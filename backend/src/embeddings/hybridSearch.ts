import { Project } from '@/entities/Project'
import { buildFilterConditions, MemoFilter } from '@/lib/filterUtils'
import { DI } from '@/di'
import { logger } from '@/lib/logger'
import { detectLanguage, Language } from '@/lib/languageDetector'

export interface HybridSearchResult {
    uuid: string
    chunk_content: string
    memo_uuid: string
    vector_score: number
    bm25_score: number
    hybrid_score: number
}

export interface HybridSearchConfig {
    vectorWeight?: number // Default: 0.7
    bm25Weight?: number // Default: 0.3
    topK?: number // Default: 10
    similarityThreshold?: number // Default: 0.95
    filters?: MemoFilter
}

export class HybridSearchService {
    /**
     * Perform hybrid search combining vector similarity and BM25 keyword search
     * Uses score normalization and weighted fusion for optimal results
     */
    static async hybridSearch(
        project: Project,
        queryEmbedding: number[],
        queryText: string,
        config: HybridSearchConfig = {}
    ): Promise<HybridSearchResult[]> {
        const { vectorWeight = 0.7, bm25Weight = 0.3, topK = 10, similarityThreshold = 0.95, filters } = config

        //1. Vector Search
        const vectorResults = await this.vectorSearch(
            project,
            queryEmbedding,
            topK * 2, // Get more results for fusion
            similarityThreshold,
            filters ? [filters] : undefined
        )

        //2. BM25 Search (PostgreSQL full-text search)
        const bm25Results = await this.bm25Search(project, queryText, topK * 2, filters ? [filters] : undefined)

        // 3. Score Normalization
        const normalizedVector = this.normalizeScores(vectorResults, 'vector_score')

        const normalizedBM25 = this.normalizeScores(bm25Results, 'bm25_score')

        // 4. Combine scores with weighted fusion
        const combined = this.combineScores(normalizedVector, normalizedBM25, vectorWeight, bm25Weight)

        // 5. Sort and return topK
        return combined.sort((a, b) => b.hybrid_score - a.hybrid_score).slice(0, topK)
    }

    /**
     * Vector search using pgvector cosine distance
     */
    private static async vectorSearch(
        project: Project,
        embeddingVector: number[],
        topK: number,
        similarityThreshold: number,
        filters?: MemoFilter[]
    ): Promise<Array<{ uuid: string; chunk_content: string; memo_uuid: string; vector_score: number }>> {
        const { whereConditions, params } = buildFilterConditions(filters || [])
        const allParams = [JSON.stringify(embeddingVector), JSON.stringify(embeddingVector), ...params]

        let whereClause = `
            WHERE (skald_memochunk.embedding <=> ?::vector) <= ${similarityThreshold}
            AND skald_memochunk.project_id = '${project.uuid}'
        `

        if (whereConditions.length > 0) {
            whereClause += ' AND ' + whereConditions.join(' AND ')
        }

        const sql = `
            SELECT
                skald_memochunk.uuid,
                skald_memochunk.chunk_content,
                skald_memochunk.memo_uuid,
                (1 - (skald_memochunk.embedding <=> ?::vector)) as vector_score
            FROM skald_memochunk
            JOIN skald_memo ON skald_memochunk.memo_id = skald_memo.uuid
            ${whereClause}
            ORDER BY vector_score DESC
            LIMIT ${topK}
        `

        try {
            const results = await DI.em.getConnection().execute<any[]>(sql, allParams)

            return (results || []).map((row) => ({
                uuid: row.uuid,
                chunk_content: row.chunk_content,
                memo_uuid: row.memo_id,
                vector_score: Math.max(0, Math.min(1, row.vector_score)),
            }))
        } catch (error) {
            logger.error({ err: error }, 'Vector search error in hybrid search')
            return []
        }
    }

    /**
     * BM25 search using PostgreSQL full-text search or pg_trgm for CJK languages
     */
    private static async bm25Search(
        project: Project,
        queryText: string,
        topK: number,
        filters?: MemoFilter[]
    ): Promise<Array<{ uuid: string; chunk_content: string; memo_uuid: string; bm25_score: number }>> {
        const detectedLanguage = detectLanguage(queryText)
        const isCJK =
            detectedLanguage === Language.KOREAN ||
            detectedLanguage === Language.JAPANESE ||
            detectedLanguage === Language.CHINESE

        if (isCJK) {
            return this.trgmSearch(project, queryText, topK, filters)
        }

        return this.fullTextSearch(project, queryText, topK, filters)
    }

    /**
     * Full-text search for English and other languages using PostgreSQL tsvector
     */
    private static async fullTextSearch(
        project: Project,
        queryText: string,
        topK: number,
        filters?: MemoFilter[]
    ): Promise<Array<{ uuid: string; chunk_content: string; memo_uuid: string; bm25_score: number }>> {
        const { whereConditions, params } = buildFilterConditions(filters || [])

        let whereClause = `
            WHERE skald_memochunk.project_id = '${project.uuid}'
            AND to_tsvector('english', skald_memochunk.chunk_content) @@ plainto_tsquery('english', ?)
        `

        if (whereConditions.length > 0) {
            whereClause += ' AND ' + whereConditions.join(' AND ')
        }

        const sql = `
            SELECT
                skald_memochunk.uuid,
                skald_memochunk.chunk_content,
                skald_memochunk.memo_uuid,
                ts_rank(to_tsvector('english', skald_memochunk.chunk_content),
                        plainto_tsquery('english', ?)) as bm25_score
            FROM skald_memochunk
            JOIN skald_memo ON skald_memochunk.memo_id = skald_memo.uuid
            ${whereClause}
            ORDER BY bm25_score DESC
            LIMIT ${topK}
        `

        try {
            const results = await DI.em.getConnection().execute<any[]>(sql, [queryText, ...params])

            return (results || []).map((row) => ({
                uuid: row.uuid,
                chunk_content: row.chunk_content,
                memo_uuid: row.memo_id,
                bm25_score: Math.max(0, Math.min(1, row.bm25_score)),
            }))
        } catch (error) {
            logger.error({ err: error }, 'Full-text search error in hybrid search')
            return []
        }
    }

    /**
     * Trigram similarity search for CJK languages (Korean, Japanese, Chinese)
     */
    private static async trgmSearch(
        project: Project,
        queryText: string,
        topK: number,
        filters?: MemoFilter[]
    ): Promise<Array<{ uuid: string; chunk_content: string; memo_uuid: string; bm25_score: number }>> {
        const { whereConditions, params } = buildFilterConditions(filters || [])

        let whereClause = `
            WHERE skald_memochunk.project_id = '${project.uuid}'
            AND skald_memochunk.chunk_content % ?
        `

        if (whereConditions.length > 0) {
            whereClause += ' AND ' + whereConditions.join(' AND ')
        }

        const sql = `
            SELECT
                skald_memochunk.uuid,
                skald_memochunk.chunk_content,
                skald_memochunk.memo_uuid,
                similarity(skald_memochunk.chunk_content, ?) as bm25_score
            FROM skald_memochunk
            JOIN skald_memo ON skald_memochunk.memo_id = skald_memo.uuid
            ${whereClause}
            ORDER BY bm25_score DESC
            LIMIT ${topK}
        `

        try {
            const results = await DI.em.getConnection().execute<any[]>(sql, [queryText, queryText, ...params])

            return (results || []).map((row) => ({
                uuid: row.uuid,
                chunk_content: row.chunk_content,
                memo_uuid: row.memo_id,
                bm25_score: Math.max(0, Math.min(1, row.bm25_score)),
            }))
        } catch (error) {
            logger.error({ err: error, language: detectLanguage(queryText) }, 'Trigram search error in hybrid search')
            return []
        }
    }

    /**
     * Normalize scores using min-max normalization
     */
    private static normalizeScores(
        results: Array<{
            uuid: string
            chunk_content: string
            memo_uuid: string
            vector_score?: number
            bm25_score?: number
        }>,
        scoreKey: 'vector_score' | 'bm25_score'
    ): Map<string, { chunk_content: string; memo_uuid: string; normalizedScore: number }> {
        const normalized = new Map()

        if (results.length === 0) return normalized

        // Min-max normalization
        const scores = results.map((r) => r[scoreKey] as number)
        const minScore = Math.min(...scores)
        const maxScore = Math.max(...scores)

        for (const result of results) {
            const rawScore = (result[scoreKey] as number) ?? 0
            const normalizedScore = maxScore > minScore ? (rawScore - minScore) / (maxScore - minScore) : 1.0

            normalized.set(result.uuid, {
                chunk_content: result.chunk_content,
                memo_uuid: result.memo_uuid,
                normalizedScore,
            })
        }

        return normalized
    }

    /**
     * Combine normalized scores with weighted fusion
     */
    private static combineScores(
        vectorScores: Map<string, { chunk_content: string; memo_uuid: string; normalizedScore: number }>,
        bm25Scores: Map<string, { chunk_content: string; memo_uuid: string; normalizedScore: number }>,
        vectorWeight: number,
        bm25Weight: number
    ): HybridSearchResult[] {
        const combined: HybridSearchResult[] = []
        const seenUuids = new Set<string>()

        // Process vector results
        for (const [uuid, data] of vectorScores.entries()) {
            if (seenUuids.has(uuid)) continue
            seenUuids.add(uuid)

            const bm25Score = bm25Scores.get(uuid)?.normalizedScore || 0
            const hybridScore = vectorWeight * data.normalizedScore + bm25Weight * bm25Score

            combined.push({
                uuid,
                chunk_content: data.chunk_content,
                memo_uuid: data.memo_uuid,
                vector_score: data.normalizedScore,
                bm25_score: bm25Score,
                hybrid_score: Math.max(0, Math.min(1, hybridScore)),
            })
        }

        // Add BM25-only results
        for (const [uuid, data] of bm25Scores.entries()) {
            if (seenUuids.has(uuid)) continue

            combined.push({
                uuid,
                chunk_content: data.chunk_content,
                memo_uuid: data.memo_uuid,
                vector_score: 0,
                bm25_score: data.normalizedScore,
                hybrid_score: Math.max(0, Math.min(1, bm25Weight * data.normalizedScore)),
            })
        }

        return combined
    }
}

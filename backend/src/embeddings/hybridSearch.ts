import { Project } from '@/entities/Project'
import { buildFilterConditions, MemoFilter } from '@/lib/filterUtils'
import { DI } from '@/di'
import { logger } from '@/lib/logger'
import { detectLanguage, Language } from '@/lib/languageDetector'

// RRF (Reciprocal Rank Fusion) constant - standard value from OneRAG
const RRF_K = 60

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
    similarityThreshold?: number // Default: 1.2 (cosine distance 0~2 range, allows cosine_similarity >= 0.4)
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
        const { topK = 10, similarityThreshold = 1.2, filters } = config

        // Dynamically adjust RRF weights based on query language.
        // CJK (Korean/Japanese/Chinese) benefits from stronger BM25 (trigram) signal.
        // English/Latin scripts benefit more from semantic vector search.
        const detectedLang = detectLanguage(queryText)
        const isCJK =
            detectedLang === Language.KOREAN ||
            detectedLang === Language.JAPANESE ||
            detectedLang === Language.CHINESE
        const vectorWeight = config.vectorWeight ?? (isCJK ? 0.5 : 0.7)
        const bm25Weight = config.bm25Weight ?? (isCJK ? 0.5 : 0.3)

        logger.debug(
            { detectedLang, isCJK, vectorWeight, bm25Weight, query: queryText.slice(0, 50) },
            'Hybrid search: dynamic RRF weights applied'
        )
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
        // Vector and BM25 results are already sorted by their respective scores
        const combined = this.combineScoresRRF(vectorResults, bm25Results, vectorWeight, bm25Weight)
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
            WHERE (skald_memochunk.embedding::halfvec(2048) <=> ?::halfvec(2048)) <= ${similarityThreshold}
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
                (1 - (skald_memochunk.embedding::halfvec(2048) <=> ?::halfvec(2048))) as vector_score
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
            memo_uuid: row.memo_uuid,
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
            memo_uuid: row.memo_uuid,
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
            AND similarity(skald_memochunk.chunk_content, ?) > 0.175
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
            memo_uuid: row.memo_uuid,
                bm25_score: Math.max(0, Math.min(1, row.bm25_score)),
            }))
        } catch (error) {
            logger.error({ err: error, language: detectLanguage(queryText) }, 'Trigram search error in hybrid search')
            return []
        }
    }

    /**
     * Combine results using Reciprocal Rank Fusion (RRF)
     * RRF score = Σ [ weight / (k + rank + 1) ]
     * More robust than weighted linear fusion as it's based on rank, not score magnitude
     */
    private static combineScoresRRF(
        vectorResults: Array<{ uuid: string; chunk_content: string; memo_uuid: string; vector_score: number }>,
        bm25Results: Array<{ uuid: string; chunk_content: string; memo_uuid: string; bm25_score: number }>,
        vectorWeight: number,
        bm25Weight: number
    ): HybridSearchResult[] {
        const rrfScores = new Map<string, number>()
        const docInfo = new Map<
            string,
            { chunk_content: string; memo_uuid: string; vector_score: number; bm25_score: number }
        >()

        // Vector results RRF scores (already sorted by vector_score DESC)
        for (let rank = 0; rank < vectorResults.length; rank++) {
            const doc = vectorResults[rank]
            const score = vectorWeight / (RRF_K + rank + 1)
            rrfScores.set(doc.uuid, (rrfScores.get(doc.uuid) || 0) + score)
            if (!docInfo.has(doc.uuid)) {
                docInfo.set(doc.uuid, {
                    chunk_content: doc.chunk_content,
                    memo_uuid: doc.memo_uuid,
                    vector_score: doc.vector_score,
                    bm25_score: 0,
                })
            }
        }

        // BM25 results RRF scores (already sorted by bm25_score DESC)
        for (let rank = 0; rank < bm25Results.length; rank++) {
            const doc = bm25Results[rank]
            const score = bm25Weight / (RRF_K + rank + 1)
            rrfScores.set(doc.uuid, (rrfScores.get(doc.uuid) || 0) + score)
            if (!docInfo.has(doc.uuid)) {
                docInfo.set(doc.uuid, {
                    chunk_content: doc.chunk_content,
                    memo_uuid: doc.memo_uuid,
                    vector_score: 0,
                    bm25_score: doc.bm25_score,
                })
            } else {
                // Update BM25 score for docs that appear in both
                const info = docInfo.get(doc.uuid)!
                info.bm25_score = doc.bm25_score
            }
        }

        // Convert to HybridSearchResult array
        const combined: HybridSearchResult[] = []
        for (const [uuid, rrfScore] of rrfScores.entries()) {
            const info = docInfo.get(uuid)!
            combined.push({
                uuid,
                chunk_content: info.chunk_content,
                memo_uuid: info.memo_uuid,
                vector_score: info.vector_score,
                bm25_score: info.bm25_score,
                hybrid_score: rrfScore,
            })
        }

        return combined
    }
}

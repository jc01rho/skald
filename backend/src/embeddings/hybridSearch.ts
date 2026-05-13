import { Project } from '@/entities/Project'
import { buildFilterConditions, MemoFilter } from '@/lib/filterUtils'
import { DI } from '@/di'
import { logger } from '@/lib/logger'
import { detectLanguage, Language } from '@/lib/languageDetector'
import { cacheSearchResults, getCachedSearchResults } from '@/lib/ragCache'

// RRF (Reciprocal Rank Fusion) constant - standard value from OneRAG
const RRF_K = 60

export interface HybridSearchResult {
    uuid: string
    chunk_content: string
    memo_uuid: string
    memo_title?: string
    doc_type?: string
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

export interface HybridSearchTuningProfile {
    isCJK: boolean
    isShortDefinitionQuery: boolean
    vectorWeight: number
    bm25Weight: number
    similarityThreshold: number
}

function getNormalizedQueryLength(queryText: string): number {
    return queryText.replace(/\s+/g, '')?.length ?? 0
}

function isShortCJKFeatureDefinitionQuery(queryText: string, isCJK: boolean): boolean {
    if (!isCJK) {
        return false
    }

    const normalized = queryText.trim()
    const compactLength = getNormalizedQueryLength(normalized)
    const definitionLike = /(기능|정의|개요|설명|소개|뭐야|이란|란\?|란$)/iu.test(normalized)

    return compactLength > 0 && compactLength <= 24 && definitionLike
}

function isComparisonOrDefinitionQuery(queryText: string): boolean {
    return /(차이|비교|다른 점|기능 설명|정의|개요|설명|뭐야|무엇)/iu.test(queryText)
}

function applyDocumentTypeBias(queryText: string, result: HybridSearchResult): HybridSearchResult {
    if (!isComparisonOrDefinitionQuery(queryText)) {
        return result
    }

    const docType = result.doc_type?.toLowerCase()
    let multiplier = 1
    if (docType === 'information') {
        multiplier = 1.18
    } else if (docType === 'release') {
        multiplier = 1
    }

    return {
        ...result,
        hybrid_score: result.hybrid_score * multiplier,
    }
}

export function resolveHybridSearchTuningProfile(
    queryText: string,
    config: HybridSearchConfig = {}
): HybridSearchTuningProfile {
    const similarityThreshold = config.similarityThreshold ?? 1.2
    const detectedLang = detectLanguage(queryText)
    const isCJK =
        detectedLang === Language.KOREAN || detectedLang === Language.JAPANESE || detectedLang === Language.CHINESE
    const isShortDefinitionQuery = isShortCJKFeatureDefinitionQuery(queryText, isCJK)
    const isComparisonOrDefinition = isComparisonOrDefinitionQuery(queryText)

    return {
        isCJK,
        isShortDefinitionQuery,
        vectorWeight: config.vectorWeight ?? (isShortDefinitionQuery ? 0.35 : isCJK ? 0.5 : 0.7),
        bm25Weight: config.bm25Weight ?? (isShortDefinitionQuery ? 0.65 : isCJK ? 0.5 : 0.3),
        similarityThreshold: isShortDefinitionQuery
            ? Math.max(0.35, similarityThreshold - 0.1)
            : isComparisonOrDefinition
              ? Math.max(0.35, similarityThreshold - 0.05)
              : similarityThreshold,
    }
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
        const { topK = 10, filters } = config
        const tuningProfile = resolveHybridSearchTuningProfile(queryText, config)
        const detectedLang = detectLanguage(queryText)
        const {
            isCJK,
            isShortDefinitionQuery,
            vectorWeight,
            bm25Weight,
            similarityThreshold: adjustedSimilarityThreshold,
        } = tuningProfile

        const cacheScope = {
            projectUuid: project.uuid,
            topK,
            similarityThreshold: adjustedSimilarityThreshold,
            vectorWeight,
            bm25Weight,
            detectedLang,
            isShortDefinitionQuery,
            filters: filters ?? null,
        }

        const cached = await getCachedSearchResults(queryText, cacheScope)
        if (cached) {
            return cached as HybridSearchResult[]
        }

        logger.debug(
            {
                detectedLang,
                isCJK,
                isShortDefinitionQuery,
                vectorWeight,
                bm25Weight,
                similarityThreshold: adjustedSimilarityThreshold,
                query: queryText.slice(0, 50),
            },
            'Hybrid search: dynamic RRF weights applied'
        )
        const searchBudget = topK + Math.min(topK, 20)
        const [vectorResults, bm25Results] = await Promise.all([
            this.vectorSearch(
                project,
                queryEmbedding,
                searchBudget,
                adjustedSimilarityThreshold,
                filters ? [filters] : undefined
            ),
            this.bm25Search(project, queryText, searchBudget, filters ? [filters] : undefined),
        ])
        // Vector and BM25 results are already sorted by their respective scores
        const combined = this.combineScoresRRF(vectorResults, bm25Results, vectorWeight, bm25Weight)
        const finalResults = combined
            .map((result) => applyDocumentTypeBias(queryText, result))
            .sort((a, b) => b.hybrid_score - a.hybrid_score)
            .slice(0, topK)
        await cacheSearchResults(queryText, cacheScope, finalResults)

        return finalResults
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
    ): Promise<
        Array<{
            uuid: string
            chunk_content: string
            memo_uuid: string
            memo_title?: string
            doc_type?: string
            vector_score: number
        }>
    > {
        const { whereConditions, params } = buildFilterConditions(filters || [])
        const allParams = [
            JSON.stringify(embeddingVector),
            JSON.stringify(embeddingVector),
            similarityThreshold,
            project.uuid,
            ...params,
            topK,
        ]

        let whereClause = `
            WHERE (skald_memochunk.embedding::halfvec(2048) <=> ?::halfvec(2048)) <= ?
            AND skald_memochunk.project_id = ?
        `

        if (whereConditions.length > 0) {
            whereClause += ' AND ' + whereConditions.join(' AND ')
        }

        const sql = `
            SELECT
                skald_memochunk.uuid,
                skald_memochunk.chunk_content,
                skald_memochunk.memo_uuid,
                skald_memo.title AS memo_title,
                skald_memo.metadata->>'doc_type' AS doc_type,
                (1 - (skald_memochunk.embedding::halfvec(2048) <=> ?::halfvec(2048))) as vector_score
            FROM skald_memochunk
            JOIN skald_memo ON skald_memochunk.memo_id = skald_memo.uuid
            ${whereClause}
            ORDER BY vector_score DESC
            LIMIT ?
        `

        try {
            const results = await DI.em.getConnection().execute<any[]>(sql, allParams)

            return (results || []).map((row) => ({
                uuid: row.uuid,
                chunk_content: row.chunk_content,
                memo_uuid: row.memo_uuid,
                memo_title: row.memo_title,
                doc_type: row.doc_type,
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
    ): Promise<
        Array<{
            uuid: string
            chunk_content: string
            memo_uuid: string
            memo_title?: string
            doc_type?: string
            bm25_score: number
        }>
    > {
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
    ): Promise<
        Array<{ uuid: string; chunk_content: string; memo_uuid: string; memo_title?: string; bm25_score: number }>
    > {
        const { whereConditions, params } = buildFilterConditions(filters || [])
        const allParams = [
            queryText,
            queryText,
            queryText,
            project.uuid,
            queryText,
            queryText,
            queryText,
            ...params,
            topK,
        ]

        let whereClause = `
            WHERE skald_memochunk.project_id = ?
            AND (
                skald_memochunk.content_tsvector @@ plainto_tsquery('english', ?)
                OR to_tsvector('english', COALESCE(skald_memo.title, '')) @@ plainto_tsquery('english', ?)
                OR to_tsvector('english', COALESCE(skald_memo.metadata->>'search_text', '')) @@ plainto_tsquery('english', ?)
            )
        `

        if (whereConditions.length > 0) {
            whereClause += ' AND ' + whereConditions.join(' AND ')
        }

        const sql = `
            SELECT
                skald_memochunk.uuid,
                skald_memochunk.chunk_content,
                skald_memochunk.memo_uuid,
                skald_memo.title AS memo_title,
                skald_memo.metadata->>'doc_type' AS doc_type,
                GREATEST(
                    ts_rank(skald_memochunk.content_tsvector, plainto_tsquery('english', ?)),
                    ts_rank(to_tsvector('english', COALESCE(skald_memo.title, '')), plainto_tsquery('english', ?)),
                    ts_rank(
                        to_tsvector('english', COALESCE(skald_memo.metadata->>'search_text', '')),
                        plainto_tsquery('english', ?)
                    ) * 1.1
                ) as bm25_score
            FROM skald_memochunk
            JOIN skald_memo ON skald_memochunk.memo_id = skald_memo.uuid
            ${whereClause}
            ORDER BY bm25_score DESC
            LIMIT ?
        `

        try {
            const results = await DI.em.getConnection().execute<any[]>(sql, allParams)

            return (results || []).map((row) => ({
                uuid: row.uuid,
                chunk_content: row.chunk_content,
                memo_uuid: row.memo_uuid,
                memo_title: row.memo_title,
                doc_type: row.doc_type,
                bm25_score: Number(row.bm25_score) || 0,
            }))
        } catch (error) {
            logger.error({ err: error }, 'BM25 search error in hybrid search')
            return []
        }
    }

    private static async trgmSearch(
        project: Project,
        queryText: string,
        topK: number,
        filters?: MemoFilter[]
    ): Promise<
        Array<{
            uuid: string
            chunk_content: string
            memo_uuid: string
            memo_title?: string
            doc_type?: string
            bm25_score: number
        }>
    > {
        const { whereConditions, params } = buildFilterConditions(filters || [])
        const sanitizedQuery = queryText.trim()
        const allParams = [sanitizedQuery, sanitizedQuery, sanitizedQuery, project.uuid, ...params, topK]

        let whereClause = `
            WHERE skald_memochunk.project_id = ?
            AND (
                similarity(skald_memochunk.chunk_content, ?) > 0
                OR similarity(COALESCE(skald_memo.title, ''), ?) > 0
                OR similarity(COALESCE(skald_memo.metadata->>'search_text', ''), ?) > 0
            )
        `

        if (whereConditions.length > 0) {
            whereClause += ' AND ' + whereConditions.join(' AND ')
        }

        const sql = `
            SELECT
                skald_memochunk.uuid,
                skald_memochunk.chunk_content,
                skald_memochunk.memo_uuid,
                skald_memo.title AS memo_title,
                skald_memo.metadata->>'doc_type' AS doc_type,
                GREATEST(
                    similarity(skald_memochunk.chunk_content, ?),
                    similarity(COALESCE(skald_memo.title, ''), ?),
                    similarity(COALESCE(skald_memo.metadata->>'search_text', ''), ?) * 1.1
                ) as bm25_score
            FROM skald_memochunk
            JOIN skald_memo ON skald_memochunk.memo_id = skald_memo.uuid
            ${whereClause}
            ORDER BY bm25_score DESC
            LIMIT ?
        `

        try {
            const results = await DI.em.getConnection().execute<any[]>(sql, allParams)

            return (results || []).map((row) => ({
                uuid: row.uuid,
                chunk_content: row.chunk_content,
                memo_uuid: row.memo_uuid,
                memo_title: row.memo_title,
                doc_type: row.doc_type,
                bm25_score: Number(row.bm25_score) || 0,
            }))
        } catch (error) {
            logger.error({ err: error }, 'Trigram search error in hybrid search')
            return []
        }
    }

    /**
     * Combine vector and BM25 results using Reciprocal Rank Fusion (RRF)
     * More robust than score normalization as it uses ranking positions rather than raw scores
     */
    private static combineScoresRRF(
        vectorResults: Array<{
            uuid: string
            chunk_content: string
            memo_uuid: string
            memo_title?: string
            doc_type?: string
            vector_score: number
        }>,
        bm25Results: Array<{
            uuid: string
            chunk_content: string
            memo_uuid: string
            memo_title?: string
            doc_type?: string
            bm25_score: number
        }>,
        vectorWeight: number = 1.0,
        bm25Weight: number = 1.0
    ): HybridSearchResult[] {
        const resultMap = new Map<string, HybridSearchResult>()

        vectorResults.forEach((result, index) => {
            const rrfScore = vectorWeight / (RRF_K + index + 1)
            resultMap.set(result.uuid, {
                uuid: result.uuid,
                chunk_content: result.chunk_content,
                memo_uuid: result.memo_uuid,
                memo_title: result.memo_title,
                doc_type: result.doc_type,
                vector_score: result.vector_score,
                bm25_score: 0,
                hybrid_score: rrfScore,
            })
        })

        bm25Results.forEach((result, index) => {
            const rrfScore = bm25Weight / (RRF_K + index + 1)
            const existing = resultMap.get(result.uuid)
            if (existing) {
                existing.bm25_score = result.bm25_score
                existing.hybrid_score += rrfScore
            } else {
                resultMap.set(result.uuid, {
                    uuid: result.uuid,
                    chunk_content: result.chunk_content,
                    memo_uuid: result.memo_uuid,
                    memo_title: result.memo_title,
                    doc_type: result.doc_type,
                    vector_score: 0,
                    bm25_score: result.bm25_score,
                    hybrid_score: rrfScore,
                })
            }
        })

        return Array.from(resultMap.values())
    }
}

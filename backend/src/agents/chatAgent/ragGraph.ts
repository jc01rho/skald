import { Project } from '@/entities/Project'
import { getOptimizedChatHistory } from '@/lib/chatUtils'
import { StateGraph, END } from '@langchain/langgraph'
import { Annotation } from '@langchain/langgraph'
import { rewrite, rewriteMultiQuery, generateHyDE, generateJiraHyDE } from './queryRewrite'
import { MemoFilter } from '@/lib/filterUtils'
import { EmbeddingService } from '@/services/embeddingService'
import { memoChunkVectorSearch, MemoChunkWithDistance } from '@/embeddings/vectorSearch'
import { HybridSearchService, HybridSearchResult } from '@/embeddings/hybridSearch'
import { QueryUnderstandingAgent, SearchStrategy } from '../queryUnderstandingAgent'
import { getTitleAndSummaryAndContentForMemoList } from '@/queries/memo'
import { RerankService } from '@/services/rerankService'
import { CHAT_AGENT_INSTRUCTIONS, CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES } from './prompts'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { logger } from '@/lib/logger'
import { DI } from '@/di'
import { MemoParentChunk } from '@/entities/MemoParentChunk'
import { reorderForLongContext, selectOptimalStrategy, ReorderStrategy } from '@/lib/contextReorder'
import { validateRetrieval, getRetryStrategy, RetrievalValidation } from '@/lib/retrievalValidator'
import { mapWithConcurrency } from '@/lib/asyncUtils'
import { HNSWOptimizationService } from '@/lib/hnswOptimization'
import { extractExplicitKeys, ExtractedKey } from '@/lib/keyExtractor'

interface RerankResult {
    index: number
    document: string
    relevance_score: number
    memo_uuid?: string
    memo_title?: string
    source_url?: string
    embedding?: number[] // Optional embedding for MMR diversity calculation
}

export interface RAGConfig {
    llmProvider: 'cli-proxy-api'
    references: {
        enabled: boolean
    }
    queryRewrite: {
        enabled: boolean
        multiQuery?: boolean
        hydeEnabled?: boolean
    }
    vectorSearch: {
        topK: number
        similarityThreshold: number
    }
    reranking: {
        enabled: boolean
        topK: number
        mmrEnabled?: boolean
        mmrLambda?: number
    }
    queryUnderstanding?: {
        enabled: boolean
    }
    hybridSearch?: {
        enabled: boolean
        vectorWeight?: number
        bm25Weight?: number
    }
    contextReorder?: {
        enabled: boolean
        strategy?: ReorderStrategy
        autoSelect?: boolean
    }
    crag?: {
        enabled: boolean
        scoreThreshold?: number
        filterLowRelevance?: boolean
    }
    selfRag?: {
        enabled: boolean
        qualityThreshold?: number
        rollbackThreshold?: number
    }
    fallbackSearch?: {
        enabled: boolean
        triggerThreshold?: number
        expandedTopK?: number
        loweredThreshold?: number
        enableMultiQuery?: boolean
    }
    confidence?: {
        threshold?: number
    }
}

// Define your state schema
const RAGState = Annotation.Root({
    project: Annotation<Project>,
    query: Annotation<string>,
    filters: Annotation<MemoFilter[]>,
    clientSystemPrompt: Annotation<string | null>,
    ragConfig: Annotation<RAGConfig>,
    chatId: Annotation<string | null>,
    conversationHistory: Annotation<Array<['human' | 'ai' | 'system', string]> | null>,
    queryUnderstanding: Annotation<SearchStrategy | null>,
    rewrittenQuery: Annotation<string | null>,
    chunkResults: Annotation<MemoChunkWithDistance[] | null>,
    rerankedResults: Annotation<RerankResult[]>,
    memoPropertiesMap: Annotation<Map<
        string,
        { title: string; summary: string; content: string; source_url: string }
    > | null>,
    parentChunkMap: Annotation<Map<string, string> | null>,
    precomputedQueryEmbedding: Annotation<number[] | null>,
    cragValidation: Annotation<RetrievalValidation | null>,
    prompt: Annotation<ChatPromptTemplate>,
    contextStr: Annotation<string | null>,
    exactLookupKeys: Annotation<ExtractedKey[] | null>,
    exactLookupResults: Annotation<Array<{ key: string; title: string; content: string; source_url: string; found: boolean; status?: 'hit' | 'archived_only' | 'miss'; archivedContent?: string; contradiction?: { urlKey: string; inlineKey: string } }> | null>,
    lookupHit: Annotation<boolean | null>,
})

async function getChatHistoryNode(state: typeof RAGState.State) {
    const { chatId, project } = state
    if (!chatId) {
        return { conversationHistory: null }
    }
    const conversationHistory = await getOptimizedChatHistory(chatId, project)
    return { conversationHistory }
}

/**
 * Exact key lookup node — runs before vector search.
 * Extracts explicit Jira keys/document references from the query and performs
 * a direct DB lookup on client_reference_id. If hit, sets lookupHit=true and
 * exactLookupResults with the full content. If miss, marks found=false so that
 * buildLLMInputs can surface a key-not-found message instead of a generic abstain.
 */
async function exactLookupNode(state: typeof RAGState.State) {
    const { query, project } = state

    const extractedKeys = extractExplicitKeys(query)
    if (extractedKeys.length === 0) {
        return { exactLookupKeys: null, exactLookupResults: null, lookupHit: null }
    }

    logger.info(
        { extractedKeys: extractedKeys.map(k => ({ type: k.type, value: k.value, confidence: k.confidence })) },
        'exactLookup: extracted keys from query'
    )

    // Task 12: Extended type to support archived_only and contradiction states
    const results: Array<{ key: string; title: string; content: string; source_url: string; found: boolean; status?: 'hit' | 'archived_only' | 'miss'; archivedContent?: string; contradiction?: { urlKey: string; inlineKey: string } }> = []
    let anyHit = false

    for (const extractedKey of extractedKeys) {
        try {
            // Task 12: Two-stage lookup — first try active (archived=false), then archived
            const rows = await DI.em.getConnection().execute<
                Array<{ uuid: string; title: string; content: string | null; source_url: string | null; archived: boolean }>
            >(
                `SELECT skald_memo.uuid, skald_memo.title,
                        skald_memocontent.content,
                        skald_memo.metadata->>'source_url' AS source_url,
                        COALESCE(skald_memo.archived, false) AS archived
                 FROM skald_memo
                 LEFT JOIN skald_memocontent ON skald_memo.uuid = skald_memocontent.memo_id
                 WHERE skald_memo.project_id = ?
                   AND skald_memo.client_reference_id = ?
                 LIMIT 1`,
                [project.uuid, extractedKey.value]
            )

            if (rows.length > 0) {
                const row = rows[0]
                if (!row.archived) {
                    // Normal hit
                    results.push({
                        key: extractedKey.value,
                        title: row.title,
                        content: row.content || row.title,
                        source_url: row.source_url || '',
                        found: true,
                        status: 'hit',
                    })
                    anyHit = true
                    logger.info(
                        { key: extractedKey.value, type: extractedKey.type, memoUuid: row.uuid },
                        'exactLookup: HIT on client_reference_id (active)'
                    )
                } else {
                    // Task 12: Archived-only hit — surface as distinct state
                    results.push({
                        key: extractedKey.value,
                        title: row.title,
                        content: '',
                        source_url: row.source_url || '',
                        found: false,
                        status: 'archived_only',
                        archivedContent: row.content || row.title,
                    })
                    logger.info(
                        { key: extractedKey.value, type: extractedKey.type, memoUuid: row.uuid },
                        'exactLookup: ARCHIVED-ONLY hit on client_reference_id'
                    )
                }
            } else {
                // Try metadata.issueKey fallback for Jira keys
                const metaRows = await DI.em.getConnection().execute<
                    Array<{ uuid: string; title: string; content: string | null; source_url: string | null; archived: boolean }>
                >(
                    `SELECT skald_memo.uuid, skald_memo.title,
                            skald_memocontent.content,
                            skald_memo.metadata->>'source_url' AS source_url,
                            COALESCE(skald_memo.archived, false) AS archived
                     FROM skald_memo
                     LEFT JOIN skald_memocontent ON skald_memo.uuid = skald_memocontent.memo_id
                     WHERE skald_memo.project_id = ?
                       AND skald_memo.metadata->>'issueKey' = ?
                     LIMIT 1`,
                    [project.uuid, extractedKey.value]
                )

                if (metaRows.length > 0) {
                    const row = metaRows[0]
                    if (!row.archived) {
                        // Normal hit
                        results.push({
                            key: extractedKey.value,
                            title: row.title,
                            content: row.content || row.title,
                            source_url: row.source_url || '',
                            found: true,
                            status: 'hit',
                        })
                        anyHit = true
                        logger.info(
                            { key: extractedKey.value, type: extractedKey.type, memoUuid: row.uuid },
                            'exactLookup: HIT on metadata.issueKey (active)'
                        )
                    } else {
                        // Task 12: Archived-only hit
                        results.push({
                            key: extractedKey.value,
                            title: row.title,
                            content: '',
                            source_url: row.source_url || '',
                            found: false,
                            status: 'archived_only',
                            archivedContent: row.content || row.title,
                        })
                        logger.info(
                            { key: extractedKey.value, type: extractedKey.type, memoUuid: row.uuid },
                            'exactLookup: ARCHIVED-ONLY hit on metadata.issueKey'
                        )
                    }
                } else {
                    // True miss
                    results.push({
                        key: extractedKey.value,
                        title: '',
                        content: '',
                        source_url: '',
                        found: false,
                        status: 'miss',
                    })
                    logger.info(
                        { key: extractedKey.value, type: extractedKey.type },
                        'exactLookup: MISS — key not found in KB'
                    )
                }
            }
        } catch (err) {
            logger.warn(
                { key: extractedKey.value, err },
                'exactLookup: error during lookup, skipping key'
            )
            results.push({
                key: extractedKey.value,
                title: '',
                content: '',
                source_url: '',
                found: false,
                status: 'miss',
            })
        }
    }

    return {
        exactLookupKeys: extractedKeys,
        exactLookupResults: results,
        lookupHit: anyHit,
    }
}

/**
 * Merged node: analyzeQuery + queryRewrite run in parallel via Promise.all.
 * Both are LLM calls and are independent of each other (both use only query + history),
 * so running them concurrently saves one serial LLM round-trip.
 */
async function analyzeAndRewriteNode(state: typeof RAGState.State) {
    const { query, conversationHistory, ragConfig } = state
    const context = (conversationHistory || []).map(([role, content]) => `${role}: ${content}`).join('\n')
    const conversationMessages = (conversationHistory || [])
        .map(([userMsg, assistantMsg]) => [
            { role: 'user' as const, content: userMsg },
            { role: 'assistant' as const, content: assistantMsg },
        ])
        .flat()

    // P1-6: Speculative search — pre-compute original query embedding in parallel with LLM calls
    // This embedding will be reused in vectorSearchNode, saving one round-trip
    const [queryUnderstanding, rewrittenQueryRaw, precomputedQueryEmbedding] = await Promise.all([
        ragConfig.queryUnderstanding?.enabled
            ? QueryUnderstandingAgent.understandQuery(query, context)
            : Promise.resolve(null),
        ragConfig.queryRewrite.enabled ? rewrite(query, conversationMessages) : Promise.resolve(null),
        EmbeddingService.generateEmbedding(query, 'search'),
    ])

    logger.info(
        {
            originalQuery: query,
            rewrittenQuery: rewrittenQueryRaw,
            queryChanged: rewrittenQueryRaw && rewrittenQueryRaw !== query,
            queryUnderstandingEnabled: ragConfig.queryUnderstanding?.enabled,
            queryRewriteEnabled: ragConfig.queryRewrite.enabled,
            precomputedEmbedding: !!precomputedQueryEmbedding,
        },
        'RAG analyzeAndRewrite completed (with speculative embedding)'
    )

    return {
        queryUnderstanding,
        rewrittenQuery: rewrittenQueryRaw && rewrittenQueryRaw !== query ? rewrittenQueryRaw : null,
        precomputedQueryEmbedding,
    }
}

function hybridResultToMemoChunk(result: HybridSearchResult): MemoChunkWithDistance {
    return {
        chunk: {
            uuid: result.uuid,
            chunk_content: result.chunk_content,
            chunk_index: 0,
            embedding: [],
            memo_uuid: result.memo_uuid,
            project_uuid: '',
        },
        distance: 2 * (1 - result.hybrid_score),
    }
}

function deduplicateByBestScore(allResults: MemoChunkWithDistance[][]): MemoChunkWithDistance[] {
    const memoScoreMap = new Map<string, MemoChunkWithDistance>()

    for (const results of allResults) {
        for (const result of results) {
            const memoUuid = result.chunk.memo_uuid
            const existing = memoScoreMap.get(memoUuid)

            if (!existing || result.distance < existing.distance) {
                memoScoreMap.set(memoUuid, result)
            }
        }
    }

    return Array.from(memoScoreMap.values()).sort((a, b) => a.distance - b.distance)
}

function calculateAverageScore(results: MemoChunkWithDistance[]): number {
    if (results.length === 0) return 0
    const avgDistance = results.reduce((sum, r) => sum + r.distance, 0) / results.length
    return Math.max(0, Math.min(1, 1 - avgDistance / 2))
}

function calculateDynamicConfidenceThreshold(results: RerankResult[], baseThreshold: number): number {
    if (results.length === 0) {
        return baseThreshold
    }

    const scores = results.map((result) => result.relevance_score)
    const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length
    const maxScore = Math.max(...scores)

    if (maxScore >= baseThreshold) {
        return baseThreshold
    }

    return Math.max(0.18, Math.min(baseThreshold, averageScore * 0.9))
}

function checkFallbackCondition(results: MemoChunkWithDistance[], topK: number, threshold: number): boolean {
    if (results.length >= topK * 0.5) return false
    const avgScore = calculateAverageScore(results)
    return avgScore < threshold
}

async function executeFallbackSearch(
    query: string,
    project: Project,
    filters: MemoFilter[] | undefined,
    topK: number,
    threshold: number
): Promise<MemoChunkWithDistance[]> {
    const variants = await rewriteMultiQuery(query)
    const searchQueries = [query, ...variants]

    const expandedTopK = Math.ceil(topK * 3)

    const fallbackResults = await mapWithConcurrency(searchQueries, 3, async (searchQuery) => {
        const embeddingVector = await EmbeddingService.generateEmbedding(searchQuery, 'search')
        return memoChunkVectorSearch(project, embeddingVector, expandedTopK, threshold, filters, true)
    })

    return deduplicateByBestScore(fallbackResults)
}

function mergeSearchResults(
    primary: MemoChunkWithDistance[],
    fallback: MemoChunkWithDistance[]
): MemoChunkWithDistance[] {
    const seenMemoUuids = new Set(primary.map((r) => r.chunk.memo_uuid))
    const merged = [...primary]

    for (const result of fallback) {
        if (!seenMemoUuids.has(result.chunk.memo_uuid)) {
            merged.push(result)
            seenMemoUuids.add(result.chunk.memo_uuid)
        }
    }

    return merged.sort((a, b) => a.distance - b.distance)
}

async function vectorSearchNode(state: typeof RAGState.State) {
    const { rewrittenQuery, query, project, filters, ragConfig, queryUnderstanding, precomputedQueryEmbedding } = state

    // Use dynamic search strategy from query understanding if available, otherwise use defaults
    const strategy = queryUnderstanding || {
        multiQuery: ragConfig.queryRewrite.multiQuery || false,
        hyde: false,
        jiraHyde: false,
        topK: ragConfig.vectorSearch.topK,
        rerank: ragConfig.reranking.enabled,
        mmr: ragConfig.reranking.mmrEnabled || false,
    }

    // P2-2: Dynamic HNSW ef_search based on topK
    await HNSWOptimizationService.applyRuntimeSearchTuning(DI.em, strategy.topK)

    const searchQueries: string[] = [query]
    if (rewrittenQuery && rewrittenQuery !== query) {
        searchQueries.push(rewrittenQuery)
    }

    const [variants, hypothetical, jiraHypothetical] = await Promise.all([
        strategy.multiQuery ? rewriteMultiQuery(query) : Promise.resolve<string[]>([]),
        strategy.hyde ? generateHyDE(query) : Promise.resolve(''),
        strategy.jiraHyde ? generateJiraHyDE(query) : Promise.resolve(''),
    ])

    if (variants.length > 0) {
        searchQueries.push(...variants)
    }

    if (hypothetical) {
        searchQueries.push(hypothetical)
    }

    if (jiraHypothetical) {
        searchQueries.push(jiraHypothetical)
    }

    // Check if hybrid search is enabled (default: true for Korean optimization)
    const useHybridSearch = ragConfig.hybridSearch?.enabled ?? true

    logger.info(
        {
            searchQueriesCount: searchQueries.length,
            searchQueries,
            useHybridSearch,
            originalQuery: query,
            activeQuery: rewrittenQuery || query,
            similarityThreshold: ragConfig.vectorSearch.similarityThreshold,
            topK: strategy.topK,
            vectorWeight: ragConfig.hybridSearch?.vectorWeight ?? 0.7,
            bm25Weight: ragConfig.hybridSearch?.bm25Weight ?? 0.3,
        },
        'RAG vectorSearchNode starting'
    )

    if (useHybridSearch) {
        // Use hybrid search combining vector + BM25
        // P0-2 + P1-6: Use precomputed embedding for original query, batch the rest
        try {
            // Separate original query (already embedded in analyzeAndRewrite) from remaining queries
            const remainingQueries = searchQueries.slice(1)
            const remainingEmbeddings =
                remainingQueries.length > 0
                    ? await EmbeddingService.generateEmbeddingsBatch(remainingQueries, 'search')
                    : []
            const allEmbeddings = [
                precomputedQueryEmbedding || (await EmbeddingService.generateEmbedding(query, 'search')),
                ...remainingEmbeddings,
            ]
            const allHybridResults = await mapWithConcurrency(
                searchQueries.map((sq, i) => ({ query: sq, embedding: allEmbeddings[i] })),
                4,
                async ({ query: searchQuery, embedding: embeddingVector }) => {
                    return HybridSearchService.hybridSearch(project, embeddingVector, searchQuery, {
                        vectorWeight: ragConfig.hybridSearch?.vectorWeight ?? 0.7,
                        bm25Weight: ragConfig.hybridSearch?.bm25Weight ?? 0.3,
                        topK: strategy.topK,
                        similarityThreshold: ragConfig.vectorSearch.similarityThreshold,
                        filters: filters?.[0], // Use first filter if available
                    })
                }
            )

            // Merge results from all queries, keeping best score per document
            const mergedResults = deduplicateByBestScore(
                allHybridResults.map((results) => results.map(hybridResultToMemoChunk))
            )

            logger.info(
                {
                    searchQueriesUsed: searchQueries.length,
                    perQueryCounts: allHybridResults.map((r, i) => ({
                        query: searchQueries[i].slice(0, 50),
                        count: r.length,
                    })),
                    mergedResultsCount: mergedResults.length,
                    topResults: mergedResults.slice(0, 5).map((r) => ({
                        memo_uuid: r.chunk.memo_uuid,
                        distance: r.distance,
                        chunk_content_preview: r.chunk.chunk_content?.slice(0, 80),
                    })),
                },
                'RAG hybrid search completed (multi-query merge)'
            )

            return { chunkResults: mergedResults }
        } catch (error) {
            logger.warn({ err: error }, 'Hybrid search failed, falling back to vector-only search')
            // Fall through to vector-only search
        }
    }

    // P0-2 + P1-6: Batch embedding for vector-only search path (reuse precomputed embedding)
    const remainingQueriesFallback = searchQueries.slice(1)
    const remainingEmbeddingsFallback =
        remainingQueriesFallback.length > 0
            ? await EmbeddingService.generateEmbeddingsBatch(remainingQueriesFallback, 'search')
            : []
    const allEmbeddings = [
        precomputedQueryEmbedding || (await EmbeddingService.generateEmbedding(query, 'search')),
        ...remainingEmbeddingsFallback,
    ]
    const allResults = await mapWithConcurrency(
        searchQueries.map((sq, i) => ({ query: sq, embedding: allEmbeddings[i] })),
        4,
        async ({ embedding: embeddingVector }) => {
            return memoChunkVectorSearch(
                project,
                embeddingVector,
                strategy.topK,
                ragConfig.vectorSearch.similarityThreshold,
                filters,
                true
            )
        }
    )

    const uniqueResults = deduplicateByBestScore(allResults)

    const shouldTriggerFallback = checkFallbackCondition(uniqueResults, strategy.topK, 0.4)

    if (shouldTriggerFallback) {
        logger.debug(
            {
                resultCount: uniqueResults.length,
                avgScore: calculateAverageScore(uniqueResults),
            },
            'Triggering fallback search'
        )

        const fallbackBaseQuery = searchQueries[0] || query
        const fallbackResults = await executeFallbackSearch(fallbackBaseQuery, project, filters, strategy.topK, 0.45)

        return { chunkResults: mergeSearchResults(uniqueResults, fallbackResults) }
    }

    return { chunkResults: uniqueResults }
}

async function getMemoPropertiesNode(state: typeof RAGState.State) {
    const { chunkResults, project } = state
    // Need memo properties if reranking is enabled OR if references are enabled
    if (!chunkResults) {
        return { memoPropertiesMap: null }
    }

    const relevantMemoUuids = Array.from(new Set(chunkResults.map((c) => c.chunk.memo_uuid)))

    const memoPropertiesMap = await getTitleAndSummaryAndContentForMemoList(project.uuid, relevantMemoUuids)

    return { memoPropertiesMap }
}

async function rerankNode(state: typeof RAGState.State) {
    const { chunkResults, memoPropertiesMap, query, rewrittenQuery, ragConfig } = state
    if (!chunkResults) {
        return { rerankedResults: [] }
    }

    logger.info(
        {
            inputChunksCount: chunkResults.length,
            rerankingEnabled: ragConfig.reranking.enabled,
            searchQuery: rewrittenQuery || query,
            topK: ragConfig.reranking.topK,
        },
        'RAG rerankNode starting'
    )

    if (!ragConfig.reranking.enabled) {
        // map chunks to rerank results with embeddings for MMR
        const rerankedResults: RerankResult[] = []
        for (let i = 0; i < chunkResults.length; i++) {
            const chunk = chunkResults[i]
            const similarity = Math.max(0, Math.min(1, 1 - chunk.distance / 2))

            rerankedResults.push({
                index: i,
                document: chunk.chunk.chunk_content,
                relevance_score: similarity,
                memo_uuid: chunk.chunk.memo_uuid,
                memo_title: memoPropertiesMap?.get(chunk.chunk.memo_uuid)?.title || '',
                source_url: memoPropertiesMap?.get(chunk.chunk.memo_uuid)?.source_url || '',
                embedding: chunk.chunk.embedding as number[], // Pass embedding for MMR
            })
        }
        return { rerankedResults }
    }

    const searchQuery = rewrittenQuery || query
    const rerankData: string[] = []
    const rerankMetadata: Array<{ memo_uuid: string; memo_title: string; source_url?: string }> = []

    for (const chunkResult of chunkResults) {
        const chunk = chunkResult.chunk

        let rerankSnippet = chunk.chunk_content
        if (memoPropertiesMap) {
            const memo = memoPropertiesMap.get(chunk.memo_uuid)
            rerankSnippet = `Title: ${memo?.title}\n\nFull content summary: ${memo?.summary}\n\nChunk content: ${chunk.chunk_content}\n\n`
        }

        rerankData.push(rerankSnippet)
        rerankMetadata.push({
            memo_uuid: chunk.memo_uuid,
            memo_title: memoPropertiesMap?.get(chunk.memo_uuid)?.title || '',
            source_url: memoPropertiesMap?.get(chunk.memo_uuid)?.source_url || '',
        })
    }

    // Dynamic batch size calculation based on reranker model
    const VOYAGE_RERANK_MODEL = process.env.VOYAGE_RERANK_MODEL || 'rerank-2-lite'
    const modelTokenLimits: Record<string, number> = {
        'rerank-2-lite': 32000,
        'rerank-2': 32000,
        default: 16000,
    }
    const avgTokensPerChunk = 1000
    const maxTokens = modelTokenLimits[VOYAGE_RERANK_MODEL] || modelTokenLimits['default']
    const batchSize = Math.max(10, Math.min(50, Math.floor((maxTokens * 0.7) / avgTokensPerChunk)))

    const rerankCutoff = Math.min(ragConfig.reranking.topK * 4, chunkResults.length)
    const truncatedRerankData = rerankData.slice(0, rerankCutoff)
    const truncatedRerankMetadata = rerankMetadata.slice(0, rerankCutoff)

    const truncatedDataBatches: string[][] = []
    const truncatedMetadataBatches: Array<Array<{ memo_uuid: string; memo_title: string; source_url?: string }>> = []
    for (let i = 0; i < truncatedRerankData.length; i += batchSize) {
        truncatedDataBatches.push(truncatedRerankData.slice(i, i + batchSize))
        truncatedMetadataBatches.push(truncatedRerankMetadata.slice(i, i + batchSize))
    }

    const results = (
        await mapWithConcurrency(truncatedDataBatches, 3, async (batch, idx) =>
            RerankService.rerank(searchQuery, batch, truncatedMetadataBatches[idx])
        )
    ).flat()

    // sort and add embeddings to results for MMR
    results.sort((a, b) => b.relevance_score - a.relevance_score)
    const resultsWithEmbeddings = results.map((result) => ({
        ...result,
        embedding: chunkResults[result.index]?.chunk.embedding as number[],
    }))
    const finalReranked = resultsWithEmbeddings.slice(0, ragConfig.reranking.topK)

    logger.info(
        {
            totalRerankResults: results.length,
            afterTopKFilter: finalReranked.length,
            topK: ragConfig.reranking.topK,
            topResults: finalReranked.slice(0, 5).map((r) => ({
                memo_uuid: r.memo_uuid,
                memo_title: r.memo_title,
                source_url: r.source_url,
                relevance_score: r.relevance_score,
            })),
        },
        'RAG rerankNode completed'
    )

    return { rerankedResults: finalReranked }
}

async function cragValidationNode(state: typeof RAGState.State) {
    const { rerankedResults, query, ragConfig } = state

    logger.info(
        {
            cragEnabled: ragConfig.crag?.enabled,
            rerankedResultsCount: rerankedResults.length,
        },
        'RAG cragValidationNode starting'
    )

    if (!ragConfig.crag?.enabled || rerankedResults.length === 0) {
        logger.info(
            { cragEnabled: ragConfig.crag?.enabled, resultCount: rerankedResults.length },
            'CRAG skipped (disabled or no results)'
        )
        return { cragValidation: null }
    }

    const scoreThreshold = ragConfig.crag.scoreThreshold ?? 0.5
    const avgScore = rerankedResults.reduce((sum, r) => sum + r.relevance_score, 0) / rerankedResults.length
    const HIGH_CONFIDENCE_THRESHOLD = 0.75

    if (avgScore >= HIGH_CONFIDENCE_THRESHOLD) {
        logger.info({ avgScore, threshold: HIGH_CONFIDENCE_THRESHOLD }, 'CRAG skipped: high confidence scores')
        return { cragValidation: null }
    }

    if (avgScore >= scoreThreshold) {
        logger.debug({ avgScore, threshold: scoreThreshold }, 'CRAG skipped: scores above threshold')
        return { cragValidation: null }
    }

    logger.debug({ avgScore, threshold: scoreThreshold }, 'CRAG validation triggered')

    const validation = await validateRetrieval(query, rerankedResults, scoreThreshold)

    if (validation.needsRetry) {
        const retryInfo = getRetryStrategy(validation)
        logger.warn(
            {
                avgRelevance: validation.averageRelevance,
                suggestedStrategy: retryInfo.strategy,
                reason: retryInfo.reason,
            },
            'CRAG detected low quality retrieval'
        )
    }

    if (ragConfig.crag.filterLowRelevance && validation.scores.length > 0) {
        const filteredResults = rerankedResults.filter((_, idx) => {
            const score = validation.scores.find((s) => s.index === idx)
            return score?.relevance !== '무관'
        })

        if (filteredResults.length > 0 && filteredResults.length < rerankedResults.length) {
            logger.info(
                {
                    original: rerankedResults.length,
                    filtered: filteredResults.length,
                    removedCount: rerankedResults.length - filteredResults.length,
                    filterLowRelevance: true,
                },
                'CRAG filtered low relevance results'
            )
            return { rerankedResults: filteredResults, cragValidation: validation }
        }
    }

    return { cragValidation: validation }
}

function cosineSimilarityEmbedding(vec1: number[], vec2: number[]): number {
    // Calculate cosine similarity between two embedding vectors
    const dot = vec1.reduce((sum, v, i) => sum + v * vec2[i], 0)
    const norm1 = Math.sqrt(vec1.reduce((sum, v) => sum + v * v, 0))
    const norm2 = Math.sqrt(vec2.reduce((sum, v) => sum + v * v, 0))
    return norm1 && norm2 ? dot / (norm1 * norm2) : 0
}

function cosineSimilarity(doc1: string, doc2: string): number {
    // Simple word overlap-based similarity (DEPRECATED - not used in MMR, kept for reference)
    // In production, consider using TF-IDF or embeddings for better accuracy
    const words1 = new Set(doc1.toLowerCase().split(/\s+/))
    const words2 = new Set(doc2.toLowerCase().split(/\s+/))

    const intersection = new Set([...words1].filter((x) => words2.has(x)))
    const union = new Set([...words1, ...words2])

    return union.size === 0 ? 0 : intersection.size / union.size
}

async function mmrNode(state: typeof RAGState.State) {
    const { rerankedResults, ragConfig } = state

    logger.info(
        {
            mmrEnabled: ragConfig.reranking.mmrEnabled,
            inputCount: rerankedResults.length,
            lambda: ragConfig.reranking.mmrLambda ?? 0.5,
            topK: ragConfig.reranking.topK,
        },
        'RAG mmrNode starting'
    )

    if (!ragConfig.reranking.mmrEnabled || rerankedResults.length < 2) {
        logger.info('MMR skipped (disabled or < 2 results)')
        return { rerankedResults }
    }

    const lambda = ragConfig.reranking.mmrLambda ?? 0.5

    // Pre-compute similarity matrix for O(n²) → O(n²/2) optimization
    // simMatrix[i][j] = cosine similarity between rerankedResults[i] and rerankedResults[j]
    const n = rerankedResults.length
    const simMatrix: (number | null)[][] = Array.from({ length: n }, () => Array(n).fill(null))

    for (let i = 0; i < n; i++) {
        const embeddingI = rerankedResults[i].embedding
        if (!embeddingI) continue
        for (let j = i + 1; j < n; j++) {
            const embeddingJ = rerankedResults[j].embedding
            if (!embeddingJ) continue
            const sim = cosineSimilarityEmbedding(embeddingI, embeddingJ)
            simMatrix[i][j] = sim
            simMatrix[j][i] = sim
        }
    }

    // Track selected indices into the original array
    const selectedIndices: number[] = []
    const remainingIndices = rerankedResults.map((_, i) => i)

    // Greedy MMR algorithm with embedding-based diversity
    while (selectedIndices.length < Math.min(n, ragConfig.reranking.topK)) {
        let bestIndex = 0
        let bestScore = -Infinity

        for (let i = 0; i < remainingIndices.length; i++) {
            const resultIndex = remainingIndices[i]
            const relevance = rerankedResults[resultIndex].relevance_score

            // Use embedding-based diversity only; skip diversity when embeddings unavailable
            let diversity = 0
            if (selectedIndices.length > 0) {
                // Check if this result has an embedding
                if (rerankedResults[resultIndex].embedding) {
                    // Find max similarity with any selected item
                    let maxSim = -Infinity
                    for (const selectedIdx of selectedIndices) {
                        const sim = simMatrix[resultIndex][selectedIdx]
                        if (sim !== null && sim > maxSim) {
                            maxSim = sim
                        }
                    }
                    diversity = maxSim === -Infinity ? 0 : maxSim
                }
            }

            const mmrScore = lambda * relevance - (1 - lambda) * diversity
            if (mmrScore > bestScore) {
                bestScore = mmrScore
                bestIndex = i
            }
        }

        selectedIndices.push(remainingIndices[bestIndex])
        remainingIndices.splice(bestIndex, 1)
    }

    const selected = selectedIndices.map((i) => rerankedResults[i])

    logger.info(
        {
            mmrInputCount: rerankedResults.length,
            mmrOutputCount: selected.length,
        },
        'RAG mmrNode completed'
    )

    return { rerankedResults: selected }
}

function contextReorderNode(state: typeof RAGState.State) {
    const { rerankedResults, ragConfig } = state

    if (!ragConfig.contextReorder?.enabled || rerankedResults.length < 4) {
        return { rerankedResults }
    }

    const strategy = ragConfig.contextReorder.autoSelect
        ? selectOptimalStrategy(rerankedResults)
        : ragConfig.contextReorder.strategy || 'sandwich'

    const reorderedResults = reorderForLongContext(rerankedResults, { strategy })

    logger.debug(
        { strategy, originalCount: rerankedResults.length, reorderedCount: reorderedResults.length },
        'Context reorder applied'
    )

    return { rerankedResults: reorderedResults }
}

/**
 * Fetch parent chunks for reranked child chunks.
 *
 * Parent-child chunking strategy:
 * - Child chunks (small, 512 chars) are used for semantic search
 * - Parent chunks (large, 2048 chars) are used for LLM context
 *
 * This node fetches the parent chunk content for each child chunk
 * to provide richer context to the LLM.
 */
async function fetchParentChunksNode(state: typeof RAGState.State) {
    const { chunkResults } = state

    if (!chunkResults || chunkResults.length === 0) {
        return { parentChunkMap: null }
    }

    // Get unique child chunk UUIDs that have parent chunks
    const childChunkUuids = chunkResults.map((c) => c.chunk.uuid).filter((uuid) => uuid) // Filter out empty uuids

    if (childChunkUuids.length === 0) {
        return { parentChunkMap: null }
    }

    try {
        // Query to get parent chunk content for each child chunk
        const placeholders = childChunkUuids.map(() => '?').join(', ')
        const sql = `
            SELECT 
                c.uuid as child_uuid,
                p.chunk_content as parent_content
            FROM skald_memochunk c
            LEFT JOIN skald_memoparentchunk p ON c.parent_chunk_id = p.uuid
            WHERE c.uuid IN (${placeholders})
            AND p.uuid IS NOT NULL
        `

        const results = await DI.em.getConnection().execute<
            Array<{
                child_uuid: string
                parent_content: string
            }>
        >(sql, childChunkUuids)

        // Build map: child_chunk_uuid -> parent_chunk_content
        const parentChunkMap = new Map<string, string>()
        for (const row of results || []) {
            parentChunkMap.set(row.child_uuid, row.parent_content)
        }

        logger.debug(
            { childChunksWithParent: parentChunkMap.size, totalChildChunks: childChunkUuids.length },
            'Fetched parent chunks for child chunks'
        )

        return { parentChunkMap }
    } catch (error) {
        logger.warn({ err: error }, 'Failed to fetch parent chunks, falling back to child content')
        return { parentChunkMap: null }
    }
}

function buildLLMInputsNode(state: typeof RAGState.State) {
    const { conversationHistory, ragConfig, rerankedResults, clientSystemPrompt, parentChunkMap, chunkResults, exactLookupResults, lookupHit } = state

    // P0-4: Confidence-based abstain — compute average relevance score
    const baseConfidenceThreshold = ragConfig.confidence?.threshold ?? 0.35
    const avgRelevanceScore =
        rerankedResults.length > 0
            ? rerankedResults.reduce((sum, r) => sum + r.relevance_score, 0) / rerankedResults.length
            : 0
    const confidenceThreshold = calculateDynamicConfidenceThreshold(rerankedResults, baseConfidenceThreshold)
    const isLowConfidence = rerankedResults.length === 0 || avgRelevanceScore < confidenceThreshold

    if (isLowConfidence) {
        logger.info(
            {
                avgRelevanceScore: avgRelevanceScore.toFixed(3),
                threshold: confidenceThreshold,
                baseThreshold: baseConfidenceThreshold,
                resultCount: rerankedResults.length,
            },
            'Low confidence retrieval detected — injecting abstain guidance'
        )
    }

    // Build context string using parent chunk content when available (better for LLM)
    // Falls back to child chunk content if no parent is available
    let contextStr = ''

    // Task 7: Prepend exact lookup results to context string
    // Found keys get their full content inserted first (highest priority evidence)
    // Missing keys get an explicit "not found" notice so the LLM can surface it
    if (exactLookupResults && exactLookupResults.length > 0) {
        // Task 12: Separate hit, archived_only, and miss statuses
        const hitResults = exactLookupResults.filter(r => r.status === 'hit')
        const archivedOnlyResults = exactLookupResults.filter(r => r.status === 'archived_only')
        const missResults = exactLookupResults.filter(r => r.status === 'miss')

        if (hitResults.length > 0) {
            contextStr += '[Exact Lookup Results — use these as primary evidence]\n'
            for (const result of hitResults) {
                contextStr += `Document: ${result.title}\n${result.content}\n`
                if (result.source_url) contextStr += `Source: ${result.source_url}\n`
                contextStr += '\n'
            }
            contextStr += '[End of Exact Lookup Results]\n\n'
        }

        // Task 12: Surface archived-only hits as distinct information
        if (archivedOnlyResults.length > 0) {
            contextStr += '[Archived Document Notice]\n'
            for (const result of archivedOnlyResults) {
                contextStr += `The document with key "${result.key}" exists but has been archived.\n`
                if (result.archivedContent) {
                    contextStr += `Archived content preview: ${result.archivedContent.substring(0, 200)}...\n`
                }
            }
            contextStr += '[End of Archived Document Notice]\n\n'
        }

        // Task 12: Provide explicit missing key notice
        if (missResults.length > 0) {
            contextStr += '[Key-Not-Found Notice]\n'
            for (const result of missResults) {
                contextStr += `The document with key "${result.key}" was NOT found in the knowledge base (neither active nor archived).\n`
            }
            contextStr += '[End of Key-Not-Found Notice]\n\n'
        }
    }

    for (let i = 0; i < rerankedResults.length; i++) {
        const result = rerankedResults[i]

        // Try to get parent chunk content for richer context
        let documentContent = result.document

        // Find the corresponding chunk UUID to look up parent content
        if (parentChunkMap && chunkResults) {
            // Match by index since rerankedResults preserves chunk order
            const chunkUuid = chunkResults[result.index]?.chunk.uuid
            if (chunkUuid && parentChunkMap.has(chunkUuid)) {
                // Use parent chunk content (larger, more context)
                documentContent = parentChunkMap.get(chunkUuid)!
            }
        }

        contextStr += `Result ${i + 1}: ${documentContent}\n\n`
    }

    let systemPrompt = ragConfig.references.enabled ? CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES : CHAT_AGENT_INSTRUCTIONS

    // P0-4: Inject low-confidence guidance into system prompt
    if (isLowConfidence) {
        const abstainGuidance =
            '\n\n[검색 신뢰도 경고]\n' +
            '검색된 컨텍스트의 관련성 점수가 낮습니다 (평균: ' +
            avgRelevanceScore.toFixed(2) +
            '). ' +
            '다음 지침을 따르십시오:\n' +
            '- 검색 결과가 질문과 직접적으로 관련이 없다면, "현재 ���장된 문서에서 해당 질문에 대한 충분한 정보를 찾지 못했습니다"라고 솔직하게 답변하십시오.\n' +
            '- 부분적으로 관련된 정보가 있다면, 해당 부분만 답변하고 확신이 낮음을 명시하십시오.\n' +
            '- 절대로 컨텍스트에 없는 내용을 만들어내지 마십시오.\n' +
            '- 답변 시 "검색 결과의 관련성이 낮아" 또는 "제한된 정보에 기반하여"와 같은 표현을 사용하십시오.'
        systemPrompt += abstainGuidance
    }

    // Task 7: Inject key-not-found guidance if explicit keys were requested but not found
    if (exactLookupResults && exactLookupResults.some(r => !r.found)) {
        const missingKeys = exactLookupResults.filter(r => !r.found).map(r => r.key)
        const keyNotFoundGuidance =
            '\n\n[Key-Not-Found Guidance]\n' +
            `The user requested specific document(s) with key(s): ${missingKeys.join(', ')}\n` +
            'These documents were NOT found in the knowledge base.\n' +
            'You MUST explicitly inform the user that the requested key(s) are not available.\n' +
            'Do NOT provide a generic "no information found" response.\n' +
            'Instead, clearly state: "The document with key [KEY] is not present in the knowledge base."\n' +
            'If semantic search results are available, you may offer them as alternatives, but make it clear they are NOT the requested document.'
        systemPrompt += keyNotFoundGuidance
    }

    if (clientSystemPrompt) {
        // escape curly braces in clientSystemPrompt so they're treated as literal text
        // langchain uses {{ and }} to escape braces
        const escapedPrompt = (clientSystemPrompt || '').replace(/{/g, '{{').replace(/}/g, '}}')
        // append to main system prompt since multiple system messages are not allowed with cli-proxy-api
        systemPrompt += `\n\nAdditional instructions: ${escapedPrompt}`
    }

    const prompts: [string, string][] = [['system', systemPrompt]]

    // Escape curly braces in conversation history to prevent LangChain template variable interpretation
    // This is necessary because chat history may contain code snippets or variable references like ${projectId}
    const escapedHistory = (conversationHistory || []).map(([role, content]) => {
        const escapedContent = content.replace(/{/g, '{{').replace(/}/g, '}}')
        return [role, escapedContent] as ['human' | 'ai' | 'system', string]
    })
    prompts.push(...escapedHistory)
    prompts.push(['human', '{input}'])

    const prompt = ChatPromptTemplate.fromMessages(prompts)

    return { prompt, contextStr }
}

// ideally we'd dynamically skip nodes based on the ragConfig but
// that's annoyingly very hard with TypeScript it seems
// so we let the nodes themselves decide whether to run or not
const ragGraphDefinition = new StateGraph(RAGState)
    .addNode('getChatHistory', getChatHistoryNode)
    .addNode('exactLookup', exactLookupNode)
    .addNode('analyzeAndRewrite', analyzeAndRewriteNode)
    .addNode('vectorSearch', vectorSearchNode)
    .addNode('getMemoProperties', getMemoPropertiesNode)
    .addNode('rerank', rerankNode)
    .addNode('validateCrag', cragValidationNode)
    .addNode('mmr', mmrNode)
    .addNode('contextReorder', contextReorderNode)
    .addNode('fetchParentChunks', fetchParentChunksNode)
    .addNode('buildLLMInputs', buildLLMInputsNode)
    .addEdge('__start__', 'getChatHistory')
    // exactLookup and analyzeAndRewrite can run in parallel after chat history is loaded
    .addEdge('getChatHistory', 'exactLookup')
    .addEdge('getChatHistory', 'analyzeAndRewrite')
    // Fan-in: vectorSearch waits for both exactLookup and analyzeAndRewrite
    .addEdge(['exactLookup', 'analyzeAndRewrite'], 'vectorSearch')
    // Fan-out: getMemoProperties and fetchParentChunks run in parallel after vectorSearch
    .addEdge('vectorSearch', 'getMemoProperties')
    .addEdge('vectorSearch', 'fetchParentChunks')
    .addEdge('getMemoProperties', 'rerank')
    .addEdge('rerank', 'validateCrag')
    .addEdge('validateCrag', 'mmr')
    .addEdge('mmr', 'contextReorder')
    // Fan-in: buildLLMInputs waits for both contextReorder and fetchParentChunks
    .addEdge(['contextReorder', 'fetchParentChunks'], 'buildLLMInputs')
    .addEdge('buildLLMInputs', END)

export const ragGraph = ragGraphDefinition.compile()

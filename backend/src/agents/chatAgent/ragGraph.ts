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

interface RerankResult {
    index: number
    document: string
    relevance_score: number
    memo_uuid?: string
    memo_title?: string
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
    memoPropertiesMap: Annotation<Map<string, { title: string; summary: string; content: string }> | null>,
    parentChunkMap: Annotation<Map<string, string> | null>, // child_chunk_uuid -> parent_chunk_content
    prompt: Annotation<ChatPromptTemplate>,
    contextStr: Annotation<string | null>,
})

async function getChatHistoryNode(state: typeof RAGState.State) {
    const { chatId, project } = state
    if (!chatId) {
        return { conversationHistory: null }
    }
    const conversationHistory = await getOptimizedChatHistory(chatId, project)
    return { conversationHistory }
}

async function queryUnderstandingNode(state: typeof RAGState.State) {
    const { query, conversationHistory, ragConfig } = state

    if (!ragConfig.queryUnderstanding?.enabled) {
        return { queryUnderstanding: null }
    }

    const context = (conversationHistory || []).map(([role, content]) => `${role}: ${content}`).join('\n')

    const understanding = await QueryUnderstandingAgent.understandQuery(query, context)

    return { queryUnderstanding: understanding }
}

async function queryRewriteNode(state: typeof RAGState.State) {
    const { query, conversationHistory, queryUnderstanding, ragConfig } = state

    if (!ragConfig.queryRewrite.enabled) {
        return { rewrittenQuery: null }
    }

    const conversationMessages = (conversationHistory || [])
        .map(([userMsg, assistantMsg]) => [
            { role: 'user' as const, content: userMsg },
            { role: 'assistant' as const, content: assistantMsg },
        ])
        .flat()

    const rewrittenQuery = await rewrite(query, conversationMessages)

    if (rewrittenQuery !== query) {
        return { rewrittenQuery }
    }

    return { rewrittenQuery: null }
}

/**
 * Adapter function to convert HybridSearchResult to MemoChunkWithDistance.
 * This allows hybrid search results to flow through the existing RAG pipeline.
 */
function hybridResultToMemoChunk(result: HybridSearchResult): MemoChunkWithDistance {
    return {
        chunk: {
            uuid: result.uuid,
            chunk_content: result.chunk_content,
            chunk_index: 0, // Not available from hybrid search
            embedding: [], // Not available from hybrid search (will be fetched if needed for MMR)
            memo_uuid: result.memo_uuid,
            project_uuid: '', // Not available from hybrid search
        },
        // Convert hybrid_score (0-1, higher is better) to distance (0-2, lower is better)
        distance: 2 * (1 - result.hybrid_score),
    }
}

async function vectorSearchNode(state: typeof RAGState.State) {
    const { rewrittenQuery, query, project, filters, ragConfig, queryUnderstanding } = state

    // Use dynamic search strategy from query understanding if available, otherwise use defaults
    const strategy = queryUnderstanding || {
        multiQuery: ragConfig.queryRewrite.multiQuery || false,
        hyde: false,
        jiraHyde: false,
        topK: ragConfig.vectorSearch.topK,
        rerank: ragConfig.reranking.enabled,
        mmr: ragConfig.reranking.mmrEnabled || false,
    }

    const searchQueries: string[] = [rewrittenQuery || query]

    // Add multi-query variations if enabled
    if (strategy.multiQuery) {
        const variants = await rewriteMultiQuery(query)
        searchQueries.push(...variants)
    }

    // Add HyDE hypothetical document if enabled
    if (strategy.hyde) {
        const hypothetical = await generateHyDE(query)
        if (hypothetical) {
            searchQueries.push(hypothetical)
        }
    }

    // Add Jira-specific HyDE if enabled
    if (strategy.jiraHyde) {
        const jiraHypothetical = await generateJiraHyDE(query)
        if (jiraHypothetical) {
            searchQueries.push(jiraHypothetical)
        }
    }

    // Check if hybrid search is enabled (default: true for Korean optimization)
    const useHybridSearch = ragConfig.hybridSearch?.enabled ?? true

    if (useHybridSearch) {
        // Use hybrid search combining vector + BM25
        const primaryQuery = searchQueries[0]
        const embeddingVector = await EmbeddingService.generateEmbedding(primaryQuery, 'search')

        try {
            const hybridResults = await HybridSearchService.hybridSearch(project, embeddingVector, primaryQuery, {
                vectorWeight: ragConfig.hybridSearch?.vectorWeight ?? 0.7,
                bm25Weight: ragConfig.hybridSearch?.bm25Weight ?? 0.3,
                topK: strategy.topK,
                similarityThreshold: ragConfig.vectorSearch.similarityThreshold,
                filters: filters?.[0], // Use first filter if available
            })

            logger.debug({ hybridResultsCount: hybridResults.length, query: primaryQuery }, 'Hybrid search completed')

            // Convert hybrid results to MemoChunkWithDistance format
            const uniqueResults = hybridResults.map(hybridResultToMemoChunk)

            return { chunkResults: uniqueResults }
        } catch (error) {
            logger.warn({ err: error }, 'Hybrid search failed, falling back to vector-only search')
            // Fall through to vector-only search
        }
    }

    // Fallback: Run vector searches in parallel for all queries
    const allResults = await Promise.all(
        searchQueries.map(async (searchQuery) => {
            const embeddingVector = await EmbeddingService.generateEmbedding(searchQuery, 'search')
            return memoChunkVectorSearch(
                project,
                embeddingVector,
                strategy.topK,
                ragConfig.vectorSearch.similarityThreshold,
                filters,
                true // Use enhanced ranking
            )
        })
    )

    // Deduplicate results by memo_uuid to avoid redundant chunks
    const seenMemoUuids = new Set<string>()
    const uniqueResults: MemoChunkWithDistance[] = []
    for (const results of allResults) {
        for (const result of results) {
            const memoUuid = result.chunk.memo_uuid
            if (!seenMemoUuids.has(memoUuid)) {
                seenMemoUuids.add(memoUuid)
                uniqueResults.push(result)
            }
        }
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
                embedding: chunk.chunk.embedding as number[], // Pass embedding for MMR
            })
        }
        return { rerankedResults }
    }

    const searchQuery = rewrittenQuery || query
    const rerankData: string[] = []
    const rerankMetadata: Array<{ memo_uuid: string; memo_title: string }> = []

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

    const rerankDataBatches: string[][] = []
    const rerankMetadataBatches: Array<Array<{ memo_uuid: string; memo_title: string }>> = []

    for (let i = 0; i < rerankData.length; i += batchSize) {
        rerankDataBatches.push(rerankData.slice(i, i + batchSize))
        rerankMetadataBatches.push(rerankMetadata.slice(i, i + batchSize))
    }

    // rerank all batches concurrently using the processed query
    const results = (
        await Promise.all(
            rerankDataBatches.map((batch, idx) => RerankService.rerank(searchQuery, batch, rerankMetadataBatches[idx]))
        )
    ).flat()

    // sort and add embeddings to results for MMR
    results.sort((a, b) => b.relevance_score - a.relevance_score)
    const resultsWithEmbeddings = results.map((result) => ({
        ...result,
        embedding: chunkResults[result.index]?.chunk.embedding as number[],
    }))
    return { rerankedResults: resultsWithEmbeddings.slice(0, ragConfig.reranking.topK) }
}

function cosineSimilarityEmbedding(vec1: number[], vec2: number[]): number {
    // Calculate cosine similarity between two embedding vectors
    const dot = vec1.reduce((sum, v, i) => sum + v * vec2[i], 0)
    const norm1 = Math.sqrt(vec1.reduce((sum, v) => sum + v * v, 0))
    const norm2 = Math.sqrt(vec2.reduce((sum, v) => sum + v * v, 0))
    return norm1 && norm2 ? dot / (norm1 * norm2) : 0
}

function cosineSimilarity(doc1: string, doc2: string): number {
    // Simple word overlap-based similarity for MMR (legacy fallback)
    // In production, consider using TF-IDF or embeddings for better accuracy
    const words1 = new Set(doc1.toLowerCase().split(/\s+/))
    const words2 = new Set(doc2.toLowerCase().split(/\s+/))

    const intersection = new Set([...words1].filter((x) => words2.has(x)))
    const union = new Set([...words1, ...words2])

    return union.size === 0 ? 0 : intersection.size / union.size
}

async function mmrNode(state: typeof RAGState.State) {
    const { rerankedResults, ragConfig } = state

    if (!ragConfig.reranking.mmrEnabled || rerankedResults.length < 2) {
        return { rerankedResults }
    }

    const lambda = ragConfig.reranking.mmrLambda ?? 0.5
    const selected: typeof rerankedResults = []
    const remaining = [...rerankedResults]

    // Greedy MMR algorithm with embedding-based diversity
    while (selected.length < Math.min(rerankedResults.length, ragConfig.reranking.topK)) {
        let bestIndex = 0
        let bestScore = -Infinity

        for (let i = 0; i < remaining.length; i++) {
            const relevance = remaining[i].relevance_score

            // Use embedding-based diversity if embeddings are available, otherwise fallback to word overlap
            const diversity =
                selected.length === 0
                    ? 0
                    : remaining[i].embedding && selected.every((s) => s.embedding)
                      ? selected.reduce(
                            (min, s) => Math.min(min, cosineSimilarityEmbedding(remaining[i].embedding!, s.embedding!)),
                            Infinity
                        )
                      : selected.reduce(
                            (min, s) => Math.min(min, cosineSimilarity(remaining[i].document, s.document)),
                            Infinity
                        )

            const mmrScore = lambda * relevance - (1 - lambda) * diversity
            if (mmrScore > bestScore) {
                bestScore = mmrScore
                bestIndex = i
            }
        }

        selected.push(remaining[bestIndex])
        remaining.splice(bestIndex, 1)
    }

    return { rerankedResults: selected }
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
        const sql = `
            SELECT 
                c.uuid as child_uuid,
                p.chunk_content as parent_content
            FROM skald_memochunk c
            LEFT JOIN skald_memoparentchunk p ON c.parent_chunk_id = p.uuid
            WHERE c.uuid = ANY(?)
            AND p.uuid IS NOT NULL
        `

        const results = await DI.em.getConnection().execute<
            Array<{
                child_uuid: string
                parent_content: string
            }>
        >(sql, [childChunkUuids])

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
    const { conversationHistory, ragConfig, rerankedResults, clientSystemPrompt, parentChunkMap, chunkResults } = state

    // Build context string using parent chunk content when available (better for LLM)
    // Falls back to child chunk content if no parent is available
    let contextStr = ''
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

    if (clientSystemPrompt) {
        // escape curly braces in clientSystemPrompt so they're treated as literal text
        // langchain uses {{ and }} to escape braces
        const escapedPrompt = (clientSystemPrompt || '').replace(/{/g, '{{').replace(/}/g, '}}')
        // append to main system prompt since multiple system messages are not allowed with cli-proxy-api
        systemPrompt += `\n\nAdditional instructions: ${escapedPrompt}`
    }

    const prompts: [string, string][] = [['system', systemPrompt]]

    prompts.push(...(conversationHistory || []))
    prompts.push(['human', '{input}'])

    const prompt = ChatPromptTemplate.fromMessages(prompts)

    return { prompt, contextStr }
}

// ideally we'd dynamically skip nodes based on the ragConfig but
// that's annoyingly very hard with TypeScript it seems
// so we let the nodes themselves decide whether to run or not
const ragGraphDefinition = new StateGraph(RAGState)
    .addNode('getChatHistory', getChatHistoryNode)
    .addNode('analyzeQuery', queryUnderstandingNode)
    .addNode('queryRewrite', queryRewriteNode)
    .addNode('vectorSearch', vectorSearchNode)
    .addNode('getMemoProperties', getMemoPropertiesNode)
    .addNode('rerank', rerankNode)
    .addNode('mmr', mmrNode)
    .addNode('fetchParentChunks', fetchParentChunksNode)
    .addNode('buildLLMInputs', buildLLMInputsNode)
    .addEdge('__start__', 'getChatHistory')
    .addEdge('getChatHistory', 'analyzeQuery')
    .addEdge('analyzeQuery', 'queryRewrite')
    .addEdge('queryRewrite', 'vectorSearch')
    .addEdge('vectorSearch', 'getMemoProperties')
    .addEdge('getMemoProperties', 'rerank')
    .addEdge('rerank', 'mmr')
    .addEdge('mmr', 'fetchParentChunks')
    .addEdge('fetchParentChunks', 'buildLLMInputs')
    .addEdge('buildLLMInputs', END)

export const ragGraph = ragGraphDefinition.compile()

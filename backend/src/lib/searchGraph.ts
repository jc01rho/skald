import { Project } from '@/entities/Project'
import { MemoFilter } from '@/lib/filterUtils'
import { EmbeddingService } from '@/services/embeddingService'
import { memoChunkVectorSearch, MemoChunkWithDistance } from '@/embeddings/vectorSearch'
import { getTitleAndSummaryAndContentForMemoList } from '@/queries/memo'
import { StateGraph, END } from '@langchain/langgraph'
import { Annotation } from '@langchain/langgraph'
import { RerankService } from '@/services/rerankService'
import { mapWithConcurrency } from '@/lib/asyncUtils'
import { HNSWOptimizationService } from '@/lib/hnswOptimization'
import { DI } from '@/di'
import { SEARCH_QUERY_REWRITE_ENABLED } from '@/settings'
import { rewrite } from '@/agents/chatAgent/queryRewrite'
import { hasExplicitKeys } from '@/lib/keyExtractor'
import { buildRerankDocument, buildRerankQuery } from '@/lib/rerankPayload'

export interface SearchResult {
    chunk_uuid: string
    memo_uuid: string
    memo_title: string
    memo_summary: string
    content_snippet: string
    chunk_content: string
    distance: number
}

interface RerankResult {
    index: number
    document: string
    relevance_score: number
    memo_uuid?: string
    memo_title?: string
}

const SearchGraphState = Annotation.Root({
    project: Annotation<Project>,
    query: Annotation<string>,
    rewrittenQuery: Annotation<string | null>,
    limit: Annotation<number>,
    filters: Annotation<MemoFilter[]>,
    chunkResults: Annotation<MemoChunkWithDistance[] | null>,
    memoPropertiesMap: Annotation<Map<string, { title: string; summary: string; content: string }> | null>,
    rerankedResults: Annotation<RerankResult[]>,
    results: Annotation<SearchResult[]>,
})

/**
 * At most this many chunks from one memo may occupy the result window. A single memo can otherwise
 * fill all ten slots with near-identical chunks.
 */
const MAX_CHUNKS_PER_MEMO = 3

function uniqueQueries(queries: string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const value of queries) {
        const query = value.trim()
        if (!query || seen.has(query)) continue
        seen.add(query)
        result.push(query)
    }
    return result
}

function chunkContentKey(memoUuid: string, chunkContent: string): string {
    return `${memoUuid}\u0000${chunkContent.trim()}`
}

/**
 * Drop duplicate rows (same memo + same chunk text) and cap how many chunks one memo can contribute.
 * Candidates are expected to be ordered best-first.
 */
export function dedupeAndCapChunks(
    chunks: MemoChunkWithDistance[],
    maxPerMemo = MAX_CHUNKS_PER_MEMO,
    limit?: number
): MemoChunkWithDistance[] {
    const seen = new Set<string>()
    const perMemo = new Map<string, number>()
    const result: MemoChunkWithDistance[] = []

    for (const chunk of chunks) {
        const key = chunkContentKey(chunk.chunk.memo_uuid, chunk.chunk.chunk_content)
        if (seen.has(key)) continue

        const used = perMemo.get(chunk.chunk.memo_uuid) ?? 0
        if (used >= maxPerMemo) continue

        seen.add(key)
        perMemo.set(chunk.chunk.memo_uuid, used + 1)
        result.push(chunk)

        if (limit !== undefined && result.length >= limit) break
    }

    return result
}

export function dedupeAndCapResults(
    results: SearchResult[],
    maxPerMemo = MAX_CHUNKS_PER_MEMO,
    limit?: number
): SearchResult[] {
    const seen = new Set<string>()
    const perMemo = new Map<string, number>()
    const deduped: SearchResult[] = []

    for (const result of results) {
        const key = chunkContentKey(result.memo_uuid, result.chunk_content)
        if (seen.has(key)) continue

        const used = perMemo.get(result.memo_uuid) ?? 0
        if (used >= maxPerMemo) continue

        seen.add(key)
        perMemo.set(result.memo_uuid, used + 1)
        deduped.push(result)

        if (limit !== undefined && deduped.length >= limit) break
    }

    return deduped
}

/**
 * Rewrite the search query for the reranker arm while keeping the original query as its own
 * vector arm. Explicit identifier queries (Jira keys, doc refs) are searched verbatim: rewriting
 * them risks losing the exact token and costs an LLM round-trip for no retrieval gain.
 */
async function buildSearchRewrite(query: string): Promise<string | null> {
    if (!SEARCH_QUERY_REWRITE_ENABLED || hasExplicitKeys(query)) {
        return null
    }

    const rewritten = (await rewrite(query, [])).trim()
    return rewritten && rewritten !== query.trim() ? rewritten : null
}

async function vectorSearchNode(state: typeof SearchGraphState.State) {
    const { query, project, filters, limit } = state

    await HNSWOptimizationService.applyRuntimeSearchTuning(DI.em)

    const rewrittenQuery = await buildSearchRewrite(query)
    const searchQueries = uniqueQueries([query, ...(rewrittenQuery ? [rewrittenQuery] : [])])
    const embeddings = await EmbeddingService.generateEmbeddingsBatch(searchQueries, 'search')

    const allResults = await mapWithConcurrency(
        searchQueries.map((searchQuery, index) => ({ searchQuery, embedding: embeddings[index] })),
        4,
        async ({ embedding }) => memoChunkVectorSearch(project, embedding, limit, 0.75, filters)
    )

    // Merge the original-query and rewritten-query arms, keeping the best distance per chunk.
    const bestByKey = new Map<string, MemoChunkWithDistance>()
    for (const results of allResults) {
        for (const result of results) {
            const key = chunkContentKey(result.chunk.memo_uuid, result.chunk.chunk_content)
            const existing = bestByKey.get(key)
            if (!existing || result.distance < existing.distance) {
                bestByKey.set(key, result)
            }
        }
    }

    const merged = Array.from(bestByKey.values()).sort((a, b) => a.distance - b.distance)
    const chunkResults = dedupeAndCapChunks(merged)

    return { chunkResults, rewrittenQuery }
}

async function getMemoPropertiesNode(state: typeof SearchGraphState.State) {
    const { chunkResults, project } = state
    if (!chunkResults) {
        return { memoPropertiesMap: null }
    }

    const relevantMemoUuids = Array.from(new Set(chunkResults.map((c) => c.chunk.memo_uuid)))
    const memoPropertiesMap = await getTitleAndSummaryAndContentForMemoList(project.uuid, relevantMemoUuids)

    return { memoPropertiesMap }
}

async function rerankNode(state: typeof SearchGraphState.State) {
    const { chunkResults, memoPropertiesMap, query, limit, rewrittenQuery } = state
    if (!chunkResults) {
        return { rerankedResults: [] }
    }

    const rerankQuery = buildRerankQuery(rewrittenQuery || query)
    const rerankData: string[] = []
    const rerankMetadata: Array<{ memo_uuid: string; memo_title: string }> = []

    for (const chunkResult of chunkResults) {
        const chunk = chunkResult.chunk
        const memo = memoPropertiesMap?.get(chunk.memo_uuid)

        rerankData.push(buildRerankDocument(chunk.chunk_content, memo))
        rerankMetadata.push({
            memo_uuid: chunk.memo_uuid,
            memo_title: memo?.title || '',
        })
    }

    const rerankCutoff = Math.min(limit * 4, rerankData.length)
    const truncatedData = rerankData.slice(0, rerankCutoff)
    const truncatedMetadata = rerankMetadata.slice(0, rerankCutoff)

    const rerankDataBatches: string[][] = []
    const rerankMetadataBatches: Array<Array<{ memo_uuid: string; memo_title: string }>> = []

    for (let i = 0; i < truncatedData.length; i += 25) {
        rerankDataBatches.push(truncatedData.slice(i, i + 25))
        rerankMetadataBatches.push(truncatedMetadata.slice(i, i + 25))
    }

    const batchResults = await mapWithConcurrency(rerankDataBatches, 3, async (batch, batchIdx) =>
        RerankService.rerank(rerankQuery, batch, rerankMetadataBatches[batchIdx], {
            batchOffset: batchIdx * 25,
            totalCount: truncatedData.length,
        })
    )

    // Adjust indices to be global (batch-relative indices need to be offset by batch start)
    const results: RerankResult[] = []
    for (let batchIdx = 0; batchIdx < batchResults.length; batchIdx++) {
        const batchStart = batchIdx * 25
        for (const result of batchResults[batchIdx]) {
            results.push({
                ...result,
                index: batchStart + result.index,
            })
        }
    }

    // sort by relevance score; per-memo capping happens when building the final window
    results.sort((a, b) => b.relevance_score - a.relevance_score)
    return { rerankedResults: results }
}

function buildResultsNode(state: typeof SearchGraphState.State) {
    const { chunkResults, memoPropertiesMap, rerankedResults, limit } = state
    if (!chunkResults) {
        return { results: [] }
    }

    // Create a map from original index to chunk result for easy lookup
    const chunkMap = new Map<number, MemoChunkWithDistance>()
    chunkResults.forEach((chunk, idx) => {
        chunkMap.set(idx, chunk)
    })

    // Build results from reranked results, mapping back to original chunks
    const results: SearchResult[] = rerankedResults.map((reranked) => {
        const originalChunk = chunkMap.get(reranked.index)
        if (!originalChunk) {
            throw new Error(`Chunk at index ${reranked.index} not found`)
        }

        const memo = memoPropertiesMap?.get(originalChunk.chunk.memo_uuid)

        return {
            chunk_uuid: originalChunk.chunk.uuid,
            memo_uuid: originalChunk.chunk.memo_uuid,
            memo_title: memo?.title || '',
            memo_summary: memo?.summary || '',
            content_snippet: memo?.content.slice(0, 100) || '',
            chunk_content: originalChunk.chunk.chunk_content || '',
            // Convert relevance_score (0-1) to distance (lower is better, so invert)
            distance: 1 - reranked.relevance_score,
        }
    })

    return { results: dedupeAndCapResults(results, MAX_CHUNKS_PER_MEMO, limit) }
}

const searchGraphDefinition = new StateGraph(SearchGraphState)
    .addNode('vectorSearch', vectorSearchNode)
    .addNode('getMemoProperties', getMemoPropertiesNode)
    .addNode('rerank', rerankNode)
    .addNode('buildResults', buildResultsNode)
    .addEdge('__start__', 'vectorSearch')
    .addEdge('vectorSearch', 'getMemoProperties')
    .addEdge('getMemoProperties', 'rerank')
    .addEdge('rerank', 'buildResults')
    .addEdge('buildResults', END)

export const searchGraph = searchGraphDefinition.compile()

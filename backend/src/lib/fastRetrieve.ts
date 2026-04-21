import { Project } from '@/entities/Project'
import { memoChunkVectorSearch } from '@/embeddings/vectorSearch'
import { DI } from '@/di'
import { MemoFilter } from '@/lib/filterUtils'
import { HNSWOptimizationService } from '@/lib/hnswOptimization'
import { logger } from '@/lib/logger'
import { getTitleAndSummaryAndContentForMemoList } from '@/queries/memo'
import { EmbeddingService } from '@/services/embeddingService'

const DEFAULT_FAST_RETRIEVE_LIMIT = 5
const DEFAULT_SIMILARITY_THRESHOLD = 0.75
const MAX_SUMMARY_LENGTH = 160
const MAX_SNIPPET_LENGTH = 240

export interface FastRetrieveResultItem {
    rank: number
    chunk_uuid: string
    chunk_index: number
    memo_uuid: string
    memo_title: string
    memo_summary: string
    source_url?: string
    snippet: string
    distance: number
}

export interface FastRetrieveResult {
    contextStr: string
    results: FastRetrieveResultItem[]
}

function normalizeInlineWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

function compactText(value: string | null | undefined, maxLength: number): string {
    const normalized = normalizeInlineWhitespace(value || '')

    if (normalized.length <= maxLength) {
        return normalized
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function buildCompactContext(results: FastRetrieveResultItem[]): string {
    if (results.length === 0) {
        return ''
    }

    return `${results
        .map((result) => {
            const lines = [`Result ${result.rank}:`, `Title: ${result.memo_title || 'Untitled document'}`]

            if (result.memo_summary) {
                lines.push(`Summary: ${result.memo_summary}`)
            }

            if (result.snippet) {
                lines.push(`Snippet: ${result.snippet}`)
            }

            if (result.source_url) {
                lines.push(`Source: ${result.source_url}`)
            }

            return lines.join('\n')
        })
        .join('\n\n')}\n\n`
}

export async function fastRetrieve({
    project,
    query,
    filters = [],
    limit = DEFAULT_FAST_RETRIEVE_LIMIT,
    similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
}: {
    project: Project
    query: string
    filters?: MemoFilter[]
    limit?: number
    similarityThreshold?: number
}): Promise<FastRetrieveResult> {
    const normalizedQuery = normalizeInlineWhitespace(query)

    if (!normalizedQuery) {
        logger.debug({ projectUuid: project.uuid }, 'Fast preview retrieval skipped for empty query')
        return { contextStr: '', results: [] }
    }

    await HNSWOptimizationService.applyRuntimeSearchTuning(DI.em)

    const embeddingVector = await EmbeddingService.generateEmbedding(normalizedQuery, 'search')
    const chunkResults = await memoChunkVectorSearch(
        project,
        embeddingVector,
        limit,
        similarityThreshold,
        filters,
        false
    )

    if (chunkResults.length === 0) {
        logger.debug(
            { projectUuid: project.uuid, query: normalizedQuery.slice(0, 50), limit, filterCount: filters.length },
            'Fast preview retrieval returned no matches'
        )
        return { contextStr: '', results: [] }
    }

    const relevantMemoUuids = Array.from(new Set(chunkResults.map((result) => result.chunk.memo_uuid)))
    const memoPropertiesMap = await getTitleAndSummaryAndContentForMemoList(project.uuid, relevantMemoUuids)

    const results: FastRetrieveResultItem[] = chunkResults.map((result, index) => {
        const memoProperties = memoPropertiesMap.get(result.chunk.memo_uuid)
        const memoTitle = memoProperties?.title || ''
        const memoSummary = compactText(memoProperties?.summary, MAX_SUMMARY_LENGTH)
        const snippet = compactText(result.chunk.chunk_content || memoProperties?.content || '', MAX_SNIPPET_LENGTH)

        return {
            rank: index + 1,
            chunk_uuid: result.chunk.uuid,
            chunk_index: result.chunk.chunk_index,
            memo_uuid: result.chunk.memo_uuid,
            memo_title: memoTitle,
            memo_summary: memoSummary,
            source_url: memoProperties?.source_url || undefined,
            snippet,
            distance: result.distance,
        }
    })

    logger.info(
        {
            projectUuid: project.uuid,
            query: normalizedQuery.slice(0, 50),
            resultCount: results.length,
            limit,
            filterCount: filters.length,
        },
        'Fast preview retrieval completed'
    )

    return {
        contextStr: buildCompactContext(results),
        results,
    }
}

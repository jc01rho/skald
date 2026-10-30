import { z } from 'zod'
import { POST_RERANK_TOP_K } from '@/settings'
import { logger } from '@/lib/logger'

const INTERNAL_RERANK_URL = process.env.INTERNAL_RERANK_URL || 'http://rerank-service:8889/v1/rerank'

interface RerankResult {
    index: number
    document: any
    relevance_score: number
    memo_uuid?: string
    memo_title?: string
    source_url?: string
}

interface RerankMetadata {
    memo_uuid: string
    memo_title: string
    source_url?: string
}

interface RerankOptions {
    originalQuery?: string
    /**
     * Position of this batch in the caller's full candidate list, and that list's size. Only used by the
     * failure fallback so batched callers that merge and sort by score keep the global retrieval order.
     */
    batchOffset?: number
    totalCount?: number
}

function buildRerankQuery(query: string, options?: RerankOptions): string {
    const normalizedQuery = query.trim()
    const normalizedOriginal = options?.originalQuery?.trim()

    if (!normalizedOriginal || normalizedOriginal === normalizedQuery) {
        return normalizedQuery
    }

    return `${normalizedOriginal}\n\nRewritten retrieval query: ${normalizedQuery}`
}

function withMetadata(result: RerankResult, metadata?: RerankMetadata[]): RerankResult {
    const meta = metadata?.[result.index]
    if (meta) {
        result.memo_uuid = meta.memo_uuid
        result.memo_title = meta.memo_title
        result.source_url = meta.source_url
    }
    return result
}

function applyTopK(results: RerankResult[]): RerankResult[] {
    return POST_RERANK_TOP_K > 0 ? results.slice(0, POST_RERANK_TOP_K) : results
}

/**
 * Fallback when the rerank endpoint is unavailable: keep the retrieval order, scoring by original rank.
 */
function originalOrderResults(results: any[], metadata?: RerankMetadata[], options?: RerankOptions): RerankResult[] {
    const offset = options?.batchOffset ?? 0
    const total = Math.max(options?.totalCount ?? results.length, offset + results.length)
    return applyTopK(
        results.map((document, index) =>
            withMetadata({ index, document, relevance_score: 1 - (offset + index) / total }, metadata)
        )
    )
}

const isValidRerankEntry = (entry: any, resultCount: number): boolean =>
    !!entry &&
    Number.isInteger(entry.index) &&
    entry.index >= 0 &&
    entry.index < resultCount &&
    typeof entry.relevance_score === 'number' &&
    Number.isFinite(entry.relevance_score)

export class RerankService {
    static async rerank(
        query: string,
        results: any[],
        metadata?: RerankMetadata[],
        options?: RerankOptions
    ): Promise<RerankResult[]> {
        return this.rerankInternal(query, results, metadata, options)
    }

    private static async rerankInternal(
        query: string,
        results: any[],
        metadata?: RerankMetadata[],
        options?: RerankOptions
    ): Promise<RerankResult[]> {
        if (!results || results.length === 0) {
            return []
        }

        try {
            return await this.requestRerank(query, results, metadata, options)
        } catch (error) {
            logger.warn(
                { err: error, url: INTERNAL_RERANK_URL, resultCount: results.length },
                'Rerank failed; falling back to original retrieval order'
            )
            return originalOrderResults(results, metadata, options)
        }
    }

    private static async requestRerank(
        query: string,
        results: any[],
        metadata?: RerankMetadata[],
        options?: RerankOptions
    ): Promise<RerankResult[]> {
        const rerankQuery = buildRerankQuery(query, options)

        const response = await fetch(INTERNAL_RERANK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: rerankQuery,
                documents: results.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))),
                top_n: POST_RERANK_TOP_K,
                model: 'rerank-model', // Model name for compatibility
            }),
            signal: AbortSignal.timeout(30000),
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`Internal rerank service error: ${response.status} - ${errorText}`)
        }

        const data = (await response.json()) as {
            results: Array<{
                index: number
                relevance_score: number
                document?: { text: string }
            }>
        }

        if (!Array.isArray(data?.results) || !data.results.every((entry) => isValidRerankEntry(entry, results.length))) {
            throw new Error('Internal rerank service returned malformed results')
        }

        const parsedResults = data.results.map((result) =>
            withMetadata(
                {
                    index: result.index,
                    document: results[result.index],
                    relevance_score: result.relevance_score,
                },
                metadata
            )
        )

        parsedResults.sort((a, b) => b.relevance_score - a.relevance_score)

        return applyTopK(parsedResults)
    }
}

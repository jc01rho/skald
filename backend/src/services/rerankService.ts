import { z } from 'zod'
import { POST_RERANK_TOP_K } from '@/settings'

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
}

function buildRerankQuery(query: string, options?: RerankOptions): string {
    const normalizedQuery = query.trim()
    const normalizedOriginal = options?.originalQuery?.trim()

    if (!normalizedOriginal || normalizedOriginal === normalizedQuery) {
        return normalizedQuery
    }

    return `${normalizedOriginal}\n\nRewritten retrieval query: ${normalizedQuery}`
}

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

        const parsedResults = data.results.map((result) => {
            const rerankResult: RerankResult = {
                index: result.index,
                document: results[result.index],
                relevance_score: result.relevance_score,
            }

            if (metadata && metadata[result.index]) {
                rerankResult.memo_uuid = metadata[result.index].memo_uuid
                rerankResult.memo_title = metadata[result.index].memo_title
                rerankResult.source_url = metadata[result.index].source_url
            }

            return rerankResult
        })

        parsedResults.sort((a, b) => b.relevance_score - a.relevance_score)

        if (POST_RERANK_TOP_K > 0) {
            return parsedResults.slice(0, POST_RERANK_TOP_K)
        }

        return parsedResults
    }
}

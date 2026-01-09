import { z } from 'zod'

// Hardcoded internal rerank endpoint
const INTERNAL_RERANK_URL = 'http://192.168.150.37/v1/rerank'

const POST_RERANK_TOP_K = parseInt(process.env.POST_RERANK_TOP_K || '10')

interface RerankResult {
    index: number
    document: any
    relevance_score: number
    memo_uuid?: string
    memo_title?: string
}

interface RerankMetadata {
    memo_uuid: string
    memo_title: string
}

export class RerankService {
    /**
     * Service for reranking results using internal endpoint (192.168.150.37)
     */

    static async rerank(query: string, results: any[], metadata?: RerankMetadata[]): Promise<RerankResult[]> {
        return this.rerankInternal(query, results, metadata)
    }

    /**
     * Rerank using internal endpoint (192.168.150.37/v1/rerank)
     */
    private static async rerankInternal(
        query: string,
        results: any[],
        metadata?: RerankMetadata[]
    ): Promise<RerankResult[]> {
        if (!results || results.length === 0) {
            return []
        }

        const response = await fetch(INTERNAL_RERANK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query,
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

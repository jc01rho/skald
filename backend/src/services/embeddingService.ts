import { EMBEDDING_V2_DIMENSION, EMBEDDING_V2_MODEL, EMBEDDING_V2_URL } from '../settings'
import { logger } from '../lib/logger'
import { getCachedEmbedding, cacheEmbedding } from '../lib/ragCache'

const toEmbeddingsEndpoint = (baseUrl: string): string => {
    const trimmed = baseUrl.replace(/\/+$/, '')
    return trimmed.endsWith('/v1/embeddings') ? trimmed : `${trimmed}/v1/embeddings`
}

interface EmbeddingEndpoint {
    url: string
    model: string
}

const getEndpoint = (): EmbeddingEndpoint => {
    if (!EMBEDDING_V2_URL) {
        throw new Error('EMBEDDING_V2_URL is not configured; cannot generate embeddings')
    }
    return { url: toEmbeddingsEndpoint(EMBEDDING_V2_URL), model: EMBEDDING_V2_MODEL }
}

/**
 * Embeddings are 512-dim vectors from EMBEDDING_V2_URL, stored in the `embedding_v2` column.
 * The dimension must match exactly (no padding/truncation).
 */
class EmbeddingService {
    private static async getCachedValidEmbedding(content: string): Promise<number[] | null> {
        const cached = await getCachedEmbedding(content)
        if (cached && cached.length !== EMBEDDING_V2_DIMENSION) {
            logger.warn({ dimension: cached.length }, 'Ignoring cached embedding with wrong dimension')
            return null
        }
        return cached
    }

    static validateEmbedding(embedding: number[]): number[] {
        if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_V2_DIMENSION) {
            throw new Error(
                `Embedding dimension mismatch: expected ${EMBEDDING_V2_DIMENSION}, got ${Array.isArray(embedding) ? embedding.length : typeof embedding}`
            )
        }
        return embedding
    }

    /**
     * Generate embedding using an OpenAI-compatible endpoint
     */
    private static async requestEmbedding(content: string, endpoint: EmbeddingEndpoint): Promise<number[]> {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 30000)

        try {
            const response = await fetch(endpoint.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    input: content,
                    model: endpoint.model,
                }),
                signal: controller.signal,
            })

            clearTimeout(timeoutId)

            if (!response.ok) {
                const errorText = await response.text()
                throw new Error(`Embedding service error: ${response.status} - ${errorText}`)
            }

            const data = (await response.json()) as {
                data: Array<{ embedding: number[]; index: number }>
                model: string
                usage: { prompt_tokens: number; total_tokens: number }
            }

            if (!data.data?.[0]?.embedding) {
                throw new Error('Could not generate vector embedding from embedding service')
            }

            return data.data[0].embedding
        } catch (error) {
            clearTimeout(timeoutId)
            if (error instanceof Error && error.name === 'AbortError') {
                logger.error({ url: endpoint.url }, 'Embedding request timed out after 30s')
                throw new Error('Embedding service request timed out')
            }
            logger.error({ err: error, url: endpoint.url }, 'Embedding service request failed')
            throw error
        }
    }

    /**
     * Generate embeddings for multiple inputs in a single HTTP call.
     * OpenAI-compatible API accepts `input` as a string array.
     * Falls back to sequential single calls if batch request fails.
     */
    private static async requestEmbeddingsBatch(contents: string[], endpoint: EmbeddingEndpoint): Promise<number[][]> {
        if (contents.length === 0) return []
        if (contents.length === 1) {
            const single = await this.requestEmbedding(contents[0], endpoint)
            return [single]
        }

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 60000) // longer timeout for batch

        try {
            const response = await fetch(endpoint.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    input: contents,
                    model: endpoint.model,
                }),
                signal: controller.signal,
            })

            clearTimeout(timeoutId)

            if (!response.ok) {
                const errorText = await response.text()
                throw new Error(`Batch embedding service error: ${response.status} - ${errorText}`)
            }

            const data = (await response.json()) as {
                data: Array<{ embedding: number[]; index: number }>
                model: string
                usage: { prompt_tokens: number; total_tokens: number }
            }

            if (!data.data || data.data.length === 0) {
                throw new Error('Batch embedding returned empty results')
            }

            // Sort by index to maintain input order
            const sorted = [...data.data].sort((a, b) => a.index - b.index)
            return sorted.map((d) => d.embedding)
        } catch (error) {
            clearTimeout(timeoutId)
            if (error instanceof Error && error.name === 'AbortError') {
                logger.error(
                    { url: endpoint.url, batchSize: contents.length },
                    'Batch embedding request timed out after 60s'
                )
                throw new Error('Batch embedding service request timed out')
            }
            // Fall back to sequential single calls
            logger.warn(
                { err: error, batchSize: contents.length, url: endpoint.url },
                'Batch embedding failed, falling back to sequential calls'
            )
            const results: number[][] = []
            for (const content of contents) {
                results.push(await this.requestEmbedding(content, endpoint))
            }
            return results
        }
    }

    /**
     * Generate a 512-dim embedding. Storage and search use the same model/column.
     * Throws when EMBEDDING_V2_URL is not configured or the dimension is not exactly EMBEDDING_V2_DIMENSION.
     */
    static async generateEmbedding(content: string, _usage: 'storage' | 'search'): Promise<number[]> {
        const endpoint = getEndpoint()
        const cached = await this.getCachedValidEmbedding(content)
        if (cached) return cached
        const embedding = this.validateEmbedding(await this.requestEmbedding(content, endpoint))
        await cacheEmbedding(content, embedding)
        return embedding
    }

    /**
     * Generate embeddings for multiple texts in a single batch HTTP call.
     * Uses cache for individual items — only uncached texts are sent to the API.
     * Returns embeddings in the same order as input.
     * `useCache: false` skips the Redis cache entirely (used by the backfill so a full-corpus pass does not flood Redis).
     */
    static async generateEmbeddingsBatch(
        contents: string[],
        _usage: 'storage' | 'search',
        options: { useCache?: boolean } = {}
    ): Promise<number[][]> {
        const endpoint = getEndpoint()
        const useCache = options.useCache ?? true
        if (contents.length === 0) return []

        const results: (number[] | null)[] = new Array(contents.length).fill(null)
        const uncachedIndices: number[] = []
        const uncachedContents: string[] = []

        for (let i = 0; i < contents.length; i++) {
            const cached = useCache ? await this.getCachedValidEmbedding(contents[i]) : null
            if (cached) {
                results[i] = cached
            } else {
                uncachedIndices.push(i)
                uncachedContents.push(contents[i])
            }
        }

        if (uncachedContents.length > 0) {
            logger.debug(
                { total: contents.length, cached: contents.length - uncachedContents.length, uncached: uncachedContents.length },
                'Batch embedding: cache hit ratio'
            )

            const rawEmbeddings = await this.requestEmbeddingsBatch(uncachedContents, endpoint)
            for (let j = 0; j < uncachedIndices.length; j++) {
                const embedding = this.validateEmbedding(rawEmbeddings[j])
                results[uncachedIndices[j]] = embedding
                if (useCache) {
                    await cacheEmbedding(uncachedContents[j], embedding)
                }
            }
        }

        return results as number[][]
    }
}

export { EmbeddingService }

import {
    EMBEDDING_READ_VERSION,
    EMBEDDING_V2_DIMENSION,
    EMBEDDING_V2_MODEL,
    EMBEDDING_V2_URL,
    EMBEDDING_VECTOR_DIMENSION,
    EmbeddingVersion,
} from '../settings'
import { logger } from '../lib/logger'
import { getCachedEmbedding, cacheEmbedding } from '../lib/ragCache'

const EMBEDDING_URL =
    process.env.EMBEDDING_SERVICE_URL || process.env.INTERNAL_EMBEDDING_URL || 'http://embedding-service:8889'

const toEmbeddingsEndpoint = (baseUrl: string): string =>
    baseUrl.endsWith('/v1/embeddings') ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/v1/embeddings`

const INTERNAL_EMBEDDING_URL = toEmbeddingsEndpoint(EMBEDDING_URL)

const TARGET_DIMENSION = EMBEDDING_VECTOR_DIMENSION

interface EmbeddingEndpoint {
    url: string
    model: string
}

const V1_ENDPOINT: EmbeddingEndpoint = { url: INTERNAL_EMBEDDING_URL, model: 'text-embedding-model' }

const getV2Endpoint = (): EmbeddingEndpoint => {
    if (!EMBEDDING_V2_URL) {
        throw new Error('EMBEDDING_V2_URL is not configured; embedding v2 is disabled')
    }
    return { url: toEmbeddingsEndpoint(EMBEDDING_V2_URL), model: EMBEDDING_V2_MODEL }
}

class EmbeddingService {
    private static normalizeEmbedding(embedding: number[]): number[] {
        const currentDim = embedding.length

        if (currentDim === TARGET_DIMENSION) {
            return embedding
        } else if (currentDim < TARGET_DIMENSION) {
            // Pad with zeros
            return [...embedding, ...Array(TARGET_DIMENSION - currentDim).fill(0)]
        } else {
            throw new Error(`Embedding dimension ${currentDim} exceeds maximum supported dimension ${TARGET_DIMENSION}`)
        }
    }

    /**
     * v2 vectors are stored in vector(512) as-is: the dimension must match exactly (no padding/truncation).
     */
    static validateEmbeddingV2(embedding: number[]): number[] {
        if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_V2_DIMENSION) {
            throw new Error(
                `Embedding v2 dimension mismatch: expected ${EMBEDDING_V2_DIMENSION}, got ${Array.isArray(embedding) ? embedding.length : typeof embedding}`
            )
        }
        return embedding
    }

    /**
     * Generate embedding using an OpenAI-compatible endpoint
     */
    private static async generateInternalEmbedding(
        content: string,
        endpoint: EmbeddingEndpoint = V1_ENDPOINT
    ): Promise<number[]> {
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
                throw new Error(`Internal embedding service error: ${response.status} - ${errorText}`)
            }

            const data = (await response.json()) as {
                data: Array<{ embedding: number[]; index: number }>
                model: string
                usage: { prompt_tokens: number; total_tokens: number }
            }

            if (!data.data?.[0]?.embedding) {
                throw new Error('Could not generate vector embedding from internal service')
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
    private static async generateInternalEmbeddingsBatch(
        contents: string[],
        endpoint: EmbeddingEndpoint = V1_ENDPOINT
    ): Promise<number[][]> {
        if (contents.length === 0) return []
        if (contents.length === 1) {
            const single = await this.generateInternalEmbedding(contents[0], endpoint)
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
                results.push(await this.generateInternalEmbedding(content, endpoint))
            }
            return results
        }
    }

    /**
     * Generate embedding.
     * - usage 'storage' always produces v1 (the `embedding` column); v2 storage goes through generateEmbeddingV2.
     * - usage 'search' follows EMBEDDING_READ_VERSION so query vectors match the column vector search reads.
     */
    static async generateEmbedding(content: string, usage: 'storage' | 'search'): Promise<number[]> {
        if (usage === 'search' && EMBEDDING_READ_VERSION === 'v2') {
            return this.generateEmbeddingV2(content)
        }
        const cached = await getCachedEmbedding(content)
        if (cached) return cached
        const embedding = await this.generateInternalEmbedding(content)
        const normalized = this.normalizeEmbedding(embedding)

        await cacheEmbedding(content, normalized)
        return normalized
    }

    /**
     * Generate embeddings for multiple texts in a single batch HTTP call.
     * Uses cache for individual items — only uncached texts are sent to the API.
     * Returns embeddings in the same order as input.
     */
    static async generateEmbeddingsBatch(contents: string[], usage: 'storage' | 'search'): Promise<number[][]> {
        if (usage === 'search' && EMBEDDING_READ_VERSION === 'v2') {
            return this.generateEmbeddingsBatchV2(contents)
        }
        if (contents.length === 0) return []
        if (contents.length === 1) return [await this.generateEmbedding(contents[0], usage)]

        // Check cache for each input
        const results: (number[] | null)[] = new Array(contents.length).fill(null)
        const uncachedIndices: number[] = []
        const uncachedContents: string[] = []

        for (let i = 0; i < contents.length; i++) {
            const cached = await getCachedEmbedding(contents[i])
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

            const rawEmbeddings = await this.generateInternalEmbeddingsBatch(uncachedContents)

            for (let j = 0; j < uncachedIndices.length; j++) {
                const normalized = this.normalizeEmbedding(rawEmbeddings[j])
                results[uncachedIndices[j]] = normalized
                await cacheEmbedding(uncachedContents[j], normalized)
            }
        }

        return results as number[][]
    }

    /**
     * Generate a v2 (512-dim, L2-normalized) embedding from EMBEDDING_V2_URL.
     * Throws when v2 is not configured or the dimension is not exactly EMBEDDING_V2_DIMENSION.
     */
    static async generateEmbeddingV2(content: string): Promise<number[]> {
        const endpoint = getV2Endpoint()
        const cached = await getCachedEmbedding(content, 'v2')
        if (cached) return cached
        const embedding = this.validateEmbeddingV2(await this.generateInternalEmbedding(content, endpoint))
        await cacheEmbedding(content, embedding, undefined, 'v2')
        return embedding
    }

    /**
     * Batch variant of generateEmbeddingV2. `useCache: false` skips the Redis cache entirely
     * (used by the backfill so a full-corpus pass does not flood Redis).
     */
    static async generateEmbeddingsBatchV2(
        contents: string[],
        options: { useCache?: boolean } = {}
    ): Promise<number[][]> {
        const endpoint = getV2Endpoint()
        const useCache = options.useCache ?? true
        if (contents.length === 0) return []

        const results: (number[] | null)[] = new Array(contents.length).fill(null)
        const uncachedIndices: number[] = []
        const uncachedContents: string[] = []

        for (let i = 0; i < contents.length; i++) {
            const cached = useCache ? await getCachedEmbedding(contents[i], 'v2') : null
            if (cached) {
                results[i] = cached
            } else {
                uncachedIndices.push(i)
                uncachedContents.push(contents[i])
            }
        }

        if (uncachedContents.length > 0) {
            const rawEmbeddings = await this.generateInternalEmbeddingsBatch(uncachedContents, endpoint)
            for (let j = 0; j < uncachedIndices.length; j++) {
                const embedding = this.validateEmbeddingV2(rawEmbeddings[j])
                results[uncachedIndices[j]] = embedding
                if (useCache) {
                    await cacheEmbedding(uncachedContents[j], embedding, undefined, 'v2')
                }
            }
        }

        return results as number[][]
    }
}

export type { EmbeddingVersion }
export { EmbeddingService }

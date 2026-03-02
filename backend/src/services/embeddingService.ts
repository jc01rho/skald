import { EMBEDDING_VECTOR_DIMENSION } from '../settings'
import { logger } from '../lib/logger'
import { getCachedEmbedding, cacheEmbedding } from '../lib/ragCache'

const EMBEDDING_URL =
    process.env.EMBEDDING_SERVICE_URL || process.env.INTERNAL_EMBEDDING_URL || 'http://embedding-service:8889'
const INTERNAL_EMBEDDING_URL = EMBEDDING_URL.endsWith('/v1/embeddings')
    ? EMBEDDING_URL
    : `${EMBEDDING_URL}/v1/embeddings`

const TARGET_DIMENSION = EMBEDDING_VECTOR_DIMENSION

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
     * Generate embedding using internal endpoint
     * OpenAI-compatible API format
     */
    private static async generateInternalEmbedding(content: string): Promise<number[]> {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 30000)

        try {
            const response = await fetch(INTERNAL_EMBEDDING_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    input: content,
                    model: 'text-embedding-model',
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
                logger.error({ url: INTERNAL_EMBEDDING_URL }, 'Embedding request timed out after 30s')
                throw new Error('Embedding service request timed out')
            }
            logger.error({ err: error, url: INTERNAL_EMBEDDING_URL }, 'Embedding service request failed')
            throw error
        }
    }

    /**
     * Generate embeddings for multiple inputs in a single HTTP call.
     * OpenAI-compatible API accepts `input` as a string array.
     * Falls back to sequential single calls if batch request fails.
     */
    private static async generateInternalEmbeddingsBatch(contents: string[]): Promise<number[][]> {
        if (contents.length === 0) return []
        if (contents.length === 1) {
            const single = await this.generateInternalEmbedding(contents[0])
            return [single]
        }

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 60000) // longer timeout for batch

        try {
            const response = await fetch(INTERNAL_EMBEDDING_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    input: contents,
                    model: 'text-embedding-model',
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
                logger.error({ url: INTERNAL_EMBEDDING_URL, batchSize: contents.length }, 'Batch embedding request timed out after 60s')
                throw new Error('Batch embedding service request timed out')
            }
            // Fall back to sequential single calls
            logger.warn(
                { err: error, batchSize: contents.length },
                'Batch embedding failed, falling back to sequential calls'
            )
            const results: number[][] = []
            for (const content of contents) {
                results.push(await this.generateInternalEmbedding(content))
            }
            return results
        }
    }

    /**
     * Generate embedding - uses INTERNAL_EMBEDDING_URL environment variable
     */
    static async generateEmbedding(content: string, usage: 'storage' | 'search'): Promise<number[]> {
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
}

export { EmbeddingService }

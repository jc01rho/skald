import { EMBEDDING_VECTOR_DIMENSION } from '../settings'
import { logger } from '../lib/logger'

const INTERNAL_EMBEDDING_URL = process.env.INTERNAL_EMBEDDING_URL || 'http://embedding-service:8889/v1/embeddings'

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
     * Generate embedding - uses INTERNAL_EMBEDDING_URL environment variable
     */
    static async generateEmbedding(content: string, usage: 'storage' | 'search'): Promise<number[]> {
        const embedding = await this.generateInternalEmbedding(content)
        return this.normalizeEmbedding(embedding)
    }
}

export { EmbeddingService }

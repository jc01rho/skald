import { logger } from './logger'
import crypto from 'crypto'

// Simple in-memory cache implementation
// In production, use Redis or similar
const embeddingCache = new Map<string, { data: number[]; expiry: number }>()
const searchCache = new Map<string, { data: any[]; expiry: number }>()
const responseCache = new Map<string, { data: string; expiry: number }>()

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes
const EMBEDDING_TTL_MS = 60 * 60 * 1000 // 1 hour (embeddings don't change)

function hashKey(key: string): string {
    return crypto.createHash('md5').update(key).digest('hex')
}

function isExpired(expiry: number): boolean {
    return Date.now() > expiry
}

function cleanExpired(cache: Map<string, { data: any; expiry: number }>): void {
    for (const [key, value] of cache.entries()) {
        if (isExpired(value.expiry)) {
            cache.delete(key)
        }
    }
}

/**
 * Cache embedding vector for text
 */
export async function cacheEmbedding(
    text: string,
    embedding: number[],
    ttlMs: number = EMBEDDING_TTL_MS
): Promise<void> {
    const key = hashKey(`emb:${text}`)
    embeddingCache.set(key, {
        data: embedding,
        expiry: Date.now() + ttlMs,
    })
    logger.debug({ text: text.slice(0, 50) }, 'Cached embedding')
}

/**
 * Get cached embedding for text
 */
export async function getCachedEmbedding(text: string): Promise<number[] | null> {
    const key = hashKey(`emb:${text}`)
    const cached = embeddingCache.get(key)

    if (!cached) return null

    if (isExpired(cached.expiry)) {
        embeddingCache.delete(key)
        return null
    }

    logger.debug({ text: text.slice(0, 50) }, 'Embedding cache hit')
    return cached.data
}

/**
 * Cache search results
 */
export async function cacheSearchResults(
    query: string,
    filters: Record<string, any>,
    results: any[],
    ttlMs: number = DEFAULT_TTL_MS
): Promise<void> {
    const cacheKey = hashKey(`search:${query}:${JSON.stringify(filters)}`)
    searchCache.set(cacheKey, {
        data: results,
        expiry: Date.now() + ttlMs,
    })
    logger.debug({ query: query.slice(0, 50) }, 'Cached search results')
}

/**
 * Get cached search results
 */
export async function getCachedSearchResults(query: string, filters: Record<string, any>): Promise<any[] | null> {
    const cacheKey = hashKey(`search:${query}:${JSON.stringify(filters)}`)
    const cached = searchCache.get(cacheKey)

    if (!cached) return null

    if (isExpired(cached.expiry)) {
        searchCache.delete(cacheKey)
        return null
    }

    logger.debug({ query: query.slice(0, 50) }, 'Search cache hit')
    return cached.data
}

/**
 * Cache response for frequent queries
 */
export async function cacheResponse(
    queryHash: string,
    response: string,
    ttlMs: number = DEFAULT_TTL_MS
): Promise<void> {
    const key = hashKey(`resp:${queryHash}`)
    responseCache.set(key, {
        data: response,
        expiry: Date.now() + ttlMs,
    })
    logger.debug({ queryHash }, 'Cached response')
}

/**
 * Get cached response
 */
export async function getCachedResponse(queryHash: string): Promise<string | null> {
    const key = hashKey(`resp:${queryHash}`)
    const cached = responseCache.get(key)

    if (!cached) return null

    if (isExpired(cached.expiry)) {
        responseCache.delete(key)
        return null
    }

    logger.debug({ queryHash }, 'Response cache hit')
    return cached.data
}

/**
 * Clear all caches
 */
export function clearAllCaches(): void {
    embeddingCache.clear()
    searchCache.clear()
    responseCache.clear()
    logger.info('All caches cleared')
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
    embeddings: number
    searches: number
    responses: number
} {
    cleanExpired(embeddingCache)
    cleanExpired(searchCache)
    cleanExpired(responseCache)

    return {
        embeddings: embeddingCache.size,
        searches: searchCache.size,
        responses: responseCache.size,
    }
}

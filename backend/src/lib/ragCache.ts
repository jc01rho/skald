import { logger } from './logger'
import { redisGet, redisSet, redisDel } from './redisClient'
import { REDIS_URL } from '@/settings'
import crypto from 'crypto'

// In-memory fallback caches (used when Redis is unavailable)
const embeddingCache = new Map<string, { data: number[]; expiry: number }>()
const searchCache = new Map<string, { data: any[]; expiry: number }>()
const responseCache = new Map<string, { data: string; expiry: number }>()

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes
const EMBEDDING_TTL_MS = 60 * 60 * 1000 // 1 hour (embeddings don't change)

const CACHE_PREFIX = 'skald:rag:'

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
 * Check if Redis is available for distributed caching.
 * Falls back to in-memory Map when Redis is not configured.
 */
function useRedis(): boolean {
    return !!REDIS_URL
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

    if (useRedis()) {
        const redisKey = `${CACHE_PREFIX}emb:${key}`
        const ttlSec = Math.ceil(ttlMs / 1000)
        await redisSet(redisKey, JSON.stringify(embedding), ttlSec)
        logger.debug({ text: text.slice(0, 50), backend: 'redis' }, 'Cached embedding')
        return
    }

    embeddingCache.set(key, {
        data: embedding,
        expiry: Date.now() + ttlMs,
    })
    logger.debug({ text: text.slice(0, 50), backend: 'memory' }, 'Cached embedding')
}

/**
 * Get cached embedding for text
 */
export async function getCachedEmbedding(text: string): Promise<number[] | null> {
    const key = hashKey(`emb:${text}`)

    if (useRedis()) {
        const redisKey = `${CACHE_PREFIX}emb:${key}`
        const cached = await redisGet(redisKey)
        if (cached) {
            logger.debug({ text: text.slice(0, 50), backend: 'redis' }, 'Embedding cache hit')
            return JSON.parse(cached) as number[]
        }
        return null
    }

    const cached = embeddingCache.get(key)

    if (!cached) return null

    if (isExpired(cached.expiry)) {
        embeddingCache.delete(key)
        return null
    }

    logger.debug({ text: text.slice(0, 50), backend: 'memory' }, 'Embedding cache hit')
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

    if (useRedis()) {
        const redisKey = `${CACHE_PREFIX}search:${cacheKey}`
        const ttlSec = Math.ceil(ttlMs / 1000)
        await redisSet(redisKey, JSON.stringify(results), ttlSec)
        logger.debug({ query: query.slice(0, 50), backend: 'redis' }, 'Cached search results')
        return
    }

    searchCache.set(cacheKey, {
        data: results,
        expiry: Date.now() + ttlMs,
    })
    logger.debug({ query: query.slice(0, 50), backend: 'memory' }, 'Cached search results')
}

/**
 * Get cached search results
 */
export async function getCachedSearchResults(query: string, filters: Record<string, any>): Promise<any[] | null> {
    const cacheKey = hashKey(`search:${query}:${JSON.stringify(filters)}`)

    if (useRedis()) {
        const redisKey = `${CACHE_PREFIX}search:${cacheKey}`
        const cached = await redisGet(redisKey)
        if (cached) {
            logger.debug({ query: query.slice(0, 50), backend: 'redis' }, 'Search cache hit')
            return JSON.parse(cached) as any[]
        }
        return null
    }

    const cached = searchCache.get(cacheKey)

    if (!cached) return null

    if (isExpired(cached.expiry)) {
        searchCache.delete(cacheKey)
        return null
    }

    logger.debug({ query: query.slice(0, 50), backend: 'memory' }, 'Search cache hit')
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

    if (useRedis()) {
        const redisKey = `${CACHE_PREFIX}resp:${key}`
        const ttlSec = Math.ceil(ttlMs / 1000)
        await redisSet(redisKey, response, ttlSec)
        logger.debug({ queryHash, backend: 'redis' }, 'Cached response')
        return
    }

    responseCache.set(key, {
        data: response,
        expiry: Date.now() + ttlMs,
    })
    logger.debug({ queryHash, backend: 'memory' }, 'Cached response')
}

/**
 * Get cached response
 */
export async function getCachedResponse(queryHash: string): Promise<string | null> {
    const key = hashKey(`resp:${queryHash}`)

    if (useRedis()) {
        const redisKey = `${CACHE_PREFIX}resp:${key}`
        const cached = await redisGet(redisKey)
        if (cached) {
            logger.debug({ queryHash, backend: 'redis' }, 'Response cache hit')
            return cached
        }
        return null
    }

    const cached = responseCache.get(key)

    if (!cached) return null

    if (isExpired(cached.expiry)) {
        responseCache.delete(key)
        return null
    }

    logger.debug({ queryHash, backend: 'memory' }, 'Response cache hit')
    return cached.data
}

/**
 * Clear all caches
 */
export async function clearAllCaches(): Promise<void> {
    // Always clear in-memory caches
    embeddingCache.clear()
    searchCache.clear()
    responseCache.clear()

    // Clear Redis caches if available (delete by prefix pattern)
    if (useRedis()) {
        try {
            // Redis doesn't support deleting by prefix natively with the basic client,
            // so we just clear the in-memory caches. Redis entries will expire via TTL.
            logger.info({ backend: 'redis+memory' }, 'In-memory caches cleared; Redis entries will expire via TTL')
        } catch (error) {
            logger.warn({ err: error }, 'Failed to clear Redis caches')
        }
    } else {
        logger.info({ backend: 'memory' }, 'All caches cleared')
    }
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
    embeddings: number
    searches: number
    responses: number
    backend: 'redis' | 'memory'
} {
    cleanExpired(embeddingCache)
    cleanExpired(searchCache)
    cleanExpired(responseCache)

    return {
        embeddings: embeddingCache.size,
        searches: searchCache.size,
        responses: responseCache.size,
        backend: useRedis() ? 'redis' : 'memory',
    }
}

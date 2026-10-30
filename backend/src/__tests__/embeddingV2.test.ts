import crypto from 'crypto'

const mockExecute = jest.fn()

jest.mock('@/settings', () => ({
    ...jest.requireActual('@/settings'),
    EMBEDDING_V2_URL: 'http://embedding-v2.test',
    EMBEDDING_READ_VERSION: 'v1',
}))

jest.mock('@/di', () => ({
    DI: { em: { getConnection: () => ({ execute: mockExecute }) } },
}))

jest.mock('@/agents/memoSummaryAgent', () => ({ memoSummaryAgent: { summarize: jest.fn() } }))
jest.mock('@/agents/memoTagsAgent', () => ({ memoTagsAgent: { extractTags: jest.fn() } }))
jest.mock('@/lib/chunkProcessor', () => ({ processChunksWithContext: jest.fn() }))

import { EmbeddingService } from '@/services/embeddingService'
import { cacheEmbedding, getCachedEmbedding, getEmbeddingCacheKeys } from '@/lib/ragCache'
import { memoChunkVectorSearch } from '@/embeddings/vectorSearch'
import { HybridSearchService } from '@/embeddings/hybridSearch'
import { createMemoChunks, generateEmbeddingV2OrNull } from '@/memoProcessingServer/memoOperations'
import { logger } from '@/lib/logger'

const mutableSettings = jest.requireMock('@/settings') as {
    EMBEDDING_V2_URL: string
    EMBEDDING_READ_VERSION: 'v1' | 'v2'
}

const vector = (dim: number, seed = 0.01) => Array.from({ length: dim }, (_, i) => seed + i / 100000)

const embeddingsResponse = (embeddings: number[][], order?: number[]) =>
    ({
        ok: true,
        json: async () => ({
            data: (order ?? embeddings.map((_, i) => i)).map((index) => ({ embedding: embeddings[index], index })),
            model: 'test',
            usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        text: async () => '',
    }) as unknown as Response

describe('Embedding v2 migration', () => {
    let fetchMock: jest.Mock
    const originalFetch = global.fetch
    let uniq = 0
    const unique = (label: string) => `${label}-${Date.now()}-${uniq++}`

    beforeEach(() => {
        fetchMock = jest.fn()
        global.fetch = fetchMock as unknown as typeof fetch
        mockExecute.mockReset()
        mutableSettings.EMBEDDING_V2_URL = 'http://embedding-v2.test'
        mutableSettings.EMBEDDING_READ_VERSION = 'v1'
    })

    afterEach(() => {
        global.fetch = originalFetch
        jest.restoreAllMocks()
    })

    describe('v2 dimension validation', () => {
        it('accepts exactly 512 dimensions and rejects anything else without padding', () => {
            expect(EmbeddingService.validateEmbeddingV2(vector(512))).toHaveLength(512)
            expect(() => EmbeddingService.validateEmbeddingV2(vector(511))).toThrow(/expected 512, got 511/)
            expect(() => EmbeddingService.validateEmbeddingV2(vector(2048))).toThrow(/expected 512, got 2048/)
        })

        it('calls the v2 endpoint and rejects a non-512 response', async () => {
            fetchMock.mockResolvedValueOnce(embeddingsResponse([vector(512)]))
            const ok = await EmbeddingService.generateEmbeddingV2(unique('ok'))
            expect(ok).toHaveLength(512)
            expect(fetchMock.mock.calls[0][0]).toBe('http://embedding-v2.test/v1/embeddings')

            fetchMock.mockResolvedValueOnce(embeddingsResponse([vector(1792)]))
            await expect(EmbeddingService.generateEmbeddingV2(unique('bad'))).rejects.toThrow(/dimension mismatch/)
        })

        it('keeps batch order by index and validates every vector', async () => {
            const a = vector(512, 0.1)
            const b = vector(512, 0.2)
            fetchMock.mockResolvedValueOnce(embeddingsResponse([a, b], [1, 0]))
            const result = await EmbeddingService.generateEmbeddingsBatchV2([unique('a'), unique('b')], {
                useCache: false,
            })
            expect(result).toEqual([a, b])
            expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toHaveLength(2)
        })

        it('throws when v2 is not configured', async () => {
            mutableSettings.EMBEDDING_V2_URL = ''
            await expect(EmbeddingService.generateEmbeddingV2(unique('off'))).rejects.toThrow(/EMBEDDING_V2_URL/)
            expect(fetchMock).not.toHaveBeenCalled()
        })
    })

    describe('version-keyed embedding cache', () => {
        it('keeps the legacy v1 key format and gives v2 a distinct key', () => {
            const md5 = crypto.createHash('md5').update('emb:hello').digest('hex')
            expect(getEmbeddingCacheKeys('hello').redisKey).toBe(`skald:rag:emb:${md5}`)
            expect(getEmbeddingCacheKeys('hello', 'v1')).toEqual({ memoryKey: md5, redisKey: `skald:rag:emb:${md5}` })

            const v2 = getEmbeddingCacheKeys('hello', 'v2')
            expect(v2.redisKey).toMatch(/^skald:rag:emb:v2:/)
            expect(v2.redisKey).not.toBe(`skald:rag:emb:${md5}`)
            expect(v2.memoryKey).not.toBe(md5)
        })

        it('never returns a v1 vector for a v2 lookup (and vice versa)', async () => {
            const text = unique('cache')
            await cacheEmbedding(text, [1, 2, 3])
            expect(await getCachedEmbedding(text, 'v2')).toBeNull()
            expect(await getCachedEmbedding(text)).toEqual([1, 2, 3])

            await cacheEmbedding(text, [9, 9], undefined, 'v2')
            expect(await getCachedEmbedding(text, 'v2')).toEqual([9, 9])
            expect(await getCachedEmbedding(text, 'v1')).toEqual([1, 2, 3])
        })
    })

    describe('write path', () => {
        it('returns null and warns when v2 fails, instead of throwing', async () => {
            jest.spyOn(EmbeddingService, 'generateEmbeddingV2').mockRejectedValue(new Error('v2 down'))
            const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never)

            await expect(generateEmbeddingV2OrNull('text', { memoUuid: 'm1' })).resolves.toBeNull()
            expect(warn).toHaveBeenCalled()
        })

        it('skips v2 entirely when EMBEDDING_V2_URL is empty', async () => {
            mutableSettings.EMBEDDING_V2_URL = ''
            const v2 = jest.spyOn(EmbeddingService, 'generateEmbeddingV2')
            await expect(generateEmbeddingV2OrNull('text', {})).resolves.toBeNull()
            expect(v2).not.toHaveBeenCalled()
        })

        it('persists chunks with v1 embedding and NULL embedding_v2 when v2 fails', async () => {
            const v1 = vector(2048)
            jest.spyOn(EmbeddingService, 'generateEmbedding').mockResolvedValue(v1)
            jest.spyOn(EmbeddingService, 'generateEmbeddingV2').mockRejectedValue(new Error('v2 down'))
            jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never)

            const persisted: any[] = []
            const em = {
                create: jest.fn((_entity: unknown, data: Record<string, unknown>) => data),
                persistAndFlush: jest.fn(async (entities: any[]) => {
                    persisted.push(...entities)
                }),
            }

            await expect(createMemoChunks(em as any, 'memo-1', 'project-1', 'short content', 'Title')).resolves.toBeUndefined()

            const child = persisted.find((e) => 'embedding' in e)
            expect(child.embedding).toBe(JSON.stringify(v1))
            expect(child.embedding_v2).toBeNull()
        })

        it('stores the v2 vector alongside v1 when v2 succeeds', async () => {
            const v2 = vector(512)
            jest.spyOn(EmbeddingService, 'generateEmbedding').mockResolvedValue(vector(2048))
            jest.spyOn(EmbeddingService, 'generateEmbeddingV2').mockResolvedValue(v2)

            const persisted: any[] = []
            const em = {
                create: jest.fn((_entity: unknown, data: Record<string, unknown>) => data),
                persistAndFlush: jest.fn(async (entities: any[]) => {
                    persisted.push(...entities)
                }),
            }
            await createMemoChunks(em as any, 'memo-2', 'project-1', 'short content', null)
            expect(persisted.find((e) => 'embedding' in e).embedding_v2).toBe(JSON.stringify(v2))
        })
    })

    describe('read path', () => {
        const project = { uuid: 'project-1' } as any

        it('searches the v1 halfvec(2048) column by default', async () => {
            mockExecute.mockResolvedValue([])
            await memoChunkVectorSearch(project, vector(2048, Math.random()), 5, 0.9, undefined, false)

            const sql = mockExecute.mock.calls[0][0] as string
            expect(sql).toContain('skald_memochunk.embedding::halfvec(2048) <=> ?::halfvec(2048)')
            expect(sql).not.toContain('embedding_v2')
        })

        it('searches embedding_v2 vector(512) and excludes NULL rows when EMBEDDING_READ_VERSION=v2', async () => {
            mutableSettings.EMBEDDING_READ_VERSION = 'v2'
            mockExecute.mockResolvedValue([])
            await memoChunkVectorSearch(project, vector(512, Math.random()), 5, 0.9, undefined, false)

            const sql = mockExecute.mock.calls[0][0] as string
            expect(sql).toContain('skald_memochunk.embedding_v2 <=> ?::vector(512)')
            expect(sql).toContain('skald_memochunk.embedding_v2 IS NOT NULL')
            expect(sql).not.toContain('halfvec')
        })

        it('routes hybrid search vector SQL by the same flag', async () => {
            mockExecute.mockResolvedValue([])
            mutableSettings.EMBEDDING_READ_VERSION = 'v2'
            await HybridSearchService.hybridSearch(project, vector(512), unique('hybrid query'))
            const v2Sql = mockExecute.mock.calls.map((c) => c[0] as string).find((s) => s.includes('vector_score'))
            expect(v2Sql).toContain('skald_memochunk.embedding_v2 <=> ?::vector(512)')

            mockExecute.mockClear()
            mutableSettings.EMBEDDING_READ_VERSION = 'v1'
            await HybridSearchService.hybridSearch(project, vector(2048), unique('hybrid query'))
            const v1Sql = mockExecute.mock.calls.map((c) => c[0] as string).find((s) => s.includes('vector_score'))
            expect(v1Sql).toContain('skald_memochunk.embedding::halfvec(2048)')
            expect(v1Sql).not.toContain('embedding_v2')
        })

        it('embeds search queries with v2 only when reading v2; storage stays v1', async () => {
            mutableSettings.EMBEDDING_READ_VERSION = 'v2'
            fetchMock.mockResolvedValue(embeddingsResponse([vector(512)]))
            const searchVec = await EmbeddingService.generateEmbedding(unique('query'), 'search')
            expect(searchVec).toHaveLength(512)
            expect(fetchMock.mock.calls[0][0]).toBe('http://embedding-v2.test/v1/embeddings')

            fetchMock.mockReset()
            fetchMock.mockResolvedValue(embeddingsResponse([vector(1792)]))
            const storageVec = await EmbeddingService.generateEmbedding(unique('doc'), 'storage')
            expect(storageVec).toHaveLength(2048)
            expect(fetchMock.mock.calls[0][0]).not.toContain('embedding-v2.test')
        })
    })
})

import crypto from 'crypto'

const mockExecute = jest.fn()

jest.mock('@/settings', () => ({
    ...jest.requireActual('@/settings'),
    EMBEDDING_V2_URL: 'http://embedding-v2.test',
}))

jest.mock('@/di', () => ({
    DI: { em: { getConnection: () => ({ execute: mockExecute }) } },
}))

jest.mock('@/agents/memoSummaryAgent', () => ({ memoSummaryAgent: { summarize: jest.fn() } }))
jest.mock('@/agents/memoTagsAgent', () => ({ memoTagsAgent: { extractTags: jest.fn() } }))
jest.mock('@/lib/chunkProcessor', () => ({ processChunksWithContext: jest.fn() }))

import { EmbeddingService } from '@/services/embeddingService'
import { cacheEmbedding, getEmbeddingCacheKeys } from '@/lib/ragCache'
import { memoChunkVectorSearch } from '@/embeddings/vectorSearch'
import { HybridSearchService } from '@/embeddings/hybridSearch'
import { createMemoChunks, generateMemoSummary } from '@/memoProcessingServer/memoOperations'
import { memoSummaryAgent } from '@/agents/memoSummaryAgent'
import { HNSWOptimizationService } from '@/lib/hnswOptimization'
import { EMBEDDING_V2_MODEL } from '@/settings'

const mutableSettings = jest.requireMock('@/settings') as {
    EMBEDDING_V2_URL: string
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

const fakeEm = (persisted: any[]) => ({
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => data),
    persistAndFlush: jest.fn(async (entities: any) => {
        persisted.push(...(Array.isArray(entities) ? entities : [entities]))
    }),
})

describe('Embedding (v2 only)', () => {
    let fetchMock: jest.Mock
    const originalFetch = global.fetch
    let uniq = 0
    const unique = (label: string) => `${label}-${Date.now()}-${uniq++}`

    beforeEach(() => {
        fetchMock = jest.fn()
        global.fetch = fetchMock as unknown as typeof fetch
        mockExecute.mockReset()
        mutableSettings.EMBEDDING_V2_URL = 'http://embedding-v2.test'
    })

    afterEach(() => {
        global.fetch = originalFetch
        jest.restoreAllMocks()
    })

    describe('generation', () => {
        it('accepts exactly 512 dimensions and rejects anything else without padding', () => {
            expect(EmbeddingService.validateEmbedding(vector(512))).toHaveLength(512)
            expect(() => EmbeddingService.validateEmbedding(vector(511))).toThrow(/expected 512, got 511/)
            expect(() => EmbeddingService.validateEmbedding(vector(2048))).toThrow(/expected 512, got 2048/)
        })

        it('embeds storage and search text with the v2 endpoint and rejects a non-512 response', async () => {
            fetchMock.mockResolvedValue(embeddingsResponse([vector(512)]))
            await expect(EmbeddingService.generateEmbedding(unique('doc'), 'storage')).resolves.toHaveLength(512)
            await expect(EmbeddingService.generateEmbedding(unique('query'), 'search')).resolves.toHaveLength(512)
            expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
                'http://embedding-v2.test/v1/embeddings',
                'http://embedding-v2.test/v1/embeddings',
            ])

            fetchMock.mockResolvedValueOnce(embeddingsResponse([vector(1792)]))
            await expect(EmbeddingService.generateEmbedding(unique('bad'), 'storage')).rejects.toThrow(
                /dimension mismatch/
            )
        })

        it('keeps batch order by index and validates every vector', async () => {
            const a = vector(512, 0.1)
            const b = vector(512, 0.2)
            fetchMock.mockResolvedValueOnce(embeddingsResponse([a, b], [1, 0]))
            const result = await EmbeddingService.generateEmbeddingsBatch([unique('a'), unique('b')], 'search', {
                useCache: false,
            })
            expect(result).toEqual([a, b])
            expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toHaveLength(2)
        })

        it('treats a wrong-dimension cached vector as a cache miss', async () => {
            const text = unique('stale')
            await cacheEmbedding(text, [1, 2, 3])
            fetchMock.mockResolvedValueOnce(embeddingsResponse([vector(512)]))
            await expect(EmbeddingService.generateEmbedding(text, 'search')).resolves.toHaveLength(512)
            expect(fetchMock).toHaveBeenCalledTimes(1)
        })

        it('throws without calling any endpoint when EMBEDDING_V2_URL is not configured', async () => {
            mutableSettings.EMBEDDING_V2_URL = ''
            await expect(EmbeddingService.generateEmbedding(unique('off'), 'storage')).rejects.toThrow(/EMBEDDING_V2_URL/)
            await expect(EmbeddingService.generateEmbeddingsBatch([unique('off')], 'search')).rejects.toThrow(
                /EMBEDDING_V2_URL/
            )
            expect(fetchMock).not.toHaveBeenCalled()
        })
    })

    describe('embedding cache', () => {
        it('uses the v2 key namespace scoped by model and never the legacy v1 key', () => {
            const legacy = crypto.createHash('md5').update('emb:hello').digest('hex')
            const v2 = crypto.createHash('md5').update(`emb:v2:${EMBEDDING_V2_MODEL}:hello`).digest('hex')
            expect(getEmbeddingCacheKeys('hello')).toEqual({
                memoryKey: `v2:${v2}`,
                redisKey: `skald:rag:emb:v2:${v2}`,
            })
            expect(getEmbeddingCacheKeys('hello').redisKey).not.toBe(`skald:rag:emb:${legacy}`)
        })
    })

    describe('write path', () => {
        it('persists chunks with embedding_v2 only (no legacy embedding column)', async () => {
            const v2 = vector(512)
            jest.spyOn(EmbeddingService, 'generateEmbedding').mockResolvedValue(v2)
            const persisted: any[] = []

            await createMemoChunks(fakeEm(persisted) as any, 'memo-1', 'project-1', 'short content', 'Title')

            const child = persisted.find((e) => 'embedding_v2' in e)
            expect(child.embedding_v2).toBe(JSON.stringify(v2))
            expect(child).not.toHaveProperty('embedding')
        })

        it('persists summaries with embedding_v2 only', async () => {
            const v2 = vector(512)
            jest.spyOn(EmbeddingService, 'generateEmbedding').mockResolvedValue(v2)
            ;(memoSummaryAgent.summarize as jest.Mock).mockResolvedValue({ summary: 'a summary' })
            const persisted: any[] = []

            await generateMemoSummary(fakeEm(persisted) as any, 'memo-1', 'content', 'project-1')

            expect(persisted).toHaveLength(1)
            expect(persisted[0].embedding_v2).toBe(JSON.stringify(v2))
            expect(persisted[0]).not.toHaveProperty('embedding')
        })

        it('fails memo chunking when embedding fails (no chunk without a vector is persisted)', async () => {
            jest.spyOn(EmbeddingService, 'generateEmbedding').mockRejectedValue(new Error('embedding down'))
            const persisted: any[] = []

            await expect(
                createMemoChunks(fakeEm(persisted) as any, 'memo-2', 'project-1', 'short content', null)
            ).rejects.toThrow('embedding down')
            expect(persisted).toHaveLength(0)
        })
    })

    describe('read path', () => {
        const project = { uuid: 'project-1' } as any

        it('searches embedding_v2 vector(512), excludes NULL rows and never reads the legacy column', async () => {
            mockExecute.mockResolvedValue([])
            await memoChunkVectorSearch(project, vector(512, Math.random()), 5, 0.9, undefined, false)

            const sql = mockExecute.mock.calls[0][0] as string
            expect(sql).toContain('skald_memochunk.embedding_v2 <=> ?::vector(512)')
            expect(sql).toContain('skald_memochunk.embedding_v2 IS NOT NULL')
            expect(sql).not.toContain('halfvec')
            expect(sql).not.toContain('skald_memochunk.*')
            expect(sql).not.toMatch(/skald_memochunk\.embedding(?!_v2)/)
        })

        it('uses the same embedding_v2 SQL in hybrid search', async () => {
            mockExecute.mockResolvedValue([])
            await HybridSearchService.hybridSearch(project, vector(512), unique('hybrid query'))
            const sql = mockExecute.mock.calls.map((c) => c[0] as string).find((s) => s.includes('vector_score'))
            expect(sql).toContain('skald_memochunk.embedding_v2 <=> ?::vector(512)')
            expect(sql).not.toContain('halfvec')
        })
    })

    describe('HNSW index', () => {
        const emWith = (execute: jest.Mock) => ({ getConnection: () => ({ execute }) }) as any

        it('builds the index CONCURRENTLY when missing', async () => {
            const execute = jest.fn().mockResolvedValueOnce([]).mockResolvedValue([])
            await HNSWOptimizationService.ensureEmbeddingV2Index(emWith(execute))
            const sqls = execute.mock.calls.map((c) => c[0] as string)
            expect(sqls[1]).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memochunk_embedding_v2_hnsw/)
            expect(sqls[1]).toContain('embedding_v2 vector_cosine_ops')
        })

        it('is a no-op when a valid index exists and rebuilds an INVALID one', async () => {
            const valid = jest.fn().mockResolvedValueOnce([{ valid: true }])
            await HNSWOptimizationService.ensureEmbeddingV2Index(emWith(valid))
            expect(valid).toHaveBeenCalledTimes(1)

            const invalid = jest.fn().mockResolvedValueOnce([{ valid: false }]).mockResolvedValue([])
            await HNSWOptimizationService.ensureEmbeddingV2Index(emWith(invalid))
            const sqls = invalid.mock.calls.map((c) => c[0] as string)
            expect(sqls[1]).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS idx_memochunk_embedding_v2_hnsw/)
            expect(sqls[2]).toMatch(/CREATE INDEX CONCURRENTLY/)
        })

        it('createOptimizedIndex only targets the embedding_v2 index', async () => {
            const execute = jest.fn().mockResolvedValue([])
            await HNSWOptimizationService.createOptimizedIndex(emWith(execute))
            const sqls = execute.mock.calls.map((c) => c[0] as string).join('\n')
            expect(sqls).toContain('idx_memochunk_embedding_v2_hnsw')
            expect(sqls).not.toContain('halfvec')
        })
    })
})

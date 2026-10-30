jest.mock('@/settings', () => ({
    ...jest.requireActual('@/settings'),
    POST_RERANK_TOP_K: 2,
}))

import { RerankService } from '../services/rerankService'
import { logger } from '../lib/logger'

describe('RerankService', () => {
    const originalFetch = global.fetch

    afterEach(() => {
        global.fetch = originalFetch
        jest.restoreAllMocks()
    })

    it('includes original query signal when reranking rewritten queries', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                results: [{ index: 0, relevance_score: 0.91 }],
            }),
        })

        global.fetch = fetchMock as unknown as typeof fetch

        await RerankService.rerank('이행 진단 기능 정의 개요 목적 동작 방식', ['doc-1'], undefined, {
            originalQuery: '이행 진단이라는 기능이 뭐야?',
        })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [, init] = fetchMock.mock.calls[0]
        const body = JSON.parse(String(init?.body))

        expect(body.query).toContain('이행 진단이라는 기능이 뭐야?')
        expect(body.query).toContain('Rewritten retrieval query: 이행 진단 기능 정의 개요 목적 동작 방식')
    })

    describe('fallback when the rerank endpoint fails', () => {
        const docs = ['doc-a', 'doc-b', 'doc-c', 'doc-d']
        const metadata = docs.map((_, i) => ({
            memo_uuid: `memo-${i}`,
            memo_title: `Title ${i}`,
            source_url: `https://example.test/${i}`,
        }))
        const expected = [
            {
                index: 0,
                document: 'doc-a',
                relevance_score: 1,
                memo_uuid: 'memo-0',
                memo_title: 'Title 0',
                source_url: 'https://example.test/0',
            },
            {
                index: 1,
                document: 'doc-b',
                relevance_score: 0.75,
                memo_uuid: 'memo-1',
                memo_title: 'Title 1',
                source_url: 'https://example.test/1',
            },
        ]

        const failures: Array<[string, () => Promise<unknown>]> = [
            ['non-2xx response', async () => ({ ok: false, status: 503, text: async () => 'unavailable' })],
            ['network error', async () => Promise.reject(new TypeError('fetch failed'))],
            [
                'timeout',
                async () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
            ],
            ['malformed body', async () => ({ ok: true, json: async () => ({}) })],
        ]

        it.each(failures)('%s: warns and returns input order capped at POST_RERANK_TOP_K', async (_label, impl) => {
            global.fetch = jest.fn().mockImplementation(impl) as unknown as typeof fetch
            const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never)

            await expect(RerankService.rerank('query', docs, metadata)).resolves.toEqual(expected)
            expect(warn).toHaveBeenCalledWith(expect.objectContaining({ resultCount: 4 }), expect.stringMatching(/Rerank failed/))
        })

        it('works without metadata', async () => {
            global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch
            jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never)

            await expect(RerankService.rerank('query', ['x', 'y'])).resolves.toEqual([
                { index: 0, document: 'x', relevance_score: 1 },
                { index: 1, document: 'y', relevance_score: 0.5 },
            ])
        })
    })
})

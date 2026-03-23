import { RerankService } from '../services/rerankService'

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
})

import { HybridSearchService } from '../embeddings/hybridSearch'
import { DI } from '../di'

jest.mock('../lib/ragCache', () => ({
    getCachedSearchResults: jest.fn().mockResolvedValue(null),
    cacheSearchResults: jest.fn().mockResolvedValue(undefined),
}))

describe('HybridSearch manual submission metadata retrieval', () => {
    afterEach(() => {
        jest.restoreAllMocks()
    })

    it('includes metadata search_text matches in trigram search results', async () => {
        const execute = jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    uuid: 'chunk-1',
                    chunk_content: '수동 제출 메모 본문',
                    memo_uuid: 'memo-27000',
                    memo_title: '내부 참고 문서',
                    bm25_score: 0.92,
                },
            ])

        DI.em = {
            getConnection: () => ({ execute }),
        } as any

        const project = { uuid: 'project-1' } as any

        const results = await HybridSearchService.hybridSearch(
            project,
            Array(2048).fill(0),
            '엔터프라이즈 에러코드 27000',
            {
                topK: 5,
                similarityThreshold: 1.2,
            }
        )

        expect(results.map((result) => result.memo_uuid)).toContain('memo-27000')

        const trgmSql = execute.mock.calls[1]?.[0] as string
        expect(trgmSql).toContain("metadata->>'search_text'")
    })

    it('includes metadata search_text matches in full-text search results', async () => {
        const execute = jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    uuid: 'chunk-2',
                    chunk_content: 'legacy error details',
                    memo_uuid: 'memo-450002',
                    memo_title: 'legacy sast docs',
                    bm25_score: 0.88,
                },
            ])

        DI.em = {
            getConnection: () => ({ execute }),
        } as any

        const project = { uuid: 'project-2' } as any

        const results = await HybridSearchService.hybridSearch(
            project,
            Array(2048).fill(0),
            'legacy sast error code 450002',
            {
                topK: 5,
                similarityThreshold: 1.2,
            }
        )

        expect(results.map((result) => result.memo_uuid)).toContain('memo-450002')

        const fullTextSql = execute.mock.calls[1]?.[0] as string
        expect(fullTextSql).toContain("metadata->>'search_text'")
    })
})

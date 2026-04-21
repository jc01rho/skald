import { Project } from '../entities/Project'
import { memoChunkVectorSearch } from '../embeddings/vectorSearch'
import { DI } from '../di'
import { MemoFilter } from '../lib/filterUtils'
import { fastRetrieve } from '../lib/fastRetrieve'
import { HNSWOptimizationService } from '../lib/hnswOptimization'
import { getTitleAndSummaryAndContentForMemoList } from '../queries/memo'
import { EmbeddingService } from '../services/embeddingService'

jest.mock('../services/embeddingService')
jest.mock('../embeddings/vectorSearch')
jest.mock('../queries/memo')
jest.mock('../lib/hnswOptimization')

describe('fastRetrieve', () => {
    const project = { uuid: 'project-1' } as Project

    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('builds compact preview context from vector-only retrieval results', async () => {
        const filters: MemoFilter[] = [
            {
                field: 'source',
                operator: 'eq',
                value: 'jira',
                filter_type: 'native_field',
            },
        ]

        const longSummary = `  ${'요약 '.repeat(80)}  `
        const longSnippet = `  ${'첫 번째 청크 내용 '.repeat(40)}  `

        ;(EmbeddingService.generateEmbedding as jest.Mock).mockResolvedValue([0.1, 0.2, 0.3])
        ;(memoChunkVectorSearch as jest.Mock).mockResolvedValue([
            {
                chunk: {
                    uuid: 'chunk-1',
                    chunk_index: 7,
                    memo_uuid: 'memo-1',
                    project_uuid: 'project-1',
                    chunk_content: longSnippet,
                    embedding: [],
                },
                distance: 0.12,
                final_score: 0.88,
            },
            {
                chunk: {
                    uuid: 'chunk-2',
                    chunk_index: 2,
                    memo_uuid: 'memo-2',
                    project_uuid: 'project-1',
                    chunk_content: ' 두 번째 청크   내용 ',
                    embedding: [],
                },
                distance: 0.24,
                final_score: 0.76,
            },
        ])
        ;(getTitleAndSummaryAndContentForMemoList as jest.Mock).mockResolvedValue(
            new Map([
                [
                    'memo-1',
                    {
                        title: '첫 번째 문서',
                        summary: longSummary,
                        content: '전체 문서 내용',
                        source_url: 'https://example.com/1',
                    },
                ],
                [
                    'memo-2',
                    {
                        title: '두 번째 문서',
                        summary: '보조 요약',
                        content: '전체 문서 내용 2',
                        source_url: 'https://example.com/2',
                    },
                ],
            ])
        )

        const result = await fastRetrieve({
            project,
            query: '  Stage A preview query  ',
            filters,
            limit: 2,
        })

        expect(HNSWOptimizationService.applyRuntimeSearchTuning).toHaveBeenCalledWith(DI.em)
        expect(EmbeddingService.generateEmbedding).toHaveBeenCalledWith('Stage A preview query', 'search')
        expect(memoChunkVectorSearch).toHaveBeenCalledWith(project, [0.1, 0.2, 0.3], 2, 0.75, filters, false)
        expect(getTitleAndSummaryAndContentForMemoList).toHaveBeenCalledWith('project-1', ['memo-1', 'memo-2'])

        expect(result.results).toEqual([
            {
                rank: 1,
                chunk_uuid: 'chunk-1',
                chunk_index: 7,
                memo_uuid: 'memo-1',
                memo_title: '첫 번째 문서',
                memo_summary: expect.stringMatching(/\.\.\.$/),
                source_url: 'https://example.com/1',
                snippet: expect.stringMatching(/\.\.\.$/),
                distance: 0.12,
            },
            {
                rank: 2,
                chunk_uuid: 'chunk-2',
                chunk_index: 2,
                memo_uuid: 'memo-2',
                memo_title: '두 번째 문서',
                memo_summary: '보조 요약',
                source_url: 'https://example.com/2',
                snippet: '두 번째 청크 내용',
                distance: 0.24,
            },
        ])

        expect(result.contextStr).toContain('Result 1:')
        expect(result.contextStr).toContain('Title: 첫 번째 문서')
        expect(result.contextStr).toContain('Summary:')
        expect(result.contextStr).toContain('Snippet:')
        expect(result.contextStr).toContain('Source: https://example.com/1')
        expect(result.contextStr).toContain('Result 2:')
    })

    it('returns an empty response when no vector matches are found', async () => {
        ;(EmbeddingService.generateEmbedding as jest.Mock).mockResolvedValue([0.1, 0.2, 0.3])
        ;(memoChunkVectorSearch as jest.Mock).mockResolvedValue([])

        const result = await fastRetrieve({ project, query: 'preview miss' })

        expect(result).toEqual({ contextStr: '', results: [] })
        expect(getTitleAndSummaryAndContentForMemoList).not.toHaveBeenCalled()
    })

    it('deduplicates memo ids for memo lookup and falls back to chunk content when memo metadata is missing', async () => {
        ;(EmbeddingService.generateEmbedding as jest.Mock).mockResolvedValue([0.4, 0.5])
        ;(memoChunkVectorSearch as jest.Mock).mockResolvedValue([
            {
                chunk: {
                    uuid: 'chunk-1',
                    chunk_index: 0,
                    memo_uuid: 'memo-1',
                    project_uuid: 'project-1',
                    chunk_content: '  첫 번째 청크 미리보기  ',
                    embedding: [],
                },
                distance: 0.2,
                final_score: 0.8,
            },
            {
                chunk: {
                    uuid: 'chunk-2',
                    chunk_index: 1,
                    memo_uuid: 'memo-1',
                    project_uuid: 'project-1',
                    chunk_content: ' 두 번째 청크 미리보기 ',
                    embedding: [],
                },
                distance: 0.25,
                final_score: 0.75,
            },
        ])
        ;(getTitleAndSummaryAndContentForMemoList as jest.Mock).mockResolvedValue(new Map())

        const result = await fastRetrieve({ project, query: 'duplicate memo ids', limit: 2 })

        expect(getTitleAndSummaryAndContentForMemoList).toHaveBeenCalledWith('project-1', ['memo-1'])
        expect(result.results).toEqual([
            {
                rank: 1,
                chunk_uuid: 'chunk-1',
                chunk_index: 0,
                memo_uuid: 'memo-1',
                memo_title: '',
                memo_summary: '',
                source_url: undefined,
                snippet: '첫 번째 청크 미리보기',
                distance: 0.2,
            },
            {
                rank: 2,
                chunk_uuid: 'chunk-2',
                chunk_index: 1,
                memo_uuid: 'memo-1',
                memo_title: '',
                memo_summary: '',
                source_url: undefined,
                snippet: '두 번째 청크 미리보기',
                distance: 0.25,
            },
        ])
        expect(result.contextStr).toContain('Title: Untitled document')
    })
})

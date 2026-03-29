import { __testables__, buildIdentifierFallbackQueries } from '../agents/chatAgent/ragGraph'
import { MemoChunkWithDistance } from '../embeddings/vectorSearch'

describe('ragGraph generic anchor preservation', () => {
    it('builds generic fallback queries from literal anchors in identifier-like questions', () => {
        expect(buildIdentifierFallbackQueries('엔터프라이즈 에러코드 20210에 대해 알려줘')).toEqual([
            '20210',
            '"20210"',
        ])
        expect(buildIdentifierFallbackQueries('exception.20210 문서를 찾아줘')).toEqual([
            'exception.20210',
            '"exception.20210"',
            '20210',
            '"20210"',
        ])
    })

    it('preserves exact numeric anchors for generic identifier-like questions', () => {
        expect(buildIdentifierFallbackQueries('엔터프라이즈 버전 20210은 언제 배포돼?')).toEqual(['20210', '"20210"'])
        expect(buildIdentifierFallbackQueries('260301에 발생한 장애 유형을 알려줘')).toEqual([])
    })

    it('extracts generic literal anchors from structured identifiers and explicit keys', () => {
        expect(__testables__.extractQueryAnchors('PROJ-123 상태와 exception.20210 원인 알려줘')).toEqual([
            'exception.20210',
            'PROJ-123',
            '20210',
        ])
    })

    it('pins anchor-matching chunks ahead of semantically higher-ranked non-matching chunks', () => {
        const rerankedResults = [
            {
                index: 0,
                document: 'generic summary',
                relevance_score: 0.95,
                memo_uuid: 'memo-1',
                memo_title: '일반 문서',
            },
            {
                index: 1,
                document: 'error code 20210 details',
                relevance_score: 0.62,
                memo_uuid: 'memo-2',
                memo_title: '에러 코드 문서',
            },
        ]

        const chunkResults = [
            {
                chunk: {
                    uuid: 'chunk-1',
                    chunk_content: 'generic summary',
                    chunk_index: 0,
                    embedding: [],
                    memo_uuid: 'memo-1',
                    project_uuid: 'project-1',
                },
                distance: 0.1,
            },
            {
                chunk: {
                    uuid: 'chunk-2',
                    chunk_content: 'Detailed explanation for error code 20210',
                    chunk_index: 1,
                    embedding: [],
                    memo_uuid: 'memo-2',
                    project_uuid: 'project-1',
                },
                distance: 0.4,
            },
        ] as MemoChunkWithDistance[]

        const memoPropertiesMap = new Map([
            ['memo-1', { title: '일반 문서', summary: '일반 요약', content: '', source_url: '' }],
            ['memo-2', { title: '에러 코드 문서', summary: '20210 처리 절차', content: '', source_url: '' }],
        ])

        const preserved = __testables__.preserveAnchorMatches({
            query: '에러코드 20210에 대해 알려줘',
            rerankedResults,
            chunkResults,
            memoPropertiesMap,
            topK: 2,
        })

        expect(preserved[0]?.memo_uuid).toBe('memo-2')
        expect(preserved.map((result) => result.memo_uuid)).toEqual(['memo-2', 'memo-1'])
    })

    it('builds a literal query anchor block for final LLM context assembly', () => {
        const anchorBlock = __testables__.buildLiteralQueryAnchorBlock('PROJ-123 상태와 exception.20210 원인 알려줘')

        expect(anchorBlock).toContain('[Literal Query Anchors — prioritize evidence containing these exact strings]')
        expect(anchorBlock).toContain('exception.20210, PROJ-123, 20210')
        expect(anchorBlock).toContain('[End of Literal Query Anchors]')
    })

    it('detects strong literal anchor evidence from reranked error-code snippets', () => {
        const hasEvidence = __testables__.hasStrongLiteralAnchorEvidence({
            query: '레거시 sast 오류코드 450002 에 대해 모두 알려줘',
            rerankedResults: [
                {
                    index: 0,
                    document: '오류 코드: 450002 (NEST)\n오류 명칭: 해당 리파지토리가 분석중임',
                    relevance_score: 0.08,
                    memo_uuid: 'memo-450002',
                    memo_title: 'Sparrow legacy 레거시 오류 코드',
                },
            ],
            chunkResults: [
                {
                    chunk: {
                        uuid: 'chunk-450002',
                        chunk_content: '오류 코드: 450002 (NEST)\n오류 명칭: 해당 리파지토리가 분석중임',
                        chunk_index: 0,
                        embedding: [],
                        memo_uuid: 'memo-450002',
                        project_uuid: 'project-1',
                    },
                    distance: 0.9,
                },
            ] as MemoChunkWithDistance[],
            memoPropertiesMap: new Map([
                [
                    'memo-450002',
                    {
                        title: 'Sparrow legacy 레거시 오류 코드',
                        summary: '450002 오류 요약',
                        content: '상세 설명',
                        source_url: '',
                    },
                ],
            ]),
        })

        expect(hasEvidence).toBe(true)
    })
})

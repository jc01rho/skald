import { chat } from '../api/chat'
import { routeQuery } from '../lib/queryRouter'
import { ragGraph } from '../agents/chatAgent/ragGraph'
import { streamChatAgent } from '../agents/chatAgent/chatAgent'
import { getCachedResponse, cacheResponse } from '../lib/ragCache'

jest.mock('../lib/queryRouter', () => ({
    routeQuery: jest.fn(),
}))

jest.mock('../agents/chatAgent/ragGraph', () => ({
    ragGraph: { invoke: jest.fn() },
}))

jest.mock('../agents/chatAgent/chatAgent', () => ({
    streamChatAgent: jest.fn(),
}))

jest.mock('../lib/ragCache', () => ({
    getCachedResponse: jest.fn(),
    cacheResponse: jest.fn(),
}))

jest.mock('../lib/chatUtils', () => ({
    createChatMessagePair: jest.fn().mockResolvedValue('chat-1'),
}))

jest.mock('../middleware/trackChatUsageMiddleware', () => ({
    trackChatUsage: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}))

jest.mock('../middleware/rateLimitMiddleware', () => ({
    chatRateLimiter: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}))

jest.mock('../lib/posthogUtils', () => ({
    posthogCapture: jest.fn(),
}))

jest.mock('../lib/selfRagEvaluator', () => ({
    SelfRagEvaluator: {
        evaluate: jest.fn(),
        requiresRegeneration: jest.fn(() => false),
        shouldRollback: jest.fn(() => false),
    },
}))

jest.mock('../lib/complexityCalculator', () => ({
    ComplexityCalculator: {
        calculate: jest.fn(() => ({ requiresSelfRag: false })),
    },
}))

jest.mock('../lib/lazyReprocessService', () => ({
    checkAndQueueLazyReprocess: jest.fn(),
    extractMemoUuidsFromRerankResults: jest.fn(() => []),
    extractMemoUuidsFromReferences: jest.fn(() => []),
}))

describe('chat response cache behavior with references', () => {
    const routeQueryMock = jest.mocked(routeQuery)
    const ragInvokeMock = jest.mocked(ragGraph.invoke)
    const streamChatAgentMock = jest.mocked(streamChatAgent)
    const getCachedResponseMock = jest.mocked(getCachedResponse)
    const cacheResponseMock = jest.mocked(cacheResponse)

    const req: any = {
        body: {
            query: '레거시 sast 오류코드 450002 에 대해 모두 알려줘',
            stream: false,
            system_prompt: '항상 한국어로 답하라.',
            rag_config: {
                references: { enabled: true },
                reranking: { enabled: true, top_k: 10 },
                vector_search: { top_k: 10, similarity_threshold: 0.4 },
                query_rewrite: { enabled: true },
            },
        },
        query: { project_id: 'project-1' },
        context: {
            requestUser: {
                project: {
                    uuid: 'project-1',
                    organization: { uuid: 'org-1' },
                },
                userInstance: null,
            },
        },
    }

    const res: any = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    }

    beforeEach(() => {
        jest.clearAllMocks()
        routeQueryMock.mockReturnValue({ route: 'rag' } as any)
        getCachedResponseMock.mockResolvedValue('stale cached response')
        ragInvokeMock.mockResolvedValue({
            query: req.body.query,
            contextStr: 'context',
            prompt: {} as any,
            rerankedResults: [
                {
                    memo_uuid: 'memo-1',
                    memo_title: 'manual submit memo',
                    source_url: 'https://ui.skald.local/projects/project-1/memos/memo-1',
                },
            ],
            exactLookupResults: [],
            lookupHit: true,
        } as any)
        streamChatAgentMock.mockImplementation(async function* () {
            yield { type: 'token', content: 'fresh answer [[1]]' } as any
            yield {
                type: 'references',
                content: JSON.stringify({
                    1: {
                        memo_uuid: 'memo-1',
                        memo_title: 'manual submit memo',
                        source_url: 'https://ui.skald.local/projects/project-1/memos/memo-1',
                    },
                }),
            } as any
        })
    })

    it('bypasses cached text responses when references are enabled', async () => {
        await chat(req, res)

        expect(getCachedResponseMock).not.toHaveBeenCalled()
        expect(ragInvokeMock).toHaveBeenCalled()
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                response: 'fresh answer [[1]]',
                references: {
                    1: {
                        memo_uuid: 'memo-1',
                        memo_title: 'manual submit memo',
                        source_url: 'https://ui.skald.local/projects/project-1/memos/memo-1',
                    },
                },
            })
        )
    })

    it('does not cache final text-only responses when references are enabled', async () => {
        await chat(req, res)

        expect(cacheResponseMock).not.toHaveBeenCalled()
    })
})

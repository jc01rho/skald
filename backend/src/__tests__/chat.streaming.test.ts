import { Response } from 'express'
import { _generateStreamingResponse } from '../api/chat'
import * as ragGraphModule from '../agents/chatAgent/ragGraph'
import * as chatAgent from '../agents/chatAgent/chatAgent'
import * as chatUtils from '../lib/chatUtils'
import * as ragCache from '../lib/ragCache'
import * as fastRetrieveModule from '../lib/fastRetrieve'
import * as previewAgentModule from '../agents/chatAgent/previewAgent'
import { Project } from '../entities/Project'

jest.mock('../agents/chatAgent/ragGraph', () => ({
    ragGraph: {
        invoke: jest.fn(),
    },
}))
jest.mock('../agents/chatAgent/chatAgent', () => ({
    streamChatAgent: jest.fn(),
}))
jest.mock('../lib/chatUtils', () => ({
    createChatWithUserMessage: jest.fn().mockResolvedValue({ chatUuid: 'chat-1', messageGroupId: 'group-1' }),
    persistAssistantMessage: jest.fn().mockResolvedValue(undefined),
    createChatMessagePair: jest.fn(),
}))
jest.mock('../lib/ragCache', () => ({
    getCachedResponse: jest.fn().mockResolvedValue(null),
    cacheResponse: jest.fn(),
}))
jest.mock('../lib/fastRetrieve', () => ({
    fastRetrieve: jest.fn().mockResolvedValue({ contextStr: 'Result 1: preview context', results: [] }),
}))
jest.mock('../agents/chatAgent/previewAgent', () => ({
    generatePreview: jest
        .fn()
        .mockResolvedValue('1차 답변: 질문을 확인했습니다. 최종 답변은 곧 자세한 근거와 함께 이어집니다.'),
}))
jest.mock('../lib/lazyReprocessService', () => ({
    checkAndQueueLazyReprocess: jest.fn().mockResolvedValue(undefined),
    extractMemoUuidsFromRerankResults: jest.fn().mockReturnValue([]),
    extractMemoUuidsFromReferences: jest.fn().mockReturnValue([]),
}))
jest.mock('../lib/posthogUtils', () => ({
    posthogCapture: jest.fn(),
}))
jest.mock('@sentry/node', () => ({
    captureException: jest.fn(),
}))
jest.mock('../lib/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}))
jest.mock('../settings', () => {
    const originalModule = jest.requireActual('../settings')
    return {
        ...originalModule,
        IS_DEVELOPMENT: true,
        SECRET_KEY: process.env.SECRET_KEY || 'UNSAFE_DEFAULT_SECRET_KEY',
    }
})

function createMockResponse() {
    const writes: string[] = []
    return {
        writes,
        res: {
            setHeader: jest.fn(),
            write: jest.fn((chunk: string) => {
                writes.push(chunk)
                return true
            }),
            end: jest.fn(),
        } as unknown as Response,
    }
}

describe('_generateStreamingResponse', () => {
    const project = {
        uuid: 'project-1',
        organization: { uuid: 'org-1' },
    } as unknown as Project

    beforeEach(() => {
        jest.clearAllMocks()
        ;(ragCache.getCachedResponse as jest.Mock).mockResolvedValue(null)
        ;(fastRetrieveModule.fastRetrieve as jest.Mock).mockResolvedValue({
            contextStr: 'Result 1: preview context',
            results: [],
        })
        ;(previewAgentModule.generatePreview as jest.Mock).mockResolvedValue(
            '1차 답변: 질문을 확인했습니다. 최종 답변은 곧 자세한 근거와 함께 이어집니다.'
        )
    })

    it('emits preview before the first token on the streaming RAG path', async () => {
        const { res, writes } = createMockResponse()

        ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue({
            query: 'test query',
            prompt: {},
            contextStr: 'deep context',
            rerankedResults: [],
            exactLookupResults: [],
            lookupHit: false,
            queryUnderstanding: null,
        })

        async function* stream() {
            yield { type: 'token', content: 'final token' }
        }

        ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(stream())

        await _generateStreamingResponse({
            res,
            query: 'test query',
            project,
            chatId: undefined,
            filters: [],
            memoFilters: [],
            clientSystemPrompt: null,
            userContext: null,
            distinctId: 'user:1',
            parsedRagConfig: {
                llmProvider: 'cli-proxy-api',
                references: { enabled: false },
            },
            routeResult: { route: 'rag' },
            previewCacheKey: 'preview-key',
        })

        const joined = writes.join('')
        const previewIndex = joined.indexOf('"type":"preview"')
        const tokenIndex = joined.indexOf('"type":"token"')
        expect(previewIndex).toBeGreaterThan(-1)
        expect(tokenIndex).toBeGreaterThan(-1)
        expect(previewIndex).toBeLessThan(tokenIndex)
        expect(fastRetrieveModule.fastRetrieve).toHaveBeenCalled()
        expect(previewAgentModule.generatePreview).toHaveBeenCalled()
        expect(chatUtils.persistAssistantMessage).toHaveBeenCalledWith(project, 'chat-1', 'group-1', 'final token')
    })

    it('uses cached preview without invoking the fast preview stage', async () => {
        const { res, writes } = createMockResponse()

        ;(ragCache.getCachedResponse as jest.Mock).mockResolvedValue('cached preview')
        ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue({
            query: 'test query',
            prompt: {},
            contextStr: 'deep context',
            rerankedResults: [],
            exactLookupResults: [],
            lookupHit: false,
            queryUnderstanding: null,
        })

        async function* stream() {
            yield { type: 'token', content: 'final token' }
        }

        ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(stream())

        await _generateStreamingResponse({
            res,
            query: 'test query',
            project,
            chatId: undefined,
            filters: [],
            memoFilters: [],
            clientSystemPrompt: null,
            userContext: null,
            distinctId: 'user:1',
            parsedRagConfig: {
                llmProvider: 'cli-proxy-api',
                references: { enabled: false },
            },
            routeResult: { route: 'rag' },
            previewCacheKey: 'preview-key',
        })

        expect(writes.join('')).toContain('cached preview')
        expect(fastRetrieveModule.fastRetrieve).not.toHaveBeenCalled()
        expect(previewAgentModule.generatePreview).not.toHaveBeenCalled()
    })

    it('falls back to default preview copy when the fast preview stage fails', async () => {
        const { res, writes } = createMockResponse()

        ;(fastRetrieveModule.fastRetrieve as jest.Mock).mockRejectedValue(new Error('preview failed'))
        ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue({
            query: 'test query',
            prompt: {},
            contextStr: 'deep context',
            rerankedResults: [],
            exactLookupResults: [],
            lookupHit: false,
            queryUnderstanding: null,
        })

        async function* stream() {
            yield { type: 'token', content: 'final token' }
        }

        ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(stream())

        await _generateStreamingResponse({
            res,
            query: 'test query',
            project,
            chatId: undefined,
            filters: [],
            memoFilters: [],
            clientSystemPrompt: null,
            userContext: null,
            distinctId: 'user:1',
            parsedRagConfig: {
                llmProvider: 'cli-proxy-api',
                references: { enabled: false },
            },
            routeResult: { route: 'rag' },
            previewCacheKey: 'preview-key',
        })

        expect(writes.join('')).toContain(
            '1차 답변: 질문을 확인했습니다. 최종 답변은 곧 자세한 근거와 함께 이어집니다.'
        )
    })
})

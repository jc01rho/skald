import { decomposeQuery } from '../agents/chatAgent/queryRewrite'
import { LLMService } from '../services/llmService'

jest.mock('../services/llmService')
jest.mock('@sentry/node', () => ({
    captureException: jest.fn(),
}))
jest.mock('../lib/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}))

describe('query decomposition', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('keeps the original query first and caps sub-questions at 3', async () => {
        ;(LLMService.invokeWithRetry as jest.Mock).mockResolvedValue({
            content: '요약해줘\n원인을 알려줘\n추천안을 제안해줘\n추가로 무시될 질문',
        })

        const query = '장애를 요약하고 원인과 추천안을 알려줘'
        const result = await decomposeQuery(query)

        expect(result).toEqual([query, '요약해줘', '원인을 알려줘', '추천안을 제안해줘'])
    })

    it('falls back to the original query when decomposition returns empty output', async () => {
        ;(LLMService.invokeWithRetry as jest.Mock).mockResolvedValue({ content: '' })

        const query = '장애를 요약하고 원인을 알려줘'
        const result = await decomposeQuery(query)

        expect(result).toEqual([query])
    })

    it('falls back to the original query when decomposition fails', async () => {
        ;(LLMService.invokeWithRetry as jest.Mock).mockRejectedValue(new Error('API Error'))

        const query = '장애를 요약하고 원인을 알려줘'
        const result = await decomposeQuery(query)

        expect(result).toEqual([query])
    })
})

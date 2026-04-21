import { generatePreview, __testables__ } from '../agents/chatAgent/previewAgent'
import { LLMService } from '../services/llmService'

jest.mock('../services/llmService')
jest.mock('../lib/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}))

describe('generatePreview', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('aggregates streamed preview text', async () => {
        async function* stream() {
            yield { content: '1차 답변: 핵심 내용입니다.' }
            yield { content: ' 최종 답변은 곧 자세한 근거와 함께 이어집니다.' }
        }

        ;(LLMService.streamWithFallback as jest.Mock).mockReturnValue(stream())

        const result = await generatePreview({ query: '질문', context: 'Result 1: 문맥' })

        expect(result).toBe('1차 답변: 핵심 내용입니다. 최종 답변은 곧 자세한 근거와 함께 이어집니다.')
    })

    it('adds the final guidance sentence when the stream does not include it', async () => {
        async function* stream() {
            yield { content: '1차 답변: 관련 문서를 확인했습니다.' }
        }

        ;(LLMService.streamWithFallback as jest.Mock).mockReturnValue(stream())

        const result = await generatePreview({ query: '질문', context: 'Result 1: 문맥', maxLength: 200 })

        expect(result).toBe('1차 답변: 관련 문서를 확인했습니다. 최종 답변은 곧 자세한 근거와 함께 이어집니다.')
    })

    it('falls back to default preview copy when the stream is empty', async () => {
        async function* stream() {
            return
        }

        ;(LLMService.streamWithFallback as jest.Mock).mockReturnValue(stream())

        const result = await generatePreview({ query: '질문', context: '' })

        expect(result).toBe(__testables__.DEFAULT_PREVIEW_FALLBACK)
    })

    it('uses the empty-context placeholder when context is missing', async () => {
        async function* stream() {
            yield { content: '1차 답변: 질문 범위를 먼저 좁히고 있습니다.' }
        }

        ;(LLMService.streamWithFallback as jest.Mock).mockReturnValue(stream())

        await generatePreview({ query: '질문' })

        expect(LLMService.streamWithFallback).toHaveBeenCalledWith(
            expect.objectContaining({
                input: expect.objectContaining({
                    context: __testables__.EMPTY_CONTEXT_PLACEHOLDER,
                }),
            })
        )
    })
})

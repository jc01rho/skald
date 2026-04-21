import { LLMService } from '@/services/llmService'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { logger } from '@/lib/logger'
import { PREVIEW_SYSTEM_PROMPT } from './prompts'

export const PREVIEW_MAX_LENGTH = 500
const EMPTY_CONTEXT_PLACEHOLDER = '(관련 문서를 아직 찾지 못했습니다. 질문의 핵심 주제만 안전하게 요약하십시오.)'
const DEFAULT_PREVIEW_FALLBACK = '1차 답변: 질문을 확인했습니다. 최종 답변은 곧 자세한 근거와 함께 이어집니다.'

function buildPreviewPrompt(): ChatPromptTemplate {
    return ChatPromptTemplate.fromMessages([
        ['system', PREVIEW_SYSTEM_PROMPT],
        ['human', '{input}'],
    ])
}

/**
 * Stage A preview-only helper. Aggregates a short, non-authoritative
 * preview via LLMService.streamWithFallback. Capped at PREVIEW_MAX_LENGTH,
 * returns empty string on failure, substitutes a placeholder when context is empty.
 */
export async function generatePreview(params: {
    query: string
    context?: string
    maxLength?: number
    temperature?: number
}): Promise<string> {
    const { query, context, maxLength = PREVIEW_MAX_LENGTH, temperature = 0.3 } = params

    const contextBlock = context && context.trim().length > 0 ? context : EMPTY_CONTEXT_PLACEHOLDER

    const prompt = buildPreviewPrompt()

    let aggregated = ''

    try {
        const stream = LLMService.streamWithFallback({
            prompt,
            input: {
                input: query,
                context: contextBlock,
            },
            temperature,
            maxRetries: 2,
            retryDelayMs: 500,
        })

        for await (const chunk of stream) {
            if (chunk.content) {
                let normalized: string
                if (typeof chunk.content === 'string') {
                    normalized = chunk.content
                } else if (typeof chunk.content === 'object' && chunk.content !== null) {
                    const content = chunk.content as { text?: string; content?: string }
                    normalized = content.text || content.content || String(chunk.content)
                } else {
                    normalized = String(chunk.content)
                }
                aggregated += normalized

                if (aggregated.length > maxLength + 50) {
                    break
                }
            }
        }
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Preview agent streaming failed, returning empty preview')
        return ''
    }

    if (aggregated.length > maxLength) {
        aggregated = aggregated.slice(0, maxLength).trimEnd() + '…'
    }

    const normalizedPreview = aggregated.replace(/\s+/g, ' ').trim()
    if (!normalizedPreview) {
        return DEFAULT_PREVIEW_FALLBACK
    }

    if (normalizedPreview.includes('최종 답변은 곧 자세한 근거와 함께 이어집니다.')) {
        return normalizedPreview
    }

    return `${normalizedPreview} 최종 답변은 곧 자세한 근거와 함께 이어집니다.`
}

export const __testables__ = {
    buildPreviewPrompt,
    PREVIEW_MAX_LENGTH,
    EMPTY_CONTEXT_PLACEHOLDER,
    DEFAULT_PREVIEW_FALLBACK,
}

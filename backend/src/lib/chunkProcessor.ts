import { LLMService } from '../services/llmService'
import { logger } from './logger'

const CONTEXT_GENERATION_PROMPT = `당신은 문서 청크에 컨텍스트를 추가하는 전문가입니다.

작업:
다음 청크가 전체 문서에서 어떤 역할을 하는지 50-100자로 설명하세요.

문서 제목: {documentTitle}
전체 문서:
{fullDocument}

청크:
{chunk}

컨텍스트 설명 (50-100자, 한국어 또는 영어로):
`

/**
 * Generate contextual description for a chunk using LLM
 */
export async function generateChunkContext(
    chunk: string,
    fullDocument: string,
    documentTitle: string
): Promise<string> {
    try {
        const prompt = CONTEXT_GENERATION_PROMPT.replace('{documentTitle}', documentTitle)
            .replace('{fullDocument}', fullDocument.slice(0, 4000))
            .replace('{chunk}', chunk)

        const response = await LLMService.invokeWithRetry({
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
        })
        const context = response.content?.toString().trim()

        if (!context) {
            logger.warn({ chunk: chunk.slice(0, 100) }, 'Context generation returned empty')
            return ''
        }

        return context
    } catch (error) {
        logger.error({ err: error }, 'Failed to generate chunk context')
        return ''
    }
}

/**
 * Prepend context to chunk content
 */
export async function addContextToChunk(chunk: string, context: string): Promise<string> {
    if (!context || context.trim().length === 0) {
        return chunk
    }

    return `[CONTEXT: ${context}]\n\n${chunk}`
}

/**
 * Process multiple chunks with contextual retrieval
 */
export async function processChunksWithContext(
    chunks: Array<{ content: string; index: number }>,
    fullDocument: string,
    documentTitle: string
): Promise<Array<{ content: string; index: number; context: string }>> {
    const processedChunks = []

    for (const chunk of chunks) {
        const context = await generateChunkContext(chunk.content, fullDocument, documentTitle)
        const contextualizedContent = await addContextToChunk(chunk.content, context)

        processedChunks.push({
            content: contextualizedContent,
            index: chunk.index,
            context,
        })
    }

    return processedChunks
}

import { LLMService } from '@/services/llmService'
import { ChatPromptTemplate } from '@langchain/core/prompts'

interface StreamChunk {
    type: 'token' | 'error' | 'done' | 'references'
    content?: string
}

interface RerankResult {
    memo_uuid?: string
    memo_title?: string
    source_url?: string
}

export async function* streamChatAgent({
    query,
    prompt,
    contextStr,
    rerankResults,
    enableReferences,
}: {
    query: string
    prompt: ChatPromptTemplate
    contextStr: string
    rerankResults: RerankResult[]
    enableReferences: boolean
}): AsyncGenerator<StreamChunk> {
    // Use streamWithFallback for automatic fallback on 503 capacity errors
    const stream = LLMService.streamWithFallback({
        prompt,
        input: {
            input: query,
            context: contextStr,
        },
        temperature: 0.7,
    })

    for await (const chunk of stream) {
        if (chunk.content) {
            // Normalize content to string, handling different LLM response formats
            let normalizedContent: string
            if (typeof chunk.content === 'string') {
                normalizedContent = chunk.content
            } else if (typeof chunk.content === 'object') {
                // Extract text from dict (Anthropic format)
                const content = chunk.content as any
                normalizedContent = content.text || content.content || String(content)
            } else {
                normalizedContent = String(chunk.content)
            }

            yield {
                type: 'token',
                content: normalizedContent,
            }
        }
    }

    if (enableReferences && rerankResults.length > 0) {
        const references: Record<number, { memo_uuid: string; memo_title: string; source_url?: string }> = {}
        for (let i = 0; i < rerankResults.length; i++) {
            const rerankResult = rerankResults[i]
            if (rerankResult.memo_uuid && rerankResult.memo_title) {
                references[i + 1] = {
                    memo_uuid: rerankResult.memo_uuid,
                    memo_title: rerankResult.memo_title,
                    source_url: rerankResult.source_url,
                }
            }
        }
        if (Object.keys(references).length > 0) {
            yield {
                type: 'references',
                content: JSON.stringify(references),
            }
        }
    }
}

import { LLMService } from '@/services/llmService'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { logger } from '@/lib/logger'

interface StreamChunk {
    type: 'token' | 'error' | 'done' | 'references'
    content?: string
}

interface RerankResult {
    memo_uuid?: string
    memo_title?: string
    source_url?: string
}

function buildReferencesPayload(
    fullResponseText: string,
    rerankResults: RerankResult[]
): Record<number, { memo_uuid: string; memo_title: string; source_url?: string }> {
    const citedNumbers = extractCitedReferenceNumbers(fullResponseText)
    const allReferences: Record<number, { memo_uuid: string; memo_title: string; source_url?: string }> = {}

    for (let i = 0; i < rerankResults.length; i++) {
        const rerankResult = rerankResults[i]
        if (rerankResult.memo_uuid && rerankResult.memo_title) {
            allReferences[i + 1] = {
                memo_uuid: rerankResult.memo_uuid,
                memo_title: rerankResult.memo_title,
                source_url: rerankResult.source_url,
            }
        }
    }

    if (citedNumbers.length === 0) {
        logger.info(
            { totalAvailable: Object.keys(allReferences).length },
            'Citation post-processing: no citations found, omitting references payload'
        )
        return {}
    }

    const filteredReferences: Record<number, { memo_uuid: string; memo_title: string; source_url?: string }> = {}
    for (const num of citedNumbers) {
        if (allReferences[num]) {
            filteredReferences[num] = allReferences[num]
        }
    }

    const totalAvailable = Object.keys(allReferences).length
    const totalCited = Object.keys(filteredReferences).length
    if (totalCited < totalAvailable) {
        logger.info(
            {
                totalAvailable,
                totalCited,
                citedNumbers,
                droppedCount: totalAvailable - totalCited,
            },
            'Citation post-processing: filtered uncited references'
        )
    }

    if (totalCited === 0 && totalAvailable > 0) {
        logger.warn(
            { totalAvailable, citedNumbers },
            'Citation post-processing: cited references missing from payload, omitting references payload'
        )
        return {}
    }

    return filteredReferences
}

function extractCitedReferenceNumbers(text: string): number[] {
    const citationPattern = /\[\[(\d+)\]\]|\[(\d+)\]/g
    const cited = new Set<number>()
    let match
    while ((match = citationPattern.exec(text)) !== null) {
        const citationNumber = match[1] || match[2]
        if (!citationNumber) {
            continue
        }
        cited.add(parseInt(citationNumber, 10))
    }
    return Array.from(cited).sort((a, b) => a - b)
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

    // P1-1: Accumulate full response text for citation cross-validation
    let fullResponseText = ''

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

            fullResponseText += normalizedContent

            yield {
                type: 'token',
                content: normalizedContent,
            }
        }
    }

    if (enableReferences && rerankResults.length > 0) {
        const filteredReferences = buildReferencesPayload(fullResponseText, rerankResults)

        if (Object.keys(filteredReferences).length > 0) {
            yield {
                type: 'references',
                content: JSON.stringify(filteredReferences),
            }
        }
    }
}

export const __testables__ = {
    extractCitedReferenceNumbers,
    buildReferencesPayload,
}

import { z } from 'zod'
import { LLMService } from '@/services/llmService'
import { CLI_PROXY_API_KEY } from '@/settings'

// Output schema for the memo summary agent
const MemoSummaryOutputSchema = z.object({
    summary: z.string().describe('A concise summary of the memo content, maximum one paragraph'),
})

export type MemoSummaryOutput = z.infer<typeof MemoSummaryOutputSchema>

const MEMO_SUMMARY_AGENT_INSTRUCTIONS = `
당신은 텍스트 내용을 요약하는 전문 보조 도구입니다. 주어진 텍스트의 내용을 최대 한 단락으로 요약하세요.

중요: 반드시 다음 JSON 형식으로만 응답해야 합니다. 다른 텍스트나 마크다운 서식(\`\`\`json 등)을 포함하지 마세요.
{
    "summary": "요약 내용..."
}

간결하게 작성하되 모든 중요한 정보를 포함해야 합니다.

내용이 마크다운과 같은 형식을 따를 경우, 요약문 끝에 문서의 개요를 포함하여 모든 제목을 다루도록 하세요.
`

/**
 * Creates a memo summary agent that generates concise summaries of memo content
 * @returns An agent that can summarize memo content
 */
export function createMemoSummaryAgent() {
    // Check if CLI_PROXY_API_KEY is configured
    if (!CLI_PROXY_API_KEY) {
        return {
            name: 'Memo Summary Agent (disabled)',
            async summarize(_memoContent: string): Promise<MemoSummaryOutput> {
                throw new Error('Memo Summary Agent is not available: CLI_PROXY_API_KEY is not configured')
            },
        }
    }

    const llm = LLMService.getLLM({ purpose: 'classification' })

    return {
        name: 'Memo Summary Agent',
        /**
         * Generate a summary of memo content
         * @param memoContent - The content of the memo to summarize
         * @returns Promise resolving to the generated summary
         */
        async summarize(memoContent: string): Promise<MemoSummaryOutput> {
            const prompt = MEMO_SUMMARY_AGENT_INSTRUCTIONS + '\n\n' + `요약할 텍스트:\n${memoContent}`

            console.log(`[MemoSummaryAgent] Starting summary generation (length: ${memoContent.length})`)
            try {
                const response = await llm.invoke(
                    [
                        {
                            role: 'user',
                            content: prompt,
                        },
                    ],
                    {
                        callbacks: [], // Disable LangSmith tracing
                    }
                )

                const responseText = response.content?.toString().trim() || ''
                const cleanedJson = responseText
                    .replace(/^```json?\n?/i, '')
                    .replace(/\n?```$/i, '')
                    .trim()
                const parsed = JSON.parse(cleanedJson)
                const result = MemoSummaryOutputSchema.parse(parsed)

                console.log(`[MemoSummaryAgent] Summary generation successful`)
                return result as MemoSummaryOutput
            } catch (error) {
                console.error(`[MemoSummaryAgent] Summary generation failed:`, error)
                // Fallback to basic string if structured output fails (optional, but good for robustness)
                throw error
            }
        },
    }
}

// Lazy initialization - only create when first accessed
let _memoSummaryAgent: ReturnType<typeof createMemoSummaryAgent> | null = null

export function getMemoSummaryAgent() {
    if (!_memoSummaryAgent) {
        _memoSummaryAgent = createMemoSummaryAgent()
    }
    return _memoSummaryAgent
}

// For backward compatibility - but now lazy
export const memoSummaryAgent = {
    get name() {
        return getMemoSummaryAgent().name
    },
    summarize: (memoContent: string) => {
        return getMemoSummaryAgent().summarize(memoContent)
    },
}

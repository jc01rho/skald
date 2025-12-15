import { z } from 'zod'
import { LLMService } from '@/services/llmService'

// Output schema for the memo summary agent
const MemoSummaryOutputSchema = z.object({
    summary: z.string().describe('A concise summary of the memo content, maximum one paragraph'),
})

export type MemoSummaryOutput = z.infer<typeof MemoSummaryOutputSchema>

const MEMO_SUMMARY_AGENT_INSTRUCTIONS = `
당신은 텍스트 내용을 요약하는 전문 보조 도구입니다. 주어진 텍스트의 내용을 최대 한 단락으로 요약하세요.

간결하게 작성하되 모든 중요한 정보를 포함해야 합니다.

내용이 마크다운과 같은 형식을 따를 경우, 요약문 끝에 문서의 개요를 포함하여 모든 제목을 다루도록 하세요.
`

/**
 * Creates a memo summary agent that generates concise summaries of memo content
 * @returns An agent that can summarize memo content
 */
export function createMemoSummaryAgent() {
    const llm = LLMService.getLLM({ purpose: 'classification' })

    const structuredLlm = llm.withStructuredOutput(MemoSummaryOutputSchema, {
        name: 'MemoSummaryAgent',
    })

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
                const result = await structuredLlm.invoke(
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

export const memoSummaryAgent = createMemoSummaryAgent()

import { z } from 'zod'
import { LLMService } from '@/services/llmService'

// Output schema for the memo tags agent
const MemoTagsOutputSchema = z.object({
    tags: z.array(z.string()).describe('List of relevant tags that describe the content of the memo'),
})

export type MemoTagsOutput = z.infer<typeof MemoTagsOutputSchema>

const MEMO_TAGS_AGENT_INSTRUCTIONS = `
당신은 메모에서 태그를 추출하는 전문가 어시스턴트입니다. 주어진 메모에서 가장 관련된 태그를 추출하여 메모의 내용을 설명합니다.
이러한 태그는 메모를 카테고리화하고 나중에 찾기 쉽도록 사용됩니다.

중요: 반드시 다음 JSON 형식으로만 응답해야 합니다. 다른 텍스트나 마크다운 서식(\`\`\`json 등)을 포함하지 마세요.
{
    "tags": ["태그1", "태그2"]
}

이미 지식베이스에 사용된 태그 목록이 제공되면 가능한 한 재사용하고 새로운 태그를 만들지 않는 것이 좋습니다.
`

/**
 * Creates a memo tags agent that extracts relevant tags from a memo
 * Uses lazy initialization to avoid startup crashes when CLI_PROXY_API_KEY is not set
 * @returns An agent that can extract tags from memo content
 */
export function createMemoTagsAgent() {
    // Lazy initialization - LLM is only created when extractTags is called
    let structuredLlm: ReturnType<ReturnType<typeof LLMService.getLLM>['withStructuredOutput']> | null = null

    const getStructuredLlm = () => {
        if (!structuredLlm) {
            if (!process.env.CLI_PROXY_API_KEY) {
                throw new Error('CLI_PROXY_API_KEY is required for memoTagsAgent')
            }
            const llm = LLMService.getLLM({ purpose: 'classification' })
            structuredLlm = llm.withStructuredOutput(MemoTagsOutputSchema, {
                name: 'MemoTagsAgent',
            })
        }
        return structuredLlm
    }

    return {
        name: 'Memo Tags Agent',
        /**
         * Extract tags from a memo
         * @param memoContent - The content of the memo
         * @param existingTags - Optional list of existing tags to reuse
         * @returns Promise resolving to the extracted tags
         */
        async extractTags(memoContent: string, existingTags?: string[]): Promise<MemoTagsOutput> {
            let prompt = MEMO_TAGS_AGENT_INSTRUCTIONS + '\n\n'

            if (existingTags && existingTags.length > 0) {
                prompt += `Existing tags in the knowledge base: ${existingTags.join(', ')}\n\n`
            }

            prompt += `Memo content:\n${memoContent}`

            const result = await getStructuredLlm().invoke(
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

            return result as unknown as MemoTagsOutput
        },
    }
}

// Lazy singleton - createMemoTagsAgent() no longer calls LLMService at module load time
export const memoTagsAgent = createMemoTagsAgent()

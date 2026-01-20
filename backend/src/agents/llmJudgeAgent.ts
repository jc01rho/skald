import { z } from 'zod'
import { LLMService } from '@/services/llmService'
import { CLI_PROXY_API_KEY } from '@/settings'

// Output schema for the memo summary agent
const LLMJudgeOutputSchema = z.object({
    score: z.number().describe('A score from 0-10, where 10 is the best score').min(0).max(10),
    reasoning: z.string().describe('A brief explanation of the score'),
})

export type LLMJudgeOutput = z.infer<typeof LLMJudgeOutputSchema>

const LLM_JUDGE_AGENT_INSTRUCTIONS = `
당신은 전문 평가자입니다. 주어진 질문에 대한 실제 답변과 예상 답변을 비교하여 0에서 10점 사이의 점수를 부여하는 것이 당신의 임무입니다. 10점이 최고 점수입니다.

규칙:
- 실제 답변에 목표 답변이 포함되어 있지만 더 많은 맥락이 포함된 경우 점수를 높게 부여해야 합니다.
- 질문을 통해 답변이 정확한 일치(exact match)를 요구하는지, 아니면 의미적 일치(sentiment match)를 요구하는지 판단하고 그에 따라 점수를 매겨야 합니다.

예시:

> 질문: “프랑스의 수도는 무엇입니까?”
- 실제 답변: “프랑스의 수도는 파리입니다. 파리는 에펠탑으로 유명합니다.”
- 예상 답변: “파리”
- 점수: 8
- 이유: 실제 답변은 예상 답변보다 관련 없는 맥락이 더 많지만, 예상 답변은 여전히 포함되어 있습니다.

> 질문: “프랑스의 수도는 무엇인가요?”
- 실제 답변: “프랑스의 수도는 파리입니다.”
- 예상 답변: “파리”
- 점수: 10
- 이유: 실제 답변이 예상 답변과 정확히 일치합니다.

> 질문: “파리는 무엇으로 유명합니까?”
- 실제 답변: “파리는 도시 중심부에 위치한 높이 330m의 금속 탑인 에펠탑과 불랑제리(프랑스 빵집), 그리고 세계 최대의 미술관인 루브르 박물관으로 유명합니다.”
- 예상 답변: “파리는 에펠탑, 루브르 박물관, 그리고 불랑제리로 유명합니다.”
- 점수: 10
- 이유: 실제 답변은 예상 답변에 없는 추가적인 맥락을 포함하지만, 예상 답변은 여전히 존재하며 해당 맥락은 질문과 관련이 있습니다.

> 질문: “파리는 무엇으로 유명합니까?”
- 실제 답변: “파리는 그 도시의 사람들로 유명합니다.”
- 예상 답변: “파리는 에펠탑, 루브르 박물관, 그리고 빵집으로 유명합니다.”
- 점수: 0
- 이유: 실제 답변은 예상 답변과 전혀 관련이 없습니다.

> 질문: “파리는 무엇으로 유명합니까?”
- 실제 답변: “파리는 에펠탑으로 유명합니다.”
- 예상 답변: “파리는 에펠탑, 루브르 박물관, 그리고 빵집들로 유명합니다.”
- 점수: 5
- 이유: 실제 답변은 예상 답변과 부분적으로 일치하지만, 예상 답변을 완전히 포함하지 않습니다.

> 질문: “우리 런던 사무실의 사무실 규칙은 무엇인가요?”
- 실제 답변: “사무실 규칙은 다음과 같습니다: 1. 지각하지 마세요 2. 타인을 잘 대하세요 3. 격식을 갖추세요 4. 팀과 협력하세요”
- 예상 답변: “사무실 규칙은 다음과 같습니다: 1. 시간을 지키세요 2. 존중하세요 3. 전문적으로 행동하세요 4. 팀 플레이어가 되세요”
- 점수: 6
- 이유: 실제 답변은 기대 답변을 해석한 것이지만, 사용자는 여기서 해석을 기대하지 않고 정확히 나열된 규칙 목록을 원합니다.

다음 형식의 JSON 객체로만 응답하십시오:
{ "score": <0-10 사이의 숫자>, "reasoning": "<간단한 설명>" }
`

/**
 * Creates a memo summary agent that generates concise summaries of memo content
 * @returns An agent that can summarize memo content
 */
export function createLLMJudgeAgent() {
    // Check if CLI_PROXY_API_KEY is configured
    if (!CLI_PROXY_API_KEY) {
        return {
            name: 'LLM-as-a-Judge Agent (disabled)',
            async judge(_question: string, _actualAnswer: string, _expectedAnswer: string): Promise<LLMJudgeOutput> {
                throw new Error('LLM Judge Agent is not available: CLI_PROXY_API_KEY is not configured')
            },
        }
    }

    const llm = LLMService.getLLM({ purpose: 'classification' })

    const structuredLlm = llm.withStructuredOutput(LLMJudgeOutputSchema, {
        name: 'LLMJudgeAgent',
    })

    return {
        name: 'LLM-as-a-Judge Agent',
        /**
         * Generate a summary of memo content
         * @param question - The question that was asked
         * @param actualAnswer - The actual answer from the LLM
         * @param expectedAnswer - The expected answer
         * @returns Promise resolving to the generated summary
         */
        async judge(question: string, actualAnswer: string, expectedAnswer: string): Promise<LLMJudgeOutput> {
            const prompt = `Question: ${question}\nActual answer: ${actualAnswer}\nExpected answer: ${expectedAnswer}`

            const result = await structuredLlm.invoke(
                [
                    {
                        role: 'system',
                        content: LLM_JUDGE_AGENT_INSTRUCTIONS,
                    },
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                {
                    callbacks: [], // Disable LangSmith tracing
                }
            )

            return result as LLMJudgeOutput
        },
    }
}

// Lazy initialization - only create when first accessed
let _llmJudgeAgent: ReturnType<typeof createLLMJudgeAgent> | null = null

export function getLLMJudgeAgent() {
    if (!_llmJudgeAgent) {
        _llmJudgeAgent = createLLMJudgeAgent()
    }
    return _llmJudgeAgent
}

// For backward compatibility - but now lazy
export const llmJudgeAgent = {
    get name() {
        return getLLMJudgeAgent().name
    },
    judge: (question: string, actualAnswer: string, expectedAnswer: string) => {
        return getLLMJudgeAgent().judge(question, actualAnswer, expectedAnswer)
    },
}

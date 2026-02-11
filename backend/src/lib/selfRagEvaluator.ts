import { LLMService } from '@/services/llmService'
import { logger } from '@/lib/logger'
import { HumanMessage } from '@langchain/core/messages'

export interface QualityEvaluation {
    relevance: number // 0.0-1.0
    grounding: number // 0.0-1.0
    completeness: number // 0.0-1.0
    confidence: number // 0.0-1.0
    overall: number // 가중합
    reasoning: string // 평가 근거
}

export interface SelfRagConfig {
    enabled: boolean
    qualityThreshold?: number // 기본 0.75
    rollbackThreshold?: number // 기본 -0.1
}

export class SelfRagEvaluator {
    private static readonly WEIGHTS = {
        relevance: 0.35,
        grounding: 0.3,
        completeness: 0.25,
        confidence: 0.1,
    }
    private static readonly DEFAULT_QUALITY_THRESHOLD = 0.75
    private static readonly DEFAULT_ROLLBACK_THRESHOLD = -0.1

    /**
     * 답변 품질을 4차원으로 평가
     * LLMService.invokeWithRetry()로 LLM 호출
     */
    static async evaluate(query: string, answer: string, context: string[]): Promise<QualityEvaluation> {
        const contextText = context.join('\n\n---\n\n')

        const prompt = `당신은 AI 답변의 품질을 객관적으로 평가하는 전문가입니다.

📋 평가 기준:
1. relevance (관련성): 질문과 답변이 얼마나 관련이 있는가? (0.0-1.0)
   - 1.0: 질문에 직접적으로 답변함
   - 0.5: 부분적으로 관련 있음
   - 0.0: 질문과 무관함

2. grounding (근거성): 답변이 제공된 컨텍스트에 근거하고 있는가? (0.0-1.0)
   - 1.0: 모든 정보가 컨텍스트에서 나옴
   - 0.5: 일부 추측이 포함됨
   - 0.0: 컨텍스트와 무관한 답변

3. completeness (완전성): 질문에 완전히 답변했는가? (0.0-1.0)
   - 1.0: 질문의 모든 부분에 답변함
   - 0.5: 일부만 답변함
   - 0.0: 답변이 불완전함

4. confidence (확신도): 답변의 확실성 수준은? (0.0-1.0)
   - 1.0: 매우 확실한 답변
   - 0.5: 불확실성 포함
   - 0.0: 매우 불확실함

질문: ${query}

제공된 컨텍스트:
${contextText}

생성된 답변:
${answer}

다음 JSON 형식으로만 응답하세요:
{"relevance": 0.0, "grounding": 0.0, "completeness": 0.0, "confidence": 0.0, "reasoning": "간단한 근거"}`

        try {
            const response = await LLMService.invokeWithRetry({
                messages: [new HumanMessage(prompt)],
                temperature: 0.1,
            })

            const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content)

            // JSON 블록 추출 시도
            const jsonMatch =
                content.match(/```json\s*([\s\S]*?)\s*```/) ||
                content.match(/```\s*([\s\S]*?)\s*```/) ||
                content.match(/{[\s\S]*?}/)

            const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content

            const parsed = JSON.parse(jsonStr)

            const relevance = Math.max(0, Math.min(1, parsed.relevance ?? 0.5))
            const grounding = Math.max(0, Math.min(1, parsed.grounding ?? 0.5))
            const completeness = Math.max(0, Math.min(1, parsed.completeness ?? 0.5))
            const confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.5))

            const overall =
                relevance * this.WEIGHTS.relevance +
                grounding * this.WEIGHTS.grounding +
                completeness * this.WEIGHTS.completeness +
                confidence * this.WEIGHTS.confidence

            return {
                relevance,
                grounding,
                completeness,
                confidence,
                overall,
                reasoning: parsed.reasoning ?? '평가 근거 없음',
            }
        } catch (error) {
            logger.warn({ err: error }, 'Self-RAG evaluation failed, returning default scores')
            // Graceful degradation: 기본 점수 반환
            return {
                relevance: 0.5,
                grounding: 0.5,
                completeness: 0.5,
                confidence: 0.5,
                overall: 0.5,
                reasoning: '평가 실패로 인한 기본 점수',
            }
        }
    }

    /**
     * 재생성 필요 여부 판단
     */
    static requiresRegeneration(evaluation: QualityEvaluation, threshold?: number): boolean {
        return evaluation.overall < (threshold ?? this.DEFAULT_QUALITY_THRESHOLD)
    }

    /**
     * 롤백 여부 판단
     * 재생성 답변이 원본보다 rollbackThreshold 이상 나빠지면 원본 유지
     */
    static shouldRollback(
        initialEval: QualityEvaluation,
        retryEval: QualityEvaluation,
        rollbackThreshold?: number
    ): boolean {
        const threshold = rollbackThreshold ?? this.DEFAULT_ROLLBACK_THRESHOLD
        return retryEval.overall < initialEval.overall + threshold
    }
}

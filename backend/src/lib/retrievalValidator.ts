import { RerankResult } from './contextReorder'
import { LLMService } from '../services/llmService'
import { logger } from '../lib/logger'

export interface RelevanceScore {
    index: number
    relevance: '관련' | '부분 관련' | '무관'
    reason?: string
}

export interface RetrievalValidation {
    scores: RelevanceScore[]
    sufficient: boolean
    averageRelevance: number
    needsRetry: boolean
    suggestedStrategy?: 'hyde' | 'multi_query' | 'broader_search'
}

const VALIDATION_PROMPT = `당신은 검색 결과의 관련성을 평가하는 전문가입니다.

질문: {query}

검색된 문서들:
{documents}

각 문서가 질문에 답변하기에 얼마나 관련이 있는지 평가하세요.

관련성 기준:
- "관련": 문서가 질문에 직접 답변하거나 핵심 정보를 제공함
- "부분 관련": 문서가 일부 관련 정보를 제공하지만 직접적인 답변은 아님
- "무관": 문서가 질문과 관련이 없음

JSON 형식으로 응답:
{
  "scores": [
    {"index": 0, "relevance": "관련", "reason": "API 키 설명 포함"},
    {"index": 1, "relevance": "무관", "reason": "데이터베이스 내용"}
  ],
  "sufficient": true/false,
  "suggestedStrategy": "hyde" | "multi_query" | "broader_search" | null
}`

/**
 * Validate retrieval quality using LLM
 */
export async function validateRetrieval(
    query: string,
    results: RerankResult[],
    threshold: number = 0.6
): Promise<RetrievalValidation> {
    if (results.length === 0) {
        return {
            scores: [],
            sufficient: false,
            averageRelevance: 0,
            needsRetry: true,
            suggestedStrategy: 'broader_search',
        }
    }

    try {
        const llm = LLMService.getLLM({ purpose: 'classification', temperature: 0.1 })

        const documents = results
            .map((r, i) => `[${i}] ${r.document.slice(0, 200)}... (score: ${r.relevance_score.toFixed(2)})`)
            .join('\n\n')

        const prompt = VALIDATION_PROMPT.replace('{query}', query).replace('{documents}', documents)

        const response = await llm.invoke([{ role: 'user', content: prompt }])
        const responseText = response.content?.toString().trim() || ''

        const cleanedJson = responseText
            .replace(/^```json?\n?/i, '')
            .replace(/\n?```$/i, '')
            .trim()
        const parsed = JSON.parse(cleanedJson)

        const scores: RelevanceScore[] = parsed.scores
        const sufficient = parsed.sufficient
        const suggestedStrategy = parsed.suggestedStrategy

        const averageRelevance = results.reduce((sum, r) => sum + r.relevance_score, 0) / results.length

        return {
            scores,
            sufficient,
            averageRelevance,
            needsRetry: !sufficient || averageRelevance < threshold,
            suggestedStrategy: sufficient ? undefined : suggestedStrategy,
        }
    } catch (error) {
        logger.error({ err: error }, 'Failed to validate retrieval')

        // Fallback to score-based validation
        const averageRelevance = results.reduce((sum, r) => sum + r.relevance_score, 0) / results.length

        return {
            scores: results.map((r, i) => ({
                index: i,
                relevance: r.relevance_score > 0.7 ? '관련' : r.relevance_score > 0.3 ? '부분 관련' : '무관',
            })),
            sufficient: averageRelevance >= threshold,
            averageRelevance,
            needsRetry: averageRelevance < threshold,
        }
    }
}

/**
 * Get retry strategy based on validation result
 */
export function getRetryStrategy(validation: RetrievalValidation): {
    retry: boolean
    strategy?: 'hyde' | 'multi_query' | 'broader_search'
    reason?: string
} {
    if (!validation.needsRetry) {
        return { retry: false }
    }

    if (validation.suggestedStrategy) {
        return {
            retry: true,
            strategy: validation.suggestedStrategy,
            reason: 'LLM suggested strategy based on content analysis',
        }
    }

    if (validation.averageRelevance < 0.3) {
        return {
            retry: true,
            strategy: 'broader_search',
            reason: 'Very low relevance - need broader search',
        }
    }

    return {
        retry: true,
        strategy: 'hyde',
        reason: 'Moderate relevance - try HyDE for better query understanding',
    }
}

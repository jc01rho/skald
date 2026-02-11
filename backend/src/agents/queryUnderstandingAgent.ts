import { LLMService } from '@/services/llmService'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/node'

export type QueryIntent =
    | 'factual_question' // 사실적 질문: "What is X?"
    | 'troubleshooting' // 문제 해결: "How do I fix X?"
    | 'similar_issue_search' // 유사 이슈 검색: "Find similar issues"
    | 'procedural' // 절차적: "How to do X?"
    | 'comparison' // 비교: "Difference between X and Y?"
    | 'general_search' // 일반 검색

export interface QueryUnderstanding {
    intent: QueryIntent
    entities: Array<{ type: string; value: string }>
    query_type: 'specific' | 'broad' | 'ambiguous'
    jira_specific: boolean
    suggested_filters: Array<{ field: string; operator: string; value: any }>
}

const QueryUnderstandingSchema = z.object({
    intent: z.enum([
        'factual_question',
        'troubleshooting',
        'similar_issue_search',
        'procedural',
        'comparison',
        'general_search',
    ]),
    entities: z.array(
        z.object({
            type: z.string(),
            value: z.string(),
        })
    ),
    query_type: z.enum(['specific', 'broad', 'ambiguous']),
    jira_specific: z.boolean(),
    suggested_filters: z.array(
        z.object({
            field: z.string(),
            operator: z.string(),
            value: z.any(),
        })
    ),
})

const QUERY_UNDERSTANDING_PROMPT = `당신은 쿼리 이해 전문가입니다.

작업:
사용자의 쿼리를 분석하여 의도, 엔티티, 쿼리 타입을 식별하십시오.

쿼리 의도 (intent):
- factual_question: 사실적 질문 ("X는 무엇인가요?", "Y의 기능은?")
- troubleshooting: 문제 해결 ("X 오류가 발생합니다", "Y를 고치는 방법")
- similar_issue_search: 유사 이슈 검색 ("비슷한 이슈 찾기", "관련 티켓")
- procedural: 절차적 ("X를 하는 방법", "Y 설치 절차")
- comparison: 비교 ("X와 Y의 차이", "A vs B")
- general_search: 일반 검색

엔티티 추출:
- 기술 용어, 컴포넌트, 에러 메시지, 버전 번호 등

쿼리 타입:
- specific: 구체적 ("API v2에서 인증이 실패합니다")
- broad: 넓은 범위 ("인증 관련 문서")
- ambiguous: 모호함 ("로그인 문제")

Jira 특정:
- jira_key, status, priority, assignee 등 Jira 용어 포함 여부

제안 필터:
- Jira 메타데이터 기반 필터 제안

쿼리: {query}

JSON 형식으로 응답하십시오.`

export interface SearchStrategy {
    queryRewrite: boolean
    multiQuery: boolean
    hyde: boolean
    jiraHyde: boolean
    topK: number
    rerank: boolean
    mmr: boolean
    filters: Array<{ field: string; operator: string; value: any }>
}

export class QueryUnderstandingAgent {
    /**
     * Analyze user query to understand intent, entities, and suggest optimal search strategy
     */
    static async understandQuery(query: string, context: string = ''): Promise<QueryUnderstanding> {
        try {
            const prompt = context
                ? `${QUERY_UNDERSTANDING_PROMPT}\n\n컨텍스트:\n${context}`
                : QUERY_UNDERSTANDING_PROMPT

            const response = await LLMService.invokeWithRetry({
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: query },
                ],
                temperature: 0.1,
            })

            const responseText = response.content?.toString().trim() || ''
            const cleanedJson = responseText
                .replace(/^```json?\n?/i, '')
                .replace(/\n?```$/i, '')
                .trim()
            const parsed = JSON.parse(cleanedJson)
            const result = QueryUnderstandingSchema.parse(parsed)

            return result as unknown as QueryUnderstanding
        } catch (error) {
            logger.error({ err: error, query }, 'Error understanding query')
            Sentry.captureException(error, {
                tags: { service: 'query_understanding' },
                extra: { query, context },
            })

            // Return safe default
            return {
                intent: 'general_search',
                entities: [],
                query_type: 'ambiguous',
                jira_specific: false,
                suggested_filters: [],
            }
        }
    }

    /**
     * Get optimal search strategy based on query understanding
     */
    static getSearchStrategy(understanding: QueryUnderstanding): SearchStrategy {
        const strategy: SearchStrategy = {
            queryRewrite: true,
            multiQuery: false,
            hyde: false,
            jiraHyde: false,
            topK: 10,
            rerank: true,
            mmr: false,
            filters: understanding.suggested_filters,
        }

        switch (understanding.intent) {
            case 'troubleshooting':
                strategy.multiQuery = true
                strategy.hyde = true
                strategy.topK = 15
                strategy.mmr = true
                break

            case 'similar_issue_search':
                strategy.multiQuery = true
                strategy.jiraHyde = true // Use Jira-specific HyDE
                strategy.topK = 20
                strategy.rerank = true
                strategy.mmr = true
                break

            case 'factual_question':
                strategy.multiQuery = false
                strategy.topK = 5
                strategy.mmr = false
                break

            case 'procedural':
                strategy.multiQuery = true
                strategy.topK = 10
                strategy.mmr = false
                break

            case 'comparison':
                strategy.multiQuery = true
                strategy.topK = 15
                strategy.mmr = true
                break

            default:
                // general_search: use default strategy
                break
        }

        // Adjust for query type
        if (understanding.query_type === 'broad') {
            strategy.topK = Math.min(strategy.topK * 1.5, 30)
            strategy.multiQuery = true
        } else if (understanding.query_type === 'specific') {
            strategy.topK = Math.max(strategy.topK - 2, 5)
            strategy.multiQuery = false
        }

        return strategy
    }
}

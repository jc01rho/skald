import { QueryUnderstanding, QueryIntent } from './queryUnderstandingAgent'
import { logger } from '../lib/logger'

export interface AdaptiveStrategy {
    pipeline: 'simple' | 'multi_step' | 'decompose' | 'iterative'
    retrieval: 'vector' | 'hybrid' | 'multi_query' | 'hyde'
    synthesis: 'direct' | 'chain_of_thought' | 'tree_of_thought'
    multiQuery?: boolean
    hyde?: boolean
    topK?: number
}

interface ComplexityIndicators {
    wordCount: number
    questionCount: number
    hasComplexKeywords: boolean
    hasMultipleEntities: boolean
}

/**
 * Analyze query complexity based on multiple factors
 */
function analyzeComplexity(query: string, understanding: QueryUnderstanding): 'simple' | 'moderate' | 'complex' {
    const indicators = extractComplexityIndicators(query, understanding)

    let complexityScore = 0
    if (indicators.wordCount > 15) complexityScore += 1
    if (indicators.wordCount > 30) complexityScore += 1
    if (indicators.questionCount > 1) complexityScore += 1
    if (indicators.hasComplexKeywords) complexityScore += 1
    if (indicators.hasMultipleEntities) complexityScore += 1
    if (understanding.query_type === 'broad') complexityScore += 1
    if (understanding.query_type === 'ambiguous') complexityScore += 1

    if (complexityScore >= 3) return 'complex'
    if (complexityScore >= 1) return 'moderate'
    return 'simple'
}

function extractComplexityIndicators(query: string, understanding: QueryUnderstanding): ComplexityIndicators {
    const wordCount = query.split(/\s+/).length
    const questionCount = (query.match(/\?/g) || []).length

    const complexKeywords = [
        // English
        'compare',
        'difference',
        'vs',
        'versus',
        'analyze',
        'evaluate',
        'contrast',
        'advantages',
        'disadvantages',
        'trade-off',
        'tradeoff',
        // Korean (한국어 복잡도 지표)
        '비교',
        '차이',
        '분석',
        '평가',
        '장단점',
        '트레이드오프',
        '어떻게',
        '왜',
        '단계',
        '방법',
        '원리',
        '이유',
    ]

    const hasComplexKeywords = complexKeywords.some((kw) => query.toLowerCase().includes(kw))

    const hasMultipleEntities = understanding.entities.length > 2

    return {
        wordCount,
        questionCount,
        hasComplexKeywords,
        hasMultipleEntities,
    }
}

/**
 * Route query to appropriate strategy based on understanding and complexity
 */
export function routeQuery(query: string, understanding: QueryUnderstanding): AdaptiveStrategy {
    const complexity = analyzeComplexity(query, understanding)

    logger.debug({ complexity, intent: understanding.intent }, 'Routing query')

    // Intent-based routing
    switch (understanding.intent) {
        case 'factual_question':
            return {
                pipeline: 'simple',
                retrieval: 'hybrid',
                synthesis: 'direct',
                topK: 5,
            }

        case 'troubleshooting':
            return {
                pipeline: complexity === 'complex' ? 'multi_step' : 'simple',
                retrieval: 'hyde',
                synthesis: 'chain_of_thought',
                hyde: true,
                topK: 15,
            }

        case 'similar_issue_search':
            return {
                pipeline: 'multi_step',
                retrieval: 'multi_query',
                synthesis: 'direct',
                multiQuery: true,
                topK: 20,
            }

        case 'comparison':
            return {
                pipeline: 'decompose',
                retrieval: 'multi_query',
                synthesis: 'chain_of_thought',
                multiQuery: true,
                topK: 15,
            }

        case 'procedural':
            return {
                pipeline: complexity === 'complex' ? 'multi_step' : 'simple',
                retrieval: 'hybrid',
                synthesis: 'direct',
                topK: 10,
            }

        default:
            // Complexity-based fallback
            return getComplexityBasedStrategy(complexity)
    }
}

function getComplexityBasedStrategy(complexity: string): AdaptiveStrategy {
    switch (complexity) {
        case 'simple':
            return {
                pipeline: 'simple',
                retrieval: 'hybrid',
                synthesis: 'direct',
                topK: 5,
            }
        case 'moderate':
            return {
                pipeline: 'multi_step',
                retrieval: 'hybrid',
                synthesis: 'direct',
                topK: 10,
            }
        case 'complex':
            return {
                pipeline: 'iterative',
                retrieval: 'hyde',
                synthesis: 'chain_of_thought',
                hyde: true,
                topK: 20,
            }
        default:
            return {
                pipeline: 'simple',
                retrieval: 'hybrid',
                synthesis: 'direct',
                topK: 10,
            }
    }
}

/**
 * Adjust strategy based on query type
 */
export function adjustStrategyForQueryType(
    strategy: AdaptiveStrategy,
    queryType: 'specific' | 'broad' | 'ambiguous'
): AdaptiveStrategy {
    const adjusted = { ...strategy }

    if (queryType === 'broad') {
        adjusted.topK = Math.min((adjusted.topK || 10) * 1.5, 30)
        adjusted.multiQuery = true
    } else if (queryType === 'specific') {
        adjusted.topK = Math.max((adjusted.topK || 10) - 2, 5)
        adjusted.multiQuery = false
    } else if (queryType === 'ambiguous') {
        adjusted.pipeline = 'iterative'
        adjusted.hyde = true
    }

    return adjusted
}

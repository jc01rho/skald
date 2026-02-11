import { logger } from '@/lib/logger'
import { containsCJK } from '@/lib/languageDetector'

export interface ComplexityResult {
    score: number
    lengthScore: number
    depthScore: number
    multiIntentScore: number
    requiresSelfRag: boolean
    details: {
        queryLength: number
        depthIndicatorsFound: number
        multiIntentIndicatorsFound: number
    }
}

export class ComplexityCalculator {
    private static readonly THRESHOLD = 0.7
    private static readonly LENGTH_WEIGHT = 0.3
    private static readonly DEPTH_WEIGHT = 0.4
    private static readonly MULTI_INTENT_WEIGHT = 0.3

    private static readonly DEPTH_INDICATORS_KO = [
        '어떻게',
        '왜',
        '차이',
        '비교',
        '단계',
        '방법',
        '원리',
        '이유',
        '분석',
        '평가',
        '장단점',
        '트레이드오프',
    ]

    private static readonly DEPTH_INDICATORS_EN = [
        'how',
        'why',
        'difference',
        'compare',
        'versus',
        'vs',
        'analyze',
        'evaluate',
        'trade-off',
        'tradeoff',
        'advantages',
        'disadvantages',
        'step',
    ]

    private static readonly MULTI_INTENT_INDICATORS_KO = ['그리고', '또는', '그런데', '아니면', '그다음', '추가로']

    private static readonly MULTI_INTENT_INDICATORS_EN = [
        'and also',
        'additionally',
        'furthermore',
        'moreover',
        'as well as',
        'on the other hand',
    ]

    static calculate(query: string): ComplexityResult {
        const isCJK = containsCJK(query)
        const lowerQuery = query.toLowerCase()

        const lengthDivisor = isCJK ? 50 : 100
        const lengthScore = Math.min(query.length / lengthDivisor, 1.0) * this.LENGTH_WEIGHT

        const depthIndicators = isCJK ? this.DEPTH_INDICATORS_KO : this.DEPTH_INDICATORS_EN
        const depthCount = depthIndicators.filter((w) => lowerQuery.includes(w.toLowerCase())).length
        const depthScore = Math.min(depthCount / 3, 1.0) * this.DEPTH_WEIGHT

        const multiIntentIndicators = isCJK ? this.MULTI_INTENT_INDICATORS_KO : this.MULTI_INTENT_INDICATORS_EN
        const multiCount = multiIntentIndicators.filter((w) => lowerQuery.includes(w.toLowerCase())).length
        const multiIntentScore = Math.min(multiCount / 2, 1.0) * this.MULTI_INTENT_WEIGHT

        const score = lengthScore + depthScore + multiIntentScore

        const result: ComplexityResult = {
            score,
            lengthScore,
            depthScore,
            multiIntentScore,
            requiresSelfRag: score >= this.THRESHOLD,
            details: {
                queryLength: query.length,
                depthIndicatorsFound: depthCount,
                multiIntentIndicatorsFound: multiCount,
            },
        }

        logger.debug(
            {
                score: result.score,
                threshold: this.THRESHOLD,
                requiresSelfRag: result.requiresSelfRag,
                isCJK,
            },
            'Complexity calculated'
        )

        return result
    }
}

import { expandTechnicalQueryVariants, normalizeTechnicalAliases } from '../lib/queryNormalization'
import { shouldInjectLowConfidenceGuidance } from '../agents/chatAgent/ragGraph'

describe('queryNormalization', () => {
    it('normalizes Korean metric aliases to metric', () => {
        expect(normalizeTechnicalAliases('sast 레거시에서 매트릭 을 켜는 옵션')).toContain('metric')
    })

    it('expands metric/property variants for legacy SAST queries', () => {
        const variants = expandTechnicalQueryVariants('sast 레거시에서 매트릭 을 켜는 옵션을 알려줘')

        expect(variants).toEqual(
            expect.arrayContaining([
                'sast 레거시에서 매트릭 을 켜는 옵션을 알려줘',
                'sast 레거시에서 metric 을 켜는 옵션을 알려줘',
                'sast 레거시에서 metric 을 켜는 옵션을 알려줘 sparrow.properties',
                'sast 레거시에서 metric 을 켜는 옵션을 알려줘 property sparrow.properties',
                'sast 레거시에서 metric 을 켜는 옵션을 알려줘 legacy sparrow.properties option property',
                'sast 레거시에서 metric 을 켜는 옵션을 알려줘 legacy metric enable option sparrow.properties',
            ])
        )
    })

    it('adds option and sparrow.properties variants for metric/property lookups', () => {
        const variants = expandTechnicalQueryVariants('sast metric 관련 옵션이나 property 를 찾아줘')

        expect(variants).toEqual(
            expect.arrayContaining([
                'sast metric 관련 옵션이나 property 를 찾아줘',
                'sast metric 관련 옵션이나 property 를 찾아줘 sparrow.properties',
                'sast metric 관련 옵션이나 property 를 찾아줘 메트릭 property 설정',
            ])
        )
    })

    it('expands Korean feature-definition queries with explanation-oriented variants', () => {
        const variants = expandTechnicalQueryVariants('이행 진단이라는 기능이 뭐야?')

        expect(variants).toEqual(
            expect.arrayContaining([
                '이행 진단이라는 기능이 뭐야?',
                '이행 진단 기능 정의 개요 목적 동작 방식',
                '이행 진단 기능 설명 사용 방법',
                '이행 진단 정의',
            ])
        )
    })

    it('adds enterprise error code alias variants for natural-language queries', () => {
        const variants = expandTechnicalQueryVariants('엔터프라이즈 에러코드 알려줘')

        expect(variants).toEqual(
            expect.arrayContaining([
                'enterprise error codes',
                'sparrow enterprise error codes',
                'sparrow enterprise backend error codes',
                'sparrow-enterprise-backend-error-codes',
                '엔터프라이즈 에러코드 알려줘 sparrow-enterprise-backend-error-codes',
            ])
        )
    })

    it('adds numeric enterprise error code variants for numeric error code queries', () => {
        const variants = expandTechnicalQueryVariants('엔터프라이즈 에러코드 27000 에 대해 모두 알려줘')

        expect(variants).toEqual(
            expect.arrayContaining([
                '27000',
                '"27000"',
                'enterprise error code 27000',
                'sparrow enterprise error code 27000',
                'backend error code 27000',
                '엔터프라이즈 에러코드 27000',
            ])
        )
    })

    it('adds legacy sast error code variants for numeric error code queries', () => {
        const variants = expandTechnicalQueryVariants('레거시 sast 오류코드 450002 에 대해 모두 알려줘')

        expect(variants).toEqual(
            expect.arrayContaining([
                'sast error codes',
                'sparrow sast error codes',
                'sparrow-sast error codes',
                'legacy sast error codes',
                '레거시 sast 오류코드',
                '450002',
                '"450002"',
                'sast error code 450002',
                'legacy sast error code 450002',
                '레거시 sast 오류코드 450002',
            ])
        )
    })

    it('adds comparison variants for enterprise information comparison queries', () => {
        const variants = expandTechnicalQueryVariants('전수분석과 수시분석의 차이를 설명해줘')

        expect(variants).toEqual(
            expect.arrayContaining([
                '전수분석 수시분석 차이 비교',
                '전수분석 수시분석 기능 설명',
                '전수분석 수시분석 개요 차이점',
                '전수분석 수시분석 information 비교',
            ])
        )
    })

    it('suppresses low-confidence guidance when exact lookup already hit', () => {
        const shouldInject = shouldInjectLowConfidenceGuidance({
            lookupHit: true,
            rerankedResults: [],
            confidenceThreshold: 0.35,
        })

        expect(shouldInject).toBe(false)
    })

    it('still injects low-confidence guidance for weak non-exact retrieval', () => {
        const shouldInject = shouldInjectLowConfidenceGuidance({
            lookupHit: false,
            rerankedResults: [{ index: 0, document: 'weak', relevance_score: 0.2 }],
            confidenceThreshold: 0.35,
        })

        expect(shouldInject).toBe(true)
    })

    it('suppresses low-confidence guidance when strong literal anchor evidence exists', () => {
        const shouldInject = shouldInjectLowConfidenceGuidance({
            lookupHit: false,
            rerankedResults: [{ index: 0, document: '오류 코드 450002', relevance_score: 0.05 }],
            confidenceThreshold: 0.35,
            hasStrongLiteralAnchorEvidence: true,
        })

        expect(shouldInject).toBe(false)
    })
})

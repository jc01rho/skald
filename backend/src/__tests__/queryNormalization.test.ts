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
})

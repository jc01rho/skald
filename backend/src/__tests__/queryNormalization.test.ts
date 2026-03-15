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
                'sast 레거시에서 metric 을 켜는 옵션을 알려줘 property sparrow.properties',
                'sast 레거시에서 metric 을 켜는 옵션을 알려줘 legacy sparrow.properties option property',
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

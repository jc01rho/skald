import { resolveHybridSearchTuningProfile } from '../embeddings/hybridSearch'

describe('HybridSearch tuning profile', () => {
    it('biases lexical weight for short Korean definition queries', () => {
        const profile = resolveHybridSearchTuningProfile('이행 진단이라는 기능이 뭐야?', {
            similarityThreshold: 0.4,
        })

        expect(profile.isCJK).toBe(true)
        expect(profile.isShortDefinitionQuery).toBe(true)
        expect(profile.vectorWeight).toBe(0.35)
        expect(profile.bm25Weight).toBe(0.65)
        expect(profile.similarityThreshold).toBeCloseTo(0.35)
    })

    it('slightly relaxes threshold for comparison queries', () => {
        const profile = resolveHybridSearchTuningProfile('전수분석과 수시분석의 차이 비교', {
            similarityThreshold: 0.4,
        })

        expect(profile.isCJK).toBe(true)
        expect(profile.isShortDefinitionQuery).toBe(false)
        expect(profile.vectorWeight).toBe(0.5)
        expect(profile.bm25Weight).toBe(0.5)
        expect(profile.similarityThreshold).toBeCloseTo(0.35)
    })

    it('keeps balanced CJK defaults for non-definition Korean queries', () => {
        const profile = resolveHybridSearchTuningProfile('서울시에서 열리는 행사 일정 알려줘', {
            similarityThreshold: 0.4,
        })

        expect(profile.isCJK).toBe(true)
        expect(profile.isShortDefinitionQuery).toBe(false)
        expect(profile.vectorWeight).toBe(0.5)
        expect(profile.bm25Weight).toBe(0.5)
        expect(profile.similarityThreshold).toBe(0.4)
    })

    it('keeps lexical-heavy tuning for short enterprise error-code queries', () => {
        const profile = resolveHybridSearchTuningProfile('엔터프라이즈 에러코드', {
            similarityThreshold: 0.4,
        })

        expect(profile.isCJK).toBe(true)
        expect(profile.vectorWeight).toBe(0.5)
        expect(profile.bm25Weight).toBe(0.5)
        expect(profile.similarityThreshold).toBe(0.4)
    })
})

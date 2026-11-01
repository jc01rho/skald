import { resolveHybridSearchTuningProfile } from '../embeddings/hybridSearch'

describe('HybridSearch tuning profile', () => {
    it('disables the lexical arm for pure-Korean definition queries', () => {
        const profile = resolveHybridSearchTuningProfile('이행 진단이라는 기능이 뭐야?', {
            similarityThreshold: 0.4,
        })

        expect(profile.isCJK).toBe(true)
        expect(profile.isPureCjkQuery).toBe(true)
        expect(profile.isShortDefinitionQuery).toBe(true)
        expect(profile.vectorWeight).toBe(1)
        expect(profile.bm25Weight).toBe(0)
        expect(profile.similarityThreshold).toBeCloseTo(0.35)
    })

    it('disables the lexical arm for pure-Korean comparison queries', () => {
        const profile = resolveHybridSearchTuningProfile('전수분석과 수시분석의 차이 비교', {
            similarityThreshold: 0.4,
        })

        expect(profile.isCJK).toBe(true)
        expect(profile.isPureCjkQuery).toBe(true)
        expect(profile.isShortDefinitionQuery).toBe(false)
        expect(profile.vectorWeight).toBe(1)
        expect(profile.bm25Weight).toBe(0)
        expect(profile.similarityThreshold).toBeCloseTo(0.35)
    })

    it('disables the lexical arm for ordinary pure-Korean queries', () => {
        const profile = resolveHybridSearchTuningProfile('서울시에서 열리는 행사 일정 알려줘', {
            similarityThreshold: 0.4,
        })

        expect(profile.isCJK).toBe(true)
        expect(profile.isPureCjkQuery).toBe(true)
        expect(profile.vectorWeight).toBe(1)
        expect(profile.bm25Weight).toBe(0)
        expect(profile.similarityThreshold).toBe(0.4)
    })

    it('keeps the lexical arm for Korean queries that carry a Latin or digit token', () => {
        const profile = resolveHybridSearchTuningProfile('sparrow.properties 메트릭 설정 방법', {
            similarityThreshold: 0.4,
        })

        expect(profile.isCJK).toBe(true)
        expect(profile.isPureCjkQuery).toBe(false)
        expect(profile.vectorWeight).toBe(0.5)
        expect(profile.bm25Weight).toBe(0.5)
    })

    it('keeps balanced defaults for pure-Korean enterprise error-code queries', () => {
        const profile = resolveHybridSearchTuningProfile('엔터프라이즈 에러코드', {
            similarityThreshold: 0.4,
        })

        expect(profile.isCJK).toBe(true)
        expect(profile.vectorWeight).toBe(1)
        expect(profile.bm25Weight).toBe(0)
        expect(profile.similarityThreshold).toBe(0.4)
    })

    it('keeps the lexical arm for non-CJK queries', () => {
        const profile = resolveHybridSearchTuningProfile('how does rerank work', {
            similarityThreshold: 0.4,
        })

        expect(profile.isCJK).toBe(false)
        expect(profile.isPureCjkQuery).toBe(false)
        expect(profile.vectorWeight).toBe(0.7)
        expect(profile.bm25Weight).toBe(0.3)
    })

    it('honours explicit weights over the derived profile', () => {
        const profile = resolveHybridSearchTuningProfile('서울시에서 열리는 행사 일정 알려줘', {
            vectorWeight: 0.4,
            bm25Weight: 0.6,
        })

        expect(profile.vectorWeight).toBe(0.4)
        expect(profile.bm25Weight).toBe(0.6)
    })
})

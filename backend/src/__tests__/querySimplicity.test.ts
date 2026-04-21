import {
    classifyQuerySimplicity,
    FAST_RETRIEVAL_PROFILES,
    QuerySimplicity,
    FastRetrievalProfile,
} from '@/lib/complexityCalculator'

// Mock languageDetector so CJK detection is deterministic
jest.mock('@/lib/languageDetector', () => ({
    containsCJK: (q: string) => /[가-힣]/.test(q),
}))

// Suppress logger noise in tests
jest.mock('@/lib/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

describe('classifyQuerySimplicity', () => {
    it('returns "simple" for a short, shallow English query', () => {
        expect(classifyQuerySimplicity('what is RAG')).toBe('simple')
    })

    it('returns "simple" for a short Korean query without depth indicators', () => {
        expect(classifyQuerySimplicity('RAG이 뭐야')).toBe('simple')
    })

    it('returns "moderate" for a medium-length English query with some depth', () => {
        // "how does RAG compare to fine-tuning" → depth indicator "how", "compare" → depthCount=2
        // length ~38 → lengthScore = 38/100 * 0.3 = 0.114
        // depthScore = min(2/3,1) * 0.4 = 0.267
        // total ~0.38 → moderate
        expect(classifyQuerySimplicity('how does RAG compare to fine-tuning')).toBe('moderate')
    })

    it('returns "moderate" for a Korean query with a single depth indicator', () => {
        // "RAG 프로젝트에서 검색 증강 생성 방법과 원리에 대해 설명해줘"
        // depth: "방법", "원리" → depthCount=2, length=37 → lengthScore=37/50*0.3=0.222
        // depthScore=min(2/3,1)*0.4=0.267, total~0.49 → moderate
        expect(classifyQuerySimplicity('RAG 프로젝트에서 검색 증강 생성 방법과 원리에 대해 설명해줘')).toBe('moderate')
    })

    it('returns "complex" for multi-intent English query (≥2 multi-intent indicators)', () => {
        // "explain RAG and also compare it to fine-tuning additionally cover edge cases"
        // multi-intent: "and also", "additionally" → 2 indicators → immediate complex
        expect(
            classifyQuerySimplicity('explain RAG and also compare it to fine-tuning additionally cover edge cases')
        ).toBe('complex')
    })

    it('returns "complex" for multi-intent Korean query (≥2 multi-intent indicators)', () => {
        // "RAG 설명 그리고 파인튜닝 차이도 알려줘 또는 다른 방법도"
        // multi-intent: "그리고", "또는" → 2 indicators → complex
        expect(classifyQuerySimplicity('RAG 설명 그리고 파인튜닝 차이도 알려줘 또는 다른 방법도')).toBe('complex')
    })

    it('returns "complex" for a very long English query with depth', () => {
        // Long query with many depth indicators → score > 0.6
        const longQuery =
            'how to analyze the differences between RAG and fine-tuning, evaluate trade-off and advantages step by step'
        expect(classifyQuerySimplicity(longQuery)).toBe('complex')
    })

    it('returns "simple" for an empty string', () => {
        expect(classifyQuerySimplicity('')).toBe('simple')
    })

    it('classifies single-word query as simple', () => {
        expect(classifyQuerySimplicity('RAG')).toBe('simple')
    })
})

describe('FAST_RETRIEVAL_PROFILES', () => {
    it('has entries for all three simplicity levels', () => {
        const keys = Object.keys(FAST_RETRIEVAL_PROFILES) as QuerySimplicity[]
        expect(keys).toContain('simple')
        expect(keys).toContain('moderate')
        expect(keys).toContain('complex')
        expect(keys).toHaveLength(3)
    })

    it('simple profile is the lightest Stage A profile', () => {
        const p: FastRetrievalProfile = FAST_RETRIEVAL_PROFILES.simple
        expect(p.topK).toBe(3)
        expect(p.maxPreviewChars).toBeLessThan(FAST_RETRIEVAL_PROFILES.moderate.maxPreviewChars)
        expect(p.similarityThreshold).toBeGreaterThan(FAST_RETRIEVAL_PROFILES.complex.similarityThreshold)
    })

    it('complex profile uses the widest Stage A profile', () => {
        const p: FastRetrievalProfile = FAST_RETRIEVAL_PROFILES.complex
        expect(p.topK).toBeGreaterThan(FAST_RETRIEVAL_PROFILES.moderate.topK)
        expect(p.maxPreviewChars).toBeGreaterThan(FAST_RETRIEVAL_PROFILES.simple.maxPreviewChars)
    })

    it('moderate profile stays between simple and complex', () => {
        const m = FAST_RETRIEVAL_PROFILES.moderate
        const s = FAST_RETRIEVAL_PROFILES.simple
        const c = FAST_RETRIEVAL_PROFILES.complex
        expect(m.topK).toBeGreaterThanOrEqual(s.topK)
        expect(m.topK).toBeLessThanOrEqual(c.topK)
        expect(m.maxPreviewChars).toBeGreaterThanOrEqual(s.maxPreviewChars)
        expect(m.maxPreviewChars).toBeLessThanOrEqual(c.maxPreviewChars)
    })
})

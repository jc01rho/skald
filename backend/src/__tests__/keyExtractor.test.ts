import { extractExplicitKeys, getPrimaryKey, hasExplicitKeys } from '../lib/keyExtractor'

describe('keyExtractor error code support', () => {
    it('extracts numeric error codes when the query explicitly asks for an error code', () => {
        expect(extractExplicitKeys('엔터프라이즈 에러코드 27000 에 대해 모두 알려줘')).toEqual([
            {
                type: 'error_code',
                value: '27000',
                original: '27000',
                confidence: 0.92,
            },
        ])

        expect(extractExplicitKeys('레거시 sast 오류코드 450002 원인 알려줘')).toEqual([
            {
                type: 'error_code',
                value: '450002',
                original: '450002',
                confidence: 0.92,
            },
        ])
    })

    it('does not treat arbitrary numbers as explicit keys without an error-code cue', () => {
        expect(extractExplicitKeys('작업 27000 진행 상황 알려줘')).toEqual([])
        expect(hasExplicitKeys('작업 27000 진행 상황 알려줘')).toBe(false)
    })

    it('exposes error code as the primary exact-lookup key', () => {
        expect(getPrimaryKey('엔터프라이즈 에러코드 27000 에 대해 모두 알려줘')).toEqual({
            type: 'error_code',
            value: '27000',
            original: '27000',
            confidence: 0.92,
        })
    })
})

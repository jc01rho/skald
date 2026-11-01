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

describe('keyExtractor multi-segment issue keys', () => {
    it('keeps every numeric segment instead of truncating SFR-006-02 to SFR-006', () => {
        expect(extractExplicitKeys('SFR-006-02 스펙 내용 알려줘')).toEqual([
            {
                type: 'jira_key',
                value: 'SFR-006-02',
                original: 'SFR-006-02',
                confidence: 1.0,
            },
        ])
    })

    it('still extracts single-segment keys such as SPARROW-1234', () => {
        expect(extractExplicitKeys('SPARROW-1234 이슈 내용 알려줘')).toEqual([
            {
                type: 'jira_key',
                value: 'SPARROW-1234',
                original: 'SPARROW-1234',
                confidence: 1.0,
            },
        ])
    })

    it('extracts the full multi-segment key from a Jira browse URL', () => {
        expect(getPrimaryKey('https://jira.example.com/browse/SFR-006-02 내용 알려줘')).toEqual({
            type: 'jira_key',
            value: 'SFR-006-02',
            original: 'SFR-006-02',
            confidence: 1.0,
        })
    })
})

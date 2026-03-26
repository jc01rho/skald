import { buildIdentifierFallbackQueries } from '../agents/chatAgent/ragGraph'

describe('ragGraph identifier fallback queries', () => {
    it('adds lexicalized fallback variants for enterprise error code questions', () => {
        const variants = buildIdentifierFallbackQueries('엔터프라이즈 에러코드 20210에 대해 알려줘')

        expect(variants).toEqual(
            expect.arrayContaining([
                '20210',
                'error code 20210',
                'enterprise error code 20210',
                'backend error codes 20210',
                'sparrow enterprise backend error codes 20210',
                'sparrow-enterprise-backend-error-codes 20210',
                '에러코드 20210',
                '엔터프라이즈 에러코드 20210',
            ])
        )
    })

    it('expands explicit exception identifiers without forcing exact lookup mapping', () => {
        const variants = buildIdentifierFallbackQueries('exception.20210 문서를 찾아줘')

        expect(variants).toEqual(
            expect.arrayContaining(['20210', 'error code 20210', 'sparrow enterprise backend error codes 20210'])
        )
        expect(variants).not.toContain('exception.20210')
    })

    it('does not treat unrelated numeric queries as identifier fallback candidates', () => {
        expect(buildIdentifierFallbackQueries('엔터프라이즈 버전 20210은 언제 배포돼?')).toEqual([])
    })

    it('does not expand plain incident/date-like numeric queries without error-code context', () => {
        expect(buildIdentifierFallbackQueries('260301에 발생한 장애 유형을 알려줘')).toEqual([])
    })
})

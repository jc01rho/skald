import { buildIdentifierFallbackQueries } from '../agents/chatAgent/ragGraph'

describe('ragGraph identifier fallback queries', () => {
    it('does not add enterprise error-code specific fallback for natural-language code questions', () => {
        expect(buildIdentifierFallbackQueries('엔터프라이즈 에러코드 20210에 대해 알려줘')).toEqual([])
    })

    it('does not add exception identifier specific fallback queries', () => {
        expect(buildIdentifierFallbackQueries('exception.20210 문서를 찾아줘')).toEqual([])
    })

    it('does not treat unrelated numeric queries as identifier fallback candidates', () => {
        expect(buildIdentifierFallbackQueries('엔터프라이즈 버전 20210은 언제 배포돼?')).toEqual([])
    })

    it('does not expand plain incident/date-like numeric queries without error-code context', () => {
        expect(buildIdentifierFallbackQueries('260301에 발생한 장애 유형을 알려줘')).toEqual([])
    })
})

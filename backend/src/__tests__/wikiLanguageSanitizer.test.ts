import {
    containsUnexpectedHanScript,
    hasKnownWikiLanguageContamination,
    sanitizeGeneratedWikiKoreanText,
    sanitizeWikiCompileOutput,
} from '../services/wiki/wikiLanguageSanitizer'

describe('wikiLanguageSanitizer', () => {
    it('replaces known Chinese wiki terms with Korean equivalents', () => {
        const sanitized = sanitizeGeneratedWikiKoreanText(
            '스패로우 내부 위키의 주요 섹션별导航 가이드. 产品开发计划과 规格 문서를 안내한다. 로그인 필요 안내가 に表示된다.'
        )

        expect(sanitized).toBe(
            '스패로우 내부 위키의 주요 섹션별 안내 가이드. 제품 개발 계획과 명세 문서를 안내한다. 로그인 필요 안내가 에 표시된다.'
        )
        expect(hasKnownWikiLanguageContamination(sanitized)).toBe(false)
    })

    it('preserves legitimate CJK proper nouns that are not known contamination patterns', () => {
        const text = '東京 리전 장애 대응 절차와 漢字 표기 정책을 유지한다.'

        expect(sanitizeGeneratedWikiKoreanText(text)).toBe(text)
        expect(containsUnexpectedHanScript(text)).toBe(true)
        expect(hasKnownWikiLanguageContamination(text)).toBe(false)
    })

    it('sanitizes generated wiki output before persistence', () => {
        const output = sanitizeWikiCompileOutput({
            pages: [
                {
                    slug: 'index-sparrow-wiki',
                    title: '스패로우 위키导航',
                    pageType: 'index_page',
                    summary: '주요 섹션별导航 가이드',
                    bodyMarkdown: '# Wiki\n\n产品开发 계획을 안내한다.',
                    canonical: '스패로우导航',
                    confidence: 0.9,
                    freshness: 0.8,
                    reviewStatus: 'draft',
                    sourceCoverageScore: 0.7,
                    relatedPageSlugs: [],
                    claims: [
                        {
                            claimText: '内部文档 접근 방법을 설명한다.',
                            claimType: 'summary',
                            nodeCanonicalName: '제품导航',
                        },
                    ],
                    nodes: [
                        {
                            nodeType: 'topic',
                            canonicalName: '제품导航',
                            displayName: '产品导航',
                            description: '产品 자료入口',
                        },
                    ],
                    edges: [
                        {
                            fromCanonicalName: '제품导航',
                            toCanonicalName: '스패로우导航',
                            edgeType: 'relates_to',
                        },
                    ],
                },
            ],
            notes: ['需要 검토'],
        })

        const page = output.pages[0]
        const joined = JSON.stringify(output)

        expect(page.title).toBe('스패로우 위키안내')
        expect(page.summary).toBe('주요 섹션별 안내 가이드')
        expect(page.claims?.[0]?.nodeCanonicalName).toBe('제품안내')
        expect(page.edges?.[0]?.fromCanonicalName).toBe('제품안내')
        expect(hasKnownWikiLanguageContamination(joined)).toBe(false)
    })
})

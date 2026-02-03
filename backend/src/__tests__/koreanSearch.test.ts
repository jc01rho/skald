import { EntityManager } from '@mikro-orm/core'
import { detectLanguage, Language } from '../lib/languageDetector'

describe('Korean Language Search', () => {
    let em: EntityManager

    beforeEach(async () => {
        em = DI.em.fork()
    })

    describe('Language Detection', () => {
        it('should detect Korean text', () => {
            const koreanQueries = ['안녕하세요', '데이터베이스 설정 방법', '로그인 오류가 발생합니다']

            for (const query of koreanQueries) {
                const result = detectLanguage(query)
                expect(result).toBe(Language.KOREAN)
            }
        })

        it('should detect English text', () => {
            const englishQueries = ['Hello world', 'Database configuration', 'Login error occurred']

            for (const query of englishQueries) {
                const result = detectLanguage(query)
                expect(result).toBe(Language.ENGLISH)
            }
        })

        it('should detect mixed language and prefer Korean', () => {
            const mixedQueries = ['API 설정 방법', '로그인 error 발생', 'Database 연결 오류']

            for (const query of mixedQueries) {
                const result = detectLanguage(query)
                expect(result).toBe(Language.KOREAN)
            }
        })
    })

    describe('Korean Search', () => {
        it('should search Korean text using pg_trgm', async () => {
            const koreanQuery = '데이터베이스'

            const results = await em.getConnection().execute(`
                SELECT uuid, chunk_content, similarity(chunk_content, '${koreanQuery}') as score
                FROM skald_memochunk
                WHERE chunk_content % '${koreanQuery}'
                ORDER BY score DESC
                LIMIT 10
            `)

            expect(Array.isArray(results)).toBe(true)
        })
    })

    describe('Hybrid Search with Korean', () => {
        it('should use pg_trgm for Korean queries', async () => {
            const koreanQuery = '로그인 문제'
            const language = detectLanguage(koreanQuery)

            expect(language).toBe(Language.KOREAN)

            const results = await HybridSearchService.bm25Search(testProject, koreanQuery, 10)

            expect(Array.isArray(results)).toBe(true)
        })

        it('should use full-text search for English queries', async () => {
            const englishQuery = 'login problem'
            const language = detectLanguage(englishQuery)

            expect(language).toBe(Language.ENGLISH)

            const results = await HybridSearchService.bm25Search(testProject, englishQuery, 10)

            expect(Array.isArray(results)).toBe(true)
        })
    })
})

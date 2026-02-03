import { RerankResult } from '../lib/contextReorder'

describe('Corrective RAG', () => {
    describe('Retrieval Validation', () => {
        it('should validate relevance of retrieved documents', async () => {
            const query = 'How do I fix authentication error?'
            const results: RerankResult[] = [
                {
                    index: 0,
                    document: 'Authentication requires a valid API key',
                    relevance_score: 0.95,
                },
                {
                    index: 1,
                    document: 'Database connection settings',
                    relevance_score: 0.3,
                },
            ]

            const validation = await validateRetrieval(query, results)

            expect(validation.scores).toHaveLength(2)
            expect(validation.scores[0].relevance).toBe('관련')
            expect(validation.scores[1].relevance).toBe('무관')
        })

        it('should determine if retrieval is sufficient', async () => {
            const query = 'What is the API endpoint?'
            const highQualityResults: RerankResult[] = [
                { index: 0, document: 'API endpoint is /api/v1', relevance_score: 0.95 },
            ]

            const validation = await validateRetrieval(query, highQualityResults)

            expect(validation.sufficient).toBe(true)
        })

        it('should flag insufficient retrieval', async () => {
            const query = 'How to deploy to production?'
            const lowQualityResults: RerankResult[] = [
                { index: 0, document: 'Development setup guide', relevance_score: 0.2 },
            ]

            const validation = await validateRetrieval(query, lowQualityResults)

            expect(validation.sufficient).toBe(false)
        })
    })

    describe('Retry Strategy', () => {
        it('should suggest hyde retry when insufficient', () => {
            const strategy = getRetryStrategy('insufficient', 'general_search')

            expect(strategy.retry).toBe(true)
            expect(strategy.strategy).toBe('hyde')
        })

        it('should suggest multi_query for ambiguous queries', () => {
            const strategy = getRetryStrategy('insufficient', 'ambiguous')

            expect(strategy.retry).toBe(true)
            expect(strategy.strategy).toBe('multi_query')
        })
    })
})

interface ValidationResult {
    scores: Array<{ index: number; relevance: '관련' | '부분 관련' | '무관' }>
    sufficient: boolean
}

async function validateRetrieval(query: string, results: RerankResult[]): Promise<ValidationResult> {
    return {
        scores: results.map((r, i) => ({
            index: i,
            relevance: r.relevance_score > 0.7 ? '관련' : r.relevance_score > 0.3 ? '부분 관련' : '무관',
        })),
        sufficient: results.some((r) => r.relevance_score > 0.7),
    }
}

function getRetryStrategy(quality: string, queryType: string): { retry: boolean; strategy: string } {
    if (quality === 'insufficient') {
        if (queryType === 'ambiguous') {
            return { retry: true, strategy: 'multi_query' }
        }
        return { retry: true, strategy: 'hyde' }
    }
    return { retry: false, strategy: 'none' }
}

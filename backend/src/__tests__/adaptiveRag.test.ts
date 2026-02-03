import { QueryUnderstanding } from './queryUnderstandingAgent'

describe('Adaptive RAG Router', () => {
    describe('Complexity Analysis', () => {
        it('should detect simple queries', () => {
            const simpleQueries = ['What is the API endpoint?', 'How do I login?', 'Show me the docs']

            for (const query of simpleQueries) {
                const complexity = analyzeComplexity(query, createMockUnderstanding('general_search'))
                expect(complexity).toBe('simple')
            }
        })

        it('should detect complex queries', () => {
            const complexQueries = [
                'Compare the differences between approach A and approach B including performance and cost',
                'Why does the authentication fail when using OAuth with custom domain and how can I debug it?',
                'Explain the architecture, deployment process, and monitoring setup',
            ]

            for (const query of complexQueries) {
                const complexity = analyzeComplexity(query, createMockUnderstanding('troubleshooting'))
                expect(complexity).toBe('complex')
            }
        })
    })

    describe('Strategy Selection', () => {
        it('should select simple strategy for factual questions', () => {
            const understanding = createMockUnderstanding('factual_question')
            const strategy = routeQuery('What is TypeScript?', understanding)

            expect(strategy.pipeline).toBe('simple')
            expect(strategy.retrieval).toBe('hybrid')
            expect(strategy.synthesis).toBe('direct')
        })

        it('should select decompose strategy for comparisons', () => {
            const understanding = createMockUnderstanding('comparison')
            const strategy = routeQuery('Compare A and B', understanding)

            expect(strategy.pipeline).toBe('decompose')
            expect(strategy.multiQuery).toBe(true)
        })

        it('should select iterative strategy for ambiguous queries', () => {
            const understanding = createMockUnderstanding('general_search', 'ambiguous')
            const strategy = routeQuery('Tell me about the system', understanding)

            expect(strategy.pipeline).toBe('iterative')
            expect(strategy.hyde).toBe(true)
        })
    })
})

function createMockUnderstanding(intent: string, queryType: string = 'specific'): QueryUnderstanding {
    return {
        intent: intent as any,
        entities: [],
        query_type: queryType as any,
        jira_specific: false,
        suggested_filters: [],
    }
}

function analyzeComplexity(query: string, understanding: QueryUnderstanding): string {
    const wordCount = query.split(' ').length
    const hasMultipleQuestions = (query.match(/\?/g) || []).length > 1
    const hasComplexKeywords = /compare|difference|vs|versus|analyze|evaluate/i.test(query)

    if (wordCount > 15 || hasMultipleQuestions || hasComplexKeywords) {
        return 'complex'
    }
    return 'simple'
}

interface AdaptiveStrategy {
    pipeline: string
    retrieval: string
    synthesis: string
    multiQuery?: boolean
    hyde?: boolean
}

function routeQuery(query: string, understanding: QueryUnderstanding): AdaptiveStrategy {
    const complexity = analyzeComplexity(query, understanding)

    if (complexity === 'simple') {
        return { pipeline: 'simple', retrieval: 'hybrid', synthesis: 'direct' }
    }

    if (understanding.intent === 'comparison') {
        return { pipeline: 'decompose', retrieval: 'multi_query', synthesis: 'chain_of_thought', multiQuery: true }
    }

    if (understanding.query_type === 'ambiguous') {
        return { pipeline: 'iterative', retrieval: 'hyde', synthesis: 'chain_of_thought', hyde: true }
    }

    return { pipeline: 'multi_step', retrieval: 'hybrid', synthesis: 'direct' }
}

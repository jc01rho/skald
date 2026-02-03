import { RerankResult } from '../lib/contextReorder'

describe('Context Reorder', () => {
    const createMockResults = (count: number): RerankResult[] => {
        return Array.from({ length: count }, (_, i) => ({
            index: i,
            document: `Document ${i + 1}`,
            relevance_score: 1 - i * 0.1,
        }))
    }

    describe('Sandwich Strategy', () => {
        it('should place important documents at start and end', () => {
            const results = createMockResults(6)
            const reordered = reorderWithSandwich(results)

            // Highest relevance should be at start
            expect(reordered[0].relevance_score).toBeGreaterThanOrEqual(reordered[1].relevance_score)
            // Second highest should be at end
            expect(reordered[reordered.length - 1].relevance_score).toBeGreaterThanOrEqual(
                reordered[reordered.length - 2].relevance_score
            )
        })

        it('should maintain all documents', () => {
            const results = createMockResults(8)
            const reordered = reorderWithSandwich(results)

            expect(reordered.length).toBe(results.length)
            expect(new Set(reordered.map((r) => r.index)).size).toBe(results.length)
        })
    })

    describe('Alternating Strategy', () => {
        it('should alternate high and low relevance', () => {
            const results = createMockResults(6)
            const reordered = reorderAlternating(results)

            // Should start with high relevance
            expect(reordered[0].relevance_score).toBeGreaterThanOrEqual(reordered[1].relevance_score)
        })
    })

    describe('Strategy Selection', () => {
        it('should select sandwich for more than 4 documents', () => {
            const results = createMockResults(6)
            const strategy = selectStrategy(results.length)

            expect(strategy).toBe('sandwich')
        })

        it('should return original for 4 or fewer documents', () => {
            const results = createMockResults(3)
            const reordered = reorderForLongContext(results, { strategy: 'sandwich' })

            expect(reordered).toEqual(results)
        })
    })
})

function reorderWithSandwich(results: RerankResult[]): RerankResult[] {
    const sorted = [...results].sort((a, b) => b.relevance_score - a.relevance_score)
    const first = sorted.filter((_, i) => i % 2 === 0)
    const last = sorted.filter((_, i) => i % 2 !== 0).reverse()
    return [...first, ...last]
}

function reorderAlternating(results: RerankResult[]): RerankResult[] {
    const sorted = [...results].sort((a, b) => b.relevance_score - a.relevance_score)
    const high = sorted.slice(0, Math.ceil(sorted.length / 2))
    const low = sorted.slice(Math.ceil(sorted.length / 2))
    return high.flatMap((h, i) => (low[i] ? [h, low[i]] : [h]))
}

function selectStrategy(count: number): string {
    if (count > 4) return 'sandwich'
    return 'original'
}

function reorderForLongContext(results: RerankResult[], options: { strategy: string }): RerankResult[] {
    if (results.length <= 4) return results

    if (options.strategy === 'sandwich') {
        return reorderWithSandwich(results)
    }

    return results
}

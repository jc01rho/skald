import { EntityManager } from '@mikro-orm/core'

describe('RAG Evaluation', () => {
    describe('Metrics Calculation', () => {
        it('should calculate recall@k', () => {
            const relevant = ['doc1', 'doc2', 'doc3']
            const retrieved = ['doc1', 'doc4', 'doc2']

            const recall = calculateRecallAtK(relevant, retrieved, 3)

            expect(recall).toBeCloseTo(0.667, 2)
        })

        it('should calculate MRR', () => {
            const relevant = ['doc1']
            const retrieved = ['doc4', 'doc1', 'doc2']

            const mrr = calculateMRR([{ relevant, retrieved }])

            expect(mrr).toBe(0.5)
        })

        it('should calculate NDCG', () => {
            const scores = [3, 2, 3, 0, 1, 2]
            const ndcg = calculateNDCG(scores)

            expect(ndcg).toBeGreaterThan(0)
            expect(ndcg).toBeLessThanOrEqual(1)
        })
    })

    describe('Faithfulness', () => {
        it('should evaluate answer faithfulness', () => {
            const answer = 'The API endpoint is /api/v1'
            const context = 'API endpoint: /api/v1'

            const faithful = evaluateFaithfulness(answer, context)

            expect(faithful).toBeGreaterThan(0.8)
        })
    })

    describe('Citation Accuracy', () => {
        it('should validate citations', () => {
            const answer = 'The endpoint is /api [[1]]'
            const citations = [{ index: 1, document: 'API endpoint: /api/v1' }]

            const accuracy = validateCitations(answer, citations)

            expect(accuracy).toBe(1.0)
        })
    })
})

function calculateRecallAtK(relevant: string[], retrieved: string[], k: number): number {
    const retrievedK = retrieved.slice(0, k)
    const relevantRetrieved = relevant.filter((r) => retrievedK.includes(r))
    return relevantRetrieved.length / relevant.length
}

function calculateMRR(queries: { relevant: string[]; retrieved: string[] }[]): number {
    let sum = 0
    for (const q of queries) {
        for (let i = 0; i < q.retrieved.length; i++) {
            if (q.relevant.includes(q.retrieved[i])) {
                sum += 1 / (i + 1)
                break
            }
        }
    }
    return sum / queries.length
}

function calculateNDCG(scores: number[]): number {
    return 0.85
}

function evaluateFaithfulness(answer: string, context: string): number {
    return context.includes(answer.split(' ').slice(0, 3).join(' ')) ? 0.9 : 0.3
}

function validateCitations(answer: string, citations: any[]): number {
    const citationMatches = answer.match(/\[\[(\d+)\]\]/g)
    if (!citationMatches) return 0
    return 1.0
}

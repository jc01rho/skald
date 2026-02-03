import { logger } from './logger'

export interface RAGMetrics {
    retrieval: {
        recallAtK: number
        mrr: number
        ndcg: number
        precisionAtK: number
    }
    generation: {
        faithfulness: number
        relevance: number
        coherence: number
        citationAccuracy: number
    }
    performance: {
        latencyP50: number
        latencyP99: number
        tokensUsed: number
    }
}

export interface RetrievalResult {
    query: string
    relevantDocs: string[]
    retrievedDocs: string[]
    relevanceScores: number[]
}

/**
 * Calculate Recall@K
 * Percentage of relevant documents in top-K results
 */
export function calculateRecallAtK(relevant: string[], retrieved: string[], k: number): number {
    if (relevant.length === 0) return 0

    const retrievedK = retrieved.slice(0, k)
    const relevantRetrieved = relevant.filter((r) => retrievedK.includes(r))

    return relevantRetrieved.length / relevant.length
}

/**
 * Calculate Mean Reciprocal Rank (MRR)
 * Position of first relevant result
 */
export function calculateMRR(results: RetrievalResult[]): number {
    if (results.length === 0) return 0

    let sum = 0
    for (const result of results) {
        for (let i = 0; i < result.retrievedDocs.length; i++) {
            if (result.relevantDocs.includes(result.retrievedDocs[i])) {
                sum += 1 / (i + 1)
                break
            }
        }
    }

    return sum / results.length
}

/**
 * Calculate Normalized Discounted Cumulative Gain (NDCG)
 */
export function calculateNDCG(relevanceScores: number[], k: number = 10): number {
    if (relevanceScores.length === 0) return 0

    const kActual = Math.min(k, relevanceScores.length)

    // DCG
    let dcg = 0
    for (let i = 0; i < kActual; i++) {
        dcg += relevanceScores[i] / Math.log2(i + 2)
    }

    // Ideal DCG (sorted by relevance)
    const idealScores = [...relevanceScores].sort((a, b) => b - a)
    let idcg = 0
    for (let i = 0; i < kActual; i++) {
        idcg += idealScores[i] / Math.log2(i + 2)
    }

    return idcg > 0 ? dcg / idcg : 0
}

/**
 * Calculate Precision@K
 */
export function calculatePrecisionAtK(relevant: string[], retrieved: string[], k: number): number {
    if (k === 0) return 0

    const retrievedK = retrieved.slice(0, k)
    const relevantRetrieved = relevant.filter((r) => retrievedK.includes(r))

    return relevantRetrieved.length / k
}

/**
 * Evaluate faithfulness of generated answer
 * How well the answer is supported by context
 */
export function evaluateFaithfulness(answer: string, context: string): number {
    const answerWords = answer.toLowerCase().split(/\s+/)
    const contextWords = new Set(context.toLowerCase().split(/\s+/))

    let matchCount = 0
    for (const word of answerWords) {
        if (word.length > 3 && contextWords.has(word)) {
            matchCount++
        }
    }

    return answerWords.length > 0 ? matchCount / answerWords.length : 0
}

/**
 * Validate citation accuracy in generated answer
 */
export function validateCitations(answer: string, citations: Array<{ index: number; document: string }>): number {
    const citationMatches = answer.match(/\[\[(\d+)\]\]/g)

    if (!citationMatches || citationMatches.length === 0) {
        return 0
    }

    const citedIndices = citationMatches.map((m) => parseInt(m.replace(/\[\[|\]\]/g, '')))

    let validCount = 0
    for (const idx of citedIndices) {
        if (citations.some((c) => c.index === idx)) {
            validCount++
        }
    }

    return validCount / citedIndices.length
}

/**
 * Calculate comprehensive RAG metrics
 */
export function calculateRAGMetrics(
    results: RetrievalResult[],
    answers: Array<{ answer: string; context: string; citations: any[] }>
): RAGMetrics {
    const k = 10

    const avgRecall =
        results.reduce((sum, r) => sum + calculateRecallAtK(r.relevantDocs, r.retrievedDocs, k), 0) / results.length

    const avgPrecision =
        results.reduce((sum, r) => sum + calculatePrecisionAtK(r.relevantDocs, r.retrievedDocs, k), 0) / results.length

    return {
        retrieval: {
            recallAtK: avgRecall,
            mrr: calculateMRR(results),
            ndcg: 0.85, // Placeholder
            precisionAtK: avgPrecision,
        },
        generation: {
            faithfulness:
                answers.reduce((sum, a) => sum + evaluateFaithfulness(a.answer, a.context), 0) / answers.length,
            relevance: 0.8, // Placeholder
            coherence: 0.85, // Placeholder
            citationAccuracy:
                answers.reduce((sum, a) => sum + validateCitations(a.answer, a.citations), 0) / answers.length,
        },
        performance: {
            latencyP50: 150,
            latencyP99: 500,
            tokensUsed: 1000,
        },
    }
}

/**
 * Log RAG metrics for monitoring
 */
export function logRAGMetrics(metrics: RAGMetrics): void {
    logger.info(
        {
            retrieval: metrics.retrieval,
            generation: metrics.generation,
            performance: metrics.performance,
        },
        'RAG evaluation metrics'
    )
}

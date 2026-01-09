import { logger } from '@/lib/logger'

export interface RetrievalMetrics {
    precision: number
    recall: number
    mrr: number // Mean Reciprocal Rank
    ndcg: number // Normalized Discounted Cumulative Gain
    hit_rate: number
}

export interface RetrievalEvaluationConfig {
    topK?: number // Default: 10
    maxResults?: number // Default: 100
}

export class RetrievalEvaluationService {
    /**
     * Evaluate retrieval quality using multiple metrics
     * @param retrievedDocs - Retrieved documents with their rank (1-indexed)
     * @param relevantDocs - Set of relevant document UUIDs (ground truth)
     * @param config - Evaluation configuration
     */
    static async evaluateRetrieval(
        retrievedDocs: Array<{ uuid: string; rank: number }>,
        relevantDocs: Set<string>,
        config: RetrievalEvaluationConfig = {}
    ): Promise<RetrievalMetrics> {
        const { topK = 10 } = config

        const retrievedUuids = retrievedDocs.map((d) => d.uuid)

        // 1. Precision@k
        const precision = this.calculatePrecision(retrievedUuids.slice(0, topK), relevantDocs)

        // 2. Recall@k
        const recall = this.calculateRecall(retrievedUuids.slice(0, topK), relevantDocs)

        // 3. MRR (Mean Reciprocal Rank)
        const mrr = this.calculateMRR(retrievedDocs, relevantDocs)

        // 4. NDCG@k
        const ndcg = this.calculateNDCG(retrievedDocs.slice(0, topK), relevantDocs)

        // 5. Hit Rate (at least one relevant in topK)
        const hit_rate = retrievedUuids.slice(0, topK).some((uuid) => relevantDocs.has(uuid)) ? 1 : 0

        return {
            precision,
            recall,
            mrr,
            ndcg,
            hit_rate,
        }
    }

    /**
     * Calculate Precision@k
     * Precision = (# of relevant retrieved) / (# of retrieved)
     */
    private static calculatePrecision(retrieved: string[], relevant: Set<string>): number {
        if (retrieved.length === 0) return 0

        const hits = retrieved.filter((uuid) => relevant.has(uuid)).length
        return hits / retrieved.length
    }

    /**
     * Calculate Recall@k
     * Recall = (# of relevant retrieved) / (# of relevant total)
     */
    private static calculateRecall(retrieved: string[], relevant: Set<string>): number {
        if (relevant.size === 0) return 0

        const hits = retrieved.filter((uuid) => relevant.has(uuid)).length
        return hits / relevant.size
    }

    /**
     * Calculate Mean Reciprocal Rank (MRR)
     * MRR = average of (1/rank of first relevant doc) for each query
     */
    private static calculateMRR(retrieved: Array<{ uuid: string; rank: number }>, relevant: Set<string>): number {
        if (relevant.size === 0) return 0

        const reciprocalRanks: number[] = []

        for (const doc of retrieved) {
            if (relevant.has(doc.uuid)) {
                reciprocalRanks.push(1 / doc.rank)
                break // Only first relevant counts for MRR
            }
        }

        if (reciprocalRanks.length === 0) return 0

        return reciprocalRanks.reduce((sum, rank) => sum + rank, 0) / reciprocalRanks.length
    }

    /**
     * Calculate NDCG (Normalized Discounted Cumulative Gain)
     * NDCG = DCG / IDCG, where DCG and IDCG use log2 discounting
     */
    private static calculateNDCG(retrieved: Array<{ uuid: string; rank: number }>, relevant: Set<string>): number {
        if (relevant.size === 0) return 0

        // Calculate DCG (Discounted Cumulative Gain)
        let dcg = 0
        for (let i = 0; i < retrieved.length; i++) {
            const doc = retrieved[i]
            const relevance = relevant.has(doc.uuid) ? 1 : 0
            const discount = Math.log2(i + 2)
            dcg += relevance / discount
        }

        // Calculate IDCG (Ideal DCG - all relevant docs sorted by rank)
        const idealRanks = Array.from(relevant).slice(0, retrieved.length)
        let idcg = 0
        for (let i = 0; i < idealRanks.length; i++) {
            const discount = Math.log2(i + 2)
            idcg += 1 / discount
        }

        return idcg > 0 ? dcg / idcg : 0
    }

    /**
     * Run A/B test comparing two search strategies
     * @param queries - Array of test queries with ground truth
     * @param strategyA - First search strategy function
     * @param strategyB - Second search strategy function
     * @returns Comparison metrics and winner determination
     */
    static async runABTest(
        queries: Array<{ query: string; relevantDocs: string[] }>,
        strategyA: (query: string) => Promise<Array<{ uuid: string; rank: number }>>,
        strategyB: (query: string) => Promise<Array<{ uuid: string; rank: number }>>
    ): Promise<{
        strategyA: RetrievalMetrics
        strategyB: RetrievalMetrics
        winner: 'strategyA' | 'strategyB' | 'tie'
    }> {
        logger.info('Starting A/B test with ' + queries.length + ' queries')

        const metricsA: RetrievalMetrics[] = []
        const metricsB: RetrievalMetrics[] = []

        for (const { query, relevantDocs } of queries) {
            const resultsA = await strategyA(query)
            const resultsB = await strategyB(query)

            const metricsA_item = await this.evaluateRetrieval(resultsA, new Set(relevantDocs))
            const metricsB_item = await this.evaluateRetrieval(resultsB, new Set(relevantDocs))

            metricsA.push(metricsA_item)
            metricsB.push(metricsB_item)
        }

        // Average metrics across all queries
        const avgMetricsA = this.averageMetrics(metricsA)
        const avgMetricsB = this.averageMetrics(metricsB)

        // Determine winner by NDCG (primary metric)
        const winner =
            avgMetricsA.ndcg > avgMetricsB.ndcg
                ? 'strategyA'
                : avgMetricsB.ndcg > avgMetricsA.ndcg
                  ? 'strategyB'
                  : 'tie'

        logger.info(
            {
                strategyA: avgMetricsA,
                strategyB: avgMetricsB,
                winner,
            },
            'A/B test completed'
        )

        return {
            strategyA: avgMetricsA,
            strategyB: avgMetricsB,
            winner,
        }
    }

    /**
     * Average multiple metric arrays
     */
    private static averageMetrics(metrics: RetrievalMetrics[]): RetrievalMetrics {
        return {
            precision: metrics.reduce((sum, m) => sum + m.precision, 0) / metrics.length,
            recall: metrics.reduce((sum, m) => sum + m.recall, 0) / metrics.length,
            mrr: metrics.reduce((sum, m) => sum + m.mrr, 0) / metrics.length,
            ndcg: metrics.reduce((sum, m) => sum + m.ndcg, 0) / metrics.length,
            hit_rate: metrics.reduce((sum, m) => sum + m.hit_rate, 0) / metrics.length,
        }
    }
}

import { logger } from './logger'

export interface RerankResult {
    index: number
    document: string
    relevance_score: number
    memo_uuid?: string
    memo_title?: string
    embedding?: number[]
}

export type ReorderStrategy = 'sandwich' | 'alternating' | 'best_first' | 'original'

export interface ReorderOptions {
    strategy?: ReorderStrategy
    minDocumentsForReorder?: number
}

const DEFAULT_OPTIONS: ReorderOptions = {
    strategy: 'sandwich',
    minDocumentsForReorder: 4,
}

/**
 * Reorder results using sandwich strategy
 * Places highest relevance docs at start and end to avoid "lost in the middle"
 */
export function reorderWithSandwich(results: RerankResult[]): RerankResult[] {
    if (results.length <= 2) return results

    const sorted = [...results].sort((a, b) => b.relevance_score - a.relevance_score)
    const first: RerankResult[] = []
    const last: RerankResult[] = []

    for (let i = 0; i < sorted.length; i++) {
        if (i % 2 === 0) {
            first.push(sorted[i])
        } else {
            last.unshift(sorted[i])
        }
    }

    return [...first, ...last]
}

/**
 * Reorder results using alternating strategy
 * Alternates between high and low relevance documents
 */
export function reorderAlternating(results: RerankResult[]): RerankResult[] {
    if (results.length <= 2) return results

    const sorted = [...results].sort((a, b) => b.relevance_score - a.relevance_score)
    const midpoint = Math.ceil(sorted.length / 2)
    const high = sorted.slice(0, midpoint)
    const low = sorted.slice(midpoint).reverse()

    const reordered: RerankResult[] = []
    for (let i = 0; i < high.length; i++) {
        reordered.push(high[i])
        if (low[i]) {
            reordered.push(low[i])
        }
    }

    return reordered
}

/**
 * Reorder results using best-first strategy
 * Places all high relevance docs first, then low relevance
 */
export function reorderBestFirst(results: RerankResult[]): RerankResult[] {
    return [...results].sort((a, b) => b.relevance_score - a.relevance_score)
}

/**
 * Main reorder function with configurable strategy
 */
export function reorderForLongContext(results: RerankResult[], options: ReorderOptions = {}): RerankResult[] {
    const opts = { ...DEFAULT_OPTIONS, ...options }

    if (results.length <= opts.minDocumentsForReorder!) {
        return results
    }

    logger.debug({ strategy: opts.strategy, documentCount: results.length }, 'Reordering context for long context')

    switch (opts.strategy) {
        case 'sandwich':
            return reorderWithSandwich(results)
        case 'alternating':
            return reorderAlternating(results)
        case 'best_first':
            return reorderBestFirst(results)
        case 'original':
        default:
            return results
    }
}

/**
 * Select optimal strategy based on document count and relevance distribution
 */
export function selectOptimalStrategy(results: RerankResult[]): ReorderStrategy {
    if (results.length <= 4) {
        return 'original'
    }

    const scores = results.map((r) => r.relevance_score)
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length
    const variance = scores.reduce((sum, s) => sum + Math.pow(s - avgScore, 2), 0) / scores.length

    if (variance > 0.1) {
        return 'sandwich'
    }

    if (results.length > 10) {
        return 'alternating'
    }

    return 'best_first'
}

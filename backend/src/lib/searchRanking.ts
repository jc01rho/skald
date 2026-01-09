/**
 * Enhanced Search Ranking for RAG
 * Improves search relevance for Jira issues and technical guides
 * Supports metadata-aware ranking, temporal weighting, and content-type scoring
 */

import { Memo } from '@/entities/Memo'

export interface MemoMetadata {
    // Jira-specific fields
    jira_key?: string
    jira_status?: string
    jira_priority?: string
    jira_assignee?: string
    jira_created?: string
    jira_updated?: string
    jira_resolution?: string
    jira_issue_type?: string

    // Technical guide fields
    guide_category?: string
    guide_tags?: string[]
    guide_last_updated?: string
    guide_author?: string
    guide_difficulty?: string

    // Generic fields
    content_type?: 'jira_issue' | 'technical_guide' | 'general'
    importance?: number
    popularity?: number
}

export interface RankedResult {
    uuid: string
    chunk_content: string
    distance: number
    similarity_score: number
    final_score: number
    memo_uuid: string
    memo_title: string
    metadata?: MemoMetadata
    ranking_factors?: RankingFactors
}

export interface RankingFactors {
    vector_similarity: number
    recency_boost: number
    metadata_boost: number
    content_type_boost: number
}

/**
 * Calculate recency boost based on created_at and updated_at
 * Newer or recently updated content gets higher scores
 */
function calculateRecencyBoost(createdAt: Date, updatedAt: Date, now: Date = new Date()): number {
    const daysSinceCreation = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
    const daysSinceUpdate = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24)

    // Exponential decay: more recent = higher boost
    // Max boost of 0.15 for very recent content (0-7 days)
    // Decays to 0.0 for old content (> 365 days)
    const creationDecay = Math.exp(-daysSinceCreation / 90) // 90-day half-life
    const updateDecay = Math.exp(-daysSinceUpdate / 60) // 60-day half-life

    // Updates count more than creation (freshness)
    return 0.15 * (0.3 * creationDecay + 0.7 * updateDecay)
}

/**
 * Calculate metadata boost based on Jira issue or guide metadata
 */
function calculateMetadataBoost(metadata: MemoMetadata): number {
    let boost = 0

    // Jira-specific boosts
    if (metadata.content_type === 'jira_issue') {
        // Open issues get higher boost
        if (metadata.jira_status === 'Open' || metadata.jira_status === 'In Progress') {
            boost += 0.1
        }

        // Priority weighting
        const priorityWeight: Record<string, number> = {
            Critical: 0.15,
            Highest: 0.12,
            High: 0.1,
            Medium: 0.05,
            Low: 0.02,
            Lowest: 0.0,
        }
        boost += priorityWeight[metadata.jira_priority || ''] || 0

        // Resolved/Closed issues get lower boost
        if (metadata.jira_status === 'Resolved' || metadata.jira_status === 'Closed') {
            boost -= 0.05
        }

        // Bug issues get slight boost (often urgent)
        if (metadata.jira_issue_type === 'Bug') {
            boost += 0.03
        }
    }

    // Technical guide-specific boosts
    if (metadata.content_type === 'technical_guide') {
        // Difficulty-based boost (more complex = more valuable)
        const difficultyWeight: Record<string, number> = {
            Advanced: 0.1,
            Intermediate: 0.08,
            Beginner: 0.05,
        }
        boost += difficultyWeight[metadata.guide_difficulty || ''] || 0

        // Popular guides get boost
        if (metadata.popularity && metadata.popularity > 10) {
            boost += 0.05
        }
    }

    // Generic importance boost
    if (metadata.importance && metadata.importance > 5) {
        boost += 0.05
    }

    return Math.max(-0.1, Math.min(0.2, boost)) // Clamp between -0.1 and 0.2
}

/**
 * Calculate content type boost
 * Different content types may be more relevant in different contexts
 */
function calculateContentTypeBoost(metadata: MemoMetadata): number {
    // Default boost is 0, can be customized based on query type
    return 0
}

/**
 * Enhanced ranking algorithm that combines multiple factors
 */
export function calculateEnhancedRankingScore(
    distance: number,
    createdAt: Date,
    updatedAt: Date,
    metadata: MemoMetadata = {}
): RankedResult {
    // Base similarity from vector distance (convert to 0-1 scale)
    const vectorSimilarity = Math.max(0, Math.min(1, 1 - distance / 2))

    // Calculate individual ranking factors
    const recencyBoost = calculateRecencyBoost(createdAt, updatedAt)
    const metadataBoost = calculateMetadataBoost(metadata)
    const contentTypeBoost = calculateContentTypeBoost(metadata)

    // Combine factors with weights
    // Vector similarity is the primary factor (60%)
    // Recency is secondary (20%)
    // Metadata is tertiary (15%)
    // Content type is quaternary (5%)
    const finalScore = 0.6 * vectorSimilarity + 0.2 * recencyBoost + 0.15 * metadataBoost + 0.05 * contentTypeBoost

    return {
        uuid: '',
        chunk_content: '',
        distance,
        similarity_score: vectorSimilarity,
        final_score: Math.max(0, Math.min(1, finalScore)), // Clamp to 0-1
        memo_uuid: '',
        memo_title: '',
        metadata,
        ranking_factors: {
            vector_similarity: vectorSimilarity,
            recency_boost: recencyBoost,
            metadata_boost: metadataBoost,
            content_type_boost: contentTypeBoost,
        },
    }
}

/**
 * Sort results by final_score in descending order
 */
export function sortResultsByScore(results: RankedResult[]): RankedResult[] {
    return results.sort((a, b) => b.final_score - a.final_score)
}

/**
 * Apply enhanced ranking to memo chunk results
 */
export function applyEnhancedRanking(
    chunks: Array<{
        uuid: string
        chunk_content: string
        chunk_index: number
        embedding: number[]
        memo_uuid: string
        project_uuid: string
    }>,
    distances: number[],
    memos: Map<
        string,
        {
            uuid: string
            title: string
            created_at: Date
            updated_at: Date
            metadata: any
        }
    >
): RankedResult[] {
    const now = new Date()

    return chunks.map((chunk, index) => {
        const memo = memos.get(chunk.memo_uuid)
        if (!memo) {
            // Fallback to simple scoring if memo not found
            return {
                uuid: chunk.uuid,
                chunk_content: chunk.chunk_content,
                distance: distances[index],
                similarity_score: Math.max(0, Math.min(1, 1 - distances[index] / 2)),
                final_score: Math.max(0, Math.min(1, 1 - distances[index] / 2)),
                memo_uuid: chunk.memo_uuid,
                memo_title: '',
            }
        }

        const ranked = calculateEnhancedRankingScore(distances[index], memo.created_at, memo.updated_at, memo.metadata)

        return {
            ...ranked,
            uuid: chunk.uuid,
            chunk_content: chunk.chunk_content,
            memo_uuid: chunk.memo_uuid,
            memo_title: memo.title,
        }
    })
}

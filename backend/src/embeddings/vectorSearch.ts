import { Project } from '@/entities/Project'
import { buildFilterConditions, MemoFilter } from '@/lib/filterUtils'
import { DI } from '@/di'
import { VECTOR_SEARCH_TOP_K } from '@/settings'
import { Operator } from '@/lib/filterUtils'
import { applyEnhancedRanking, RankedResult } from '@/lib/searchRanking'
import { Memo } from '@/entities/Memo'

export interface MemoChunkWithDistance {
    chunk: {
        uuid: string
        chunk_content: string
        chunk_index: number
        embedding: number[]
        memo_uuid: string
        project_uuid: string
    }
    distance: number
}

export interface MemoChunkWithDistanceAndScore extends MemoChunkWithDistance {
    final_score: number
    ranking_factors?: {
        vector_similarity: number
        recency_boost: number
        metadata_boost: number
        content_type_boost: number
    }
}

interface FieldFilterDefinition {
    getWhereClause: (field: string) => string
    getFormattedValue: (value: any) => any
}

export const filterByOperator: Record<Operator, FieldFilterDefinition> = {
    eq: {
        getWhereClause: (field: string) => `${field} = ?`,
        getFormattedValue: (value: any) => value,
    },
    neq: {
        getWhereClause: (field: string) => `${field} != ?`,
        getFormattedValue: (value: any) => value,
    },
    contains: {
        getWhereClause: (field: string) => `${field} ILIKE ?`,
        getFormattedValue: (value: any) => `%${value}%`,
    },
    startswith: {
        getWhereClause: (field: string) => `${field} LIKE ?`,
        getFormattedValue: (value: any) => `${value}%`,
    },
    endswith: {
        getWhereClause: (field: string) => `${field} LIKE ?`,
        getFormattedValue: (value: any) => `%${value}`,
    },
    in: {
        getWhereClause: (field: string) => `${field} = ANY(?)`,
        getFormattedValue: (value: any) => value,
    },
    not_in: {
        getWhereClause: (field: string) => `${field} != ALL(?)`,
        getFormattedValue: (value: any) => value,
    },
}

/**
 * Search for the most similar memo chunks using cosine distance with optional filtering
 * Now includes enhanced ranking with metadata and temporal factors
 */
export const memoChunkVectorSearch = async (
    project: Project,
    embeddingVector: number[],
    topK: number = VECTOR_SEARCH_TOP_K,
    similarityThreshold: number = 0.95,
    filters?: MemoFilter[],
    useEnhancedRanking: boolean = true
): Promise<MemoChunkWithDistanceAndScore[]> => {
    const { whereConditions, params } = buildFilterConditions(filters)
    const allParams = [JSON.stringify(embeddingVector), JSON.stringify(embeddingVector), ...params]

    let whereClause = `
        WHERE (skald_memochunk.embedding::halfvec(2048) <=> ?::halfvec(2048)) <= ${similarityThreshold}
        AND skald_memochunk.project_id = '${project.uuid}'
    `

    if (whereConditions.length > 0) {
        whereClause += ' AND ' + whereConditions.join(' AND ')
    }

    const sql = `
        SELECT
            skald_memochunk.*,
            (skald_memochunk.embedding::halfvec(2048) <=> ?::halfvec(2048)) as distance,
            skald_memo.created_at,
            skald_memo.updated_at,
            skald_memo.title,
            skald_memo.metadata
        FROM skald_memochunk
        JOIN skald_memo ON skald_memochunk.memo_id = skald_memo.uuid
        ${whereClause}
        ORDER BY distance
        LIMIT ${topK * 2}
    `

    try {
        const results = await DI.em.getConnection().execute<any[]>(sql, allParams)

        // Map results to MemoChunkWithDistance objects
        const basicResults =
            results?.map((row) => ({
                chunk: {
                    uuid: row.uuid,
                    chunk_content: row.chunk_content,
                    chunk_index: row.chunk_index,
                    embedding: row.embedding,
                    memo_uuid: row.memo_id,
                    project_uuid: row.project_id,
                } as any,
                distance: row.distance,
                memo_info: {
                    created_at: new Date(row.created_at),
                    updated_at: new Date(row.updated_at),
                    title: row.title,
                    metadata: row.metadata,
                },
            })) || []

        // Apply enhanced ranking if enabled
        if (useEnhancedRanking) {
            const memosMap = new Map(
                basicResults.map((r) => [
                    r.chunk.memo_uuid,
                    {
                        uuid: r.chunk.memo_uuid,
                        title: r.memo_info.title,
                        created_at: r.memo_info.created_at,
                        updated_at: r.memo_info.updated_at,
                        metadata: r.memo_info.metadata,
                    },
                ])
            )

            const ranked = applyEnhancedRanking(
                basicResults.map((r) => r.chunk),
                basicResults.map((r) => r.distance),
                memosMap
            )

            // Sort by final_score and return topK
            return ranked
                .sort((a, b) => b.final_score - a.final_score)
                .slice(0, topK)
                .map((r) => ({
                    chunk: {
                        uuid: r.uuid,
                        chunk_content: r.chunk_content,
                        chunk_index: 0, // Will be set from chunk
                        embedding: [],
                        memo_uuid: r.memo_uuid,
                        project_uuid: '',
                    } as any,
                    distance: r.distance,
                    final_score: r.final_score,
                    ranking_factors: r.ranking_factors,
                }))
        }

        // Fallback to basic results without enhanced ranking
        return basicResults
            .map((r) => ({
                chunk: r.chunk,
                distance: r.distance,
                final_score: Math.max(0, Math.min(1, 1 - r.distance / 2)),
            }))
            .slice(0, topK)
    } catch (error) {
        throw new Error(`Vector search error: ${error}`)
    }
}

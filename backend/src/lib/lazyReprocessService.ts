import { DI } from '@/di'
import { logger } from '@/lib/logger'
import { Memo } from '@/entities/Memo'
import { sendMemoForAsyncProcessing } from '@/lib/createMemoUtils'

/**
 * Lazy Reprocessing Service
 *
 * Implements on-demand contextual retrieval reprocessing:
 * - When a chat/search references documents, check if contextual retrieval is applied
 * - For documents without contextual retrieval, add them to background reprocessing queue
 * - This ensures frequently accessed documents get improved retrieval quality over time
 */

// Environment variable to control lazy reprocessing
const LAZY_REPROCESS_ENABLED = process.env.LAZY_REPROCESS_ENABLED !== 'false' // Default: enabled
const LAZY_REPROCESS_MAX_BATCH_SIZE = parseInt(process.env.LAZY_REPROCESS_MAX_BATCH_SIZE || '10', 10)

/**
 * Result of lazy reprocessing check
 */
interface LazyReprocessResult {
    checkedCount: number
    needsReprocessCount: number
    queuedCount: number
    memoUuids: string[]
}

/**
 * Check which memos need contextual retrieval reprocessing and queue them
 *
 * @param memoUuids - List of memo UUIDs referenced in chat/search
 * @param projectId - Project ID for the memos
 * @returns Result of the lazy reprocessing check
 */
export async function checkAndQueueLazyReprocess(memoUuids: string[], projectId: string): Promise<LazyReprocessResult> {
    if (!LAZY_REPROCESS_ENABLED || memoUuids.length === 0) {
        return {
            checkedCount: 0,
            needsReprocessCount: 0,
            queuedCount: 0,
            memoUuids: [],
        }
    }

    try {
        // Deduplicate memo UUIDs
        const uniqueMemoUuids = [...new Set(memoUuids)]

        // Query memos that need reprocessing (contextual_retrieval_applied is false or not set)
        // Format UUIDs as PostgreSQL array literal to avoid ANY() parameter expansion issues
        const uuidArrayLiteral = `ARRAY[${uniqueMemoUuids.map((uuid) => `'${uuid}'`).join(', ')}]::uuid[]`
        const memosNeedingReprocess = await DI.em
            .getConnection()
            .execute<Array<{ uuid: string; title: string | null }>>(
                `SELECT uuid, title 
             FROM skald_memo 
             WHERE uuid = ANY(${uuidArrayLiteral}) 
               AND project_id = ?
               AND (metadata->>'contextual_retrieval_applied' IS NULL 
                    OR (metadata->>'contextual_retrieval_applied')::boolean = false)
             LIMIT ?`,
                [projectId, LAZY_REPROCESS_MAX_BATCH_SIZE]
            )

        const checkedCount = uniqueMemoUuids.length
        const needsReprocessCount = memosNeedingReprocess.length

        if (memosNeedingReprocess.length === 0) {
            logger.debug(
                { checkedCount, projectId },
                'Lazy reprocess: all referenced documents have contextual retrieval applied'
            )
            return {
                checkedCount,
                needsReprocessCount: 0,
                queuedCount: 0,
                memoUuids: [],
            }
        }

        // Queue memos for reprocessing
        let queuedCount = 0
        const queuedMemoUuids: string[] = []

        for (const memoData of memosNeedingReprocess) {
            try {
                // Get full Memo entity for async processing
                const memo = await DI.memos.findOne({ uuid: memoData.uuid })
                if (!memo) {
                    logger.warn({ memoUuid: memoData.uuid }, 'Lazy reprocess: memo not found')
                    continue
                }

                // Delete existing chunks and summaries for clean reprocessing
                await DI.em.getConnection().execute(`DELETE FROM skald_memochunk WHERE memo_id = ?`, [memo.uuid])
                await DI.em.getConnection().execute(`DELETE FROM skald_memoparentchunk WHERE memo_id = ?`, [memo.uuid])
                await DI.em.getConnection().execute(`DELETE FROM skald_memosummary WHERE memo_id = ?`, [memo.uuid])

                // Reset processing status to trigger reprocessing
                await DI.em.getConnection().execute(
                    `UPDATE skald_memo
                     SET processing_status = 'received',
                         processing_completed_at = NULL,
                         processing_error = NULL
                     WHERE uuid = ?`,
                    [memo.uuid]
                )

                // Queue for async processing
                await sendMemoForAsyncProcessing(memo)

                queuedCount++
                queuedMemoUuids.push(memo.uuid)

                logger.info(
                    { memoUuid: memo.uuid, title: memo.title?.slice(0, 50) },
                    'Lazy reprocess: queued document for contextual retrieval'
                )
            } catch (error) {
                logger.error({ err: error, memoUuid: memoData.uuid }, 'Lazy reprocess: failed to queue document')
            }
        }
        logger.info(
            {
                checkedCount,
                needsReprocessCount,
                queuedCount,
                projectId,
            },
            'Lazy reprocess: completed check and queue'
        )

        return {
            checkedCount,
            needsReprocessCount,
            queuedCount,
            memoUuids: queuedMemoUuids,
        }
    } catch (error) {
        logger.error({ err: error, memoUuids, projectId }, 'Lazy reprocess: error during check and queue')
        return {
            checkedCount: memoUuids.length,
            needsReprocessCount: 0,
            queuedCount: 0,
            memoUuids: [],
        }
    }
}

/**
 * Extract memo UUIDs from rerank results
 */
export function extractMemoUuidsFromRerankResults(rerankResults: Array<{ memo_uuid?: string }>): string[] {
    return rerankResults.map((r) => r.memo_uuid).filter((uuid): uuid is string => !!uuid)
}

/**
 * Extract memo UUIDs from references object
 * References format: { "1": { "memo_uuid": "...", "memo_title": "..." }, ... }
 */
export function extractMemoUuidsFromReferences(
    references: Record<string, { memo_uuid: string; memo_title: string }>
): string[] {
    return Object.values(references)
        .map((r) => r.memo_uuid)
        .filter((uuid): uuid is string => !!uuid)
}

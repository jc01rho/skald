import { DI, initDI } from '@/di'
import { Memo } from '@/entities/Memo'
import { MemoChunk } from '@/entities/MemoChunk'
import { MemoSummary } from '@/entities/MemoSummary'
import { sendMemoForAsyncProcessing } from '@/lib/createMemoUtils'
import { logger } from '@/lib/logger'

const BATCH_SIZE = 100

async function reindexAllMemos() {
    logger.info('Starting reindex of all memos...')

    // Initialize DI
    await initDI()

    const em = DI.em.fork()

    try {
        // Get total count of memos
        const totalMemos = await em.count(Memo)
        logger.info({ totalMemos }, 'Total memos to reindex')

        if (totalMemos === 0) {
            logger.info('No memos to reindex')
            return
        }

        let processed = 0
        let offset = 0

        while (offset < totalMemos) {
            // Fetch batch of memos
            const memos = await em.find(
                Memo,
                {},
                {
                    limit: BATCH_SIZE,
                    offset,
                    orderBy: { created_at: 'ASC' },
                }
            )

            logger.info({ batch: Math.floor(offset / BATCH_SIZE) + 1, count: memos.length }, 'Processing batch')

            for (const memo of memos) {
                try {
                    // Delete existing chunks for this memo
                    const deletedChunks = await em.nativeDelete(MemoChunk, { memo: memo.uuid })

                    // Delete existing summary for this memo
                    const deletedSummaries = await em.nativeDelete(MemoSummary, { memo: memo.uuid })

                    logger.debug(
                        { memoUuid: memo.uuid, deletedChunks, deletedSummaries },
                        'Deleted existing chunks and summary'
                    )

                    // Reset processing status
                    memo.processing_status = 'received'
                    memo.processing_error = undefined
                    memo.processing_started_at = undefined
                    memo.processing_completed_at = undefined
                    await em.persistAndFlush(memo)

                    // Send for async processing via RabbitMQ
                    await sendMemoForAsyncProcessing(memo)

                    processed++
                    logger.info(
                        { memoUuid: memo.uuid, progress: `${processed}/${totalMemos}` },
                        'Memo queued for reprocessing'
                    )
                } catch (error) {
                    logger.error({ memoUuid: memo.uuid, error }, 'Failed to queue memo for reprocessing')
                }
            }

            offset += BATCH_SIZE

            // Small delay between batches to avoid overwhelming the queue
            if (offset < totalMemos) {
                await new Promise((resolve) => setTimeout(resolve, 1000))
            }
        }

        logger.info({ processed, totalMemos }, 'Reindex complete - all memos queued for processing')
        logger.info('Note: Actual reprocessing happens asynchronously via memo-processing-server')
    } catch (error) {
        logger.error({ error }, 'Reindex failed')
        throw error
    } finally {
        await DI.orm.close()
    }
}

// Run the script
reindexAllMemos()
    .then(() => {
        logger.info('Reindex script completed successfully')
        process.exit(0)
    })
    .catch((error) => {
        logger.error({ error }, 'Reindex script failed')
        process.exit(1)
    })

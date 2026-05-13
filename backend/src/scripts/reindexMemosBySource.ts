import { FilterQuery } from '@mikro-orm/core'
import { DI, initDI } from '@/di'
import { Memo } from '@/entities/Memo'
import { MemoChunk } from '@/entities/MemoChunk'
import { MemoParentChunk } from '@/entities/MemoParentChunk'
import { MemoSummary } from '@/entities/MemoSummary'
import { sendMemoForAsyncProcessing } from '@/lib/createMemoUtils'
import { logger } from '@/lib/logger'

const DEFAULT_BATCH_SIZE = 50
const BATCH_DELAY_MS = 1000

function parseSources(): string[] {
    const raw = process.env.SOURCES?.trim() ?? ''
    if (!raw) {
        throw new Error('SOURCES is required. Example: SOURCES=information,techs')
    }

    const sources = raw
        .split(',')
        .map((source) => source.trim())
        .filter(Boolean)

    if (sources.length === 0) {
        throw new Error('SOURCES must contain at least one source value')
    }

    return Array.from(new Set(sources))
}

function parseBatchSize(): number {
    const raw = process.env.BATCH_SIZE?.trim()
    if (!raw) {
        return DEFAULT_BATCH_SIZE
    }

    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid BATCH_SIZE: ${raw}`)
    }

    return parsed
}

function isDryRun(): boolean {
    return process.env.DRY_RUN === 'true'
}

function buildWhere(sources: string[]): FilterQuery<Memo> {
    return {
        client_reference_id: { $like: 'spms:%' },
        source: { $in: sources },
    }
}

async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}

async function reindexMemosBySource() {
    const sources = parseSources()
    const batchSize = parseBatchSize()
    const dryRun = isDryRun()

    logger.info({ sources, batchSize, dryRun }, 'Starting source-filtered memo reindex')

    await initDI()
    const em = DI.em.fork()
    const where = buildWhere(sources)

    try {
        const totalMemos = await em.count(Memo, where)
        logger.info({ totalMemos, sources }, 'Total memos selected for source-filtered reindex')

        if (totalMemos === 0) {
            logger.info({ sources }, 'No memos matched requested sources')
            return
        }

        if (dryRun) {
            const countsBySource = await em.getConnection().execute<{ source: string; count: string }[]>(
                `SELECT source, COUNT(*)::text AS count
                     FROM skald_memo
                     WHERE client_reference_id LIKE ?
                       AND source = ANY(?)
                     GROUP BY source
                     ORDER BY source ASC`,
                ['spms:%', sources]
            )
            logger.info({ countsBySource }, 'Dry run result for source-filtered memo reindex')
            return
        }

        let processed = 0
        let offset = 0

        while (offset < totalMemos) {
            const memos = await em.find(Memo, where, {
                limit: batchSize,
                offset,
                orderBy: { created_at: 'ASC' },
            })

            logger.info(
                {
                    batch: Math.floor(offset / batchSize) + 1,
                    count: memos.length,
                    totalMemos,
                },
                'Processing source-filtered reindex batch'
            )

            for (const memo of memos) {
                try {
                    const deletedChunks = await em.nativeDelete(MemoChunk, { memo: memo.uuid })
                    const deletedParentChunks = await em.nativeDelete(MemoParentChunk, { memo: memo.uuid })
                    const deletedSummaries = await em.nativeDelete(MemoSummary, { memo: memo.uuid })

                    memo.processing_status = 'received'
                    memo.processing_error = undefined
                    memo.processing_started_at = undefined
                    memo.processing_completed_at = undefined
                    await em.persistAndFlush(memo)

                    await sendMemoForAsyncProcessing(memo)

                    processed += 1
                    logger.info(
                        {
                            memoUuid: memo.uuid,
                            source: memo.source,
                            deletedChunks,
                            deletedParentChunks,
                            deletedSummaries,
                            progress: `${processed}/${totalMemos}`,
                        },
                        'Memo queued for source-filtered reprocessing'
                    )
                } catch (error) {
                    logger.error(
                        {
                            memoUuid: memo.uuid,
                            source: memo.source,
                            error,
                        },
                        'Failed to queue memo for source-filtered reprocessing'
                    )
                }
            }

            offset += batchSize

            if (offset < totalMemos) {
                await delay(BATCH_DELAY_MS)
            }
        }

        logger.info(
            { processed, totalMemos, sources },
            'Source-filtered reindex complete - memos queued for processing'
        )
        logger.info('Note: Actual reprocessing happens asynchronously via memo-processing-server')
    } catch (error) {
        logger.error(
            {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
                sources,
            },
            'Source-filtered reindex failed'
        )
        throw error
    } finally {
        await DI.orm.close()
    }
}

reindexMemosBySource()
    .then(() => {
        logger.info('Source-filtered reindex script completed successfully')
        process.exit(0)
    })
    .catch((error) => {
        logger.error(
            {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
            },
            'Source-filtered reindex script failed'
        )
        process.exit(1)
    })

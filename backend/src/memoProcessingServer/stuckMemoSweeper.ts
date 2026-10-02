import { EntityManager, MikroORM } from '@mikro-orm/core'
import { logger } from '@/lib/logger'

/**
 * Stuck memo sweeper
 *
 * A memo is persisted as `received` before its queue message is published. If the broker
 * restarts or the publish fails, the memo stays `received` forever (shown as "processing" in
 * the UI) and never gets chunks. This sweeper periodically re-publishes such memos while the
 * queue is idle, and gives up after a retry window by marking them `error`.
 *
 * Retry bookkeeping lives in memo metadata (`stuck_retry_first_at`, `stuck_retry_last_at`,
 * `stuck_retry_count`) and is cleared by processMemo once the memo is actually processed.
 */

export interface StuckMemoSweepOptions {
    receivedStaleMinutes: number
    processingStaleMinutes: number
    retryIntervalMinutes: number
    retryWindowHours: number
    batchSize: number
}

export interface StuckMemoSweepDeps {
    getReadyMessageCount: () => Promise<number>
    publish: (memoUuid: string) => Promise<void>
}

export interface StuckMemoSweepResult {
    skipped: boolean
    requeued: string[]
    exhausted: string[]
}

export const STUCK_RETRY_METADATA_RESET = {
    stuck_retry_first_at: null,
    stuck_retry_last_at: null,
    stuck_retry_count: null,
}

export const STUCK_RETRY_EXHAUSTED_ERROR = 'Processing did not start within the stuck-memo retry window'

const EXHAUST_SQL = `
    UPDATE skald_memo
    SET processing_status = 'error',
        processing_error = ?,
        processing_completed_at = now(),
        updated_at = now()
    WHERE processing_status IN ('received', 'processing')
      AND (metadata->>'stuck_retry_first_at') IS NOT NULL
      AND (metadata->>'stuck_retry_first_at')::timestamptz < now() - make_interval(hours => ?)
    RETURNING uuid`

const CLAIM_SQL = `
    WITH candidates AS (
        SELECT uuid
        FROM skald_memo
        WHERE (
                (processing_status = 'received'
                    AND GREATEST(created_at, updated_at) < now() - make_interval(mins => ?))
             OR (processing_status = 'processing'
                    AND COALESCE(processing_started_at, updated_at) < now() - make_interval(mins => ?))
              )
          AND COALESCE((metadata->>'stuck_retry_last_at')::timestamptz, '-infinity'::timestamptz)
                < now() - make_interval(mins => ?)
        ORDER BY created_at ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED
    )
    UPDATE skald_memo m
    SET metadata = COALESCE(m.metadata, '{}'::jsonb) || jsonb_build_object(
            'stuck_retry_first_at', COALESCE(m.metadata->>'stuck_retry_first_at', now()::text),
            'stuck_retry_last_at', now()::text,
            'stuck_retry_count', COALESCE((m.metadata->>'stuck_retry_count')::int, 0) + 1
        )
    FROM candidates c
    WHERE m.uuid = c.uuid
    RETURNING m.uuid`

export async function sweepStuckMemos(
    em: EntityManager,
    options: StuckMemoSweepOptions,
    deps: StuckMemoSweepDeps
): Promise<StuckMemoSweepResult> {
    const conn = em.getConnection()

    const exhaustedRows = await conn.execute<Array<{ uuid: string }>>(EXHAUST_SQL, [
        STUCK_RETRY_EXHAUSTED_ERROR,
        options.retryWindowHours,
    ])
    const exhausted = exhaustedRows.map((row: { uuid: string }) => row.uuid)
    if (exhausted.length > 0) {
        logger.warn(
            { count: exhausted.length, memoUuids: exhausted.slice(0, 20), retryWindowHours: options.retryWindowHours },
            'Stuck memo sweep: retry window exhausted, marked memos as error'
        )
    }

    const readyMessages = await deps.getReadyMessageCount()
    if (readyMessages > 0) {
        logger.debug({ readyMessages }, 'Stuck memo sweep: queue is not idle, skipping re-publish')
        return { skipped: true, requeued: [], exhausted }
    }

    const claimedRows = await conn.execute<Array<{ uuid: string }>>(CLAIM_SQL, [
        options.receivedStaleMinutes,
        options.processingStaleMinutes,
        options.retryIntervalMinutes,
        options.batchSize,
    ])

    const requeued: string[] = []
    for (const { uuid } of claimedRows) {
        try {
            await deps.publish(uuid)
            requeued.push(uuid)
        } catch (error) {
            // The claim already recorded stuck_retry_last_at, so this memo is retried next interval.
            logger.error({ err: error, memoUuid: uuid }, 'Stuck memo sweep: failed to re-publish memo')
        }
    }

    if (claimedRows.length > 0) {
        logger.info(
            { claimed: claimedRows.length, requeued: requeued.length },
            'Stuck memo sweep: re-published stuck memos'
        )
    }

    return { skipped: false, requeued, exhausted }
}

export function startStuckMemoSweeper(
    orm: MikroORM,
    options: StuckMemoSweepOptions,
    intervalMinutes: number,
    deps: StuckMemoSweepDeps
): () => void {
    let running = false
    const timer = setInterval(async () => {
        if (running) {
            return
        }
        running = true
        try {
            await sweepStuckMemos(orm.em.fork(), options, deps)
        } catch (error) {
            logger.error({ err: error }, 'Stuck memo sweep failed')
        } finally {
            running = false
        }
    }, intervalMinutes * 60_000)

    logger.info({ intervalMinutes, ...options }, 'Stuck memo sweeper started')
    return () => clearInterval(timer)
}

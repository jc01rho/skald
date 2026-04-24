/**
 * Cleanup duplicate parent/child chunks caused by missing delete-before-reprocess.
 * Keeps one parent per (memo_id, chunk_index) — largest UUID as deterministic tiebreaker.
 * Child chunks referencing deleted parents, or duplicate children, are also removed.
 *
 * Usage:
 *   npx ts-node src/scripts/cleanupDuplicateChunks.ts           # dry-run
 *   npx ts-node src/scripts/cleanupDuplicateChunks.ts --execute # actually delete
 */
import { MikroORM } from '@mikro-orm/core'
import { logger } from '@/lib/logger'

async function main() {
    const execute = process.argv.includes('--execute')

    logger.info({ mode: execute ? 'EXECUTE' : 'DRY-RUN' }, 'Starting duplicate chunk cleanup')

    const orm = await MikroORM.init()
    const conn = orm.em.getConnection()

    const [parentCount] = await conn.execute<{ count: string }>(
        `SELECT count(*)::text AS count FROM skald_memoparentchunk`
    )
    const [childCount] = await conn.execute<{ count: string }>(`SELECT count(*)::text AS count FROM skald_memochunk`)
    const [memoCount] = await conn.execute<{ count: string }>(
        `SELECT count(DISTINCT memo_id)::text AS count FROM skald_memoparentchunk`
    )

    logger.info(
        {
            parentChunks: Number(parentCount.count),
            childChunks: Number(childCount.count),
            memosWithParents: Number(memoCount.count),
        },
        'Current state'
    )

    // UUID v4 is not time-ordered; largest UUID is used as deterministic tiebreaker only.
    const [duplicateParents] = await conn.execute<{ count: string }>(`
        SELECT count(*)::text AS count FROM skald_memoparentchunk p
        WHERE p.uuid NOT IN (
            SELECT DISTINCT ON (memo_id, chunk_index) uuid
            FROM skald_memoparentchunk
            ORDER BY memo_id, chunk_index, uuid DESC
        )
    `)

    const duplicateParentCount = Number(duplicateParents.count)
    logger.info({ duplicateParentCount }, 'Duplicate parent chunks to delete')

    const [orphanChildren] = await conn.execute<{ count: string }>(`
        SELECT count(*)::text AS count FROM skald_memochunk c
        WHERE c.parent_chunk_id IS NOT NULL
          AND c.parent_chunk_id NOT IN (
            SELECT DISTINCT ON (memo_id, chunk_index) uuid
            FROM skald_memoparentchunk
            ORDER BY memo_id, chunk_index, uuid DESC
          )
    `)

    const orphanChildCount = Number(orphanChildren.count)
    logger.info({ orphanChildCount }, 'Child chunks with duplicate parents to delete')

    const [duplicateChildren] = await conn.execute<{ count: string }>(`
        SELECT count(*)::text AS count FROM skald_memochunk c
        WHERE c.uuid NOT IN (
            SELECT DISTINCT ON (memo_id, chunk_index) uuid
            FROM skald_memochunk
            ORDER BY memo_id, chunk_index, uuid DESC
        )
        AND c.parent_chunk_id IN (
            SELECT DISTINCT ON (memo_id, chunk_index) uuid
            FROM skald_memoparentchunk
            ORDER BY memo_id, chunk_index, uuid DESC
        )
    `)

    const duplicateChildCount = Number(duplicateChildren.count)
    logger.info({ duplicateChildCount }, 'Duplicate child chunks to delete')

    const [noParentChildren] = await conn.execute<{ count: string }>(`
        SELECT count(*)::text AS count FROM skald_memochunk c
        WHERE c.parent_chunk_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM skald_memoparentchunk p WHERE p.uuid = c.parent_chunk_id
          )
    `)

    const noParentChildCount = Number(noParentChildren.count)
    logger.info({ noParentChildCount }, 'Child chunks with missing parent to delete')

    const totalChildrenToDelete = orphanChildCount + duplicateChildCount + noParentChildCount
    const totalToDelete = duplicateParentCount + totalChildrenToDelete

    logger.info(
        {
            duplicateParents: duplicateParentCount,
            orphanChildren: orphanChildCount,
            duplicateChildren: duplicateChildCount,
            noParentChildren: noParentChildCount,
            total: totalToDelete,
        },
        `Summary: ${execute ? 'DELETING' : 'would delete'} ${totalToDelete} rows`
    )

    if (!execute) {
        logger.info('Dry-run complete. Run with --execute to perform deletion.')
        await orm.close()
        return
    }

    const BATCH_SIZE = 5000

    let deletedOrphanChildren = 0
    for (;;) {
        const result = await conn.execute(`
            DELETE FROM skald_memochunk
            WHERE uuid IN (
                SELECT c.uuid FROM skald_memochunk c
                WHERE c.parent_chunk_id IS NOT NULL
                  AND c.parent_chunk_id NOT IN (
                    SELECT DISTINCT ON (memo_id, chunk_index) uuid
                    FROM skald_memoparentchunk
                    ORDER BY memo_id, chunk_index, uuid DESC
                  )
                LIMIT ${BATCH_SIZE}
            )
        `)
        deletedOrphanChildren += result.rowCount ?? 0
        logger.info({ deleted: result.rowCount, totalSoFar: deletedOrphanChildren }, 'Deleted orphan children batch')
        if ((result.rowCount ?? 0) < BATCH_SIZE) break
    }

    let deletedNoParentChildren = 0
    for (;;) {
        const result = await conn.execute(`
            DELETE FROM skald_memochunk
            WHERE uuid IN (
                SELECT c.uuid FROM skald_memochunk c
                WHERE c.parent_chunk_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM skald_memoparentchunk p WHERE p.uuid = c.parent_chunk_id
                  )
                LIMIT ${BATCH_SIZE}
            )
        `)
        deletedNoParentChildren += result.rowCount ?? 0
        logger.info(
            { deleted: result.rowCount, totalSoFar: deletedNoParentChildren },
            'Deleted no-parent children batch'
        )
        if ((result.rowCount ?? 0) < BATCH_SIZE) break
    }

    let deletedDuplicateChildren = 0
    for (;;) {
        const result = await conn.execute(`
            DELETE FROM skald_memochunk
            WHERE uuid IN (
                SELECT c.uuid FROM skald_memochunk c
                WHERE c.uuid NOT IN (
                    SELECT DISTINCT ON (memo_id, chunk_index) uuid
                    FROM skald_memochunk
                    ORDER BY memo_id, chunk_index, uuid DESC
                )
                LIMIT ${BATCH_SIZE}
            )
        `)
        deletedDuplicateChildren += result.rowCount ?? 0
        logger.info(
            { deleted: result.rowCount, totalSoFar: deletedDuplicateChildren },
            'Deleted duplicate children batch'
        )
        if ((result.rowCount ?? 0) < BATCH_SIZE) break
    }

    // FK: children reference parents — must delete children first
    let deletedParents = 0
    for (;;) {
        const result = await conn.execute(`
            DELETE FROM skald_memoparentchunk
            WHERE uuid IN (
                SELECT p.uuid FROM skald_memoparentchunk p
                WHERE p.uuid NOT IN (
                    SELECT DISTINCT ON (memo_id, chunk_index) uuid
                    FROM skald_memoparentchunk
                    ORDER BY memo_id, chunk_index, uuid DESC
                )
                LIMIT ${BATCH_SIZE}
            )
        `)
        deletedParents += result.rowCount ?? 0
        logger.info({ deleted: result.rowCount, totalSoFar: deletedParents }, 'Deleted duplicate parents batch')
        if ((result.rowCount ?? 0) < BATCH_SIZE) break
    }

    const [finalParentCount] = await conn.execute<{ count: string }>(
        `SELECT count(*)::text AS count FROM skald_memoparentchunk`
    )
    const [finalChildCount] = await conn.execute<{ count: string }>(
        `SELECT count(*)::text AS count FROM skald_memochunk`
    )

    logger.info(
        {
            deletedOrphanChildren,
            deletedNoParentChildren,
            deletedDuplicateChildren,
            deletedParents,
            finalParentChunks: Number(finalParentCount.count),
            finalChildChunks: Number(finalChildCount.count),
        },
        'Cleanup complete'
    )

    await orm.close()
}

main().catch((err) => {
    logger.error({ err }, 'Cleanup script failed')
    process.exit(1)
})

/**
 * Backfill `embedding_v2` (vector(512)) for memo chunks and summaries that do not have it yet.
 *
 * - Idempotent/resumable: only rows WHERE embedding_v2 IS NULL are selected and updated; rerun at any time.
 * - Keyset pagination by uuid, so a single pass always terminates.
 * - Chunks are embedded with the same title-prefixed text the write path uses (buildContextualContent).
 * - A batch is retried MAX_ATTEMPTS times with exponential backoff; persistent failure exits non-zero.
 * - After a successful pass, builds idx_memochunk_embedding_v2_hnsw with CREATE INDEX CONCURRENTLY
 *   (idempotent; required before EMBEDDING_READ_VERSION=v2). SKIP_INDEX=true skips this step.
 *
 * Env: EMBEDDING_V2_URL (required), BATCH_SIZE (default 16), MAX_ATTEMPTS (default 5),
 *      RETRY_BASE_DELAY_MS (default 2000), BACKFILL_TARGETS (default "chunks,summaries").
 * Run in the api pod: node dist/scripts/backfillEmbeddingV2.js
 */
import { EntityManager } from '@mikro-orm/core'
import { DI, initDI } from '@/di'
import { logger } from '@/lib/logger'
import { buildContextualContent } from '@/memoProcessingServer/memoOperations'
import { EmbeddingService } from '@/services/embeddingService'
import { EMBEDDING_V2_URL } from '@/settings'
import { HNSWOptimizationService } from '@/lib/hnswOptimization'

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
    const parsed = parseInt(value ?? '', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const BATCH_SIZE = parsePositiveInt(process.env.BATCH_SIZE, 16)
const MAX_ATTEMPTS = parsePositiveInt(process.env.MAX_ATTEMPTS, 5)
const RETRY_BASE_DELAY_MS = parsePositiveInt(process.env.RETRY_BASE_DELAY_MS, 2000)
const MIN_UUID = '00000000-0000-0000-0000-000000000000'

interface BackfillRow {
    uuid: string
    text: string | null
    title?: string | null
}

interface BackfillTarget {
    name: 'chunks' | 'summaries'
    table: 'skald_memochunk' | 'skald_memosummary'
    selectSql: string
    toEmbeddingText: (row: BackfillRow) => string
}

const TARGETS: BackfillTarget[] = [
    {
        name: 'chunks',
        table: 'skald_memochunk',
        selectSql: `
            SELECT c.uuid, c.chunk_content AS text, m.title
            FROM skald_memochunk c
            JOIN skald_memo m ON m.uuid = c.memo_id
            WHERE c.embedding_v2 IS NULL AND c.uuid > ?
            ORDER BY c.uuid
            LIMIT ?
        `,
        toEmbeddingText: (row) => buildContextualContent(row.text ?? '', row.title ?? null),
    },
    {
        name: 'summaries',
        table: 'skald_memosummary',
        selectSql: `
            SELECT s.uuid, s.summary AS text
            FROM skald_memosummary s
            WHERE s.embedding_v2 IS NULL AND s.uuid > ?
            ORDER BY s.uuid
            LIMIT ?
        `,
        toEmbeddingText: (row) => row.text ?? '',
    },
]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function embedWithRetry(texts: string[], context: Record<string, unknown>): Promise<number[][]> {
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await EmbeddingService.generateEmbeddingsBatchV2(texts, { useCache: false })
        } catch (error) {
            lastError = error
            logger.warn({ err: error, attempt, maxAttempts: MAX_ATTEMPTS, ...context }, 'Embedding v2 batch failed')
            if (attempt < MAX_ATTEMPTS) {
                await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function backfillTarget(em: EntityManager, target: BackfillTarget): Promise<number> {
    const connection = em.getConnection()
    const [{ count }] = await connection.execute<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM ${target.table} WHERE embedding_v2 IS NULL`
    )
    const pending = parseInt(count, 10)
    logger.info({ target: target.name, pending, batchSize: BATCH_SIZE }, 'Embedding v2 backfill: starting target')

    let lastUuid = MIN_UUID
    let updated = 0
    const startedAt = Date.now()

    for (;;) {
        const rows = await connection.execute<BackfillRow[]>(target.selectSql, [lastUuid, BATCH_SIZE])
        if (rows.length === 0) break
        lastUuid = rows[rows.length - 1].uuid

        const embeddings = await embedWithRetry(rows.map(target.toEmbeddingText), {
            target: target.name,
            firstUuid: rows[0].uuid,
            lastUuid,
        })

        for (let i = 0; i < rows.length; i++) {
            const result = await connection.execute(
                `UPDATE ${target.table} SET embedding_v2 = ?::vector(512) WHERE uuid = ? AND embedding_v2 IS NULL`,
                [JSON.stringify(embeddings[i]), rows[i].uuid],
                'run'
            )
            updated += (result as { affectedRows?: number }).affectedRows ?? 0
        }

        const elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000)
        logger.info(
            {
                target: target.name,
                updated,
                pending,
                progress: pending > 0 ? `${Math.min(100, (updated / pending) * 100).toFixed(1)}%` : '100%',
                rowsPerSec: (updated / elapsedSec).toFixed(1),
                lastUuid,
            },
            'Embedding v2 backfill: batch done'
        )
    }

    logger.info({ target: target.name, updated }, 'Embedding v2 backfill: target complete')
    return updated
}

async function backfillEmbeddingV2(): Promise<void> {
    if (!EMBEDDING_V2_URL) {
        throw new Error('EMBEDDING_V2_URL is not set; nothing to backfill against')
    }
    const requested = (process.env.BACKFILL_TARGETS || 'chunks,summaries').split(',').map((s) => s.trim())
    const targets = TARGETS.filter((t) => requested.includes(t.name))
    if (targets.length === 0) {
        throw new Error(`BACKFILL_TARGETS matched no targets: ${requested.join(',')}`)
    }

    await initDI()
    try {
        const em = DI.em.fork()
        for (const target of targets) {
            await backfillTarget(em, target)
        }
        if (process.env.SKIP_INDEX !== 'true') {
            await HNSWOptimizationService.ensureEmbeddingV2Index(em)
        }
    } finally {
        await DI.orm.close()
    }
}

backfillEmbeddingV2()
    .then(() => {
        logger.info('Embedding v2 backfill completed successfully')
        process.exit(0)
    })
    .catch((error) => {
        logger.error({ err: error }, 'Embedding v2 backfill failed')
        process.exit(1)
    })

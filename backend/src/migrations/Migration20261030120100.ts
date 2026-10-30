import { Migration } from '@mikro-orm/migrations'

/**
 * Embedding v2 HNSW index (cosine) on skald_memochunk.embedding_v2.
 *
 * Not CONCURRENTLY: mikro-orm.config.ts runs migrations with `allOrNothing: true` (one master transaction for
 * all pending migrations). CONCURRENTLY cannot run inside a transaction, and opting out via
 * isTransactional() = false makes MikroORM 6 execute the SQL on a separate pooled connection outside the master
 * transaction, which would block forever on the ACCESS EXCLUSIVE lock held by the uncommitted ALTER TABLE of
 * Migration20261030120000 when both are pending in the same run (self-deadlock).
 * A plain CREATE INDEX is cheap here: it runs right after the column is added, while every embedding_v2 is
 * NULL (HNSW skips NULLs), so the build is one heap scan with no graph construction. The index is then
 * maintained incrementally by dual-write and backfillEmbeddingV2.
 */
export class Migration20261030120100 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`
            CREATE INDEX IF NOT EXISTS idx_memochunk_embedding_v2_hnsw
            ON skald_memochunk
            USING hnsw (embedding_v2 vector_cosine_ops)
            WITH (m = 24, ef_construction = 256)
        `)
    }

    override async down(): Promise<void> {
        this.addSql(`DROP INDEX IF EXISTS idx_memochunk_embedding_v2_hnsw;`)
    }
}

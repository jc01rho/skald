import { Migration } from '@mikro-orm/migrations'

/**
 * Embedding v1 removal, phase 1: the app no longer writes the legacy `embedding` vector(2048) column,
 * so it must accept NULL. DROP NOT NULL is a catalog-only change (no table scan/rewrite).
 * Pods from the previous release may still insert into `embedding` during a rolling deploy; that stays valid.
 * The columns and the halfvec HNSW index are dropped in a later phase.
 * lock_timeout makes the ALTER fail fast instead of queueing reads behind its ACCESS EXCLUSIVE lock.
 */
export class Migration20261030150000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`set local lock_timeout = '10s';`)
        this.addSql(`alter table "skald_memochunk" alter column "embedding" drop not null;`)
        this.addSql(`alter table "skald_memosummary" alter column "embedding" drop not null;`)
    }

    // Fails if rows without a v1 embedding exist (expected once the v1-free release has written any).
    override async down(): Promise<void> {
        this.addSql(`set local lock_timeout = '10s';`)
        this.addSql(`alter table "skald_memosummary" alter column "embedding" set not null;`)
        this.addSql(`alter table "skald_memochunk" alter column "embedding" set not null;`)
    }
}

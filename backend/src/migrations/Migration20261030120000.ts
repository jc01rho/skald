import { Migration } from '@mikro-orm/migrations'

/**
 * Embedding v2 (512-dim) dual-write: add nullable columns.
 * Nullable ADD COLUMN without default is a metadata-only change in PostgreSQL (no table rewrite).
 * lock_timeout makes the ALTER fail fast instead of queueing all reads behind its ACCESS EXCLUSIVE lock
 * when a long-running query holds the table (SET LOCAL scopes it to the migration transaction).
 */
export class Migration20261030120000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`set local lock_timeout = '10s';`)
        this.addSql(`alter table "skald_memochunk" add column if not exists "embedding_v2" vector(512) null;`)
        this.addSql(`alter table "skald_memosummary" add column if not exists "embedding_v2" vector(512) null;`)
    }

    override async down(): Promise<void> {
        this.addSql(`alter table "skald_memosummary" drop column if exists "embedding_v2";`)
        this.addSql(`alter table "skald_memochunk" drop column if exists "embedding_v2";`)
    }
}

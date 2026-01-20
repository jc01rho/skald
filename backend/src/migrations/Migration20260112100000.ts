import { Migration } from '@mikro-orm/migrations'

/**
 * Migration for parent-child chunking feature.
 *
 * Creates MemoParentChunk table and adds parent_chunk_id FK to MemoChunk.
 * This enables storing larger context chunks (parents) that contain
 * smaller searchable chunks (children).
 */
export class Migration20260112100000 extends Migration {
    override async up(): Promise<void> {
        // Create the parent chunk table
        this.addSql(`
            CREATE TABLE "skald_memoparentchunk" (
                "uuid" UUID NOT NULL,
                "chunk_content" TEXT NOT NULL,
                "chunk_index" INTEGER NOT NULL,
                "memo_uuid" UUID NOT NULL,
                "project_uuid" UUID NOT NULL,
                "memo_id" UUID NOT NULL,
                "project_id" UUID NOT NULL,
                CONSTRAINT "skald_memoparentchunk_pkey" PRIMARY KEY ("uuid")
            );
        `)

        // Create indexes for parent chunk
        this.addSql(`CREATE INDEX "skald_memoparentchunk_memo_id" ON "skald_memoparentchunk" ("memo_id");`)
        this.addSql(`CREATE INDEX "skald_memoparentchunk_project_id" ON "skald_memoparentchunk" ("project_id");`)

        // Add foreign keys for parent chunk
        this.addSql(`
            ALTER TABLE "skald_memoparentchunk"
            ADD CONSTRAINT "skald_memoparentchunk_memo_id_foreign"
            FOREIGN KEY ("memo_id") REFERENCES "skald_memo" ("uuid")
            ON UPDATE CASCADE ON DELETE CASCADE
            DEFERRABLE INITIALLY DEFERRED;
        `)
        this.addSql(`
            ALTER TABLE "skald_memoparentchunk"
            ADD CONSTRAINT "skald_memoparentchunk_project_id_foreign"
            FOREIGN KEY ("project_id") REFERENCES "skald_project" ("uuid")
            ON UPDATE CASCADE ON DELETE CASCADE
            DEFERRABLE INITIALLY DEFERRED;
        `)

        // Add parent_chunk_id column to memo chunk (nullable for backward compatibility)
        this.addSql(`
            ALTER TABLE "skald_memochunk"
            ADD COLUMN "parent_chunk_uuid" UUID NULL;
        `)
        this.addSql(`
            ALTER TABLE "skald_memochunk"
            ADD COLUMN "parent_chunk_id" UUID NULL;
        `)

        // Create index for parent_chunk_id
        this.addSql(`CREATE INDEX "skald_memochunk_parent_chunk_id" ON "skald_memochunk" ("parent_chunk_id");`)

        // Add foreign key for parent_chunk_id
        this.addSql(`
            ALTER TABLE "skald_memochunk"
            ADD CONSTRAINT "skald_memochunk_parent_chunk_id_foreign"
            FOREIGN KEY ("parent_chunk_id") REFERENCES "skald_memoparentchunk" ("uuid")
            ON UPDATE CASCADE ON DELETE SET NULL
            DEFERRABLE INITIALLY DEFERRED;
        `)
    }

    override async down(): Promise<void> {
        // Remove foreign key and column from memo chunk
        this.addSql(`
            ALTER TABLE "skald_memochunk"
            DROP CONSTRAINT IF EXISTS "skald_memochunk_parent_chunk_id_foreign";
        `)
        this.addSql(`DROP INDEX IF EXISTS "skald_memochunk_parent_chunk_id";`)
        this.addSql(`ALTER TABLE "skald_memochunk" DROP COLUMN IF EXISTS "parent_chunk_id";`)
        this.addSql(`ALTER TABLE "skald_memochunk" DROP COLUMN IF EXISTS "parent_chunk_uuid";`)

        // Drop parent chunk table
        this.addSql(`DROP TABLE IF EXISTS "skald_memoparentchunk";`)
    }
}

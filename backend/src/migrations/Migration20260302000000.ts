import { Migration } from '@mikro-orm/migrations'

export class Migration20260302000000 extends Migration {
    async up(): Promise<void> {
        // Add a generated tsvector column for English full-text search.
        // This avoids recomputing to_tsvector('english', chunk_content) on every query.
        this.addSql(`
            ALTER TABLE skald_memochunk
            ADD COLUMN IF NOT EXISTS content_tsvector tsvector
            GENERATED ALWAYS AS (to_tsvector('english', coalesce(chunk_content, ''))) STORED
        `)

        // Create a GIN index on the generated tsvector column for fast full-text search.
        this.addSql(`
            CREATE INDEX IF NOT EXISTS idx_memochunk_content_tsvector
            ON skald_memochunk
            USING gin (content_tsvector)
        `)

        this.addSql(`
            COMMENT ON COLUMN skald_memochunk.content_tsvector
            IS 'Generated tsvector column for English full-text search (P1-2 optimization)'
        `)
    }

    async down(): Promise<void> {
        this.addSql(`
            DROP INDEX IF EXISTS idx_memochunk_content_tsvector
        `)

        this.addSql(`
            ALTER TABLE skald_memochunk
            DROP COLUMN IF EXISTS content_tsvector
        `)
    }
}

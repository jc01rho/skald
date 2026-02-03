import { Migration } from '@mikro-orm/migrations'

export class Migration20260203000001 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            -- Enable pg_trgm extension for trigram similarity search
            CREATE EXTENSION IF NOT EXISTS pg_trgm
        `)

        this.addSql(`
            -- Create GIN index on chunk_content for trigram similarity search
            -- This enables efficient LIKE and similarity queries for CJK languages
            CREATE INDEX idx_memochunk_content_trgm 
            ON skald_memochunk 
            USING gin (chunk_content gin_trgm_ops)
        `)

        this.addSql(`
            -- Add comment for documentation
            COMMENT ON INDEX idx_memochunk_content_trgm 
            IS 'Trigram index for CJK language text search (Korean, Japanese, Chinese)'
        `)
    }

    async down(): Promise<void> {
        this.addSql(`
            DROP INDEX IF EXISTS idx_memochunk_content_trgm
        `)
    }
}

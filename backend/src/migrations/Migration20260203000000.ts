import { Migration } from '@mikro-orm/migrations'

export class Migration20260203000000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            -- Drop existing HNSW index if present
            DROP INDEX IF EXISTS idx_memochunk_embedding_hnsw
        `)

        this.addSql(`
            -- Create optimized HNSW index with production-ready parameters
            -- m=24: Higher connectivity for better recall
            -- ef_construction=256: Higher quality index build
            CREATE INDEX idx_memochunk_embedding_hnsw_optimized 
            ON skald_memochunk 
            USING hnsw (embedding vector_cosine_ops)
            WITH (m = 24, ef_construction = 256)
        `)

        this.addSql(`
            -- Add comment for documentation
            COMMENT ON INDEX idx_memochunk_embedding_hnsw_optimized 
            IS 'Optimized HNSW index for vector search: m=24, ef_construction=256'
        `)
    }

    async down(): Promise<void> {
        this.addSql(`
            DROP INDEX IF EXISTS idx_memochunk_embedding_hnsw_optimized
        `)
    }
}

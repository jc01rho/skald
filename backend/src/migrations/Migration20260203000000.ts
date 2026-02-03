import { Migration } from '@mikro-orm/migrations'

export class Migration20260203000000 extends Migration {
    async up(): Promise<void> {
        // pgvector 0.8.x limits HNSW/IVFFlat indexes to 2000 dimensions
        // Current embeddings are 2048 dimensions, so we cannot create an index
        // This migration is a no-op until embeddings are reduced to <= 2000 dimensions
        // or pgvector is upgraded to support higher dimensions

        this.addSql(`
            -- Cleanup: Drop any existing vector indexes
            DROP INDEX IF EXISTS idx_memochunk_embedding_hnsw;
            DROP INDEX IF EXISTS idx_memochunk_embedding_ivfflat;
            DROP INDEX IF EXISTS idx_memochunk_embedding_hnsw_optimized;
        `)

        // Note: Index creation is skipped because current embeddings (2048 dims) exceed pgvector limit (2000 dims)
        // When embedding dimension is reduced, uncomment the following:
        /*
        this.addSql(`
            CREATE INDEX idx_memochunk_embedding_hnsw_optimized 
            ON skald_memochunk 
            USING hnsw (embedding vector_cosine_ops)
            WITH (m = 24, ef_construction = 256)
        `)
        */
    }

    async down(): Promise<void> {
        this.addSql(`
            DROP INDEX IF EXISTS idx_memochunk_embedding_hnsw_optimized;
            DROP INDEX IF EXISTS idx_memochunk_embedding_ivfflat;
        `)
    }
}

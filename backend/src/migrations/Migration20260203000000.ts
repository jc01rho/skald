import { Migration } from '@mikro-orm/migrations'

export class Migration20260203000000 extends Migration {
    async up(): Promise<void> {
        // halfvec (16-bit float) supports up to 4000 dimensions for HNSW index
        // Current embeddings are 2048 dimensions, so we use halfvec casting

        this.addSql(`
            DROP INDEX IF EXISTS idx_memochunk_embedding_hnsw;
            DROP INDEX IF EXISTS idx_memochunk_embedding_ivfflat;
            DROP INDEX IF EXISTS idx_memochunk_embedding_hnsw_optimized;
            DROP INDEX IF EXISTS idx_memochunk_embedding_halfvec_hnsw;
        `)

        this.addSql(`
            CREATE INDEX idx_memochunk_embedding_halfvec_hnsw 
            ON skald_memochunk 
            USING hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops)
            WITH (m = 24, ef_construction = 256)
        `)
    }

    async down(): Promise<void> {
        this.addSql(`
            DROP INDEX IF EXISTS idx_memochunk_embedding_halfvec_hnsw;
            DROP INDEX IF EXISTS idx_memochunk_embedding_hnsw_optimized;
        `)
    }
}

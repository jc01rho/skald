import { EntityManager } from '@mikro-orm/core'
import { logger } from './logger'
import { EMBEDDING_READ_VERSION, EmbeddingVersion } from '@/settings'

export interface HNSWConfig {
    m: number
    efConstruction: number
    efSearch: number
}

export const DEFAULT_HNSW_CONFIG: HNSWConfig = {
    m: 24,
    efConstruction: 256,
    efSearch: 150,
}

export const EMBEDDING_V2_INDEX_NAME = 'idx_memochunk_embedding_v2_hnsw'

export class HNSWOptimizationService {
    /**
     * Idempotently build the v2 HNSW index without blocking reads/writes (CREATE INDEX CONCURRENTLY).
     * Not a migration: migrations run in one all-or-nothing transaction, where CONCURRENTLY is impossible
     * and a plain build would hold the ALTER TABLE lock for the whole scan.
     * Must run on an autocommit connection (never inside em.transactional). An INVALID index left by an
     * interrupted concurrent build is dropped and rebuilt.
     */
    static async ensureEmbeddingV2Index(em: EntityManager, config: Partial<HNSWConfig> = {}): Promise<void> {
        const finalConfig = { ...DEFAULT_HNSW_CONFIG, ...config }
        const connection = em.getConnection()
        const existing = await connection.execute<{ valid: boolean }[]>(
            `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ?`,
            [EMBEDDING_V2_INDEX_NAME]
        )
        if (existing.length > 0 && existing[0].valid) {
            logger.info({ index: EMBEDDING_V2_INDEX_NAME }, 'Embedding v2 HNSW index already exists')
            return
        }
        if (existing.length > 0) {
            logger.warn({ index: EMBEDDING_V2_INDEX_NAME }, 'Dropping INVALID embedding v2 HNSW index before rebuild')
            await connection.execute(`DROP INDEX CONCURRENTLY IF EXISTS ${EMBEDDING_V2_INDEX_NAME}`)
        }
        logger.info({ index: EMBEDDING_V2_INDEX_NAME, config: finalConfig }, 'Building embedding v2 HNSW index concurrently')
        await connection.execute(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS ${EMBEDDING_V2_INDEX_NAME}
            ON skald_memochunk
            USING hnsw (embedding_v2 vector_cosine_ops)
            WITH (m = ${finalConfig.m}, ef_construction = ${finalConfig.efConstruction})
        `)
        logger.info({ index: EMBEDDING_V2_INDEX_NAME }, 'Embedding v2 HNSW index built')
    }

    /**
     * Create optimized HNSW index for vector search
     * Drops existing index if present and creates new optimized one
     */
    static async createOptimizedIndex(
        em: EntityManager,
        config: Partial<HNSWConfig> = {},
        version: EmbeddingVersion = EMBEDDING_READ_VERSION
    ): Promise<void> {
        const finalConfig = { ...DEFAULT_HNSW_CONFIG, ...config }

        try {
            logger.info({ config: finalConfig, version }, 'Creating optimized HNSW index')

            if (version === 'v2') {
                // v2 column is a native vector(512); only touch the v2 index so v1 stays searchable.
                await em.getConnection().execute(`DROP INDEX IF EXISTS ${EMBEDDING_V2_INDEX_NAME};`)
                await em.getConnection().execute(`
                    CREATE INDEX ${EMBEDDING_V2_INDEX_NAME}
                    ON skald_memochunk
                    USING hnsw (embedding_v2 vector_cosine_ops)
                    WITH (m = ${finalConfig.m}, ef_construction = ${finalConfig.efConstruction})
                `)
                logger.info({ config: finalConfig, version }, 'Optimized HNSW index created successfully')
                return
            }

            await em.getConnection().execute(`
                DROP INDEX IF EXISTS idx_memochunk_embedding_hnsw_optimized;
                DROP INDEX IF EXISTS idx_memochunk_embedding_halfvec_hnsw;
            `)

            await em.getConnection().execute(`
                CREATE INDEX idx_memochunk_embedding_halfvec_hnsw 
                ON skald_memochunk 
                USING hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops)
                WITH (m = ${finalConfig.m}, ef_construction = ${finalConfig.efConstruction})
            `)

            logger.info({ config: finalConfig }, 'Optimized HNSW index created successfully')
        } catch (error) {
            logger.error({ err: error }, 'Failed to create optimized HNSW index')
            throw error
        }
    }

    /**
     * Configure HNSW search settings for the current session
     */
    static async configureSearchSettings(
        em: EntityManager,
        efSearch: number = DEFAULT_HNSW_CONFIG.efSearch
    ): Promise<void> {
        try {
            await em.getConnection().execute("SELECT set_config('hnsw.ef_search', ?, false)", [String(efSearch)])

            logger.debug({ efSearch }, 'HNSW search settings configured')
        } catch (error) {
            logger.error({ err: error }, 'Failed to configure HNSW search settings')
            throw error
        }
    }

    /**
     * Apply runtime HNSW tuning based on search parameters.
     * ef_search is dynamically scaled based on topK to ensure good recall.
     * Rule of thumb: ef_search >= topK * 2 for high recall.
     */
    static async applyRuntimeSearchTuning(em: EntityManager, topK: number = 50): Promise<void> {
        // P2-2: Dynamic ef_search based on topK
        const minEfSearch = DEFAULT_HNSW_CONFIG.efSearch
        const dynamicEfSearch = Math.max(minEfSearch, topK * 2)

        try {
            await em
                .getConnection()
                .execute("SELECT set_config('hnsw.ef_search', ?, false)", [String(dynamicEfSearch)])
            logger.debug({ efSearch: dynamicEfSearch, topK }, 'HNSW ef_search configured dynamically')
        } catch (error) {
            logger.warn({ err: error }, 'Failed to apply hnsw.ef_search runtime tuning')
        }

        try {
            await em.getConnection().execute("SELECT set_config('hnsw.iterative_scan', ?, false)", ['strict_order'])
        } catch (error) {
            logger.warn({ err: error }, 'Failed to apply hnsw.iterative_scan runtime tuning')
        }

        try {
            await em.getConnection().execute("SELECT set_config('ivfflat.probes', ?, false)", ['10'])
        } catch (error) {
            logger.warn({ err: error }, 'Failed to apply ivfflat.probes runtime tuning')
        }
    }

    /**
     * Get current HNSW configuration
     */
    static async getCurrentConfig(em: EntityManager): Promise<Partial<HNSWConfig>> {
        try {
            const result = await em.getConnection().execute(`
                SELECT 
                    (SELECT setting FROM pg_settings WHERE name = 'hnsw.ef_search') as ef_search
            `)

            return {
                efSearch: parseInt(result[0].ef_search, 10),
            }
        } catch (error) {
            logger.error({ err: error }, 'Failed to get current HNSW config')
            return {}
        }
    }
}

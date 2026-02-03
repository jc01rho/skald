import { EntityManager } from '@mikro-orm/core'
import { logger } from './logger'

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

export class HNSWOptimizationService {
    /**
     * Create optimized HNSW index for vector search
     * Drops existing index if present and creates new optimized one
     */
    static async createOptimizedIndex(em: EntityManager, config: Partial<HNSWConfig> = {}): Promise<void> {
        const finalConfig = { ...DEFAULT_HNSW_CONFIG, ...config }

        try {
            logger.info({ config: finalConfig }, 'Creating optimized HNSW index')

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
            await em.getConnection().execute(`
                SET hnsw.ef_search = ${efSearch}
            `)

            logger.debug({ efSearch }, 'HNSW search settings configured')
        } catch (error) {
            logger.error({ err: error }, 'Failed to configure HNSW search settings')
            throw error
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

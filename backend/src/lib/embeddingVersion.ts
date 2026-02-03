import { logger } from './logger'

export type EmbeddingModel = 'legacy'

export interface EmbeddingVersionConfig {
    version: EmbeddingModel
    dimension: number
    enabled: boolean
}

export const EMBEDDING_VERSIONS: Record<EmbeddingModel, EmbeddingVersionConfig> = {
    legacy: {
        version: 'legacy',
        dimension: 2048,
        enabled: true,
    },
}

export interface EmbeddingMigrationStatus {
    totalChunks: number
    migratedChunks: number
    pendingChunks: number
    failedChunks: number
    progress: number
}

/**
 * Get embedding version configuration
 */
export function getEmbeddingVersionConfig(version: EmbeddingModel): EmbeddingVersionConfig {
    return EMBEDDING_VERSIONS[version] || EMBEDDING_VERSIONS.legacy
}

/**
 * Check if embedding version is enabled
 */
export function isEmbeddingVersionEnabled(version: EmbeddingModel): boolean {
    return EMBEDDING_VERSIONS[version]?.enabled ?? false
}

/**
 * Enable embedding version for A/B testing
 */
export function enableEmbeddingVersion(version: EmbeddingModel): void {
    if (EMBEDDING_VERSIONS[version]) {
        EMBEDDING_VERSIONS[version].enabled = true
        logger.info({ version }, 'Embedding version enabled')
    }
}

/**
 * Select embedding model based on experiment flags
 */
export function selectEmbeddingModel(flags: { experiment?: string; userId?: string }): EmbeddingModel {
    return 'legacy'
}

/**
 * Migrate embeddings in batches
 */
export async function migrateEmbeddings(
    fromVersion: EmbeddingModel,
    toVersion: EmbeddingModel,
    batchSize: number = 100
): Promise<EmbeddingMigrationStatus> {
    logger.info({ fromVersion, toVersion, batchSize }, 'Starting embedding migration')

    return {
        totalChunks: 0,
        migratedChunks: 0,
        pendingChunks: 0,
        failedChunks: 0,
        progress: 0,
    }
}

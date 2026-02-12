import { RAGConfig } from '@/agents/chatAgent/ragGraph'
import { LLM_PROVIDER, SUPPORTED_LLM_PROVIDERS } from '@/settings'
import { AVAILABLE_LLM_PROVIDERS } from '@/api/config'

export function parseRagConfig(ragConfig: Record<string, any>): {
    parsedRagConfig: RAGConfig | null
    error: string | null
} {
    const defaults = {
        queryRewriteEnabled: true,
        queryRewriteMultiQuery: false,
        queryRewriteHydeEnabled: false,
        rerankingEnabled: true,
        vectorSearchTopK: 50,
        similarityThreshold: 0.65,
        rerankingTopK: 25,
        rerankingMmrEnabled: true,
        rerankingMmrLambda: 0.5,
        referencesEnabled: false,
        hybridSearchEnabled: true,
        hybridSearchVectorWeight: 0.7,
        hybridSearchBm25Weight: 0.3,
        selfRagEnabled: false,
        selfRagQualityThreshold: 0.75,
        selfRagRollbackThreshold: -0.1,
        fallbackSearchEnabled: true,
        fallbackTriggerThreshold: 0.4,
        fallbackExpandedTopK: 3,
        fallbackLoweredThreshold: 0.45,
        fallbackEnableMultiQuery: true,
    }

    const llmProvider = ragConfig.llm_provider || ragConfig.llmProvider || LLM_PROVIDER

    const validProviders =
        AVAILABLE_LLM_PROVIDERS.length > 0 ? AVAILABLE_LLM_PROVIDERS.map((p) => p.provider) : SUPPORTED_LLM_PROVIDERS

    if (!validProviders.includes(llmProvider)) {
        return {
            parsedRagConfig: null,
            error: `Invalid LLM provider: ${llmProvider}. Supported providers: ${validProviders.join(', ')}`,
        }
    }

    // queryRewriteEnabled must be a boolean (snake_case only)
    const queryRewriteEnabled = ragConfig.query_rewrite?.enabled ?? defaults.queryRewriteEnabled
    if (typeof queryRewriteEnabled !== 'boolean') {
        return {
            parsedRagConfig: null,
            error: `Invalid query rewrite enabled: ${queryRewriteEnabled}. Must be a boolean.`,
        }
    }

    // queryRewriteMultiQuery must be a boolean (snake_case only)
    const queryRewriteMultiQuery = ragConfig.query_rewrite?.multi_query ?? defaults.queryRewriteMultiQuery
    if (typeof queryRewriteMultiQuery !== 'boolean') {
        return {
            parsedRagConfig: null,
            error: `Invalid query rewrite multi query: ${queryRewriteMultiQuery}. Must be a boolean.`,
        }
    }

    // queryRewriteHydeEnabled must be a boolean (snake_case only)
    const queryRewriteHydeEnabled = ragConfig.query_rewrite?.hyde_enabled ?? defaults.queryRewriteHydeEnabled
    if (typeof queryRewriteHydeEnabled !== 'boolean') {
        return {
            parsedRagConfig: null,
            error: `Invalid query rewrite hyde enabled: ${queryRewriteHydeEnabled}. Must be a boolean.`,
        }
    }

    // rerankingEnabled must be a boolean (snake_case only)
    const rerankingEnabled = ragConfig.reranking?.enabled ?? defaults.rerankingEnabled
    if (typeof rerankingEnabled !== 'boolean') {
        return {
            parsedRagConfig: null,
            error: `Invalid reranking enabled: ${rerankingEnabled}. Must be a boolean.`,
        }
    }

    // rerankingMmrEnabled must be a boolean (snake_case only)
    const rerankingMmrEnabled = ragConfig.reranking?.mmr_enabled ?? defaults.rerankingMmrEnabled
    if (typeof rerankingMmrEnabled !== 'boolean') {
        return {
            parsedRagConfig: null,
            error: `Invalid reranking mmr enabled: ${rerankingMmrEnabled}. Must be a boolean.`,
        }
    }

    // rerankingMmrLambda must be a number between 0 and 1 (snake_case only)
    const rerankingMmrLambda = ragConfig.reranking?.mmr_lambda ?? defaults.rerankingMmrLambda
    if (typeof rerankingMmrLambda !== 'number' || rerankingMmrLambda < 0 || rerankingMmrLambda > 1) {
        return {
            parsedRagConfig: null,
            error: `Invalid reranking mmr lambda: ${rerankingMmrLambda}. Must be a number between 0 and 1.`,
        }
    }

    const referencesEnabled = ragConfig.references?.enabled ?? defaults.referencesEnabled
    if (typeof referencesEnabled !== 'boolean') {
        return {
            parsedRagConfig: null,
            error: `Invalid references enabled: ${referencesEnabled}. Must be a boolean.`,
        }
    }

    // vectorSearchTopK must be between 1 and 200 (snake_case only)
    const vectorSearchTopK = ragConfig.vector_search?.top_k ?? defaults.vectorSearchTopK
    if (typeof vectorSearchTopK !== 'number' || vectorSearchTopK < 1 || vectorSearchTopK > 200) {
        return {
            parsedRagConfig: null,
            error: `Invalid vector search topK: ${vectorSearchTopK}. Must be a number between 1 and 200.`,
        }
    }

    // similarityThreshold must be between 0 and 1 (snake_case only)
    const similarityThreshold = ragConfig.vector_search?.similarity_threshold ?? defaults.similarityThreshold
    if (typeof similarityThreshold !== 'number' || similarityThreshold < 0 || similarityThreshold > 1) {
        return {
            parsedRagConfig: null,
            error: `Invalid similarity threshold: ${similarityThreshold}. Must be a number between 0 and 1.`,
        }
    }

    // rerankingTopK must be between 1 and 100 and must be smaller than vector search top k (snake_case only)
    const rerankingTopK = ragConfig.reranking?.top_k ?? defaults.rerankingTopK
    if (typeof rerankingTopK !== 'number' || rerankingTopK < 1 || rerankingTopK > 100) {
        return {
            parsedRagConfig: null,
            error: `Invalid reranking topK: ${rerankingTopK}. Must be a number between 1 and 100.`,
        }
    }

    if (rerankingTopK > vectorSearchTopK) {
        return {
            parsedRagConfig: null,
            error: `Reranking topK (${rerankingTopK}) must be less than or equal to vector search topK (${vectorSearchTopK}).`,
        }
    }

    // hybridSearchEnabled must be a boolean (snake_case only)
    const hybridSearchEnabled = ragConfig.hybrid_search?.enabled ?? defaults.hybridSearchEnabled
    if (typeof hybridSearchEnabled !== 'boolean') {
        return {
            parsedRagConfig: null,
            error: `Invalid hybrid search enabled: ${hybridSearchEnabled}. Must be a boolean.`,
        }
    }

    // hybridSearchVectorWeight must be a number between 0 and 1 (snake_case only)
    const hybridSearchVectorWeight = ragConfig.hybrid_search?.vector_weight ?? defaults.hybridSearchVectorWeight
    if (typeof hybridSearchVectorWeight !== 'number' || hybridSearchVectorWeight < 0 || hybridSearchVectorWeight > 1) {
        return {
            parsedRagConfig: null,
            error: `Invalid hybrid search vector weight: ${hybridSearchVectorWeight}. Must be a number between 0 and 1.`,
        }
    }

    // hybridSearchBm25Weight must be a number between 0 and 1 (snake_case only)
    const hybridSearchBm25Weight = ragConfig.hybrid_search?.bm25_weight ?? defaults.hybridSearchBm25Weight
    if (typeof hybridSearchBm25Weight !== 'number' || hybridSearchBm25Weight < 0 || hybridSearchBm25Weight > 1) {
        return {
            parsedRagConfig: null,
            error: `Invalid hybrid search BM25 weight: ${hybridSearchBm25Weight}. Must be a number between 0 and 1.`,
        }
    }

    const selfRagEnabled = ragConfig.self_rag?.enabled ?? defaults.selfRagEnabled
    if (typeof selfRagEnabled !== 'boolean') {
        return {
            parsedRagConfig: null,
            error: `Invalid self_rag enabled: ${selfRagEnabled}. Must be a boolean.`,
        }
    }

    const selfRagQualityThreshold = ragConfig.self_rag?.quality_threshold ?? defaults.selfRagQualityThreshold
    if (typeof selfRagQualityThreshold !== 'number' || selfRagQualityThreshold < 0 || selfRagQualityThreshold > 1) {
        return {
            parsedRagConfig: null,
            error: `Invalid self_rag quality threshold: ${selfRagQualityThreshold}. Must be a number between 0 and 1.`,
        }
    }

    const selfRagRollbackThreshold = ragConfig.self_rag?.rollback_threshold ?? defaults.selfRagRollbackThreshold
    if (typeof selfRagRollbackThreshold !== 'number' || selfRagRollbackThreshold < -1 || selfRagRollbackThreshold > 0) {
        return {
            parsedRagConfig: null,
            error: `Invalid self_rag rollback threshold: ${selfRagRollbackThreshold}. Must be a number between -1 and 0.`,
        }
    }

    const result = {
        parsedRagConfig: {
            llmProvider: llmProvider as 'cli-proxy-api',
            references: {
                enabled: referencesEnabled,
            },
            queryRewrite: {
                enabled: queryRewriteEnabled,
                multiQuery: queryRewriteMultiQuery,
                hydeEnabled: queryRewriteHydeEnabled,
            },
            vectorSearch: {
                topK: vectorSearchTopK,
                similarityThreshold: similarityThreshold,
            },
            reranking: {
                enabled: rerankingEnabled,
                topK: rerankingTopK,
                mmrEnabled: rerankingMmrEnabled,
                mmrLambda: rerankingMmrLambda,
            },
            hybridSearch: {
                enabled: hybridSearchEnabled,
                vectorWeight: hybridSearchVectorWeight,
                bm25Weight: hybridSearchBm25Weight,
            },
            selfRag: {
                enabled: selfRagEnabled,
                qualityThreshold: selfRagQualityThreshold,
                rollbackThreshold: selfRagRollbackThreshold,
            },
        },
        error: null,
    }
    return result
}

import { RAGConfig } from '@/agents/chatAgent/ragGraph'
import { LLM_PROVIDER } from '@/settings'
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
        similarityThreshold: 0.72,
        rerankingTopK: 25,
        rerankingMmrEnabled: false,
        rerankingMmrLambda: 0.5,
        referencesEnabled: false,
    }

    // Parse and validate llmProvider (snake_case only)
    const llmProvider = ragConfig.llm_provider || ragConfig.llmProvider || LLM_PROVIDER

    if (!AVAILABLE_LLM_PROVIDERS.map((provider) => provider.provider).includes(llmProvider)) {
        return {
            parsedRagConfig: null,
            error: `Invalid LLM provider: ${llmProvider}. Supported providers: ${AVAILABLE_LLM_PROVIDERS.map((provider) => provider.provider).join(', ')}`,
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
        },
        error: null,
    }
    return result
}

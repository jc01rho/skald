import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatOpenAI } from '@langchain/openai'
import { getLLMConfig, reloadLLMConfig } from '../settings'
import { getDefaultLLMModels, getModelFallbackChains, PROVIDER_FALLBACK_CHAIN, isGeminiModel } from '@/llmModels'
import { logger } from '@/lib/logger'

interface GetLLMParams {
    temperature?: number
    providerOverride?: 'cli-proxy-api'
    purpose?: 'chat' | 'classification'
    modelOverride?: string
}

interface RetryConfig {
    maxRetries?: number
    retryDelayMs?: number
    useFallbackChain?: boolean
}

interface InvokeWithRetryParams {
    messages: any[]
    temperature?: number
    maxRetries?: number
    retryDelayMs?: number
    useFallbackChain?: boolean
}

/**
 * Retry wrapper for LLM operations
 * Retries up to 3 times with exponential backoff
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, retryDelayMs = 1000): Promise<T> {
    let lastError: Error | null = null
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn()
        } catch (error) {
            lastError = error as Error
            logger.warn(`Attempt ${attempt}/${maxRetries} failed: ${lastError.message}`)
            if (attempt < maxRetries) {
                const delay = retryDelayMs * attempt
                logger.info(`Retrying in ${delay}ms...`)
                await new Promise((resolve) => setTimeout(resolve, delay))
            }
        }
    }
    throw lastError
}

/**
 * LLM Service for creating LLM instances based on configuration
 * Supports hot-reloading of LLM settings via reloadLLMConfig()
 */
export class LLMService {
    private static provider: string = 'cli-proxy-api'

    /**
     * Get an LLM instance based on current runtime configuration
     * @param temperature - Temperature for the LLM (default: 0 for deterministic output)
     * @returns Configured LLM instance
     */
    static getLLM({ temperature = 0, providerOverride, purpose = 'chat', modelOverride }: GetLLMParams): BaseChatModel {
        const provider = providerOverride || this.provider
        const config = getLLMConfig()

        if (provider === 'cli-proxy-api') {
            if (!config.cliProxyApiKey && !config.geminiApiKey) {
                throw new Error(
                    'CLI Proxy API provider is not configured. Please set CLI_PROXY_API_KEY or GEMINI_API_KEY.'
                )
            }

            const defaultModels = getDefaultLLMModels()
            const modelSlug =
                modelOverride ||
                (purpose === 'chat'
                    ? defaultModels['cli-proxy-api'].defaultChatModel.slug
                    : defaultModels['cli-proxy-api'].defaultClassificationModel.slug)

            const useGeminiEndpoint = isGeminiModel(modelSlug)
            const apiKey = useGeminiEndpoint ? config.geminiApiKey : config.cliProxyApiKey
            const baseURL = useGeminiEndpoint ? config.geminiApiBaseUrl : config.cliProxyApiBaseUrl

            return new ChatOpenAI({
                model: modelSlug,
                apiKey,
                configuration: {
                    baseURL,
                },
                temperature,
            })
        } else {
            throw new Error(`Unsupported LLM provider: ${provider}. Supported providers: cli-proxy-api`)
        }
    }

    /**
     * Invoke LLM with retry logic and fallback chain
     * 1. Try current model with 3 retries
     * 2. If all retries fail, try next model in fallback chain
     * 3. If all models fail, throw error (no provider-level fallback as cli-proxy-api is the only provider)
     */
    static async invokeWithRetry({
        messages,
        temperature = 0,
        maxRetries = 3,
        retryDelayMs = 1000,
        useFallbackChain = true,
    }: InvokeWithRetryParams): Promise<any> {
        const currentProvider = this.provider
        const purpose = 'chat' // Default to chat for now

        // Step 1: Try current model with retries
        try {
            logger.info(`Attempting to invoke LLM with provider: ${currentProvider}`)
            return await withRetry(
                async () => {
                    const llm = this.getLLM({ temperature, providerOverride: currentProvider as any, purpose })
                    return await llm.invoke(messages)
                },
                maxRetries,
                retryDelayMs
            )
        } catch (error) {
            if (!useFallbackChain) {
                throw error
            }

            logger.warn('Current model failed after retries, trying model-level fallback chain...')
            const errorMessage = (error as Error).message
            logger.warn(`Error: ${errorMessage}`)

            // Step 2: Try model-level fallback (only for cli-proxy-api)
            // Get fresh config for hot-reload support
            const fallbackChains = getModelFallbackChains()
            const defaultModels = getDefaultLLMModels()

            if (currentProvider === 'cli-proxy-api' && fallbackChains['cli-proxy-api']) {
                const models = fallbackChains['cli-proxy-api']
                const defaultModelSlug =
                    purpose === 'chat'
                        ? defaultModels['cli-proxy-api'].defaultChatModel.slug
                        : defaultModels['cli-proxy-api'].defaultClassificationModel.slug

                // Skip the current model and try the rest
                const modelFallbackIndex = models.indexOf(defaultModelSlug)
                const fallbackModels = modelFallbackIndex >= 0 ? models.slice(modelFallbackIndex + 1) : models

                for (const fallbackModel of fallbackModels) {
                    try {
                        logger.info(`Trying fallback model: ${fallbackModel}`)
                        const result = await withRetry(
                            async () => {
                                const llm = this.getLLM({
                                    temperature,
                                    providerOverride: currentProvider as any,
                                    purpose,
                                    modelOverride: fallbackModel,
                                })
                                return await llm.invoke(messages)
                            },
                            maxRetries,
                            retryDelayMs
                        )
                        logger.info(`Successfully invoked with fallback model: ${fallbackModel}`)
                        return result
                    } catch (modelError) {
                        logger.warn(`Fallback model ${fallbackModel} failed: ${(modelError as Error).message}`)
                        continue
                    }
                }
            }

            // All fallbacks exhausted
            throw new Error(`All LLM models failed. Last error: ${errorMessage}`)
        }
    }

    /**
     * Reload LLM configuration from environment variables
     * Call this after updating ConfigMap to apply changes without restart
     */
    static reloadConfig() {
        const newConfig = reloadLLMConfig()
        this.provider = newConfig.provider
        logger.info('LLM Service configuration reloaded')
        return {
            provider: newConfig.provider,
            defaultChatModel: newConfig.defaultChatModel,
            defaultClassificationModel: newConfig.defaultClassificationModel,
            fallbackChainLength: newConfig.fallbackChain.length,
        }
    }

    /**
     * Get current LLM configuration (for debugging/monitoring)
     */
    static getConfig() {
        const config = getLLMConfig()
        return {
            provider: config.provider,
            defaultChatModel: config.defaultChatModel,
            defaultClassificationModel: config.defaultClassificationModel,
            fallbackChain: config.fallbackChain,
        }
    }
}

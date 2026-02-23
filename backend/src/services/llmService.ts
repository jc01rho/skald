import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatOpenAI } from '@langchain/openai'
import {
    LLM_PROVIDER,
    CLI_PROXY_API_KEY,
    CLI_PROXY_API_BASE_URL,
    CLI_PROXY_API_MODEL,
    GEMINI_API_BASE_URL,
    GEMINI_API_KEY,
} from '../settings'
import { DEFAULT_LLM_MODELS, MODEL_FALLBACK_CHAINS, PROVIDER_FALLBACK_CHAIN, isGeminiModel } from '@/llmModels'
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
 */
export class LLMService {
    private static provider: string = LLM_PROVIDER

    /**
     * Get an LLM instance based on environment configuration
     * @param temperature - Temperature for the LLM (default: 0 for deterministic output)
     * @returns Configured LLM instance
     */
    static getLLM({ temperature = 0, providerOverride, purpose = 'chat', modelOverride }: GetLLMParams): BaseChatModel {
        let provider = this.provider
        if (providerOverride) {
            provider = providerOverride
        }

        if (provider === 'cli-proxy-api') {
            if (!CLI_PROXY_API_KEY && !GEMINI_API_KEY) {
                throw new Error(
                    'CLI Proxy API provider is not configured. Please set CLI_PROXY_API_KEY or GEMINI_API_KEY.'
                )
            }
            const modelSlug =
                modelOverride ||
                (purpose === 'chat'
                    ? DEFAULT_LLM_MODELS['cli-proxy-api'].defaultChatModel.slug
                    : DEFAULT_LLM_MODELS['cli-proxy-api'].defaultClassificationModel.slug)

            const useGeminiEndpoint = isGeminiModel(modelSlug)
            const apiKey = useGeminiEndpoint ? GEMINI_API_KEY : CLI_PROXY_API_KEY
            const baseURL = useGeminiEndpoint ? GEMINI_API_BASE_URL : CLI_PROXY_API_BASE_URL

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
            if (currentProvider === 'cli-proxy-api' && MODEL_FALLBACK_CHAINS['cli-proxy-api']) {
                const models = MODEL_FALLBACK_CHAINS['cli-proxy-api']
                const defaultModelSlug =
                    purpose === 'chat'
                        ? DEFAULT_LLM_MODELS['cli-proxy-api'].defaultChatModel.slug
                        : DEFAULT_LLM_MODELS['cli-proxy-api'].defaultClassificationModel.slug

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
}

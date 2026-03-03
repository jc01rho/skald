import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatOpenAI } from '@langchain/openai'
import { getLLMConfig, reloadLLMConfig } from '../settings'
import { getDefaultLLMModels, getModelFallbackChains, PROVIDER_FALLBACK_CHAIN, isGeminiModel } from '@/llmModels'
import { logger } from '@/lib/logger'

/**
 * Check if an error indicates model capacity issues (503 No capacity)
 * These errors should immediately trigger fallback instead of retry
 */
function isCapacityError(error: Error): boolean {
    const message = error.message.toLowerCase()
    return (
        message.includes('503') ||
        message.includes('no capacity') ||
        message.includes('unavailable') ||
        message.includes('overloaded') ||
        message.includes('rate limit') ||
        message.includes('too many requests')
    )
}

function normalizeOpenAIBaseUrl(rawBaseUrl: string): string {
    const trimmed = (rawBaseUrl || '').trim()
    if (!trimmed) {
        return trimmed
    }

    const withoutTrailingSlash = trimmed.replace(/\/+$/, '')
    if (withoutTrailingSlash.endsWith('/v1')) {
        return withoutTrailingSlash
    }

    return `${withoutTrailingSlash}/v1`
}

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

interface StreamWithFallbackParams {
    prompt: any // ChatPromptTemplate
    input: Record<string, any>
    temperature?: number
    maxRetries?: number
    retryDelayMs?: number
}
/**
 * Retry wrapper for LLM operations
 * Retries up to maxRetries times with exponential backoff
 * Skips retry for capacity errors (503) - should fallback instead
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, retryDelayMs = 1000): Promise<T> {
    let lastError: Error | null = null
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn()
        } catch (error) {
            lastError = error as Error

            // Check if this is a capacity error - should fallback immediately
            if (isCapacityError(lastError)) {
                logger.warn(`Capacity error detected (attempt ${attempt}/${maxRetries}): ${lastError.message}`)
                logger.info('Skipping retry, proceeding to fallback model...')
                throw lastError // Let the caller handle fallback
            }

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
            const baseURL = normalizeOpenAIBaseUrl(
                useGeminiEndpoint ? config.geminiApiBaseUrl : config.cliProxyApiBaseUrl
            )

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
     * Traverses fallback chain starting from default model for consistent behavior with streamWithFallback
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
        const fallbackChains = getModelFallbackChains()
        const defaultModels = getDefaultLLMModels()
        const defaultModelSlug =
            purpose === 'chat'
                ? defaultModels['cli-proxy-api'].defaultChatModel.slug
                : defaultModels['cli-proxy-api'].defaultClassificationModel.slug

        // Get all models to try (default + fallbacks), consistent with streamWithFallback
        const models = fallbackChains['cli-proxy-api'] || [defaultModelSlug]
        const modelFallbackIndex = models.indexOf(defaultModelSlug)
        const modelsToTry = modelFallbackIndex >= 0 ? models.slice(modelFallbackIndex) : models

        if (!useFallbackChain) {
            // Only try default model without fallback
            const llm = this.getLLM({ temperature, providerOverride: currentProvider as any, purpose })
            return await llm.invoke(messages)
        }

        let lastError: Error | null = null

        for (const modelSlug of modelsToTry) {
            try {
                logger.info(`Attempting to invoke LLM with model: ${modelSlug}`)
                const result = await withRetry(
                    async () => {
                        const llm = this.getLLM({
                            temperature,
                            providerOverride: currentProvider as any,
                            purpose,
                            modelOverride: modelSlug,
                        })
                        return await llm.invoke(messages)
                    },
                    maxRetries,
                    retryDelayMs
                )
                logger.info(`Successfully invoked with model: ${modelSlug}`)
                return result
            } catch (error) {
                lastError = error as Error
                const isCapacity = isCapacityError(lastError)

                if (isCapacity) {
                    logger.warn(`Capacity error for model ${modelSlug}, trying next fallback model...`)
                } else {
                    logger.warn(`Model ${modelSlug} failed: ${lastError.message}`)
                }
                continue
            }
        }

        // All models exhausted
        throw new Error(`All LLM models failed for invoke. Last error: ${lastError?.message}`)
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

    /**
     * Stream LLM response with fallback chain support
     * Used by chatAgent for streaming responses with automatic fallback on capacity errors
     */
    static async *streamWithFallback({
        prompt,
        input,
        temperature = 0,
        maxRetries = 3,
        retryDelayMs = 1000,
    }: StreamWithFallbackParams): AsyncGenerator<any> {
        const currentProvider = this.provider
        const purpose = 'chat'
        const fallbackChains = getModelFallbackChains()
        const defaultModels = getDefaultLLMModels()
        const defaultModelSlug = defaultModels['cli-proxy-api'].defaultChatModel.slug

        // Get all models to try (default + fallbacks)
        const models = fallbackChains['cli-proxy-api'] || [defaultModelSlug]
        const modelFallbackIndex = models.indexOf(defaultModelSlug)
        const modelsToTry = modelFallbackIndex >= 0 ? models.slice(modelFallbackIndex) : models

        let lastError: Error | null = null

        for (const modelSlug of modelsToTry) {
            try {
                logger.info(`Attempting to stream LLM with model: ${modelSlug}`)
                const llm = this.getLLM({
                    temperature,
                    providerOverride: currentProvider as any,
                    purpose,
                    modelOverride: modelSlug,
                })
                const chain = prompt.pipe(llm)

                // Try to start streaming with retries for transient errors
                let stream: AsyncGenerator<any> | null = null
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        stream = await chain.stream(input)
                        break
                    } catch (streamError) {
                        lastError = streamError as Error

                        if (isCapacityError(lastError)) {
                            logger.warn(
                                `Capacity error for model ${modelSlug} (attempt ${attempt}/${maxRetries}): ${lastError.message}`
                            )
                            throw lastError // Move to next model
                        }

                        logger.warn(
                            `Stream attempt ${attempt}/${maxRetries} failed for model ${modelSlug}: ${lastError.message}`
                        )
                        if (attempt < maxRetries) {
                            const delay = retryDelayMs * attempt
                            logger.info(`Retrying in ${delay}ms...`)
                            await new Promise((resolve) => setTimeout(resolve, delay))
                        }
                    }
                }

                if (!stream) {
                    throw lastError
                }

                // Successfully got stream, yield chunks
                logger.info(`Successfully started streaming with model: ${modelSlug}`)
                for await (const chunk of stream) {
                    yield chunk
                }
                return // Success, exit the generator
            } catch (error) {
                lastError = error as Error
                const isCapacity = isCapacityError(lastError)

                if (isCapacity) {
                    logger.warn(`Capacity error for model ${modelSlug}, trying next fallback model...`)
                } else {
                    logger.warn(`Model ${modelSlug} failed: ${lastError.message}`)
                }
                continue // Try next model
            }
        }

        // All models exhausted
        throw new Error(`All LLM models failed for streaming. Last error: ${lastError?.message}`)
    }
}

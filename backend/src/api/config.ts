import express, { Request, Response } from 'express'
import { getLLMConfig, CLI_PROXY_API_KEY } from '@/settings'
import { getDefaultLLMModels } from '@/llmModels'
import { LLMService } from '@/services/llmService'

interface LLMProvider {
    provider: 'cli-proxy-api'
    label: string
    model: string
}

/**
 * Get list of available LLM providers (for backward compatibility)
 * This is used by ragUtils for validation
 */
export function getAvailableLLMProvidersList(): LLMProvider[] {
    const defaultModels = getDefaultLLMModels()
    const config = getLLMConfig()
    const providers: LLMProvider[] = []
    
    if (config.cliProxyApiKey) {
        providers.push({
            provider: 'cli-proxy-api',
            label: 'CLI Proxy API',
            model: defaultModels['cli-proxy-api'].defaultChatModel.name,
        })
    }
    
    return providers
}

// Backward compatible export
export const AVAILABLE_LLM_PROVIDERS: LLMProvider[] = getAvailableLLMProvidersList()
export const getAvailableLLMProviders = async (req: Request, res: Response) => {
    const defaultModels = getDefaultLLMModels()
    const providers: LLMProvider[] = []
    const config = getLLMConfig()
    
    if (config.cliProxyApiKey) {
        providers.push({
            provider: 'cli-proxy-api',
            label: 'CLI Proxy API',
            model: defaultModels['cli-proxy-api'].defaultChatModel.name,
        })
    }
    
    return res.status(200).json({
        providers,
        currentConfig: {
            defaultChatModel: config.defaultChatModel,
            defaultClassificationModel: config.defaultClassificationModel,
            fallbackChainLength: config.fallbackChain.length,
        },
    })
}

/**
 * Reload LLM configuration from environment
 * POST /api/config/llm-reload
 * 
 * After updating ConfigMap, call this endpoint to apply changes without restart
 */
export const reloadLLMConfigHandler = async (req: Request, res: Response) => {
    try {
        const newConfig = LLMService.reloadConfig()
        return res.status(200).json({
            success: true,
            message: 'LLM configuration reloaded successfully',
            config: newConfig,
        })
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: (error as Error).message,
        })
    }
}

/**
 * Get current LLM configuration
 * GET /api/config/llm
 */
export const getLLMConfigHandler = async (req: Request, res: Response) => {
    const config = LLMService.getConfig()
    return res.status(200).json({
        config,
    })
}

export const configRouter = express.Router()
configRouter.get('/llm-providers', getAvailableLLMProviders)
configRouter.get('/llm', getLLMConfigHandler)
configRouter.post('/llm-reload', reloadLLMConfigHandler)

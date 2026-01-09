import express, { Request, Response } from 'express'
import { CLI_PROXY_API_KEY } from '@/settings'
import { DEFAULT_LLM_MODELS } from '@/llmModels'

interface LLMProvider {
    provider: 'cli-proxy-api'
    label: string
    model: string
}

export const AVAILABLE_LLM_PROVIDERS: LLMProvider[] = []
if (CLI_PROXY_API_KEY) {
    AVAILABLE_LLM_PROVIDERS.push({
        provider: 'cli-proxy-api',
        label: 'CLI Proxy API',
        model: DEFAULT_LLM_MODELS['cli-proxy-api'].defaultChatModel.name,
    })
}

export const getAvailableLLMProviders = async (req: Request, res: Response) => {
    return res.status(200).json({
        providers: AVAILABLE_LLM_PROVIDERS,
    })
}

export const configRouter = express.Router()
configRouter.get('/llm-providers', getAvailableLLMProviders)

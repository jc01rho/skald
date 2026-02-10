export const SUPPORTED_LLM_MODELS = {
    'cli-proxy-api': {
        // ========================================
        // Available Models (27 working models)
        // Listed in priority order as specified
        // ========================================
        'gemini-3-pro': { slug: 'gemini-3-pro', name: 'Gemini 3 Pro' },
        'glm-4.7': { slug: 'glm-4.7', name: 'GLM 4.7' },
        'deepseek-v3.2-reasoner': { slug: 'deepseek-v3.2-reasoner', name: 'DeepSeek V3.2 Reasoner' },
        'gemini-2.5-pro': { slug: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
        'qwen3-max': { slug: 'qwen3-max', name: 'Qwen 3 Max' },
        'qwen3-235b': { slug: 'qwen3-235b', name: 'Qwen 3 235B' },
        'gemini-2.5-flash': { slug: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        free: { slug: 'free', name: 'Free' },
        'gemini-2.5-flash-lite': { slug: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
        'gemini-3-flash-preview': { slug: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
        'gemini-2.5-computer-use-preview-10-2025': {
            slug: 'gemini-2.5-computer-use-preview-10-2025',
            name: 'Gemini 2.5 Computer Use Preview',
        },
        'kimi-k2-0905': { slug: 'kimi-k2-0905', name: 'Kimi K2 0905' },
        'kimi-k2': { slug: 'kimi-k2', name: 'Kimi K2' },
        'qwen3-max-preview': { slug: 'qwen3-max-preview', name: 'Qwen 3 Max Preview' },
        'qwen3-coder-plus': { slug: 'qwen3-coder-plus', name: 'Qwen 3 Coder Plus' },
        'qwen3-235b-a22b-thinking-2507': {
            slug: 'qwen3-235b-a22b-thinking-2507',
            name: 'Qwen 3 235B A22B Thinking 2507',
        },
        'qwen3-235b-a22b-instruct': { slug: 'qwen3-235b-a22b-instruct', name: 'Qwen 3 235B A22B Instruct' },
        'qwen3-32b': { slug: 'qwen3-32b', name: 'Qwen 3 32B' },
        'deepseek-v3.1': { slug: 'deepseek-v3.1', name: 'DeepSeek V3.1' },
        'deepseek-v3': { slug: 'deepseek-v3', name: 'DeepSeek V3' },
        'deepseek-r1': { slug: 'deepseek-r1', name: 'DeepSeek R1' },
        'deepseek-v3.2': { slug: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
        'deepseek-v3.2-chat': { slug: 'deepseek-v3.2-chat', name: 'DeepSeek V3.2 Chat' },
        'tstars2.0': { slug: 'tstars2.0', name: 'TStars 2.0' },
        sonnet: { slug: 'sonnet', name: 'Sonnet' },
        opus: { slug: 'opus', name: 'Opus' },
    },
}

export const DEFAULT_LLM_MODELS = {
    'cli-proxy-api': {
        // Both chat and classification now use gemini-3-pro as default
        defaultChatModel: SUPPORTED_LLM_MODELS['cli-proxy-api']['gemini-3-pro'],
        defaultClassificationModel: SUPPORTED_LLM_MODELS['cli-proxy-api']['gemini-3-pro'],
    },
}

export const MODEL_FALLBACK_CHAINS = {
    'cli-proxy-api': [
        // Priority order: gemini-3-pro -> deepseek-v3.2 -> glm-4.7 -> kimi-k2 -> qwen3-max -> rest
        'gemini-3-pro',
        'deepseek-v3.2',
        'glm-4.7',
        'kimi-k2',
        'qwen3-max',
        'gemini-2.5-pro',
        'qwen3-235b',
        'gemini-2.5-flash',
        'free',
        'gemini-2.5-flash-lite',
        'gemini-3-flash-preview',
        'gemini-2.5-computer-use-preview-10-2025',
        'kimi-k2-0905',
        'qwen3-max-preview',
        'qwen3-coder-plus',
        'qwen3-235b-a22b-thinking-2507',
        'qwen3-235b-a22b-instruct',
        'qwen3-32b',
        'deepseek-v3.2-reasoner',
        'deepseek-v3.1',
        'deepseek-v3',
        'deepseek-r1',
        'deepseek-v3.2-chat',
        'tstars2.0',
        'sonnet',
        'opus',
    ],
}

// Provider-level fallback chain: cli-proxy-api is the only provider
export const PROVIDER_FALLBACK_CHAIN = ['cli-proxy-api']

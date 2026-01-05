export const SUPPORTED_LLM_MODELS = {
    openai: {
        'gpt-4o-mini': { slug: 'gpt-4o-mini', name: 'GPT-4o Mini' },
        'gpt-5-nano': { slug: 'gpt-5-nano', name: 'GPT-5 Nano' },
    },
    anthropic: {
        'claude-haiku-4-5-20251001': { slug: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
        'claude-sonnet-4-5-20250929': { slug: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
    },
    gemini: {
        'gemini-2.5-flash': { slug: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        'gemini-2.5-pro': { slug: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    },
    groq: {
        'llama-3.1-8b-instant': { slug: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
        'llama-3.3-70b-versatile': { slug: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
        'qwen/qwen3-32b': { slug: 'qwen/qwen3-32b', name: 'Qwen 3 32B' },
        'moonshotai/kimi-k2-instruct': { slug: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 Instruct' },
        'openai/gpt-oss-120b': { slug: 'openai/gpt-oss-120b', name: 'GPT OSS 120B' },
        'groq/compound': { slug: 'groq/compound', name: 'Groq Compound' },
        'moonshotai/kimi-k2-instruct-0905': { slug: 'moonshotai/kimi-k2-instruct-0905', name: 'Kimi K2 Instruct 0905' },
        'meta-llama/llama-4-scout-17b-16e-instruct': {
            slug: 'meta-llama/llama-4-scout-17b-16e-instruct',
            name: 'Llama 4 Scout 17B',
        },
        'meta-llama/llama-4-maverick-17b-128e-instruct': {
            slug: 'meta-llama/llama-4-maverick-17b-128e-instruct',
            name: 'Llama 4 Maverick 17B',
        },
        'openai/gpt-oss-20b': { slug: 'openai/gpt-oss-20b', name: 'GPT OSS 20B' },
        'openai/gpt-oss-safeguard-20b': { slug: 'openai/gpt-oss-safeguard-20b', name: 'GPT OSS Safeguard 20B' },
        'allam-2-7b': { slug: 'allam-2-7b', name: 'Allam 2 7B' },
        'groq/compound-mini': { slug: 'groq/compound-mini', name: 'Groq Compound Mini' },
    },
    pollinations: {
        openai: { slug: 'openai', name: 'OpenAI' },
        'claude-3-5-sonnet': { slug: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
        'gemini-2.5-flash': { slug: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        'llama-3.3-70b': { slug: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
    },
}

export const DEFAULT_LLM_MODELS = {
    openai: {
        defaultChatModel: SUPPORTED_LLM_MODELS.openai['gpt-4o-mini'],
        defaultClassificationModel: SUPPORTED_LLM_MODELS.openai['gpt-4o-mini'],
    },
    anthropic: {
        defaultChatModel: SUPPORTED_LLM_MODELS.anthropic['claude-sonnet-4-5-20250929'],
        defaultClassificationModel: SUPPORTED_LLM_MODELS.anthropic['claude-haiku-4-5-20251001'],
    },
    gemini: {
        defaultChatModel: SUPPORTED_LLM_MODELS.gemini['gemini-2.5-pro'],
        defaultClassificationModel: SUPPORTED_LLM_MODELS.gemini['gemini-2.5-flash'],
    },
    groq: {
        defaultChatModel: SUPPORTED_LLM_MODELS.groq['llama-3.3-70b-versatile'],
        defaultClassificationModel: SUPPORTED_LLM_MODELS.groq['llama-3.1-8b-instant'],
    },
    pollinations: {
        defaultChatModel: SUPPORTED_LLM_MODELS.pollinations['openai'],
        defaultClassificationModel: SUPPORTED_LLM_MODELS.pollinations['openai'],
    },
}

import { config } from 'dotenv'
import { resolve } from 'path'
import pino from 'pino'

// Logger for settings validation (before main logger is configured)
const logger = pino({
    level: 'info',
    transport:
        process.env.NODE_ENV === 'development'
            ? {
                  target: 'pino-pretty',
                  options: {
                      colorize: true,
                      translateTime: 'HH:MM:ss Z',
                      ignore: 'pid,hostname',
                  },
              }
            : undefined,
})

if (process.env.NODE_ENV === 'development') {
    config({ path: resolve(__dirname, '../../.env') })
} else {
    config({ path: resolve(__dirname, '.env') })
}

function strToBool(input: string | boolean | undefined, defaultValue: boolean = false): boolean {
    if (!input) {
        return defaultValue
    }

    if (typeof input === 'boolean') {
        return input
    }

    if (input === undefined) {
        return false
    }

    const trueTerms = ['true', '1', 'yes', 'y', 't']
    const falseTerms = ['false', '0', 'no', 'n', 'f']

    const normalizedStr = input.trim().toLowerCase()

    if (trueTerms.includes(normalizedStr)) {
        return true
    } else if (falseTerms.includes(normalizedStr)) {
        return false
    } else {
        throw new Error('Input string does not represent a boolean value')
    }
}

export const SECRET_KEY = process.env.SECRET_KEY || 'UNSAFE_DEFAULT_SECRET_KEY'

export const TEST = strToBool(process.env.TEST)

export const NODE_ENV = process.env.NODE_ENV

export const IS_DEVELOPMENT = strToBool(process.env.IS_DEVELOPMENT) || NODE_ENV === 'development'

// postgres
export const DB_NAME = process.env.DB_NAME || 'skald'
export const DB_USER = process.env.DB_USER || 'postgres'
export const DB_PASSWORD = process.env.DB_PASSWORD || '12345678'
export const DB_HOST = process.env.DB_HOST || 'localhost'
export const DB_PORT = parseInt(process.env.DB_PORT || '5432')
export const DATABASE_URL =
    process.env.DATABASE_URL || `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`

// queue configuration
export const INTER_PROCESS_QUEUE = process.env.INTER_PROCESS_QUEUE || 'redis'

export const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL
export const SQS_DLQ_QUEUE_URL = process.env.SQS_DLQ_QUEUE_URL

export const REDIS_HOST = process.env.REDIS_HOST || 'localhost'
export const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379')
export const REDIS_URL = process.env.REDIS_URL
export const CHANNEL_NAME = process.env.CHANNEL_NAME || 'process_memo'

export const RABBITMQ_HOST = process.env.RABBITMQ_HOST || 'localhost'
export const RABBITMQ_PORT = process.env.RABBITMQ_PORT || '5672'
export const RABBITMQ_USER = process.env.RABBITMQ_USER || 'guest'
export const RABBITMQ_PASSWORD = process.env.RABBITMQ_PASSWORD || 'guest'
export const RABBITMQ_VHOST = process.env.RABBITMQ_VHOST || '/'
export const RABBITMQ_QUEUE_NAME = process.env.RABBITMQ_QUEUE_NAME || 'process_memo'

export const AWS_REGION = process.env.AWS_REGION || 'us-east-2'
export const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID
export const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY
export const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME

// ---- LLM Configuration ----
export const LLM_PROVIDER = process.env.LLM_PROVIDER || 'cli-proxy-api'

// CLI Proxy API (only supported LLM provider)
export const CLI_PROXY_API_KEY = process.env.CLI_PROXY_API_KEY
export const CLI_PROXY_API_BASE_URL = process.env.CLI_PROXY_API_BASE_URL || 'http://cli-proxy-service:8317/v1'
export const CLI_PROXY_API_MODEL = process.env.CLI_PROXY_API_MODEL || 'qwen3-max'

// Gemini models use a separate endpoint/auth from the default CLI Proxy API
export const GEMINI_API_BASE_URL = process.env.GEMINI_API_BASE_URL || 'http://REDACTED_HOST:REDACTED_PORT/v1'
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'REDACTED_API_KEY'

// Validation of LLM provider configuration on startup
export const SUPPORTED_LLM_PROVIDERS = ['cli-proxy-api']
if (!SUPPORTED_LLM_PROVIDERS.includes(LLM_PROVIDER)) {
    throw new Error(`Invalid LLM_PROVIDER: ${LLM_PROVIDER}. Supported: ${SUPPORTED_LLM_PROVIDERS.join(', ')}`)
}

// Warn if LLM provider API key is missing
if (!IS_DEVELOPMENT && LLM_PROVIDER === 'cli-proxy-api' && !CLI_PROXY_API_KEY) {
    logger.warn('CLI_PROXY_API_KEY not set in production')
}

// ---- Embedding Provider Configuration ----
// NOTE: Embedding is now hardcoded to use internal endpoint (192.168.150.37:8889)
// EMBEDDING_PROVIDER is kept for backward compatibility but no longer used
export const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || 'internal'

// ---- Reranking Configuration ----
// NOTE: Reranking is now hardcoded to use internal endpoint (192.168.150.37)
// RERANKING_PROVIDER is kept for backward compatibility but no longer used
export const RERANKING_PROVIDER = process.env.RERANKING_PROVIDER || 'internal'

// Voyage AI (kept for backward compatibility, no longer used)
export const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY
export const VOYAGE_EMBEDDING_MODEL = process.env.VOYAGE_EMBEDDING_MODEL || 'voyage-3-large'

// OpenAI (kept for backward compatibility, no longer used for embedding)
export const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-large'

// Local (kept for backward compatibility, no longer used)
export const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || 'http://localhost:8001'

// Constants
export const EMBEDDING_VECTOR_DIMENSION = 2048
export const VECTOR_SEARCH_TOP_K = parseInt(process.env.VECTOR_SEARCH_TOP_K || '100')
export const POST_RERANK_TOP_K = parseInt(process.env.POST_RERANK_TOP_K || '50')

// NOTE: Embedding/Reranking provider validation removed - now using hardcoded internal endpoints

export const SENTRY_DSN = process.env.SENTRY_DSN

// ---- CORS Configuration ----
export const CORS_ALLOW_CREDENTIALS = true

// Get allowed origins from environment or use defaults
const CORS_ORIGINS_ENV = process.env.CORS_ALLOWED_ORIGINS || ''
let CORS_ALLOWED_ORIGINS: string[]

if (CORS_ORIGINS_ENV) {
    CORS_ALLOWED_ORIGINS = CORS_ORIGINS_ENV.split(',').map((origin) => origin.trim())
} else if (IS_DEVELOPMENT) {
    CORS_ALLOWED_ORIGINS = ['http://localhost:8000', 'http://localhost:3000', 'http://localhost:5173']
} else {
    CORS_ALLOWED_ORIGINS = ['https://app.useskald.com', 'https://api.useskald.com', 'https://platform.useskald.com']
}

// Add self-hosted deployment URLs
export const IS_SELF_HOSTED_DEPLOY = strToBool(process.env.IS_SELF_HOSTED_DEPLOY)
if (IS_SELF_HOSTED_DEPLOY) {
    const FRONTEND_URL = process.env.FRONTEND_URL
    const API_URL = process.env.API_URL
    if (FRONTEND_URL) {
        CORS_ALLOWED_ORIGINS.push(FRONTEND_URL)
    }
    if (API_URL) {
        CORS_ALLOWED_ORIGINS.push(API_URL)
    }
}

export const IS_CLOUD = strToBool(process.env.IS_CLOUD)

export { CORS_ALLOWED_ORIGINS }

export const ENABLE_SECURITY_SETTINGS = strToBool(process.env.ENABLE_SECURITY_SETTINGS, !IS_DEVELOPMENT)

// ---- Email Configuration ----
const DEFAULT_EMAIL_VERIFICATION_ENABLED = !(IS_DEVELOPMENT || IS_SELF_HOSTED_DEPLOY)
export const EMAIL_VERIFICATION_ENABLED = strToBool(
    process.env.EMAIL_VERIFICATION_ENABLED,
    DEFAULT_EMAIL_VERIFICATION_ENABLED
)

// Resend
export const RESEND_API_KEY = process.env.RESEND_API_KEY
export const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || 'useskald.com'
export const RESEND_DEFAULT_AUDIENCE_ID = process.env.RESEND_DEFAULT_AUDIENCE_ID || ''

// Frontend URL
export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'

export const EXPRESS_SERVER_PORT = parseInt(process.env.EXPRESS_SERVER_PORT || '3000')

// ---- Google OAuth Configuration ----
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
export const GOOGLE_OAUTH_REDIRECT_URI =
    process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${EXPRESS_SERVER_PORT}/api/auth/google/callback`

// ---- Stripe Configuration ----
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET

// Warn if Stripe keys are missing in production
if (!IS_DEVELOPMENT && !STRIPE_SECRET_KEY) {
    logger.warn('STRIPE_SECRET_KEY not set in production')
}

export const LOG_LEVEL = process.env.LOG_LEVEL || 'warn'

// PostHog
export const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || 'phc_B77mcYC1EycR6bKLgSNzjM9aaeiWXhoeizyriFIxWf2' // it's a public key that can be leaked
export const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com'

// ---- Document Extraction Provider Configuration ----
export const DOCUMENT_EXTRACTION_PROVIDER = process.env.DOCUMENT_EXTRACTION_PROVIDER || 'datalab'

// Datalab API (for converting documents to markdown)
export const DATALAB_API_KEY = process.env.DATALAB_API_KEY

// Docling Service (for converting documents to markdown)
export const DOCLING_SERVICE_URL = process.env.DOCLING_SERVICE_URL || 'http://localhost:5001'

// Validation of document extraction provider configuration on startup
const SUPPORTED_DOCUMENT_EXTRACTION_PROVIDERS = ['datalab', 'docling']
if (!SUPPORTED_DOCUMENT_EXTRACTION_PROVIDERS.includes(DOCUMENT_EXTRACTION_PROVIDER)) {
    throw new Error(
        `Invalid DOCUMENT_EXTRACTION_PROVIDER: ${DOCUMENT_EXTRACTION_PROVIDER}. Supported: ${SUPPORTED_DOCUMENT_EXTRACTION_PROVIDERS.join(', ')}`
    )
}

// Warn if document extraction provider API keys are missing
if (!IS_DEVELOPMENT && DOCUMENT_EXTRACTION_PROVIDER === 'datalab' && !DATALAB_API_KEY) {
    logger.warn('DATALAB_API_KEY not set for datalab provider in production')
} else if (!IS_DEVELOPMENT && DOCUMENT_EXTRACTION_PROVIDER === 'docling' && !DOCLING_SERVICE_URL) {
    logger.warn('DOCLING_SERVICE_URL not set for docling provider in production')
}

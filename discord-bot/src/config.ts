import 'dotenv/config'

function requireEnv(name: string): string {
    const value = process.env[name]
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`)
    }
    return value
}

export const config = {
    discordBotToken: requireEnv('DISCORD_BOT_TOKEN'),
    skaldApiUrl: requireEnv('SKALD_API_URL'),
    skaldApiKey: requireEnv('SKALD_API_KEY'),
    skaldProjectId: requireEnv('SKALD_PROJECT_ID'),
    spmsInfoBaseUrl: process.env.SPMS_INFO_BASE_URL || '',
    logLevel: process.env.LOG_LEVEL || 'info',
}

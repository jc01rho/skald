export const config = {
    skaldApiUrl: process.env.SKALD_API_URL || 'http://localhost:8000',
    skaldProjectId: process.env.SKALD_PROJECT_ID || '',
    logLevel: process.env.LOG_LEVEL || 'info',
    discordToken: process.env.DISCORD_TOKEN || '',
}

import { DATABASE_URL } from '@/settings'
import { logger } from '@/lib/logger'
import { Client } from 'pg'

export async function canConnectToPostgres(): Promise<void> {
    const client = new Client({ connectionString: DATABASE_URL })

    try {
        await client.connect()
        await client.end()
    } catch {
        logger.fatal('Failed to connect to Postgres')
        process.exit(1)
    }
}

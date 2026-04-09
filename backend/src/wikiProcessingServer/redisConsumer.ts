import { createClient } from 'redis'
import { MikroORM } from '@mikro-orm/core'
import { REDIS_HOST, REDIS_PORT, WIKI_CHANNEL_NAME } from '@/settings'
import { logger } from '@/lib/logger'
import { WikiCompilerService } from '@/services/wiki/wikiCompilerService'
import type { WikiRefreshQueueMessage } from '@/lib/wikiQueueClient'

export async function runWikiRedisConsumer(orm: MikroORM): Promise<void> {
    const subscriber = createClient({
        socket: {
            host: REDIS_HOST,
            port: REDIS_PORT,
        },
    })

    await subscriber.connect()
    logger.info({ channelName: WIKI_CHANNEL_NAME }, 'Subscribed to wiki Redis channel')

    await subscriber.subscribe(WIKI_CHANNEL_NAME, async (message) => {
        const payload = JSON.parse(message) as WikiRefreshQueueMessage
        const em = orm.em.fork()
        await WikiCompilerService.processPendingRefreshes(em, undefined, payload.project_uuid || null)
    })
}

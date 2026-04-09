import { MikroORM } from '@mikro-orm/core'
import config from '@/mikro-orm.config'
import { logger } from '@/lib/logger'
import { closeWikiRabbitMQ, runWikiRabbitMQConsumer } from '@/wikiProcessingServer/rabbitMqConsumer'
import { runWikiRedisConsumer } from '@/wikiProcessingServer/redisConsumer'
import { runWikiSQSConsumer } from '@/wikiProcessingServer/sqsConsumer'
import { EMBEDDING_PROVIDER, INTER_PROCESS_QUEUE, LLM_PROVIDER } from '@/settings'

export const startWikiProcessingServer = async () => {
    const orm = await MikroORM.init(config)

    logger.info({ queue: INTER_PROCESS_QUEUE }, 'Starting wiki processing server')
    logger.info({ llmProvider: LLM_PROVIDER }, 'LLM provider configured for wiki processing')
    logger.info({ embeddingProvider: EMBEDDING_PROVIDER }, 'Embedding provider configured for wiki processing')

    switch (INTER_PROCESS_QUEUE) {
        case 'redis':
            await runWikiRedisConsumer(orm)
            break
        case 'sqs':
            await runWikiSQSConsumer(orm)
            break
        case 'rabbitmq':
            await runWikiRabbitMQConsumer(orm)
            break
        default:
            throw new Error(`Invalid INTER_PROCESS_QUEUE value: ${INTER_PROCESS_QUEUE}`)
    }

    process.on('SIGINT', async () => {
        if (INTER_PROCESS_QUEUE === 'rabbitmq') {
            await closeWikiRabbitMQ()
        }
        process.exit(0)
    })

    process.on('SIGTERM', async () => {
        if (INTER_PROCESS_QUEUE === 'rabbitmq') {
            await closeWikiRabbitMQ()
        }
        process.exit(0)
    })
}

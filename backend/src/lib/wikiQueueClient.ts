import { createClient } from 'redis'
import * as amqplib from 'amqplib'
import { publishMessage } from '@/lib/sqsClient'
import { logger } from '@/lib/logger'
import {
    INTER_PROCESS_QUEUE,
    REDIS_HOST,
    REDIS_PORT,
    WIKI_CHANNEL_NAME,
    WIKI_SQS_QUEUE_URL,
    RABBITMQ_HOST,
    RABBITMQ_PORT,
    RABBITMQ_USER,
    RABBITMQ_PASSWORD,
    RABBITMQ_VHOST,
    WIKI_RABBITMQ_QUEUE_NAME,
    TEST,
} from '@/settings'

export interface WikiRefreshQueueMessage {
    request_uuid?: string
    project_uuid?: string
    reason: 'memo_refresh' | 'manual' | 'retry' | 'batch_tick'
}

async function publishToRedis(message: WikiRefreshQueueMessage): Promise<void> {
    const redisClient = createClient({
        socket: {
            host: REDIS_HOST,
            port: REDIS_PORT,
        },
    })

    await redisClient.connect()
    await redisClient.publish(WIKI_CHANNEL_NAME, JSON.stringify(message))
    await redisClient.quit()
    logger.info({ queue: WIKI_CHANNEL_NAME, reason: message.reason }, 'Published wiki refresh to Redis channel')
}

async function publishToSqs(message: WikiRefreshQueueMessage): Promise<void> {
    if (!WIKI_SQS_QUEUE_URL) {
        throw new Error('WIKI_SQS_QUEUE_URL is not configured')
    }

    const response = await publishMessage(JSON.stringify(message), WIKI_SQS_QUEUE_URL)
    logger.info(
        { queue: WIKI_SQS_QUEUE_URL, messageId: response.MessageId, reason: message.reason },
        'Published wiki refresh to SQS'
    )
}

async function publishToRabbitmq(message: WikiRefreshQueueMessage): Promise<void> {
    const credentials = amqplib.credentials.plain(RABBITMQ_USER, RABBITMQ_PASSWORD)
    const url = `amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@${RABBITMQ_HOST}:${RABBITMQ_PORT}${RABBITMQ_VHOST}`
    const connection = await amqplib.connect(url, { credentials })
    const channel = await connection.createChannel()

    await channel.assertQueue(WIKI_RABBITMQ_QUEUE_NAME, { durable: true })
    channel.sendToQueue(WIKI_RABBITMQ_QUEUE_NAME, Buffer.from(JSON.stringify(message)), { persistent: true })

    await channel.close()
    await connection.close()
    logger.info({ queue: WIKI_RABBITMQ_QUEUE_NAME, reason: message.reason }, 'Published wiki refresh to RabbitMQ')
}

export async function publishWikiRefresh(message: WikiRefreshQueueMessage): Promise<void> {
    if (TEST) {
        return
    }

    if (INTER_PROCESS_QUEUE === 'redis') {
        await publishToRedis(message)
        return
    }

    if (INTER_PROCESS_QUEUE === 'sqs') {
        await publishToSqs(message)
        return
    }

    if (INTER_PROCESS_QUEUE === 'rabbitmq') {
        await publishToRabbitmq(message)
        return
    }

    throw new Error(`Invalid inter-process queue: ${INTER_PROCESS_QUEUE}`)
}

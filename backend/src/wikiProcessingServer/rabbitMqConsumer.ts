import * as amqplib from 'amqplib'
import { MikroORM } from '@mikro-orm/core'
import { logger } from '@/lib/logger'
import {
    RABBITMQ_HOST,
    RABBITMQ_PASSWORD,
    RABBITMQ_PORT,
    RABBITMQ_USER,
    RABBITMQ_VHOST,
    WIKI_BATCH_SIZE,
    WIKI_RABBITMQ_QUEUE_NAME,
} from '@/settings'
import { WikiCompilerService } from '@/services/wiki/wikiCompilerService'
import type { WikiRefreshQueueMessage } from '@/lib/wikiQueueClient'

let connection: amqplib.ChannelModel | null = null
let channel: amqplib.Channel | null = null

async function initRabbitMq(): Promise<void> {
    const url = `amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@${RABBITMQ_HOST}:${RABBITMQ_PORT}${RABBITMQ_VHOST}`
    connection = await amqplib.connect(url)
    channel = await connection.createChannel()
    await channel.assertQueue(WIKI_RABBITMQ_QUEUE_NAME, { durable: true })
    await channel.prefetch(Math.max(1, WIKI_BATCH_SIZE))
}

export async function runWikiRabbitMQConsumer(orm: MikroORM): Promise<void> {
    await initRabbitMq()
    if (!channel) {
        throw new Error('Wiki RabbitMQ channel not initialized')
    }

    await channel.consume(
        WIKI_RABBITMQ_QUEUE_NAME,
        async (msg) => {
            if (!msg || !channel) {
                return
            }

            try {
                const payload = JSON.parse(msg.content.toString()) as WikiRefreshQueueMessage
                const em = orm.em.fork()
                await WikiCompilerService.processPendingRefreshes(em, undefined, payload.project_uuid || null)
                channel.ack(msg)
            } catch (error) {
                logger.error({ err: error }, 'Error processing wiki RabbitMQ message')
                channel.nack(msg, false, true)
            }
        },
        { noAck: false }
    )
}

export async function closeWikiRabbitMQ(): Promise<void> {
    if (channel) {
        await channel.close()
        channel = null
    }
    if (connection) {
        await connection.close()
        connection = null
    }
}

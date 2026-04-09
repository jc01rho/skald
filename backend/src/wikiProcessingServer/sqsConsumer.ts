import { Message } from '@aws-sdk/client-sqs'
import { MikroORM } from '@mikro-orm/core'
import { logger } from '@/lib/logger'
import { deleteMessage, publishMessage, receiveMessagesForQueue } from '@/lib/sqsClient'
import { SQS_DLQ_QUEUE_URL, WIKI_SQS_QUEUE_URL } from '@/settings'
import { WikiCompilerService } from '@/services/wiki/wikiCompilerService'
import type { WikiRefreshQueueMessage } from '@/lib/wikiQueueClient'

async function processMessage(orm: MikroORM, message: Message): Promise<void> {
    if (!message.Body) {
        return
    }

    try {
        const payload = JSON.parse(message.Body) as WikiRefreshQueueMessage
        const em = orm.em.fork()
        await WikiCompilerService.processPendingRefreshes(em, undefined, payload.project_uuid || null)

        if (message.ReceiptHandle && WIKI_SQS_QUEUE_URL) {
            await deleteMessage(message, WIKI_SQS_QUEUE_URL)
        }
    } catch (error) {
        logger.error({ err: error }, 'Error processing wiki SQS message')
        if (message.ReceiptHandle && WIKI_SQS_QUEUE_URL) {
            await deleteMessage(message, WIKI_SQS_QUEUE_URL)
        }
        if (SQS_DLQ_QUEUE_URL && message.Body) {
            await publishMessage(message.Body, SQS_DLQ_QUEUE_URL)
        }
    }
}

export async function runWikiSQSConsumer(orm: MikroORM): Promise<void> {
    while (true) {
        const response = await receiveMessagesForQueue(WIKI_SQS_QUEUE_URL)
        if (response.Messages?.length) {
            await Promise.allSettled(response.Messages.map((message) => processMessage(orm, message)))
        }
    }
}

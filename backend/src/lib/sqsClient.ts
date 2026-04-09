import {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand,
    Message,
    SendMessageCommand,
    SendMessageCommandOutput,
} from '@aws-sdk/client-sqs'
import { AWS_REGION, SQS_QUEUE_URL } from '@/settings'

const MAX_MESSAGES = 10
const WAIT_TIME_SECONDS = 1
const VISIBILITY_TIMEOUT = 60

let sqsClient: SQSClient | null = null

const initSQSClient = () => {
    if (sqsClient) {
        return sqsClient
    }

    // AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are automatically pulled from the environment
    sqsClient = new SQSClient({
        region: AWS_REGION,
    })

    return sqsClient
}

export const receiveMessagesForQueue = async (queueUrl: string | undefined) => {
    const _sqsClient = initSQSClient()
    if (!queueUrl) {
        throw new Error('Queue URL is required')
    }

    const command = new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: MAX_MESSAGES,
        WaitTimeSeconds: WAIT_TIME_SECONDS,
        VisibilityTimeout: VISIBILITY_TIMEOUT,
    })
    return await _sqsClient.send(command)
}

export const receiveMessages = async () => receiveMessagesForQueue(SQS_QUEUE_URL)

export const deleteMessage = async (message: Message, queueUrl: string = SQS_QUEUE_URL || '') => {
    const _sqsClient = initSQSClient()
    if (!queueUrl) {
        throw new Error('Queue URL is required')
    }

    await _sqsClient.send(
        new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
        })
    )
}

export const publishMessage = async (message: string, queueUrl: string): Promise<SendMessageCommandOutput> => {
    const _sqsClient = initSQSClient()

    const command = new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: message,
    })

    const response = await _sqsClient.send(command)

    return response
}

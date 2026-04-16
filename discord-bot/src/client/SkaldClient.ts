import { ChatOptions, ChatResponse, SSEEvent } from './types.js'

const MAX_RETRIES = 3
const RETRY_DELAYS_MS = [1000, 2000, 4000]

const sleep = async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
}

const buildChatPath = (projectId: string) => `/api/v1/chat/?project_id=${encodeURIComponent(projectId)}`

const normalizeErrorMessage = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message
    }
    if (typeof error === 'string') {
        return error
    }
    return 'Unknown error'
}

export class SkaldClient {
    private readonly baseUrl: string
    private readonly apiKey: string
    private readonly projectId: string

    constructor(config: { baseUrl: string; apiKey: string; projectId: string }) {
        this.baseUrl = config.baseUrl.replace(/\/$/, '')
        this.apiKey = config.apiKey
        this.projectId = config.projectId
    }

    async *chatStream(query: string, options: ChatOptions = {}): AsyncGenerator<SSEEvent> {
        const requestBody = {
            query,
            stream: true,
            ...options,
        }

        let hasReceivedToken = false

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(`${this.baseUrl}${buildChatPath(this.projectId)}`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                        Accept: 'text/event-stream',
                    },
                    body: JSON.stringify(requestBody),
                })

                if (!response.ok) {
                    const errorText = await this.parseHttpError(response)
                    throw new Error(errorText)
                }

                const reader = response.body?.getReader()
                if (!reader) {
                    throw new Error('No response body for SSE stream')
                }

                const decoder = new TextDecoder()
                let buffer = ''

                while (true) {
                    const { done, value } = await reader.read()
                    if (done) {
                        break
                    }

                    buffer += decoder.decode(value, { stream: true })
                    const lines = buffer.split('\n')
                    buffer = lines.pop() || ''

                    for (const rawLine of lines) {
                        const line = rawLine.trim()
                        if (!line || line.startsWith(':')) {
                            continue
                        }
                        if (!line.startsWith('data:')) {
                            continue
                        }

                        const payload = line.slice(5).trim()
                        if (!payload) {
                            continue
                        }

                        try {
                            const event = JSON.parse(payload) as SSEEvent
                            if (event.type === 'token' && event.content) {
                                hasReceivedToken = true
                            }
                            yield event
                        } catch {
                            yield {
                                type: hasReceivedToken ? 'transport_error' : 'error',
                                content: 'Failed to parse SSE message',
                            }
                            return
                        }
                    }
                }

                if (buffer.trim().startsWith('data:')) {
                    const payload = buffer.trim().slice(5).trim()
                    if (payload) {
                        try {
                            const event = JSON.parse(payload) as SSEEvent
                            if (event.type === 'token' && event.content) {
                                hasReceivedToken = true
                            }
                            yield event
                        } catch {
                            yield {
                                type: hasReceivedToken ? 'transport_error' : 'error',
                                content: 'Failed to parse trailing SSE message',
                            }
                            return
                        }
                    }
                }

                return
            } catch (error) {
                const isLastAttempt = attempt === MAX_RETRIES
                if (hasReceivedToken) {
                    yield {
                        type: 'transport_error',
                        content: normalizeErrorMessage(error),
                    }
                    return
                }

                if (isLastAttempt) {
                    yield {
                        type: 'error',
                        content: normalizeErrorMessage(error),
                    }
                    return
                }

                await sleep(RETRY_DELAYS_MS[attempt - 1])
            }
        }
    }

    async chat(query: string, options: ChatOptions = {}): Promise<ChatResponse> {
        const requestBody = {
            query,
            stream: false,
            ...options,
        }

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(`${this.baseUrl}${buildChatPath(this.projectId)}`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestBody),
                })

                if (!response.ok) {
                    const errorText = await this.parseHttpError(response)
                    throw new Error(errorText)
                }

                return (await response.json()) as ChatResponse
            } catch (error) {
                const isLastAttempt = attempt === MAX_RETRIES
                if (isLastAttempt) {
                    throw new Error(
                        `Chat request failed after ${MAX_RETRIES} attempts: ${normalizeErrorMessage(error)}`
                    )
                }
                await sleep(RETRY_DELAYS_MS[attempt - 1])
            }
        }

        throw new Error('Unreachable state in chat retry loop')
    }

    private async parseHttpError(response: Response): Promise<string> {
        try {
            const data = (await response.json()) as { error?: string }
            return data.error || `HTTP error: ${response.status}`
        } catch {
            return `HTTP error: ${response.status}`
        }
    }
}

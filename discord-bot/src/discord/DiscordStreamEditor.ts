import { Message } from 'discord.js'
import { logger } from '../logger.js'

export class DiscordStreamEditor {
    private message: Message
    private extraMessages: Message[] = []
    private buffer: string = ''
    private lastEditTime: number = 0
    private timer: NodeJS.Timeout | null = null
    private isFinalized: boolean = false
    private editChain: Promise<void> = Promise.resolve()

    private readonly THROTTLE_MS = 400
    private readonly MAX_LENGTH = 1900
    private readonly STREAMING_PREFIX = '⏳ 답변을 스트리밍하는 중입니다. 아래 내용이 실시간으로 이어집니다.\n\n'
    private readonly STREAMING_CURSOR = '▌'

    constructor(message: Message) {
        this.message = message
    }

    append(text: string): void {
        if (this.isFinalized) {
            throw new Error('Cannot append to finalized message')
        }

        this.buffer += text
        this.scheduleEdit()
    }

    private scheduleEdit(): void {
        if (this.timer !== null) {
            return
        }

        const now = Date.now()
        const timeSinceLastEdit = now - this.lastEditTime
        const timeToWait = Math.max(0, this.THROTTLE_MS - timeSinceLastEdit)

        this.timer = setTimeout(async () => {
            this.timer = null
            try {
                await this.performEdit()
            } catch (error) {
                logger.error({ error }, 'Failed to edit message')
                // Retry after a short delay if not finalized
                if (!this.isFinalized) {
                    this.scheduleEdit()
                }
            }
        }, timeToWait)
    }

    private async performEdit(): Promise<void> {
        const nextEdit = this.editChain
            .catch(() => undefined)
            .then(async () => {
                const chunks = this.formatChunks()

                if (chunks.length === 0) {
                    return
                }

                await this.syncMessages(chunks)
                this.lastEditTime = Date.now()
            })

        this.editChain = nextEdit
        await nextEdit
    }

    private splitMessage(text: string): string[] {
        const normalized = text.trim()
        if (!normalized) {
            return []
        }

        if (normalized.length <= this.MAX_LENGTH) {
            return [normalized]
        }

        const chunks: string[] = []
        const lines = normalized.split('\n')
        let current = ''

        for (const line of lines) {
            const candidate = current ? `${current}\n${line}` : line
            if (candidate.length <= this.MAX_LENGTH) {
                current = candidate
                continue
            }

            if (current) {
                chunks.push(current)
                current = ''
            }

            if (line.length <= this.MAX_LENGTH) {
                current = line
                continue
            }

            for (let start = 0; start < line.length; start += this.MAX_LENGTH) {
                chunks.push(line.slice(start, start + this.MAX_LENGTH))
            }
        }

        if (current) {
            chunks.push(current)
        }

        return chunks
    }

    private formatChunks(): string[] {
        if (this.isFinalized) {
            return this.splitMessage(this.buffer)
        }

        return this.formatStreamingPreviewChunks()
    }

    private formatStreamingPreviewChunks(): string[] {
        const normalized = this.buffer.trim()
        if (!normalized) {
            return []
        }

        const streamingText = `${normalized}${this.STREAMING_CURSOR}`
        const firstChunkLimit = this.MAX_LENGTH - this.STREAMING_PREFIX.length

        if (firstChunkLimit <= 0) {
            return this.splitMessage(streamingText)
        }

        const firstChunkContent = streamingText.slice(0, firstChunkLimit)
        const remaining = streamingText.slice(firstChunkLimit)
        const chunks = [`${this.STREAMING_PREFIX}${firstChunkContent}`]

        for (let start = 0; start < remaining.length; start += this.MAX_LENGTH) {
            chunks.push(remaining.slice(start, start + this.MAX_LENGTH))
        }

        return chunks
    }

    private async syncMessages(chunks: string[]): Promise<void> {
        await this.message.edit(chunks[0])

        for (let index = 1; index < chunks.length; index++) {
            const targetIndex = index - 1
            const existing = this.extraMessages[targetIndex]

            if (existing) {
                await existing.edit(chunks[index])
                continue
            }

            const created = await this.message.reply(chunks[index])
            this.extraMessages.push(created)
        }

        if (this.extraMessages.length > chunks.length - 1) {
            const staleMessages = this.extraMessages.splice(chunks.length - 1)
            for (const stale of staleMessages) {
                try {
                    await stale.delete()
                } catch (error) {
                    logger.warn({ error }, 'Failed to delete stale streaming message')
                }
            }
        }
    }

    async finalize(finalContent?: string): Promise<void> {
        if (this.isFinalized) {
            return
        }

        if (typeof finalContent === 'string') {
            this.buffer = finalContent
        }

        this.isFinalized = true

        if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
        }

        try {
            await this.performEdit()
        } catch (error) {
            logger.error({ error }, 'Failed to finalize message')
            throw new Error('Failed to finalize streaming message')
        }
    }

    async showError(error: string): Promise<void> {
        this.isFinalized = true
        this.buffer = ''

        if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
        }

        const errorMessage = `❌ Error: ${error.slice(0, 1800)}`

        try {
            const nextEdit = this.editChain
                .catch(() => undefined)
                .then(async () => {
                    await this.message.edit(errorMessage)

                    if (this.extraMessages.length > 0) {
                        const staleMessages = this.extraMessages.splice(0)
                        for (const stale of staleMessages) {
                            try {
                                await stale.delete()
                            } catch (deleteError) {
                                logger.warn({ deleteError }, 'Failed to delete stale error message chunk')
                            }
                        }
                    }
                })

            this.editChain = nextEdit
            await nextEdit
        } catch (editError) {
            logger.error({ editError }, 'Failed to show error message')
        }
    }
}

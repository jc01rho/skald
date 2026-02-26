import { Message } from 'discord.js'

export class DiscordStreamEditor {
    private message: Message
    private buffer: string = ''
    private lastEditTime: number = 0
    private timer: NodeJS.Timeout | null = null
    private isFinalized: boolean = false

    private readonly THROTTLE_MS = 1000
    private readonly MAX_LENGTH = 1900
    private readonly STREAMING_INDICATOR = '⏳'

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
                console.error('Failed to edit message:', error)
                // Retry after a short delay if not finalized
                if (!this.isFinalized) {
                    this.scheduleEdit()
                }
            }
        }, timeToWait)
    }

    private async performEdit(): Promise<void> {
        const content = this.formatContent()
        
        // Discord doesn't allow empty messages
        if (!content || content.trim().length === 0) {
            return
        }

        try {
            await this.message.edit(content)
            this.lastEditTime = Date.now()
        } catch (error) {
            console.error('Failed to edit message:', error)
            throw error // Re-throw so scheduleEdit can catch it
        }
    }

    private formatContent(): string {
        let content = this.buffer

        if (content.length > this.MAX_LENGTH) {
            content = content.slice(0, this.MAX_LENGTH - 3) + '...'
        }

        if (!this.isFinalized) {
            return `${this.STREAMING_INDICATOR} ${content}`
        }

        return content
    }

    async finalize(): Promise<void> {
        if (this.isFinalized) {
            return
        }

        this.isFinalized = true

        // Wait for any pending edit to complete
        if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
            // Perform one final edit
            try {
                await this.performEdit()
            } catch (error) {
                console.error('Failed to finalize message:', error)
            }
            return
        }

        await this.performEdit()
    }

    async showError(error: string): Promise<void> {
        this.isFinalized = true

        if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
        }

        const errorMessage = `❌ Error: ${error.slice(0, 1800)}`

        try {
            await this.message.edit(errorMessage)
        } catch (editError) {
            console.error('Failed to show error message:', editError)
        }
    }
}

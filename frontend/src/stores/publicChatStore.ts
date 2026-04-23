import { create } from 'zustand'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { ApiStreamData, ApiErrorData } from '@/lib/types'

export interface PublicChatMessage {
    id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    timestamp: Date
    isStreaming?: boolean
    references?: Record<number, { memo_uuid: string; memo_title: string }>
}

interface PublicChatState {
    messages: PublicChatMessage[]
    isLoading: boolean
    isStreaming: boolean
    currentStreamingMessageId: string | null
    chatSessionId: string | null
    systemPrompt: string
    sendMessage: (query: string, slug: string) => Promise<void>
    clearMessages: () => void
    addMessage: (message: Omit<PublicChatMessage, 'id' | 'timestamp'> & { id?: string }) => void
    updateStreamingMessage: (messageId: string, content: string) => void
    setMessageReferences: (
        messageId: string,
        references: Record<number, { memo_uuid: string; memo_title: string }>
    ) => void
    finishStreaming: (messageId: string) => void
    setSystemPrompt: (prompt: string) => void
}

export const usePublicChatStore = create<PublicChatState>()((set, get) => ({
    messages: [],
    isLoading: false,
    isStreaming: false,
    currentStreamingMessageId: null,
    chatSessionId: null,
    systemPrompt: '',

    setSystemPrompt: (prompt: string) => {
        set({ systemPrompt: prompt })
    },

    addMessage: (message) => {
        const newMessage: PublicChatMessage = {
            ...message,
            id: message.id || crypto.randomUUID(),
            timestamp: new Date(),
        }
        set((state) => ({
            messages: [...state.messages, newMessage],
        }))
    },

    updateStreamingMessage: (messageId, content) => {
        set((state) => ({
            messages: state.messages.map((msg) => (msg.id === messageId ? { ...msg, content } : msg)),
        }))
    },

    setMessageReferences: (messageId, references) => {
        set((state) => ({
            messages: state.messages.map((msg) => (msg.id === messageId ? { ...msg, references } : msg)),
        }))
    },

    finishStreaming: (messageId) => {
        set((state) => ({
            messages: state.messages.map((msg) => (msg.id === messageId ? { ...msg, isStreaming: false } : msg)),
            isStreaming: false,
            currentStreamingMessageId: null,
        }))
    },

    sendMessage: async (query: string, slug: string) => {
        if (!query.trim()) {
            return
        }

        get().addMessage({
            role: 'user',
            content: query.trim(),
        })

        set({ isLoading: true, isStreaming: true })

        const assistantMessageId = crypto.randomUUID()
        let activeAssistantMessageId = assistantMessageId

        get().addMessage({
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            isStreaming: true,
        })

        set({ currentStreamingMessageId: assistantMessageId })

        const payload: Record<string, unknown> = {
            query: query.trim(),
        }

        const systemPrompt = get().systemPrompt.trim()
        if (systemPrompt) {
            payload.system_prompt = systemPrompt
        }

        const chatSessionId = get().chatSessionId
        if (chatSessionId) {
            payload.chat_id = chatSessionId
        }

        api.stream(
            `/public_chat/${slug}`,
            payload,
            (data: ApiStreamData) => {
                if (data.type === 'accepted' && 'chat_id' in data && typeof data.chat_id === 'string') {
                    set({ chatSessionId: data.chat_id })
                    return
                }

                if (data.type === 'progress') {
                    return
                }

                if (data.type === 'preview') {
                    const previewContent = data.content?.trim()
                    const previewMessage = get().messages.find((message) => message.id === assistantMessageId)

                    if (!previewContent || activeAssistantMessageId !== assistantMessageId || !previewMessage) {
                        return
                    }

                    if (previewMessage.content.trim()) {
                        return
                    }

                    set((state) => ({
                        messages: state.messages.map((message) =>
                            message.id === assistantMessageId
                                ? { ...message, content: previewContent, isStreaming: false }
                                : message
                        ),
                    }))

                    const authoritativeMessageId = crypto.randomUUID()
                    get().addMessage({
                        id: authoritativeMessageId,
                        role: 'assistant',
                        content: '',
                        isStreaming: true,
                    })

                    activeAssistantMessageId = authoritativeMessageId
                    set({ currentStreamingMessageId: authoritativeMessageId, isStreaming: true })
                    return
                }

                if (data.type === 'token' && data.content) {
                    const currentContent =
                        get().messages.find((message) => message.id === activeAssistantMessageId)?.content || ''
                    get().updateStreamingMessage(activeAssistantMessageId, currentContent + data.content)
                } else if (data.type === 'references' && data.content) {
                    try {
                        const references = JSON.parse(data.content)
                        get().setMessageReferences(activeAssistantMessageId, references)
                    } catch (error) {
                        console.error('Failed to parse references:', error)
                    }
                } else if (data.type === 'done') {
                    const activeMessage = get().messages.find((message) => message.id === activeAssistantMessageId)

                    if (
                        activeAssistantMessageId !== assistantMessageId &&
                        activeMessage &&
                        !activeMessage.content.trim() &&
                        !activeMessage.references
                    ) {
                        set((state) => ({
                            messages: state.messages.filter((message) => message.id !== activeAssistantMessageId),
                            isStreaming: false,
                            currentStreamingMessageId: null,
                        }))
                    } else {
                        get().finishStreaming(activeAssistantMessageId)
                    }

                    if ('chat_id' in data && typeof data.chat_id === 'string') {
                        set({ chatSessionId: data.chat_id })
                    }
                } else if (data.type === 'error') {
                    get().finishStreaming(activeAssistantMessageId)
                    get().updateStreamingMessage(activeAssistantMessageId, `Error: ${data.content || 'An error occurred'}`)
                }
            },
            (error: ApiErrorData | Event) => {
                console.error('Chat stream error:', error)
                get().finishStreaming(activeAssistantMessageId)

                const errorMessage =
                    'error' in error && typeof error.error === 'string' ? error.error : 'Failed to get response'

                get().updateStreamingMessage(activeAssistantMessageId, `Error: ${errorMessage}`)
                toast.error(errorMessage)
            }
        )

        set({ isLoading: false })
    },

    clearMessages: () => {
        set({ messages: [], chatSessionId: null })
    },
}))

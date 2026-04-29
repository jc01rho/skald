import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '@/lib/api'
import { useProjectStore } from '@/stores/projectStore'
import { toast } from 'sonner'
import type { ApiStreamData, ApiErrorData, MemoFilter } from '@/lib/types'

export interface ChatMessage {
    id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    timestamp: Date
    isStreaming?: boolean
    references?: Record<number, { memo_uuid: string; memo_title: string }>
}

export interface RagConfig {
    queryRewriteEnabled: boolean
    rerankingEnabled: boolean
    vectorSearchTopK: number
    similarityThreshold: number
    rerankingTopK: number
    referencesEnabled: boolean
}

interface ChatState {
    messages: ChatMessage[]
    isLoading: boolean
    isStreaming: boolean
    currentStreamingMessageId: string | null
    systemPrompt: string
    llmProvider: string
    ragConfig: RagConfig
    filters: MemoFilter[]
    chatSessionId: string | null
    userContext: string
    setSystemPrompt: (prompt: string) => void
    setLlmProvider: (provider: string) => void
    setRagConfig: (config: Partial<RagConfig>) => void
    setFilters: (filters: MemoFilter[]) => void
    addFilter: (filter: Omit<MemoFilter, 'id'>) => void
    updateFilter: (id: string, filter: Partial<Omit<MemoFilter, 'id'>>) => void
    removeFilter: (id: string) => void
    setUserContext: (context: string) => void
    sendMessage: (query: string) => Promise<void>
    clearMessages: () => void
    addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string }) => void
    updateStreamingMessage: (messageId: string, content: string) => void
    setMessageReferences: (
        messageId: string,
        references: Record<number, { memo_uuid: string; memo_title: string }>
    ) => void
    finishStreaming: (messageId: string) => void
}

function isPersistedChatSettings(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

export const useChatStore = create<ChatState>()(
    persist(
        (set, get) => ({
            messages: [],
            isLoading: false,
            isStreaming: false,
            currentStreamingMessageId: null,
            systemPrompt: '',
            llmProvider: 'cli-proxy-api',
            ragConfig: {
                queryRewriteEnabled: false,
                rerankingEnabled: true,
                vectorSearchTopK: 50,
                similarityThreshold: 0.8,
                rerankingTopK: 25,
                referencesEnabled: false,
            },
            filters: [],
            chatSessionId: null,
            userContext: '',

            setSystemPrompt: (prompt: string) => {
                set({ systemPrompt: prompt })
            },
            setLlmProvider: (provider: string) => {
                set({ llmProvider: provider })
            },

            setRagConfig: (config: Partial<RagConfig>) => {
                set((state) => ({
                    ragConfig: { ...state.ragConfig, ...config },
                }))
            },

            setFilters: (filters: MemoFilter[]) => {
                set({ filters })
            },

            setUserContext: (context: string) => {
                set({ userContext: context })
            },

            addFilter: (filter: Omit<MemoFilter, 'id'>) => {
                const newFilter: MemoFilter = {
                    ...filter,
                    id: crypto.randomUUID(),
                }
                set((state) => ({
                    filters: [...state.filters, newFilter],
                }))
            },

            updateFilter: (id: string, filter: Partial<Omit<MemoFilter, 'id'>>) => {
                set((state) => ({
                    filters: state.filters.map((f) => (f.id === id ? { ...f, ...filter } : f)),
                }))
            },

            removeFilter: (id: string) => {
                set((state) => ({
                    filters: state.filters.filter((f) => f.id !== id),
                }))
            },

            addMessage: (message) => {
                const newMessage: ChatMessage = {
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
                    messages: state.messages.map((msg) =>
                        msg.id === messageId ? { ...msg, isStreaming: false } : msg
                    ),
                    isStreaming: false,
                    currentStreamingMessageId: null,
                }))
            },

            sendMessage: async (query: string) => {
                const currentProject = useProjectStore.getState().currentProject
                if (!currentProject) {
                    toast.error('No project selected')
                    return
                }

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
                    project_id: currentProject.uuid,
                    stream: true,
                }

                const systemPrompt = get().systemPrompt.trim()
                if (systemPrompt) {
                    payload.system_prompt = systemPrompt
                }

                const chatSessionId = get().chatSessionId
                if (chatSessionId) {
                    payload.chat_id = chatSessionId
                }

                const userContext = get().userContext.trim()
                if (userContext) {
                    payload.user_context = userContext
                }

                // Include RAG config
                const ragConfig = get().ragConfig
                const llmProvider = get().llmProvider
                payload.rag_config = {
                    llm_provider: llmProvider,
                    query_rewrite: { enabled: ragConfig.queryRewriteEnabled },
                    reranking: { enabled: ragConfig.rerankingEnabled, top_k: ragConfig.rerankingTopK },
                    vector_search: {
                        top_k: ragConfig.vectorSearchTopK,
                        similarity_threshold: ragConfig.similarityThreshold,
                    },
                    references: { enabled: ragConfig.referencesEnabled },
                }

                // Include filters (strip frontend-only id field)
                const filters = get().filters
                if (filters.length > 0) {
                    payload.filters = filters.map(({ field, operator, value, filter_type }) => ({
                        field,
                        operator,
                        value,
                        filter_type,
                    }))
                }

                api.stream(
                    '/v1/chat/',
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
                            const activeMessage = get().messages.find(
                                (message) => message.id === activeAssistantMessageId
                            )

                            if (
                                activeAssistantMessageId !== assistantMessageId &&
                                activeMessage &&
                                !activeMessage.content.trim() &&
                                !activeMessage.references
                            ) {
                                set((state) => ({
                                    messages: state.messages.filter(
                                        (message) => message.id !== activeAssistantMessageId
                                    ),
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
                            get().updateStreamingMessage(
                                activeAssistantMessageId,
                                `Error: ${data.content || 'An error occurred'}`
                            )
                        }
                    },
                    (error: ApiErrorData | Event) => {
                        console.error('Chat stream error:', error)
                        get().finishStreaming(activeAssistantMessageId)

                        // Extract error message from ApiErrorData or use generic message
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
        }),
        {
            name: 'playground-settings',
            version: 2,
            migrate: (persistedState) => {
                if (!isPersistedChatSettings(persistedState)) {
                    return persistedState
                }

                const rest = { ...persistedState }
                delete rest.userContext
                return rest
            },
            partialize: (state) => ({
                systemPrompt: state.systemPrompt,
                llmProvider: state.llmProvider,
                ragConfig: state.ragConfig,
                filters: state.filters,
            }),
        }
    )
)

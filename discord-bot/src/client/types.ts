export type SSEEvent =
    | { type: 'token'; content: string }
    | { type: 'references'; content: Record<string, { memo_uuid: string; memo_title: string }> }
    | { type: 'done'; chat_id: string }
    | { type: 'error'; content: string }

export interface ChatOptions {
    chat_id?: string
    filters?: unknown[]
    system_prompt?: string
    rag_config?: Record<string, unknown>
}

export interface ChatResponse {
    ok: boolean
    chat_id: string
    response: string
    intermediate_steps: unknown[]
    references?: Record<string, { memo_uuid: string; memo_title: string }>
}

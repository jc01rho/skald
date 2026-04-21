export type SSEEvent =
    | { type: 'token'; content: string }
    | {
          type: 'references'
          // Backend sends JSON.stringify(references), so content is actually a string
          content: string | Record<string, { memo_uuid: string; memo_title: string; source_url?: string }>
      }
    | { type: 'done'; chat_id: string }
    | { type: 'accepted'; chat_id: string }
    | { type: 'progress'; status: string }
    | { type: 'preview'; content: string }
    | { type: 'transport_error'; content: string }
    | { type: 'error'; content: string }
export interface MemoFilter {
    field: string
    operator: 'eq' | 'neq' | 'contains' | 'startswith' | 'endswith' | 'in' | 'not_in'
    value: string | string[]
    filter_type: 'native_field' | 'custom_metadata'
}

export interface ChatOptions {
    chat_id?: string
    history?: Array<{ role: string; content: string }>
    filters?: MemoFilter[]
    system_prompt?: string
    rag_config?: Record<string, unknown>
}

export interface ChatResponse {
    ok: boolean
    chat_id: string
    response: string
    intermediate_steps: unknown[]
    references?: Record<string, { memo_uuid: string; memo_title: string; source_url?: string }>
}

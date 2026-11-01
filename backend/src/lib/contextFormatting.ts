/**
 * Formatting helpers for the RAG prompt context.
 *
 * Two invariants live here so they are unit-testable without a graph or a database:
 *   - every retrieved result is labelled with its memo title and source URL when known;
 *   - exact-key memo content is bounded before it enters the prompt (memos reach hundreds of KB).
 */

export const EXACT_LOOKUP_MAX_CONTENT_CHARS = 16_000

export interface ContextMemoProperties {
    title?: string | null
    summary?: string | null
    content?: string | null
    source_url?: string | null
}

export interface ContextRerankResult {
    index: number
    memo_uuid?: string
    memo_title?: string
    source_url?: string
}

export function boundExactLookupContent(content: string): string {
    if (content.length <= EXACT_LOOKUP_MAX_CONTENT_CHARS) {
        return content
    }

    return `${content.slice(0, EXACT_LOOKUP_MAX_CONTENT_CHARS)}\n\n[Content truncated: showing the first ${EXACT_LOOKUP_MAX_CONTENT_CHARS} of ${content.length} characters]`
}

export function buildContextResultHeader<T extends ContextMemoProperties>(
    result: ContextRerankResult,
    fallbackMemoUuid: string | null | undefined,
    memoPropertiesMap: Map<string, T> | null | undefined,
    position: number
): string {
    const memoUuid = result.memo_uuid || fallbackMemoUuid
    const memo = memoUuid ? memoPropertiesMap?.get(memoUuid) : undefined
    const title = result.memo_title || memo?.title || ''
    const sourceUrl = result.source_url || memo?.source_url || ''

    const header = [`Result ${position}:`]
    if (title) header.push(`Title: ${title}`)
    if (sourceUrl) header.push(`Source: ${sourceUrl}`)
    return header.join(' ')
}

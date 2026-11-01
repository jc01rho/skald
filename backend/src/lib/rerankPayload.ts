/**
 * Single source of truth for what we send to the reranker.
 *
 * The reranker scores `query` against `documents`. Both matter:
 * - Document: chat retrieval measured 0.903 for a title+summary+chunk document vs 0.0002 for a
 *   bare chunk on the same pair, so /search must use the same construction as chat.
 * - Query: sending the rewritten retrieval query alone scored 0.990 vs 0.125 for the
 *   `original\n\nRewritten retrieval query: ...` wrapper. The original query stays available
 *   as a separate vector-search arm; it must not be glued onto the rerank query.
 *
 * Kept dependency-free so CI can pin the exact wire format without a network or secrets.
 */

export interface RerankDocumentMemo {
    title?: string | null
    summary?: string | null
}

/**
 * Build the document string sent to the reranker for one chunk.
 * Falls back to the bare chunk content when no memo metadata is available.
 */
export function buildRerankDocument(chunkContent: string, memo?: RerankDocumentMemo | null): string {
    if (!memo) {
        return chunkContent
    }

    return `Title: ${memo.title ?? ''}\n\nFull content summary: ${memo.summary ?? ''}\n\nChunk content: ${chunkContent}\n\n`
}

/**
 * Build the query string sent to the reranker.
 * Callers pass the rewritten query when one exists, otherwise the original query.
 */
export function buildRerankQuery(query: string): string {
    return query.trim()
}

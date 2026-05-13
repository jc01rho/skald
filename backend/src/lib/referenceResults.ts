export type ReferenceCandidate = {
    memo_uuid?: string
    memo_title?: string
    source_url?: string
    doc_type?: string
}

type ExactLookupReference = {
    memo_uuid?: string
    title: string
    source_url: string
    found: boolean
    status?: 'hit' | 'archived_only' | 'miss'
}

function getReferenceKey(reference: ReferenceCandidate): string | null {
    if (reference.memo_uuid) {
        return `memo:${reference.memo_uuid}`
    }

    if (reference.memo_title) {
        return `title:${reference.memo_title}|url:${reference.source_url || ''}`
    }

    return null
}

export function buildReferenceResults(
    rerankedResults: ReferenceCandidate[],
    exactLookupResults?: ExactLookupReference[] | null
): ReferenceCandidate[] {
    const merged: ReferenceCandidate[] = []
    const seen = new Set<string>()

    const pushIfNew = (reference: ReferenceCandidate) => {
        if (!reference.memo_title) {
            return
        }

        const key = getReferenceKey(reference)
        if (!key || seen.has(key)) {
            return
        }

        seen.add(key)
        merged.push(reference)
    }

    for (const result of exactLookupResults || []) {
        if (!result.found || result.status !== 'hit' || !result.memo_uuid) {
            continue
        }

        pushIfNew({
            memo_uuid: result.memo_uuid,
            memo_title: result.title,
            source_url: result.source_url,
        })
    }

    for (const result of rerankedResults) {
        pushIfNew(result)
    }

    return merged
}

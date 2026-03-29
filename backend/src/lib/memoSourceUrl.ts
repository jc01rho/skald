import { FRONTEND_URL } from '@/settings'

type MemoSourceUrlInput = {
    projectUuid: string
    memoUuid: string
    sourceUrl?: string | null
    source?: string | null
    submissionId?: string | null
}

export function buildMemoSourceUrl({
    projectUuid,
    memoUuid,
    sourceUrl,
    source,
    submissionId,
}: MemoSourceUrlInput): string {
    const trimmedSourceUrl = sourceUrl?.trim()
    if (trimmedSourceUrl) {
        return trimmedSourceUrl
    }

    if (submissionId || source === 'public-submission') {
        return `${FRONTEND_URL}/projects/${projectUuid}/memos/${memoUuid}`
    }

    return ''
}

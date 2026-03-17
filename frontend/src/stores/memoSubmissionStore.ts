import { create } from 'zustand'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { DetailedMemoSubmission, MemoSubmission, PublicMemo } from '@/lib/types'

interface PaginatedResponse<T> {
    count: number
    next: string | null
    previous: string | null
    results: T[]
}

interface PublicMemoSubmissionPayload {
    projectUuid: string
    title: string
    content: string
    source?: string
    type?: string
    client_reference_id?: string
    expiration_date?: string
    tags?: string[]
    metadata?: Record<string, unknown>
}

interface PublicFileMemoSubmissionPayload {
    projectUuid: string
    file: File
    title?: string
    source?: string
    client_reference_id?: string
    expiration_date?: string
    tags?: string[]
    metadata?: Record<string, unknown>
}

interface MemoSubmissionStore {
    publicMemos: PublicMemo[]
    publicMemosLoading: boolean
    publicMemosError: string | null
    publicMemosTotalCount: number
    publicMemosCurrentPage: number
    publicMemosPageSize: number
    submissions: MemoSubmission[]
    submissionsLoading: boolean
    submissionsError: string | null
    submissionsTotalCount: number
    submissionsCurrentPage: number
    submissionsPageSize: number
    fetchPublicMemos: (page?: number, pageSize?: number) => Promise<void>
    submitPublicMemo: (payload: PublicMemoSubmissionPayload) => Promise<boolean>
    submitPublicFileMemo: (payload: PublicFileMemoSubmissionPayload) => Promise<boolean>
    fetchMemoSubmissions: (projectUuid: string, page?: number, pageSize?: number) => Promise<void>
    getMemoSubmissionDetails: (projectUuid: string, submissionUuid: string) => Promise<DetailedMemoSubmission | null>
    approveMemoSubmission: (projectUuid: string, submissionUuid: string, reviewNote?: string) => Promise<boolean>
    rejectMemoSubmission: (projectUuid: string, submissionUuid: string, reviewNote?: string) => Promise<boolean>
}

export const useMemoSubmissionStore = create<MemoSubmissionStore>((set, get) => ({
    publicMemos: [],
    publicMemosLoading: false,
    publicMemosError: null,
    publicMemosTotalCount: 0,
    publicMemosCurrentPage: 1,
    publicMemosPageSize: 20,
    submissions: [],
    submissionsLoading: false,
    submissionsError: null,
    submissionsTotalCount: 0,
    submissionsCurrentPage: 1,
    submissionsPageSize: 20,

    fetchPublicMemos: async (page = 1, pageSize = 20) => {
        set({ publicMemosLoading: true, publicMemosError: null })

        try {
            const response = await api.get<PaginatedResponse<PublicMemo>>(
                `/public/memos?page=${page}&page_size=${pageSize}`
            )

            if (response.error || !response.data) {
                const errorMsg = response.error || 'Failed to fetch public memos'
                set({ publicMemosLoading: false, publicMemosError: errorMsg })
                toast.error(`Failed to fetch public memos: ${errorMsg}`)
                return
            }

            set({
                publicMemos: response.data.results,
                publicMemosLoading: false,
                publicMemosError: null,
                publicMemosTotalCount: response.data.count,
                publicMemosCurrentPage: page,
                publicMemosPageSize: pageSize,
            })
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to fetch public memos'
            set({ publicMemosLoading: false, publicMemosError: errorMsg })
            toast.error(`Failed to fetch public memos: ${errorMsg}`)
        }
    },

    submitPublicMemo: async (payload) => {
        try {
            const response = await api.post<{ submission_uuid: string }>(
                `/public/memo-submissions?project_id=${payload.projectUuid}`,
                {
                    title: payload.title,
                    content: payload.content,
                    source: payload.source,
                    type: payload.type,
                    reference_id: payload.client_reference_id,
                    expiration_date: payload.expiration_date,
                    tags: payload.tags,
                    metadata: payload.metadata,
                }
            )

            if (response.error) {
                toast.error(`Failed to submit memo: ${response.error}`)
                return false
            }

            return true
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to submit memo'
            toast.error(`Failed to submit memo: ${errorMsg}`)
            return false
        }
    },

    submitPublicFileMemo: async (payload) => {
        try {
            const formData = new FormData()
            formData.append('file', payload.file)

            if (payload.title) {
                formData.append('title', payload.title)
            }
            if (payload.source) {
                formData.append('source', payload.source)
            }
            if (payload.client_reference_id) {
                formData.append('reference_id', payload.client_reference_id)
            }
            if (payload.expiration_date) {
                formData.append('expiration_date', payload.expiration_date)
            }
            if (payload.tags && payload.tags.length > 0) {
                formData.append('tags', JSON.stringify(payload.tags))
            }
            if (payload.metadata) {
                formData.append('metadata', JSON.stringify(payload.metadata))
            }

            const response = await api.postFile<{ submission_uuid: string }>(
                `/public/memo-submissions?project_id=${payload.projectUuid}`,
                formData
            )

            if (response.error) {
                toast.error(`Failed to submit document: ${response.error}`)
                return false
            }

            return true
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to submit document'
            toast.error(`Failed to submit document: ${errorMsg}`)
            return false
        }
    },

    fetchMemoSubmissions: async (projectUuid, page = 1, pageSize = 20) => {
        set({ submissionsLoading: true, submissionsError: null })

        try {
            const response = await api.get<PaginatedResponse<MemoSubmission>>(
                `/v1/memo-submissions?project_id=${projectUuid}&status=pending&page=${page}&page_size=${pageSize}`
            )

            if (response.error || !response.data) {
                const errorMsg = response.error || 'Failed to fetch memo submissions'
                set({ submissionsLoading: false, submissionsError: errorMsg })
                toast.error(`Failed to fetch memo submissions: ${errorMsg}`)
                return
            }

            set({
                submissions: response.data.results,
                submissionsLoading: false,
                submissionsError: null,
                submissionsTotalCount: response.data.count,
                submissionsCurrentPage: page,
                submissionsPageSize: pageSize,
            })
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to fetch memo submissions'
            set({ submissionsLoading: false, submissionsError: errorMsg })
            toast.error(`Failed to fetch memo submissions: ${errorMsg}`)
        }
    },

    getMemoSubmissionDetails: async (projectUuid, submissionUuid) => {
        try {
            const response = await api.get<DetailedMemoSubmission>(
                `/v1/memo-submissions/${submissionUuid}?project_id=${projectUuid}`
            )

            if (response.error || !response.data) {
                toast.error(`Failed to fetch submission details: ${response.error || 'Unknown error'}`)
                return null
            }

            return response.data
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to fetch submission details'
            toast.error(`Failed to fetch submission details: ${errorMsg}`)
            return null
        }
    },

    approveMemoSubmission: async (projectUuid, submissionUuid, reviewNote) => {
        try {
            const response = await api.post(
                `/v1/memo-submissions/${submissionUuid}/approve?project_id=${projectUuid}`,
                reviewNote ? { review_note: reviewNote } : {}
            )

            if (response.error) {
                toast.error(`Failed to approve submission: ${response.error}`)
                return false
            }

            await get().fetchMemoSubmissions(projectUuid, get().submissionsCurrentPage, get().submissionsPageSize)
            toast.success('Submission approved successfully')
            return true
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to approve submission'
            toast.error(`Failed to approve submission: ${errorMsg}`)
            return false
        }
    },

    rejectMemoSubmission: async (projectUuid, submissionUuid, reviewNote) => {
        try {
            const response = await api.post(
                `/v1/memo-submissions/${submissionUuid}/reject?project_id=${projectUuid}`,
                reviewNote ? { review_note: reviewNote } : {}
            )

            if (response.error) {
                toast.error(`Failed to reject submission: ${response.error}`)
                return false
            }

            await get().fetchMemoSubmissions(projectUuid, get().submissionsCurrentPage, get().submissionsPageSize)
            toast.success('Submission rejected successfully')
            return true
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to reject submission'
            toast.error(`Failed to reject submission: ${errorMsg}`)
            return false
        }
    },
}))

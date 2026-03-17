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

interface PublicMemoSubmissionState {
    approvedMemos: PublicMemo[]
    approvedMemosLoading: boolean
    approvedMemosError: string | null
    approvedMemosTotalCount: number
    approvedMemosCurrentPage: number
    approvedMemosPageSize: number
    pendingSubmissions: MemoSubmission[]
    pendingSubmissionsLoading: boolean
    pendingSubmissionsError: string | null
    pendingSubmissionsTotalCount: number
    pendingSubmissionsCurrentPage: number
    pendingSubmissionsPageSize: number
    submitting: boolean
    fetchApprovedMemos: (projectUuid: string, page?: number, pageSize?: number) => Promise<void>
    fetchPendingSubmissions: (projectUuid: string, page?: number, pageSize?: number) => Promise<void>
    submitPublicMemo: (payload: PublicMemoSubmissionPayload) => Promise<boolean>
    getPublicSubmissionDetails: (projectUuid: string, submissionUuid: string) => Promise<DetailedMemoSubmission | null>
}

export const usePublicMemoSubmissionStore = create<PublicMemoSubmissionState>((set) => ({
    approvedMemos: [],
    approvedMemosLoading: false,
    approvedMemosError: null,
    approvedMemosTotalCount: 0,
    approvedMemosCurrentPage: 1,
    approvedMemosPageSize: 20,
    pendingSubmissions: [],
    pendingSubmissionsLoading: false,
    pendingSubmissionsError: null,
    pendingSubmissionsTotalCount: 0,
    pendingSubmissionsCurrentPage: 1,
    pendingSubmissionsPageSize: 20,
    submitting: false,

    fetchApprovedMemos: async (projectUuid, page = 1, pageSize = 20) => {
        set({ approvedMemosLoading: true, approvedMemosError: null })

        try {
            const response = await api.get<PaginatedResponse<PublicMemo>>(
                `/public/memos?project_id=${projectUuid}&status=approved&page=${page}&page_size=${pageSize}`
            )

            if (response.error || !response.data) {
                const errorMsg = response.error || 'Failed to fetch approved memos'
                set({ approvedMemosLoading: false, approvedMemosError: errorMsg })
                toast.error(`Failed to fetch approved memos: ${errorMsg}`)
                return
            }

            set({
                approvedMemos: response.data.results,
                approvedMemosLoading: false,
                approvedMemosError: null,
                approvedMemosTotalCount: response.data.count,
                approvedMemosCurrentPage: page,
                approvedMemosPageSize: pageSize,
            })
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to fetch approved memos'
            set({ approvedMemosLoading: false, approvedMemosError: errorMsg })
            toast.error(`Failed to fetch approved memos: ${errorMsg}`)
        }
    },

    fetchPendingSubmissions: async (projectUuid, page = 1, pageSize = 20) => {
        set({ pendingSubmissionsLoading: true, pendingSubmissionsError: null })

        try {
            const response = await api.get<PaginatedResponse<MemoSubmission>>(
                `/public/memo-submissions?project_id=${projectUuid}&status=pending&page=${page}&page_size=${pageSize}`
            )

            if (response.error || !response.data) {
                const errorMsg = response.error || 'Failed to fetch pending submissions'
                set({ pendingSubmissionsLoading: false, pendingSubmissionsError: errorMsg })
                toast.error(`Failed to fetch pending submissions: ${errorMsg}`)
                return
            }

            set({
                pendingSubmissions: response.data.results,
                pendingSubmissionsLoading: false,
                pendingSubmissionsError: null,
                pendingSubmissionsTotalCount: response.data.count,
                pendingSubmissionsCurrentPage: page,
                pendingSubmissionsPageSize: pageSize,
            })
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to fetch pending submissions'
            set({ pendingSubmissionsLoading: false, pendingSubmissionsError: errorMsg })
            toast.error(`Failed to fetch pending submissions: ${errorMsg}`)
        }
    },

    submitPublicMemo: async (payload) => {
        set({ submitting: true })

        try {
            const response = await api.post<{ submission_uuid: string }>(
                `/public/memo-submissions?project_id=${payload.projectUuid}`,
                {
                    title: payload.title,
                    content: payload.content,
                    source: payload.source,
                    type: payload.type,
                    client_reference_id: payload.client_reference_id,
                    expiration_date: payload.expiration_date,
                    tags: payload.tags,
                    metadata: payload.metadata,
                }
            )

            if (response.error) {
                toast.error(`Failed to submit memo: ${response.error}`)
                set({ submitting: false })
                return false
            }

            toast.success('Memo submitted successfully')
            set({ submitting: false })
            return true
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to submit memo'
            toast.error(`Failed to submit memo: ${errorMsg}`)
            set({ submitting: false })
            return false
        }
    },

    getPublicSubmissionDetails: async (projectUuid, submissionUuid) => {
        try {
            const response = await api.get<DetailedMemoSubmission>(
                `/public/memo-submissions/${submissionUuid}?project_id=${projectUuid}`
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
}))

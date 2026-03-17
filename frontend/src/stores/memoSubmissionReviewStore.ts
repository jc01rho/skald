import { create } from 'zustand'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { DetailedMemoSubmission, MemoSubmission } from '@/lib/types'

interface PaginatedResponse<T> {
    count: number
    next: string | null
    previous: string | null
    results: T[]
}

interface MemoSubmissionReviewState {
    submissions: MemoSubmission[]
    submissionsLoading: boolean
    submissionsError: string | null
    submissionsTotalCount: number
    submissionsCurrentPage: number
    submissionsPageSize: number
    reviewActionLoading: boolean
    fetchMemoSubmissions: (projectUuid: string, page?: number, pageSize?: number) => Promise<void>
    getMemoSubmissionDetails: (projectUuid: string, submissionUuid: string) => Promise<DetailedMemoSubmission | null>
    approveMemoSubmission: (projectUuid: string, submissionUuid: string, reviewNote?: string) => Promise<boolean>
    rejectMemoSubmission: (projectUuid: string, submissionUuid: string, reviewNote?: string) => Promise<boolean>
}

export const useMemoSubmissionReviewStore = create<MemoSubmissionReviewState>((set, get) => ({
    submissions: [],
    submissionsLoading: false,
    submissionsError: null,
    submissionsTotalCount: 0,
    submissionsCurrentPage: 1,
    submissionsPageSize: 20,
    reviewActionLoading: false,

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
        set({ reviewActionLoading: true })

        try {
            const response = await api.post(
                `/v1/memo-submissions/${submissionUuid}/approve?project_id=${projectUuid}`,
                reviewNote ? { review_note: reviewNote } : {}
            )

            if (response.error) {
                toast.error(`Failed to approve submission: ${response.error}`)
                set({ reviewActionLoading: false })
                return false
            }

            await get().fetchMemoSubmissions(projectUuid, get().submissionsCurrentPage, get().submissionsPageSize)
            toast.success('Submission approved successfully')
            set({ reviewActionLoading: false })
            return true
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to approve submission'
            toast.error(`Failed to approve submission: ${errorMsg}`)
            set({ reviewActionLoading: false })
            return false
        }
    },

    rejectMemoSubmission: async (projectUuid, submissionUuid, reviewNote) => {
        set({ reviewActionLoading: true })

        try {
            const response = await api.post(
                `/v1/memo-submissions/${submissionUuid}/reject?project_id=${projectUuid}`,
                reviewNote ? { review_note: reviewNote } : {}
            )

            if (response.error) {
                toast.error(`Failed to reject submission: ${response.error}`)
                set({ reviewActionLoading: false })
                return false
            }

            await get().fetchMemoSubmissions(projectUuid, get().submissionsCurrentPage, get().submissionsPageSize)
            toast.success('Submission rejected successfully')
            set({ reviewActionLoading: false })
            return true
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to reject submission'
            toast.error(`Failed to reject submission: ${errorMsg}`)
            set({ reviewActionLoading: false })
            return false
        }
    },
}))

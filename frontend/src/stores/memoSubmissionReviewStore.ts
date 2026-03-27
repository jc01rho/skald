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
    approvedSubmissions: MemoSubmission[]
    submissionsLoading: boolean
    approvedSubmissionsLoading: boolean
    submissionsError: string | null
    submissionsTotalCount: number
    approvedSubmissionsTotalCount: number
    submissionsCurrentPage: number
    approvedSubmissionsCurrentPage: number
    submissionsPageSize: number
    approvedSubmissionsPageSize: number
    reviewActionLoading: boolean
    previewActionLoading: boolean
    backfillLoading: boolean
    fetchMemoSubmissions: (projectUuid: string, page?: number, pageSize?: number) => Promise<void>
    fetchApprovedMemoSubmissions: (projectUuid: string, page?: number, pageSize?: number) => Promise<void>
    getMemoSubmissionDetails: (projectUuid: string, submissionUuid: string) => Promise<DetailedMemoSubmission | null>
    approveMemoSubmission: (
        projectUuid: string,
        submissionUuid: string,
        reviewNote?: string,
        productId?: string
    ) => Promise<boolean>
    rejectMemoSubmission: (projectUuid: string, submissionUuid: string, reviewNote?: string) => Promise<boolean>
    regenerateMemoSubmissionPreview: (
        projectUuid: string,
        submissionUuid: string
    ) => Promise<DetailedMemoSubmission | null>
    backfillPendingSubmissionPreviews: (projectUuid: string) => Promise<boolean>
}

export const useMemoSubmissionReviewStore = create<MemoSubmissionReviewState>((set, get) => ({
    submissions: [],
    approvedSubmissions: [],
    submissionsLoading: false,
    approvedSubmissionsLoading: false,
    submissionsError: null,
    submissionsTotalCount: 0,
    approvedSubmissionsTotalCount: 0,
    submissionsCurrentPage: 1,
    approvedSubmissionsCurrentPage: 1,
    submissionsPageSize: 20,
    approvedSubmissionsPageSize: 20,
    reviewActionLoading: false,
    previewActionLoading: false,
    backfillLoading: false,

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

    fetchApprovedMemoSubmissions: async (projectUuid, page = 1, pageSize = 20) => {
        set({ approvedSubmissionsLoading: true, submissionsError: null })

        try {
            const response = await api.get<PaginatedResponse<MemoSubmission>>(
                `/v1/memo-submissions?project_id=${projectUuid}&status=approved&page=${page}&page_size=${pageSize}`
            )

            if (response.error || !response.data) {
                const errorMsg = response.error || 'Failed to fetch approved memo submissions'
                set({ approvedSubmissionsLoading: false, submissionsError: errorMsg })
                toast.error(`Failed to fetch approved memo submissions: ${errorMsg}`)
                return
            }

            set({
                approvedSubmissions: response.data.results,
                approvedSubmissionsLoading: false,
                submissionsError: null,
                approvedSubmissionsTotalCount: response.data.count,
                approvedSubmissionsCurrentPage: page,
                approvedSubmissionsPageSize: pageSize,
            })
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to fetch approved memo submissions'
            set({ approvedSubmissionsLoading: false, submissionsError: errorMsg })
            toast.error(`Failed to fetch approved memo submissions: ${errorMsg}`)
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

    approveMemoSubmission: async (projectUuid, submissionUuid, reviewNote, productId) => {
        set({ reviewActionLoading: true })

        try {
            const payload: Record<string, unknown> = {}
            if (reviewNote) {
                payload.review_note = reviewNote
            }
            if (productId) {
                payload.product_id = productId
            }

            const response = await api.post(
                `/v1/memo-submissions/${submissionUuid}/approve?project_id=${projectUuid}`,
                payload
            )

            if (response.error) {
                toast.error(`Failed to approve submission: ${response.error}`)
                set({ reviewActionLoading: false })
                return false
            }

            await get().fetchMemoSubmissions(projectUuid, get().submissionsCurrentPage, get().submissionsPageSize)
            await get().fetchApprovedMemoSubmissions(
                projectUuid,
                get().approvedSubmissionsCurrentPage,
                get().approvedSubmissionsPageSize
            )
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
            await get().fetchApprovedMemoSubmissions(
                projectUuid,
                get().approvedSubmissionsCurrentPage,
                get().approvedSubmissionsPageSize
            )
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

    regenerateMemoSubmissionPreview: async (projectUuid, submissionUuid) => {
        set({ previewActionLoading: true })

        try {
            const response = await api.post<DetailedMemoSubmission>(
                `/v1/memo-submissions/${submissionUuid}/regenerate-preview?project_id=${projectUuid}`,
                {}
            )

            if (response.error || !response.data) {
                toast.error(`Failed to regenerate preview: ${response.error || 'Unknown error'}`)
                set({ previewActionLoading: false })
                return null
            }

            await get().fetchMemoSubmissions(projectUuid, get().submissionsCurrentPage, get().submissionsPageSize)
            toast.success('Preview regenerated successfully')
            set({ previewActionLoading: false })
            return response.data
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to regenerate preview'
            toast.error(`Failed to regenerate preview: ${errorMsg}`)
            set({ previewActionLoading: false })
            return null
        }
    },

    backfillPendingSubmissionPreviews: async (projectUuid) => {
        set({ backfillLoading: true })

        try {
            const response = await api.post<{ updated_count: number }>(
                `/v1/memo-submissions/backfill-preview?project_id=${projectUuid}`,
                {}
            )

            if (response.error || !response.data) {
                toast.error(`Failed to backfill previews: ${response.error || 'Unknown error'}`)
                set({ backfillLoading: false })
                return false
            }

            await get().fetchMemoSubmissions(projectUuid, get().submissionsCurrentPage, get().submissionsPageSize)
            toast.success(`Backfilled ${response.data.updated_count} pending submission previews`)
            set({ backfillLoading: false })
            return true
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to backfill previews'
            toast.error(`Failed to backfill previews: ${errorMsg}`)
            set({ backfillLoading: false })
            return false
        }
    },
}))

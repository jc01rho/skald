import { create } from 'zustand'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { DetailedMemoSubmission, DetailedPublicMemo, MemoSubmission, PublicMemo } from '@/lib/types'

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
    getPublicMemoDetails: (projectUuid: string, memoUuid: string) => Promise<DetailedPublicMemo | null>
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
                const errorMsg = response.error || '공개 메모를 불러오지 못했습니다.'
                set({ approvedMemosLoading: false, approvedMemosError: errorMsg })
                toast.error(`공개 메모를 불러오지 못했습니다: ${errorMsg}`)
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
            const errorMsg = error instanceof Error ? error.message : '공개 메모를 불러오지 못했습니다.'
            set({ approvedMemosLoading: false, approvedMemosError: errorMsg })
            toast.error(`공개 메모를 불러오지 못했습니다: ${errorMsg}`)
        }
    },

    fetchPendingSubmissions: async (projectUuid, page = 1, pageSize = 20) => {
        set({ pendingSubmissionsLoading: true, pendingSubmissionsError: null })

        try {
            const response = await api.get<PaginatedResponse<MemoSubmission>>(
                `/public/memo-submissions?project_id=${projectUuid}&status=pending&page=${page}&page_size=${pageSize}`
            )

            if (response.error || !response.data) {
                const errorMsg = response.error || '검토 대기 제출을 불러오지 못했습니다.'
                set({ pendingSubmissionsLoading: false, pendingSubmissionsError: errorMsg })
                toast.error(`검토 대기 제출을 불러오지 못했습니다: ${errorMsg}`)
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
            const errorMsg = error instanceof Error ? error.message : '검토 대기 제출을 불러오지 못했습니다.'
            set({ pendingSubmissionsLoading: false, pendingSubmissionsError: errorMsg })
            toast.error(`검토 대기 제출을 불러오지 못했습니다: ${errorMsg}`)
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
                toast.error(`메모를 제출하지 못했습니다: ${response.error}`)
                set({ submitting: false })
                return false
            }

            toast.success('메모가 제출되었습니다.')
            set({ submitting: false })
            return true
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : '메모를 제출하지 못했습니다.'
            toast.error(`메모를 제출하지 못했습니다: ${errorMsg}`)
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
                toast.error(`제출 상세 정보를 불러오지 못했습니다: ${response.error || '알 수 없는 오류'}`)
                return null
            }

            return response.data
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : '제출 상세 정보를 불러오지 못했습니다.'
            toast.error(`제출 상세 정보를 불러오지 못했습니다: ${errorMsg}`)
            return null
        }
    },

    getPublicMemoDetails: async (projectUuid, memoUuid) => {
        try {
            const response = await api.get<DetailedPublicMemo>(`/public/memos/${memoUuid}?project_id=${projectUuid}`)

            if (response.error || !response.data) {
                toast.error(`공개 메모 상세 정보를 불러오지 못했습니다: ${response.error || '알 수 없는 오류'}`)
                return null
            }

            return response.data
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : '공개 메모 상세 정보를 불러오지 못했습니다.'
            toast.error(`공개 메모 상세 정보를 불러오지 못했습니다: ${errorMsg}`)
            return null
        }
    },
}))

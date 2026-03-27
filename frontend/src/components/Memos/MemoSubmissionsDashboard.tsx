import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/AppLayout/PageHeader'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MemosPagination } from '@/components/Memos/MemosPagination'
import { MemoSubmissionsTable } from '@/components/Memos/MemoSubmissionsTable'
import { MemoSubmissionDecisionDialog } from '@/components/Memos/MemoSubmissionDecisionDialog'
import { MemoSubmissionDetailDialog } from '@/components/Memos/MemoSubmissionDetailDialog'
import { useMemoSubmissionReviewStore } from '@/stores/memoSubmissionReviewStore'
import { useMemoStore } from '@/stores/memoStore'
import { DeleteMemoDialog } from '@/components/Memos/DeleteMemoDialog'
import type { DetailedMemoSubmission, MemoSubmission } from '@/lib/types'

type DecisionMode = 'approve' | 'reject'

export const MemoSubmissionsDashboard = () => {
    const { uuid: projectUuid } = useParams<{ uuid: string }>()
    const submissions = useMemoSubmissionReviewStore((state) => state.submissions)
    const loading = useMemoSubmissionReviewStore((state) => state.submissionsLoading)
    const totalCount = useMemoSubmissionReviewStore((state) => state.submissionsTotalCount)
    const currentPage = useMemoSubmissionReviewStore((state) => state.submissionsCurrentPage)
    const pageSize = useMemoSubmissionReviewStore((state) => state.submissionsPageSize)
    const approvedSubmissions = useMemoSubmissionReviewStore((state) => state.approvedSubmissions)
    const approvedLoading = useMemoSubmissionReviewStore((state) => state.approvedSubmissionsLoading)
    const approvedTotalCount = useMemoSubmissionReviewStore((state) => state.approvedSubmissionsTotalCount)
    const approvedCurrentPage = useMemoSubmissionReviewStore((state) => state.approvedSubmissionsCurrentPage)
    const approvedPageSize = useMemoSubmissionReviewStore((state) => state.approvedSubmissionsPageSize)
    const fetchMemoSubmissions = useMemoSubmissionReviewStore((state) => state.fetchMemoSubmissions)
    const fetchApprovedMemoSubmissions = useMemoSubmissionReviewStore((state) => state.fetchApprovedMemoSubmissions)
    const getMemoSubmissionDetails = useMemoSubmissionReviewStore((state) => state.getMemoSubmissionDetails)
    const approveMemoSubmission = useMemoSubmissionReviewStore((state) => state.approveMemoSubmission)
    const rejectMemoSubmission = useMemoSubmissionReviewStore((state) => state.rejectMemoSubmission)
    const reviewActionLoading = useMemoSubmissionReviewStore((state) => state.reviewActionLoading)
    const previewActionLoading = useMemoSubmissionReviewStore((state) => state.previewActionLoading)
    const backfillLoading = useMemoSubmissionReviewStore((state) => state.backfillLoading)
    const regenerateMemoSubmissionPreview = useMemoSubmissionReviewStore(
        (state) => state.regenerateMemoSubmissionPreview
    )
    const backfillPendingSubmissionPreviews = useMemoSubmissionReviewStore(
        (state) => state.backfillPendingSubmissionPreviews
    )
    const deleteMemo = useMemoStore((state) => state.deleteMemo)

    const [selectedSubmission, setSelectedSubmission] = useState<DetailedMemoSubmission | null>(null)
    const [decisionMode, setDecisionMode] = useState<DecisionMode | null>(null)
    const [decisionSubmission, setDecisionSubmission] = useState<DetailedMemoSubmission | null>(null)
    const [activeTab, setActiveTab] = useState<'pending' | 'approved'>('pending')
    const [approvedMemoToDelete, setApprovedMemoToDelete] = useState<MemoSubmission | null>(null)
    const [deletingApprovedMemo, setDeletingApprovedMemo] = useState(false)

    useEffect(() => {
        if (projectUuid) {
            fetchMemoSubmissions(projectUuid)
            fetchApprovedMemoSubmissions(projectUuid)
        }
    }, [fetchMemoSubmissions, fetchApprovedMemoSubmissions, projectUuid])

    const loadDetails = async (submission: MemoSubmission) => {
        if (!projectUuid) return null
        return getMemoSubmissionDetails(projectUuid, submission.uuid)
    }

    const handleView = async (submission: MemoSubmission) => {
        const detail = await loadDetails(submission)
        if (detail) {
            setSelectedSubmission(detail)
        }
    }

    const openDecisionDialog = async (mode: DecisionMode, submission: MemoSubmission | DetailedMemoSubmission) => {
        const detail = 'content' in submission ? submission : await loadDetails(submission)
        if (!detail) return

        setSelectedSubmission(null)
        setDecisionMode(mode)
        setDecisionSubmission(detail)
    }

    const handleDecisionConfirm = async (reviewNote: string, productId?: string) => {
        if (!projectUuid || !decisionMode || !decisionSubmission) return

        const success =
            decisionMode === 'approve'
                ? await approveMemoSubmission(projectUuid, decisionSubmission.uuid, reviewNote || undefined, productId)
                : await rejectMemoSubmission(projectUuid, decisionSubmission.uuid, reviewNote || undefined)

        if (success) {
            setDecisionMode(null)
            setDecisionSubmission(null)
        }
    }

    const handleDeleteApprovedMemo = async () => {
        if (!projectUuid || !approvedMemoToDelete?.memo_uuid) return

        setDeletingApprovedMemo(true)
        const success = await deleteMemo(approvedMemoToDelete.memo_uuid)
        setDeletingApprovedMemo(false)

        if (success) {
            setApprovedMemoToDelete(null)
            fetchApprovedMemoSubmissions(projectUuid, approvedCurrentPage, approvedPageSize)
        }
    }

    const handleRegeneratePreview = async (submission: DetailedMemoSubmission) => {
        if (!projectUuid) return

        const refreshed = await regenerateMemoSubmissionPreview(projectUuid, submission.uuid)
        if (refreshed) {
            setSelectedSubmission(refreshed)
        }
    }

    if (!projectUuid) {
        return (
            <div className="container mx-auto py-6 space-y-6">
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Project not found</AlertTitle>
                    <AlertDescription>Memo submissions require a valid project route.</AlertDescription>
                </Alert>
            </div>
        )
    }

    return (
        <div className="container mx-auto py-6 space-y-6">
            <PageHeader title="Memo submissions">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        fetchMemoSubmissions(projectUuid, currentPage, pageSize)
                        fetchApprovedMemoSubmissions(projectUuid, approvedCurrentPage, approvedPageSize)
                    }}
                    disabled={loading || approvedLoading}
                >
                    <RefreshCw className={`h-4 w-4 mr-2 ${loading || approvedLoading ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => backfillPendingSubmissionPreviews(projectUuid)}
                    disabled={loading || backfillLoading}
                >
                    <RefreshCw className={`h-4 w-4 mr-2 ${backfillLoading ? 'animate-spin' : ''}`} />
                    Pending preview backfill
                </Button>
            </PageHeader>

            <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Approval required</AlertTitle>
                <AlertDescription>
                    Only authenticated users can review pending submissions. Approved memos are published to the public
                    memo list and can be deleted from the approved tab.
                </AlertDescription>
            </Alert>

            <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'pending' | 'approved')}>
                <TabsList className="grid w-full grid-cols-2 md:w-[360px]">
                    <TabsTrigger value="pending">Pending</TabsTrigger>
                    <TabsTrigger value="approved">Approved</TabsTrigger>
                </TabsList>

                <TabsContent value="pending" className="space-y-4">
                    <MemoSubmissionsTable
                        submissions={submissions}
                        loading={loading}
                        onView={handleView}
                        onApprove={(submission) => openDecisionDialog('approve', submission)}
                        onReject={(submission) => openDecisionDialog('reject', submission)}
                        emptyTitle="No pending submissions"
                        emptyDescription="New public memo submissions awaiting approval will appear here."
                    />

                    <MemosPagination
                        currentPage={currentPage}
                        pageSize={pageSize}
                        totalCount={totalCount}
                        loading={loading}
                        onPageChange={(page) => fetchMemoSubmissions(projectUuid, page, pageSize)}
                    />
                </TabsContent>

                <TabsContent value="approved" className="space-y-4">
                    <MemoSubmissionsTable
                        submissions={approvedSubmissions}
                        loading={approvedLoading}
                        onView={handleView}
                        onApprove={() => undefined}
                        onReject={() => undefined}
                        onDeleteApproved={(submission) => setApprovedMemoToDelete(submission)}
                        emptyTitle="No approved submissions"
                        emptyDescription="Approved submissions that created public memos will appear here."
                    />

                    <MemosPagination
                        currentPage={approvedCurrentPage}
                        pageSize={approvedPageSize}
                        totalCount={approvedTotalCount}
                        loading={approvedLoading}
                        onPageChange={(page) => fetchApprovedMemoSubmissions(projectUuid, page, approvedPageSize)}
                    />
                </TabsContent>
            </Tabs>

            <MemoSubmissionDetailDialog
                submission={selectedSubmission}
                onClose={() => setSelectedSubmission(null)}
                onApprove={(submission) => openDecisionDialog('approve', submission)}
                onReject={(submission) => openDecisionDialog('reject', submission)}
                onRegeneratePreview={handleRegeneratePreview}
                previewActionLoading={previewActionLoading}
            />

            <MemoSubmissionDecisionDialog
                mode={decisionMode || 'approve'}
                submission={decisionSubmission}
                submitting={reviewActionLoading}
                onClose={() => {
                    if (!reviewActionLoading) {
                        setDecisionMode(null)
                        setDecisionSubmission(null)
                    }
                }}
                onConfirm={handleDecisionConfirm}
            />

            <DeleteMemoDialog
                memo={
                    approvedMemoToDelete
                        ? {
                              uuid: approvedMemoToDelete.memo_uuid || '',
                              created_at: approvedMemoToDelete.created_at,
                              updated_at: approvedMemoToDelete.updated_at,
                              title: approvedMemoToDelete.title,
                              summary: approvedMemoToDelete.summary || '',
                              metadata: {},
                              client_reference_id: null,
                              processing_status: 'processed',
                          }
                        : null
                }
                deleting={deletingApprovedMemo}
                onConfirm={handleDeleteApprovedMemo}
                onCancel={() => {
                    if (!deletingApprovedMemo) {
                        setApprovedMemoToDelete(null)
                    }
                }}
            />
        </div>
    )
}

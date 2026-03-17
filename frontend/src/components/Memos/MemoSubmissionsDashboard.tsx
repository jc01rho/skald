import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/AppLayout/PageHeader'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { MemosPagination } from '@/components/Memos/MemosPagination'
import { MemoSubmissionsTable } from '@/components/Memos/MemoSubmissionsTable'
import { MemoSubmissionDecisionDialog } from '@/components/Memos/MemoSubmissionDecisionDialog'
import { MemoSubmissionDetailDialog } from '@/components/Memos/MemoSubmissionDetailDialog'
import { useMemoSubmissionReviewStore } from '@/stores/memoSubmissionReviewStore'
import type { DetailedMemoSubmission, MemoSubmission } from '@/lib/types'

type DecisionMode = 'approve' | 'reject'

export const MemoSubmissionsDashboard = () => {
    const { uuid: projectUuid } = useParams<{ uuid: string }>()
    const submissions = useMemoSubmissionReviewStore((state) => state.submissions)
    const loading = useMemoSubmissionReviewStore((state) => state.submissionsLoading)
    const totalCount = useMemoSubmissionReviewStore((state) => state.submissionsTotalCount)
    const currentPage = useMemoSubmissionReviewStore((state) => state.submissionsCurrentPage)
    const pageSize = useMemoSubmissionReviewStore((state) => state.submissionsPageSize)
    const fetchMemoSubmissions = useMemoSubmissionReviewStore((state) => state.fetchMemoSubmissions)
    const getMemoSubmissionDetails = useMemoSubmissionReviewStore((state) => state.getMemoSubmissionDetails)
    const approveMemoSubmission = useMemoSubmissionReviewStore((state) => state.approveMemoSubmission)
    const rejectMemoSubmission = useMemoSubmissionReviewStore((state) => state.rejectMemoSubmission)
    const reviewActionLoading = useMemoSubmissionReviewStore((state) => state.reviewActionLoading)

    const [selectedSubmission, setSelectedSubmission] = useState<DetailedMemoSubmission | null>(null)
    const [decisionMode, setDecisionMode] = useState<DecisionMode | null>(null)
    const [decisionSubmission, setDecisionSubmission] = useState<DetailedMemoSubmission | null>(null)

    useEffect(() => {
        if (projectUuid) {
            fetchMemoSubmissions(projectUuid)
        }
    }, [fetchMemoSubmissions, projectUuid])

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

    const handleDecisionConfirm = async (reviewNote: string) => {
        if (!projectUuid || !decisionMode || !decisionSubmission) return

        const success =
            decisionMode === 'approve'
                ? await approveMemoSubmission(projectUuid, decisionSubmission.uuid, reviewNote || undefined)
                : await rejectMemoSubmission(projectUuid, decisionSubmission.uuid, reviewNote || undefined)

        if (success) {
            setDecisionMode(null)
            setDecisionSubmission(null)
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
                    onClick={() => fetchMemoSubmissions(projectUuid, currentPage, pageSize)}
                    disabled={loading}
                >
                    <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
            </PageHeader>

            <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Approval required</AlertTitle>
                <AlertDescription>
                    Only authenticated users can review pending submissions. Approved memos are published to the public
                    memo list.
                </AlertDescription>
            </Alert>

            <MemoSubmissionsTable
                submissions={submissions}
                loading={loading}
                onView={handleView}
                onApprove={(submission) => openDecisionDialog('approve', submission)}
                onReject={(submission) => openDecisionDialog('reject', submission)}
            />

            <MemosPagination
                currentPage={currentPage}
                pageSize={pageSize}
                totalCount={totalCount}
                loading={loading}
                onPageChange={(page) => fetchMemoSubmissions(projectUuid, page, pageSize)}
            />

            <MemoSubmissionDetailDialog
                submission={selectedSubmission}
                onClose={() => setSelectedSubmission(null)}
                onApprove={(submission) => openDecisionDialog('approve', submission)}
                onReject={(submission) => openDecisionDialog('reject', submission)}
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
        </div>
    )
}

import type { DetailedMemoSubmission } from '@/lib/types'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { MemoSubmissionStatusBadge } from '@/components/Memos/MemoSubmissionStatusBadge'

interface MemoSubmissionDetailDialogProps {
    submission: DetailedMemoSubmission | null
    onClose: () => void
    onApprove: (submission: DetailedMemoSubmission) => void
    onReject: (submission: DetailedMemoSubmission) => void
    onRegeneratePreview: (submission: DetailedMemoSubmission) => void
    previewActionLoading: boolean
}

const formatDate = (dateString: string | null) => {
    if (!dateString) return 'N/A'

    return new Date(dateString).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

export const MemoSubmissionDetailDialog = ({
    submission,
    onClose,
    onApprove,
    onReject,
    onRegeneratePreview,
    previewActionLoading,
}: MemoSubmissionDetailDialogProps) => {
    const previewReady = Boolean(
        submission?.summary && submission.tags.length > 0 && Object.keys(submission.metadata).length > 0
    )

    return (
        <Dialog open={!!submission} onOpenChange={onClose}>
            <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Memo submission details</DialogTitle>
                    <DialogDescription>Review the submission before approving or rejecting it.</DialogDescription>
                </DialogHeader>

                {submission && (
                    <div className="max-h-[70vh] overflow-y-auto pr-1">
                        <div className="space-y-6">
                            <div className="space-y-3">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="space-y-2 min-w-0">
                                        <h2 className="text-2xl font-bold break-words">{submission.title}</h2>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <MemoSubmissionStatusBadge status={submission.status} />
                                            {submission.type && <Badge variant="outline">{submission.type}</Badge>}
                                            {submission.file_name && (
                                                <Badge variant="secondary">{submission.file_name}</Badge>
                                            )}
                                            <Badge variant={previewReady ? 'secondary' : 'outline'}>
                                                {previewReady ? 'Preview ready' : 'Preview incomplete'}
                                            </Badge>
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 gap-4 text-sm text-muted-foreground md:grid-cols-2">
                                    <div>
                                        <p className="font-medium text-foreground">Submitted</p>
                                        <p>{formatDate(submission.created_at)}</p>
                                    </div>
                                    <div>
                                        <p className="font-medium text-foreground">Submitter</p>
                                        <p>{submission.submitter_name || submission.submitter_email || 'Anonymous'}</p>
                                    </div>
                                    <div>
                                        <p className="font-medium text-foreground">Source</p>
                                        <p>{submission.source || '—'}</p>
                                    </div>
                                    <div>
                                        <p className="font-medium text-foreground">Reference ID</p>
                                        <p>{submission.client_reference_id || '—'}</p>
                                    </div>
                                </div>
                            </div>

                            <Separator />

                            {submission.summary && (
                                <Card>
                                    <CardHeader>
                                        <CardTitle>Summary</CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <p className="text-sm leading-relaxed">{submission.summary}</p>
                                    </CardContent>
                                </Card>
                            )}

                            {submission.content && (
                                <Card>
                                    <CardHeader>
                                        <CardTitle>Content</CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans">
                                            {submission.content}
                                        </pre>
                                    </CardContent>
                                </Card>
                            )}

                            {submission.tags.length > 0 && (
                                <Card>
                                    <CardHeader>
                                        <CardTitle>Tags</CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="flex flex-wrap gap-2">
                                            {submission.tags.map((tag) => (
                                                <Badge key={tag} variant="secondary">
                                                    {tag}
                                                </Badge>
                                            ))}
                                        </div>
                                    </CardContent>
                                </Card>
                            )}

                            {Object.keys(submission.metadata).length > 0 && (
                                <Card>
                                    <CardHeader>
                                        <CardTitle>Metadata</CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <pre className="rounded-md bg-muted p-4 text-xs overflow-x-auto">
                                            {JSON.stringify(submission.metadata, null, 2)}
                                        </pre>
                                    </CardContent>
                                </Card>
                            )}

                            {(submission.review_note || submission.reviewed_at || submission.expiration_date) && (
                                <Card>
                                    <CardHeader>
                                        <CardTitle>Review metadata</CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-3 text-sm">
                                        {submission.expiration_date && (
                                            <div>
                                                <p className="font-medium text-foreground">Expiration date</p>
                                                <p className="text-muted-foreground">
                                                    {formatDate(submission.expiration_date)}
                                                </p>
                                            </div>
                                        )}
                                        {submission.reviewed_at && (
                                            <div>
                                                <p className="font-medium text-foreground">Reviewed at</p>
                                                <p className="text-muted-foreground">
                                                    {formatDate(submission.reviewed_at)}
                                                </p>
                                            </div>
                                        )}
                                        {submission.review_note && (
                                            <div>
                                                <p className="font-medium text-foreground">Review note</p>
                                                <p className="text-muted-foreground whitespace-pre-wrap">
                                                    {submission.review_note}
                                                </p>
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    </div>
                )}

                {submission && (
                    <DialogFooter>
                        <div className="flex items-center gap-2">
                            <Button variant="outline" onClick={() => onReject(submission)}>
                                Reject
                            </Button>
                            <Button
                                variant="outline"
                                onClick={() => onRegeneratePreview(submission)}
                                disabled={previewActionLoading || submission.status !== 'pending'}
                            >
                                {previewActionLoading ? 'Regenerating...' : 'Preview 재생성'}
                            </Button>
                            <Button
                                onClick={() => onApprove(submission)}
                                disabled={!previewReady || previewActionLoading}
                            >
                                Approve
                            </Button>
                        </div>
                    </DialogFooter>
                )}
            </DialogContent>
        </Dialog>
    )
}

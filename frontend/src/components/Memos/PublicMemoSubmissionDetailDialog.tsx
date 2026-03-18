import type { DetailedMemoSubmission } from '@/lib/types'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MemoSubmissionStatusBadge } from '@/components/Memos/MemoSubmissionStatusBadge'

interface PublicMemoSubmissionDetailDialogProps {
    submission: DetailedMemoSubmission | null
    onClose: () => void
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

export const PublicMemoSubmissionDetailDialog = ({ submission, onClose }: PublicMemoSubmissionDetailDialogProps) => {
    return (
        <Dialog open={!!submission} onOpenChange={onClose}>
            <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Submission details</DialogTitle>
                    <DialogDescription>View the submitted memo while it is waiting for review.</DialogDescription>
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
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 gap-4 text-sm text-muted-foreground md:grid-cols-2">
                                    <div>
                                        <p className="font-medium text-foreground">Submitted</p>
                                        <p>{formatDate(submission.created_at)}</p>
                                    </div>
                                    <div>
                                        <p className="font-medium text-foreground">Source</p>
                                        <p>{submission.source || '—'}</p>
                                    </div>
                                </div>
                            </div>

                            {submission.summary && (
                                <Card>
                                    <CardHeader>
                                        <CardTitle>Summary</CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <p className="text-sm leading-relaxed whitespace-pre-wrap">
                                            {submission.summary}
                                        </p>
                                    </CardContent>
                                </Card>
                            )}

                            <Card>
                                <CardHeader>
                                    <CardTitle>Content</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans">
                                        {submission.content || 'No content available'}
                                    </pre>
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}

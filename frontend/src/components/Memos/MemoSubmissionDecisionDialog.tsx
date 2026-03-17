import { useEffect, useState } from 'react'
import type { DetailedMemoSubmission } from '@/lib/types'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface MemoSubmissionDecisionDialogProps {
    mode: 'approve' | 'reject'
    submission: DetailedMemoSubmission | null
    submitting: boolean
    onClose: () => void
    onConfirm: (reviewNote: string) => Promise<void>
}

export const MemoSubmissionDecisionDialog = ({
    mode,
    submission,
    submitting,
    onClose,
    onConfirm,
}: MemoSubmissionDecisionDialogProps) => {
    const [reviewNote, setReviewNote] = useState('')

    useEffect(() => {
        if (submission) {
            setReviewNote(submission.review_note || '')
        } else {
            setReviewNote('')
        }
    }, [submission])

    const actionLabel = mode === 'approve' ? 'Approve' : 'Reject'

    return (
        <Dialog open={!!submission} onOpenChange={onClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{actionLabel} submission</DialogTitle>
                    <DialogDescription>
                        {mode === 'approve'
                            ? `Approve "${submission?.title}" and publish it to the public memo list.`
                            : `Reject "${submission?.title}" and keep it out of the public memo list.`}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-2">
                    <label htmlFor="memo-submission-review-note" className="text-sm font-medium">
                        Review note
                    </label>
                    <Textarea
                        id="memo-submission-review-note"
                        value={reviewNote}
                        onChange={(event) => setReviewNote(event.target.value)}
                        placeholder={
                            mode === 'approve'
                                ? 'Optional note for the approval record'
                                : 'Optional reason for rejection'
                        }
                        className="min-h-[140px] resize-y"
                        disabled={submitting}
                    />
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={submitting}>
                        Cancel
                    </Button>
                    <Button
                        variant={mode === 'approve' ? 'default' : 'destructive'}
                        onClick={() => onConfirm(reviewNote.trim())}
                        disabled={submitting}
                    >
                        {submitting ? `${actionLabel}ing...` : actionLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

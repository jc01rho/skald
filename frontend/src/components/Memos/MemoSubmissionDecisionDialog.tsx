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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

const PRODUCT_OPTIONS = [
    { value: 'sparrow', label: 'Sparrow' },
    { value: 'sparrow-sast', label: 'Sparrow SAST' },
    { value: 'sparrow-sca', label: 'Sparrow SCA' },
    { value: 'sast', label: 'SAST' },
    { value: 'dast', label: 'DAST' },
    { value: 'cloud', label: 'Cloud' },
    { value: 'rasp', label: 'RASP' },
    { value: 'sca', label: 'SCA' },
    { value: 'saqt', label: 'SAQT' },
    { value: 'ihub', label: 'iHub' },
] as const

interface MemoSubmissionDecisionDialogProps {
    mode: 'approve' | 'reject'
    submission: DetailedMemoSubmission | null
    submitting: boolean
    onClose: () => void
    onConfirm: (reviewNote: string, productId?: string) => Promise<void>
}

export const MemoSubmissionDecisionDialog = ({
    mode,
    submission,
    submitting,
    onClose,
    onConfirm,
}: MemoSubmissionDecisionDialogProps) => {
    const [reviewNote, setReviewNote] = useState('')
    const [productId, setProductId] = useState('')

    useEffect(() => {
        if (submission) {
            setReviewNote(submission.review_note || '')
            setProductId(typeof submission.metadata?.product_id === 'string' ? submission.metadata.product_id : '')
        } else {
            setReviewNote('')
            setProductId('')
        }
    }, [submission])

    const actionLabel = mode === 'approve' ? 'Approve' : 'Reject'
    const confirmDisabled = submitting || (mode === 'approve' && !productId)

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
                    {mode === 'approve' && (
                        <div className="space-y-2">
                            <label htmlFor="memo-submission-product-id" className="text-sm font-medium">
                                Product
                            </label>
                            <Select value={productId} onValueChange={setProductId} disabled={submitting}>
                                <SelectTrigger id="memo-submission-product-id">
                                    <SelectValue placeholder="Select a product" />
                                </SelectTrigger>
                                <SelectContent>
                                    {PRODUCT_OPTIONS.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}

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
                        onClick={() => onConfirm(reviewNote.trim(), productId || undefined)}
                        disabled={confirmDisabled}
                    >
                        {submitting ? `${actionLabel}ing...` : actionLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

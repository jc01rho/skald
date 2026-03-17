import type { MemoSubmission } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Eye, ThumbsDown, ThumbsUp } from 'lucide-react'
import { MemoSubmissionStatusBadge } from '@/components/Memos/MemoSubmissionStatusBadge'

interface MemoSubmissionsTableProps {
    submissions: MemoSubmission[]
    loading: boolean
    onView: (submission: MemoSubmission) => void
    onApprove: (submission: MemoSubmission) => void
    onReject: (submission: MemoSubmission) => void
}

const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    })
}

const truncate = (text: string | null, maxLength: number) => {
    if (!text) return 'No summary available'
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

export const MemoSubmissionsTable = ({
    submissions,
    loading,
    onView,
    onApprove,
    onReject,
}: MemoSubmissionsTableProps) => {
    if (loading) {
        return (
            <div className="p-4 space-y-3">
                {['one', 'two', 'three', 'four', 'five'].map((item) => (
                    <Skeleton key={item} className="h-16 w-full" />
                ))}
            </div>
        )
    }

    if (submissions.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                <h3 className="text-xl font-semibold text-foreground mb-2">No pending submissions</h3>
                <p className="text-muted-foreground max-w-md">
                    New public memo submissions awaiting approval will appear here.
                </p>
            </div>
        )
    }

    return (
        <div className="rounded-md border overflow-x-auto">
            <Table className="w-full table-fixed">
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-[20%]">Title</TableHead>
                        <TableHead className="w-[28%]">Summary</TableHead>
                        <TableHead className="w-[14%]">Source</TableHead>
                        <TableHead className="w-[12%]">Submitter</TableHead>
                        <TableHead className="w-[10%]">Status</TableHead>
                        <TableHead className="w-[10%]">Submitted</TableHead>
                        <TableHead className="w-[16%]"></TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {submissions.map((submission) => (
                        <TableRow key={submission.uuid}>
                            <TableCell className="font-medium align-top">
                                <div className="space-y-1 min-w-0">
                                    <p className="truncate" title={submission.title}>
                                        {submission.title}
                                    </p>
                                    {submission.type && (
                                        <p className="text-xs text-muted-foreground uppercase tracking-wide">
                                            {submission.type}
                                        </p>
                                    )}
                                </div>
                            </TableCell>
                            <TableCell className="align-top">
                                <p
                                    className="line-clamp-2 text-sm text-muted-foreground break-words"
                                    title={submission.summary ?? ''}
                                >
                                    {truncate(submission.summary, 120)}
                                </p>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground align-top">
                                <span className="block truncate" title={submission.source ?? ''}>
                                    {submission.source || '—'}
                                </span>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground align-top">
                                <span
                                    className="block truncate"
                                    title={submission.submitter_email ?? submission.submitter_name ?? ''}
                                >
                                    {submission.submitter_name || submission.submitter_email || 'Anonymous'}
                                </span>
                            </TableCell>
                            <TableCell className="align-top">
                                <MemoSubmissionStatusBadge status={submission.status} />
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground align-top">
                                {formatDate(submission.created_at)}
                            </TableCell>
                            <TableCell className="align-top">
                                <div className="flex justify-end gap-1">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => onView(submission)}
                                        title="View submission"
                                    >
                                        <Eye className="h-4 w-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => onApprove(submission)}
                                        title="Approve submission"
                                    >
                                        <ThumbsUp className="h-4 w-4 text-primary" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => onReject(submission)}
                                        title="Reject submission"
                                    >
                                        <ThumbsDown className="h-4 w-4 text-destructive" />
                                    </Button>
                                </div>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    )
}

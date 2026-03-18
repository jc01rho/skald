import type { MemoSubmission, PublicMemo } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CheckCircle2, Clock3, FileText, Plus } from 'lucide-react'

interface PublicMemosTableProps {
    items: Array<PublicMemo | MemoSubmission>
    loading: boolean
    emptyTitle: string
    emptyDescription: string
    onCreateMemo?: () => void
    onSelectItem?: (item: PublicMemo | MemoSubmission) => void | Promise<void>
}

const isPendingSubmission = (item: PublicMemo | MemoSubmission): item is MemoSubmission => {
    return 'status' in item
}

const formatDate = (dateString: string | null) => {
    if (!dateString) return 'N/A'

    return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    })
}

const truncate = (text: string | null, maxLength: number) => {
    if (!text) return 'No summary available yet'
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

export const PublicMemosTable = ({
    items,
    loading,
    emptyTitle,
    emptyDescription,
    onCreateMemo,
    onSelectItem,
}: PublicMemosTableProps) => {
    if (loading) {
        return (
            <div className="p-4 space-y-3">
                {['one', 'two', 'three', 'four', 'five'].map((item) => (
                    <Skeleton key={item} className="h-16 w-full" />
                ))}
            </div>
        )
    }

    if (items.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                <FileText className="h-10 w-10 text-muted-foreground mb-4" />
                <h3 className="text-xl font-semibold text-foreground mb-2">{emptyTitle}</h3>
                <p className="text-muted-foreground max-w-md mb-6">{emptyDescription}</p>
                {onCreateMemo && (
                    <Button onClick={onCreateMemo} size="lg" className="gap-2">
                        <Plus className="h-4 w-4" />
                        Submit memo
                    </Button>
                )}
            </div>
        )
    }

    return (
        <div className="rounded-md border overflow-x-auto">
            <Table className="w-full table-fixed">
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-[24%]">Title</TableHead>
                        <TableHead className="w-[40%]">Summary</TableHead>
                        <TableHead className="w-[12%]">Status</TableHead>
                        <TableHead className="w-[12%]">Source</TableHead>
                        <TableHead className="w-[12%]">Updated</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {items.map((item) => {
                        const pending = isPendingSubmission(item)
                        const statusLabel = pending ? (
                            <Badge variant="outline" className="flex items-center gap-1">
                                <Clock3 className="h-3 w-3" />
                                Pending
                            </Badge>
                        ) : (
                            <Badge variant="default" className="flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3" />
                                Approved
                            </Badge>
                        )

                        const updatedAt = pending ? item.updated_at : item.approved_at || item.created_at

                        return (
                            <TableRow
                                key={item.uuid}
                                className={onSelectItem ? 'cursor-pointer hover:bg-muted/50' : undefined}
                                onClick={onSelectItem ? () => onSelectItem(item) : undefined}
                            >
                                <TableCell className="font-medium align-top">
                                    <div className="space-y-1 min-w-0">
                                        <p
                                            className="truncate underline-offset-4 group-hover:underline"
                                            title={item.title}
                                        >
                                            {item.title}
                                        </p>
                                        {pending && item.submitter_name && (
                                            <p
                                                className="text-xs text-muted-foreground truncate"
                                                title={item.submitter_name}
                                            >
                                                Submitted by {item.submitter_name}
                                            </p>
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell className="align-top">
                                    <p
                                        className="line-clamp-2 text-sm text-muted-foreground break-words"
                                        title={item.summary ?? ''}
                                    >
                                        {truncate(item.summary, 160)}
                                    </p>
                                </TableCell>
                                <TableCell className="align-top">{statusLabel}</TableCell>
                                <TableCell className="text-sm text-muted-foreground align-top">
                                    <span className="block truncate" title={item.source ?? ''}>
                                        {item.source || '—'}
                                    </span>
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground align-top">
                                    {formatDate(updatedAt)}
                                </TableCell>
                            </TableRow>
                        )
                    })}
                </TableBody>
            </Table>
        </div>
    )
}

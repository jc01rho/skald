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
    if (!dateString) return '없음'

    return new Date(dateString).toLocaleDateString('ko-KR', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    })
}

const truncate = (text: string | null, maxLength: number) => {
    if (!text) return '아직 요약이 없습니다'
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
            <div className="space-y-3 rounded-xl border bg-background p-4 sm:p-5">
                {['one', 'two', 'three', 'four', 'five'].map((item) => (
                    <Skeleton key={item} className="h-16 w-full rounded-lg" />
                ))}
            </div>
        )
    }

    if (items.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-muted/20 px-6 py-16 text-center sm:px-8">
                <FileText className="mb-4 h-10 w-10 text-muted-foreground" />
                <h3 className="mb-2 text-xl font-semibold text-foreground">{emptyTitle}</h3>
                <p className="mb-6 max-w-md text-sm leading-6 text-muted-foreground">{emptyDescription}</p>
                {onCreateMemo && (
                    <Button onClick={onCreateMemo} size="lg" className="gap-2">
                        <Plus className="h-4 w-4" />
                        메모 제출
                    </Button>
                )}
            </div>
        )
    }

    return (
        <div className="overflow-hidden rounded-xl border bg-background">
            <Table className="w-full table-fixed">
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-[27%] px-4 py-3 text-xs font-semibold tracking-tight text-muted-foreground">
                            제목
                        </TableHead>
                        <TableHead className="w-[33%] px-4 py-3 text-xs font-semibold tracking-tight text-muted-foreground">
                            요약
                        </TableHead>
                        <TableHead className="w-[14%] px-4 py-3 text-xs font-semibold tracking-tight text-muted-foreground">
                            상태
                        </TableHead>
                        <TableHead className="w-[14%] px-4 py-3 text-xs font-semibold tracking-tight text-muted-foreground">
                            출처
                        </TableHead>
                        <TableHead className="w-[12%] px-4 py-3 text-xs font-semibold tracking-tight text-muted-foreground">
                            최근 변경일
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {items.map((item) => {
                        const pending = isPendingSubmission(item)
                        const statusLabel = pending ? (
                            <Badge variant="outline" className="flex items-center gap-1">
                                <Clock3 className="h-3 w-3" />
                                대기 중
                            </Badge>
                        ) : (
                            <Badge variant="default" className="flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3" />
                                승인됨
                            </Badge>
                        )

                        const updatedAt = pending ? item.updated_at : item.approved_at || item.created_at

                        return (
                            <TableRow
                                key={item.uuid}
                                className={
                                    onSelectItem
                                        ? 'group cursor-pointer transition-colors hover:bg-muted/40'
                                        : undefined
                                }
                                onClick={onSelectItem ? () => onSelectItem(item) : undefined}
                            >
                                <TableCell className="px-4 py-4 font-medium align-top">
                                    <div className="min-w-0 space-y-1">
                                        <p
                                            className="truncate leading-5 underline-offset-4 group-hover:underline"
                                            title={item.title}
                                        >
                                            {item.title}
                                        </p>
                                        {pending && item.submitter_name && (
                                            <p
                                                className="text-xs text-muted-foreground truncate"
                                                title={item.submitter_name}
                                            >
                                                제출자: {item.submitter_name}
                                            </p>
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell className="px-4 py-4 align-top">
                                    <p
                                        className="line-clamp-2 text-sm text-muted-foreground break-words"
                                        title={item.summary ?? ''}
                                    >
                                        {truncate(item.summary, 160)}
                                    </p>
                                </TableCell>
                                <TableCell className="px-4 py-4 align-top">{statusLabel}</TableCell>
                                <TableCell className="px-4 py-4 text-sm text-muted-foreground align-top">
                                    <span className="block truncate" title={item.source ?? ''}>
                                        {item.source || '—'}
                                    </span>
                                </TableCell>
                                <TableCell className="px-4 py-4 text-sm text-muted-foreground align-top">
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

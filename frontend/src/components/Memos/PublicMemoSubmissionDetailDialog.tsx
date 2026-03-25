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
    if (!dateString) return '없음'

    return new Date(dateString).toLocaleString('ko-KR', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

const getMemoTypeLabel = (type: string | null | undefined) => {
    if (!type) return null

    const normalizedType = type.toLowerCase()

    if (normalizedType === 'code') return '코드'
    if (normalizedType === 'document') return '문서'

    return type
}

export const PublicMemoSubmissionDetailDialog = ({ submission, onClose }: PublicMemoSubmissionDetailDialogProps) => {
    return (
        <Dialog open={!!submission} onOpenChange={onClose}>
            <DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden p-0">
                <DialogHeader className="border-b px-6 py-5">
                    <DialogTitle>제출 상세 정보</DialogTitle>
                    <DialogDescription>
                        검토 대기 중인 공개 메모 제출 내용을 자세히 확인할 수 있습니다.
                    </DialogDescription>
                </DialogHeader>

                {submission && (
                    <div className="max-h-[72vh] overflow-y-auto px-6 py-6">
                        <div className="space-y-6">
                            <div className="space-y-4">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0 space-y-2">
                                        <h2 className="text-2xl font-bold break-words">{submission.title}</h2>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <MemoSubmissionStatusBadge status={submission.status} />
                                            {submission.type && (
                                                <Badge variant="outline">{getMemoTypeLabel(submission.type)}</Badge>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 gap-4 rounded-xl border bg-muted/20 p-4 text-sm text-muted-foreground md:grid-cols-2">
                                    <div>
                                        <p className="font-medium text-foreground">제출 일시</p>
                                        <p>{formatDate(submission.created_at)}</p>
                                    </div>
                                    <div>
                                        <p className="font-medium text-foreground">제출자</p>
                                        <p>{submission.submitter_name || submission.submitter_email || '익명 제출'}</p>
                                    </div>
                                    <div>
                                        <p className="font-medium text-foreground">출처</p>
                                        <p>{submission.source || '—'}</p>
                                    </div>
                                    {(submission.review_note || submission.reviewed_at) && (
                                        <div>
                                            <p className="font-medium text-foreground">검토 정보</p>
                                            <p>
                                                {submission.reviewed_at
                                                    ? `${formatDate(submission.reviewed_at)}에 검토됨`
                                                    : '검토 메모가 등록됨'}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {submission.summary && (
                                <Card>
                                    <CardHeader className="border-b">
                                        <CardTitle>요약</CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <p className="text-sm leading-relaxed whitespace-pre-wrap">
                                            {submission.summary}
                                        </p>
                                    </CardContent>
                                </Card>
                            )}

                            <Card>
                                <CardHeader className="border-b">
                                    <CardTitle>내용</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans">
                                        {submission.content || '표시할 내용이 없습니다'}
                                    </pre>
                                </CardContent>
                            </Card>

                            {submission.review_note && (
                                <Card>
                                    <CardHeader className="border-b">
                                        <CardTitle>검토 메모</CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                                            {submission.review_note}
                                        </p>
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}

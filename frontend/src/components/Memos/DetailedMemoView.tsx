import { DetailedMemo } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
    Calendar,
    Clock,
    FileText,
    Hash,
    Tag,
    Archive,
    AlertCircle,
    CheckCircle,
    ExternalLink,
    Code,
    Database,
} from 'lucide-react'
import { formatDate } from '@/components/utils/dateUtils'
import { addMonths, isBefore } from 'date-fns'
import ReactMarkdown from 'react-markdown'

interface DetailedMemoViewProps {
    memo: DetailedMemo
}

export const DetailedMemoView = ({ memo }: DetailedMemoViewProps) => {
    const getMemoTypeLabel = (type: string | null | undefined) => {
        if (!type) return null

        const normalizedType = type.toLowerCase()

        if (normalizedType === 'code') return '코드'
        if (normalizedType === 'document') return '문서'

        return type
    }

    const getExpirationStyles = (dateString: string) => {
        const expirationDate = new Date(dateString)
        const now = new Date()
        const oneMonthFromNow = addMonths(now, 1)

        const isExpired = isBefore(expirationDate, now)
        const isExpiringSoon = isBefore(expirationDate, oneMonthFromNow)

        let valueStyles = 'text-muted-foreground'
        let labelStyles = 'text-white'

        if (isExpired) {
            valueStyles = 'text-destructive'
            labelStyles = 'text-destructive'
        } else if (isExpiringSoon) {
            valueStyles = 'text-amber-600'
            labelStyles = 'text-amber-600'
        }

        return {
            labelStyles,
            valueStyles,
        }
    }

    const getExpirationLabel = (dateString: string): string => {
        const expirationDate = new Date(dateString)
        const now = new Date()

        if (isBefore(expirationDate, now)) {
            return '만료일'
        }
        return '만료 예정일'
    }

    const expirationStyles = memo.expiration_date ? getExpirationStyles(memo.expiration_date) : null
    const expirationLabel = memo.expiration_date ? getExpirationLabel(memo.expiration_date) : null

    const getStatusBadge = () => {
        if (memo.archived) {
            return (
                <Badge variant="secondary" className="flex items-center gap-1">
                    <Archive className="h-3 w-3" />
                    보관됨
                </Badge>
            )
        }
        if (memo.processing_status === 'processing') {
            return (
                <Badge variant="outline" className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    처리 중
                </Badge>
            )
        }
        if (memo.processing_status === 'processed') {
            return (
                <Badge variant="default" className="flex items-center gap-1">
                    <CheckCircle className="h-3 w-3" />
                    처리 완료
                </Badge>
            )
        }
        if (memo.processing_status === 'error') {
            return (
                <Badge variant="destructive" className="flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    오류
                </Badge>
            )
        }
    }

    const getTypeIcon = () => {
        switch (memo.type?.toLowerCase()) {
            case 'code':
                return <Code className="h-6 w-6" />
            case 'document':
                return <FileText className="h-6 w-6" />
            default:
                return <Database className="h-6 w-6" />
        }
    }

    return (
        <div className="space-y-6">
            <div className="space-y-5 rounded-2xl border bg-muted/20 p-5 sm:p-6">
                <div className="flex items-start justify-between gap-4">
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-3">
                            {getTypeIcon()}
                            <h1 className="text-2xl font-bold leading-tight sm:text-[2rem]">{memo.title}</h1>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                            {getStatusBadge()}
                            {memo.type && (
                                <Badge variant="outline" className="flex items-center gap-1">
                                    {getTypeIcon()}
                                    {getMemoTypeLabel(memo.type)}
                                </Badge>
                            )}
                            {memo.source && (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <ExternalLink className="h-4 w-4" />
                                    <span>출처: {memo.source}</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-4 pt-1 text-sm md:grid-cols-2">
                    <div className="flex items-start gap-3 rounded-xl border bg-background/70 p-4">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <div>
                            <div className="font-medium">생성일</div>
                            <div className="text-muted-foreground">{formatDate(memo.created_at)}</div>
                        </div>
                    </div>
                    <div className="flex items-start gap-3 rounded-xl border bg-background/70 p-4">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <div>
                            <div className="font-medium">수정일</div>
                            <div className="text-muted-foreground">{formatDate(memo.updated_at)}</div>
                        </div>
                    </div>
                </div>

                {(memo.client_reference_id || memo.expiration_date) && (
                    <div className="grid grid-cols-1 gap-4 pt-1 text-sm md:grid-cols-2">
                        {memo.client_reference_id && (
                            <div className="flex items-start gap-3 rounded-xl border bg-background/70 p-4 text-sm">
                                <Hash className="h-4 w-4 text-muted-foreground" />
                                <div>
                                    <div className="font-medium">참조 ID</div>
                                    <span className="text-muted-foreground font-mono">{memo.client_reference_id}</span>
                                </div>
                            </div>
                        )}

                        {memo.expiration_date && expirationStyles && expirationLabel && (
                            <div className="flex items-start gap-3 rounded-xl border bg-background/70 p-4 text-sm">
                                <AlertCircle className={`h-4 w-4 ${expirationStyles.valueStyles}`} />
                                <div>
                                    <div className={`font-medium ${expirationStyles.labelStyles}`}>
                                        {expirationLabel}
                                    </div>
                                    <span className={expirationStyles.valueStyles}>
                                        {formatDate(memo.expiration_date)}
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            <Separator />

            {memo.content && (
                <Card>
                    <CardHeader className="border-b">
                        <CardTitle className="flex items-center gap-2">
                            <FileText className="h-5 w-5" />
                            내용
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="max-h-[420px] w-full overflow-y-auto rounded-lg bg-background/50">
                            <div className="prose prose-sm max-w-none">
                                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed react-markdown">
                                    <ReactMarkdown>{memo.content}</ReactMarkdown>
                                </pre>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {memo.summary && (
                <Card>
                    <CardHeader className="border-b">
                        <CardTitle className="flex items-center gap-2">
                            <FileText className="h-5 w-5" />
                            요약
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm leading-relaxed">{memo.summary}</p>
                    </CardContent>
                </Card>
            )}

            {memo.tags && memo.tags.length > 0 && (
                <Card>
                    <CardHeader className="border-b">
                        <CardTitle className="flex items-center gap-2">
                            <Tag className="h-5 w-5" />
                            태그 ({memo.tags.length})
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex flex-wrap gap-2">
                            {memo.tags.map((tag) => (
                                <Badge key={tag.uuid} variant="secondary" className="flex items-center gap-1">
                                    <Tag className="h-3 w-3" />
                                    {tag.tag}
                                </Badge>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            {memo.metadata && Object.keys(memo.metadata).length > 0 && (
                <Card>
                    <CardHeader className="border-b">
                        <CardTitle className="flex items-center gap-2">
                            <Database className="h-5 w-5" />
                            메타데이터
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="max-h-48 w-full overflow-y-auto rounded-lg bg-muted/60">
                            <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">
                                {JSON.stringify(memo.metadata, null, 2)}
                            </pre>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}

import { Badge } from '@/components/ui/badge'
import type { MemoSubmissionStatus } from '@/lib/types'
import { CheckCircle, Clock3, XCircle } from 'lucide-react'

interface MemoSubmissionStatusBadgeProps {
    status: MemoSubmissionStatus
}

export const MemoSubmissionStatusBadge = ({ status }: MemoSubmissionStatusBadgeProps) => {
    if (status === 'approved') {
        return (
            <Badge variant="default" className="flex items-center gap-1">
                <CheckCircle className="h-3 w-3" />
                승인됨
            </Badge>
        )
    }

    if (status === 'rejected') {
        return (
            <Badge variant="destructive" className="flex items-center gap-1">
                <XCircle className="h-3 w-3" />
                반려됨
            </Badge>
        )
    }

    return (
        <Badge variant="outline" className="flex items-center gap-1">
            <Clock3 className="h-3 w-3" />
            대기 중
        </Badge>
    )
}

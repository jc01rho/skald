import type { DetailedMemo } from '@/lib/types'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { DetailedMemoView } from './DetailedMemoView'
import { Button } from '../ui/button'
import { Share, Trash2 } from 'lucide-react'

interface ViewMemoDialogProps {
    memo: DetailedMemo | null
    onClose: () => void
    onShareMemo?: (memo: DetailedMemo) => void | Promise<void>
    onDeleteMemo?: (memo: DetailedMemo) => void | Promise<void>
}

export const ViewMemoDialog = ({ memo, onClose, onShareMemo, onDeleteMemo }: ViewMemoDialogProps) => {
    return (
        <Dialog open={!!memo} onOpenChange={onClose}>
            <DialogContent className="max-h-[90vh] max-w-5xl overflow-hidden p-0">
                <div className="sr-only">
                    <DialogHeader>
                        <DialogTitle>메모 상세</DialogTitle>
                        <DialogDescription>이 공개 메모의 전체 정보를 확인합니다.</DialogDescription>
                    </DialogHeader>
                </div>
                <div className="max-h-[72vh] overflow-y-auto px-6 py-6">{memo && <DetailedMemoView memo={memo} />}</div>
                <DialogFooter className="border-t px-6 py-4">
                    {(onShareMemo || onDeleteMemo) && (
                        <div className="flex items-center gap-2">
                            {onShareMemo && (
                                <Button variant="outline" size="sm" onClick={() => onShareMemo?.(memo as DetailedMemo)}>
                                    <Share className="h-4 w-4 mr-1" />
                                    공유
                                </Button>
                            )}
                            {onDeleteMemo && (
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => onDeleteMemo?.(memo as DetailedMemo)}
                                >
                                    <Trash2 className="h-4 w-4 mr-1" />
                                    삭제
                                </Button>
                            )}
                        </div>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

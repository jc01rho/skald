import { Button } from '@/components/ui/button'

interface PaginationProps {
    currentPage: number
    pageSize: number
    totalCount: number
    loading: boolean
    onPageChange: (page: number) => void
    itemLabel?: string
    rangeLabel?: string
    ofLabel?: string
    previousLabel?: string
    nextLabel?: string
}

export const Pagination = ({
    currentPage,
    pageSize,
    totalCount,
    loading,
    onPageChange,
    itemLabel = 'items',
    rangeLabel = 'Showing',
    ofLabel = 'of',
    previousLabel = 'Previous',
    nextLabel = 'Next',
}: PaginationProps) => {
    const totalPages = Math.ceil(totalCount / pageSize)

    if (totalPages <= 1) {
        return null
    }

    return (
        <div className="flex items-center justify-between px-4 py-4 border-t">
            <p className="text-sm text-muted-foreground">
                {rangeLabel} {(currentPage - 1) * pageSize + 1} ~ {Math.min(currentPage * pageSize, totalCount)}{' '}
                {ofLabel} {totalCount} {itemLabel}
            </p>
            <div className="flex gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onPageChange(currentPage - 1)}
                    disabled={currentPage === 1 || loading}
                >
                    {previousLabel}
                </Button>
                <div className="flex items-center gap-1">
                    {[...Array(totalPages)].map((_, i) => {
                        const pageNum = i + 1
                        if (pageNum === 1 || pageNum === totalPages || Math.abs(pageNum - currentPage) <= 1) {
                            return (
                                <Button
                                    key={pageNum}
                                    variant={currentPage === pageNum ? 'default' : 'outline'}
                                    size="sm"
                                    onClick={() => onPageChange(pageNum)}
                                    disabled={loading}
                                    className="w-9"
                                >
                                    {pageNum}
                                </Button>
                            )
                        }
                        if (pageNum === currentPage - 2 || pageNum === currentPage + 2) {
                            return (
                                <span key={pageNum} className="px-2">
                                    ...
                                </span>
                            )
                        }
                        return null
                    })}
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onPageChange(currentPage + 1)}
                    disabled={currentPage === totalPages || loading}
                >
                    {nextLabel}
                </Button>
            </div>
        </div>
    )
}

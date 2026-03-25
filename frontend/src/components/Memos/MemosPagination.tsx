import { Pagination } from '@/components/utils/Pagination'

interface MemosPaginationProps {
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

export const MemosPagination = (props: MemosPaginationProps) => {
    return <Pagination itemLabel="memos" {...props} />
}

import { Pagination } from '@/components/utils/Pagination'

interface MemosPaginationProps {
    currentPage: number
    pageSize: number
    totalCount: number
    loading: boolean
    onPageChange: (page: number) => void
}

export const MemosPagination = (props: MemosPaginationProps) => {
    return <Pagination {...props} itemLabel="memos" />
}

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { RefreshCw, Send } from 'lucide-react'
import type { DetailedMemoSubmission, DetailedPublicMemo, MemoSubmission, PublicMemo } from '@/lib/types'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/AppLayout/PageHeader'
import { MemosPagination } from '@/components/Memos/MemosPagination'
import { PublicMemosTable } from '@/components/Memos/PublicMemosTable'
import { ViewMemoDialog } from '@/components/Memos/ViewMemoDialog'
import { PublicMemoSubmissionDetailDialog } from '@/components/Memos/PublicMemoSubmissionDetailDialog'
import { usePublicMemoSubmissionStore } from '@/stores/publicMemoSubmissionStore'

export const PublicMemosDashboard = () => {
    const { projectUuid } = useParams<{ projectUuid: string }>()
    const [activeTab, setActiveTab] = useState<'approved' | 'pending'>('approved')

    const approvedMemos = usePublicMemoSubmissionStore((state) => state.approvedMemos)
    const approvedLoading = usePublicMemoSubmissionStore((state) => state.approvedMemosLoading)
    const approvedTotalCount = usePublicMemoSubmissionStore((state) => state.approvedMemosTotalCount)
    const approvedCurrentPage = usePublicMemoSubmissionStore((state) => state.approvedMemosCurrentPage)
    const approvedPageSize = usePublicMemoSubmissionStore((state) => state.approvedMemosPageSize)
    const pendingSubmissions = usePublicMemoSubmissionStore((state) => state.pendingSubmissions)
    const pendingLoading = usePublicMemoSubmissionStore((state) => state.pendingSubmissionsLoading)
    const pendingTotalCount = usePublicMemoSubmissionStore((state) => state.pendingSubmissionsTotalCount)
    const pendingCurrentPage = usePublicMemoSubmissionStore((state) => state.pendingSubmissionsCurrentPage)
    const pendingPageSize = usePublicMemoSubmissionStore((state) => state.pendingSubmissionsPageSize)
    const fetchApprovedMemos = usePublicMemoSubmissionStore((state) => state.fetchApprovedMemos)
    const fetchPendingSubmissions = usePublicMemoSubmissionStore((state) => state.fetchPendingSubmissions)
    const getPublicMemoDetails = usePublicMemoSubmissionStore((state) => state.getPublicMemoDetails)
    const getPublicSubmissionDetails = usePublicMemoSubmissionStore((state) => state.getPublicSubmissionDetails)
    const [selectedApprovedMemo, setSelectedApprovedMemo] = useState<DetailedPublicMemo | null>(null)
    const [selectedPendingSubmission, setSelectedPendingSubmission] = useState<DetailedMemoSubmission | null>(null)

    useEffect(() => {
        if (!projectUuid) {
            return
        }

        fetchApprovedMemos(projectUuid)
        fetchPendingSubmissions(projectUuid)
    }, [fetchApprovedMemos, fetchPendingSubmissions, projectUuid])

    if (!projectUuid) {
        return null
    }

    const handleRefresh = () => {
        if (activeTab === 'approved') {
            fetchApprovedMemos(projectUuid, approvedCurrentPage, approvedPageSize)
            return
        }

        fetchPendingSubmissions(projectUuid, pendingCurrentPage, pendingPageSize)
    }

    const handleSelectItem = async (item: PublicMemo | MemoSubmission) => {
        if ('status' in item) {
            const submission = await getPublicSubmissionDetails(projectUuid, item.uuid)
            if (submission) {
                setSelectedPendingSubmission(submission)
            }
            return
        }

        const memo = await getPublicMemoDetails(projectUuid, item.uuid)
        if (memo) {
            setSelectedApprovedMemo(memo)
        }
    }

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
            <PageHeader title="공개 메모" showSidebarTrigger={false}>
                <div className="flex flex-wrap items-center gap-2">
                    <Button asChild size="sm">
                        <Link to={`/public/memos/${projectUuid}/submit`}>공개 메모 제출</Link>
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRefresh}
                        disabled={activeTab === 'approved' ? approvedLoading : pendingLoading}
                    >
                        <RefreshCw
                            className={`h-4 w-4 mr-2 ${(activeTab === 'approved' ? approvedLoading : pendingLoading) ? 'animate-spin' : ''}`}
                        />
                        새로고침
                    </Button>
                </div>
            </PageHeader>

            <Card className="mx-auto w-full max-w-6xl">
                <CardHeader className="gap-5 border-b pb-6">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-3">
                            <div className="flex items-center gap-2 text-muted-foreground">
                                <Send className="h-5 w-5" />
                                <span className="text-sm font-medium">공개 메모 공간</span>
                            </div>
                            <div className="space-y-2">
                                <CardTitle className="text-2xl sm:text-3xl">
                                    검토가 끝난 메모와 대기 중인 제출을 한곳에서 확인하세요
                                </CardTitle>
                                <CardDescription className="max-w-3xl leading-6">
                                    승인된 메모는 누구나 볼 수 있고, 검토 대기 중인 제출은 별도 탭에서 현재 상태를
                                    확인할 수 있습니다.
                                </CardDescription>
                            </div>
                        </div>

                        <Button asChild variant="outline" size="sm" className="shrink-0">
                            <Link to={`/public/memos/${projectUuid}/submit`}>새 메모 제출하기</Link>
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                    <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'approved' | 'pending')}>
                        <TabsList className="grid h-auto w-full grid-cols-2 rounded-xl p-1 sm:w-[360px]">
                            <TabsTrigger value="approved" className="py-2">
                                공개된 메모
                            </TabsTrigger>
                            <TabsTrigger value="pending" className="py-2">
                                검토 대기 제출
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent value="approved" className="mt-6 space-y-4">
                            <PublicMemosTable
                                items={approvedMemos}
                                loading={approvedLoading}
                                emptyTitle="아직 승인된 메모가 없습니다"
                                emptyDescription="검토를 통과한 공개 메모가 이곳에 표시됩니다. 새로운 메모를 제출하면 검토 후 공개될 수 있습니다."
                                onSelectItem={handleSelectItem}
                            />
                            <MemosPagination
                                currentPage={approvedCurrentPage}
                                pageSize={approvedPageSize}
                                totalCount={approvedTotalCount}
                                loading={approvedLoading}
                                itemLabel="메모"
                                rangeLabel="표시 중"
                                ofLabel="전체"
                                previousLabel="이전"
                                nextLabel="다음"
                                onPageChange={(page) => fetchApprovedMemos(projectUuid, page, approvedPageSize)}
                            />
                        </TabsContent>

                        <TabsContent value="pending" className="mt-6 space-y-4">
                            <PublicMemosTable
                                items={pendingSubmissions}
                                loading={pendingLoading}
                                emptyTitle="검토 대기 중인 제출이 없습니다"
                                emptyDescription="새로 제출된 메모는 검토가 끝날 때까지 이곳에 표시됩니다. 상태를 눌러 제출 내용을 자세히 확인할 수 있습니다."
                                onSelectItem={handleSelectItem}
                            />
                            <MemosPagination
                                currentPage={pendingCurrentPage}
                                pageSize={pendingPageSize}
                                totalCount={pendingTotalCount}
                                loading={pendingLoading}
                                itemLabel="제출"
                                rangeLabel="표시 중"
                                ofLabel="전체"
                                previousLabel="이전"
                                nextLabel="다음"
                                onPageChange={(page) => fetchPendingSubmissions(projectUuid, page, pendingPageSize)}
                            />
                        </TabsContent>
                    </Tabs>
                </CardContent>
            </Card>

            <ViewMemoDialog memo={selectedApprovedMemo} onClose={() => setSelectedApprovedMemo(null)} />
            <PublicMemoSubmissionDetailDialog
                submission={selectedPendingSubmission}
                onClose={() => setSelectedPendingSubmission(null)}
            />
        </div>
    )
}

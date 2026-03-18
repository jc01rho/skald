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
        <div className="container mx-auto py-6 space-y-6">
            <PageHeader title="Public memos" showSidebarTrigger={false}>
                <div className="flex gap-2">
                    <Button asChild size="sm">
                        <Link to={`/public/memos/${projectUuid}/submit`}>Submit memo</Link>
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
                        Refresh
                    </Button>
                </div>
            </PageHeader>

            <Card>
                <CardHeader className="gap-3">
                    <div className="flex items-center gap-2 text-muted-foreground">
                        <Send className="h-5 w-5" />
                        <span className="text-sm font-medium">Public knowledge base</span>
                    </div>
                    <CardTitle className="text-3xl">Browse public memos</CardTitle>
                    <CardDescription>
                        Approved memos are publicly visible. Pending submissions stay visible in a separate tab while
                        they wait for review.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'approved' | 'pending')}>
                        <TabsList className="grid w-full grid-cols-2 md:w-[360px]">
                            <TabsTrigger value="approved">Approved</TabsTrigger>
                            <TabsTrigger value="pending">Pending</TabsTrigger>
                        </TabsList>

                        <TabsContent value="approved" className="space-y-4">
                            <PublicMemosTable
                                items={approvedMemos}
                                loading={approvedLoading}
                                emptyTitle="No approved memos yet"
                                emptyDescription="Approved public memos will appear here after review."
                                onSelectItem={handleSelectItem}
                            />
                            <MemosPagination
                                currentPage={approvedCurrentPage}
                                pageSize={approvedPageSize}
                                totalCount={approvedTotalCount}
                                loading={approvedLoading}
                                onPageChange={(page) => fetchApprovedMemos(projectUuid, page, approvedPageSize)}
                            />
                        </TabsContent>

                        <TabsContent value="pending" className="space-y-4">
                            <PublicMemosTable
                                items={pendingSubmissions}
                                loading={pendingLoading}
                                emptyTitle="No pending submissions"
                                emptyDescription="New submissions will appear here while they wait for review."
                                onSelectItem={handleSelectItem}
                            />
                            <MemosPagination
                                currentPage={pendingCurrentPage}
                                pageSize={pendingPageSize}
                                totalCount={pendingTotalCount}
                                loading={pendingLoading}
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

import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { MemoSubmissionForm } from '@/components/Memos/MemoSubmissionForm'
import { AlertCircle } from 'lucide-react'

export const PublicSubmitMemoPage = () => {
    const { projectUuid } = useParams<{ projectUuid: string }>()

    if (!projectUuid) {
        return (
            <div className="min-h-screen bg-background px-4 py-10 sm:px-6 lg:px-8">
                <div className="mx-auto max-w-3xl">
                    <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>유효하지 않은 제출 링크입니다</AlertTitle>
                        <AlertDescription>공개 메모를 제출하려면 올바른 프로젝트 식별자가 필요합니다.</AlertDescription>
                    </Alert>
                </div>
            </div>
        )
    }

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
                <div className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
                    <div className="space-y-2.5">
                        <p className="text-sm font-medium text-muted-foreground">공개 메모</p>
                        <div className="space-y-2">
                            <h1 className="text-3xl font-semibold tracking-tight">공개 메모 제출</h1>
                            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                                로그인 없이 검토용 메모를 남길 수 있습니다. 제출된 메모는 검토를 거친 뒤 공개 메모
                                목록에 반영됩니다.
                            </p>
                        </div>
                    </div>

                    <Button asChild variant="outline" size="sm" className="shrink-0">
                        <Link to={`/public/memos/${projectUuid}`}>공개 메모 목록으로</Link>
                    </Button>
                </div>

                <MemoSubmissionForm projectUuid={projectUuid} />
            </div>
        </div>
    )
}

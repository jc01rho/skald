import { useParams } from 'react-router-dom'
import { AlertCircle } from 'lucide-react'
import { PublicMemosDashboard } from '@/components/Memos/PublicMemosDashboard'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export const PublicMemosPage = () => {
    const { projectUuid } = useParams<{ projectUuid: string }>()

    if (!projectUuid) {
        return (
            <div className="mx-auto flex w-full max-w-6xl flex-col px-4 py-8 sm:px-6 lg:px-8">
                <Alert variant="destructive" className="max-w-3xl">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>유효하지 않은 공개 메모 링크입니다</AlertTitle>
                    <AlertDescription>공개 메모를 보려면 올바른 프로젝트 식별자가 필요합니다.</AlertDescription>
                </Alert>
            </div>
        )
    }

    return <PublicMemosDashboard />
}

import { useParams } from 'react-router-dom'
import { AlertCircle } from 'lucide-react'
import { PublicMemosDashboard } from '@/components/Memos/PublicMemosDashboard'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export const PublicMemosPage = () => {
    const { projectUuid } = useParams<{ projectUuid: string }>()

    if (!projectUuid) {
        return (
            <div className="container mx-auto py-6">
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Invalid public memo link</AlertTitle>
                    <AlertDescription>A valid project identifier is required to browse public memos.</AlertDescription>
                </Alert>
            </div>
        )
    }

    return <PublicMemosDashboard />
}

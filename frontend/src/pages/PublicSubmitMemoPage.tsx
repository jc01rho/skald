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
                        <AlertTitle>Invalid submission link</AlertTitle>
                        <AlertDescription>
                            A valid project identifier is required to submit a public memo.
                        </AlertDescription>
                    </Alert>
                </div>
            </div>
        )
    }

    return (
        <div className="container mx-auto space-y-6 py-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                    <h1 className="text-3xl font-semibold tracking-tight">Submit public memo</h1>
                    <p className="text-sm text-muted-foreground">
                        Share text for review without signing in. Approved submissions appear in the public memo list.
                    </p>
                </div>

                <Button asChild variant="outline" size="sm">
                    <Link to={`/public/memos/${projectUuid}`}>View public memos</Link>
                </Button>
            </div>

            <div className="max-w-3xl">
                <MemoSubmissionForm projectUuid={projectUuid} />
            </div>
        </div>
    )
}

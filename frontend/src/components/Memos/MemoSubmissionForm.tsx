import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { usePublicMemoSubmissionStore } from '@/stores/publicMemoSubmissionStore'
import { CheckCircle2, Send } from 'lucide-react'

const memoFormSchema = z.object({
    title: z.string().min(1, 'Title is required').max(255, 'Title must be 255 characters or less'),
    content: z.string().min(1, 'Content is required'),
})

type MemoFormValues = z.infer<typeof memoFormSchema>

interface MemoSubmissionFormProps {
    projectUuid: string
}

export const MemoSubmissionForm = ({ projectUuid }: MemoSubmissionFormProps) => {
    const [isSubmitted, setIsSubmitted] = useState(false)
    const submitPublicMemo = usePublicMemoSubmissionStore((state) => state.submitPublicMemo)
    const isSubmitting = usePublicMemoSubmissionStore((state) => state.submitting)

    const form = useForm<MemoFormValues>({
        resolver: zodResolver(memoFormSchema),
        defaultValues: {
            title: '',
            content: '',
        },
    })

    const resetFormState = () => {
        form.reset()
        setIsSubmitted(false)
    }

    const onSubmit = async (data: MemoFormValues) => {
        const success = await submitPublicMemo({
            projectUuid,
            title: data.title,
            content: data.content,
        })

        if (success) {
            resetFormState()
            setIsSubmitted(true)
        }
    }

    return (
        <Card>
            <CardHeader className="gap-3">
                <div className="flex items-center gap-2 text-muted-foreground">
                    <Send className="h-5 w-5" />
                    <span className="text-sm font-medium">Public memo intake</span>
                </div>
                <CardTitle className="text-2xl">Submit public memo</CardTitle>
                <CardDescription>
                    Text-only submission. Share a title and the memo content for review without signing in.
                </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
                {isSubmitted && (
                    <Alert>
                        <CheckCircle2 className="h-4 w-4" />
                        <AlertTitle>Submission received</AlertTitle>
                        <AlertDescription>
                            Your memo is now waiting for review. Once approved, it will appear in the public memo list.
                        </AlertDescription>
                    </Alert>
                )}

                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                        <div className="space-y-4">
                            <FormField
                                control={form.control}
                                name="title"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>
                                            Title <span className="text-destructive">*</span>
                                        </FormLabel>
                                        <FormControl>
                                            <Input placeholder="Enter memo title" {...field} />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            <FormField
                                control={form.control}
                                name="content"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>
                                            Content <span className="text-destructive">*</span>
                                        </FormLabel>
                                        <FormControl>
                                            <Textarea
                                                placeholder="Paste the memo content you want reviewed"
                                                className="min-h-[220px] resize-y"
                                                {...field}
                                            />
                                        </FormControl>
                                        <FormDescription>
                                            Reviewers use this content to decide whether the memo should be published.
                                        </FormDescription>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                        </div>

                        <div className="flex justify-end gap-3 pt-4">
                            <Button type="button" variant="outline" onClick={resetFormState} disabled={isSubmitting}>
                                Reset
                            </Button>
                            <Button type="submit" disabled={isSubmitting}>
                                Submit memo
                            </Button>
                        </div>
                    </form>
                </Form>
            </CardContent>
        </Card>
    )
}

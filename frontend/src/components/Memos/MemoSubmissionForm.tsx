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
    title: z.string().min(1, '제목을 입력해주세요').max(255, '제목은 255자 이하로 입력해주세요'),
    content: z.string().min(1, '내용을 입력해주세요'),
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
        <Card className="overflow-hidden">
            <CardHeader className="gap-4 border-b pb-6">
                <div className="flex items-center gap-2 text-muted-foreground">
                    <Send className="h-5 w-5" />
                    <span className="text-sm font-medium">공개 메모 접수</span>
                </div>
                <CardTitle className="text-2xl">검토용 메모를 제출하세요</CardTitle>
                <CardDescription className="leading-6">
                    로그인 없이 제목과 메모 내용을 남길 수 있습니다. 제출된 내용은 검토 후 공개 여부가 결정되며,
                    승인되면 공개 메모 목록에 표시됩니다.
                </CardDescription>
            </CardHeader>

            <CardContent className="space-y-8 pt-6">
                {isSubmitted && (
                    <Alert className="border-primary/20 bg-primary/5">
                        <CheckCircle2 className="h-4 w-4" />
                        <AlertTitle>제출이 접수되었습니다</AlertTitle>
                        <AlertDescription>
                            메모가 검토 대기 상태로 등록되었습니다. 승인되면 공개 메모 목록에 표시됩니다.
                        </AlertDescription>
                    </Alert>
                )}

                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                        <div className="space-y-5">
                            <FormField
                                control={form.control}
                                name="title"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>
                                            제목 <span className="text-destructive">*</span>
                                        </FormLabel>
                                        <FormControl>
                                            <Input placeholder="예: 3월 고객 인터뷰 요약" {...field} />
                                        </FormControl>
                                        <FormDescription>
                                            목록에서 한눈에 이해할 수 있는 제목으로 작성해 주세요.
                                        </FormDescription>
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
                                            내용 <span className="text-destructive">*</span>
                                        </FormLabel>
                                        <FormControl>
                                            <Textarea
                                                placeholder="검토받을 메모 내용을 그대로 붙여넣거나 직접 입력해 주세요."
                                                className="min-h-[260px] resize-y"
                                                {...field}
                                            />
                                        </FormControl>
                                        <FormDescription>
                                            검토자는 이 내용을 바탕으로 공개 여부를 판단합니다. 민감한 정보는 제출 전에
                                            제거해 주세요.
                                        </FormDescription>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                        </div>

                        <div className="flex flex-col-reverse gap-3 border-t pt-6 sm:flex-row sm:justify-end">
                            <Button type="button" variant="outline" onClick={resetFormState} disabled={isSubmitting}>
                                입력 초기화
                            </Button>
                            <Button type="submit" disabled={isSubmitting}>
                                메모 제출
                            </Button>
                        </div>
                    </form>
                </Form>
            </CardContent>
        </Card>
    )
}

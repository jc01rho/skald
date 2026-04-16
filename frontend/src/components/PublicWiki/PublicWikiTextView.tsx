import ReactMarkdown from 'react-markdown'
import { FileText, Loader2, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export interface PublicWikiTextPage {
    id: string
    slug: string
    title: string
    summary: string | null
    content: string
    page_type: string
    updated_at: string
}

interface PublicWikiTextViewProps {
    page: PublicWikiTextPage | null
    loading: boolean
    emptyMessage: string
}

export const PublicWikiTextView = ({ page, loading, emptyMessage }: PublicWikiTextViewProps) => {
    return (
        <Card className="overflow-hidden border-slate-200/80 shadow-sm">
            <CardHeader className="border-b bg-white/80 backdrop-blur">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="gap-1 bg-slate-900 text-slate-50">
                        <FileText className="h-3 w-3" />
                        Text reading view
                    </Badge>
                    {page?.page_type ? <Badge variant="outline">{page.page_type}</Badge> : null}
                </div>
                <CardTitle className="text-2xl text-slate-900">{page?.title || '페이지를 선택해 주세요'}</CardTitle>
                <CardDescription>
                    {page
                        ? `${page.slug} · ${new Date(page.updated_at).toLocaleString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                          })}`
                        : emptyMessage}
                </CardDescription>
            </CardHeader>
            <CardContent className="bg-[linear-gradient(180deg,rgba(248,250,252,0.94),rgba(255,255,255,1))] p-6 sm:p-8">
                {loading ? (
                    <div className="flex min-h-[320px] items-center justify-center gap-3 text-sm text-slate-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        텍스트를 불러오는 중입니다.
                    </div>
                ) : !page ? (
                    <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-200 bg-white/70 px-6 text-center text-sm text-slate-500">
                        <Sparkles className="h-5 w-5 text-slate-400" />
                        {emptyMessage}
                    </div>
                ) : (
                    <div className="space-y-6">
                        {page.summary ? (
                            <div className="rounded-2xl border border-slate-200/80 bg-white/90 p-5 shadow-sm">
                                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                    Summary
                                </p>
                                <p className="mt-3 text-sm leading-7 text-slate-700">{page.summary}</p>
                            </div>
                        ) : null}

                        <div className="rounded-[28px] border border-slate-200/80 bg-white p-6 shadow-[0_18px_60px_rgba(15,23,42,0.06)] sm:p-8">
                            <div className="prose prose-slate max-w-none text-[15px] leading-7 react-markdown">
                                <ReactMarkdown>{page.content}</ReactMarkdown>
                            </div>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

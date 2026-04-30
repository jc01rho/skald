import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router-dom'
import { BookOpenText, FileText, Home, Loader2, Network, Sparkles, Tag } from 'lucide-react'
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
    projectSlug?: string | null
}

const getPageTypeMeta = (pageType?: string | null) => {
    switch (pageType) {
        case 'index_page':
            return { icon: Home, label: 'Wiki Home' }
        case 'concept_page':
            return { icon: BookOpenText, label: '개념 문서' }
        case 'entity_page':
            return { icon: Tag, label: '엔티티 문서' }
        case 'process_page':
            return { icon: Network, label: '프로세스 문서' }
        default:
            return { icon: FileText, label: '문서' }
    }
}

const getInternalWikiPageRoute = (href: string | undefined, projectSlug?: string | null) => {
    if (!href || !projectSlug) {
        return null
    }

    const normalizedHref = href.trim()
    if (!normalizedHref || normalizedHref.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(normalizedHref)) {
        return null
    }

    const [withoutHash, hashFragment = ''] = normalizedHref.split('#', 2)
    const [pathOnly, queryString = ''] = withoutHash.split('?', 2)
    const suffix = `${queryString ? `?${queryString}` : ''}${hashFragment ? `#${hashFragment}` : ''}`
    const sanitizedHref = pathOnly

    if (sanitizedHref.startsWith('/public/wiki/')) {
        const parts = sanitizedHref.split('/').filter(Boolean)
        const pageSlug = parts[3] === 'pages' ? parts[4] : parts[2]
        return pageSlug ? `/public/wiki/${projectSlug}/pages/${pageSlug}${suffix}` : null
    }

    if (sanitizedHref.startsWith('../')) {
        return null
    }

    const pageSlug = sanitizedHref.replace(/^\.\//, '').replace(/^\//, '')
    return pageSlug ? `/public/wiki/${projectSlug}/pages/${pageSlug}${suffix}` : null
}

export const PublicWikiTextView = ({ page, loading, emptyMessage, projectSlug }: PublicWikiTextViewProps) => {
    const pageTypeMeta = getPageTypeMeta(page?.page_type)
    const PageTypeIcon = pageTypeMeta.icon

    return (
        <Card className="overflow-hidden border-teal-200/70 bg-white/88 shadow-[0_24px_80px_rgba(15,118,110,0.11)] backdrop-blur">
            <CardHeader className="border-b border-teal-100 bg-[linear-gradient(135deg,rgba(240,253,250,0.92),rgba(255,251,235,0.86))] text-teal-950 backdrop-blur">
                <div className="flex flex-wrap items-center gap-2 text-sm text-teal-800/70">
                    <span className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-teal-800">
                        <PageTypeIcon className="h-3.5 w-3.5" />
                        {pageTypeMeta.label}
                    </span>
                    {page?.page_type === 'index_page' ? (
                        <Badge className="rounded-full bg-amber-600 text-white hover:bg-amber-600">Start here</Badge>
                    ) : null}
                </div>
                <CardTitle className="text-2xl leading-tight text-teal-950 sm:text-[2rem]">
                    {page?.title || '페이지를 선택해 주세요'}
                </CardTitle>
                <CardDescription className="text-teal-900/70">
                    {page
                        ? `Last updated ${new Date(page.updated_at).toLocaleString('en-US', {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                          })} · ${page.slug}`
                        : emptyMessage}
                </CardDescription>
            </CardHeader>
            <CardContent className="bg-[linear-gradient(180deg,rgba(255,247,237,0.66),rgba(255,255,255,0.96))] p-6 text-stone-900 sm:p-8">
                {loading ? (
                    <div className="flex min-h-[320px] items-center justify-center gap-3 text-sm text-teal-700/75">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        텍스트를 불러오는 중입니다.
                    </div>
                ) : !page ? (
                    <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-amber-200 bg-amber-50/70 px-6 text-center text-sm text-amber-700">
                        <Sparkles className="h-5 w-5 text-amber-500" />
                        {emptyMessage}
                    </div>
                ) : (
                    <div className="space-y-6">
                        {page.summary ? (
                            <div className="rounded-2xl border border-amber-200/80 bg-amber-50/70 p-5 shadow-sm shadow-amber-900/5">
                                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700/80">
                                    Summary
                                </p>
                                <p
                                    className={`mt-3 leading-7 text-stone-800 ${page.page_type === 'index_page' ? 'text-base sm:text-[1.05rem]' : 'text-sm'}`}
                                >
                                    {page.summary}
                                </p>
                            </div>
                        ) : null}

                        <div className="rounded-[28px] border border-teal-100 bg-white/92 p-6 shadow-[0_18px_60px_rgba(15,118,110,0.08)] sm:p-8">
                            <div
                                className={`react-markdown prose prose-stone mx-auto text-[15px] leading-7 prose-a:text-teal-700 prose-a:decoration-teal-300 prose-strong:text-teal-950 prose-headings:text-teal-950 ${page.page_type === 'index_page' ? 'prose-lg max-w-3xl' : 'max-w-prose'}`}
                            >
                                <ReactMarkdown
                                    components={{
                                        a: ({ href, children, ...props }) => {
                                            const internalWikiPageRoute = getInternalWikiPageRoute(href, projectSlug)

                                            if (internalWikiPageRoute) {
                                                return (
                                                    <Link to={internalWikiPageRoute} {...props}>
                                                        {children}
                                                    </Link>
                                                )
                                            }

                                            return (
                                                <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                                                    {children}
                                                </a>
                                            )
                                        },
                                    }}
                                >
                                    {page.content}
                                </ReactMarkdown>
                            </div>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

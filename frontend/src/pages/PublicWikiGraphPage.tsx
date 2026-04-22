import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
    AlertCircle,
    BookOpenText,
    ChevronRight,
    FileText,
    Home,
    Loader2,
    Network,
    ScanSearch,
    Search,
    Sparkles,
    Tag,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
    PublicWikiGraphView,
    type PublicWikiGraphEdge,
    type PublicWikiGraphNode,
} from '@/components/PublicWiki/PublicWikiGraphView'
import { PublicWikiTextView, type PublicWikiTextPage } from '@/components/PublicWiki/PublicWikiTextView'
import { cn } from '@/lib/utils'

type GraphMode = 'page' | 'node'
type ViewMode = 'graph' | 'text'

interface PublicWikiConfig {
    title: string
    logo_url: string | null
}

interface PublicWikiProjectSummary {
    slug: string | null
    name: string
    title: string
    logo_url: string | null
}

interface PublicWikiGraphResponse {
    project: PublicWikiProjectSummary
    stats: {
        nodes: number
        edges: number
    }
    nodes: PublicWikiGraphNode[]
    edges: PublicWikiGraphEdge[]
}

interface PublicWikiPageDetailResponse {
    project: PublicWikiProjectSummary
    page: PublicWikiTextPage
}

interface PageNodeGroup {
    key: string
    label: string
    icon: typeof FileText
    nodes: PublicWikiGraphNode[]
}

const PAGE_TYPE_ORDER = [
    'concept_page',
    'process_page',
    'entity_page',
    'faq_page',
    'synthesis_page',
    'comparison_page',
    'policy_page',
    'source_digest_page',
    'default',
] as const

const LARGE_PAGE_GROUP_THRESHOLD = 12

const findDefaultPageNode = (nodes: PublicWikiGraphNode[]) =>
    nodes.find((node) => node.page_type === 'index_page') ?? nodes[0] ?? null

const sortPageNodes = (nodes: PublicWikiGraphNode[]) =>
    [...nodes].sort((left, right) => {
        if (left.page_type === 'index_page' && right.page_type !== 'index_page') {
            return -1
        }
        if (left.page_type !== 'index_page' && right.page_type === 'index_page') {
            return 1
        }

        return (left.title || left.slug || '').localeCompare(right.title || right.slug || '', 'en-US')
    })

const getPageTypeMeta = (pageType?: string | null) => {
    switch (pageType) {
        case 'index_page':
            return { label: 'Wiki Home', icon: Home }
        case 'concept_page':
            return { label: '개념', icon: BookOpenText }
        case 'entity_page':
            return { label: '엔티티', icon: Tag }
        case 'process_page':
            return { label: '프로세스', icon: Network }
        case 'faq_page':
            return { label: 'FAQ', icon: BookOpenText }
        case 'synthesis_page':
            return { label: '큐레이션', icon: Sparkles }
        case 'comparison_page':
            return { label: '비교', icon: ScanSearch }
        case 'policy_page':
            return { label: '정책', icon: FileText }
        case 'source_digest_page':
            return { label: '다이제스트', icon: FileText }
        default:
            return { label: '문서', icon: FileText }
    }
}

const getPageTypeGroupKey = (pageType?: string | null) => {
    switch (pageType) {
        case 'concept_page':
        case 'process_page':
        case 'entity_page':
        case 'faq_page':
        case 'synthesis_page':
        case 'comparison_page':
        case 'policy_page':
        case 'source_digest_page':
            return pageType
        default:
            return 'default'
    }
}

const getSearchableText = (node: PublicWikiGraphNode) => {
    const pageTypeMeta = getPageTypeMeta(node.page_type)
    return [node.title, node.slug, pageTypeMeta.label].filter(Boolean).join(' ').toLowerCase()
}

export const PublicWikiGraphPage = () => {
    const { slug } = useParams<{ slug: string }>()
    const [isChecking, setIsChecking] = useState(true)
    const [isAvailable, setIsAvailable] = useState(false)
    const [graphMode, setGraphMode] = useState<GraphMode>('page')
    const [viewMode, setViewMode] = useState<ViewMode>('text')
    const [focusMode, setFocusMode] = useState(false)
    const [config, setConfig] = useState<PublicWikiConfig | null>(null)
    const [pageGraph, setPageGraph] = useState<PublicWikiGraphResponse | null>(null)
    const [nodeGraph, setNodeGraph] = useState<PublicWikiGraphResponse | null>(null)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
    const [selectedPageDetail, setSelectedPageDetail] = useState<PublicWikiTextPage | null>(null)
    const [isPageDetailLoading, setIsPageDetailLoading] = useState(false)
    const [pageDetailError, setPageDetailError] = useState<string | null>(null)
    const [pageSearchQuery, setPageSearchQuery] = useState('')

    useEffect(() => {
        if (!slug) {
            setIsChecking(false)
            setIsAvailable(false)
            return
        }

        const loadPublicWiki = async () => {
            setIsChecking(true)
            setErrorMessage(null)
            try {
                const [availabilityResponse, configResponse, pageGraphResponse, nodeGraphResponse] = await Promise.all([
                    api.get<{ available: boolean }>(`/public/wiki/${slug}/available`),
                    api.get<PublicWikiConfig>(`/public/wiki/${slug}/config`).catch(() => null),
                    api.get<PublicWikiGraphResponse>(`/public/wiki/${slug}/page-graph`).catch(() => null),
                    api.get<PublicWikiGraphResponse>(`/public/wiki/${slug}/node-graph`).catch(() => null),
                ])

                const available = availabilityResponse.data?.available === true
                setIsAvailable(available)

                if (!available) {
                    return
                }

                if (!configResponse?.data || !pageGraphResponse?.data || !nodeGraphResponse?.data) {
                    setErrorMessage('공개 wiki 그래프를 불러오지 못했습니다.')
                    return
                }

                setConfig(configResponse.data)
                setPageGraph(pageGraphResponse.data)
                setNodeGraph(nodeGraphResponse.data)
                setSelectedPageId(findDefaultPageNode(pageGraphResponse.data.nodes)?.id ?? null)
                setSelectedNodeId(nodeGraphResponse.data.nodes[0]?.id ?? null)
            } catch (error) {
                console.error('Error loading public wiki graph:', error)
                setIsAvailable(false)
                setErrorMessage('공개 wiki 그래프를 확인하지 못했습니다.')
            } finally {
                setIsChecking(false)
            }
        }

        loadPublicWiki()
    }, [slug])

    useEffect(() => {
        setPageSearchQuery('')
    }, [slug])

    const activeGraph = useMemo(() => (graphMode === 'page' ? pageGraph : nodeGraph), [graphMode, nodeGraph, pageGraph])
    const sortedPageNodes = useMemo(() => sortPageNodes(pageGraph?.nodes ?? []), [pageGraph])
    const homePageNode = useMemo(
        () => sortedPageNodes.find((node) => node.page_type === 'index_page') ?? null,
        [sortedPageNodes]
    )
    const secondaryPageNodes = useMemo(
        () => sortedPageNodes.filter((node) => node.page_type !== 'index_page'),
        [sortedPageNodes]
    )
    const normalizedPageSearchQuery = pageSearchQuery.trim().toLowerCase()
    const filteredSecondaryPageNodes = useMemo(() => {
        if (!normalizedPageSearchQuery) {
            return secondaryPageNodes
        }

        return secondaryPageNodes.filter((node) => getSearchableText(node).includes(normalizedPageSearchQuery))
    }, [normalizedPageSearchQuery, secondaryPageNodes])
    const groupedSecondaryPageNodes = useMemo<PageNodeGroup[]>(() => {
        const groups = new Map<string, PageNodeGroup>()

        for (const node of filteredSecondaryPageNodes) {
            const key = getPageTypeGroupKey(node.page_type)
            if (!groups.has(key)) {
                const pageTypeMeta = getPageTypeMeta(node.page_type)
                groups.set(key, {
                    key,
                    label: pageTypeMeta.label,
                    icon: pageTypeMeta.icon,
                    nodes: [],
                })
            }

            groups.get(key)?.nodes.push(node)
        }

        return [...groups.values()].sort((left, right) => {
            const leftIndex = PAGE_TYPE_ORDER.indexOf(left.key as (typeof PAGE_TYPE_ORDER)[number])
            const rightIndex = PAGE_TYPE_ORDER.indexOf(right.key as (typeof PAGE_TYPE_ORDER)[number])

            if (leftIndex !== rightIndex) {
                return leftIndex - rightIndex
            }

            return left.label.localeCompare(right.label, 'ko-KR')
        })
    }, [filteredSecondaryPageNodes])

    const selectedPageNode = useMemo(
        () =>
            pageGraph?.nodes.find((node) => node.id === selectedPageId) ??
            findDefaultPageNode(pageGraph?.nodes ?? []) ??
            null,
        [pageGraph, selectedPageId]
    )

    useEffect(() => {
        if (!slug || viewMode !== 'text' || !selectedPageNode?.slug) {
            setSelectedPageDetail(null)
            if (viewMode === 'text') {
                setPageDetailError(null)
            }
            return
        }

        let cancelled = false
        const loadPageDetail = async () => {
            setIsPageDetailLoading(true)
            setPageDetailError(null)
            try {
                const response = await api.get<PublicWikiPageDetailResponse>(
                    `/public/wiki/${slug}/pages/${selectedPageNode.slug}`
                )
                if (!cancelled) {
                    setSelectedPageDetail(response.data?.page ?? null)
                    if (!response.data?.page) {
                        setPageDetailError('페이지 상세를 불러오지 못했습니다.')
                    }
                }
            } catch (error) {
                console.error('Error loading public wiki page detail:', error)
                if (!cancelled) {
                    setSelectedPageDetail(null)
                    setPageDetailError('페이지 상세를 불러오지 못했습니다.')
                }
            } finally {
                if (!cancelled) {
                    setIsPageDetailLoading(false)
                }
            }
        }

        loadPageDetail()
        return () => {
            cancelled = true
        }
    }, [selectedPageNode?.slug, slug, viewMode])

    if (!slug) {
        return (
            <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center px-4 py-8 sm:px-6 lg:px-8">
                <Alert variant="destructive" className="max-w-3xl">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>유효하지 않은 공개 wiki 링크입니다</AlertTitle>
                    <AlertDescription>공개 wiki를 보려면 올바른 slug가 필요합니다.</AlertDescription>
                </Alert>
            </div>
        )
    }

    if (isChecking) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin" />
            </div>
        )
    }

    if (!isAvailable) {
        return (
            <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center px-4 py-8 sm:px-6 lg:px-8">
                <Alert variant="destructive" className="max-w-3xl">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>공개 wiki 그래프를 찾을 수 없습니다</AlertTitle>
                    <AlertDescription>
                        {errorMessage || '이 slug는 아직 활성화되지 않았거나 접근할 수 없습니다.'}
                    </AlertDescription>
                </Alert>
            </div>
        )
    }

    const currentSelectedNodeId = graphMode === 'page' ? selectedPageId : selectedNodeId
    const pageCount = pageGraph?.stats.nodes ?? 0
    const selectedPageMeta = getPageTypeMeta(selectedPageNode?.page_type)
    const matchingPageCount = filteredSecondaryPageNodes.length

    return (
        <div className="min-h-screen bg-slate-50/60">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
                <Card>
                    <CardHeader className="border-b">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div className="space-y-3">
                                <div className="flex flex-wrap items-center gap-3">
                                    <Badge variant="secondary">Public Wiki</Badge>
                                    {activeGraph && viewMode !== 'text' ? (
                                        <>
                                            <Badge variant="outline">nodes {activeGraph.stats.nodes}</Badge>
                                            <Badge variant="outline">edges {activeGraph.stats.edges}</Badge>
                                        </>
                                    ) : null}
                                </div>
                                <div>
                                    <CardTitle className="text-3xl">
                                        {config?.title || activeGraph?.project.title || 'Public Wiki'}
                                    </CardTitle>
                                    <CardDescription className="mt-2 max-w-3xl text-base">
                                        {viewMode === 'text'
                                            ? `${config?.title || activeGraph?.project.title || 'Public Wiki'} · ${pageCount} pages`
                                            : '익명으로 탐색 가능한 wiki graph view입니다. 페이지 수준 연결과 개념/프로세스 수준 연결을 전환해서 볼 수 있습니다.'}
                                    </CardDescription>
                                </div>
                            </div>

                            <div className="flex flex-wrap gap-2">
                                <Button
                                    type="button"
                                    variant={viewMode === 'graph' && graphMode === 'page' ? 'default' : 'outline'}
                                    onClick={() => {
                                        setViewMode('graph')
                                        setGraphMode('page')
                                    }}
                                >
                                    <Network className="mr-2 h-4 w-4" />
                                    Page graph view
                                </Button>
                                <Button
                                    type="button"
                                    variant={viewMode === 'graph' && graphMode === 'node' ? 'default' : 'outline'}
                                    onClick={() => {
                                        setViewMode('graph')
                                        setGraphMode('node')
                                    }}
                                >
                                    <ScanSearch className="mr-2 h-4 w-4" />
                                    Node / edge graph view
                                </Button>
                                <Button
                                    type="button"
                                    variant={viewMode === 'text' ? 'default' : 'outline'}
                                    onClick={() => {
                                        setGraphMode('page')
                                        setViewMode('text')
                                    }}
                                    disabled={!pageCount}
                                >
                                    <BookOpenText className="mr-2 h-4 w-4" />
                                    Text reading
                                </Button>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="pt-6">
                        {viewMode === 'text' ? (
                            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                <span className="font-medium text-foreground">
                                    {config?.title || activeGraph?.project.title || 'Public Wiki'}
                                </span>
                                <ChevronRight className="h-3.5 w-3.5" />
                                <span className="font-medium text-foreground">
                                    {selectedPageNode?.title || selectedPageNode?.slug || 'Wiki Home'}
                                </span>
                                <Badge variant="outline" className="rounded-full">
                                    {selectedPageMeta.label}
                                </Badge>
                            </div>
                        ) : (
                            <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-4">
                                <div className="rounded-lg border bg-background p-4">
                                    <p className="font-medium text-foreground">접근 키</p>
                                    <p className="mt-1 break-all">{slug}</p>
                                </div>
                                <div className="rounded-lg border bg-background p-4">
                                    <p className="font-medium text-foreground">프로젝트</p>
                                    <p className="mt-1">{activeGraph?.project.name || '-'}</p>
                                </div>
                                <div className="rounded-lg border bg-background p-4">
                                    <p className="font-medium text-foreground">현재 모드</p>
                                    <p className="mt-1">
                                        {graphMode === 'page' ? '페이지 간 연결' : '개념/프로세스 연결'}
                                    </p>
                                </div>
                                <div className="rounded-lg border bg-background p-4">
                                    <p className="font-medium text-foreground">포커스</p>
                                    <p className="mt-1">{focusMode ? '선택 항목 중심' : '전체 구조'}</p>
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {errorMessage ? (
                    <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>공개 wiki 그래프를 불러오지 못했습니다</AlertTitle>
                        <AlertDescription>{errorMessage}</AlertDescription>
                    </Alert>
                ) : null}

                {viewMode === 'text' ? (
                    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
                        <Card className="h-fit overflow-hidden border-slate-200/80 lg:sticky lg:top-8">
                            <CardHeader className="border-b bg-[linear-gradient(135deg,rgba(248,250,252,0.98),rgba(255,255,255,0.9))] text-slate-900">
                                <div className="space-y-1">
                                    <CardTitle>{config?.title || 'Public Wiki'}</CardTitle>
                                    <CardDescription className="text-slate-600">
                                        {activeGraph?.project.name || '공개 wiki'} · {pageCount} pages
                                    </CardDescription>
                                </div>
                            </CardHeader>
                            <CardContent className="max-h-[calc(100vh-9rem)] space-y-6 overflow-y-auto pt-6">
                                {homePageNode ? (
                                    <div className="space-y-3">
                                        <div className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                            <Home className="h-3.5 w-3.5" />
                                            Home
                                        </div>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            className={cn(
                                                'h-auto w-full justify-start rounded-2xl border px-4 py-4 text-left shadow-none transition-colors',
                                                homePageNode.id === selectedPageNode?.id
                                                    ? 'border-slate-900 bg-slate-900 text-white hover:bg-slate-900 hover:text-white'
                                                    : 'border-sky-200/80 bg-sky-50/70 text-sky-900 hover:border-sky-300 hover:bg-sky-100 hover:text-sky-950'
                                            )}
                                            onClick={() => setSelectedPageId(homePageNode.id)}
                                        >
                                            <div className="flex w-full items-start gap-3">
                                                <div
                                                    className={cn(
                                                        'mt-0.5 rounded-xl p-2',
                                                        homePageNode.id === selectedPageNode?.id
                                                            ? 'bg-white/15 text-white'
                                                            : 'bg-white text-sky-700 shadow-sm'
                                                    )}
                                                >
                                                    <Home className="h-4 w-4" />
                                                </div>
                                                <div className="min-w-0 space-y-1">
                                                    <div className="font-medium">
                                                        {homePageNode.title || homePageNode.slug}
                                                    </div>
                                                    <div
                                                        className={cn(
                                                            'text-xs',
                                                            homePageNode.id === selectedPageNode?.id
                                                                ? 'text-white/75'
                                                                : 'text-sky-700/80'
                                                        )}
                                                    >
                                                        시작 문서 · {homePageNode.slug}
                                                    </div>
                                                </div>
                                            </div>
                                        </Button>
                                    </div>
                                ) : null}

                                {secondaryPageNodes.length > 0 ? (
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between gap-2 px-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                            <div className="flex items-center gap-2">
                                                <FileText className="h-3.5 w-3.5" />
                                                Library
                                            </div>
                                            <span>{secondaryPageNodes.length} pages</span>
                                        </div>

                                        <div className="rounded-2xl border border-slate-200/80 bg-white/90 p-3 shadow-sm">
                                            <div className="relative">
                                                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                                                <Input
                                                    value={pageSearchQuery}
                                                    onChange={(event) => setPageSearchQuery(event.target.value)}
                                                    placeholder="페이지 제목이나 slug로 찾기"
                                                    className="h-11 rounded-xl border-slate-200 bg-white pl-9 text-sm text-slate-900 placeholder:text-slate-400"
                                                />
                                            </div>
                                            <p className="mt-2 px-1 text-xs text-slate-500">
                                                {normalizedPageSearchQuery
                                                    ? `${matchingPageCount}개의 페이지가 검색되었습니다.`
                                                    : '대규모 wiki에서는 문서 타입별로 접어 보거나 검색으로 바로 이동할 수 있습니다.'}
                                            </p>
                                        </div>

                                        {normalizedPageSearchQuery ? (
                                            matchingPageCount > 0 ? (
                                                <div className="space-y-2">
                                                    {filteredSecondaryPageNodes.map((node) => {
                                                        const pageTypeMeta = getPageTypeMeta(node.page_type)
                                                        const PageTypeIcon = pageTypeMeta.icon

                                                        return (
                                                            <Button
                                                                key={node.id}
                                                                type="button"
                                                                variant="outline"
                                                                className={cn(
                                                                    'h-auto w-full justify-start rounded-2xl border px-4 py-3 text-left shadow-none transition-colors',
                                                                    node.id === selectedPageNode?.id
                                                                        ? 'border-slate-900 bg-slate-900 text-white hover:bg-slate-900 hover:text-white'
                                                                        : 'border-slate-200/80 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900'
                                                                )}
                                                                onClick={() => setSelectedPageId(node.id)}
                                                            >
                                                                <div className="flex w-full items-start gap-3">
                                                                    <div
                                                                        className={cn(
                                                                            'mt-0.5 rounded-xl p-2',
                                                                            node.id === selectedPageNode?.id
                                                                                ? 'bg-white/15 text-white'
                                                                                : 'bg-slate-100 text-slate-700'
                                                                        )}
                                                                    >
                                                                        <PageTypeIcon className="h-4 w-4" />
                                                                    </div>
                                                                    <div className="min-w-0 space-y-1">
                                                                        <div className="font-medium">
                                                                            {node.title || node.slug}
                                                                        </div>
                                                                        <div
                                                                            className={cn(
                                                                                'flex flex-wrap items-center gap-2 text-xs',
                                                                                node.id === selectedPageNode?.id
                                                                                    ? 'text-white/75'
                                                                                    : 'text-slate-500'
                                                                            )}
                                                                        >
                                                                            <span>{node.slug}</span>
                                                                            <span
                                                                                className={cn(
                                                                                    'rounded-full border px-2 py-0.5',
                                                                                    node.id === selectedPageNode?.id
                                                                                        ? 'border-white/20 bg-white/10 text-white'
                                                                                        : 'border-slate-200 bg-slate-50 text-slate-600'
                                                                                )}
                                                                            >
                                                                                {pageTypeMeta.label}
                                                                            </span>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </Button>
                                                        )
                                                    })}
                                                </div>
                                            ) : (
                                                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-6 text-center text-sm text-slate-500">
                                                    검색어와 일치하는 공개 wiki 페이지가 없습니다.
                                                </div>
                                            )
                                        ) : (
                                            <div className="space-y-3">
                                                {groupedSecondaryPageNodes.map((group) => {
                                                    const GroupIcon = group.icon
                                                    const containsSelectedPage = group.nodes.some(
                                                        (node) => node.id === selectedPageNode?.id
                                                    )
                                                    const shouldOpen =
                                                        containsSelectedPage ||
                                                        group.nodes.length <= LARGE_PAGE_GROUP_THRESHOLD

                                                    return (
                                                        <details
                                                            key={group.key}
                                                            open={shouldOpen}
                                                            className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm"
                                                        >
                                                            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-left [&::-webkit-details-marker]:hidden">
                                                                <div className="flex min-w-0 items-center gap-3">
                                                                    <div className="rounded-xl bg-slate-100 p-2 text-slate-700">
                                                                        <GroupIcon className="h-4 w-4" />
                                                                    </div>
                                                                    <div className="min-w-0">
                                                                        <div className="font-medium text-slate-900">
                                                                            {group.label}
                                                                        </div>
                                                                        <div className="text-xs text-slate-500">
                                                                            {group.nodes.length >
                                                                            LARGE_PAGE_GROUP_THRESHOLD
                                                                                ? '기본 접힘 · 큰 컬렉션'
                                                                                : '바로 읽을 수 있는 컬렉션'}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600">
                                                                    {group.nodes.length}
                                                                </span>
                                                            </summary>
                                                            <div className="border-t border-slate-100 px-2 pb-2 pt-1">
                                                                <div className="space-y-2">
                                                                    {group.nodes.map((node) => {
                                                                        const pageTypeMeta = getPageTypeMeta(
                                                                            node.page_type
                                                                        )
                                                                        const PageTypeIcon = pageTypeMeta.icon

                                                                        return (
                                                                            <Button
                                                                                key={node.id}
                                                                                type="button"
                                                                                variant="outline"
                                                                                className={cn(
                                                                                    'h-auto w-full justify-start rounded-2xl border px-4 py-3 text-left shadow-none transition-colors',
                                                                                    node.id === selectedPageNode?.id
                                                                                        ? 'border-slate-900 bg-slate-900 text-white hover:bg-slate-900 hover:text-white'
                                                                                        : 'border-slate-200/80 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900'
                                                                                )}
                                                                                onClick={() =>
                                                                                    setSelectedPageId(node.id)
                                                                                }
                                                                            >
                                                                                <div className="flex w-full items-start gap-3">
                                                                                    <div
                                                                                        className={cn(
                                                                                            'mt-0.5 rounded-xl p-2',
                                                                                            node.id ===
                                                                                                selectedPageNode?.id
                                                                                                ? 'bg-white/15 text-white'
                                                                                                : 'bg-slate-100 text-slate-700'
                                                                                        )}
                                                                                    >
                                                                                        <PageTypeIcon className="h-4 w-4" />
                                                                                    </div>
                                                                                    <div className="min-w-0 space-y-1">
                                                                                        <div className="font-medium">
                                                                                            {node.title || node.slug}
                                                                                        </div>
                                                                                        <div
                                                                                            className={cn(
                                                                                                'flex flex-wrap items-center gap-2 text-xs',
                                                                                                node.id ===
                                                                                                    selectedPageNode?.id
                                                                                                    ? 'text-white/75'
                                                                                                    : 'text-slate-500'
                                                                                            )}
                                                                                        >
                                                                                            <span>{node.slug}</span>
                                                                                            <span
                                                                                                className={cn(
                                                                                                    'rounded-full border px-2 py-0.5',
                                                                                                    node.id ===
                                                                                                        selectedPageNode?.id
                                                                                                        ? 'border-white/20 bg-white/10 text-white'
                                                                                                        : 'border-slate-200 bg-slate-50 text-slate-600'
                                                                                                )}
                                                                                            >
                                                                                                {pageTypeMeta.label}
                                                                                            </span>
                                                                                        </div>
                                                                                    </div>
                                                                                </div>
                                                                            </Button>
                                                                        )
                                                                    })}
                                                                </div>
                                                            </div>
                                                        </details>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </div>
                                ) : null}
                            </CardContent>
                        </Card>

                        <div className="space-y-4">
                            {pageDetailError ? (
                                <Alert variant="destructive">
                                    <AlertCircle className="h-4 w-4" />
                                    <AlertTitle>텍스트를 불러오지 못했습니다</AlertTitle>
                                    <AlertDescription>{pageDetailError}</AlertDescription>
                                </Alert>
                            ) : null}
                            <PublicWikiTextView
                                page={selectedPageDetail}
                                loading={isPageDetailLoading}
                                emptyMessage={
                                    selectedPageNode?.slug
                                        ? `${selectedPageNode.slug} 페이지를 텍스트로 불러오지 못했습니다.`
                                        : '왼쪽에서 읽을 wiki 페이지를 선택해 주세요.'
                                }
                            />
                        </div>
                    </div>
                ) : !activeGraph ? (
                    <Alert>
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>그래프 데이터가 아직 준비되지 않았습니다</AlertTitle>
                        <AlertDescription>잠시 후 다시 시도해 주세요.</AlertDescription>
                    </Alert>
                ) : activeGraph.nodes.length === 0 ? (
                    <Alert>
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>표시할 wiki 그래프가 없습니다</AlertTitle>
                        <AlertDescription>
                            현재 공개된 wiki 항목이 없어 {graphMode === 'page' ? '페이지' : '노드'} 그래프를 렌더링할 수
                            없습니다.
                        </AlertDescription>
                    </Alert>
                ) : (
                    <PublicWikiGraphView
                        graphMode={graphMode}
                        title={graphMode === 'page' ? 'Page graph view' : 'Node / edge graph view'}
                        description={
                            graphMode === 'page'
                                ? 'Wiki page 사이의 링크 구조를 차분한 레이아웃으로 보여주고, 선택한 페이지 중심으로 읽기 쉽게 강조합니다.'
                                : 'Wiki node 와 edge 사이의 관계를 선택 개체 중심으로 재구성해 복잡도를 낮춰 보여줍니다.'
                        }
                        nodes={activeGraph.nodes}
                        edges={activeGraph.edges}
                        selectedNodeId={currentSelectedNodeId}
                        focusMode={focusMode}
                        onToggleFocusMode={() => setFocusMode((current) => !current)}
                        onResetSelection={() => {
                            setFocusMode(false)
                            if (graphMode === 'page') {
                                setSelectedPageId(findDefaultPageNode(activeGraph.nodes)?.id ?? null)
                            } else {
                                setSelectedNodeId(activeGraph.nodes[0]?.id ?? null)
                            }
                        }}
                        onSelectNode={(nodeId) => {
                            if (graphMode === 'page') {
                                setSelectedPageId(nodeId)
                            } else {
                                setSelectedNodeId(nodeId)
                            }
                        }}
                    />
                )}
            </div>
        </div>
    )
}

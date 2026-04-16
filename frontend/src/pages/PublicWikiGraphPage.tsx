import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AlertCircle, BookOpenText, Loader2, Network, ScanSearch } from 'lucide-react'
import { api } from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
    PublicWikiGraphView,
    type PublicWikiGraphEdge,
    type PublicWikiGraphNode,
} from '@/components/PublicWiki/PublicWikiGraphView'
import { PublicWikiTextView, type PublicWikiTextPage } from '@/components/PublicWiki/PublicWikiTextView'

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

export const PublicWikiGraphPage = () => {
    const { slug } = useParams<{ slug: string }>()
    const [isChecking, setIsChecking] = useState(true)
    const [isAvailable, setIsAvailable] = useState(false)
    const [graphMode, setGraphMode] = useState<GraphMode>('page')
    const [viewMode, setViewMode] = useState<ViewMode>('graph')
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
                setSelectedPageId(pageGraphResponse.data.nodes[0]?.id ?? null)
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

    const activeGraph = useMemo(() => (graphMode === 'page' ? pageGraph : nodeGraph), [graphMode, nodeGraph, pageGraph])

    const selectedPageNode = useMemo(
        () => pageGraph?.nodes.find((node) => node.id === selectedPageId) ?? pageGraph?.nodes[0] ?? null,
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

    return (
        <div className="min-h-screen bg-slate-50/60">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
                <Card>
                    <CardHeader className="border-b">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div className="space-y-3">
                                <div className="flex flex-wrap items-center gap-3">
                                    <Badge variant="secondary">Public Wiki</Badge>
                                    {activeGraph ? (
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
                                        익명으로 탐색 가능한 wiki graph view입니다. 페이지 수준 연결과 개념/프로세스
                                        수준 연결을 전환해서 볼 수 있습니다.
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
                                    {viewMode === 'text'
                                        ? '텍스트 열람'
                                        : graphMode === 'page'
                                          ? '페이지 간 연결'
                                          : '개념/프로세스 연결'}
                                </p>
                            </div>
                            <div className="rounded-lg border bg-background p-4">
                                <p className="font-medium text-foreground">포커스</p>
                                <p className="mt-1">{focusMode ? '선택 항목 중심' : '전체 구조'}</p>
                            </div>
                        </div>
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
                        <Card className="h-fit overflow-hidden">
                            <CardHeader className="border-b bg-[linear-gradient(135deg,rgba(248,250,252,0.96),rgba(255,255,255,0.88))]">
                                <CardTitle>공개 wiki 페이지</CardTitle>
                                <CardDescription>
                                    페이지 그래프에서 연결된 문서를 텍스트로 직접 읽을 수 있습니다.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3 pt-6">
                                {pageGraph?.nodes.map((node) => (
                                    <Button
                                        key={node.id}
                                        type="button"
                                        variant={node.id === selectedPageNode?.id ? 'default' : 'outline'}
                                        className="h-auto w-full justify-start whitespace-normal px-4 py-3 text-left"
                                        onClick={() => setSelectedPageId(node.id)}
                                    >
                                        <div>
                                            <div className="font-medium">{node.title || node.slug}</div>
                                            <div className="mt-1 text-xs opacity-80">{node.slug}</div>
                                        </div>
                                    </Button>
                                ))}
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
                                setSelectedPageId(activeGraph.nodes[0]?.id ?? null)
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

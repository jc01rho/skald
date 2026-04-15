import { useEffect, useMemo, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { AlertCircle, Loader2, Network, ScanSearch } from 'lucide-react'
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

type GraphMode = 'page' | 'node'

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

export const PublicWikiGraphPage = () => {
    const { slug } = useParams<{ slug: string }>()
    const [isChecking, setIsChecking] = useState(true)
    const [isAvailable, setIsAvailable] = useState(false)
    const [graphMode, setGraphMode] = useState<GraphMode>('page')
    const [config, setConfig] = useState<PublicWikiConfig | null>(null)
    const [pageGraph, setPageGraph] = useState<PublicWikiGraphResponse | null>(null)
    const [nodeGraph, setNodeGraph] = useState<PublicWikiGraphResponse | null>(null)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

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
            } finally {
                setIsChecking(false)
            }
        }

        loadPublicWiki()
    }, [slug])

    const activeGraph = useMemo(() => {
        return graphMode === 'page' ? pageGraph : nodeGraph
    }, [graphMode, nodeGraph, pageGraph])

    if (!slug) {
        return <Navigate to="/404" replace />
    }

    if (isChecking) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin" />
            </div>
        )
    }

    if (!isAvailable) {
        return <Navigate to="/404" replace />
    }

    const currentSelectedNodeId = graphMode === 'page' ? selectedPageId : selectedNodeId

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
                                    variant={graphMode === 'page' ? 'default' : 'outline'}
                                    onClick={() => setGraphMode('page')}
                                >
                                    <Network className="mr-2 h-4 w-4" />
                                    Page graph view
                                </Button>
                                <Button
                                    type="button"
                                    variant={graphMode === 'node' ? 'default' : 'outline'}
                                    onClick={() => setGraphMode('node')}
                                >
                                    <ScanSearch className="mr-2 h-4 w-4" />
                                    Node / edge graph view
                                </Button>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="pt-6">
                        <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
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
                                <p className="mt-1">{graphMode === 'page' ? '페이지 간 연결' : '개념/프로세스 연결'}</p>
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

                {!activeGraph ? (
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
                                ? 'Wiki page 사이의 링크 구조를 원형 배치로 보여줍니다.'
                                : 'Wiki node 와 edge 사이의 관계를 원형 배치로 보여줍니다.'
                        }
                        nodes={activeGraph.nodes}
                        edges={activeGraph.edges}
                        selectedNodeId={currentSelectedNodeId}
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

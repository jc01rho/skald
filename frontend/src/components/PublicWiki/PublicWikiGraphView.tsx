import { useMemo } from 'react'
import { Focus, Orbit, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

type GraphMode = 'page' | 'node'

export interface PublicWikiGraphNode {
    id: string
    slug?: string
    title?: string
    page_type?: string
    node_type?: string
    canonical_name?: string
    display_name?: string
    confidence: number
    freshness: number
}

export interface PublicWikiGraphEdge {
    id: string
    source: string
    target: string
    link_type?: string
    anchor_text?: string | null
    edge_type?: string
    weight?: number
    provenance_type?: string | null
}

interface PublicWikiGraphViewProps {
    graphMode: GraphMode
    title: string
    description: string
    nodes: PublicWikiGraphNode[]
    edges: PublicWikiGraphEdge[]
    selectedNodeId: string | null
    onSelectNode: (nodeId: string) => void
    focusMode: boolean
    onToggleFocusMode: () => void
    onResetSelection: () => void
}

const CANVAS_WIDTH = 1080
const CANVAS_HEIGHT = 620
const NODE_RADIUS = 26

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const toLabel = (node: PublicWikiGraphNode, graphMode: GraphMode) => {
    if (graphMode === 'page') {
        return node.title || node.slug || 'Untitled page'
    }
    return node.display_name || node.canonical_name || 'Untitled node'
}

const toSecondaryText = (node: PublicWikiGraphNode, graphMode: GraphMode) => {
    if (graphMode === 'page') {
        return node.slug || '페이지 식별자가 없습니다.'
    }
    return node.canonical_name || '정규화 이름이 아직 없습니다.'
}

const getNodeTone = (node: PublicWikiGraphNode, graphMode: GraphMode) => {
    const type = graphMode === 'page' ? node.page_type : node.node_type
    switch (type) {
        case 'index_page':
        case 'process':
            return { fill: '#dbeafe', stroke: '#2563eb' }
        case 'concept_page':
        case 'concept':
            return { fill: '#dcfce7', stroke: '#16a34a' }
        case 'entity_page':
        case 'entity':
            return { fill: '#fef3c7', stroke: '#d97706' }
        default:
            return { fill: '#f3f4f6', stroke: '#6b7280' }
    }
}

const buildNeighborMap = (edges: PublicWikiGraphEdge[]) => {
    const map = new Map<string, Set<string>>()
    for (const edge of edges) {
        if (!map.has(edge.source)) map.set(edge.source, new Set())
        if (!map.has(edge.target)) map.set(edge.target, new Set())
        map.get(edge.source)?.add(edge.target)
        map.get(edge.target)?.add(edge.source)
    }
    return map
}

export const PublicWikiGraphView = ({
    graphMode,
    title,
    description,
    nodes,
    edges,
    selectedNodeId,
    onSelectNode,
    focusMode,
    onToggleFocusMode,
    onResetSelection,
}: PublicWikiGraphViewProps) => {
    const neighborMap = useMemo(() => buildNeighborMap(edges), [edges])

    const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0] ?? null
    const selectedNeighborhood = useMemo(
        () =>
            selectedNode ? new Set([selectedNode.id, ...(neighborMap.get(selectedNode.id) || [])]) : new Set<string>(),
        [neighborMap, selectedNode]
    )

    const graphLayout = useMemo(() => {
        if (nodes.length === 0) {
            return {
                positionedNodes: [],
                positionedEdges: [] as Array<PublicWikiGraphEdge & { x1: number; y1: number; x2: number; y2: number }>,
            }
        }

        const centerX = CANVAS_WIDTH / 2
        const centerY = CANVAS_HEIGHT / 2
        const outerRadius = Math.min(246 + Math.min(nodes.length, 18) * 6, 286)
        const innerRadius = 144

        const arrangedNodes =
            focusMode && selectedNode
                ? [
                      ...nodes.filter((node) => node.id === selectedNode.id),
                      ...nodes.filter((node) => node.id !== selectedNode.id && selectedNeighborhood.has(node.id)),
                      ...nodes.filter((node) => node.id !== selectedNode.id && !selectedNeighborhood.has(node.id)),
                  ]
                : nodes

        const positionedNodes = arrangedNodes.map((node, index) => {
            const isCenter = selectedNode ? node.id === selectedNode.id : false
            const isNeighborhood = selectedNode ? selectedNeighborhood.has(node.id) : false
            const peerNodes =
                focusMode && selectedNode
                    ? arrangedNodes.filter(
                          (candidate) =>
                              candidate.id !== selectedNode.id &&
                              selectedNeighborhood.has(candidate.id) === isNeighborhood
                      )
                    : arrangedNodes
            const ringIndex =
                focusMode && selectedNode
                    ? Math.max(
                          peerNodes.findIndex((candidate) => candidate.id === node.id),
                          0
                      )
                    : index
            const ringLength = focusMode && selectedNode ? Math.max(peerNodes.length, 1) : arrangedNodes.length
            const angle = isCenter ? 0 : (Math.PI * 2 * ringIndex) / ringLength - Math.PI / 2
            const radius = isCenter
                ? 0
                : focusMode && selectedNode
                  ? isNeighborhood
                      ? innerRadius
                      : outerRadius
                  : outerRadius

            const x = isCenter ? centerX : clamp(centerX + radius * Math.cos(angle), 96, CANVAS_WIDTH - 96)
            const y = isCenter ? centerY : clamp(centerY + radius * Math.sin(angle), 96, CANVAS_HEIGHT - 96)

            return { ...node, x, y }
        })

        const lookup = new Map(positionedNodes.map((node) => [node.id, node]))
        const positionedEdges = edges
            .map((edge) => {
                const source = lookup.get(edge.source)
                const target = lookup.get(edge.target)
                if (!source || !target) {
                    return null
                }
                return {
                    ...edge,
                    x1: source.x,
                    y1: source.y,
                    x2: target.x,
                    y2: target.y,
                }
            })
            .filter(
                (edge): edge is PublicWikiGraphEdge & { x1: number; y1: number; x2: number; y2: number } =>
                    edge !== null
            )

        return { positionedNodes, positionedEdges }
    }, [edges, focusMode, nodes, selectedNeighborhood, selectedNode])

    const relatedNodes = selectedNode
        ? nodes.filter((node) => selectedNeighborhood.has(node.id) && node.id !== selectedNode.id).slice(0, 8)
        : []

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Card className="overflow-hidden border-slate-200/80 shadow-sm">
                <CardHeader className="border-b bg-[linear-gradient(135deg,rgba(248,250,252,0.96),rgba(255,255,255,0.9))]">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                        <div>
                            <div className="mb-3 flex flex-wrap items-center gap-2">
                                <Badge variant="secondary" className="bg-slate-900 text-slate-50">
                                    <Sparkles className="mr-1 h-3 w-3" />
                                    Curated graph view
                                </Badge>
                                <Badge variant="outline">{nodes.length} nodes</Badge>
                                <Badge variant="outline">{edges.length} edges</Badge>
                            </div>
                            <CardTitle>{title}</CardTitle>
                            <CardDescription className="mt-2 max-w-2xl">{description}</CardDescription>
                        </div>

                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="button"
                                variant={focusMode ? 'default' : 'outline'}
                                onClick={onToggleFocusMode}
                            >
                                <Focus className="mr-2 h-4 w-4" />
                                {focusMode ? 'Focused view on' : 'Focused view off'}
                            </Button>
                            <Button type="button" variant="ghost" onClick={onResetSelection}>
                                <Orbit className="mr-2 h-4 w-4" />
                                Reset selection
                            </Button>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="overflow-x-auto p-0">
                    <div className="min-w-[960px] bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.12),_transparent_45%),linear-gradient(180deg,rgba(248,250,252,0.92),rgba(255,255,255,1))] p-4">
                        <svg
                            viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
                            className="h-[620px] w-full rounded-[28px] border border-slate-200/80 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.08)]"
                        >
                            <defs>
                                <marker
                                    id={`arrow-${graphMode}`}
                                    markerWidth="8"
                                    markerHeight="8"
                                    refX="6"
                                    refY="3"
                                    orient="auto"
                                >
                                    <path d="M0,0 L0,6 L6,3 z" fill="#94a3b8" opacity="0.72" />
                                </marker>
                            </defs>

                            <circle cx={CANVAS_WIDTH / 2} cy={CANVAS_HEIGHT / 2} r="212" fill="rgba(59,130,246,0.04)" />

                            {graphLayout.positionedEdges.map((edge) => {
                                const isRelevant =
                                    !selectedNode ||
                                    edge.source === selectedNode.id ||
                                    edge.target === selectedNode.id ||
                                    (focusMode &&
                                        selectedNeighborhood.has(edge.source) &&
                                        selectedNeighborhood.has(edge.target))
                                return (
                                    <g key={edge.id}>
                                        <line
                                            x1={edge.x1}
                                            y1={edge.y1}
                                            x2={edge.x2}
                                            y2={edge.y2}
                                            stroke={isRelevant ? '#64748b' : '#cbd5e1'}
                                            strokeWidth={Math.max(
                                                isRelevant ? 1.8 : 1,
                                                (edge.weight ?? 1) * (isRelevant ? 1 : 0.65)
                                            )}
                                            strokeOpacity={isRelevant ? 0.88 : 0.24}
                                            markerEnd={`url(#arrow-${graphMode})`}
                                        />
                                        <text
                                            x={(edge.x1 + edge.x2) / 2}
                                            y={(edge.y1 + edge.y2) / 2 - 6}
                                            textAnchor="middle"
                                            className="fill-slate-400 text-[11px]"
                                            opacity={focusMode && !isRelevant ? 0.28 : 0.72}
                                        >
                                            {edge.link_type || edge.edge_type || 'linked'}
                                        </text>
                                    </g>
                                )
                            })}

                            {graphLayout.positionedNodes.map((node) => {
                                const tone = getNodeTone(node, graphMode)
                                const isSelected = node.id === selectedNode?.id
                                const isRelated = selectedNeighborhood.has(node.id)
                                const isDimmed = focusMode && selectedNode && !isRelated
                                const label = toLabel(node, graphMode)
                                const shortLabel = label.length > 22 ? `${label.slice(0, 22)}…` : label

                                return (
                                    <g
                                        key={node.id}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => onSelectNode(node.id)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault()
                                                onSelectNode(node.id)
                                            }
                                        }}
                                        className="cursor-pointer outline-none"
                                    >
                                        <circle
                                            cx={node.x}
                                            cy={node.y}
                                            r={
                                                isSelected
                                                    ? NODE_RADIUS + 10
                                                    : isRelated
                                                      ? NODE_RADIUS + 2
                                                      : NODE_RADIUS
                                            }
                                            fill={tone.fill}
                                            stroke={isSelected ? '#0f172a' : tone.stroke}
                                            strokeWidth={isSelected ? 3 : 2}
                                            opacity={isDimmed ? 0.22 : isRelated ? 1 : 0.82}
                                        />
                                        {isSelected ? (
                                            <circle
                                                cx={node.x}
                                                cy={node.y}
                                                r={NODE_RADIUS + 18}
                                                fill="none"
                                                stroke={tone.stroke}
                                                strokeOpacity={0.22}
                                                strokeWidth={8}
                                            />
                                        ) : null}
                                        <text
                                            x={node.x}
                                            y={node.y + NODE_RADIUS + 18}
                                            textAnchor="middle"
                                            className="fill-slate-700 text-[12px] font-medium"
                                            opacity={isDimmed ? 0.3 : 1}
                                        >
                                            {shortLabel}
                                        </text>
                                    </g>
                                )
                            })}
                        </svg>
                    </div>
                </CardContent>
            </Card>

            <Card className="h-fit border-slate-200/80 shadow-sm">
                <CardHeader className="border-b">
                    <CardTitle>선택한 {graphMode === 'page' ? '페이지' : '노드'} 상세</CardTitle>
                    <CardDescription>
                        그래프에서 항목을 클릭하면 공개 가능한 최소 메타데이터와 직접 연결된 이웃을 볼 수 있습니다.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 pt-6">
                    {selectedNode ? (
                        <>
                            <div className="space-y-2">
                                <div className="flex flex-wrap gap-2">
                                    <Badge variant="secondary">confidence {selectedNode.confidence.toFixed(2)}</Badge>
                                    <Badge variant="outline">freshness {selectedNode.freshness.toFixed(2)}</Badge>
                                    <Badge variant="outline">
                                        {graphMode === 'page'
                                            ? selectedNode.page_type || 'page'
                                            : selectedNode.node_type || 'node'}
                                    </Badge>
                                    {focusMode ? <Badge variant="secondary">focused</Badge> : null}
                                </div>
                                <div>
                                    <h3 className="text-lg font-semibold">{toLabel(selectedNode, graphMode)}</h3>
                                    <p className="mt-2 text-sm text-muted-foreground">
                                        {toSecondaryText(selectedNode, graphMode)}
                                    </p>
                                </div>
                            </div>

                            {graphMode === 'page' ? (
                                <div className="space-y-3 rounded-lg border bg-muted/20 p-4 text-sm">
                                    <div>
                                        <span className="font-medium">Slug</span>
                                        <p className="text-muted-foreground">{selectedNode.slug || '-'}</p>
                                    </div>
                                    <div>
                                        <span className="font-medium">페이지 유형</span>
                                        <p className="text-muted-foreground">{selectedNode.page_type || '-'}</p>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-3 rounded-lg border bg-muted/20 p-4 text-sm">
                                    <div>
                                        <span className="font-medium">Canonical name</span>
                                        <p className="text-muted-foreground">{selectedNode.canonical_name || '-'}</p>
                                    </div>
                                    <div>
                                        <span className="font-medium">노드 유형</span>
                                        <p className="text-muted-foreground">{selectedNode.node_type || '-'}</p>
                                    </div>
                                </div>
                            )}

                            <div className="rounded-lg border bg-slate-50 p-4 text-sm">
                                <p className="font-medium text-slate-900">현재 포커스</p>
                                <p className="mt-1 text-slate-600">
                                    {focusMode
                                        ? '선택한 항목과 바로 연결된 이웃만 강조합니다. 나머지는 흐리게 보여 관계를 한 눈에 읽기 쉽게 만듭니다.'
                                        : '전체 구조를 보여주는 기본 보기입니다. Focused view를 켜면 선택 항목 중심으로 재구성됩니다.'}
                                </p>
                            </div>

                            {relatedNodes.length > 0 ? (
                                <div className="space-y-3 rounded-lg border bg-muted/20 p-4 text-sm">
                                    <div>
                                        <span className="font-medium">직접 연결된 이웃</span>
                                        <p className="text-muted-foreground">
                                            선택 항목과 1-hop 관계를 가진 항목입니다.
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {relatedNodes.map((node) => (
                                            <Button
                                                key={node.id}
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                onClick={() => onSelectNode(node.id)}
                                            >
                                                {toLabel(node, graphMode)}
                                            </Button>
                                        ))}
                                    </div>
                                </div>
                            ) : null}

                            <div className="grid gap-2 sm:grid-cols-2">
                                {nodes.slice(0, 6).map((node) => (
                                    <Button
                                        key={node.id}
                                        type="button"
                                        variant={node.id === selectedNode.id ? 'default' : 'outline'}
                                        className={cn(
                                            'justify-start overflow-hidden text-left',
                                            node.id === selectedNode.id ? 'shadow-sm' : undefined
                                        )}
                                        onClick={() => onSelectNode(node.id)}
                                    >
                                        <span className="truncate">{toLabel(node, graphMode)}</span>
                                    </Button>
                                ))}
                            </div>
                        </>
                    ) : (
                        <p className="text-sm text-muted-foreground">선택 가능한 항목이 없습니다.</p>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

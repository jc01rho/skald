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

type PositionedGraphNode = PublicWikiGraphNode & { x: number; y: number; clusterKey: string }
type PositionedGraphEdge = PublicWikiGraphEdge & { x1: number; y1: number; x2: number; y2: number }

interface ClusterRegion {
    key: string
    label: string
    count: number
    x: number
    y: number
    rx: number
    ry: number
    fill: string
    stroke: string
}

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
            return { fill: '#fff7ed', stroke: '#c2410c' }
        case 'concept_page':
        case 'concept':
            return { fill: '#ecfdf5', stroke: '#047857' }
        case 'entity_page':
        case 'entity':
            return { fill: '#fefce8', stroke: '#a16207' }
        default:
            return { fill: '#f5f5f4', stroke: '#57534e' }
    }
}

const getClusterKey = (node: PublicWikiGraphNode, graphMode: GraphMode) =>
    graphMode === 'page' ? node.page_type || 'page' : node.node_type || 'node'

const getClusterLabel = (clusterKey: string, graphMode: GraphMode) => {
    if (graphMode === 'page') {
        switch (clusterKey) {
            case 'index_page':
                return 'Home'
            case 'concept_page':
                return 'Concepts'
            case 'process_page':
                return 'Processes'
            case 'entity_page':
                return 'Entities'
            case 'faq_page':
                return 'FAQ'
            case 'synthesis_page':
                return 'Synthesis'
            case 'comparison_page':
                return 'Comparisons'
            case 'policy_page':
                return 'Policies'
            case 'source_digest_page':
                return 'Source digests'
            default:
                return 'Pages'
        }
    }

    switch (clusterKey) {
        case 'process':
            return 'Processes'
        case 'concept':
            return 'Concepts'
        case 'entity':
            return 'Entities'
        case 'artifact':
            return 'Artifacts'
        case 'event':
            return 'Events'
        case 'metric':
            return 'Metrics'
        case 'policy':
            return 'Policies'
        default:
            return 'Nodes'
    }
}

const getClusterTone = (clusterKey: string) => {
    switch (clusterKey) {
        case 'index_page':
        case 'process_page':
        case 'process':
            return { fill: 'rgba(251,146,60,0.13)', stroke: 'rgba(194,65,12,0.28)' }
        case 'concept_page':
        case 'concept':
            return { fill: 'rgba(16,185,129,0.12)', stroke: 'rgba(4,120,87,0.26)' }
        case 'entity_page':
        case 'entity':
        case 'artifact':
            return { fill: 'rgba(245,158,11,0.12)', stroke: 'rgba(161,98,7,0.26)' }
        case 'source_digest_page':
        case 'event':
            return { fill: 'rgba(20,184,166,0.1)', stroke: 'rgba(15,118,110,0.24)' }
        default:
            return { fill: 'rgba(120,113,108,0.1)', stroke: 'rgba(87,83,78,0.22)' }
    }
}

const getClusterSortWeight = (clusterKey: string) => {
    const order = [
        'index_page',
        'concept_page',
        'concept',
        'process_page',
        'process',
        'entity_page',
        'entity',
        'artifact',
        'event',
        'faq_page',
        'comparison_page',
        'source_digest_page',
    ]
    const index = order.indexOf(clusterKey)
    return index === -1 ? order.length : index
}

const getClusterCenter = (index: number, total: number, focusMode: boolean) => {
    if (focusMode) {
        const radiusX = 310
        const radiusY = 190
        const angle = (Math.PI * 2 * index) / Math.max(total, 1) - Math.PI / 2
        return {
            x: CANVAS_WIDTH / 2 + radiusX * Math.cos(angle),
            y: CANVAS_HEIGHT / 2 + radiusY * Math.sin(angle),
        }
    }

    const columns = Math.min(3, Math.max(1, total))
    const rows = Math.ceil(total / columns)
    const column = index % columns
    const row = Math.floor(index / columns)
    return {
        x: ((column + 1) * CANVAS_WIDTH) / (columns + 1),
        y: ((row + 1) * CANVAS_HEIGHT) / (rows + 1),
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
                positionedNodes: [] as PositionedGraphNode[],
                positionedEdges: [] as PositionedGraphEdge[],
                clusters: [] as ClusterRegion[],
            }
        }

        const centerX = CANVAS_WIDTH / 2
        const centerY = CANVAS_HEIGHT / 2
        const nodesByCluster = new Map<string, PublicWikiGraphNode[]>()
        for (const node of nodes) {
            const clusterKey = getClusterKey(node, graphMode)
            nodesByCluster.set(clusterKey, [...(nodesByCluster.get(clusterKey) ?? []), node])
        }

        const clusterEntries = [...nodesByCluster.entries()].sort(
            ([leftKey, leftNodes], [rightKey, rightNodes]) =>
                getClusterSortWeight(leftKey) - getClusterSortWeight(rightKey) || rightNodes.length - leftNodes.length
        )

        const clusters = clusterEntries.map(([clusterKey, clusterNodes], index): ClusterRegion => {
            const center = getClusterCenter(index, clusterEntries.length, focusMode)
            const tone = getClusterTone(clusterKey)
            const sizeBoost = Math.min(clusterNodes.length, 42)
            return {
                key: clusterKey,
                label: getClusterLabel(clusterKey, graphMode),
                count: clusterNodes.length,
                x: clamp(center.x, 160, CANVAS_WIDTH - 160),
                y: clamp(center.y, 128, CANVAS_HEIGHT - 128),
                rx: clamp(104 + sizeBoost * 2.4, 116, 188),
                ry: clamp(76 + sizeBoost * 1.7, 88, 148),
                fill: tone.fill,
                stroke: tone.stroke,
            }
        })
        const clusterByKey = new Map(clusters.map((cluster) => [cluster.key, cluster]))

        const positionedNodes = nodes.map((node): PositionedGraphNode => {
            const clusterKey = getClusterKey(node, graphMode)
            const cluster = clusterByKey.get(clusterKey) ?? clusters[0]
            const clusterNodes = [...(clusterEntries.find(([entryKey]) => entryKey === clusterKey)?.[1] ?? nodes)].sort(
                (left, right) => (neighborMap.get(right.id)?.size ?? 0) - (neighborMap.get(left.id)?.size ?? 0)
            )
            const clusterIndex = Math.max(
                clusterNodes.findIndex((candidate) => candidate.id === node.id),
                0
            )
            const isCenter = focusMode && selectedNode ? node.id === selectedNode.id : false
            const isNeighborhood = selectedNode ? selectedNeighborhood.has(node.id) : false
            const totalInCluster = Math.max(clusterNodes.length, 1)
            const angle = (Math.PI * 2 * clusterIndex) / totalInCluster - Math.PI / 2
            const spiralOffset = Math.sqrt(clusterIndex / totalInCluster)
            const radiusFactor = clamp(0.28 + spiralOffset * 0.62, 0.28, 0.9)
            const radiusX = Math.max(24, (cluster.rx - NODE_RADIUS - 24) * radiusFactor)
            const radiusY = Math.max(20, (cluster.ry - NODE_RADIUS - 18) * radiusFactor)
            const baseX = isCenter ? centerX : cluster.x + radiusX * Math.cos(angle)
            const baseY = isCenter ? centerY : cluster.y + radiusY * Math.sin(angle)
            const pullToCenter = focusMode && selectedNode && isNeighborhood && !isCenter ? 0.18 : 0
            const x = clamp(baseX * (1 - pullToCenter) + centerX * pullToCenter, 76, CANVAS_WIDTH - 76)
            const y = clamp(baseY * (1 - pullToCenter) + centerY * pullToCenter, 76, CANVAS_HEIGHT - 76)

            return { ...node, x, y, clusterKey }
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

        return { positionedNodes, positionedEdges, clusters }
    }, [edges, focusMode, graphMode, neighborMap, nodes, selectedNeighborhood, selectedNode])

    const relatedNodes = selectedNode
        ? nodes.filter((node) => selectedNeighborhood.has(node.id) && node.id !== selectedNode.id).slice(0, 8)
        : []

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Card className="overflow-hidden border-teal-200/70 bg-white/86 shadow-[0_24px_90px_rgba(15,118,110,0.13)] backdrop-blur">
                <CardHeader className="border-b border-teal-100 bg-[linear-gradient(135deg,rgba(204,251,241,0.55),rgba(255,247,237,0.9))]">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                        <div>
                            <div className="mb-3 flex flex-wrap items-center gap-2">
                                <Badge className="border border-teal-200 bg-teal-700 text-teal-50 hover:bg-teal-700">
                                    <Sparkles className="mr-1 h-3 w-3" />
                                    Curated graph view
                                </Badge>
                                <Badge variant="outline" className="border-teal-200 bg-white/70 text-teal-800">
                                    {nodes.length} nodes
                                </Badge>
                                <Badge variant="outline" className="border-amber-200 bg-white/70 text-amber-800">
                                    {edges.length} edges
                                </Badge>
                            </div>
                            <CardTitle className="text-teal-950">{title}</CardTitle>
                            <CardDescription className="mt-2 max-w-2xl text-teal-900/70">{description}</CardDescription>
                        </div>

                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="button"
                                variant={focusMode ? 'default' : 'outline'}
                                className={cn(
                                    focusMode
                                        ? 'bg-teal-700 text-white hover:bg-teal-800'
                                        : 'border-teal-200 bg-white/70 text-teal-800 hover:bg-teal-50 hover:text-teal-950'
                                )}
                                onClick={onToggleFocusMode}
                            >
                                <Focus className="mr-2 h-4 w-4" />
                                {focusMode ? 'Focused view on' : 'Focused view off'}
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                className="text-amber-800 hover:bg-amber-50 hover:text-amber-950"
                                onClick={onResetSelection}
                            >
                                <Orbit className="mr-2 h-4 w-4" />
                                Reset selection
                            </Button>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="overflow-x-auto p-0">
                    <div className="min-w-[960px] bg-[radial-gradient(circle_at_20%_8%,rgba(20,184,166,0.18),transparent_34%),radial-gradient(circle_at_82%_12%,rgba(245,158,11,0.18),transparent_30%),linear-gradient(180deg,rgba(255,247,237,0.96),rgba(240,253,250,0.92))] p-4">
                        <svg
                            viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
                            className="h-[620px] w-full rounded-[28px] border border-teal-200/70 bg-[#fffaf0] shadow-[0_24px_80px_rgba(15,118,110,0.12)]"
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
                                    <path d="M0,0 L0,6 L6,3 z" fill="#0f766e" opacity="0.56" />
                                </marker>
                            </defs>

                            <circle cx={CANVAS_WIDTH / 2} cy={CANVAS_HEIGHT / 2} r="96" fill="rgba(15,118,110,0.055)" />

                            {graphLayout.clusters.map((cluster) => {
                                const isSelectedCluster = selectedNode
                                    ? getClusterKey(selectedNode, graphMode) === cluster.key
                                    : false
                                return (
                                    <g key={cluster.key}>
                                        <ellipse
                                            cx={cluster.x}
                                            cy={cluster.y}
                                            rx={cluster.rx}
                                            ry={cluster.ry}
                                            fill={cluster.fill}
                                            stroke={isSelectedCluster ? 'rgba(15,118,110,0.52)' : cluster.stroke}
                                            strokeWidth={isSelectedCluster ? 3 : 1.5}
                                            strokeDasharray={undefined}
                                        />
                                        <text
                                            x={cluster.x - cluster.rx + 18}
                                            y={cluster.y - cluster.ry + 28}
                                            className="fill-teal-900 text-[13px] font-semibold"
                                        >
                                            {cluster.label}
                                        </text>
                                        <text
                                            x={cluster.x - cluster.rx + 18}
                                            y={cluster.y - cluster.ry + 46}
                                            className="fill-teal-700 text-[11px]"
                                        >
                                            {cluster.count} items
                                        </text>
                                    </g>
                                )
                            })}

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
                                            stroke={isRelevant ? '#0f766e' : '#99f6e4'}
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
                                            className="fill-teal-600 text-[11px]"
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
                                            stroke={isSelected ? '#134e4a' : tone.stroke}
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
                                            className="fill-teal-950 text-[12px] font-medium"
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

            <Card className="h-fit border-amber-200/70 bg-white/88 shadow-[0_20px_70px_rgba(146,64,14,0.1)] backdrop-blur">
                <CardHeader className="border-b border-amber-100 bg-[linear-gradient(135deg,rgba(255,251,235,0.92),rgba(240,253,250,0.72))]">
                    <CardTitle className="text-teal-950">
                        선택한 {graphMode === 'page' ? '페이지' : '노드'} 상세
                    </CardTitle>
                    <CardDescription className="text-teal-900/70">
                        그래프에서 항목을 클릭하면 공개 가능한 최소 메타데이터와 직접 연결된 이웃을 볼 수 있습니다.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 pt-6">
                    {selectedNode ? (
                        <>
                            <div className="space-y-2">
                                <div className="flex flex-wrap gap-2">
                                    <Badge className="bg-teal-700 text-white hover:bg-teal-700">
                                        confidence {selectedNode.confidence.toFixed(2)}
                                    </Badge>
                                    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800">
                                        freshness {selectedNode.freshness.toFixed(2)}
                                    </Badge>
                                    <Badge variant="outline" className="border-teal-200 bg-teal-50 text-teal-800">
                                        {graphMode === 'page'
                                            ? selectedNode.page_type || 'page'
                                            : selectedNode.node_type || 'node'}
                                    </Badge>
                                    {focusMode ? (
                                        <Badge className="bg-amber-600 text-white hover:bg-amber-600">focused</Badge>
                                    ) : null}
                                </div>
                                <div>
                                    <h3 className="text-lg font-semibold text-teal-950">
                                        {toLabel(selectedNode, graphMode)}
                                    </h3>
                                    <p className="mt-2 text-sm text-teal-800/70">
                                        {toSecondaryText(selectedNode, graphMode)}
                                    </p>
                                </div>
                            </div>

                            {graphMode === 'page' ? (
                                <div className="space-y-3 rounded-2xl border border-teal-100 bg-teal-50/55 p-4 text-sm">
                                    <div>
                                        <span className="font-medium text-teal-950">Slug</span>
                                        <p className="text-teal-800/70">{selectedNode.slug || '-'}</p>
                                    </div>
                                    <div>
                                        <span className="font-medium text-teal-950">페이지 유형</span>
                                        <p className="text-teal-800/70">{selectedNode.page_type || '-'}</p>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-3 rounded-2xl border border-teal-100 bg-teal-50/55 p-4 text-sm">
                                    <div>
                                        <span className="font-medium text-teal-950">Canonical name</span>
                                        <p className="text-teal-800/70">{selectedNode.canonical_name || '-'}</p>
                                    </div>
                                    <div>
                                        <span className="font-medium text-teal-950">노드 유형</span>
                                        <p className="text-teal-800/70">{selectedNode.node_type || '-'}</p>
                                    </div>
                                </div>
                            )}

                            <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 text-sm">
                                <p className="font-medium text-amber-950">현재 포커스</p>
                                <p className="mt-1 text-amber-800/80">
                                    {focusMode
                                        ? '선택한 항목과 바로 연결된 이웃만 강조합니다. 나머지는 흐리게 보여 관계를 한 눈에 읽기 쉽게 만듭니다.'
                                        : '전체 구조를 보여주는 기본 보기입니다. Focused view를 켜면 선택 항목 중심으로 재구성됩니다.'}
                                </p>
                            </div>

                            {relatedNodes.length > 0 ? (
                                <div className="space-y-3 rounded-2xl border border-teal-100 bg-white/72 p-4 text-sm">
                                    <div>
                                        <span className="font-medium text-teal-950">직접 연결된 이웃</span>
                                        <p className="text-teal-800/70">선택 항목과 1-hop 관계를 가진 항목입니다.</p>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {relatedNodes.map((node) => (
                                            <Button
                                                key={node.id}
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100 hover:text-teal-950"
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
                                            node.id === selectedNode.id
                                                ? 'bg-teal-700 text-white shadow-sm hover:bg-teal-800'
                                                : 'border-teal-100 bg-white/75 text-teal-800 hover:bg-teal-50 hover:text-teal-950'
                                        )}
                                        onClick={() => onSelectNode(node.id)}
                                    >
                                        <span className="truncate">{toLabel(node, graphMode)}</span>
                                    </Button>
                                ))}
                            </div>
                        </>
                    ) : (
                        <p className="text-sm text-teal-800/70">선택 가능한 항목이 없습니다.</p>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

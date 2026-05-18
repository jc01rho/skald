import { useEffect, useMemo, useRef, useState } from 'react'
import { Focus, Orbit, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { MultiGraph } from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import Sigma from 'sigma'

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

const appendGroupedNode = (map: Map<string, PublicWikiGraphNode[]>, key: string, node: PublicWikiGraphNode) => {
    const group = map.get(key)
    if (group) {
        group.push(node)
        return
    }
    map.set(key, [node])
}

const LARGE_GRAPH_LAYOUT_THRESHOLD = 2000
const CLUSTER_SPREAD_MULTIPLIER = 2.2
const NODE_SPREAD_MULTIPLIER = 2.5

const getSeededPosition = (index: number, total: number, clusterIndex: number, clusterTotal: number) => {
    const clusterAngle = (Math.PI * 2 * clusterIndex) / Math.max(clusterTotal, 1) - Math.PI / 2
    const clusterRadius = 140 + Math.min(total, 6000) * 0.045 * CLUSTER_SPREAD_MULTIPLIER
    const localAngle = (Math.PI * (3 - Math.sqrt(5)) * index) % (Math.PI * 2)
    const localSpread =
        total > LARGE_GRAPH_LAYOUT_THRESHOLD
            ? 72 + Math.sqrt(total) * 2.2 * NODE_SPREAD_MULTIPLIER
            : 32 * NODE_SPREAD_MULTIPLIER
    const localRadius = Math.sqrt((index + 1) / Math.max(total, 1)) * localSpread

    return {
        x: Math.cos(clusterAngle) * clusterRadius + Math.cos(localAngle) * localRadius,
        y: Math.sin(clusterAngle) * clusterRadius + Math.sin(localAngle) * localRadius,
    }
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
    const containerRef = useRef<HTMLDivElement>(null)
    const sigmaRef = useRef<Sigma | null>(null)
    const onSelectNodeRef = useRef(onSelectNode)
    const onResetSelectionRef = useRef(onResetSelection)
    const [hoveredNode, setHoveredNode] = useState<string | null>(null)

    useEffect(() => {
        onSelectNodeRef.current = onSelectNode
        onResetSelectionRef.current = onResetSelection
    }, [onSelectNode, onResetSelection])

    const neighborMap = useMemo(() => buildNeighborMap(edges), [edges])

    const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0] ?? null
    const selectedNeighborhood = useMemo(
        () =>
            selectedNode ? new Set([selectedNode.id, ...(neighborMap.get(selectedNode.id) || [])]) : new Set<string>(),
        [neighborMap, selectedNode]
    )
    const hoveredNeighborhood = useMemo(
        () => (hoveredNode ? new Set([hoveredNode, ...(neighborMap.get(hoveredNode) || [])]) : new Set<string>()),
        [neighborMap, hoveredNode]
    )

    useEffect(() => {
        if (!containerRef.current) return

        const graph = new MultiGraph()
        const groupedNodes = new Map<string, PublicWikiGraphNode[]>()
        for (const node of nodes) {
            const clusterKey = getClusterKey(node, graphMode)
            appendGroupedNode(groupedNodes, clusterKey, node)
        }
        const orderedClusters = [...groupedNodes.entries()].sort(
            ([leftKey, leftNodes], [rightKey, rightNodes]) =>
                getClusterSortWeight(leftKey) - getClusterSortWeight(rightKey) || rightNodes.length - leftNodes.length
        )
        const clusterIndexByKey = new Map(orderedClusters.map(([clusterKey], index) => [clusterKey, index]))
        const nodeIndexById = new Map(
            orderedClusters.flatMap(([clusterKey, clusterNodes]) =>
                clusterNodes.map((node, index) => [node.id, { index, total: clusterNodes.length, clusterKey }] as const)
            )
        )

        nodes.forEach((node) => {
            const tone = getNodeTone(node, graphMode)
            const label = toLabel(node, graphMode)
            const degree = neighborMap.get(node.id)?.size || 0
            const clusterInfo = nodeIndexById.get(node.id)
            const clusterIndex = clusterIndexByKey.get(clusterInfo?.clusterKey ?? getClusterKey(node, graphMode)) ?? 0
            const position = getSeededPosition(
                clusterInfo?.index ?? 0,
                clusterInfo?.total ?? nodes.length,
                clusterIndex,
                orderedClusters.length
            )

            graph.addNode(node.id, {
                x: position.x,
                y: position.y,
                size: Math.max(3, Math.min(8, 3 + Math.sqrt(Math.min(degree, 20)) * 1.2)),
                label,
                color: tone.stroke,
            })
        })
        edges.forEach((edge, index) => {
            if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
                const edgeKey = `${edge.id || `${edge.source}->${edge.target}`}-${index}`
                graph.addEdgeWithKey(edgeKey, edge.source, edge.target, {
                    size: Math.max(1.2, (edge.weight || 1) * 0.55),
                    color: '#0f766e',
                    type: 'arrow',
                })
            }
        })

        if (nodes.length > 0 && nodes.length <= LARGE_GRAPH_LAYOUT_THRESHOLD) {
            const settings = forceAtlas2.inferSettings(graph)
            forceAtlas2.assign(graph, {
                iterations: 200,
                settings: {
                    ...settings,
                    gravity: 0.15,
                    scalingRatio: 15,
                    slowDown: 10,
                    barnesHutOptimize: true,
                    barnesHutTheta: 0.6,
                },
            })
        }
        const sigma = new Sigma(graph, containerRef.current, {
            renderLabels: true,
            renderEdgeLabels: false,
            labelDensity: 1.2,
            labelGridCellSize: 80,
            labelRenderedSizeThreshold: 8,
            zIndex: true,
            allowInvalidContainer: true,
        })
        sigmaRef.current = sigma

        sigma.on('enterNode', (e) => setHoveredNode(e.node))
        sigma.on('leaveNode', () => setHoveredNode(null))
        sigma.on('clickNode', (e) => onSelectNodeRef.current(e.node))
        sigma.on('clickStage', () => onResetSelectionRef.current())

        return () => {
            sigma.kill()
            sigmaRef.current = null
        }
    }, [nodes, edges, graphMode, neighborMap])

    useEffect(() => {
        const sigma = sigmaRef.current
        if (!sigma) return

        sigma.setSetting('nodeReducer', (node, data) => {
            const res = { ...data }

            const isSelected = selectedNodeId === node
            const isHovered = hoveredNode === node
            const inSelectedNeighborhood = selectedNeighborhood.has(node)
            const inHoveredNeighborhood = hoveredNeighborhood.has(node)

            const degree = neighborMap.get(node)?.size || 0

            if (isHovered || isSelected) {
                res.highlighted = true
                res.color = data.color
                res.zIndex = 10
            } else if (inHoveredNeighborhood || inSelectedNeighborhood) {
                res.color = data.color
                res.zIndex = 5
            } else if ((focusMode && selectedNode) || hoveredNode) {
                res.color = '#f1f5f9'
                res.zIndex = 0
            } else {
                res.color = data.color
                res.zIndex = 1
            }

            const isImportant = degree > 5
            const showLabel =
                isSelected || isHovered || inHoveredNeighborhood || (focusMode && inSelectedNeighborhood) || isImportant

            if (!showLabel && !res.highlighted) {
                res.label = ''
            }

            return res
        })

        sigma.setSetting('edgeReducer', (edge, data) => {
            const res = { ...data }

            const graph = sigma.getGraph()
            const source = graph.source(edge)
            const target = graph.target(edge)

            const sourceHovered = hoveredNode === source
            const targetHovered = hoveredNode === target
            const sourceSelected = selectedNodeId === source
            const targetSelected = selectedNodeId === target

            const isRelatedToHovered = sourceHovered || targetHovered
            const isRelatedToSelected = sourceSelected || targetSelected
            const inSelectedNeighborhood = selectedNeighborhood.has(source) && selectedNeighborhood.has(target)

            if (isRelatedToHovered) {
                res.color = '#0f766e'
                res.size = data.size * 1.5
                res.zIndex = 10
            } else if (isRelatedToSelected) {
                res.color = '#0f766e'
                res.size = data.size * 1.5
                res.zIndex = 5
            } else if (focusMode && selectedNodeId && inSelectedNeighborhood) {
                res.color = '#14b8a6'
                res.zIndex = 2
            } else if ((focusMode && selectedNodeId) || hoveredNode) {
                res.color = '#94a3b8'
                res.zIndex = 0
            }

            return res
        })
    }, [hoveredNode, selectedNodeId, focusMode, selectedNeighborhood, hoveredNeighborhood, neighborMap, selectedNode])

    const nodesByCluster = useMemo(() => {
        const map = new Map<string, PublicWikiGraphNode[]>()
        for (const node of nodes) {
            const clusterKey = getClusterKey(node, graphMode)
            appendGroupedNode(map, clusterKey, node)
        }
        return map
    }, [nodes, graphMode])

    const clusterEntries = useMemo(() => {
        return [...nodesByCluster.entries()].sort(
            ([leftKey, leftNodes], [rightKey, rightNodes]) =>
                getClusterSortWeight(leftKey) - getClusterSortWeight(rightKey) || rightNodes.length - leftNodes.length
        )
    }, [nodesByCluster])

    const relatedNodes = selectedNode
        ? nodes.filter((node) => selectedNeighborhood.has(node.id) && node.id !== selectedNode.id).slice(0, 8)
        : []

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Card className="overflow-hidden border-teal-200/70 bg-white/86 shadow-[0_24px_90px_rgba(15,118,110,0.13)] backdrop-blur flex flex-col h-full">
                <CardHeader className="border-b border-teal-100 bg-[linear-gradient(135deg,rgba(204,251,241,0.55),rgba(255,247,237,0.9))] shrink-0">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                        <div>
                            <div className="mb-3 flex flex-wrap items-center gap-2">
                                <Badge className="border border-teal-200 bg-teal-700 text-teal-50 hover:bg-teal-700">
                                    <Sparkles className="mr-1 h-3 w-3" />
                                    Interactive Knowledge Graph
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
                <CardContent className="p-0 relative flex-1 min-h-[620px] bg-[#fffaf0]">
                    <div
                        ref={containerRef}
                        className="w-full h-full bg-[radial-gradient(circle_at_20%_8%,rgba(20,184,166,0.18),transparent_34%),radial-gradient(circle_at_82%_12%,rgba(245,158,11,0.18),transparent_30%),linear-gradient(180deg,rgba(255,247,237,0.96),rgba(240,253,250,0.92))] cursor-grab active:cursor-grabbing"
                    />

                    <div className="absolute top-4 left-4 max-w-[200px] flex flex-col gap-2 pointer-events-none">
                        {clusterEntries.slice(0, 6).map(([clusterKey, clusterNodes]) => {
                            const tone = getClusterTone(clusterKey)
                            return (
                                <div
                                    key={clusterKey}
                                    className="flex items-center gap-2 bg-white/80 backdrop-blur px-2 py-1.5 rounded border shadow-sm"
                                    style={{ borderColor: tone.stroke }}
                                >
                                    <div
                                        className="w-3 h-3 rounded-full"
                                        style={{ backgroundColor: tone.fill, border: `1px solid ${tone.stroke}` }}
                                    />
                                    <div className="flex-1 flex justify-between text-[11px] items-center gap-4">
                                        <span className="font-medium text-teal-900 truncate">
                                            {getClusterLabel(clusterKey, graphMode)}
                                        </span>
                                        <span className="text-teal-700 font-mono">{clusterNodes.length}</span>
                                    </div>
                                </div>
                            )
                        })}
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

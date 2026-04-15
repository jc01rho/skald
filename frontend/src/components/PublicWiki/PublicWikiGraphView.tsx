import { useMemo } from 'react'
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
}

const CANVAS_WIDTH = 1080
const CANVAS_HEIGHT = 620
const NODE_RADIUS = 28

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
            return {
                fill: '#dbeafe',
                stroke: '#2563eb',
                text: '#1d4ed8',
            }
        case 'concept_page':
        case 'concept':
            return {
                fill: '#dcfce7',
                stroke: '#16a34a',
                text: '#166534',
            }
        case 'entity_page':
        case 'entity':
            return {
                fill: '#fef3c7',
                stroke: '#d97706',
                text: '#b45309',
            }
        default:
            return {
                fill: '#f3f4f6',
                stroke: '#6b7280',
                text: '#374151',
            }
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
}: PublicWikiGraphViewProps) => {
    const graphLayout = useMemo(() => {
        if (nodes.length === 0) {
            return {
                positionedNodes: [],
                positionedEdges: [] as Array<PublicWikiGraphEdge & { x1: number; y1: number; x2: number; y2: number }>,
            }
        }

        const centerX = CANVAS_WIDTH / 2
        const centerY = CANVAS_HEIGHT / 2
        const radius = Math.min(230 + nodes.length * 8, 260)
        const positionedNodes = nodes.map((node, index) => {
            const angle = (Math.PI * 2 * index) / nodes.length - Math.PI / 2
            const x = clamp(centerX + radius * Math.cos(angle), 90, CANVAS_WIDTH - 90)
            const y = clamp(centerY + radius * Math.sin(angle), 90, CANVAS_HEIGHT - 90)
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
    }, [edges, nodes])

    const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0] ?? null

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Card className="overflow-hidden">
                <CardHeader className="border-b">
                    <CardTitle>{title}</CardTitle>
                    <CardDescription>{description}</CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto p-0">
                    <div className="min-w-[960px] bg-[radial-gradient(circle_at_center,_rgba(59,130,246,0.08),_transparent_55%)] p-4">
                        <svg
                            viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
                            className="h-[620px] w-full rounded-xl bg-background"
                        >
                            <defs>
                                <marker
                                    id={`arrow-${graphMode}`}
                                    markerWidth="10"
                                    markerHeight="10"
                                    refX="7"
                                    refY="3"
                                    orient="auto"
                                >
                                    <path d="M0,0 L0,6 L9,3 z" fill="#94a3b8" />
                                </marker>
                            </defs>

                            {graphLayout.positionedEdges.map((edge) => (
                                <g key={edge.id}>
                                    <line
                                        x1={edge.x1}
                                        y1={edge.y1}
                                        x2={edge.x2}
                                        y2={edge.y2}
                                        stroke="#94a3b8"
                                        strokeWidth={Math.max(1.5, edge.weight ?? 1)}
                                        strokeOpacity={0.9}
                                        markerEnd={`url(#arrow-${graphMode})`}
                                    />
                                    <text
                                        x={(edge.x1 + edge.x2) / 2}
                                        y={(edge.y1 + edge.y2) / 2 - 6}
                                        textAnchor="middle"
                                        className="fill-slate-500 text-[11px]"
                                    >
                                        {edge.link_type || edge.edge_type || 'linked'}
                                    </text>
                                </g>
                            ))}

                            {graphLayout.positionedNodes.map((node) => {
                                const tone = getNodeTone(node, graphMode)
                                const isSelected = node.id === selectedNode?.id
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
                                            r={isSelected ? NODE_RADIUS + 6 : NODE_RADIUS}
                                            fill={tone.fill}
                                            stroke={isSelected ? '#0f172a' : tone.stroke}
                                            strokeWidth={isSelected ? 3 : 2}
                                        />
                                        <text
                                            x={node.x}
                                            y={node.y + NODE_RADIUS + 18}
                                            textAnchor="middle"
                                            className="fill-slate-700 text-[12px] font-medium"
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

            <Card className="h-fit">
                <CardHeader className="border-b">
                    <CardTitle>선택한 {graphMode === 'page' ? '페이지' : '노드'} 상세</CardTitle>
                    <CardDescription>
                        그래프에서 항목을 클릭하면 공개 가능한 최소 메타데이터를 볼 수 있습니다.
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

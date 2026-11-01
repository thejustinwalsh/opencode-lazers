import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js"
import type { RadarLayoutInput, RadarLayoutResult } from "./layout-ipc.ts"

type ElkCompoundNode = ElkNode & { edges?: ElkExtendedEdge[] }

const ELK_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "36",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.layered.spacing.edgeNodeBetweenLayers": "22",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.edgeLabels.placement": "CENTER",
  "elk.padding": "[top=18,left=18,bottom=18,right=18]",
}

export function elkGraph(input: RadarLayoutInput): ElkCompoundNode {
  const nodeGroups = new Map<string, RadarLayoutInput["nodes"][number][]>()
  for (const node of input.nodes) {
    const values = nodeGroups.get(node.group) ?? []
    values.push(node)
    nodeGroups.set(node.group, values)
  }
  const groups = input.groups.flatMap((group) => {
    const nodes = nodeGroups.get(group.id)
    if (!nodes?.length) return []
    return [
      {
        id: group.id,
        width: group.width,
        height: group.height,
        labels: [
          { id: `${group.id}:label`, text: group.label, width: group.width, height: group.height },
        ],
        children: nodes.map((node) => ({
          id: node.id,
          width: node.width,
          height: node.height,
        })),
        layoutOptions: {
          "elk.padding": "[top=38,left=16,bottom=16,right=16]",
          "elk.nodeSize.constraints": "MINIMUM_SIZE",
        },
      },
    ]
  })
  const edges: ElkExtendedEdge[] = input.edges.map((edge) => ({
    id: edge.id,
    sources: [edge.source],
    targets: [edge.target],
    labels: [
      {
        id: `${edge.id}:label`,
        text: edge.label,
        width: edge.labelWidth,
        height: edge.labelHeight,
      },
    ],
  }))
  return {
    id: "radar",
    children: groups,
    edges,
    layoutOptions: ELK_OPTIONS,
  } as ElkCompoundNode
}

type BoxValue = RadarLayoutResult["nodes"][number]

function boxes(node: ElkNode, x = 0, y = 0): BoxValue[] {
  const absoluteX = x + (node.x ?? 0)
  const absoluteY = y + (node.y ?? 0)
  const current =
    node.id !== "radar" && node.width !== undefined && node.height !== undefined
      ? [
          {
            id: node.id,
            x: absoluteX,
            y: absoluteY,
            width: node.width,
            height: node.height,
          },
        ]
      : []
  return [
    ...current,
    ...(node.children ?? []).flatMap((child) => boxes(child, absoluteX, absoluteY)),
  ]
}

function edgePath(points: readonly { x: number; y: number }[]) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")
}

function arrowPath(points: readonly { x: number; y: number }[]) {
  const end = points.at(-1)
  const previous = points.at(-2)
  if (!end || !previous) return "M 0 0 L 0 0"
  const angle = Math.atan2(end.y - previous.y, end.x - previous.x)
  const length = 10
  const spread = Math.PI / 6
  const left = {
    x: end.x - length * Math.cos(angle - spread),
    y: end.y - length * Math.sin(angle - spread),
  }
  const right = {
    x: end.x - length * Math.cos(angle + spread),
    y: end.y - length * Math.sin(angle + spread),
  }
  return `M ${left.x} ${left.y} L ${end.x} ${end.y} L ${right.x} ${right.y}`
}

function toEdge(edge: ElkExtendedEdge): RadarLayoutResult["edges"][number] | undefined {
  const sections = edge.sections ?? []
  if (!sections.length) return undefined
  const paths = sections.map((section) => [
    section.startPoint,
    ...(section.bendPoints ?? []),
    section.endPoint,
  ])
  const path = paths.map(edgePath).join(" ")
  const lastPoints = paths.at(-1)!
  const label = edge.labels?.[0]
  const longest = paths
    .flatMap((points) =>
      points.slice(1).map((point, index) => {
        const previous = points[index]!
        return {
          length: Math.hypot(point.x - previous.x, point.y - previous.y),
          x: (point.x + previous.x) / 2,
          y: (point.y + previous.y) / 2,
        }
      }),
    )
    .sort((left, right) => right.length - left.length)[0]
  return {
    id: edge.id,
    path,
    arrow: arrowPath(lastPoints),
    labelX: label?.x ?? longest?.x ?? lastPoints[0]!.x,
    labelY: label?.y ?? longest?.y ?? lastPoints[0]!.y,
  }
}

export function radarLayoutResult(
  input: RadarLayoutInput,
  graph: ElkNode,
  elapsedMs: number,
  workerThreadId: number,
): RadarLayoutResult {
  const allBoxes = boxes(graph)
  const boxByID = new Map(allBoxes.map((box) => [box.id, box]))
  const groups = input.groups.flatMap((group) => {
    const box = boxByID.get(group.id)
    return box ? [{ ...box }] : []
  })
  const nodes = input.nodes.flatMap((node) => {
    const box = boxByID.get(node.id)
    return box ? [{ ...box }] : []
  })
  const edges = (graph.edges ?? []).flatMap((edge) => {
    const routed = toEdge(edge)
    return routed ? [routed] : []
  })
  return {
    key: input.key,
    width: graph.width ?? 0,
    height: graph.height ?? 0,
    groups,
    nodes,
    edges,
    elapsedMs,
    workerThreadId,
  }
}

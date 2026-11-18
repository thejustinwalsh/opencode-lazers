import type { MapNode, MapTone, RadarMap } from "./map-model.ts"

export const MAP_PAD = 12
const NODE_HEIGHT = 36
const ROW_GAP = 30
const COLUMN_GAP = 8
const MAX_NODE_WIDTH = 100

export type PlacedNode = MapNode & { x: number; y: number; width: number; height: number }
export type PlacedEdge = { id: string; from: string; to: string; tone: MapTone; d: string }
export type MapLayout = { width: number; height: number; nodes: PlacedNode[]; edges: PlacedEdge[] }

/** Truncate a label to what fits a node of this width at this font size. */
export function fitText(text: string, width: number, size = 12) {
  const limit = Math.max(3, Math.floor((width - 10) / (size * 0.52)))
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * Rows: you, Architect, groups side by side, then each group's items stacked in its own column.
 * The layout fills the given width so text stays at its real size; nothing scrolls sideways.
 */
export function layoutMap(map: RadarMap, width: number): MapLayout {
  const inner = Math.max(120, width - MAP_PAD * 2)
  const topWidth = Math.min(MAX_NODE_WIDTH, inner)
  const groups = map.nodes.filter((node) => node.kind === "group")
  const columns = Math.max(1, groups.length)
  const columnWidth = Math.min(MAX_NODE_WIDTH, (inner - (columns - 1) * COLUMN_GAP) / columns)
  const blockWidth = columns * columnWidth + (columns - 1) * COLUMN_GAP
  const placed = new Map<string, PlacedNode>()
  const place = (node: MapNode, x: number, y: number, nodeWidth: number) =>
    placed.set(node.id, { ...node, x, y, width: nodeWidth, height: NODE_HEIGHT })

  let y = MAP_PAD
  const centerX = width / 2
  for (const node of map.nodes.filter((item) => item.kind === "you" || item.kind === "architect")) {
    place(node, centerX - topWidth / 2, y, topWidth)
    y += NODE_HEIGHT + ROW_GAP
  }
  groups.forEach((group, index) => {
    const x = centerX - blockWidth / 2 + index * (columnWidth + COLUMN_GAP)
    place(group, x, y, columnWidth)
    map.nodes
      .filter((node) => node.parent === group.id)
      .forEach((item, row) => place(item, x, y + (row + 1) * (NODE_HEIGHT + ROW_GAP), columnWidth))
  })
  const bottom = Math.max(...[...placed.values()].map((node) => node.y + node.height))

  const edges = map.edges.flatMap((edge): PlacedEdge[] => {
    const from = placed.get(edge.from)
    const to = placed.get(edge.to)
    if (!from || !to) return []
    const x1 = from.x + from.width / 2
    const y1 = from.y + from.height
    const x2 = to.x + to.width / 2
    const mid = Math.round(y1 + ROW_GAP / 2)
    const d = Math.abs(x1 - x2) < 0.5 ? `M${x1} ${y1}V${to.y}` : `M${x1} ${y1}V${mid}H${x2}V${to.y}`
    return [{ id: edge.id, from: edge.from, to: edge.to, tone: edge.tone, d }]
  })
  return {
    width,
    height: bottom + MAP_PAD,
    nodes: map.nodes.flatMap((node) => placed.get(node.id) ?? []),
    edges,
  }
}

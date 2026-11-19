import type { MapNode, MapTone, RadarMap } from "./map-model.ts"

const MAP_PAD = 12
const NODE_HEIGHT = 36
const ROW_GAP = 30
const COLUMN_GAP = 8
const MAX_NODE_WIDTH = 100
/** Nodes and type grow with the panel, from 1× at 360 px to this cap at 740 px. */
const MAP_MAX_SCALE = 1.4

function mapScale(width: number) {
  return Math.min(
    MAP_MAX_SCALE,
    Math.max(1, 1 + ((width - 360) / (740 - 360)) * (MAP_MAX_SCALE - 1)),
  )
}

export type PlacedNode = MapNode & { x: number; y: number; width: number; height: number }
export type PlacedEdge = { id: string; from: string; to: string; tone: MapTone; d: string }
export type MapLayout = {
  width: number
  height: number
  scale: number
  nodes: PlacedNode[]
  edges: PlacedEdge[]
}

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
  const scale = mapScale(width)
  const nodeHeight = NODE_HEIGHT * scale
  const rowGap = ROW_GAP * scale
  const columnGap = COLUMN_GAP * scale
  const maxWidth = MAX_NODE_WIDTH * scale
  const inner = Math.max(120, width - MAP_PAD * 2)
  const topWidth = Math.min(maxWidth, inner)
  const groups = map.nodes.filter((node) => node.kind === "group")
  const columns = Math.max(1, groups.length)
  const columnWidth = Math.min(maxWidth, (inner - (columns - 1) * columnGap) / columns)
  const blockWidth = columns * columnWidth + (columns - 1) * columnGap
  const placed = new Map<string, PlacedNode>()
  const place = (node: MapNode, x: number, y: number, nodeWidth: number) =>
    placed.set(node.id, { ...node, x, y, width: nodeWidth, height: nodeHeight })

  let y = MAP_PAD
  const centerX = width / 2
  for (const node of map.nodes.filter((item) => item.kind === "you" || item.kind === "architect")) {
    place(node, centerX - topWidth / 2, y, topWidth)
    y += nodeHeight + rowGap
  }
  // Items under a group are siblings: a rail runs down the group's left side and a short tick
  // reaches each item, org-chart style, so nothing reads as a chain or a dependency.
  const indent = 16 * scale
  const itemGap = 10 * scale
  const itemTop = nodeHeight + 14 * scale
  const rails = new Map<string, number>()
  groups.forEach((group, index) => {
    const x = centerX - blockWidth / 2 + index * (columnWidth + columnGap)
    place(group, x, y, columnWidth)
    rails.set(group.id, x + indent / 2)
    map.nodes
      .filter((node) => node.parent === group.id)
      .forEach((item, row) =>
        place(item, x + indent, y + itemTop + row * (nodeHeight + itemGap), columnWidth - indent),
      )
  })
  const bottom = Math.max(...[...placed.values()].map((node) => node.y + node.height))

  const tickY = (node: PlacedNode) => Math.round(node.y + node.height / 2)
  const edges = map.edges.flatMap((edge): PlacedEdge[] => {
    const to = placed.get(edge.to)
    const group = placed.get(edge.from)
    if (!to || !group) return []
    const rail = rails.get(edge.from)
    if (rail !== undefined && to.kind !== "group") {
      // From the previous tick (or the group) down the rail, then across to this item.
      const siblings = map.nodes.filter((node) => node.parent === edge.from)
      const above = siblings[siblings.findIndex((node) => node.id === edge.to) - 1]
      const start = above ? tickY(placed.get(above.id)!) : group.y + group.height
      return [
        {
          id: edge.id,
          from: edge.from,
          to: edge.to,
          tone: edge.tone,
          d: `M${rail} ${start}V${tickY(to)}H${to.x}`,
        },
      ]
    }
    const x1 = group.x + group.width / 2
    const y1 = group.y + group.height
    const x2 = to.x + to.width / 2
    const mid = Math.round(y1 + rowGap / 2)
    const d = Math.abs(x1 - x2) < 0.5 ? `M${x1} ${y1}V${to.y}` : `M${x1} ${y1}V${mid}H${x2}V${to.y}`
    return [{ id: edge.id, from: edge.from, to: edge.to, tone: edge.tone, d }]
  })
  return {
    width,
    scale,
    height: bottom + MAP_PAD,
    nodes: map.nodes.flatMap((node) => placed.get(node.id) ?? []),
    edges,
  }
}

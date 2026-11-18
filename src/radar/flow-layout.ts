import { DEST_GROUPS } from "./flow-model.ts"
import type { FlowDestination, FlowEdge, FlowModel, FlowSession } from "./flow-model.ts"

/** At or below this panel width the layout abbreviates roles and drops counts. */
export const FLOW_NARROW = 420

export type PlacedSession = FlowSession & { x: number; y: number }
export type PlacedDestination = FlowDestination & { x: number; y: number }
export type PlacedEdge = FlowEdge & {
  d: string
  /** Two points along the curve, for the static particle fallback. */
  dots: Array<{ x: number; y: number }>
  x0: number
  x1: number
}
export type FlowLayout = {
  width: number
  height: number
  narrow: boolean
  frame: { x: number; y: number; width: number; height: number }
  sessions: PlacedSession[]
  headings: Array<{ label: string; x: number; y: number }>
  destinations: PlacedDestination[]
  edges: PlacedEdge[]
  /** Characters of the mono "doing" line that fit beside the session node. */
  doingChars: number
  links: Array<{ sessionID: string; d: string }>
}

const cubic = (t: number, a: number, b: number, c: number, d: number) => {
  const u = 1 - t
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
}

/** The mockup's algorithm: session rows on the left, grouped destinations on the right. */
export function layoutFlow(model: FlowModel, width: number): FlowLayout {
  const narrow = width <= FLOW_NARROW
  const rowH = narrow ? 50 : 54
  const top = 34
  const sinkX = width - 20
  const frameW = narrow ? 180 : Math.min(274, Math.round(width * 0.55))
  const x0 = frameW + 12
  const x1 = Math.max(x0 + 40, sinkX - (narrow ? 96 : 118))
  const sessions = model.sessions.map((session, index): PlacedSession => ({
    ...session,
    x: (narrow ? 26 : 30) + session.depth * 18,
    y: top + index * rowH,
  }))
  const placedSession = new Map(sessions.map((session) => [session.sessionID, session]))

  const headings: FlowLayout["headings"] = []
  const destinations: PlacedDestination[] = []
  let y = -4
  let lastLabel = ""
  for (const dest of model.destinations) {
    const label = DEST_GROUPS.find((group) => group.kind === dest.kind)!.label
    if (label !== lastLabel) {
      y += 30
      headings.push({ label, x: sinkX + 6, y })
      lastLabel = label
    }
    y += narrow ? 22 : 24
    destinations.push({ ...dest, x: sinkX, y })
  }
  const placedDest = new Map(destinations.map((dest) => [dest.id, dest]))

  const mx = (x0 + x1) / 2
  const edges = model.edges.flatMap((edge): PlacedEdge[] => {
    const from = placedSession.get(edge.sessionID)
    const to = placedDest.get(edge.destID)
    if (!from || !to) return []
    const d = `M${x0} ${from.y}C${mx} ${from.y} ${mx} ${to.y} ${x1} ${to.y}`
    const dots = [0.22 + (edge.count % 3) * 0.07, 0.61 + (edge.count % 2) * 0.09].map((t) => ({
      x: cubic(t, x0, mx, mx, x1),
      y: cubic(t, from.y, from.y, to.y, to.y),
    }))
    return [{ ...edge, d, dots, x0, x1 }]
  })

  const links = sessions.flatMap((session) => {
    const parent = session.parent ? placedSession.get(session.parent) : undefined
    return parent
      ? [
          {
            sessionID: session.sessionID,
            d: `M${parent.x} ${parent.y + 9}V${session.y - 8}q0 8 8 8H${session.x - 9}`,
          },
        ]
      : []
  })

  const doingChars = Math.max(8, Math.floor((frameW - 30 - 18 - 8) / 6.2))
  const bottom = Math.max(top + sessions.length * rowH - 10, y + 16)
  return {
    width,
    height: bottom + 12,
    narrow,
    frame: { x: 8, y: top - 22, width: frameW, height: Math.max(0, sessions.length * rowH - 6) },
    sessions,
    headings,
    destinations,
    edges,
    doingChars,
    links,
  }
}

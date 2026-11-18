import type { LiveRadarResponse } from "../observability/contract.ts"
import { formatAge, sessionState } from "./monitor-model.ts"
import type { LiveSession } from "./monitor-model.ts"
import { sessionRole } from "./monitor-model.ts"

/**
 * The compact org tree: you, the Architect, the groups of work under it, and concrete items
 * under each group. Every node comes from the live read; a node or sub-line whose data is
 * absent is omitted, never labelled unknown.
 */
export type MapNodeKind = "you" | "architect" | "group" | "session" | "item" | "more"
export type MapTone = "active" | "failed" | "attention" | "weak"

export type MapNode = {
  id: string
  kind: MapNodeKind
  title: string
  sub?: string
  tone: MapTone
  /** Something is running here, so the node pulses. */
  running: boolean
  parent: string | null
  /** Set for session nodes and for the Architect: the Monitor inspector opens for it. */
  sessionID?: string
}

export type MapEdge = { id: string; from: string; to: string; tone: MapTone }

export type RadarMap = {
  nodes: MapNode[]
  edges: MapEdge[]
  nodeByID: Map<string, MapNode>
}

/** Items shown per group before the "+N more" node. */
export const MAP_ITEMS_PER_GROUP = 4

type Live = LiveRadarResponse
type Item = Omit<MapNode, "parent">

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`

export function createRadarMap(live: Live, now: number): RadarMap {
  const available = live.sessions.filter((session) => session.availability === "available")
  const architect = available.find((session) => session.isCurrentArchitect === true)
  const working = available.filter((session) => session !== architect && session.assignment)
  const workers = working.filter((session) => session.assignment?.state !== "verifying")
  const verifiers = working.filter((session) => session.assignment?.state === "verifying")
  const workload = live.workload

  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  const add = (node: MapNode) => {
    nodes.push(node)
  }
  const link = (from: string, to: string) =>
    edges.push({ id: `${from}>${to}`, from, to, tone: "weak" })

  add({
    id: "you",
    kind: "you",
    title: "You · session",
    tone: "weak",
    running: false,
    parent: null,
  })
  let top = "you"
  if (architect) {
    const state = sessionState(architect)
    const age =
      architect.updatedAt === null
        ? ""
        : ` ${formatAge(now - architect.updatedAt).replace(" ago", "")}`
    add({
      id: "architect",
      kind: "architect",
      title: "Architect",
      ...(state ? { sub: `${state}${age}` } : {}),
      tone: "weak",
      running: architect.state === "busy",
      parent: "you",
      sessionID: architect.sessionID,
    })
    link("you", "architect")
    top = "architect"
  }

  const group = (
    id: string,
    title: string,
    sub: string | undefined,
    items: Item[],
    run: boolean,
  ) => {
    add({
      id,
      kind: "group",
      title,
      ...(sub ? { sub } : {}),
      tone: run ? "active" : "weak",
      running: run,
      parent: top,
    })
    link(top, id)
    for (const item of items.slice(0, MAP_ITEMS_PER_GROUP)) {
      add({ ...item, parent: id })
      link(id, item.id)
    }
    if (items.length > MAP_ITEMS_PER_GROUP) {
      const more = `more:${id}`
      add({
        id: more,
        kind: "more",
        title: `+${items.length - MAP_ITEMS_PER_GROUP} more`,
        tone: "weak",
        running: false,
        parent: id,
      })
      link(id, more)
    }
  }
  const sessionItem = (session: LiveSession): Item => {
    const state = sessionState(session)
    return {
      id: `session:${session.sessionID}`,
      kind: "session",
      title: session.assignment?.taskReference ?? sessionRole(session).label,
      ...(state ? { sub: state } : {}),
      tone: "active",
      running: true,
      sessionID: session.sessionID,
    }
  }

  if (workers.length > 0)
    group("group:runtime", "Runtime", `${workers.length} running`, workers.map(sessionItem), true)
  if (verifiers.length > 0)
    group("group:checks", "Checks", `${verifiers.length} running`, verifiers.map(sessionItem), true)

  const queued = workload?.queued ?? 0
  const needsYou = workload?.needsYou ?? 0
  const failed = workload?.failed ?? 0
  if (queued + needsYou + failed > 0) {
    const items: Item[] = [
      ...(needsYou > 0
        ? [
            {
              id: "item:needs-you",
              kind: "item" as const,
              title: "Needs you",
              sub: plural(needsYou, "task"),
              tone: "attention" as const,
              running: false,
            },
          ]
        : []),
      ...(failed > 0
        ? [
            {
              id: "item:failed",
              kind: "item" as const,
              title: "Failed",
              sub: plural(failed, "task"),
              tone: "failed" as const,
              running: false,
            },
          ]
        : []),
    ]
    group("group:queue", "Queue", queued > 0 ? `${queued} queued` : undefined, items, false)
  }

  const byID = new Map(nodes.map((node) => [node.id, node]))
  // Active or failed children colour the path above them: the route from you to what runs.
  for (const node of nodes) {
    if (node.tone !== "active" && node.tone !== "failed") continue
    for (let id = node.parent; id; id = byID.get(id)?.parent ?? null) {
      const parent = byID.get(id)!
      if (parent.tone === "weak" || (parent.tone === "active" && node.tone === "failed"))
        parent.tone = node.tone
    }
  }
  for (const edge of edges) edge.tone = byID.get(edge.to)!.tone

  return { nodes, edges, nodeByID: byID }
}

/** The node, its ancestors and its descendants: everything else dims when one is selected. */
export function relatedNodes(map: RadarMap, selectedID: string | null) {
  if (!selectedID || !map.nodeByID.has(selectedID)) return undefined
  const related = new Set([selectedID])
  for (let id = map.nodeByID.get(selectedID)!.parent; id; id = map.nodeByID.get(id)?.parent ?? null)
    related.add(id)
  const descend = (id: string) => {
    for (const node of map.nodes)
      if (node.parent === id && !related.has(node.id)) {
        related.add(node.id)
        descend(node.id)
      }
  }
  descend(selectedID)
  return related
}

/** Facts for a system node's inspector; every line is something the read records. */
export function mapFacts(live: Live, node: MapNode): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = []
  const workload = live.workload
  if (
    (node.id === "group:runtime" || node.id === "group:checks") &&
    live.scheduler.status !== "unknown"
  )
    facts.push({ label: "Scheduler", value: live.scheduler.status })
  if (node.id === "group:runtime" && live.scheduler.participants !== null)
    facts.push({ label: "Participants", value: String(live.scheduler.participants) })
  if (node.id === "group:queue" && workload) {
    facts.push({ label: "Queued", value: String(workload.queued) })
    if (workload.needsYou > 0) facts.push({ label: "Needs you", value: String(workload.needsYou) })
    if (workload.failed > 0) facts.push({ label: "Failed", value: String(workload.failed) })
  }
  return facts
}

import type { RadarMapEdge, RadarMapModel, RadarMapNode, RadarMapNodeRecord } from "./map-model.ts"

export type RadarOverviewGroupID =
  "runtime" | "sessions" | "work" | "routes" | "tools" | "relationships"

export type RadarOverviewEntry = {
  id: string
  kind: "node" | "edge"
  title: string
  status: string
  context: string
  sourceIDs?: string[]
}

export type RadarOverviewGroup = {
  id: RadarOverviewGroupID
  label: string
  entries: RadarOverviewEntry[]
  count: number
  sourceCount: number
}

export type RadarOverview = {
  nodes: RadarMapNode[]
  workerSessions: RadarMapNode[]
  activeWorkerSessions: RadarMapNode[]
  /** Focused relationships are listed as buttons rather than widening the compact graph. */
  graphEdges: RadarMapEdge[]
  edges: RadarMapEdge[]
  groups: RadarOverviewGroup[]
  currentArchitectID: string | null
  activeWorkerCount: number
  visibleWorkerCount: number
}

const GROUPS: ReadonlyArray<{ id: RadarOverviewGroupID; label: string }> = [
  { id: "runtime", label: "Runtime components" },
  { id: "sessions", label: "Native sessions" },
  { id: "work", label: "Plans and tasks" },
  { id: "routes", label: "Model routes" },
  { id: "tools", label: "Native tools" },
  { id: "relationships", label: "Recorded relationships" },
]

const MAX_VISIBLE_WORKERS = 2

function agentName(node: RadarMapNode) {
  return node.record.kind === "session" ? node.record.value.agent?.trim().toLowerCase() : undefined
}

function isCurrentArchitect(node: RadarMapNode, currentSessionID: string | undefined) {
  return (
    node.record.kind === "session" &&
    Boolean(currentSessionID) &&
    node.record.value.sessionID === currentSessionID &&
    agentName(node) === "architect"
  )
}

function hasWorkerEvidence(node: RadarMapNode) {
  if (node.record.kind !== "session") return false
  const session = node.record.value
  return (
    session.classification === "managed" ||
    session.associations.includes("attempt") ||
    session.associations.includes("plan-owner") ||
    node.record.attempts.length > 0 ||
    node.record.tasks.length > 0
  )
}

function latestAttemptAt(node: RadarMapNode) {
  return node.record.kind === "session"
    ? Math.max(0, ...node.record.attempts.map((attempt) => attempt.startedAt))
    : 0
}

function isActiveWorker(node: RadarMapNode) {
  return (
    node.record.kind === "session" &&
    node.record.value.state === "busy" &&
    node.record.value.availability === "available" &&
    node.record.value.freshness === "current"
  )
}

function hasActiveWorkEvidence(node: RadarMapNode) {
  if (node.record.kind !== "session") return false
  const activeStates = new Set(["queued", "ready", "running", "verifying"])
  return (
    node.record.attempts.some((attempt) => activeStates.has(attempt.state)) ||
    node.record.tasks.some((task) => activeStates.has(task.state))
  )
}

function workerPriority(node: RadarMapNode) {
  if (isActiveWorker(node)) return 0
  if (node.record.kind === "session" && node.record.value.state === "busy") return 1
  if (hasActiveWorkEvidence(node)) return 2
  return 3
}

export function radarSessionModelContext(record: Extract<RadarMapNodeRecord, { kind: "session" }>) {
  const current = record.value.currentRouteID
    ? record.routes.find((route) => route.id === record.value.currentRouteID)
    : undefined
  const route =
    current ??
    [...record.routes].sort((left, right) => {
      const sourceRank = (source: string) =>
        source === "step-event" ? 0 : source === "session-selection" ? 1 : 2
      return (
        sourceRank(left.source) - sourceRank(right.source) ||
        (right.observedAt ?? 0) - (left.observedAt ?? 0) ||
        left.id.localeCompare(right.id)
      )
    })[0]
  const model = route
    ? `${route.providerID}/${route.modelID} · effort ${route.variant ?? "unavailable"} · ${route.source}`
    : "Model/effort unavailable · route provenance unavailable"
  const task = record.tasks[0]
  const taskContext = task ? `Task: ${task.label} · ${task.state}` : "Task context unavailable"
  return { model, task: taskContext }
}

export function radarOverviewConnectionIDs(edges: readonly RadarMapEdge[]) {
  return edges.map((edge) => edge.id)
}

export function radarOverviewConnectionForID(edges: readonly RadarMapEdge[], id: string) {
  return edges.find((edge) => edge.id === id)
}

export function radarOverviewNode(node: RadarMapNode, currentArchitect = false): RadarMapNode {
  if (node.record.kind !== "session") return node
  const context = radarSessionModelContext(node.record)
  const session = node.record.value
  const state = session.state === "unknown" ? "State unavailable" : session.state
  const availability = session.availability === "available" ? "" : ` · ${session.availability}`
  const freshness = session.freshness === "current" ? "" : ` · ${session.freshness}`
  return {
    ...node,
    label: currentArchitect ? "Current Architect" : (node.record.value.agent ?? "Native session"),
    subtitle: context.model,
    status: `${state}${availability}${freshness} · ${context.task}`,
  }
}

function nodeContext(node: RadarMapNode) {
  if (node.record.kind === "session") {
    const context = radarSessionModelContext(node.record)
    return `${context.model}; ${context.task}`
  }
  if (node.record.kind === "component") return node.record.value.responsibility
  if (node.record.kind === "plan") return `${node.record.tasks.length} related tasks`
  if (node.record.kind === "task") return node.record.objective ?? "Objective unavailable"
  if (node.record.kind === "route") return node.record.value.map((route) => route.source).join(", ")
  return node.record.sessions.length
    ? `${node.record.sessions.length} associated sessions`
    : "No associated sessions recorded"
}

function edgeContext(edge: RadarMapEdge, model: RadarMapModel) {
  const evidence = [...new Set(edge.evidence.map((item) => item.source))]
  const from = model.nodeByID.get(edge.from)?.label ?? edge.from
  const to = model.nodeByID.get(edge.to)?.label ?? edge.to
  const source = evidence.length ? `Evidence: ${evidence.join(", ")}` : "No event evidence recorded"
  const stage = edge.records.at(-1)?.deliveryStage
  const sourceCount = edge.records.length + edge.routeRecords.length
  return `${from} → ${to}; ${sourceCount} source records; ${source}${stage ? `; delivery ${stage}` : ""}`
}

function nodeEntry(node: RadarMapNode): RadarOverviewEntry {
  const sourceIDs = [node.id]
  if (node.record.kind === "session")
    sourceIDs.push(node.record.value.id, node.record.value.sessionID)
  else if (node.record.kind === "route")
    sourceIDs.push(...node.record.value.map((route) => route.id))
  else sourceIDs.push(node.record.value.id)
  return {
    id: node.id,
    kind: "node",
    title: node.label,
    status: node.status,
    context: nodeContext(node),
    sourceIDs: [...new Set(sourceIDs)],
  }
}

function edgeEntry(edge: RadarMapEdge, model: RadarMapModel): RadarOverviewEntry {
  return {
    id: edge.id,
    kind: "edge",
    title: `${edge.kind} relationship`,
    status: edge.status,
    context: edgeContext(edge, model),
    sourceIDs: [
      ...new Set([
        edge.id,
        ...edge.records.map((record) => record.id),
        ...edge.routeRecords.map((record) => record.id),
      ]),
    ],
  }
}

export function createRadarOverview(
  model: RadarMapModel,
  currentSessionID?: string,
): RadarOverview {
  const scheduler = model.nodes.find(
    (node) => node.record.kind === "component" && node.id === "component:runner-runtime",
  )
  const architect = model.nodes.find((node) => isCurrentArchitect(node, currentSessionID))
  const workerCandidates = model.nodes
    .filter(
      (node) =>
        node.record.kind === "session" &&
        agentName(node) !== "architect" &&
        hasWorkerEvidence(node),
    )
    .sort(
      (left, right) =>
        workerPriority(left) - workerPriority(right) ||
        latestAttemptAt(right) - latestAttemptAt(left) ||
        left.id.localeCompare(right.id),
    )
  const visibleWorkers = workerCandidates.slice(0, MAX_VISIBLE_WORKERS)
  // Selection favors current work, but the selected nodes retain a stable order
  // so status-only priority changes do not request a different ELK layout.
  const stableVisibleWorkers = visibleWorkers.toSorted(
    (left, right) =>
      latestAttemptAt(right) - latestAttemptAt(left) || left.id.localeCompare(right.id),
  )
  const taskConnections = stableVisibleWorkers.flatMap((worker) => {
    const assignments = model.edges
      .filter(
        (edge) => edge.kind === "assignment" && (edge.from === worker.id || edge.to === worker.id),
      )
      .flatMap((edge) => {
        const taskID = edge.from === worker.id ? edge.to : edge.from
        const task = model.nodeByID.get(taskID)
        return task?.record.kind === "task" ? [{ worker, task, edge }] : []
      })
      .sort(
        (left, right) =>
          (right.edge.records.at(-1)?.observedAt ?? 0) -
            (left.edge.records.at(-1)?.observedAt ?? 0) ||
          left.task.id.localeCompare(right.task.id),
      )
    return assignments.slice(0, 1)
  })
  const assignedWorkerIDs = new Set(taskConnections.map(({ worker }) => worker.id))
  const focusNodes = [
    ...taskConnections.flatMap(({ task, worker }) => [task, worker]),
    ...stableVisibleWorkers.filter((worker) => !assignedWorkerIDs.has(worker.id)),
  ]
  const visibleNodeIDs = new Set(
    [scheduler, architect, ...focusNodes].flatMap((node) => (node ? [node.id] : [])),
  )
  const nodes = [scheduler, architect, ...focusNodes]
    .filter((node): node is RadarMapNode => Boolean(node))
    .filter((node, index, values) => values.findIndex((value) => value.id === node.id) === index)
    .map((node) => ({
      ...radarOverviewNode(node, node.id === architect?.id),
      group: "overview" as const,
    }))
  const selectedAssignmentIDs = new Set(taskConnections.map(({ edge }) => edge.id))
  const controlNodeIDs = new Set([scheduler?.id, architect?.id].filter((id): id is string => !!id))
  const workerNodeIDs = new Set(stableVisibleWorkers.map((node) => node.id))
  const edges = model.edges.filter((edge) => {
    if (edge.kind === "assignment") return selectedAssignmentIDs.has(edge.id)
    if (edge.kind !== "prompt" && edge.kind !== "outcome") return false
    return (
      visibleNodeIDs.has(edge.from) &&
      visibleNodeIDs.has(edge.to) &&
      (controlNodeIDs.has(edge.from) ||
        controlNodeIDs.has(edge.to) ||
        workerNodeIDs.has(edge.from) ||
        workerNodeIDs.has(edge.to))
    )
  })

  const recordsFor = (id: RadarOverviewGroupID) => {
    if (id === "relationships") return model.edges.map((edge) => edgeEntry(edge, model))
    const values = model.nodes.filter((node) => {
      if (id === "runtime") return node.kind === "component"
      if (id === "sessions") return node.kind === "session"
      if (id === "work") return node.kind === "plan" || node.kind === "task"
      if (id === "routes") return node.kind === "route"
      return node.kind === "tool"
    })
    return values.map(nodeEntry)
  }
  const groups = GROUPS.map(({ id, label }) => {
    const entries = recordsFor(id)
    const sourceCount =
      id === "relationships"
        ? model.edges.reduce(
            (count, edge) => count + edge.records.length + edge.routeRecords.length,
            0,
          )
        : id === "routes"
          ? model.nodes.reduce(
              (count, node) =>
                count + (node.record.kind === "route" ? node.record.value.length : 0),
              0,
            )
          : entries.length
    return { id, label, entries, count: entries.length, sourceCount }
  })
  const activeWorkerCount = workerCandidates.filter(isActiveWorker).length
  const workerSessions = stableVisibleWorkers.map((node) => ({
    ...radarOverviewNode(node),
    group: "overview" as const,
  }))
  return {
    nodes,
    workerSessions,
    activeWorkerSessions: workerSessions.filter(isActiveWorker),
    graphEdges: [],
    edges,
    groups,
    currentArchitectID: architect?.id ?? null,
    activeWorkerCount,
    visibleWorkerCount: visibleWorkers.length,
  }
}

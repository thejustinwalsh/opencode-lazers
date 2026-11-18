import type { RadarResponse, SnapshotResponse } from "../observability/contract.ts"

export type RadarMapNodeKind = "component" | "session" | "route" | "plan" | "task" | "tool"
export type RadarMapGroup = "runtime" | "work" | "sessions" | "routes" | "tools" | "overview"
export type RadarMapEdgeKind =
  RadarResponse["edges"][number]["kind"] | "contains" | "selected-route" | "configured-route"

type Component = RadarResponse["components"][number]
type Session = RadarResponse["sessions"][number]
type Route = RadarResponse["routes"][number]
type Plan = RadarResponse["plans"][number]
type Task = RadarResponse["tasks"][number]
type Attempt = RadarResponse["attempts"][number]
type Tool = RadarResponse["tools"][number]
type RecordedEdge = RadarResponse["edges"][number]

export type RadarMapNodeRecord =
  | { kind: "component"; value: Component }
  | {
      kind: "session"
      value: Session
      routes: Route[]
      attempts: Attempt[]
      tasks: Array<{
        id: string
        label: string
        state: string
        objective: string | null
        reason: string | null
      }>
    }
  | { kind: "route"; value: Route[] }
  | { kind: "plan"; value: Plan; tasks: Task[] }
  | {
      kind: "task"
      value: Task
      objective: string | null
      reason: string | null
      attempts: Attempt[]
    }
  | { kind: "tool"; value: Tool; sessions: Session[] }

export type RadarMapNode = {
  id: string
  kind: RadarMapNodeKind
  group: RadarMapGroup
  label: string
  subtitle: string
  status: string
  record: RadarMapNodeRecord
  related: string[]
}

export type RadarMapEdge = {
  id: string
  kind: RadarMapEdgeKind
  from: string
  to: string
  status: string
  records: RecordedEdge[]
  evidence: RecordedEdge["evidence"]
  routeRecords: Route[]
  related: string[]
  pulseEventIDs: string[]
}

export type RadarMapModel = {
  nodes: RadarMapNode[]
  edges: RadarMapEdge[]
  nodeByID: Map<string, RadarMapNode>
  edgeByID: Map<string, RadarMapEdge>
  routeNodeByID: Map<string, string>
  coverage: RadarResponse["coverage"]
  freshness: RadarResponse["freshness"]
  observedAt: string
}

export function radarPlanNodeID(planID: string) {
  return `plan:${planID}`
}

export function radarTaskNodeID(taskID: string) {
  return `task:${taskID}`
}

function hash(value: string) {
  let result = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(value)) {
    result ^= BigInt(byte)
    result = BigInt.asUintN(64, result * 0x100000001b3n)
  }
  return result.toString(16).padStart(16, "0")
}

function shortID(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

function routeKey(route: Pick<Route, "providerID" | "modelID" | "variant">) {
  return JSON.stringify([route.providerID, route.modelID, route.variant])
}

function routeNodeID(route: Pick<Route, "providerID" | "modelID" | "variant">) {
  return `route:${hash(routeKey(route))}`
}

function edgeID(kind: RadarMapEdgeKind, from: string, to: string) {
  return `map-edge:${hash(JSON.stringify([kind, from, to]))}`
}

function groupFor(kind: RadarMapNodeKind): RadarMapGroup {
  if (kind === "component") return "runtime"
  if (kind === "plan" || kind === "task") return "work"
  if (kind === "session") return "sessions"
  if (kind === "route") return "routes"
  return "tools"
}

function latestStatus(records: readonly RecordedEdge[]) {
  const latest = [...records].sort(
    (left, right) =>
      (right.observedAt ?? right.startedAt ?? 0) - (left.observedAt ?? left.startedAt ?? 0),
  )[0]
  if (!latest) return "structural"
  const stage = latest.deliveryStage ? ` · ${latest.deliveryStage}` : ""
  return `${latest.status}${stage}`
}

function unique(values: Iterable<string>) {
  return [...new Set(values)].filter(Boolean).sort()
}

export function createRadarMapModel(
  radar: RadarResponse,
  snapshot?: SnapshotResponse,
): RadarMapModel {
  const nodes: RadarMapNode[] = []
  const nodeByID = new Map<string, RadarMapNode>()
  const addNode = (node: RadarMapNode) => {
    nodes.push(node)
    nodeByID.set(node.id, node)
  }
  const sessionsByID = new Map(radar.sessions.map((session) => [session.sessionID, session]))
  const tasksByID = new Map(radar.tasks.map((task) => [task.id, task]))
  const taskContexts = new Map<string, { objective: string; reason: string | null }>()
  for (const plan of snapshot?.plans ?? [])
    for (const task of plan.nodes)
      taskContexts.set(task.taskID, { objective: task.objective, reason: task.reason })
  const routesByID = new Map(radar.routes.map((route) => [route.id, route]))
  const routesBySession = new Map<string, Route[]>()
  const attemptsByTask = new Map<string, Attempt[]>()
  const attemptsBySession = new Map<string, Attempt[]>()
  for (const attempt of radar.attempts) {
    const taskAttempts = attemptsByTask.get(attempt.taskID) ?? []
    taskAttempts.push(attempt)
    attemptsByTask.set(attempt.taskID, taskAttempts)
    const sessionAttempts = attemptsBySession.get(attempt.sessionID) ?? []
    sessionAttempts.push(attempt)
    attemptsBySession.set(attempt.sessionID, sessionAttempts)
  }

  for (const component of radar.components) {
    addNode({
      id: component.id,
      kind: "component",
      group: groupFor("component"),
      label: component.name,
      subtitle: component.responsibility,
      status: "Code-backed",
      record: { kind: "component", value: component },
      related: [],
    })
  }

  for (const session of radar.sessions) {
    const id = session.id
    const routes = radar.routes.filter(
      (route) =>
        route.sessionID === session.sessionID ||
        route.id === session.currentRouteID ||
        session.configuredRouteIDs.includes(route.id),
    )
    routesBySession.set(session.sessionID, routes)
    const attempts = attemptsBySession.get(session.sessionID) ?? []
    const relatedTaskIDs = unique([
      ...session.taskIDs,
      ...attempts.map((attempt) => attempt.taskID),
    ])
    const tasks = relatedTaskIDs.map((taskID) => {
      const task = tasksByID.get(taskID)
      const context = taskContexts.get(taskID)
      return {
        id: taskID,
        label: context?.objective ?? `Task ${shortID(taskID)}`,
        state: task?.state ?? "",
        objective: context?.objective ?? null,
        reason: context?.reason ?? null,
      }
    })
    const state = session.state === "unknown" ? "" : session.state
    const availability = session.availability === "available" ? "" : ` · ${session.availability}`
    addNode({
      id,
      kind: "session",
      group: groupFor("session"),
      label: session.agent ?? "Native session",
      subtitle: shortID(session.sessionID),
      status: state ? `${state}${availability}` : availability.replace(/^ · /, ""),
      record: {
        kind: "session",
        value: session,
        routes,
        attempts,
        tasks,
      },
      related: [],
    })
  }

  const routeBuckets = new Map<string, Route[]>()
  for (const route of radar.routes) {
    const key = routeKey(route)
    const bucket = routeBuckets.get(key) ?? []
    bucket.push(route)
    routeBuckets.set(key, bucket)
  }
  const routeNodeByID = new Map<string, string>()
  for (const values of routeBuckets.values()) {
    const route = values[0]!
    const id = routeNodeID(route)
    for (const value of values) routeNodeByID.set(value.id, id)
    const sources = unique(values.map((value) => value.source))
    addNode({
      id,
      kind: "route",
      group: groupFor("route"),
      label: `${route.providerID} / ${route.modelID}`,
      subtitle: route.variant ? `Variant ${route.variant}` : "",
      status: sources.length === 1 ? sources[0]! : `${sources.length} route sources`,
      record: { kind: "route", value: values },
      related: [],
    })
  }

  for (const plan of radar.plans) {
    const tasks = radar.tasks.filter((task) => task.planID === plan.id)
    addNode({
      id: radarPlanNodeID(plan.id),
      kind: "plan",
      group: groupFor("plan"),
      label: plan.title ?? `Plan ${shortID(plan.id)}`,
      subtitle: shortID(plan.id),
      status: `Plan · ${plan.state}`,
      record: { kind: "plan", value: plan, tasks },
      related: [],
    })
  }

  for (const task of radar.tasks) {
    const context = taskContexts.get(task.id)
    addNode({
      id: radarTaskNodeID(task.id),
      kind: "task",
      group: groupFor("task"),
      label: context?.objective ?? `Task ${shortID(task.id)}`,
      subtitle: shortID(task.id),
      status: `Task · ${task.state}`,
      record: {
        kind: "task",
        value: task,
        objective: context?.objective ?? null,
        reason: context?.reason ?? null,
        attempts: attemptsByTask.get(task.id) ?? [],
      },
      related: [],
    })
  }

  const toolSessions = new Map<string, Set<string>>()
  for (const edge of radar.edges) {
    if (edge.kind !== "tool-call" && edge.kind !== "tool-result") continue
    const toolID = edge.kind === "tool-call" ? edge.to : edge.from
    const values = toolSessions.get(toolID) ?? new Set<string>()
    values.add(edge.from.startsWith("session:") ? edge.from : edge.to)
    toolSessions.set(toolID, values)
  }
  for (const tool of radar.tools) {
    const sessions = [...(toolSessions.get(tool.id) ?? [])]
      .map((id) => sessionsByID.get(id))
      .filter((value): value is Session => Boolean(value))
    addNode({
      id: tool.id,
      kind: "tool",
      group: groupFor("tool"),
      label: tool.name,
      subtitle: "Native tool",
      status: sessions.length ? `Observed · ${sessions.length} sessions` : "Observed",
      record: { kind: "tool", value: tool, sessions },
      related: [],
    })
  }

  const edgeBuckets = new Map<
    string,
    {
      kind: RadarMapEdgeKind
      from: string
      to: string
      records: RecordedEdge[]
      routeRecords: Route[]
    }
  >()
  const addRelation = (
    kind: RadarMapEdgeKind,
    from: string,
    to: string,
    record?: RecordedEdge,
    routeRecord?: Route,
  ) => {
    if (!nodeByID.has(from) || !nodeByID.has(to)) return
    const key = JSON.stringify([kind, from, to])
    const current = edgeBuckets.get(key) ?? { kind, from, to, records: [], routeRecords: [] }
    if (record) current.records.push(record)
    if (routeRecord) current.routeRecords.push(routeRecord)
    edgeBuckets.set(key, current)
  }

  for (const task of radar.tasks)
    if (task.planID) addRelation("contains", radarPlanNodeID(task.planID), radarTaskNodeID(task.id))

  for (const session of radar.sessions) {
    const sessionNode = nodeByID.get(session.id)!
    const related: string[] = [
      ...session.planIDs.map(radarPlanNodeID),
      ...session.taskIDs.map(radarTaskNodeID),
      ...(session.parentSessionID ? [sessionsByID.get(session.parentSessionID)?.id ?? ""] : []),
      ...(routesBySession.get(session.sessionID) ?? []).flatMap((route) => {
        const routeID = routeNodeByID.get(route.id)
        return routeID ? [routeID] : []
      }),
    ]
    sessionNode.related = unique(related)
    const current = session.currentRouteID ? routesByID.get(session.currentRouteID) : undefined
    if (current) {
      const target = routeNodeByID.get(current.id)
      if (target) addRelation("selected-route", session.id, target, undefined, current)
    }
    for (const configuredID of session.configuredRouteIDs) {
      const route = routesByID.get(configuredID)
      const target = route ? routeNodeByID.get(route.id) : undefined
      if (route && target) addRelation("configured-route", session.id, target, undefined, route)
    }
  }

  for (const edge of radar.edges) {
    let from = edge.from
    let to = edge.to
    if (edge.kind === "assignment" && edge.taskID && tasksByID.has(edge.taskID))
      from = radarTaskNodeID(edge.taskID)
    if (routeNodeByID.has(from)) from = routeNodeByID.get(from)!
    if (routeNodeByID.has(to)) to = routeNodeByID.get(to)!
    if (from.startsWith("plan:")) from = radarPlanNodeID(from.slice("plan:".length))
    if (to.startsWith("plan:")) to = radarPlanNodeID(to.slice("plan:".length))
    if (from.startsWith("task:")) from = radarTaskNodeID(from.slice("task:".length))
    if (to.startsWith("task:")) to = radarTaskNodeID(to.slice("task:".length))
    addRelation(edge.kind, from, to, edge)
  }

  for (const plan of radar.plans) {
    const ownerID = radar.sessions.find((session) => session.sessionID === plan.ownerSessionID)?.id
    const node = nodeByID.get(radarPlanNodeID(plan.id))
    if (node)
      node.related = unique([
        ...node.related,
        ...(ownerID ? [ownerID] : []),
        ...radar.tasks
          .filter((task) => task.planID === plan.id)
          .map((task) => radarTaskNodeID(task.id)),
      ])
  }
  for (const task of radar.tasks) {
    const node = nodeByID.get(radarTaskNodeID(task.id))
    if (node)
      node.related = unique([
        ...(task.planID ? [radarPlanNodeID(task.planID)] : []),
        ...(attemptsByTask.get(task.id) ?? []).flatMap((attempt) => {
          const sessionID = radar.sessions.find(
            (session) => session.sessionID === attempt.sessionID,
          )?.id
          return sessionID ? [sessionID] : []
        }),
      ])
  }

  for (const node of nodes) {
    if (node.record.kind === "route")
      node.related = unique(
        node.record.value.flatMap((route) => [
          sessionsByID.get(route.sessionID ?? "")?.id ?? "",
          ...(route.attemptID
            ? radar.attempts
                .filter((attempt) => attempt.id === route.attemptID)
                .flatMap((attempt) => [
                  radarTaskNodeID(attempt.taskID),
                  sessionsByID.get(attempt.sessionID)?.id ?? "",
                ])
            : []),
        ]),
      )
    else if (node.record.kind === "tool")
      node.related = unique(node.record.sessions.map((session) => session.id))
  }

  const edges: RadarMapEdge[] = [...edgeBuckets.values()].map((bucket) => {
    const records = [...bucket.records].sort(
      (left, right) =>
        (left.observedAt ?? left.startedAt ?? 0) - (right.observedAt ?? right.startedAt ?? 0),
    )
    const id = edgeID(bucket.kind, bucket.from, bucket.to)
    const evidence = records.flatMap((record) => record.evidence)
    const routeRecords = bucket.routeRecords
    const recordRelated = records.flatMap((record) => [
      record.planID ? radarPlanNodeID(record.planID) : "",
      record.taskID ? radarTaskNodeID(record.taskID) : "",
      record.routeID ? (routeNodeByID.get(record.routeID) ?? "") : "",
      record.from,
      record.to,
    ])
    const attemptSessions = records.flatMap((record) =>
      record.attemptID
        ? radar.attempts
            .filter((attempt) => attempt.id === record.attemptID)
            .flatMap((attempt) => [
              radar.sessions.find((session) => session.sessionID === attempt.sessionID)?.id ?? "",
              radarTaskNodeID(attempt.taskID),
            ])
        : [],
    )
    return {
      id,
      kind: bucket.kind,
      from: bucket.from,
      to: bucket.to,
      status: latestStatus(records),
      records,
      evidence,
      routeRecords,
      related: unique([...recordRelated, ...attemptSessions, bucket.from, bucket.to]),
      pulseEventIDs: unique(
        records.flatMap((record) =>
          record.live
            ? record.evidence.flatMap((item) =>
                item.source === "native-event" ? [item.eventID] : [],
              )
            : [],
        ),
      ),
    }
  })

  for (const edge of edges) {
    const from = nodeByID.get(edge.from)
    const to = nodeByID.get(edge.to)
    if (from) from.related = unique([...from.related, edge.id, edge.to])
    if (to) to.related = unique([...to.related, edge.id, edge.from])
  }

  return {
    nodes: nodes.sort(
      (left, right) => left.group.localeCompare(right.group) || left.id.localeCompare(right.id),
    ),
    edges: edges.sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
    ),
    nodeByID,
    edgeByID: new Map(edges.map((edge) => [edge.id, edge])),
    routeNodeByID,
    coverage: radar.coverage,
    freshness: radar.freshness,
    observedAt: radar.observedAt,
  }
}

export function shortRadarID(value: string) {
  return shortID(value)
}

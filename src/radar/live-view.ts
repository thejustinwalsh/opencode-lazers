import { relativize } from "../progress/tool-detail.ts"
import { AttemptModel } from "../tasks/attempt-summary.ts"

/**
 * What Monitor, Map and Flow render: sessions with their assignment and routes, tool calls and
 * the flow of model and tool phases. Assembled in the GUI from stream rows (`monitor-streams.ts`),
 * all of them stored:
 *
 * ```
 * radar.sessions (host_session_state) ─┐
 * radar.assignments (runner_attempts) ─┤
 * radar.scheduler, radar.workload ─────┼─► assembleLive ─► RadarLive ─► monitor/map/flow models
 * liveHistory toolsOnly (workers) ─────┤
 * radar.nativeCalls (every session) ───┤
 * radar.steps (transcript_steps) ──────┘
 * ```
 *
 * No message text is stored or shown; a call's one-line summary is the stored `detail`.
 */
export type RadarLiveScope = { kind: "session" | "project"; sessionID: string }

export type LiveRoute = {
  id: string
  providerID: string
  modelID: string
  variant: string | null
  source: "attempt-policy" | "session-selection" | "step-event"
  sessionID: string
  messageID: string | null
  observedAt: number | null
}

export type LiveAssignment = {
  planID: string
  taskID: string
  attemptID: string
  state: "preparing" | "running" | "verifying"
  startedAt: number
  attemptNumber?: number
  taskTitle?: string
  taskReference?: string
  task?: { state: string; reason: string | null; planState: string; planReason: string | null }
}

export type LiveSession = {
  id: string
  sessionID: string
  classification: "managed" | "unmanaged"
  parentSessionID?: string
  title?: string
  isViewSession: boolean
  isCurrentArchitect: boolean | null
  availability: "available" | "missing" | "archived" | "moved" | "unavailable"
  freshness: "current" | "stale" | "unknown"
  agent: string | null
  state: "busy" | "idle" | "unknown"
  assignment: LiveAssignment | null
  selectedRouteID: string | null
  configuredRouteID: string | null
  observedRouteID: string | null
  updatedAt: number | null
  observedAt: number | null
  /**
   * The session's stored model phases are still being read (`transcript_sessions` not
   * `available`): its Flow and Messages are not final.
   */
  phasesLoading?: true
}

export type LiveCall = {
  id: string
  sessionID: string
  messageID: string | null
  callID: string
  tool: string | null
  status: "input-started" | "running" | "not-executed" | "succeeded" | "failed" | "unknown"
  inputAt: number | null
  calledAt: number | null
  completedAt: number | null
  observedAt: number | null
  result: string | null
  error: string | null
  fileTargets?: {
    coverage: "observed" | "partial" | "omitted"
    operation: "read" | "edit" | "patch" | null
    paths: string[]
  }
  detail?: string
}

export type LiveFlow = {
  id: string
  kind: "execution" | "model-request" | "model-stream" | "model-response" | "tool-phase"
  sessionID: string
  messageID: string | null
  callID: string | null
  tool: string | null
  routeID: string | null
  status: string
  startedAt: number | null
  observedAt: number
  detail?: string
  usage?: { input: number | null; output: number | null }
}

export type RadarLive = {
  /** Task counts are project-wide: a session view leaves them out. */
  scope: { kind: "session" | "project" | "all"; sessionID?: string }
  /** When the rows were assembled. */
  observedAt: number
  scheduler: {
    status: "scheduled" | "draining" | "registered" | "absent" | "stale" | "unknown"
    participants: number | null
  }
  /** Absent while the project's task list is not indexed: unknown, never zero. */
  workload?: { queued: number; needsYou: number; failed: number }
  sessions: LiveSession[]
  routes: LiveRoute[]
  calls: LiveCall[]
  flow: LiveFlow[]
}

/** A stream row, read by column name. */
export type StreamRow = Record<string, unknown>

export type LiveRows = {
  scope: RadarLiveScope
  projectDirectory: string
  now: number
  includeUnmanagedSessions: boolean
  sessions: readonly StreamRow[]
  assignments: readonly StreamRow[]
  scheduler?: StreamRow
  workload?: StreamRow
  /** `observability.liveHistory` tool rows of a worker's attempt, newest first. */
  calls: ReadonlyMap<string, readonly StreamRow[]>
  /** `radar.nativeCalls` rows, newest first. */
  nativeCalls: ReadonlyMap<string, readonly StreamRow[]>
  /** `radar.steps` rows, newest first. */
  steps: ReadonlyMap<string, readonly StreamRow[]>
  /** Sessions whose stored transcript metadata is not read in full yet. */
  phasesLoading: ReadonlySet<string>
}

const str = (value: unknown) => (typeof value === "string" && value ? value : null)
const num = (value: unknown) => {
  const n = typeof value === "bigint" ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

const SCHEDULER = new Set(["scheduled", "draining", "registered", "absent", "stale"])
const ASSIGNMENT_STATES = new Set(["preparing", "running", "verifying"])
const CALL_STATUS = new Set(["input-started", "running", "not-executed", "succeeded", "failed"])
const FINISHED = new Set(["succeeded", "failed", "not-executed"])
/** A native call not finished and not seen for this long reads as unknown, not running. */
const NATIVE_RUNNING_MS = 600_000

function assignmentOf(row: StreamRow): LiveAssignment | null {
  const state = str(row.state)
  if (!state || !ASSIGNMENT_STATES.has(state)) return null
  const number = num(row.number)
  return {
    planID: String(row.plan_id),
    taskID: String(row.task_id),
    attemptID: String(row.id),
    state: state as LiveAssignment["state"],
    startedAt: num(row.started_at) ?? 0,
    ...(number !== null && number > 0 ? { attemptNumber: number } : {}),
    ...(str(row.title) ? { taskTitle: String(row.title) } : {}),
    ...(str(row.reference) ? { taskReference: String(row.reference) } : {}),
    ...(str(row.node_state)
      ? {
          task: {
            state: String(row.node_state),
            reason: str(row.node_reason),
            planState: String(row.plan_state ?? ""),
            planReason: str(row.plan_reason),
          },
        }
      : {}),
  }
}

type Routes = { list: LiveRoute[]; byKey: Map<string, LiveRoute> }

function addRoute(routes: Routes, route: Omit<LiveRoute, "id">): string {
  const id = `route:${route.source}:${route.sessionID}:${route.messageID ?? ""}:${route.providerID}/${route.modelID}/${route.variant ?? ""}`
  const known = routes.byKey.get(id)
  if (known) {
    if (route.observedAt !== null && (known.observedAt ?? -Infinity) < route.observedAt)
      known.observedAt = route.observedAt
    return id
  }
  const value = { id, ...route }
  routes.byKey.set(id, value)
  routes.list.push(value)
  return id
}

/**
 * Model phases of one session's steps, oldest first, and the route of its newest step. Statuses are
 * the recorder's step statuses (`started`, `streamed`, `ended`, `failed`), as the progress rows had.
 */
function stepFlow(
  sessionID: string,
  steps: readonly StreamRow[],
  routes: Routes,
  flow: LiveFlow[],
) {
  let observedRouteID: string | null = null
  for (const step of steps.toReversed()) {
    const messageID = str(step.message_id)
    const provider = str(step.provider_id)
    const model = str(step.model_id)
    const created = num(step.created_at)
    const routeID =
      provider && model
        ? addRoute(routes, {
            providerID: provider,
            modelID: model,
            variant: str(step.variant),
            source: "step-event",
            sessionID,
            messageID,
            observedAt: created,
          })
        : null
    if (routeID) observedRouteID = routeID
    const base = { sessionID, messageID, callID: null, tool: null, routeID }
    const key = `flow:step:${sessionID}:${messageID ?? String(step.id)}`
    if (created !== null)
      flow.push({
        ...base,
        id: `${key}:request`,
        kind: "model-request",
        status: "started",
        startedAt: created,
        observedAt: created,
      })
    const streamed = num(step.streamed_at)
    if (streamed !== null)
      flow.push({
        ...base,
        id: `${key}:stream`,
        kind: "model-stream",
        status: "streamed",
        startedAt: null,
        observedAt: streamed,
      })
    const completed = num(step.completed_at)
    const failed = str(step.error_type) !== null
    if (completed !== null || failed) {
      const input = num(step.input_tokens)
      const output = num(step.output_tokens)
      flow.push({
        ...base,
        id: `${key}:response`,
        kind: "model-response",
        status: failed ? "failed" : "ended",
        startedAt: null,
        observedAt: completed ?? streamed ?? created ?? 0,
        ...(!failed && (input !== null || output !== null) ? { usage: { input, output } } : {}),
      })
    }
  }
  return observedRouteID
}

type Observation = { eventType?: unknown; at?: unknown; status?: unknown }
const observationsOf = (value: unknown): Observation[] =>
  Array.isArray(value) ? (value as Observation[]) : []

function fileTargetsOf(value: unknown): LiveCall["fileTargets"] {
  const targets = value as { coverage?: unknown; operation?: unknown; paths?: unknown } | null
  if (!targets || !Array.isArray(targets.paths)) return undefined
  const coverage = targets.coverage
  if (coverage !== "observed" && coverage !== "partial" && coverage !== "omitted") return undefined
  const operation = targets.operation
  return {
    coverage,
    operation:
      operation === "read" || operation === "edit" || operation === "patch" ? operation : null,
    paths: targets.paths.filter((path): path is string => typeof path === "string").slice(0, 8),
  }
}

/** A worker's calls from its attempt's tool rows: the newest row of each call is its state. */
function workerCalls(
  sessionID: string,
  rows: readonly StreamRow[],
  details: ReadonlyMap<string, string>,
  calls: LiveCall[],
  flow: LiveFlow[],
) {
  const seen = new Set<string>()
  for (const row of rows) {
    const callID = str(row.call_id)
    if (!callID || seen.has(callID)) continue
    seen.add(callID)
    const observations = observationsOf(row.observations_json)
      .map((item) => ({ ...item, at: num(item.at) }))
      .filter((item) => item.at !== null)
      .toSorted((a, b) => a.at! - b.at!)
    const rawStatus = str(row.status)
    const status = (
      rawStatus && CALL_STATUS.has(rawStatus) ? rawStatus : "unknown"
    ) as LiveCall["status"]
    const at = num(row.at)
    const latestAt = observations.at(-1)?.at ?? num(row.recorded_at) ?? at
    const startedAt = observations[0]?.at ?? at
    const detail = details.get(callID)
    const tool = str(row.tool)
    const fileTargets = fileTargetsOf(row.file_targets_json)
    calls.push({
      id: `call:${sessionID}:${callID}`,
      sessionID,
      messageID: str(row.message_id),
      callID,
      tool,
      status,
      inputAt: startedAt,
      calledAt: null,
      completedAt: FINISHED.has(status) ? latestAt : null,
      observedAt: latestAt,
      result: str(row.result),
      error: str(row.error),
      ...(fileTargets ? { fileTargets } : {}),
      ...(detail ? { detail } : {}),
    })
    const latest = observations.at(-1)
    if (latest && latestAt !== null)
      flow.push({
        id: `flow:tool:${sessionID}:${callID}`,
        kind: "tool-phase",
        sessionID,
        messageID: str(row.message_id),
        callID,
        tool,
        routeID: null,
        status: str(latest.status) ?? status,
        startedAt,
        observedAt: latestAt,
        ...(detail ? { detail } : {}),
      })
  }
}

/** Sessions without a runner assignment: their calls are the canonical per-call records. */
function nativeCalls(
  sessionID: string,
  rows: readonly StreamRow[],
  now: number,
  shorten: (detail: string) => string,
  calls: LiveCall[],
) {
  const seen = new Set<string>()
  for (const row of rows) {
    const callID = str(row.call_id)
    if (!callID || seen.has(callID)) continue
    seen.add(callID)
    const raw = str(row.status)
    const last = num(row.last_observed_at)
    const finished = raw === "succeeded" || raw === "failed"
    const status: LiveCall["status"] = finished
      ? (raw as "succeeded" | "failed")
      : last !== null && now - last <= NATIVE_RUNNING_MS
        ? "running"
        : "unknown"
    const detail = str(row.detail)
    calls.push({
      id: `call:${sessionID}:${callID}`,
      sessionID,
      messageID: str(row.message_id),
      callID,
      tool: str(row.tool),
      status,
      inputAt: num(row.first_observed_at),
      calledAt: null,
      completedAt: finished ? last : null,
      observedAt: last,
      result: null,
      error: str(row.error),
      ...(detail ? { detail: shorten(detail) } : {}),
    })
  }
}

/** The rows of every open stream, as one value the models read. */
export function assembleLive(rows: LiveRows): RadarLive {
  const { scope, now } = rows
  const assignments = new Map<string, StreamRow>()
  for (const row of rows.assignments) {
    const id = str(row.session_id)
    if (id) assignments.set(id, row)
  }
  const routes: Routes = { list: [], byKey: new Map() }
  const calls: LiveCall[] = []
  const flow: LiveFlow[] = []
  const sessions: LiveSession[] = []
  for (const row of rows.sessions) {
    const sessionID = str(row.session_id)
    if (!sessionID) continue
    const attempt = assignments.get(sessionID)
    if (
      scope.kind === "project" &&
      !rows.includeUnmanagedSessions &&
      !attempt &&
      sessionID !== scope.sessionID
    )
      continue
    const assignment = attempt ? assignmentOf(attempt) : null
    const agent = str(row.agent)
    const provider = str(row.route_provider)
    const model = str(row.route_model)
    const selectedRouteID =
      provider && model
        ? addRoute(routes, {
            providerID: provider,
            modelID: model,
            variant: str(row.route_variant),
            source: "session-selection",
            sessionID,
            messageID: null,
            observedAt: num(row.host_updated_at),
          })
        : null
    const policy = attempt ? AttemptModel.safeParse(attempt.model) : undefined
    const configuredRouteID = policy?.success
      ? addRoute(routes, {
          providerID: policy.data.providerID,
          modelID: policy.data.id,
          variant: policy.data.variant ?? null,
          source: "attempt-policy",
          sessionID,
          messageID: null,
          observedAt: null,
        })
      : null
    const observedRouteID = stepFlow(sessionID, rows.steps.get(sessionID) ?? [], routes, flow)
    const directory = str(row.directory)
    const shorten = (detail: string) =>
      relativize(detail, {
        roots: directory ? [directory, rows.projectDirectory] : [rows.projectDirectory],
        worktreesBase: `${rows.projectDirectory}.worktrees`,
      })
    const native = rows.nativeCalls.get(sessionID) ?? []
    if (assignment) {
      const details = new Map<string, string>()
      for (const call of native) {
        const key = str(call.detail_call_id) ?? str(call.call_id)
        const detail = str(call.detail)
        if (key && detail && !details.has(key)) details.set(key, shorten(detail))
      }
      workerCalls(sessionID, rows.calls.get(sessionID) ?? [], details, calls, flow)
    } else nativeCalls(sessionID, native, now, shorten, calls)
    const parent = str(row.parent_session_id)
    const title = str(row.title)?.trim()
    sessions.push({
      id: `session:${sessionID}`,
      sessionID,
      classification: assignment ? "managed" : "unmanaged",
      ...(parent ? { parentSessionID: parent } : {}),
      ...(title ? { title } : {}),
      isViewSession: sessionID === scope.sessionID,
      isCurrentArchitect:
        sessionID !== scope.sessionID || agent === null
          ? null
          : agent.trim().toLocaleLowerCase() === "architect",
      availability: row.archived ? "archived" : "available",
      freshness: "current",
      agent,
      state: row.busy ? "busy" : "idle",
      assignment,
      selectedRouteID,
      configuredRouteID,
      observedRouteID,
      updatedAt: num(row.host_updated_at),
      observedAt: now,
      ...(rows.phasesLoading.has(sessionID) ? { phasesLoading: true as const } : {}),
    })
  }
  const schedulerStatus = str(rows.scheduler?.status)
  const workload = rows.workload
  return {
    scope,
    observedAt: now,
    scheduler: {
      status: (schedulerStatus && SCHEDULER.has(schedulerStatus)
        ? schedulerStatus
        : "unknown") as RadarLive["scheduler"]["status"],
      participants: num(rows.scheduler?.participants),
    },
    ...(workload?.ready
      ? {
          workload: {
            queued: num(workload.queued) ?? 0,
            needsYou: num(workload.needs_you) ?? 0,
            failed: num(workload.failed) ?? 0,
          },
        }
      : {}),
    sessions: sessions.toSorted(compareSessions),
    routes: routes.list,
    calls,
    flow,
  }
}

/** The old read's order: the view's Architect, the view session, managed, busy, then recency. */
function compareSessions(left: LiveSession, right: LiveSession) {
  return (
    Number(right.isCurrentArchitect === true) - Number(left.isCurrentArchitect === true) ||
    Number(right.isViewSession) - Number(left.isViewSession) ||
    Number(right.classification === "managed") - Number(left.classification === "managed") ||
    Number(right.state === "busy") - Number(left.state === "busy") ||
    (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  )
}

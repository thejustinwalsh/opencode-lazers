import type { IconName } from "@opencode/plugin/gui"
import type { LiveCall, LiveFlow, LiveRoute, LiveSession, RadarLive } from "./live-view.ts"
import type { TaskRingGlyph } from "../tasks/row-presentation.ts"
import type { RadarMonitorData } from "./monitor-state.ts"
import { isHeldWorker } from "./worker-hold.ts"

type Live = RadarLive
export type { LiveCall, LiveFlow, LiveSession }

/** One tool call under a session row. Phases and notes are not rows; history shows them. */
export type ActivityLine = {
  kind: "call"
  /** Selection key: a live call record ID, or `flow-call:<callID>` for native-only calls. */
  id: string
  sessionID: string
  callID: string
  tool: string
  status: "starting" | "running" | "completed" | "failed" | "not-run" | "unknown"
  current: boolean
  /** First requested path, only when the call's own input attributes it. */
  target: string | null
  extraTargets: number
  /** What the call ran: its command, file or pattern, as recorded; null for older rows. */
  detail: string | null
  startedAt: number | null
  endedAt: number | null
  error: string | null
  record: LiveCall | null
}

export type SessionActivity = {
  lines: ActivityLine[]
  lastActivityAt: number | null
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

function words(value: string) {
  return value
    .replace(/^lazers[-_]/i, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ")
}

/** Role identity from the native agent name; never from task or model guesses. */
export function sessionRole(session: LiveSession): { label: string; icon: IconName } {
  const agent = session.agent?.trim() ?? ""
  const label =
    session.isCurrentArchitect === true
      ? "Architect"
      : agent
        ? words(agent)
        : session.isViewSession
          ? "This session"
          : session.classification === "managed"
            ? "Worker"
            : "Session"
  const key = `${session.isCurrentArchitect === true ? "architect" : ""} ${agent}`.toLowerCase()
  const icon: IconName = key.includes("architect")
    ? "brain"
    : /implement|build|code|engineer/.test(key)
      ? "code-slash"
      : /review|audit|verif/.test(key)
        ? "glasses"
        : session.isViewSession
          ? "speech-bubble"
          : "bubble-5"
  return { label, icon }
}

/** `LZ-99 · title` from the task record; never a raw id. Null when the read has neither. */
export function sessionTask(session: LiveSession) {
  const assignment = session.assignment
  if (!assignment) return null
  const text = [assignment.taskReference, assignment.taskTitle].filter(Boolean).join(" · ")
  return text || null
}

/** The task's title, falling back to its reference, for the inspector heading. */
export function sessionTaskTitle(session: LiveSession) {
  return session.assignment?.taskTitle ?? session.assignment?.taskReference ?? session.title ?? null
}

/** The lower-case state word, or undefined when the read gives none; the view omits it. */
export function sessionState(session: LiveSession) {
  if (session.availability !== "available") return words(session.availability).toLowerCase()
  const assignment = session.assignment?.state
  const base = assignment
    ? assignment === "verifying"
      ? "checking"
      : assignment
    : session.state === "busy"
      ? "running"
      : session.state === "idle"
        ? "idle"
        : undefined
  if (!base) return undefined
  return session.freshness === "stale" ? `${base} · stale` : base
}

export type SessionTone = "running" | "checking" | "idle" | "away"

/** Visual tone of a session's state: running and checking are blue, the rest neutral. */
export function sessionTone(session: LiveSession): SessionTone {
  if (session.availability !== "available") return "away"
  if (session.assignment?.state === "verifying") return "checking"
  if (session.assignment || session.state === "busy") return "running"
  return session.state === "idle" ? "idle" : "away"
}

/** The ring glyph for a worker row, from the same family as Tasks. */
export function sessionGlyph(session: LiveSession): TaskRingGlyph {
  const tone = sessionTone(session)
  if (tone === "running" || tone === "checking") return "ring-progress"
  return tone === "idle" ? "ring" : "ring-dashed"
}

function modelLabel(route: LiveRoute) {
  return [route.modelID, route.variant].filter(Boolean).join(" · ")
}

/** Observed route first; a configured route is labelled as such, never presented as observed. */
export function sessionModel(live: Live, session: LiveSession) {
  const find = (id: string | null) =>
    id ? live.routes.find((route) => route.id === id) : undefined
  const observed = find(session.observedRouteID)
  if (observed)
    return {
      label: modelLabel(observed),
      model: observed.modelID,
      effort: observed.variant,
      basis: "observed" as const,
      detail: `${observed.providerID} / ${modelLabel(observed)}`,
    }
  const configured = find(session.configuredRouteID) ?? find(session.selectedRouteID)
  if (configured)
    return {
      label: modelLabel(configured),
      model: configured.modelID,
      effort: configured.variant,
      basis: "configured" as const,
      detail: `${configured.providerID} / ${modelLabel(configured)}`,
    }
  return undefined
}

function callStatus(status: string): Extract<ActivityLine, { kind: "call" }>["status"] {
  switch (status) {
    case "input-started":
    case "called":
      return "starting"
    case "running":
      return "running"
    case "succeeded":
      return "completed"
    case "failed":
      return "failed"
    case "not-executed":
      return "not-run"
    default:
      return "unknown"
  }
}

export function callStatusWord(status: Extract<ActivityLine, { kind: "call" }>["status"]) {
  return status === "not-run" ? "not run" : status === "unknown" ? "" : status
}

function callTargets(call: LiveCall) {
  const targets = call.fileTargets
  return targets?.coverage === "observed" && targets.paths.length > 0
    ? { target: targets.paths[0]!, extraTargets: targets.paths.length - 1 }
    : { target: null, extraTargets: 0 }
}

const PHASES: Record<string, { label: string; status: "current" | "ended" | "failed" }> = {
  "request-started": { label: "Model request", status: "current" },
  "response-streamed": { label: "Streaming response", status: "current" },
  "response-ended": { label: "Response received", status: "ended" },
  "text-ended": { label: "Response received", status: "ended" },
  "response-failed": { label: "Model request failed", status: "failed" },
  "execution-started": { label: "Executing", status: "current" },
  "execution-succeeded": { label: "Execution finished", status: "ended" },
  "execution-failed": { label: "Execution failed", status: "failed" },
  "execution-interrupted": { label: "Execution interrupted", status: "failed" },
}

/** Native terminal tool events omit the tool name; borrow it from the same call when known. */
export function flowPhase(item: LiveFlow, live?: Live) {
  if (item.kind === "tool-phase") {
    const tool =
      item.tool ??
      (item.callID && live
        ? live.flow.find((other) => other.callID === item.callID && other.tool)?.tool
        : null) ??
      "Tool"
    return { label: `${tool} ${callStatusWord(callStatus(item.status))}`, status: "ended" as const }
  }
  return (
    PHASES[item.status] ?? {
      label:
        item.kind === "model-request"
          ? "Model request"
          : item.kind === "model-stream"
            ? "Streaming response"
            : item.kind === "model-response"
              ? "Response received"
              : "Execution",
      status: "ended" as const,
    }
  )
}

const callTime = (call: LiveCall) => call.inputAt ?? call.calledAt ?? call.observedAt

/** Calls from runner records; sessions without them fall back to native tool phases by call ID. */
export function sessionCallLines(live: Live, sessionID: string) {
  const recorded = live.calls.filter((call) => call.sessionID === sessionID)
  if (recorded.length > 0)
    return recorded.map((call): Extract<ActivityLine, { kind: "call" }> => {
      const status = callStatus(call.status)
      return {
        kind: "call",
        id: call.id,
        sessionID,
        callID: call.callID,
        tool: call.tool ?? "Tool",
        status,
        current: status === "starting" || status === "running",
        ...callTargets(call),
        detail: call.detail ?? null,
        startedAt: callTime(call),
        endedAt: call.completedAt,
        error: call.error,
        record: call,
      }
    })
  const byCall = new Map<string, LiveFlow[]>()
  for (const item of live.flow)
    if (item.sessionID === sessionID && item.kind === "tool-phase" && item.callID)
      byCall.set(item.callID, [...(byCall.get(item.callID) ?? []), item])
  return [...byCall].map(([callID, items]): Extract<ActivityLine, { kind: "call" }> => {
    const latest = items.reduce((left, right) =>
      right.observedAt > left.observedAt ? right : left,
    )
    const status = callStatus(latest.status)
    const starts = items.map((item) => item.startedAt).filter(finite)
    const current = status === "starting" || status === "running"
    return {
      kind: "call",
      id: `flow-call:${callID}`,
      sessionID,
      callID,
      tool: latest.tool ?? items.find((item) => item.tool)?.tool ?? "Tool",
      status,
      current,
      target: null,
      extraTargets: 0,
      detail: items.find((item) => item.detail)?.detail ?? null,
      startedAt: starts.length ? Math.min(...starts) : null,
      endedAt: current ? null : latest.observedAt,
      error: null,
      record: null,
    }
  })
}

/**
 * Current calls stay distinct; the latest finished call shows what just happened. A session with
 * neither shows nothing under its row.
 */
export function sessionActivity(live: Live, session: LiveSession): SessionActivity {
  const sessionID = session.sessionID
  const calls = sessionCallLines(live, sessionID)
  const current = calls.filter((call) => call.current)
  const finished = calls
    .filter((call) => !call.current)
    .toSorted((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0))
  const latestFinished = current.length < 3 ? finished[0] : undefined
  const lines = [...current, ...(latestFinished ? [latestFinished] : [])].toSorted(
    (left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0),
  )
  const flow = live.flow.filter((item) => item.sessionID === sessionID)
  const times = [
    session.updatedAt,
    ...calls.flatMap((call) => [call.startedAt, call.endedAt, call.record?.observedAt]),
    ...flow.map((item) => item.observedAt),
  ].filter(finite)
  return { lines, lastActivityAt: times.length ? Math.max(...times) : null }
}

/** Recorded-state rank: active or assigned work leads, then idle, then unknown. */
function sessionRank(session: LiveSession) {
  if (session.state === "busy" || session.assignment) return 0
  return session.state === "idle" ? 1 : 2
}

/**
 * The current Architect always leads. Other available sessions follow in recorded-state order;
 * the server's order is kept within a rank so rows only move when their state changes. A session
 * nests under its recorded native parent when that parent is in the read. An assigned session whose
 * parent is not reported at all nests under the current Architect. Sessions without live data are
 * not rows: they have nothing to show.
 */
export function sessionGroups(live: Live, include?: ReadonlySet<string>) {
  const available = live.sessions.filter(
    (session) =>
      session.availability === "available" && (!include || include.has(session.sessionID)),
  )
  const ranked = available
    .map((session, index) => ({ session, index }))
    .toSorted(
      (left, right) =>
        Number(right.session.isCurrentArchitect === true) -
          Number(left.session.isCurrentArchitect === true) ||
        sessionRank(left.session) - sessionRank(right.session) ||
        left.index - right.index,
    )
    .map(({ session }) => session)
  const byID = new Map(ranked.map((session) => [session.sessionID, session]))
  const architect = ranked.find((session) => session.isCurrentArchitect === true)
  const parentOf = (session: LiveSession) => {
    const reported = session.parentSessionID
    if (reported !== undefined && byID.has(reported) && reported !== session.sessionID)
      return reported
    // No parent in the read, whether unreported or outside it: assigned work sits under the Architect.
    return architect !== undefined && session !== architect && session.assignment !== null
      ? architect.sessionID
      : undefined
  }
  // A parent chain that loops back to the session would hide it; such a session stays top-level.
  const loops = (session: LiveSession) => {
    const seen = new Set([session.sessionID])
    for (let id = parentOf(session); id !== undefined; id = parentOf(byID.get(id)!)) {
      if (seen.has(id)) return true
      seen.add(id)
    }
    return false
  }
  const parents = new Map(
    ranked.flatMap((session) => {
      const parent = loops(session) ? undefined : parentOf(session)
      return parent === undefined ? [] : [[session.sessionID, parent] as const]
    }),
  )
  const children = new Map<string, string[]>()
  for (const session of ranked) {
    const parent = parents.get(session.sessionID)
    if (parent !== undefined)
      children.set(parent, [...(children.get(parent) ?? []), session.sessionID])
  }
  return {
    leading: ranked
      .filter((session) => !parents.has(session.sessionID))
      .map((session) => session.sessionID),
    children,
    parents,
  }
}

export type SummarySegment = { count: number; word: string }

/**
 * Task counts follow the selected scope. The runner records them for the whole project, so in
 * session scope they cannot be attributed to one session and are left out.
 */
export function scopedWorkload(live: Live) {
  return live.scope.kind === "session" ? undefined : live.workload
}

/**
 * Running counts workers: sessions with a runner assignment that are running or preparing, and
 * those checking. A busy Architect is visible on its own row and is not counted here.
 */
function runningCounts(live: Live) {
  const workers = live.sessions.filter(
    (session) => session.availability === "available" && session.assignment !== null,
  )
  // A held, waiting or interrupted task is not running, whatever its attempt row still says.
  const working = workers.filter((session) => !isHeldWorker(session))
  const verifying = working.filter((session) => session.assignment?.state === "verifying").length
  return { running: working.length - verifying, verifying, held: workers.length - working.length }
}

/**
 * The one line under the header: running, needs you, failed, queued. Each segment appears only
 * when its number is present and non-zero. The queue, failure and attention counts come from the
 * recorded task states in the live read's `workload`; capacity is not recorded by the runtime, so
 * it never appears. Data gaps are not a summary segment.
 */
export function monitorSegments(live: Live): SummarySegment[] {
  const { running, verifying, held } = runningCounts(live)
  const workload = scopedWorkload(live)
  return [
    { count: running + verifying, word: "running" },
    { count: held, word: "waiting" },
    { count: workload?.needsYou ?? 0, word: "needs you" },
    { count: workload?.failed ?? 0, word: "failed" },
    { count: workload?.queued ?? 0, word: "queued" },
  ].filter((segment) => segment.count > 0)
}

/** Flow's line: what is moving. Verifying counts as running, and the queue is not shown. */
export function flowSegments(live: Live): SummarySegment[] {
  const { running, verifying } = runningCounts(live)
  return [
    { count: running + verifying, word: "running" },
    { count: scopedWorkload(live)?.needsYou ?? 0, word: "needs you" },
    { count: scopedWorkload(live)?.failed ?? 0, word: "failed" },
  ].filter((segment) => segment.count > 0)
}

/** How recent a failure or a finished call must be for an otherwise idle session to count. */
const ACTIVE_WINDOW_MS = 120_000

/**
 * A session is active when it is running, checking, preparing or busy, has a call in progress
 * (which includes waiting on you), or has finished a call or started a model request in the last
 * two minutes, so a recent failure stays visible. Everything else is idle.
 */
export function sessionActive(live: Live, session: LiveSession, now: number) {
  if (session.availability !== "available") return false
  if (session.assignment !== null || session.state === "busy") return true
  const recent = (at: number | null) => at !== null && now - at <= ACTIVE_WINDOW_MS
  const calls = sessionCallLines(live, session.sessionID)
  if (calls.some((call) => call.current || recent(call.endedAt))) return true
  return live.flow.some(
    (item) =>
      item.sessionID === session.sessionID &&
      item.kind === "model-request" &&
      recent(item.startedAt ?? item.observedAt),
  )
}

/**
 * Which sessions Monitor, Map and Flow list. A family (a root session and its descendants) shows
 * when any member is active; inside it the root always shows and idle descendants do not. A
 * family with no active member is hidden whole. The selected session is never hidden. With
 * `showIdle` every available session shows. `hidden` always counts what the default hides.
 */
export function visibleSessions(
  live: Live,
  now: number,
  options: { showIdle?: boolean; selectedID?: string | null } = {},
) {
  const groups = sessionGroups(live)
  const available = live.sessions.filter((session) => session.availability === "available")
  const byID = new Map(available.map((session) => [session.sessionID, session]))
  const active = new Set(
    available.filter((session) => sessionActive(live, session, now)).map((s) => s.sessionID),
  )
  const keep = new Set<string>()
  const keepWithAncestors = (id: string) => {
    for (
      let at: string | undefined = id;
      at !== undefined && !keep.has(at);
      at = groups.parents.get(at)
    )
      keep.add(at)
  }
  for (const id of active) keepWithAncestors(id)
  // Roots of a shown family stay even when idle; ancestors above are already kept.
  const selected = options.selectedID
  if (selected && byID.has(selected)) keepWithAncestors(selected)
  const shown = options.showIdle ? new Set(available.map((session) => session.sessionID)) : keep
  return {
    shown,
    active,
    hidden: available.filter((session) => !keep.has(session.sessionID)).length,
  }
}

/** What is true when nothing is running, in one plain sentence. */
export function idleSentence(live: Live) {
  const architect = live.sessions.find(
    (session) => session.availability === "available" && session.isCurrentArchitect === true,
  )
  const base =
    architect && architect.state === "idle"
      ? "Architect is idle and no workers are active."
      : "No sessions are running."
  const queued = scopedWorkload(live)?.queued ?? 0
  return queued > 0 ? `${base} ${queued} ${queued === 1 ? "task is" : "tasks are"} queued.` : base
}

/** True when no available session is running or verifying work. */
export function nothingRunning(live: Live) {
  const { running, verifying } = runningCounts(live)
  return running === 0 && verifying === 0
}

export type ConnectionChip = {
  word: "Live" | "Reconnecting" | "Offline"
  state: "live" | "reconnecting" | "offline"
  detail: string
}

/** Exactly three values. "Live" is a state, not a success; it is never green. */
export function connectionChip(
  kind: "live" | "reconnecting" | "offline",
  lastUpdate?: number,
): ConnectionChip {
  const last = finite(lastUpdate) ? ` Last update ${clockTime(lastUpdate)}.` : ""
  if (kind === "offline")
    return { word: "Offline", state: "offline", detail: `Server disconnected.${last}` }
  if (kind === "reconnecting")
    return {
      word: "Reconnecting",
      state: "reconnecting",
      detail: `Live updates reconnecting.${last}`,
    }
  return { word: "Live", state: "live", detail: `Live updates connected.${last}` }
}

export function connectionStatus(data: RadarMonitorData): ConnectionChip {
  const last = data.live?.observedAt
  if (data.connection === "disconnected") return connectionChip("offline", last)
  if (data.readError && !data.live) return connectionChip("offline", last)
  if (data.connection === "reconnecting" || data.connection === "connecting")
    return connectionChip("reconnecting", last)
  if (data.readError) return connectionChip("reconnecting", last)
  return connectionChip("live", last)
}

export function clockTime(value: number | null | undefined) {
  if (!finite(value)) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

/** `1:35:27`: the list form of a clock time, without AM/PM; the tooltip carries the full time. */
export function clockCompact(value: number | null | undefined) {
  return clockTime(value)
    .replace(/^0/, "")
    .replace(/\s?[AP]M$/i, "")
}

/** `5:43 PM`: a time of day to the minute, for facts lines. */
export function clockMinutes(value: number | null | undefined) {
  if (!finite(value)) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

export function formatDuration(milliseconds: number) {
  const value = Math.max(0, milliseconds)
  if (value < 10_000) return `${(Math.floor(value / 100) / 10).toFixed(1)}s`
  const seconds = Math.floor(value / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export function formatAge(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 5) return "now"
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

const TOOL_ICONS: Array<[RegExp, IconName]> = [
  [/^(read|view|cat)$/i, "file-document"],
  [/edit|patch|write|apply/i, "edit"],
  [/bash|shell|exec|run|command|check/i, "console"],
  [/grep|glob|search|find|list|ls/i, "magnifying-glass"],
  [/web|fetch|browse/i, "globe"],
  [/task|agent/i, "task"],
]

function toolIcon(tool: string | null): IconName {
  if (!tool) return "settings-gear"
  return TOOL_ICONS.find(([pattern]) => pattern.test(tool))?.[1] ?? "settings-gear"
}

export function flowIcon(item: LiveFlow): IconName {
  if (item.kind === "tool-phase") return toolIcon(item.tool)
  if (item.kind === "execution") return "console"
  return "models"
}

/** `0:42` for a running call's live timer; `1:05:03` past an hour. */
export function formatTimer(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}

/** One call row: tool, argument, and the call's own icon. Failed calls show their error. */
/** What a call ran: the recorded command or file, else its first file target; null if neither. */
export function callSummary(line: ActivityLine) {
  if (line.detail) return line.detail
  return line.target
    ? `${line.target}${line.extraTargets > 0 ? ` +${line.extraTargets}` : ""}`
    : null
}

export function callRow(line: ActivityLine) {
  const failed = line.status === "failed"
  const argument = failed ? (line.error ?? callSummary(line)) : callSummary(line)
  return {
    tool: line.tool,
    argument,
    failed,
    current: line.current,
    icon: toolIcon(line.tool),
  }
}

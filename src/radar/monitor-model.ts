import type { IconName } from "@opencode/plugin/gui"
import type { LiveRadarResponse } from "../observability/contract.ts"
import type { RadarMonitorData } from "./monitor-state.ts"

type Live = LiveRadarResponse
export type LiveSession = Live["sessions"][number]
export type LiveCall = Live["calls"][number]
export type LiveFlow = Live["flow"][number]
type LiveRoute = Live["routes"][number]

/** One activity line under a session row: a tool call or a model/execution phase. */
export type ActivityLine =
  | {
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
      targetNote: string | null
      startedAt: number | null
      endedAt: number | null
      error: string | null
      record: LiveCall | null
    }
  | {
      kind: "phase"
      id: string
      sessionID: string
      label: string
      status: "current" | "ended" | "failed"
      current: boolean
      startedAt: number | null
      endedAt: number | null
      flow: LiveFlow
    }
  | { kind: "note"; id: string; sessionID: string; label: string }

export type SessionActivity = {
  lines: ActivityLine[]
  lastActivityAt: number | null
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

export function shortID(value: string, length = 8) {
  return value.length > length + 2 ? `${value.slice(0, length)}…` : value
}

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
  return session.assignment?.taskTitle ?? session.assignment?.taskReference ?? null
}

/** The state word, or undefined when the read gives none; the view omits the segment. */
export function sessionState(session: LiveSession) {
  if (session.availability !== "available") return words(session.availability)
  const base = session.assignment
    ? words(session.assignment.state)
    : session.state === "busy"
      ? "Busy"
      : session.state === "idle"
        ? "Idle"
        : undefined
  if (!base) return undefined
  return session.freshness === "stale" ? `${base} · stale` : base
}

/** Visual tone of a session's state: running work, idle, or away. */
export function sessionTone(session: LiveSession): "running" | "idle" | "away" {
  if (session.availability !== "available") return "away"
  if (session.assignment || session.state === "busy") return "running"
  return session.state === "idle" ? "idle" : "away"
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
      basis: "observed" as const,
      detail: `${observed.providerID} / ${modelLabel(observed)}`,
    }
  const configured = find(session.configuredRouteID) ?? find(session.selectedRouteID)
  if (configured)
    return {
      label: modelLabel(configured),
      basis: "configured" as const,
      detail: `${configured.providerID} / ${modelLabel(configured)}`,
    }
  return undefined
}

export function routeDetail(live: Live, routeID: string | null) {
  const route = routeID ? live.routes.find((candidate) => candidate.id === routeID) : undefined
  return route ? `${route.providerID} / ${modelLabel(route)}` : null
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
  if (!targets) return { target: null, extraTargets: 0, targetNote: null }
  if (targets.coverage === "observed" && targets.paths.length > 0)
    return {
      target: targets.paths[0]!,
      extraTargets: targets.paths.length - 1,
      targetNote: null,
    }
  return {
    target: null,
    extraTargets: 0,
    targetNote:
      targets.coverage === "partial" ? "File targets partly recorded" : "File target not recorded",
  }
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
      targetNote: null,
      startedAt: starts.length ? Math.min(...starts) : null,
      endedAt: current ? null : latest.observedAt,
      error: null,
      record: null,
    }
  })
}

/**
 * Current calls stay distinct; the latest finished call shows what just happened. A busy session
 * with no current call or phase says so instead of implying progress.
 */
export function sessionActivity(live: Live, session: LiveSession): SessionActivity {
  const sessionID = session.sessionID
  const calls = sessionCallLines(live, sessionID)
  const current = calls.filter((call) => call.current)
  const finished = calls
    .filter((call) => !call.current)
    .toSorted((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0))
  const latestFinished = current.length < 3 ? finished[0] : undefined
  const lines: ActivityLine[] = [...current, ...(latestFinished ? [latestFinished] : [])].toSorted(
    (left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0),
  )

  const flow = live.flow.filter((item) => item.sessionID === sessionID)
  const latestPhase = flow
    .filter((item) => item.kind !== "tool-phase")
    .reduce<LiveFlow | undefined>(
      (latest, item) => (!latest || item.observedAt > latest.observedAt ? item : latest),
      undefined,
    )
  if (latestPhase) {
    const phase = flowPhase(latestPhase)
    if (phase.status !== "ended" && current.length === 0)
      lines.push({
        kind: "phase",
        id: latestPhase.id,
        sessionID,
        label: phase.label,
        status: phase.status,
        current: phase.status === "current",
        startedAt: latestPhase.startedAt ?? latestPhase.observedAt,
        endedAt: phase.status === "current" ? null : latestPhase.observedAt,
        flow: latestPhase,
      })
  }
  if (session.state === "busy" && !lines.some((line) => "current" in line && line.current))
    lines.push({
      kind: "note",
      id: `note:${sessionID}`,
      sessionID,
      label: "Busy · no call in progress",
    })

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
 * Available sessions lead in recorded-state order; the server's order is kept within a rank so
 * rows only move when their state changes. A session nests under its recorded native parent when
 * that parent is in the read. Only a session whose parent is not reported at all falls back to
 * nesting under the current Architect. Unavailable (historical) sessions are grouped apart.
 */
export function sessionGroups(live: Live) {
  const available = live.sessions.filter((session) => session.availability === "available")
  const ranked = available
    .map((session, index) => ({ session, index }))
    .toSorted(
      (left, right) =>
        sessionRank(left.session) - sessionRank(right.session) || left.index - right.index,
    )
    .map(({ session }) => session)
  const byID = new Map(ranked.map((session) => [session.sessionID, session]))
  const architect = ranked.find((session) => session.isCurrentArchitect === true)
  const parentOf = (session: LiveSession) => {
    const reported = session.parentSessionID
    if (reported !== undefined)
      return byID.has(reported) && reported !== session.sessionID ? reported : undefined
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
    unavailable: live.sessions
      .filter((session) => session.availability !== "available")
      .map((session) => session.sessionID),
  }
}

export type SummarySegment = { count: number; word: string }

function runningCounts(live: Live) {
  const available = live.sessions.filter((session) => session.availability === "available")
  const verifying = available.filter((session) => session.assignment?.state === "verifying").length
  const running = available.filter(
    (session) =>
      session.assignment?.state !== "verifying" &&
      (session.assignment !== null || session.state === "busy"),
  ).length
  return { running, verifying }
}

/**
 * The one line under the header: running, needs you, failed, queued. Each segment appears only
 * when its number is present and non-zero. The queue, failure and attention counts come from the
 * recorded task states in the live read's `workload`; capacity is not recorded by the runtime, so
 * it never appears.
 */
export function monitorSegments(live: Live): SummarySegment[] {
  const { running, verifying } = runningCounts(live)
  const workload = live.workload
  const gaps = coverageGaps(live).length
  return [
    { count: running, word: "running" },
    { count: verifying, word: "verifying" },
    { count: workload?.needsYou ?? 0, word: "needs you" },
    { count: workload?.failed ?? 0, word: "failed" },
    { count: workload?.queued ?? 0, word: "queued" },
    { count: gaps, word: gaps === 1 ? "data gap" : "data gaps" },
  ].filter((segment) => segment.count > 0)
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
  const queued = live.workload?.queued ?? 0
  return queued > 0 ? `${base} ${queued} ${queued === 1 ? "task is" : "tasks are"} queued.` : base
}

/** True when no available session is running or verifying work. */
export function nothingRunning(live: Live) {
  const { running, verifying } = runningCounts(live)
  return running === 0 && verifying === 0
}

export function coverageGaps(live: Live) {
  const coverage = live.coverage
  return [
    coverage.inventoryTruncated && "sessions",
    coverage.assignmentTruncated && "assignments",
    coverage.progressTruncated && "progress",
    coverage.payloadTruncated && "payloads",
    coverage.callsTruncated && "calls",
    coverage.flowTruncated && "activity",
    coverage.routeTruncated && "routes",
    coverage.journalTruncated && "journal",
  ].filter((value): value is string => Boolean(value))
}

export function recentFlow(live: Live, limit = 8) {
  return live.flow.toSorted((left, right) => right.observedAt - left.observedAt).slice(0, limit)
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
  [/bash|shell|exec|run|command/i, "console"],
  [/grep|glob|search|find|list|ls/i, "magnifying-glass"],
  [/web|fetch|browse/i, "globe"],
  [/task|agent/i, "task"],
]

export function toolIcon(tool: string | null): IconName {
  if (!tool) return "settings-gear"
  return TOOL_ICONS.find(([pattern]) => pattern.test(tool))?.[1] ?? "settings-gear"
}

export function flowIcon(item: LiveFlow): IconName {
  if (item.kind === "tool-phase") return toolIcon(item.tool)
  if (item.kind === "execution") return "console"
  return "models"
}

/** Flat presentation of an activity line, so the view never switches on its kind. */
export function lineView(line: ActivityLine) {
  if (line.kind === "call")
    return {
      label: `${line.tool} ${callStatusWord(line.status)}`,
      status: line.status,
      current: line.current,
      icon: line.status === "failed" ? ("warning" as IconName) : toolIcon(line.tool),
      target: line.target,
      extraTargets: line.extraTargets,
      targetNote: line.targetNote,
      error: line.error,
      selectable: true,
    }
  if (line.kind === "phase")
    return {
      label: line.label,
      status: line.status,
      current: line.current,
      icon: line.status === "failed" ? ("warning" as IconName) : ("models" as IconName),
      target: null,
      extraTargets: 0,
      targetNote: null,
      error: null,
      selectable: true,
    }
  return {
    label: line.label,
    status: "note",
    current: false,
    icon: "info" as IconName,
    target: null,
    extraTargets: 0,
    targetNote: null,
    error: null,
    selectable: false,
  }
}

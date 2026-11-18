import { linearAxis } from "./axis.ts"
import { isActiveAttemptState } from "./projection.ts"
import type { Timeline, TrajectoryEvent } from "./projection.ts"

/** Recorded outcome vocabulary shared by every track; each value has its own glyph. */
export type Outcome = "succeeded" | "failed" | "running" | "unknown"

export type ToolMark = {
  /** Event identity used for selection; prefers the LAZERS progress fact. */
  id: string
  /** Other loaded event identities describing the same native call. */
  aliases: string[]
  attemptID: string | null
  sessionID: string | null
  callID: string | null
  tool: string
  outcome: Outcome
  start: number | null
  end: number | null
  /** Placement time: start, otherwise the recorded end. */
  at: number
  startSource: string | null
  endSource: string | null
  left: number
  width: number
  files: FileTargets | null
}

export type FileTargets = NonNullable<TrajectoryEvent["fileTargets"]>

export type FileMark = {
  id: string
  attemptID: string | null
  operation: "read" | "edit" | "patch"
  coverage: FileTargets["coverage"]
  paths: string[]
  tool: string
  outcome: Outcome
  at: number
  left: number
}

export type GapMark = {
  id: string
  attemptID: string | null
  kind: "gap" | "compaction"
  label: string
  at: number
  left: number
}

export type Tracks = {
  tools: ToolMark[]
  files: FileMark[]
  gaps: GapMark[]
  /** Distinct recorded calls that carry no time and so are not placed. */
  untimedTools: number
  /** File-target records whose paths were omitted by the recorder. */
  omittedFileTargets: number
  /** Percent of the axis after which captured events are not loaded yet. */
  loadedThrough: number | null
}

const SUCCEEDED = new Set(["succeeded", "completed"])
const FAILED = new Set(["failed", "error"])
const RUNNING = new Set(["running", "streaming", "pending", "started"])

/** A non-terminal call in a finished attempt has no recorded result; it is not running. */
export function toolOutcome(status: string | null | undefined, attemptActive: boolean): Outcome {
  if (!status) return "unknown"
  if (SUCCEEDED.has(status)) return "succeeded"
  if (FAILED.has(status)) return "failed"
  if (RUNNING.has(status)) return attemptActive ? "running" : "unknown"
  return "unknown"
}

/** Attempt and check outcome for glyphs; text keeps the exact recorded state. */
export function attemptOutcome(state: string): Outcome {
  if (state === "failed") return "failed"
  if (state === "completed" || state === "accepted" || state === "succeeded") return "succeeded"
  if (isActiveAttemptState(state)) return "running"
  return "unknown"
}

export function checkOutcome(result: string, state: string): Outcome {
  if (result === "passed") return "succeeded"
  if (result === "failed") return "failed"
  if (state === "running" || state === "pending" || state === "started") return "running"
  return "unknown"
}

export const outcomeText: Record<Outcome, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  running: "Running",
  /** No recorded outcome: nothing is said about it. */
  unknown: "",
}

function endpoint(event: TrajectoryEvent, key: string) {
  const value = event.timing?.endpoints[key]
  return value && typeof value.at === "number" && Number.isFinite(value.at)
    ? { at: value.at, source: value.sourceType ?? value.source ?? null }
    : null
}

function nativeCallID(event: TrajectoryEvent) {
  const marker = event.id.indexOf(":tool:")
  return marker < 0 ? null : event.id.slice(marker + ":tool:".length) || null
}

type Call = {
  primary: TrajectoryEvent
  events: TrajectoryEvent[]
}

function callKey(event: TrajectoryEvent) {
  const callID = event.kind === "worker-tool" ? (event.callID ?? null) : nativeCallID(event)
  return callID && event.sessionID ? `${event.sessionID}\u0000${callID}` : `event\u0000${event.id}`
}

function firstTime(events: TrajectoryEvent[], read: (event: TrajectoryEvent) => Endpoint | null) {
  for (const event of events) {
    const value = read(event)
    if (value) return value
  }
  return null
}
type Endpoint = { at: number; source: string | null }

const startOf = (event: TrajectoryEvent): Endpoint | null =>
  endpoint(event, "calledAt") ??
  endpoint(event, "inputAt") ??
  (typeof event.at === "number" && Number.isFinite(event.at)
    ? { at: event.at, source: event.kind === "tool" ? "native tool call time" : "recorded at" }
    : null)

const endOf = (event: TrajectoryEvent): Endpoint | null =>
  endpoint(event, "completedAt") ??
  (typeof event.completedAt === "number" && Number.isFinite(event.completedAt)
    ? { at: event.completedAt, source: "recorded completion" }
    : null)

function mergedOutcome(events: TrajectoryEvent[], attemptActive: boolean): Outcome {
  const outcomes = events.map((event) => toolOutcome(event.status, attemptActive))
  if (outcomes.includes("failed")) return "failed"
  if (outcomes.includes("succeeded")) return "succeeded"
  if (outcomes.includes("running")) return "running"
  return "unknown"
}

/**
 * Projects loaded captured and live events onto the shared timeline. Native context tool
 * events and LAZERS progress facts for the same `sessionID + callID` become one mark.
 */
export function buildTracks(
  timeline: Pick<Timeline, "origin" | "durationMs" | "axis">,
  events: readonly TrajectoryEvent[],
  attemptStates: ReadonlyMap<string, string>,
  pendingAfter: number | null = null,
): Tracks {
  const origin = timeline.origin
  const duration = timeline.durationMs
  const axis = timeline.axis ?? linearAxis(duration)
  const left = (at: number) => (origin === null || duration <= 0 ? 0 : axis.place(at - origin))

  const calls = new Map<string, Call>()
  const gaps: GapMark[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    if (event.kind === "tool" || event.kind === "worker-tool") {
      const key = callKey(event)
      const call = calls.get(key)
      if (!call) calls.set(key, { primary: event, events: [event] })
      else {
        call.events.push(event)
        if (event.kind === "worker-tool" && call.primary.kind !== "worker-tool")
          call.primary = event
      }
    } else if (
      (event.kind === "worker-gap" || event.kind === "compaction") &&
      typeof event.at === "number"
    ) {
      gaps.push({
        id: event.id,
        attemptID: event.attemptID ?? null,
        kind: event.kind === "compaction" ? "compaction" : "gap",
        label:
          event.kind === "compaction"
            ? "Context compacted"
            : `Recording gap${event.reason ? ` · ${event.reason}` : ""}`,
        at: event.at,
        left: left(event.at),
      })
    }
  }

  const tools: ToolMark[] = []
  let untimedTools = 0
  let omittedFileTargets = 0
  for (const call of calls.values()) {
    const primary = call.primary
    // The progress fact first: it carries LAZERS-recorded hook timing and file targets.
    const ordered = [primary, ...call.events.filter((event) => event !== primary)]
    const start = firstTime(ordered, startOf)
    const end = firstTime(ordered, endOf)
    const at = start?.at ?? end?.at ?? null
    if (at === null) {
      untimedTools++
      continue
    }
    const attemptID = ordered.find((event) => event.attemptID)?.attemptID ?? null
    const active = attemptID ? isActiveAttemptState(attemptStates.get(attemptID) ?? "") : false
    const files = ordered.find((event) => event.fileTargets)?.fileTargets ?? null
    if (files && files.paths.length === 0) omittedFileTargets++
    const startLeft = left(at)
    tools.push({
      id: primary.id,
      aliases: ordered.slice(1).map((event) => event.id),
      attemptID,
      sessionID: ordered.find((event) => event.sessionID)?.sessionID ?? null,
      callID: primary.kind === "worker-tool" ? (primary.callID ?? null) : nativeCallID(primary),
      tool: ordered.find((event) => event.tool)?.tool ?? "Tool",
      outcome: mergedOutcome(ordered, active),
      start: start?.at ?? null,
      end: end?.at ?? null,
      at,
      startSource: start?.source ?? null,
      endSource: end?.source ?? null,
      left: startLeft,
      width: start && end && end.at >= start.at ? Math.max(0, left(end.at) - startLeft) : 0,
      files,
    })
  }
  const byTime = <T extends { at: number; id: string }>(a: T, b: T) =>
    a.at - b.at || a.id.localeCompare(b.id)
  tools.sort(byTime)
  gaps.sort(byTime)

  const files: FileMark[] = tools.flatMap((tool) =>
    tool.files && tool.files.operation && tool.files.paths.length > 0
      ? [
          {
            id: tool.id,
            attemptID: tool.attemptID,
            operation: tool.files.operation,
            coverage: tool.files.coverage,
            paths: tool.files.paths,
            tool: tool.tool,
            outcome: tool.outcome,
            at: tool.at,
            left: tool.left,
          },
        ]
      : [],
  )

  return {
    tools,
    files,
    gaps,
    untimedTools,
    omittedFileTargets,
    loadedThrough: pendingAfter === null ? null : left(pendingAfter),
  }
}

/** Latest timestamp among loaded captured events; later captured pages are not loaded. */
export function loadedEventHorizon(events: readonly TrajectoryEvent[]) {
  let latest: number | null = null
  for (const event of events)
    if (typeof event.at === "number" && Number.isFinite(event.at))
      latest = latest === null ? event.at : Math.max(latest, event.at)
  return latest
}

/** Roving-focus target inside one horizontal track. */
export function neighborMark<T extends { id: string }>(
  marks: readonly T[],
  currentID: string | null,
  key: string,
): T | undefined {
  if (marks.length === 0) return undefined
  const index = currentID === null ? -1 : marks.findIndex((mark) => mark.id === currentID)
  if (key === "Home") return marks[0]
  if (key === "End") return marks.at(-1)
  if (key === "ArrowRight" || key === "ArrowDown")
    return marks[index < 0 ? 0 : Math.min(marks.length - 1, index + 1)]
  if (key === "ArrowLeft" || key === "ArrowUp")
    return marks[index < 0 ? marks.length - 1 : Math.max(0, index - 1)]
  if (key === "PageDown") return marks[index < 0 ? 0 : Math.min(marks.length - 1, index + 10)]
  if (key === "PageUp") return marks[index < 0 ? 0 : Math.max(0, index - 10)]
  return undefined
}

/** Closest mark to a pointer position, for wide hit targets on dense tracks. */
export function nearestMark<T extends { left: number; width?: number }>(
  marks: readonly T[],
  percent: number,
  tolerance: number,
): T | undefined {
  let best: T | undefined
  let bestDistance = Infinity
  for (const mark of marks) {
    const end = mark.left + (mark.width ?? 0)
    const distance = percent < mark.left ? mark.left - percent : percent > end ? percent - end : 0
    if (distance < bestDistance) {
      best = mark
      bestDistance = distance
    }
  }
  return bestDistance <= tolerance ? best : undefined
}

export const ZOOM_LEVELS = [1, 2, 4, 8, 16, 32] as const
export function nextZoom(current: number, direction: 1 | -1) {
  const index = ZOOM_LEVELS.findIndex((level) => level >= current)
  const at = index < 0 ? ZOOM_LEVELS.length - 1 : index
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, at + direction))]!
}

/** Recorded tool and gap times that the shared axis must cover. */
export function trackTimes(events: readonly TrajectoryEvent[]) {
  const times: number[] = []
  for (const event of events) {
    if (event.kind !== "tool" && event.kind !== "worker-tool" && event.kind !== "worker-gap")
      continue
    const start = startOf(event)
    const end = endOf(event)
    if (start) times.push(start.at)
    if (end) times.push(end.at)
  }
  return times
}

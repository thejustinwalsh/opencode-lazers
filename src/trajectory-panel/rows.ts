import { Check, Event, Model } from "./projection.ts"
import type {
  RecordedAttempt,
  RecordedCheck,
  TaskChoice,
  TrajectoryAttempt,
  TrajectoryCheck,
  TrajectoryEvent,
  TrajectoryReport,
} from "./projection.ts"
import { isActiveAttemptState } from "./projection.ts"
import { listRowOf } from "../tasks/task-row.ts"

/**
 * The view's data, built from stream rows. A row carries only what the stream's columns name; a
 * value the row does not hold is omitted, never filled with a placeholder.
 */
type Raw = Record<string, unknown>

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined)
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined
const defined = <T extends Raw>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T

/** The id of the event a timeline row stands for: the old read's id, so selection and joins agree. */
export function timelineEventID(row: Raw) {
  const kind = text(row.kind)
  const message = text(row.message_id)
  if (kind === "tool" && message && text(row.call_id)) return `${message}:tool:${row.call_id}`
  if (kind === "assistant-step" && message) return `${message}:assistant-step`
  return String(row.ref)
}

/**
 * A progress row's event kind as the old read named it. The display row stores the projected
 * fact's kind (`worker-tool`, `commentary`, `user`, `synthetic`, ...); a row whose payload was
 * gone stores the raw recorder kind (`tool`), which the projection prefixes (`projectProgressFact`).
 */
const PROJECTED_KINDS = new Set(["commentary", "user", "synthetic"])
function progressKind(event: string | undefined) {
  if (!event) return "worker-step"
  return event.startsWith("worker-") || PROJECTED_KINDS.has(event) ? event : `worker-${event}`
}

/** A timeline row as the old event kinds the view knows. */
export function eventFromRow(row: Raw, taskID: string): TrajectoryEvent {
  const kind = String(row.kind)
  const at = num(row.at)
  const base = {
    id: timelineEventID(row),
    ...(at === undefined ? {} : { at }),
    planID: text(row.plan_id),
    taskID,
    attemptID: text(row.attempt_id),
    sessionID: text(row.session_id),
    messageID: text(row.message_id),
    callID: text(row.call_id),
  }
  const status = text(row.status)
  const tool = text(row.tool)
  const event = text(row.event)
  // A step's route, and a tool call's (its step's), as the old read's `model`.
  const model = text(row.route_model)
    ? {
        providerID: text(row.route_provider) ?? "",
        id: String(row.route_model),
        ...(text(row.route_variant) ? { variant: String(row.route_variant) } : {}),
      }
    : undefined
  const shaped =
    kind === "transition"
      ? { kind: "runner-transition", event, from: text(row.from_state), to: text(row.to_state) }
      : kind === "effect"
        ? { kind: "runner-effect", effect: event, state: status }
        : kind === "check"
          ? { kind: "verification", checkID: event, status }
          : kind === "progress"
            ? {
                kind: progressKind(event),
                status,
                tool,
                text: text(row.title),
                fileTargets: row.file_targets ?? undefined,
              }
            : kind === "assistant-step"
              ? { kind, status, model }
              : kind === "provider-retry" || kind === "assistant-error"
                ? { kind, error: text(row.error_type), status }
                : { kind, tool, status, model, completedAt: num(row.completed_at) }
  const parsed = Event.safeParse(defined({ ...base, ...defined(shaped) }))
  return parsed.success ? parsed.data : { id: base.id, kind }
}

/** A transcript row (already privacy filtered by the server) as the old event. */
export function eventFromTranscript(
  row: Raw,
  attempt: { id: string; planID: string; sessionID: string } | undefined,
): TrajectoryEvent {
  const body = (typeof row.body === "object" && row.body !== null ? row.body : {}) as Raw
  const at = num(row.at)
  const parsed = Event.safeParse(
    defined({
      ...body,
      id: String(row.id),
      kind: String(row.kind),
      ...(at === undefined ? {} : { at }),
      messageID: text(row.message_id),
      text: text(row.text),
      status: text(row.status),
      tool: text(row.tool),
      sessionID: attempt?.sessionID,
      attemptID: attempt?.id,
      planID: attempt?.planID,
    }),
  )
  return parsed.success ? parsed.data : { id: String(row.id), kind: String(row.kind) }
}

/** The full stored event of a timeline row, from its `detail` (`{ event }` or `{ event, check }`). */
export function eventFromDetail(detail: unknown): TrajectoryEvent | undefined {
  const parsed = Event.safeParse((detail as { event?: unknown } | null)?.event)
  return parsed.success ? parsed.data : undefined
}

const PartialCheck = Check.partial()
export function checkFromDetail(detail: unknown): Partial<TrajectoryCheck> | undefined {
  const parsed = PartialCheck.safeParse((detail as { check?: unknown } | null)?.check)
  return parsed.success ? parsed.data : undefined
}

/** One `check` row, with the receipt interval the list row carries (`started_at`, `ended_at`). */
export function checkFromRow(row: Raw): TrajectoryCheck & { planID: string; ref: string } {
  const status = text(row.status)
  return {
    ref: String(row.ref),
    planID: text(row.plan_id) ?? "",
    id: text(row.event) ?? String(row.ref),
    scope: text(row.attempt_id) ? "attempt" : "plan",
    attemptID: text(row.attempt_id) ?? null,
    state: text(row.to_state) ?? status ?? "",
    result: status === "passed" || status === "failed" ? status : "unknown",
    command: null,
    startedAt: num(row.started_at) ?? null,
    endedAt: num(row.ended_at) ?? null,
    timingBasis:
      "Verification receipt check.startedAt/check.endedAt; absent endpoints remain unknown",
    exitCode: null,
    timedOut: null,
    unchanged: null,
    stdout: null,
    stderr: null,
    error: null,
  }
}

/**
 * The task's current hold from its stored `tasks.schedule` row: held and why, by the rule Tasks
 * lists by (`listRowOf`). Stored plan and node state, never a windowed event.
 */
export function holdFromSchedule(row: Raw): { waiting: boolean; reason: string | null } {
  const { waiting, holdReason } = listRowOf((column) => row[column], String(row.task_id))
  return { waiting, reason: holdReason }
}

export type ConcernSignal = { line: string; action?: string; because?: string } | undefined

/**
 * The open concern of a `tasks.schedule` row (`concern`): its line, with the rule's recommended
 * action and reason (`concern_action`, `concern_because`) when the projection recorded them.
 */
export function concernFromSchedule(row: Raw): ConcernSignal {
  const concern = row.concern as { line?: unknown } | null
  if (typeof concern?.line !== "string" || !concern.line) return undefined
  const action = text(row.concern_action)
  const because = text(row.concern_because)
  return { line: concern.line, ...(action ? { action } : {}), ...(because ? { because } : {}) }
}

export function attemptFromRow(row: Raw, concern: ConcernSignal): TrajectoryAttempt {
  const startedAt = num(row.started_at) ?? 0
  const state = String(row.state)
  const last = num(row.last_event_at)
  const model = Model.safeParse(row.model)
  return {
    id: String(row.id),
    planID: String(row.plan_id),
    number: Number(row.number),
    state,
    ...(row.takeover ? { takeover: { agent: "architect" as const } } : {}),
    ...(concern ? { concern } : {}),
    sessionID: text(row.session_id) ?? "",
    startedAt,
    intervals: {
      attempt: {
        startedAt,
        // An active attempt has no end yet; a finished one ended at its last recorded event.
        endedAt: isActiveAttemptState(state) ? null : (last ?? null),
        basis: "runner attempt start; end is the attempt's latest recorded event",
      },
      modelActivity: { startedAt: null, endedAt: null, basis: "not part of the attempt row" },
    },
    admittedModel: model.success ? model.data : null,
    observedCurrentModel: null,
    toolCount: { value: num(row.tool_count) ?? 0, source: "runner attempt tool_count" },
    activeMs: num(row.active_ms) ?? null,
    checks: [],
  }
}

/** The attempt as the timeline plots it. */
export function recordedAttempt(attempt: TrajectoryAttempt, taskID: string): RecordedAttempt {
  const { startedAt, endedAt } = attempt.intervals.attempt
  return {
    id: attempt.id,
    planID: attempt.planID,
    taskID,
    number: attempt.number,
    state: attempt.state,
    startedAt: startedAt ?? attempt.startedAt,
    endedAt,
    timingBasis: attempt.intervals.attempt.basis,
    executions: [],
  }
}

export function recordedCheck(
  check: TrajectoryCheck & { planID: string },
  taskID: string,
): RecordedCheck {
  return {
    id: `${check.planID}:${check.attemptID ?? "plan"}:${check.id}`,
    planID: check.planID,
    taskID,
    attemptID: check.attemptID,
    checkID: check.id,
    scope: check.scope,
    state: check.state,
    startedAt: check.startedAt,
    endedAt: check.endedAt,
    exitCode: check.exitCode,
    timingBasis: check.timingBasis,
  }
}

export function choiceFromRow(row: Raw): TaskChoice {
  return {
    taskID: String(row.task_id),
    ...(text(row.reference) ? { reference: String(row.reference) } : {}),
    ...(num(row.revision) === undefined ? {} : { revision: Number(row.revision) }),
    title: text(row.objective) ?? text(row.title) ?? null,
    status: String(row.node_state ?? row.status ?? ""),
  }
}

/** An effort not computed yet (or one the view cannot read) is the absent window, not zeros. */
export function emptyEffort(toolCalls: number): TrajectoryReport["effort"] {
  return {
    acceptedAt: null,
    firstAttemptAt: null,
    tokenUsage: {
      measuredSubtotal: {
        uncachedInput: null,
        cacheRead: null,
        cacheWrite: null,
        output: null,
        reasoning: null,
      },
      total: null,
      knownSessions: 0,
      totalSessions: 0,
      unknownAttempts: [],
    },
    toolCalls: { count: toolCalls },
    recordedCost: { apiEquivalentTotalUsd: null },
  }
}

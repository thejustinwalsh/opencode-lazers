import { buildAxis } from "./axis.ts"
import type { Axis } from "./axis.ts"
import { z } from "zod"
import { TrajectoryMarketEquivalentCostSchema } from "../models/task-valuation-schema.ts"

const NullableTime = z.number().finite().nullable()
export const Model = z
  .object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
  .strip()
export const Check = z
  .object({
    id: z.string(),
    scope: z.enum(["attempt", "plan"]),
    attemptID: z.string().nullable(),
    state: z.string(),
    result: z.enum(["passed", "failed", "unknown"]),
    command: z.string().nullable(),
    startedAt: NullableTime,
    endedAt: NullableTime,
    timingBasis: z.string(),
    exitCode: z.number().finite().nullable(),
    timedOut: z.boolean().nullable(),
    unchanged: z.boolean().nullable(),
    stdout: z.string().nullable(),
    stderr: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strip()
const Interval = z
  .object({ startedAt: NullableTime, endedAt: NullableTime, basis: z.string() })
  .strip()
const TimingEndpoint = z
  .object({
    at: NullableTime,
    source: z.string().nullable().optional(),
    sourceType: z.string().nullable().optional(),
  })
  .strip()
// Server-projected timing endpoints (src/trajectory/read.ts contextTiming and
// src/progress/projection.ts projectedTiming). Only times and source labels pass.
const EventTiming = z.object({ endpoints: z.record(z.string(), TimingEndpoint.nullable()) }).strip()
// Server-validated, workspace-relative requested paths (src/progress/projection.ts).
const FileTargets = z
  .object({
    coverage: z.enum(["observed", "partial", "omitted"]),
    operation: z.enum(["read", "edit", "patch"]).nullable(),
    paths: z.array(z.string()).max(8),
  })
  .strip()
export const Event = z
  .object({
    id: z.string(),
    at: NullableTime.optional(),
    sequence: z.number().finite().optional(),
    projectID: z.string().optional(),
    planID: z.string().optional(),
    taskID: z.string().optional(),
    attemptID: z.string().nullable().optional(),
    sessionID: z.string().nullable().optional(),
    messageID: z.string().nullable().optional(),
    callID: z.string().nullable().optional(),
    source: z.string().optional(),
    sources: z.array(z.string()).optional(),
    eventIDs: z.array(z.string()).optional(),
    kind: z.string(),
    event: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    version: z.number().finite().optional(),
    text: z.string().optional(),
    tool: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    input: z.unknown().optional(),
    result: z.string().optional(),
    error: z.unknown().optional(),
    completedAt: NullableTime.optional(),
    command: z.string().nullable().optional(),
    exit: z.number().finite().nullable().optional(),
    output: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    checkID: z.string().optional(),
    state: z.string().optional(),
    effect: z.string().optional(),
    reason: z.string().optional(),
    model: Model.nullable().optional(),
    previous: Model.nullable().optional(),
    agent: z.string().nullable().optional(),
    location: z.string().optional(),
    finish: z.string().nullable().optional(),
    measurementBasis: z.string().nullable().optional(),
    usage: z.unknown().optional(),
    additive: z.boolean().optional(),
    outcome: z.string().nullable().optional(),
    basis: z.string().nullable().optional(),
    delivery: z.string().nullable().optional(),
    commit: z.string().nullable().optional(),
    truncated: z.boolean().optional(),
    exitCode: z.number().finite().nullable().optional(),
    timedOut: z.boolean().nullable().optional(),
    unchanged: z.boolean().nullable().optional(),
    artifact: z.string().optional(),
    timing: EventTiming.optional().catch(undefined),
    fileTargets: FileTargets.optional().catch(undefined),
  })
  .strip()
const Report = z
  .object({
    task: z.object({
      id: z.string(),
      /** Task reference such as LZ-137; absent from older servers and for unreferenced tasks. */
      reference: z.string().optional(),
      revision: z.number().int().positive().optional(),
      status: z.string(),
      /** The current recorded lifecycle state; absent from older servers. */
      recordedState: z.string().optional(),
      specification: z.object({ objective: z.string() }).strip(),
    }),
    plans: z.array(
      z.object({
        id: z.string(),
        state: z.string().optional(),
        /** Why the plan is held, cancelled or failed; the same text Tasks reads. */
        reason: z.string().nullable().optional(),
        /** Why this task's node is held or failed. */
        taskReason: z.string().nullable().optional(),
        checks: z.array(Check),
      }),
    ),
    attempts: z.array(
      z.object({
        id: z.string(),
        planID: z.string(),
        number: z.number().int().positive(),
        state: z.string(),
        /** Present when the attempt is the Architect finishing the task itself. */
        takeover: z
          .object({ agent: z.literal("architect") })
          .strip()
          .optional(),
        /** An open worker concern raised against this attempt, with the rule's advice. */
        concern: z
          .object({
            line: z.string(),
            action: z.string().optional(),
            because: z.string().optional(),
          })
          .strip()
          .optional(),
        sessionID: z.string(),
        startedAt: z.number().finite(),
        intervals: z.object({ attempt: Interval, modelActivity: Interval }).strip(),
        admittedModel: Model.nullable(),
        observedCurrentModel: Model.nullable(),
        toolCount: z.object({ value: z.number().finite(), source: z.string() }).strip(),
        checks: z.array(Check),
      }),
    ),
    effort: z.object({
      acceptedAt: NullableTime,
      firstAttemptAt: NullableTime,
      tokenUsage: z.object({
        measuredSubtotal: z.object({
          uncachedInput: z.number().finite().nullable(),
          cacheRead: z.number().finite().nullable(),
          cacheWrite: z.number().finite().nullable(),
          output: z.number().finite().nullable(),
          reasoning: z.number().finite().nullable(),
        }),
        total: z
          .object({
            uncachedInput: z.number().finite(),
            cacheRead: z.number().finite(),
            cacheWrite: z.number().finite(),
            output: z.number().finite(),
            reasoning: z.number().finite(),
          })
          .nullable(),
        knownSessions: z.number().int().nonnegative(),
        totalSessions: z.number().int().nonnegative(),
        unknownAttempts: z.array(z.string()),
      }),
      toolCalls: z.object({ count: z.number().int().nonnegative() }),
      recordedCost: z.object({
        apiEquivalentTotalUsd: z.number().finite().nullable(),
        apiEquivalentSubtotalUsd: z.number().finite().nullable().optional(),
        apiEquivalentStatus: z.string().optional(),
      }),
      marketEquivalentCost: TrajectoryMarketEquivalentCostSchema.optional(),
    }),
  })
  .strip()

const RecordedExecution = z
  .object({
    startedAt: NullableTime,
    endedAt: NullableTime,
    startSequence: z.number().int().positive().nullable(),
    endSequence: z.number().int().positive().nullable(),
    timingBasis: z.string(),
  })
  .strip()
const RecordedAttemptSchema = z
  .object({
    id: z.string(),
    planID: z.string(),
    taskID: z.string(),
    number: z.number().int().positive(),
    state: z.string(),
    startedAt: z.number().finite(),
    endedAt: NullableTime,
    timingBasis: z.string(),
    executions: z.array(RecordedExecution),
  })
  .strip()
const RecordedCheckSchema = z
  .object({
    id: z.string(),
    planID: z.string().nullable().optional(),
    taskID: z.string().nullable(),
    attemptID: z.string().nullable(),
    checkID: z.string(),
    scope: z.enum(["attempt", "plan"]),
    state: z.string(),
    startedAt: NullableTime,
    endedAt: NullableTime,
    exitCode: z.number().finite().nullable(),
    timingBasis: z.string(),
  })
  .strip()
export type RecordedAttempt = z.infer<typeof RecordedAttemptSchema>
export type RecordedCheck = z.infer<typeof RecordedCheckSchema>

/** The effort the stream's detail carries, parsed so the view reads only what it knows. */
export const reportEffortSchema = Report.shape.effort
export type TrajectoryReport = z.infer<typeof Report>
export type TrajectoryAttempt = TrajectoryReport["attempts"][number]
export type TrajectoryCheck = z.infer<typeof Check>
export type TrajectoryEvent = z.infer<typeof Event>

export type TaskChoice = {
  taskID: string
  reference?: string
  revision?: number
  title: string | null
  status: string
}

export type TimelineTick = { elapsedMs: number; label: string }
export type AttemptTimeline = {
  attempt: RecordedAttempt
  segments: Array<{
    left: number
    width: number
    pointOnly: boolean
    startRecorded: boolean
    endRecorded: boolean
    /** Active attempt drawn to the capture time; its end is not recorded. */
    open: boolean
    visible: boolean
    basis: string
  }>
}
export type CheckTimeline = RecordedCheck & {
  left: number
  startLeft: number | null
  endLeft: number | null
  width: number
  pointOnly: boolean
  visible: boolean
}
/** A compressed idle stretch, positioned by the same axis as every mark. */
export type IdleBreak = {
  startMs: number
  endMs: number
  label: string
  left: number
  width: number
}
export type Timeline = {
  origin: number | null
  durationMs: number
  /** The shared time-to-position transform; absent only for an empty timeline. */
  axis?: Axis
  breaks?: IdleBreak[]
  ticks: TimelineTick[]
  attempts: AttemptTimeline[]
  checks: CheckTimeline[]
  /** Capture time that bounds open bars, or null when no attempt is open. */
  openEnd?: number | null
}

function timestampValues(attempts: RecordedAttempt[], checks: RecordedCheck[]) {
  const values: number[] = []
  for (const attempt of attempts) {
    values.push(attempt.startedAt)
    if (attempt.endedAt !== null) values.push(attempt.endedAt)
    for (const execution of attempt.executions)
      for (const value of [execution.startedAt, execution.endedAt])
        if (value !== null) values.push(value)
  }
  for (const check of checks)
    for (const value of [check.startedAt, check.endedAt]) if (value !== null) values.push(value)
  return values.filter(Number.isFinite)
}

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const TICK_STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 10_800, 21_600, 43_200, 86_400,
].map((seconds) => seconds * SECOND)
const ACTIVE_ATTEMPT_STATES = new Set(["preparing", "running", "verifying"])

/** Smallest readable step that keeps the fitted axis at or below `maxTicks` intervals. */
export function tickStep(spanMs: number, maxTicks = 6) {
  return TICK_STEPS.find((step) => Math.ceil(spanMs / step) <= maxTicks) ?? TICK_STEPS.at(-1)!
}

/** Compact elapsed label: 45s, 1m30s, 12m, 1h, 1h30m. */
export function elapsedDurationLabel(elapsedMs: number) {
  const total = Math.round(elapsedMs / SECOND)
  if (total === 0) return "0"
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  if (hours) return `${hours}h${minutes ? `${minutes}m` : ""}`
  if (minutes) return `${minutes}m${seconds ? `${seconds}s` : ""}`
  return `${seconds}s`
}

/**
 * Human duration for inspector rows: 240ms, 4.2s, 18s, 4m 47s, 48m, 1h 02m, 3h, 1d 20h. A zero
 * trailing unit is dropped.
 */
export function durationText(durationMs: number) {
  if (durationMs < SECOND) return `${Math.round(durationMs)}ms`
  if (durationMs < 10 * SECOND) return `${(durationMs / SECOND).toFixed(1)}s`
  if (durationMs < MINUTE) return `${Math.round(durationMs / SECOND)}s`
  const total = Math.round(durationMs / SECOND)
  const pair = (major: number, unit: string, minor: number, minorUnit: string, pad: boolean) =>
    minor
      ? `${major}${unit} ${pad ? String(minor).padStart(2, "0") : minor}${minorUnit}`
      : `${major}${unit}`
  if (durationMs < HOUR) return pair(Math.floor(total / 60), "m", total % 60, "s", true)
  const hours = Math.floor(total / 3_600)
  if (hours < 24) return pair(hours, "h", Math.floor((total % 3_600) / 60), "m", true)
  return pair(Math.floor(hours / 24), "d", hours % 24, "h", false)
}

export function isActiveAttemptState(state: string) {
  return ACTIVE_ATTEMPT_STATES.has(state)
}

/**
 * Projects recorded attempt and check intervals onto one elapsed axis whose origin is the
 * earliest recorded attempt start. `asOf` (history capture time) only extends the axis and
 * the open bar of an attempt still in an active state; it never becomes a recorded end.
 */
export function buildTimeline(
  recorded: {
    attempts: RecordedAttempt[]
    checks: RecordedCheck[]
    firstAttemptAt?: number | null
  },
  asOf?: number | null,
  extraTimes: readonly number[] = [],
  /** Compress known idle stretches; only once the whole timeline is loaded. */
  compressIdle = false,
): Timeline {
  const { attempts, checks } = recorded
  const starts = attempts.map((attempt) => attempt.startedAt).filter(Number.isFinite)
  const origin = starts.length ? Math.min(...starts) : (recorded.firstAttemptAt ?? null)
  if (origin === null) return { origin: null, durationMs: 0, ticks: [], attempts: [], checks: [] }
  const openAttempt = attempts.some(
    (attempt) => attempt.endedAt === null && isActiveAttemptState(attempt.state),
  )
  const openEnd =
    openAttempt && typeof asOf === "number" && Number.isFinite(asOf) && asOf > origin ? asOf : null
  const values = [
    ...timestampValues(attempts, checks),
    ...extraTimes.filter(Number.isFinite),
    ...(openEnd === null ? [] : [openEnd]),
  ]
  const maximum = Math.max(origin, ...values)
  const span = Math.max(0, maximum - origin)
  const step = tickStep(span)
  // The axis ends at the last recorded time, not at the next tick step.
  const durationMs = span > 0 ? span : step
  const ticks: TimelineTick[] = []
  for (let elapsed = 0; elapsed <= durationMs; elapsed += step)
    ticks.push({ elapsedMs: elapsed, label: elapsedDurationLabel(elapsed) })
  const axis = buildAxis(
    durationMs,
    values.map((value) => value - origin),
    compressIdle,
  )
  const position = (at: number) => axis.place(at - origin)
  const breaks = axis.idle.map((span) => ({
    ...span,
    label: `${elapsedDurationLabel(span.endMs - span.startMs)} idle`,
    left: axis.place(span.startMs),
    width: axis.place(span.endMs) - axis.place(span.startMs),
  }))
  const attemptsWithGeometry = attempts.map((attempt) => {
    const executions =
      attempt.executions.length > 0
        ? attempt.executions
        : [
            {
              startedAt: attempt.startedAt,
              endedAt: attempt.endedAt,
              startSequence: null,
              endSequence: null,
              timingBasis: attempt.timingBasis,
            },
          ]
    const active = attempt.endedAt === null && isActiveAttemptState(attempt.state)
    return {
      attempt,
      segments: executions.map((execution, index) => {
        const point = execution.startedAt ?? execution.endedAt ?? attempt.startedAt
        const left = position(point)
        // Only the last execution of an active attempt may stay open to the capture time.
        const open =
          active &&
          openEnd !== null &&
          index === executions.length - 1 &&
          execution.startedAt !== null &&
          execution.endedAt === null
        const width =
          execution.startedAt !== null && execution.endedAt !== null
            ? Math.max(0, position(execution.endedAt) - left)
            : open
              ? Math.max(0, position(openEnd) - left)
              : 0
        return {
          left: execution.startedAt === null && execution.endedAt === null ? 0 : left,
          width,
          pointOnly: !open && (execution.startedAt === null || execution.endedAt === null),
          startRecorded: execution.startedAt !== null,
          endRecorded: execution.endedAt !== null,
          open,
          visible: execution.startedAt !== null || execution.endedAt !== null,
          basis: execution.timingBasis,
        }
      }),
    }
  })
  const checksWithGeometry = checks.map((check) => {
    const timing = checkTiming(check)
    const startLeft = check.startedAt === null ? null : position(check.startedAt)
    const endLeft = check.endedAt === null ? null : position(check.endedAt)
    const left = startLeft ?? endLeft ?? 0
    return {
      ...check,
      left,
      startLeft,
      endLeft,
      width:
        timing.status === "known" && timing.durationMs > 0
          ? Math.max(0, (endLeft ?? left) - left)
          : 0,
      pointOnly: timing.status !== "known" || timing.durationMs === 0,
      visible: startLeft !== null || endLeft !== null,
    }
  })
  return {
    origin,
    durationMs,
    axis,
    breaks,
    ticks,
    attempts: attemptsWithGeometry,
    checks: checksWithGeometry,
    openEnd,
  }
}

/** Word-boundary display title; the full objective stays available below the heading. */
export function displayTitle(objective: string) {
  const line = objective.trim().split(/\r?\n/)[0]?.trim() ?? ""
  if (line.length <= 72) return line
  const cut = line.slice(0, 72 + 1)
  const boundary = cut.lastIndexOf(" ")
  return `${(boundary > 24 ? cut.slice(0, boundary) : line.slice(0, 72)).replace(/[\s,.;:–-]+$/, "")}…`
}

export type CheckTiming =
  | { status: "known"; durationMs: number; reason: null }
  | {
      status: "missing-start" | "missing-end" | "missing-endpoints" | "invalid-order"
      durationMs: null
      reason: string
    }

export function checkTiming(check: Pick<TrajectoryCheck, "startedAt" | "endedAt">): CheckTiming {
  if (check.startedAt === null && check.endedAt === null)
    return {
      status: "missing-endpoints",
      durationMs: null,
      reason: "Neither start nor end time was recorded.",
    }
  if (check.startedAt === null)
    return {
      status: "missing-start",
      durationMs: null,
      reason: "Start time was not recorded.",
    }
  if (check.endedAt === null)
    return {
      status: "missing-end",
      durationMs: null,
      reason: "End time was not recorded.",
    }
  if (check.endedAt < check.startedAt)
    return {
      status: "invalid-order",
      durationMs: null,
      reason: "The recorded end time precedes the start time; duration is unavailable.",
    }
  return { status: "known", durationMs: check.endedAt - check.startedAt, reason: null }
}

export type DetailedCheck = TrajectoryCheck & { planID: string }

export function checkKey(check: Pick<TrajectoryCheck, "id" | "attemptID"> & { planID?: string }) {
  return `${check.planID ?? ""}:${check.attemptID ?? "plan"}:${check.id}`
}

export function detailedChecks(report: TrajectoryReport) {
  const checks = new Map<string, DetailedCheck>()
  for (const plan of report.plans)
    for (const check of plan.checks) {
      const value = { ...check, planID: plan.id }
      checks.set(checkKey(value), value)
    }
  for (const attempt of report.attempts)
    for (const check of attempt.checks) {
      const value = { ...check, planID: attempt.planID }
      checks.set(checkKey(value), value)
    }
  return [...checks.values()]
}

export function sourceReferences(text: string) {
  const found = new Map<string, { path: string; line: number; column: number | null }>()
  const expression = /(?:^|[\s(])((?:\.{0,2}\/)?[\w@./-]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/gm
  for (const match of text.matchAll(expression)) {
    const path = match[1]
    const line = Number(match[2])
    const column = match[3] ? Number(match[3]) : null
    if (!path || !Number.isInteger(line) || line < 1) continue
    found.set(`${path}:${line}:${column ?? ""}`, { path, line, column })
  }
  return [...found.values()]
}

export function eventPayload(event: TrajectoryEvent) {
  const payload: Record<string, unknown> = { kind: event.kind }
  for (const key of [
    "sequence",
    "projectID",
    "planID",
    "taskID",
    "source",
    "sources",
    "eventIDs",
    "event",
    "from",
    "to",
    "version",
    "text",
    "tool",
    "status",
    "input",
    "result",
    "error",
    "completedAt",
    "command",
    "exit",
    "output",
    "outputTruncated",
    "checkID",
    "state",
    "effect",
    "outcome",
    "reason",
    "model",
    "previous",
    "agent",
    "location",
    "finish",
    "measurementBasis",
    "usage",
    "additive",
    "basis",
    "delivery",
    "commit",
    "truncated",
    "exitCode",
    "timedOut",
    "unchanged",
    "artifact",
  ] as const)
    if (event[key] !== undefined) payload[key] = event[key]
  return payload
}

/** The plain name of a timing source: "verification receipt"; its field path stays in the body. */
export function sourceName(basis: string) {
  const words: string[] = []
  for (const word of (basis.split(";")[0] ?? "").trim().split(/\s+/)) {
    if (word.endsWith(":")) {
      words.push(word.slice(0, -1))
      break
    }
    if (/[./:]/.test(word)) break
    words.push(word)
  }
  const name = words.join(" ").trim()
  return name ? name[0]!.toLowerCase() + name.slice(1) : ""
}

/** Token counts as in the mockup: 950, 20.3k, 16M, 1.2B. */
export function compactCount(value: number) {
  const units = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const
  for (const [size, unit] of units)
    if (Math.abs(value) >= size) return `${Number((value / size).toFixed(1))}${unit}`
  return String(Math.round(value))
}

/** The state Tasks shows for the task: its recorded lifecycle state, else the proposal's status. */
export function currentTaskState(report: Pick<TrajectoryReport, "task">) {
  return report.task.recordedState ?? report.task.status
}

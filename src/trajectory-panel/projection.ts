import type {
  ObservationScope,
  ObservationScopeView,
  SnapshotResponse,
  TrajectoryHistoryResponse,
  TrajectoryResponse,
} from "../observability/contract.ts"
import { trajectoryChanges } from "./events.ts"
import type { TrajectoryChange, TrajectoryEventSource } from "./events.ts"
import { z } from "zod"

export type ObservationRpc = {
  snapshot(
    input: { scope: ObservationScope },
    options: { location: { directory: string }; signal: AbortSignal },
  ): Promise<SnapshotResponse>
  trajectory(
    input: { scope: ObservationScope; taskID: string; limit: number; cursor?: string },
    options: { location: { directory: string }; signal: AbortSignal },
  ): Promise<TrajectoryResponse>
  trajectoryHistory(
    input: { scope: ObservationScope; taskID: string; limit: number; cursor?: string },
    options: { location: { directory: string }; signal: AbortSignal },
  ): Promise<TrajectoryHistoryResponse>
  trajectoryStatus(
    input: { scope: ObservationScope; taskID: string },
    options: { location: { directory: string }; signal: AbortSignal },
  ): Promise<TrajectoryResponse>
}

export type TrajectoryTransport = {
  snapshot(scope: ObservationScope, signal: AbortSignal): Promise<SnapshotResponse>
  trajectory(
    scope: ObservationScope,
    taskID: string,
    signal: AbortSignal,
    cursor?: string,
  ): Promise<TrajectoryResponse>
  history(
    scope: ObservationScope,
    taskID: string,
    signal: AbortSignal,
    cursor?: string,
    limit?: number,
  ): Promise<TrajectoryHistoryResponse>
  status(scope: ObservationScope, taskID: string, signal: AbortSignal): Promise<TrajectoryResponse>
  changes(signal: AbortSignal): AsyncIterable<TrajectoryChange>
  online(): boolean
}

export function createTrajectoryTransport(
  rpc: ObservationRpc,
  directory: string,
  online: () => boolean,
  events: TrajectoryEventSource,
  projectID: string,
): TrajectoryTransport {
  return {
    snapshot: (scope, signal) => rpc.snapshot({ scope }, { location: { directory }, signal }),
    trajectory: (scope, taskID, signal, cursor) =>
      rpc.trajectory(
        { scope, taskID, limit: 50, ...(cursor ? { cursor } : {}) },
        { location: { directory }, signal },
      ),
    history: (scope, taskID, signal, cursor, limit = 50) =>
      rpc.trajectoryHistory(
        { scope, taskID, limit, ...(cursor ? { cursor } : {}) },
        { location: { directory }, signal },
      ),
    status: (scope, taskID, signal) =>
      rpc.trajectoryStatus({ scope, taskID }, { location: { directory }, signal }),
    changes: (signal) => trajectoryChanges(events, projectID, signal),
    online,
  }
}

const NullableTime = z.number().finite().nullable()
const Model = z
  .object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
  .strip()
const Check = z
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
const Event = z
  .object({
    id: z.string(),
    at: NullableTime.optional(),
    sequence: z.number().finite().optional(),
    projectID: z.string().optional(),
    planID: z.string().optional(),
    taskID: z.string().optional(),
    attemptID: z.string().nullable().optional(),
    sessionID: z.string().nullable().optional(),
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
  })
  .strip()
const Report = z
  .object({
    schemaVersion: z.literal(1),
    task: z.object({
      id: z.string(),
      revision: z.number().int().positive().optional(),
      status: z.string(),
      specification: z.object({ objective: z.string() }).strip(),
    }),
    plans: z.array(z.object({ id: z.string(), checks: z.array(Check) })),
    attempts: z.array(
      z.object({
        id: z.string(),
        planID: z.string(),
        number: z.number().int().positive(),
        state: z.string(),
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
          uncachedInput: z.number().finite(),
          cacheRead: z.number().finite(),
          cacheWrite: z.number().finite(),
          output: z.number().finite(),
          reasoning: z.number().finite(),
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
      recordedCost: z.object({ apiEquivalentTotalUsd: z.number().finite().nullable() }),
    }),
    coverage: z.object({
      availableSessionContexts: z.number().int().nonnegative(),
      unavailableSessionContexts: z.number().int().nonnegative(),
      fullSessionHistory: z.string(),
      compacted: z.boolean(),
      ongoing: z.boolean(),
      attemptsWithoutRecordedSessions: z.number().int().nonnegative(),
      workerProgress: z
        .object({
          facts: z.number().int().nonnegative(),
          truncated: z.boolean(),
          commentary: z.number().int().nonnegative(),
          automaticFacts: z.number().int().nonnegative(),
          recoveryGaps: z.number().int().nonnegative(),
          additiveStepMeasurements: z.number().int().nonnegative(),
          cumulativeUsageSnapshots: z.number().int().nonnegative(),
        })
        .optional(),
    }),
    trajectory: z.object({
      page: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
      totalEvents: z.number().int().nonnegative(),
      events: z.array(Event),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  })
  .strip()

const SnapshotNode = z
  .object({
    taskID: z.string(),
    revision: z.number().int().positive().optional(),
    objective: z.string().optional(),
    ordinal: z.number().int().nonnegative(),
    state: z.string(),
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
const RecordedAttempt = z
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
const RecordedCheck = z
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
const ProjectedSnapshot = z
  .object({
    projectID: z.string(),
    scope: z.union([
      z.object({ kind: z.literal("session"), sessionID: z.string() }),
      z.object({ kind: z.literal("project") }),
    ]),
    boundary: z.object({
      repositoryVersion: z.number().int().nonnegative(),
      sourceRevision: z.number().int().nonnegative(),
      sourceFingerprint: z.string(),
      nativeRevision: z.number().int().nonnegative(),
      eventSequence: z.number().int().nonnegative(),
      transitionSequence: z.number().int().nonnegative(),
    }),
    plans: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        nodes: z.array(SnapshotNode),
      }),
    ),
    unplannedTasks: z.array(
      z.object({
        taskID: z.string(),
        revision: z.number().int().positive(),
        status: z.string(),
        title: z.string(),
      }),
    ),
    attempts: z.array(RecordedAttempt).optional().default([]),
    checks: z.array(RecordedCheck).optional().default([]),
  })
  .strip()

export type ProjectedSnapshot = z.infer<typeof ProjectedSnapshot>
export type RecordedAttempt = z.infer<typeof RecordedAttempt>
export type RecordedCheck = z.infer<typeof RecordedCheck>

export function parseProjectedSnapshot(snapshot: SnapshotResponse): ProjectedSnapshot {
  const parsed = ProjectedSnapshot.safeParse(snapshot)
  if (!parsed.success) throw new Error("Observation snapshot has an unsupported shape")
  return parsed.data
}

export type TrajectoryReport = z.infer<typeof Report>
export type TrajectoryAttempt = TrajectoryReport["attempts"][number]
export type TrajectoryCheck = z.infer<typeof Check>
export type TrajectoryEvent = z.infer<typeof Event>

export function eventTitle(event: TrajectoryEvent) {
  if (event.kind === "tool") return `${event.tool ?? "Tool"} · ${event.status ?? "unknown"}`
  if (event.kind === "worker-tool")
    return `${event.tool ?? "Worker tool"} · ${event.status ?? "updated"}`
  if (event.kind === "commentary") return "Worker progress note"
  if (event.kind === "worker-visible-text") return "Worker message"
  if (event.kind === "worker-step") return `Worker step · ${event.status ?? "updated"}`
  if (event.kind === "verification")
    return `Check ${event.checkID ?? ""} · ${event.status ?? "unknown"}`
  if (event.kind === "runner-transition")
    return `${event.event ?? "Transition"}${event.to ? ` · ${event.to}` : ""}`
  if (event.kind === "runner-effect")
    return `${event.effect ?? "Runner effect"} · ${event.state ?? "unknown"}`
  if (event.kind === "assistant-text") return "Worker message"
  return event.kind
}

export function parseTrajectoryReport(response: TrajectoryResponse): TrajectoryReport {
  const parsed = Report.safeParse(response.report)
  if (!parsed.success)
    throw new Error(
      `Trajectory projection has an unsupported shape at ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
    )
  return parsed.data
}

export type TaskChoice = {
  taskID: string
  revision?: number
  title: string | null
  status: string
}

export function taskChoices(snapshot: ProjectedSnapshot): TaskChoice[] {
  const tasks = new Map<string, TaskChoice>()
  for (const plan of snapshot.plans)
    for (const node of plan.nodes)
      if (!tasks.has(node.taskID))
        tasks.set(node.taskID, {
          taskID: node.taskID,
          ...(node.revision === undefined ? {} : { revision: node.revision }),
          title: node.objective ?? plan.title,
          status: node.state,
        })
  for (const task of snapshot.unplannedTasks)
    if (!tasks.has(task.taskID))
      tasks.set(task.taskID, {
        taskID: task.taskID,
        revision: task.revision,
        title: task.title,
        status: task.status,
      })
  return [...tasks.values()]
}

export type TimelineTick = { elapsedMs: number; label: string }
export type AttemptTimeline = {
  attempt: RecordedAttempt
  segments: Array<{
    left: number
    width: number
    pointOnly: boolean
    visible: boolean
    basis: string
  }>
}
export type CheckTimeline = RecordedCheck & { left: number; pointOnly: boolean }
export type Timeline = {
  origin: number | null
  durationMs: number
  ticks: TimelineTick[]
  attempts: AttemptTimeline[]
  checks: CheckTimeline[]
}

function timelineAttempts(snapshot: ProjectedSnapshot, taskID: string, report?: TrajectoryReport) {
  const attempts = snapshot.attempts.filter((attempt) => attempt.taskID === taskID)
  if (attempts.length || !report) return attempts
  return report.attempts.map((attempt): RecordedAttempt => ({
    id: attempt.id,
    planID: attempt.id,
    taskID,
    number: attempt.number,
    state: attempt.state,
    startedAt: attempt.intervals.attempt.startedAt ?? attempt.startedAt,
    endedAt: attempt.intervals.attempt.endedAt,
    timingBasis: attempt.intervals.attempt.basis,
    executions: [],
  }))
}

function timelineChecks(snapshot: ProjectedSnapshot, taskID: string, report?: TrajectoryReport) {
  const allowedPlanIDs = new Set(
    snapshot.plans
      .filter((plan) => plan.nodes.some((node) => node.taskID === taskID))
      .map((plan) => plan.id),
  )
  const checks = snapshot.checks.filter(
    (check) =>
      check.taskID === taskID ||
      (check.taskID === null &&
        typeof check.planID === "string" &&
        allowedPlanIDs.has(check.planID)),
  )
  if (checks.length || !report) return checks
  const fromReport = report.plans.flatMap((plan) =>
    plan.checks.map((check) => ({ check, planID: plan.id })),
  )
  for (const attempt of report.attempts)
    for (const check of attempt.checks) fromReport.push({ check, planID: attempt.planID })
  return fromReport.map(({ check, planID }): RecordedCheck => ({
    id: `${planID}:${check.attemptID ?? "plan"}:${check.id}`,
    planID,
    taskID,
    attemptID: check.attemptID,
    checkID: check.id,
    scope: check.scope,
    state: check.state,
    startedAt: check.startedAt,
    endedAt: check.endedAt,
    exitCode: check.exitCode,
    timingBasis: check.timingBasis,
  }))
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

function niceMinuteStep(minutes: number) {
  if (minutes <= 6) return 1
  if (minutes <= 15) return 5
  if (minutes <= 60) return 10
  if (minutes <= 180) return 30
  return 60
}

export function buildTimeline(
  snapshot: ProjectedSnapshot,
  taskID: string,
  report?: TrajectoryReport,
): Timeline {
  const attempts = timelineAttempts(snapshot, taskID, report)
  const checks = timelineChecks(snapshot, taskID, report)
  const starts = attempts.map((attempt) => attempt.startedAt).filter(Number.isFinite)
  const origin = starts.length ? Math.min(...starts) : (report?.effort.firstAttemptAt ?? null)
  if (origin === null) return { origin: null, durationMs: 0, ticks: [], attempts: [], checks: [] }
  const values = timestampValues(attempts, checks)
  const maximum = Math.max(origin, ...values)
  const rawMinutes = Math.max(0, (maximum - origin) / 60_000)
  const step = niceMinuteStep(rawMinutes)
  const durationMinutes = Math.max(step, Math.ceil(rawMinutes / step) * step)
  const durationMs = durationMinutes * 60_000
  const ticks: TimelineTick[] = []
  for (let minute = 0; minute <= durationMinutes; minute += step)
    ticks.push({ elapsedMs: minute * 60_000, label: `${minute}m` })
  const position = (at: number) => Math.max(0, Math.min(100, ((at - origin) / durationMs) * 100))
  const attemptsWithGeometry = attempts.map((attempt) => {
    const executions =
      attempt.executions.length > 0
        ? attempt.executions
        : [
            {
              startedAt: attempt.startedAt,
              endedAt: null,
              startSequence: null,
              endSequence: null,
              timingBasis: attempt.timingBasis,
            },
          ]
    return {
      attempt,
      segments: executions.map((execution) => {
        const point = execution.startedAt ?? execution.endedAt ?? attempt.startedAt
        const left = position(point)
        const width =
          execution.startedAt !== null && execution.endedAt !== null
            ? Math.max(0, position(execution.endedAt) - left)
            : 0
        return {
          left: execution.startedAt === null && execution.endedAt === null ? 0 : left,
          width,
          pointOnly: execution.startedAt === null || execution.endedAt === null,
          visible: execution.startedAt !== null || execution.endedAt !== null,
          basis: execution.timingBasis,
        }
      }),
    }
  })
  const checksWithGeometry = checks.map((check) => ({
    ...check,
    left: position(check.startedAt ?? check.endedAt ?? origin),
    pointOnly:
      check.startedAt === null || check.endedAt === null || check.startedAt === check.endedAt,
  }))
  return { origin, durationMs, ticks, attempts: attemptsWithGeometry, checks: checksWithGeometry }
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

export function allEvents(report: TrajectoryReport) {
  return report.trajectory.events
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

export type ScopeView = ObservationScopeView

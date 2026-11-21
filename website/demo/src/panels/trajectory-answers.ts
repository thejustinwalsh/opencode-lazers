import { Observability } from "../../../../src/observability/contract.ts"
import type {
  ObservationScope,
  SnapshotResponse,
  TrajectoryHistoryResponse,
  TrajectoryResponse,
} from "../../../../src/observability/contract.ts"
import { parseTrajectoryReport } from "../../../../src/trajectory-panel/projection.ts"
import type {
  TrajectoryCheck,
  TrajectoryEvent,
  TrajectoryReport,
} from "../../../../src/trajectory-panel/projection.ts"
import type { TaskState } from "../../../../src/runner/schema.ts"
import type { Read } from "../adapter.ts"
import { T0 } from "../story.ts"

/**
 * Pure answers for the Trajectory panel: a compact description of one task's recorded work at one
 * moment, expanded into the exact contract shapes (`lazers.observability` snapshot, captured
 * history and live status) the real panel reads. No browser or Solid code, so the build script
 * can validate it.
 *
 * All times are seconds after the work began; the work began six minutes before the story's
 * wall-clock origin, so every recorded time is in the story's past.
 */
export interface DemoCall {
  /** Stable name; `markID` turns it into the id of its mark on the timeline. */
  key: string
  attempt: 1 | 2
  tool: "Read" | "Grep" | "Edit" | "Bash"
  at: number
  /** Duration in seconds. */
  s: number
  status: "completed" | "error"
  /** File the call read or edited. */
  path?: string
  command?: string
  /** What the call printed. */
  result?: string
}
export interface DemoCheck {
  id: "tests" | "typecheck"
  attempt: 1 | 2
  start: number
  /** Null while the check is still running. */
  end: number | null
  result: "passed" | "failed" | "unknown"
  command: string
  exit?: number
  stdout?: string
  stderr?: string
}
export interface DemoAttempt {
  number: 1 | 2
  state: "failed" | "running" | "verifying" | "accepted"
  start: number
  end: number | null
  /** When the worker stopped editing and verification began. */
  workEnd: number | null
  model: { providerID: string; id: string; variant?: string }
}
export interface DemoOtherTask {
  n: number
  title: string
  state: TaskState
  plan: string
  /** Whether this session created it; the session scope lists only these. */
  session: boolean
}
export interface TrajectoryData {
  /** Change counter: the producer's event sequence. */
  version: number
  /** The task whose trajectory the story opens. */
  task: { n: number; title: string; objective: string; state: TaskState; plan: string }
  attempts: DemoAttempt[]
  calls: DemoCall[]
  checks: DemoCheck[]
  others: DemoOtherTask[]
}

export const PROJECT = { canonical: "/workspace/lazers-demo", id: "demo-project" }
const OWNER_SESSION = "ses-demo"
const SEC = 1000
const WORK_START = T0 - 360 * SEC
const when = (seconds: number) => WORK_START + Math.round(seconds * SEC)
const sessionOf = (attempt: number) => `ses-worker-${attempt}`
const callID = (call: Pick<DemoCall, "key">) => `call-${call.key}`

/** The id of a call's mark on the timeline (`data-mark-id`), for the story's selectors. */
export const markID = (attempt: 1 | 2, key: string) => `${sessionOf(attempt)}:tool:call-${key}`
/** RFC 4122 v4-shaped ids, stable per kind and number. */
const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const taskID = (n: number) => uid(1, n)
const attemptID = (number: number) => uid(2, number)
const planTitles = (data: TrajectoryData) => [
  ...new Set([data.task.plan, ...data.others.map((task) => task.plan)]),
]
const planID = (data: TrajectoryData, title: string) => uid(3, planTitles(data).indexOf(title) + 1)
const ref = (n: number) => `LZ-${n}`
const FINGERPRINT = "c".repeat(64)

const BASIS = "worker progress hook, recorded by the LAZERS runner"

/* ---------------------------------------------------------------- events */

function toolEvent(call: DemoCall, kind: "tool" | "worker-tool"): TrajectoryEvent {
  const start = when(call.at)
  const end = when(call.at + call.s)
  const failed = call.status === "error"
  return {
    id: markID(call.attempt, call.key),
    at: start,
    kind,
    attemptID: attemptID(call.attempt),
    sessionID: sessionOf(call.attempt),
    callID: callID(call),
    tool: call.tool,
    status: call.status,
    completedAt: end,
    ...(call.command ? { command: call.command } : {}),
    ...(call.result ? { result: call.result } : {}),
    ...(failed ? { error: "Command exited with code 1" } : {}),
    ...(call.path && call.tool !== "Bash"
      ? {
          fileTargets: {
            coverage: "observed" as const,
            operation: call.tool === "Edit" ? ("edit" as const) : ("read" as const),
            paths: [call.path],
          },
        }
      : {}),
    timing: {
      endpoints: {
        calledAt: { at: start, source: BASIS, sourceType: "worker progress" },
        completedAt: { at: end, source: BASIS, sourceType: "worker progress" },
      },
    },
  }
}

function transitions(data: TrajectoryData) {
  const list: {
    at: number
    attempt: 1 | 2 | null
    event: string
    from: TaskState | null
    to: TaskState
    reason: string | null
  }[] = [{ at: 1, attempt: null, event: "QUEUED", from: null, to: "queued", reason: null }]
  for (const attempt of data.attempts) {
    list.push({
      at: attempt.start,
      attempt: attempt.number,
      event: "START",
      from: attempt.number === 1 ? "ready" : "failed",
      to: "running",
      reason: null,
    })
    if (attempt.workEnd !== null && attempt.state !== "failed")
      list.push({
        at: attempt.workEnd,
        attempt: attempt.number,
        event: "VERIFY",
        from: "running",
        to: "verifying",
        reason: null,
      })
    if (attempt.state === "failed" && attempt.end !== null)
      list.push({
        at: attempt.end,
        attempt: attempt.number,
        event: "FAIL",
        from: "running",
        to: "failed",
        reason: "The tests check failed",
      })
    if (attempt.state === "accepted" && attempt.end !== null)
      list.push({
        at: attempt.end,
        attempt: attempt.number,
        event: "ACCEPT",
        from: "verifying",
        to: "accepted",
        reason: null,
      })
  }
  return list
}

/* --------------------------------------------------------------- reports */

function check(data: TrajectoryData, value: DemoCheck): TrajectoryCheck {
  const done = value.end !== null
  return {
    id: value.id,
    scope: "attempt",
    attemptID: attemptID(value.attempt),
    state: done ? "completed" : "running",
    result: value.result,
    command: value.command,
    startedAt: when(value.start),
    endedAt: value.end === null ? null : when(value.end),
    timingBasis: "verification receipt",
    exitCode: value.exit ?? null,
    timedOut: done ? false : null,
    unchanged: done ? false : null,
    stdout: value.stdout ?? null,
    stderr: value.stderr ?? null,
    error: null,
  }
}

function report(
  data: TrajectoryData,
  events: TrajectoryEvent[],
  totalEvents: number,
): TrajectoryReport {
  const running = data.attempts.some((attempt) => attempt.end === null)
  const calls = data.calls.length
  const tokens = calls * 5_200
  return {
    schemaVersion: 1,
    task: {
      id: taskID(data.task.n),
      reference: ref(data.task.n),
      revision: 1,
      status: "submitted",
      recordedState: data.task.state,
      specification: { objective: data.task.objective },
    },
    plans: [
      {
        id: planID(data, data.task.plan),
        state: data.task.state === "accepted" ? "accepted" : "running",
        reason: null,
        taskReason: null,
        checks: [],
      },
    ],
    attempts: data.attempts.map((attempt) => ({
      id: attemptID(attempt.number),
      planID: planID(data, data.task.plan),
      number: attempt.number,
      state: attempt.state,
      sessionID: sessionOf(attempt.number),
      startedAt: when(attempt.start),
      intervals: {
        attempt: {
          startedAt: when(attempt.start),
          endedAt: attempt.end === null ? null : when(attempt.end),
          basis: "runner transitions",
        },
        modelActivity: {
          startedAt: when(attempt.start),
          endedAt: attempt.workEnd === null ? null : when(attempt.workEnd),
          basis: "worker progress hook",
        },
      },
      admittedModel: attempt.model,
      observedCurrentModel: attempt.model,
      toolCount: {
        value: data.calls.filter((call) => call.attempt === attempt.number).length,
        source: "worker progress hook",
      },
      checks: data.checks
        .filter((value) => value.attempt === attempt.number)
        .map((value) => check(data, value)),
    })),
    effort: {
      acceptedAt: data.task.state === "accepted" ? when(352) : null,
      firstAttemptAt: when(data.attempts[0]?.start ?? 0),
      tokenUsage: {
        measuredSubtotal: {
          uncachedInput: tokens,
          cacheRead: tokens * 6,
          cacheWrite: Math.round(tokens / 4),
          output: Math.round(tokens / 8),
          reasoning: Math.round(tokens / 16),
        },
        total: null,
        knownSessions: data.attempts.length,
        totalSessions: data.attempts.length,
        unknownAttempts: [],
      },
      toolCalls: { count: calls },
      recordedCost: { apiEquivalentTotalUsd: null },
    },
    coverage: {
      availableSessionContexts: data.attempts.length,
      unavailableSessionContexts: 0,
      fullSessionHistory: "available",
      compacted: false,
      ongoing: running,
      attemptsWithoutRecordedSessions: 0,
    },
    trajectory: {
      page: 1,
      limit: 50,
      totalEvents,
      events,
      nextCursor: null,
      hasMore: false,
    },
  }
}

/** Everything the capture knows at this moment: the recorded calls and the runner's transitions. */
function capturedEvents(data: TrajectoryData): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = data.calls.map((call) => toolEvent(call, "tool"))
  let sequence = 0
  for (const step of transitions(data))
    events.push({
      id: `transition-${++sequence}`,
      at: when(step.at),
      sequence,
      kind: "runner-transition",
      event: step.event,
      ...(step.from ? { from: step.from } : {}),
      to: step.to,
      ...(step.attempt ? { attemptID: attemptID(step.attempt) } : {}),
      ...(step.reason ? { reason: step.reason } : {}),
    })
  return events.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id))
}

/** The live attempt's progress facts, which status reads deliver on top of the capture. */
function liveEvents(data: TrajectoryData): TrajectoryEvent[] {
  return data.calls
    .filter((call) => call.attempt === 2)
    .map((call) => toolEvent(call, "worker-tool"))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

/* -------------------------------------------------------------- snapshot */

const machine = {
  id: "task-lifecycle",
  version: "demo",
  initialState: "queued" as const,
  states: [
    {
      id: "queued" as const,
      type: "atomic" as const,
      transitions: [{ event: "START", target: "running" as const }],
    },
    {
      id: "running" as const,
      type: "atomic" as const,
      transitions: [
        { event: "VERIFY", target: "verifying" as const },
        { event: "FAIL", target: "failed" as const },
      ],
    },
    {
      id: "verifying" as const,
      type: "atomic" as const,
      transitions: [
        { event: "ACCEPT", target: "accepted" as const },
        { event: "FAIL", target: "failed" as const },
      ],
    },
    {
      id: "failed" as const,
      type: "atomic" as const,
      transitions: [{ event: "START", target: "running" as const }],
    },
    { id: "accepted" as const, type: "final" as const, transitions: [] },
  ],
}

type NodeSpec = { n: number; title: string; state: TaskState; plan: string; after?: number }

function nodesFor(data: TrajectoryData, scope: ObservationScope): NodeSpec[] {
  const featured: NodeSpec = {
    n: data.task.n,
    title: data.task.title,
    state: data.task.state,
    plan: data.task.plan,
  }
  const others = data.others
    .filter((task) => scope.kind === "project" || task.session)
    .map((task): NodeSpec => ({ n: task.n, title: task.title, state: task.state, plan: task.plan }))
  return [featured, ...others].sort((a, b) => a.n - b.n)
}

function snapshot(data: TrajectoryData, scope: ObservationScope): SnapshotResponse {
  const nodes = nodesFor(data, scope)
  const titles = planTitles(data).filter((title) => nodes.some((node) => node.plan === title))
  const featuredPlan = planID(data, data.task.plan)
  const steps = transitions(data)
  return {
    schemaVersion: 1,
    projectID: PROJECT.id,
    scope:
      scope.kind === "project"
        ? { kind: "project" }
        : { kind: "session", sessionID: scope.sessionID },
    observedAt: new Date(Date.now()).toISOString(),
    boundary: {
      repositoryVersion: data.version,
      sourceRevision: 1,
      sourceFingerprint: FINGERPRINT,
      nativeRevision: 1,
      eventSequence: data.version,
      transitionSequence: steps.length,
    },
    machine,
    plans: titles.map((title, index) => {
      const members = nodes.filter((node) => node.plan === title)
      return {
        id: planID(data, title),
        revision: 1,
        version: data.version,
        state: members.every((node) => node.state === "accepted") ? "accepted" : "running",
        reason: null,
        title,
        priority: 10 - index,
        queuePosition: index,
        afterPlans: [],
        nodes: members.map((node, ordinal) => ({
          taskID: taskID(node.n),
          reference: ref(node.n),
          revision: 1 as const,
          objective: node.title,
          ordinal,
          state: node.state,
          version: data.version,
          reason: null,
          machineVersion: "demo",
          machineSupported: true,
          snapshot: null,
          snapshotMatchesState: true,
          waitingOn: [],
        })),
        dependencies: [],
      }
    }),
    unplannedTasks: [],
    attempts: data.attempts.map((attempt) => ({
      id: attemptID(attempt.number),
      planID: featuredPlan,
      taskID: taskID(data.task.n),
      number: attempt.number,
      state: attempt.state,
      startedAt: when(attempt.start),
      endedAt: null,
      timingBasis: "runner transitions",
      executions: [
        {
          startedAt: when(attempt.start),
          endedAt: attempt.workEnd === null ? null : when(attempt.workEnd),
          startSequence: 2,
          endSequence: attempt.workEnd === null ? null : 3,
          timingBasis: "worker progress hook",
        },
      ],
    })),
    checks: data.checks.map((value) => ({
      id: `${featuredPlan}:${attemptID(value.attempt)}:${value.id}`,
      planID: featuredPlan,
      taskID: taskID(data.task.n),
      attemptID: attemptID(value.attempt),
      checkID: value.id,
      scope: "attempt" as const,
      state: value.end === null ? "running" : "completed",
      startedAt: when(value.start),
      endedAt: value.end === null ? null : when(value.end),
      exitCode: value.exit ?? null,
      timingBasis: "verification receipt",
    })),
  }
}

function scopeView(scope: ObservationScope) {
  return scope.kind === "project"
    ? ({ kind: "project" } as const)
    : ({ kind: "session", sessionID: scope.sessionID } as const)
}

function boundary(data: TrajectoryData) {
  return {
    repositoryVersion: data.version,
    sourceRevision: 1,
    sourceFingerprint: FINGERPRINT,
    nativeRevision: 1,
    eventSequence: data.version,
    transitionSequence: transitions(data).length,
  }
}

function history(data: TrajectoryData, scope: ObservationScope): TrajectoryHistoryResponse {
  const events = capturedEvents(data)
  return {
    schemaVersion: 1,
    projectID: PROJECT.id,
    scope: scopeView(scope),
    boundary: boundary(data),
    capturedAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * SEC,
    eventIDs: events.map((event) => event.id),
    report: report(data, events, events.length),
  }
}

function status(data: TrajectoryData, scope: ObservationScope): TrajectoryResponse {
  const events = liveEvents(data)
  return {
    schemaVersion: 1,
    projectID: PROJECT.id,
    scope: scopeView(scope),
    boundary: boundary(data),
    report: report(data, events, events.length),
  }
}

type Input = { scope: ObservationScope }

export function rpc(data: () => TrajectoryData) {
  return {
    [Observability.id]: {
      snapshot: (input: Input) => snapshot(data(), input.scope),
      trajectoryHistory: (input: Input) => history(data(), input.scope),
      trajectoryStatus: (input: Input) => status(data(), input.scope),
    },
  } as Record<string, Record<string, (input: never) => unknown>>
}

/** The panel's own report parser as a schema: a report the panel would reject fails the build. */
const panelReport = {
  "~standard": {
    version: 1 as const,
    vendor: "lazers-demo",
    validate(value: unknown) {
      try {
        parseTrajectoryReport({ report: value } as never)
        return { value }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
}

const SESSION_SCOPE: ObservationScope = { kind: "session", sessionID: OWNER_SESSION }
const PROJECT_SCOPE: ObservationScope = { kind: "project", sessionID: OWNER_SESSION }

/** Every distinct read this data answers, with the contract schema that must accept it. */
export function reads(data: TrajectoryData): Read[] {
  const out: Read[] = []
  for (const scope of [SESSION_SCOPE, PROJECT_SCOPE])
    out.push({
      label: `lazers.observability.snapshot ${scope.kind}`,
      schema: Observability.methods.snapshot.output,
      value: snapshot(data, scope),
    })
  const captured = history(data, SESSION_SCOPE)
  out.push({
    label: "lazers.observability.trajectoryHistory",
    schema: Observability.methods.trajectoryHistory.output,
    value: captured,
  })
  out.push({ label: "trajectory history report", schema: panelReport, value: captured.report })
  const live = status(data, SESSION_SCOPE)
  out.push({
    label: "lazers.observability.trajectoryStatus",
    schema: Observability.methods.trajectoryStatus.output,
    value: live,
  })
  out.push({ label: "trajectory status report", schema: panelReport, value: live.report })
  return out
}

/**
 * What the service emits after a change. The panel refreshes only on a sequence newer than the
 * last boundary it read, so the sequence is the data's own change counter.
 */
export const trajectoryChanged = (
  data: Pick<TrajectoryData, "version">,
  emit: (type: string, data: unknown) => void,
) =>
  emit("rpc.lazers.observability.changed", {
    projectID: PROJECT.id,
    sequence: data.version,
    repositoryVersion: data.version,
    sourceRevision: 1,
    nativeRevision: 1,
    cause: "runner",
    resnapshotRequired: false,
  })

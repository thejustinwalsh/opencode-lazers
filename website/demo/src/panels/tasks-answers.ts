import { CurrentActivityOutput, Tasks } from "../../../../src/tasks/contract.ts"
import type {
  TaskPage,
  TaskDetail,
  TaskSummary,
  CurrentTaskActivity,
} from "../../../../src/tasks/contract.ts"
import { TasksScheduling } from "../../../../src/tasks/scheduling-contract.ts"
import type { SchedulingPage, SchedulingNode } from "../../../../src/tasks/scheduling-contract.ts"
import type { TaskState } from "../../../../src/runner/schema.ts"
import type { Read } from "../adapter.ts"
import { Streams } from "../../../../src/streams/contract.ts"
import { taskStreams } from "./tasks-streams.ts"

/**
 * Pure answers for the Tasks panel: a compact description of the tasks at one moment, expanded
 * into the exact contract shapes (`lazers.tasks`, `lazers.tasks.scheduling`, the observability
 * topology) the real panel reads. No browser or Solid code, so the build script can validate it.
 */
export interface DemoTask {
  /** Reference number: 204 is LZ-204. */
  n: number
  title: string
  state: TaskState
  /** Plan the task belongs to. */
  plan: string
  objective?: string
  /** Reference numbers of prerequisite tasks. */
  after?: number[]
  /** Why a blocked task waits. */
  reason?: string
  /** Minutes ago the current attempt started; for running and verifying tasks. */
  startedMin?: number
  model?: { providerID: string; id: string; variant?: string }
  /** Tool calls the current attempt has made so far. */
  calls?: number
  files?: number
}
export interface TasksData {
  tasks: DemoTask[]
}

export const PROJECT = { canonical: "/workspace/lazers-demo", id: "demo-project" }
const SESSION = "ses-demo"
const CREATED = "2026-11-19T13:56:00.000Z"
const MIN = 60_000

/** RFC 4122 v4-shaped ids, stable per kind and number. */
const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const taskID = (n: number) => uid(1, n)
const attemptID = (n: number) => uid(2, n)
const planIDs = (data: TasksData) => {
  const titles = [...new Set(data.tasks.map((task) => task.plan))]
  return new Map(titles.map((title, index) => [title, uid(3, index + 1)]))
}
const ref = (n: number) => `LZ-${n}`
const nByAny = (id: string) => {
  const match = /^LZ-(\d+)$/.exec(id)
  return match ? Number(match[1]) : parseInt(id.slice(-12), 16)
}

const classification = {
  revision: 1,
  classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
  provenance: { kind: "embedded", sessionID: SESSION, createdAt: CREATED },
} as const

const openStates = new Set<TaskState>(["queued", "ready", "running", "verifying", "blocked"])
const filters: Record<string, (state: TaskState) => boolean> = {
  open: (s) => openStates.has(s),
  queued: (s) => s === "queued" || s === "ready",
  running: (s) => s === "running" || s === "verifying",
  blocked: (s) => s === "blocked",
  paused: () => false,
  completed: (s) => s === "accepted" || s === "incorporated",
  accepted: (s) => s === "accepted",
  integrated: (s) => s === "incorporated",
  failed: (s) => s === "failed" || s === "exhausted",
  cancelled: (s) => s === "cancelled",
  all: () => true,
}

function summary(data: TasksData, task: DemoTask): TaskSummary {
  const live = task.state === "running" || task.state === "verifying"
  return {
    taskID: taskID(task.n),
    reference: ref(task.n),
    revision: 1,
    status: task.state,
    recordedState: task.state,
    ...(live && task.startedMin !== undefined
      ? { startedAt: Date.now() - task.startedMin * MIN }
      : {}),
    reason: task.state === "blocked" ? (task.reason ?? null) : null,
    classification,
    title: task.title,
    objective: task.objective ?? task.title,
    createdAt: CREATED,
    sessionID: SESSION,
    matches: [],
  }
}

function proposal(task: DemoTask) {
  return {
    objective: task.objective ?? task.title,
    classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
    exclusions: ["Do not change the public settings format"],
    constraints: ["Keep the change inside the listed write scope"],
    assumptions: [],
    writeScope: ["src/**"],
    context: [{ reference: "README.md", revision: null }],
    acceptance: [
      {
        id: "behavior",
        assertion: `${task.title}: the behavior is covered by a test that fails without the change`,
        evidence: [{ kind: "verification", verificationID: "tests" }],
      },
      {
        id: "types",
        assertion: "The typecheck passes",
        evidence: [{ kind: "verification", verificationID: "check" }],
      },
    ],
    requirements: { capabilities: [], skills: [], risk: "low", policyReference: "AGENTS.md" },
    verification: [
      { id: "tests", command: "bun test", timeoutMs: 120_000 },
      { id: "check", command: "bun check", timeoutMs: 120_000 },
    ],
  } as const
}

function detail(data: TasksData, id: string): TaskDetail {
  const task = data.tasks.find((candidate) => candidate.n === nByAny(id))
  if (!task) return { status: "not_found" }
  const plans = planIDs(data)
  const live = task.state === "running" || task.state === "verifying"
  const now = Date.now()
  const started = now - (task.startedMin ?? 0) * MIN
  const calls = task.calls ?? 0
  return {
    status: "found",
    task: {
      schemaVersion: 1,
      id: taskID(task.n),
      revision: 1,
      status: "submitted",
      createdAt: CREATED,
      provenance: {
        projectID: PROJECT.id,
        projectDirectory: PROJECT.canonical,
        workspaceDirectory: PROJECT.canonical,
        sessionID: SESSION,
        startingRevision: { kind: "unborn" },
      },
      proposal: proposal(task) as never,
    },
    classification,
    classificationHistory: [classification],
    advice: null,
    reference: ref(task.n),
    recordedState: task.state,
    execution: {
      planID: plans.get(task.plan)!,
      taskID: taskID(task.n),
      state: task.state,
      version: 1,
      reason: task.state === "blocked" ? (task.reason ?? null) : null,
      waitingOn: (task.after ?? [])
        .filter((n) => data.tasks.find((t) => t.n === n && openStates.has(t.state)))
        .map(taskID),
    },
    attempts: live
      ? [
          {
            id: attemptID(task.n),
            number: 1,
            state: task.state,
            startedAt: started,
            artifact: null,
            tokenCount: calls * 5_200,
            toolCount: calls,
            ...(task.model ? { model: task.model } : {}),
            summary: {
              lastActivityAt: now - 20_000,
              ticks: Array.from({ length: calls }, (_, i) => ({
                at: started + ((i + 1) * (now - started)) / (calls + 1),
              })),
              ...(task.files ? { files: task.files } : {}),
            },
          },
        ]
      : [],
    activity: [],
  }
}

type Scope = { kind: "session" | "project"; sessionID: string }
const SCOPE: Scope = { kind: "project", sessionID: SESSION }

function scheduling(data: TasksData, scope: Scope = SCOPE): SchedulingPage {
  const plans = planIDs(data)
  const waiting = (task: DemoTask) =>
    (task.after ?? []).filter((n) => data.tasks.find((t) => t.n === n && openStates.has(t.state)))
  let first: DemoTask | undefined
  const nodesOf = (title: string): SchedulingNode[] =>
    data.tasks
      .filter((task) => task.plan === title)
      .map((task, ordinal) => {
        const blockers = waiting(task)
        const queued = task.state === "queued" || task.state === "ready"
        const decision = queued ? (blockers.length ? "waiting" : "eligible") : "not-applicable"
        if (decision === "eligible" && !first) first = task
        return {
          taskID: taskID(task.n),
          reference: ref(task.n),
          title: task.title,
          objective: task.objective ?? task.title,
          ordinal,
          order: ordinal,
          lifecycle: task.state,
          decision,
          reason: blockers.length ? `Waiting on ${blockers.map(ref).join(", ")}` : null,
          prerequisites: (task.after ?? []).map(taskID),
          waitingOn: blockers.map(taskID),
          reservationTaskIDs: [],
        }
      })
  const planList = [...plans].map(([title, id], index) => ({
    planID: id,
    planVersion: 1,
    planOrder: index,
    priority: 10 - index,
    title,
    lifecycle: "running",
    decision: "eligible" as const,
    reason: null,
    afterPlans: [],
    nodes: nodesOf(title),
    nodesComplete: true,
  }))
  return {
    schemaVersion: 1,
    snapshotID: uid(4, 1),
    repositoryVersion: 1,
    scope,
    observedAt: Date.now(),
    coverage: {
      status: "complete",
      planCount: planList.length,
      coveredPlanCount: planList.length,
      nodeCount: data.tasks.length,
      coveredNodeCount: data.tasks.length,
      activeReservationCount: 0,
      reservationsComplete: true,
      reason: null,
    },
    next: first
      ? {
          status: "known",
          candidate: {
            planID: plans.get(first.plan)!,
            taskID: taskID(first.n),
            reference: ref(first.n),
            title: first.title,
            priority: 10,
            planOrder: 0,
            ordinal: 0,
            order: 0,
          },
        }
      : { status: "none" },
    selectedTaskIDs: data.tasks.map((task) => taskID(task.n)),
    selectionComplete: true,
    plans: planList,
    nextCursor: null,
  }
}

function currentActivity(data: TasksData, ids: string[]) {
  return {
    activities: ids.map((id): CurrentTaskActivity => {
      const task = data.tasks.find((candidate) => candidate.n === nByAny(id))
      const live = task?.state === "running" || task?.state === "verifying"
      return {
        taskID: id,
        ...(live ? { workerSessionID: `ses-worker-${task!.n}` } : {}),
        attemptID: live ? attemptID(task!.n) : null,
        foreground: live ? "active" : "unknown",
        unknownReason: live ? null : "no-current-attempt",
        recordedState: task?.state ?? null,
        waiting: task?.state === "blocked",
        holdReason: task?.state === "blocked" ? (task.reason ?? null) : null,
        pendingInput: live ? false : null,
        pendingPermissions: live ? 0 : null,
        pendingForms: live ? 0 : null,
        outcome: null,
        observedAt: Date.now(),
      }
    }),
  }
}

export function rpc(data: () => TasksData) {
  // The detail and the rows' current activity read as streams; Models still reads `get`.
  const streams = taskStreams(data, PROJECT.canonical, {
    detail: (id) => detail(data(), id),
    currentActivity: (ids) => currentActivity(data(), ids),
  })
  return {
    [Streams.id]: streams,
    [Tasks.id]: {
      get: (input: { taskID: string }) => detail(data(), input.taskID),
    },
    [TasksScheduling.id]: { read: (input: { scope: Scope }) => scheduling(data(), input.scope) },
  } as Record<string, Record<string, (input: never) => unknown>>
}

/** Every distinct read this data answers, with the contract schema that must accept it. */
export function reads(data: TasksData): Read[] {
  const out: Read[] = []
  for (const task of data.tasks)
    out.push({
      label: `lazers.tasks.get ${ref(task.n)}`,
      schema: Tasks.methods.get.output,
      value: detail(data, ref(task.n)),
    })
  out.push({
    label: "tasks.currentActivity (stream composition)",
    schema: CurrentActivityOutput,
    value: currentActivity(data, data.tasks.map((task) => taskID(task.n)).slice(0, 40)),
  })
  out.push({
    label: "lazers.tasks.scheduling.read",
    schema: TasksScheduling.methods.read.output,
    value: scheduling(data),
  })
  return out
}

export const tasksChanged = (emit: (type: string, data: unknown) => void) =>
  emit("rpc.lazers.tasks.changed", { projectDirectory: PROJECT.canonical, version: Date.now() })

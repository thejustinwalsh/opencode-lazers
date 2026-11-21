import type { Columns } from "../streams/frame.ts"
import type { SourceRef } from "../streams/source.ts"
import {
  taskActivityPayloadsRef,
  taskActivityRef,
  taskAttemptCallsRef,
  taskAttemptsRef,
  taskCurrentActivityRef,
  taskDetailRef,
  type TaskScope,
} from "../streams/sources/tasks-ref.ts"
import { TaskSpecSchema } from "../task.ts"
import { AttemptModel, type AttemptSummary } from "./attempt-summary.ts"
import type { CurrentActivityOutput, CurrentTaskActivity, TaskDetail } from "./contract.ts"

/**
 * The selected task's detail, the agent tool's `lz-get-task` and the rows' current activity,
 * composed from stream windows over stored rows (`tasks.detail`, `tasks.attempts`,
 * `tasks.activity`, `tasks.attemptCalls`, `tasks.currentActivity`). The same code runs in the GUI
 * (windows over the Streams RPC) and in the service (windows on the reader pool), so the panel
 * and the tool cannot drift apart, and neither reads on the plugin main thread.
 *
 * ```
 *  tasks.detail (window 1) ─┬─ no execution ──────────────────────────────► detail
 *                           └─ plan ─┬─ tasks.attempts (whole) ─ latest ─┬─ tasks.attemptCalls (tools, whole)
 *                                    │                                   └─ tasks.attemptCalls (newest, 1)
 *                                    └─ tasks.activity[Payloads] (whole) ──► detail
 * ```
 */
export type WindowRead = <F, C extends Columns>(
  source: SourceRef<F, C>,
  options: {
    filter: F
    order: string
    window: number
    anchor?: "head" | "tail" | { key: readonly unknown[]; place: "start" | "center" }
  },
) => Promise<Array<Record<string, unknown>>>

/** First window of a whole read; it doubles while a window comes back full. A unit, not a cap. */
const WHOLE_WINDOW = 64

/** Every row of a stream, a window at a time: the window grows until the rows fit. */
export async function readWhole<F, C extends Columns>(
  read: WindowRead,
  source: SourceRef<F, C>,
  options: { filter: F; order: string },
) {
  for (let window = WHOLE_WINDOW; ; window *= 2) {
    // A window of 1 carries the cold columns; a whole read never wants them.
    const rows = await read(source, { ...options, window: Math.max(window, 2) })
    if (rows.length < Math.max(window, 2)) return rows
  }
}

export type TaskDetailQuery = {
  project: string
  /** Over RPC: the caller's view, checked by the service. */
  scope?: TaskScope
  /** A task id or a `<CODE>-<n>` reference. */
  taskID: string
  revision?: number
  classificationRevision?: number
  /** Only a task this session created (the agent tool's `sessionID`). */
  creator?: string
  /** Only a task linked to this session (a server-side session view). */
  session?: string
}

type Found = Extract<TaskDetail, { status: "found" }>
type Activity = NonNullable<Found["activity"]>[number]
/** The detail the panel holds: the History rows carry a payload only once read. */
export type PanelActivity = Omit<Activity, "payload"> & { payload?: string }
export type PanelTaskDetail =
  | (Omit<Found, "activity"> & { activity?: PanelActivity[] })
  | Exclude<TaskDetail, { status: "found" }>

/** The transitions the scope review reads: the latest scope report and amendment. */
export const SCOPE_EVENTS = ["SCOPE_REPORTED", "SCOPE_AMENDED"] as const

const UUID = /^[0-9a-f]{8}-/i
const text = (value: unknown) => (typeof value === "string" ? value : null)

function summaryOf(
  ticks: readonly Record<string, unknown>[],
  newest: Record<string, unknown> | undefined,
): AttemptSummary {
  const files = new Set<string>()
  for (const row of ticks) {
    const targets = row.file_targets_json as { operation?: unknown; paths?: unknown } | null
    if (targets?.operation !== "edit" && targets?.operation !== "patch") continue
    if (Array.isArray(targets.paths))
      for (const path of targets.paths) if (typeof path === "string" && path) files.add(path)
  }
  return {
    ...(newest ? { lastActivityAt: Number(newest.at) } : {}),
    ticks: ticks.map((row) => ({
      at: Number(row.at),
      ...(row.status === "failed" ? { failed: true as const } : {}),
    })),
    ...(files.size ? { files: files.size } : {}),
  }
}

/**
 * One task's detail. `payloads: "all"` carries every transition's payload (the agent tool);
 * `"scope"` only the latest scope report and amendment, the rest read when a History row opens
 * (`readActivityPayload`).
 */
export async function readTaskDetail(
  read: WindowRead,
  query: TaskDetailQuery,
  options: { payloads: "all" },
): Promise<TaskDetail>
export async function readTaskDetail(
  read: WindowRead,
  query: TaskDetailQuery,
  options: { payloads: "scope" },
): Promise<PanelTaskDetail>
export async function readTaskDetail(
  read: WindowRead,
  query: TaskDetailQuery,
  options: { payloads: "all" | "scope" },
): Promise<TaskDetail | PanelTaskDetail> {
  const base = {
    project: query.project,
    ...(query.scope ? { scope: query.scope } : {}),
    ...(query.creator !== undefined ? { creator: query.creator } : {}),
    ...(query.session !== undefined ? { session: query.session } : {}),
  }
  const [row] = await read(taskDetailRef, {
    filter: {
      ...base,
      ...(UUID.test(query.taskID) ? { task: query.taskID } : { reference: query.taskID }),
    },
    order: "task",
    window: 1,
  })
  if (!row) return { status: "not_found" }
  const task = TaskSpecSchema.parse(row.body)
  if (query.revision !== undefined && query.revision !== task.revision)
    return { status: "revision_unavailable", revision: task.revision }
  const history = (row.classification_history ?? []) as Found["classificationHistory"]
  const found = {
    status: "found" as const,
    task,
    classification: row.classification as Found["classification"],
    classificationHistory: history,
    advice: (row.advice ?? null) as Found["advice"],
    ...(row.audit_history ? { auditHistory: row.audit_history as Found["auditHistory"] } : {}),
    ...(query.classificationRevision !== undefined
      ? {
          classificationAtRevision:
            history.find((item) => item.revision === query.classificationRevision) ?? null,
        }
      : {}),
    reference: String(row.reference),
    ...(row.disposition ? { disposition: row.disposition as Found["disposition"] } : {}),
  }
  const execution = row.execution as Found["execution"] | null
  if (!execution) return found
  const child = { ...base, task: task.id, plan: execution.planID }
  const attemptRows = await readWhole(read, taskAttemptsRef, { filter: child, order: "started" })
  const latest = attemptRows.at(-1)
  let summary: AttemptSummary | undefined
  if (latest) {
    const calls = { ...child, attempt: String(latest.id), sessionID: String(latest.session_id) }
    try {
      const [ticks, newest] = await Promise.all([
        readWhole(read, taskAttemptCallsRef, {
          filter: { ...calls, toolsOnly: true },
          order: "calls",
        }),
        read(taskAttemptCallsRef, { filter: calls, order: "recent", window: 2 }),
      ])
      summary = summaryOf(ticks, newest[0])
    } catch {
      // A failed summary read leaves the pane without it, as before.
      summary = undefined
    }
  }
  const attempts = attemptRows.map((attempt) => {
    const model = AttemptModel.safeParse(attempt.model)
    return {
      id: String(attempt.id),
      number: Number(attempt.number),
      state: String(attempt.state),
      startedAt: Number(attempt.started_at),
      artifact: text(attempt.artifact),
      tokenCount: attempt.token_count === null ? null : Number(attempt.token_count),
      toolCount: Number(attempt.tool_count),
      ...(attempt.takeover ? { takeover: true as const } : {}),
      ...(model.success ? { model: model.data } : {}),
      ...(attempt === latest && summary ? { summary } : {}),
    }
  })
  const activityOf = (event: Record<string, unknown>) => ({
    id: Number(event.transition_id),
    taskID: text(event.task_id),
    event: String(event.event),
    createdAt: Number(event.at),
  })
  let activity: PanelActivity[]
  if (options.payloads === "all")
    activity = (
      await readWhole(read, taskActivityPayloadsRef, { filter: child, order: "transition" })
    ).map((event) => ({ ...activityOf(event), payload: String(event.payload) }))
  else {
    const [events, scoped] = await Promise.all([
      readWhole(read, taskActivityRef, { filter: child, order: "transition" }),
      readWhole(read, taskActivityPayloadsRef, {
        filter: { ...child, events: SCOPE_EVENTS },
        order: "transition",
      }),
    ])
    const latestOf = new Map<string, Record<string, unknown>>()
    for (const event of scoped) latestOf.set(String(event.event), event)
    const kept = new Map(
      [...latestOf.values()].map((event) => [Number(event.transition_id), String(event.payload)]),
    )
    activity = events.map((event) => {
      const payload = kept.get(Number(event.transition_id))
      return { ...activityOf(event), ...(payload !== undefined ? { payload } : {}) }
    })
  }
  return {
    ...found,
    recordedState: (row.node_state as Found["recordedState"]) ?? null,
    execution,
    ...(row.architect_session_id ? { architectSessionID: String(row.architect_session_id) } : {}),
    attempts,
    activity,
  }
}

/** One History row's payload, read when the row opens: `tasks.activity` at window 1. */
export async function readActivityPayload(
  read: WindowRead,
  query: { project: string; scope?: TaskScope; taskID: string; planID: string; id: number },
): Promise<string | undefined> {
  const [row] = await read(taskActivityRef, {
    filter: {
      project: query.project,
      ...(query.scope ? { scope: query.scope } : {}),
      task: query.taskID,
      plan: query.planID,
    },
    order: "transition",
    window: 1,
    anchor: { key: [query.id], place: "start" },
  })
  return row && Number(row.transition_id) === query.id ? String(row.payload) : undefined
}

const WORKER_AGENTS = new Set(["lazers-implementor", "auditor"])
const OUTCOMES = new Set(["succeeded", "failed", "interrupted"])
const TERMINAL = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])
const absolute = (path: unknown): path is string =>
  typeof path === "string" && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))
/** `path.resolve` for the comparison the old read made, without Node in the GUI. */
const normalized = (path: string) => {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

/**
 * The current activity of the rows in view, from one `tasks.currentActivity` window. A task the
 * scope cannot read is `unavailable`; a task with no attempt in its plan `no-current-attempt`; an
 * attempt whose stored session is not exactly that worker (agent, attempt id, checkout) is
 * `unavailable` with its ids, as the host reads were.
 */
export async function readCurrentActivity(
  read: WindowRead,
  query: { project: string; scope?: TaskScope; session?: string; taskIDs: readonly string[] },
): Promise<CurrentActivityOutput> {
  if (query.taskIDs.length === 0) return { activities: [] }
  const rows = await read(taskCurrentActivityRef, {
    filter: {
      project: query.project,
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.session !== undefined ? { session: query.session } : {}),
      tasks: query.taskIDs,
    },
    order: "task",
    window: Math.max(query.taskIDs.length, 2),
  })
  const byID = new Map(rows.map((row) => [String(row.task_id), row]))
  const quiet = {
    pendingInput: null,
    pendingPermissions: null,
    pendingForms: null,
    outcome: null,
    observedAt: null,
  }
  return {
    activities: query.taskIDs.map((taskID): CurrentTaskActivity => {
      const row = byID.get(taskID)
      if (!row)
        return {
          taskID,
          attemptID: null,
          foreground: "unknown",
          unknownReason: "unavailable",
          recordedState: null,
          waiting: false,
          holdReason: null,
          ...quiet,
        }
      const nodeState = text(row.node_state)
      const planState = text(row.plan_state)
      const waiting = Boolean(
        nodeState &&
        planState !== "cancelled" &&
        (nodeState === "blocked" || (planState === "blocked" && !TERMINAL.has(nodeState))),
      )
      const held = {
        recordedState: nodeState as CurrentTaskActivity["recordedState"],
        waiting,
        holdReason: waiting ? (text(row.node_reason) ?? text(row.plan_reason)) : null,
      }
      const attemptID = text(row.attempt_id)
      const sessionID = text(row.attempt_session_id)
      if (!nodeState || !attemptID || !sessionID)
        return {
          taskID,
          attemptID: null,
          foreground: "unknown",
          unknownReason: "no-current-attempt",
          ...held,
          ...quiet,
        }
      const matches =
        WORKER_AGENTS.has(String(row.host_agent)) &&
        row.host_attempt_id === attemptID &&
        absolute(row.host_directory) &&
        absolute(row.attempt_workspace) &&
        normalized(row.host_directory) === normalized(row.attempt_workspace) &&
        typeof row.busy === "boolean"
      if (!matches)
        return {
          taskID,
          workerSessionID: sessionID,
          attemptID,
          foreground: "unknown",
          unknownReason: "unavailable",
          ...held,
          ...quiet,
        }
      const outcome = text(row.outcome)
      return {
        taskID,
        workerSessionID: sessionID,
        attemptID,
        foreground: row.busy ? "active" : "inactive",
        archived: Boolean(row.archived),
        unknownReason: null,
        ...held,
        pendingInput: Boolean(row.pending_input),
        pendingPermissions: Number(row.pending_permissions),
        pendingForms: Number(row.pending_forms),
        outcome:
          outcome && OUTCOMES.has(outcome) ? (outcome as CurrentTaskActivity["outcome"]) : null,
        observedAt: row.observed_at === null ? null : Number(row.observed_at),
      }
    }),
  }
}

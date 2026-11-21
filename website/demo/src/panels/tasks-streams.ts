import type { Columns } from "../../../../src/streams/frame.ts"
import { streamAnswers, type Open, type DemoRow } from "./stream-answers.ts"
import {
  TASK_SOURCES,
  taskBucketCountColumns,
  taskDependencyRowColumns,
  taskIndexColumns,
  taskPlanColumns,
  taskScheduleColumns,
  taskSessionBucketCountColumns,
  taskBlockerColumns,
  taskWaitColumns,
  taskActivityColumns,
  taskActivityPayloadColumns,
  taskAttemptCallColumns,
  taskAttemptColumns,
  taskCurrentActivityColumns,
  taskDetailColdColumns,
  taskDetailColumns,
} from "../../../../src/streams/sources/tasks-ref.ts"
import type { CurrentActivityOutput, TaskDetail } from "../../../../src/tasks/contract.ts"
import { BUCKETS, type Bucket } from "../../../../src/tasks/schedule/buckets.ts"
import { bucketsFor } from "../../../../src/tasks/schedule/key.ts"
import type { TaskState } from "../../../../src/runner/schema.ts"
import type { DemoTask, TasksData } from "./tasks-answers.ts"

/**
 * The demo's answer to `lazers.streams` for the Tasks sources: the same frames the real reader
 * writes (the real codec), over rows built from the demo's mock tasks. Windows slide and seek
 * over the sorted rows, so the list scrolls, anchors and counts the way it does live.
 */

const SESSION = "ses-demo"
const CREATED = "2026-11-19T13:56:00.000Z"
const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

const bucketOfState = (state: TaskState): Bucket =>
  state === "running" || state === "verifying"
    ? "running"
    : state === "queued" || state === "ready"
      ? "queued"
      : state === "blocked"
        ? "blocked"
        : state === "accepted"
          ? "accepted"
          : state === "incorporated"
            ? "integrated"
            : state === "failed" || state === "exhausted"
              ? "failed"
              : "cancelled"

const rankOfBucket = (bucket: Bucket) =>
  bucket === "running"
    ? 0
    : bucket === "accepted"
      ? 2
      : bucket === "integrated"
        ? 3
        : bucket === "failed"
          ? 4
          : bucket === "cancelled"
            ? 5
            : 1

const pad = (value: number) => String(value).padStart(6, "0")

export function scheduleRows(data: TasksData, project: string): DemoRow[] {
  const plans = new Map(
    [...new Set(data.tasks.map((task) => task.plan))].map((title, index) => [title, index + 1]),
  )
  return data.tasks.map((task: DemoTask) => {
    const bucket = bucketOfState(task.state)
    const live = bucket === "running"
    return {
      task_id: uid(1, task.n),
      seq: task.n,
      sort_key: `${rankOfBucket(bucket)}${pad(plans.get(task.plan) ?? 0)}${pad(task.n)}`,
      reference: `LZ-${task.n}`,
      title: task.title,
      objective: task.objective ?? task.title,
      status: task.state,
      reason: task.state === "blocked" ? (task.reason ?? null) : null,
      node_reason: task.state === "blocked" ? (task.reason ?? null) : null,
      plan_reason: null,
      node_state: task.state,
      plan_state: "running",
      bucket,
      plan_id: uid(3, plans.get(task.plan) ?? 0),
      ordinal: task.n,
      priority_key: plans.get(task.plan) ?? 0,
      started_at:
        live && task.startedMin !== undefined ? Date.now() - task.startedMin * 60_000 : null,
      takeover: false,
      classification: {
        revision: 1,
        classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
        provenance: { kind: "embedded", sessionID: SESSION, createdAt: CREATED },
      },
      concern: null,
      concern_totals: null,
      dispatch_pause: null,
      dispatch_pause_plan_id: null,
      dependency_count: task.after?.length ?? 0,
      blocker_count: 0,
      wait_plans_count: 0,
      wait_plan_ids: [],
      blocker_task_ids: [],
      dependency_waiting: false,
      decision: bucket === "queued" ? "eligible" : "not-applicable",
      decision_reason: null,
      disposition: null,
      retired: false,
      stale: false,
      source_plan: null,
      revision: 1,
      session_id: SESSION,
      created_at: CREATED,
      project_directory: project,
    }
  })
}

const SOURCES: Record<string, { columns: Columns; key: string[] }> = {
  [TASK_SOURCES.schedule]: { columns: taskScheduleColumns, key: ["task_id"] },
  [TASK_SOURCES.bucketCounts]: {
    columns: taskBucketCountColumns,
    key: ["project_directory", "bucket"],
  },
  [TASK_SOURCES.sessionBucketCounts]: {
    columns: taskSessionBucketCountColumns,
    key: ["session_id", "project_directory", "bucket"],
  },
  [TASK_SOURCES.index]: { columns: taskIndexColumns, key: ["project_directory"] },
  [TASK_SOURCES.plans]: { columns: taskPlanColumns, key: ["plan_id"] },
  [TASK_SOURCES.dependencies]: {
    columns: taskDependencyRowColumns,
    key: ["parent_task_id", "ord"],
  },
  [TASK_SOURCES.blockers]: { columns: taskBlockerColumns, key: ["task_id", "blocker_task_id"] },
  [TASK_SOURCES.waits]: { columns: taskWaitColumns, key: ["task_id", "ord"] },
  [TASK_SOURCES.detail]: {
    columns: { ...taskDetailColumns, ...taskDetailColdColumns },
    key: ["task_id"],
  },
  [TASK_SOURCES.attempts]: { columns: taskAttemptColumns, key: ["id"] },
  [TASK_SOURCES.activity]: {
    columns: { ...taskActivityColumns, ...taskActivityPayloadColumns },
    key: ["transition_id"],
  },
  [TASK_SOURCES.activityPayloads]: {
    columns: { ...taskActivityColumns, ...taskActivityPayloadColumns },
    key: ["transition_id"],
  },
  [TASK_SOURCES.attemptCalls]: { columns: taskAttemptCallColumns, key: ["seq"] },
  [TASK_SOURCES.currentActivity]: { columns: taskCurrentActivityColumns, key: ["task_id"] },
}

/** What the demo's mock detail and activity reads answer; the frames are built from them. */
export type DetailAnswers = {
  detail(taskID: string): TaskDetail
  currentActivity(taskIDs: string[]): CurrentActivityOutput
}

/**
 * The detail sources' rows, from the mock detail: the same rows the stored projection holds for
 * it, so `readTaskDetail` and `readCurrentActivity` compose the mock detail back.
 */
function detailRowsOf(answers: DetailAnswers, open: Open): DemoRow[] | undefined {
  const filter = open.filter
  const found = (id: unknown) => {
    const detail = answers.detail(String(id))
    return detail.status === "found" ? detail : undefined
  }
  switch (open.source) {
    case TASK_SOURCES.detail: {
      const detail = found(filter.task ?? filter.reference)
      if (!detail) return []
      return [
        {
          task_id: detail.task.id,
          reference: detail.reference,
          revision: detail.task.revision,
          status: detail.execution?.state ?? detail.task.status,
          node_state: detail.recordedState ?? null,
          plan_id: detail.execution?.planID ?? null,
          session_id: detail.task.provenance.sessionID,
          retired: false,
          body: detail.task,
          execution: detail.execution ?? null,
          classification: detail.classification,
          classification_history: detail.classificationHistory,
          advice: detail.advice,
          audit_history: detail.auditHistory ?? null,
          disposition: detail.disposition ?? null,
          architect_session_id: detail.architectSessionID ?? null,
        },
      ]
    }
    case TASK_SOURCES.attempts:
      return (found(filter.task)?.attempts ?? []).map((attempt) => ({
        id: attempt.id,
        number: attempt.number,
        state: attempt.state,
        started_at: attempt.startedAt,
        artifact: attempt.artifact,
        token_count: attempt.tokenCount,
        tool_count: attempt.toolCount,
        session_id: `ses-worker-${attempt.id}`,
        takeover: Boolean(attempt.takeover),
        model: attempt.model ?? null,
      }))
    case TASK_SOURCES.attemptCalls: {
      const latest = found(filter.task)?.attempts?.at(-1)
      const summary = latest && latest.id === filter.attempt ? latest.summary : undefined
      if (!summary) return []
      const calls = summary.ticks.map((tick, index) => ({
        seq: index + 1,
        at: tick.at,
        status: tick.failed ? "failed" : "succeeded",
        file_targets_json:
          index < (summary.files ?? 0)
            ? { operation: "edit", paths: [`src/demo-${index}.ts`] }
            : null,
      }))
      // The newest row: the last activity, a message rather than a call.
      const newest = summary.lastActivityAt
        ? [
            {
              seq: calls.length + 1,
              at: summary.lastActivityAt,
              status: null,
              file_targets_json: null,
            },
          ]
        : []
      const rows = filter.toolsOnly ? calls : [...calls, ...newest]
      return open.order === "recent" ? rows.reverse() : rows
    }
    case TASK_SOURCES.activity:
    case TASK_SOURCES.activityPayloads: {
      const events = filter.events as string[] | undefined
      return (found(filter.task)?.activity ?? [])
        .filter((event) => !events || events.includes(event.event))
        .map((event) => ({
          transition_id: event.id,
          task_id: event.taskID,
          event: event.event,
          at: event.createdAt,
          payload: event.payload,
        }))
    }
    case TASK_SOURCES.currentActivity:
      return answers
        .currentActivity((filter.tasks as string[]).toSorted())
        .activities.map((activity) => ({
          task_id: activity.taskID,
          node_state: activity.recordedState,
          plan_state: activity.recordedState ? "running" : null,
          node_reason: activity.holdReason,
          plan_reason: null,
          attempt_id: activity.attemptID,
          attempt_session_id: activity.workerSessionID ?? null,
          attempt_workspace: "/demo/worktree",
          host_agent: activity.foreground === "unknown" ? null : "lazers-implementor",
          host_attempt_id: activity.attemptID,
          host_directory: "/demo/worktree",
          busy: activity.foreground === "unknown" ? null : activity.foreground === "active",
          pending_input: activity.pendingInput,
          pending_permissions: activity.pendingPermissions,
          pending_forms: activity.pendingForms,
          outcome: activity.outcome,
          archived: Boolean(activity.archived),
          observed_at: activity.observedAt,
        }))
    default:
      return undefined
  }
}

function rowsOf(data: TasksData, open: Open, project: string, answers?: DetailAnswers): DemoRow[] {
  const detailRows = answers ? detailRowsOf(answers, open) : undefined
  if (detailRows) return detailRows
  const filter = open.filter
  if (open.source === TASK_SOURCES.index) return [{ project_directory: project, ready: true }]
  if (
    open.source === TASK_SOURCES.bucketCounts ||
    open.source === TASK_SOURCES.sessionBucketCounts
  ) {
    const rows = scheduleRows(data, project)
    return BUCKETS.map((bucket) => ({
      ...(open.source === TASK_SOURCES.sessionBucketCounts ? { session_id: SESSION } : {}),
      project_directory: project,
      bucket,
      n: rows.filter((row) => row.bucket === bucket).length,
    }))
  }
  if (open.source !== TASK_SOURCES.schedule) return []
  const buckets = bucketsFor(filter.state as string | undefined)
  const needle = String(filter.search ?? "").toLowerCase()
  const rows = scheduleRows(data, project).filter(
    (row) =>
      (!buckets || buckets.includes(row.bucket as Bucket)) &&
      (filter.taskID === undefined || row.task_id === filter.taskID) &&
      (!needle || `${row.reference} ${row.title}`.toLowerCase().includes(needle)),
  )
  return rows.sort((a, b) =>
    open.order === "recent"
      ? Number(b.seq) - Number(a.seq)
      : open.order === "plan"
        ? Number(a.ordinal) - Number(b.ordinal)
        : String(a.sort_key).localeCompare(String(b.sort_key)),
  )
}

export const taskStreams = (data: () => TasksData, project: string, answers?: DetailAnswers) =>
  streamAnswers(SOURCES, (open) => rowsOf(data(), open, project, answers))

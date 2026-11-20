import { frameSize, writeFrame, type Columns } from "../../../../src/streams/frame.ts"
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
} from "../../../../src/streams/sources/tasks-ref.ts"
import { BUCKETS, type Bucket } from "../../../../src/tasks/schedule/buckets.ts"
import { bucketsFor } from "../../../../src/tasks/schedule/key.ts"
import type { TaskState } from "../../../../src/runner/schema.ts"
import type { DemoTask, TasksData } from "./tasks-answers.ts"

/**
 * The demo's answer to `lazers.streams` for the Tasks sources: the same frames the real reader
 * writes (the real codec), over rows built from the demo's mock tasks. Windows slide and seek
 * over the sorted rows, so the list scrolls, anchors and counts the way it does live.
 */
type Row = Record<string, unknown>
type Anchor = "head" | "tail" | { key: (string | number | null)[]; place?: "center" | "start" }
type Open = {
  source: string
  filter: Record<string, unknown>
  order: string
  window: number
  position: number
}

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

function scheduleRows(data: TasksData, project: string): Row[] {
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
}

function rowsOf(data: TasksData, open: Open, project: string): Row[] {
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

export function taskStreams(data: () => TasksData, project: string) {
  const streams = new Map<string, Open>()
  let sequence = 0

  const frame = (id: string) => {
    const open = streams.get(id)
    if (!open) throw new Error(`Unknown stream ${id}`)
    const { columns } = SOURCES[open.source] ?? { columns: {} as Columns }
    const all = rowsOf(data(), open, project)
    const top = Math.max(0, all.length - open.window)
    open.position = Math.min(top, Math.max(0, open.position))
    const names = Object.keys(columns)
    const rows = all
      .slice(open.position, open.position + open.window)
      .map((row) => names.map((name) => row[name] ?? null))
    const bytes = new Uint8Array(frameSize(columns, rows))
    writeFrame(
      bytes.buffer,
      0,
      columns,
      {
        revision: ++sequence,
        count: rows.length,
        before: open.position,
        after: Math.max(0, all.length - open.position - rows.length),
      },
      rows,
    )
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { seq: sequence, data: btoa(binary) }
  }

  const place = (open: Open, anchor: Anchor | undefined) => {
    const all = rowsOf(data(), open, project)
    if (anchor === "tail") open.position = Math.max(0, all.length - open.window)
    else if (anchor && anchor !== "head") {
      const key = SOURCES[open.source]?.key ?? []
      const index = all.findIndex((row) => key.every((name, i) => row[name] === anchor.key[i]))
      open.position =
        index < 0 ? 0 : anchor.place === "start" ? index : index - Math.floor(open.window / 2)
    } else open.position = 0
  }

  return {
    open: (input: {
      stream: string
      source: string
      filter: Record<string, unknown>
      order: string
      window: number
      anchor?: Anchor
    }) => {
      const open: Open = {
        source: input.source,
        filter: (input.filter ?? {}) as Record<string, unknown>,
        order: input.order,
        window: input.window,
        position: 0,
      }
      streams.set(input.stream, open)
      place(open, input.anchor)
      return frame(input.stream)
    },
    slide: (input: { stream: string; delta: number }) => {
      streams.get(input.stream)!.position += input.delta
      return frame(input.stream)
    },
    seek: (input: { stream: string; anchor: Anchor }) => {
      place(streams.get(input.stream)!, input.anchor)
      return frame(input.stream)
    },
    read: (input: { stream: string }) => frame(input.stream),
    touch: () => ({ alive: true }),
    close: (input: { stream: string }) => ({ closed: streams.delete(input.stream) }),
  }
}

import { effectiveTaskStateFilter } from "./state-filter.ts"
import type { TaskRepository } from "../storage.ts"
import { openStream } from "../streams/client.ts"
import { acquireReaderPool } from "../streams/pool.ts"
import "../streams/sources/index.ts"
import {
  taskBucketCountsSource,
  taskScheduleSource,
  taskWaitsSource,
} from "../streams/sources/tasks.ts"
import { taskSearchFieldsRef } from "../streams/sources/tasks-ref.ts"
import type { StreamPool } from "../streams/client.ts"
import { findSource, streamColumns } from "../streams/source.ts"
import { readTaskDetail, type TaskDetailQuery, type WindowRead } from "./detail-read.ts"
import { GetOutput, type TaskDetail } from "./contract.ts"
import { startProjection } from "../projections/owner.ts"
import { TASK_EVENTS, taskEventsProjection } from "../events/task-events-refresh.ts"
import { projectionStatus } from "../projections/lifecycle.ts"
import { bucketsFor, bucketsForSelection } from "./schedule/key.ts"
import type { TaskStateSelection } from "./state-filter.ts"
import { BUCKETS } from "./schedule/buckets.ts"
import { AgentQueryInput, type TaskSummary } from "./contract.ts"
import { TaskStateFilter, effectiveTaskStateFilter as effective } from "./state-filter.ts"
import { backfillPage } from "./schedule/backfill.ts"
import { RunnerStore } from "../runner/store.ts"
import { summaryOf } from "./summary-row.ts"
import { selectionCursor } from "./selection-cursor.ts"

/**
 * One window of the stored task list for an agent tool: a stream opened on the project's reader
 * pool, read once and closed. The page size is the window; the continue marker is the key of the
 * last task on the page, and the next call opens the window on it.
 *
 * `count` and `stateCounts` come from the stored per-bucket counters. A search, a scope path, a
 * creating session or retired tasks narrow the list in ways no counter stores, so those pages
 * leave both out rather than count by scanning.
 */
export type TaskToolPage = {
  projectDirectory: string
  /** Tasks matching the state filter; absent when no stored counter answers the query. */
  count?: number
  /** Tasks per state filter for this project; first page only, absent as `count` is. */
  stateCounts?: Partial<Record<TaskStateFilter, number>>
  tasks: TaskSummary[]
  /** The id of the last task on this page while more follow; pass it back as `cursor`. */
  nextCursor: string | null
  serverTime: string
}

/** Where a search matched, from the stored search fields of a task on the page (`task_schedule_search`). */
function matchesOf(
  fields: readonly { field: string; text: string }[],
  search: string,
  scopePath: string | undefined,
): TaskSummary["matches"] {
  const matches: TaskSummary["matches"] = []
  const needle = search.toLowerCase()
  for (const { field, text: value } of fields) {
    const index = needle ? value.toLowerCase().indexOf(needle) : -1
    if (index >= 0 && matches.length < 4)
      matches.push({
        field,
        snippet: value.slice(Math.max(0, index - 40), index + 160).slice(0, 240),
      })
  }
  const scope = fields.find((field) => field.field === "scope")?.text ?? ""
  if (scopePath && matches.length < 4)
    matches.push({ field: "scope candidate", snippet: scope.slice(0, 240) })
  if (needle && matches.length === 0)
    matches.push({
      field: "specification",
      snippet: "Literal match in the stored task specification.",
    })
  return matches
}

/** The search fields of the page's tasks, one window: six rows per task. */
async function searchFieldsOf(pool: StreamPool, project: string, taskIDs: readonly string[]) {
  const byTask = new Map<string, { field: string; text: string }[]>()
  if (!taskIDs.length) return byTask
  const rows = await poolRead(pool)(taskSearchFieldsRef, {
    filter: { project, tasks: taskIDs },
    order: "field",
    window: Math.max(2, taskIDs.length * SEARCH_FIELDS),
  })
  for (const row of rows) {
    const list = byTask.get(String(row.task_id)) ?? []
    list.push({ field: String(row.field), text: String(row.text) })
    byTask.set(String(row.task_id), list)
  }
  return byTask
}

/** Fields stored per task: id, reference, objective, scope, acceptance, context. */
const SEARCH_FIELDS = 6

/** The stored bucket counters of the project, summed into the numbers a state filter selects. */
async function storedCounts(
  pool: StreamPool,
  project: string,
  state: string,
  states?: readonly TaskStateSelection[],
) {
  const stream = openStream(pool, taskBucketCountsSource, {
    filter: { project } as never,
    order: "bucket",
    window: BUCKETS.length,
  })
  try {
    await stream.ready()
    const perBucket = new Map<string, number>()
    for (const row of stream.items) perBucket.set(String(row.bucket), Number(row.n))
    const sum = (filter: string) =>
      (bucketsFor(filter) ?? BUCKETS).reduce(
        (total, bucket) => total + (perBucket.get(bucket) ?? 0),
        0,
      )
    return {
      count: (bucketsForSelection(states, state) ?? BUCKETS).reduce(
        (total, bucket) => total + (perBucket.get(bucket) ?? 0),
        0,
      ),
      stateCounts: Object.fromEntries(
        TaskStateFilter.options
          .filter((filter) => filter !== "completed")
          .map((filter) => [filter, sum(filter)]),
      ) as Partial<Record<TaskStateFilter, number>>,
    }
  } finally {
    stream.close()
  }
}

/** The prerequisite plans one task waits on, whole: the stored count is the window. */
async function waitsOf(pool: StreamPool, project: string, taskID: string, count: number) {
  const stream = openStream(pool, taskWaitsSource, {
    filter: { project, task: taskID } as never,
    order: "ord",
    window: count,
  })
  try {
    await stream.ready()
    return stream.items.map((row) => ({
      planID: String(row.plan_id),
      title: (row.title as string | null) ?? null,
      state: (row.state as string | null) ?? null,
      version: (row.version as number | null) ?? null,
      reason: (row.reason as string | null) ?? null,
    }))
  } finally {
    stream.close()
  }
}

/**
 * A fresh process has no schedule owner yet: index the project here, a page per write
 * transaction, so a tool never answers that tasks which exist are missing.
 */
async function ensureScheduleIndexed(
  repository: Pick<TaskRepository, "path" | "projectDirectory" | "read" | "atomicAsync">,
) {
  const ready = () =>
    repository.read(
      (db) =>
        db
          .query<{ ready: number }, [string]>(
            "SELECT ready FROM task_schedule_state WHERE project_directory=?",
          )
          .get(repository.projectDirectory)?.ready === 1,
    )
  // `atomicAsync` waits out another process's write lock instead of failing the tool.
  while (!ready())
    await repository.atomicAsync((db) => {
      backfillPage(db, repository.projectDirectory)
    })
}

const busy = (error: unknown) =>
  String((error as { code?: unknown } | null)?.code ?? "").startsWith("SQLITE_BUSY") ||
  /database is locked/.test(String(error))

/** How long a tool waits out another writer while the task events fold; a unit, not a cap. */
const FOLD_WAIT_MS = 30_000

/**
 * `lz-get-task`: one task's detail from the stored rows, every transition payload included. The
 * task events are folded first (the core's owner, shared; a process without one folds here), so
 * the activity is whole, never a partial list.
 */
export async function getTaskDetail(
  repository: TaskRepository,
  query: Omit<TaskDetailQuery, "project">,
): Promise<TaskDetail> {
  // A repository opened without the runner store has not installed the runner tables or the
  // projection yet; the store installs both.
  const installed = repository.read((db) =>
    Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name='task_schedule_state'").get()),
  )
  if (!installed) new RunnerStore(repository)
  await ensureScheduleIndexed(repository)
  // Folded already (the core's owner, or writes drained in their own transaction): read now.
  const folded = repository.read((db) => projectionStatus(db, TASK_EVENTS)?.state === "ready")
  // Another process's write lock is waited out: starting the owner and its pages write.
  if (!folded)
    for (const started = Date.now(); ;) {
      try {
        const events = startProjection(
          repository.path,
          repository.projectDirectory,
          taskEventsProjection,
        )
        try {
          await events.owner.settle()
        } finally {
          events.release()
        }
        break
      } catch (error) {
        if (!busy(error) || Date.now() - started > FOLD_WAIT_MS) throw error
        await Bun.sleep(25)
      }
    }
  const lease = acquireReaderPool(repository.path)
  try {
    return GetOutput.parse(
      await readTaskDetail(
        poolRead(lease.pool),
        { ...query, project: repository.projectDirectory },
        { payloads: "all" },
      ),
    )
  } finally {
    lease.release()
  }
}

export async function queryTaskPage(
  repository: Pick<TaskRepository, "path" | "projectDirectory" | "read" | "atomicAsync">,
  input: unknown,
): Promise<TaskToolPage> {
  const query = AgentQueryInput.parse(input)
  const cursor = selectionCursor(query, repository.projectDirectory)
  await ensureScheduleIndexed(repository)
  const lease = acquireReaderPool(repository.path)
  try {
    const stream = openStream(lease.pool, taskScheduleSource, {
      filter: {
        project: repository.projectDirectory,
        state: effectiveTaskStateFilter(query.state, query.includeCompleted),
        ...(query.states === undefined ? {} : { states: query.states }),
        includeRetired: query.includeRetired,
        ...(query.search ? { search: query.search } : {}),
        ...(query.scopePath ? { scopePath: query.scopePath } : {}),
        ...(query.sessionID ? { creator: query.sessionID } : {}),
      },
      order: query.sort,
      // One more than the page: the first row of a continued page is the marker itself.
      window: query.limit + (query.cursor ? 1 : 0) + 1,
      ...(cursor.taskID ? { anchor: { key: [cursor.taskID], place: "start" as const } } : {}),
    })
    try {
      await stream.ready()
      // Rows are views into the frame: copy the fields before the stream closes.
      const rows = stream.items.map((row) =>
        Object.fromEntries(
          Object.keys(taskScheduleSource.columns).map((name) => [
            name,
            (row as Record<string, unknown>)[name],
          ]),
        ),
      )
      if (query.cursor) {
        if (rows[0]?.task_id !== cursor.taskID) throw new Error("Invalid task cursor")
        rows.shift()
      }
      const page = rows.slice(0, query.limit)
      const more = rows.length > query.limit
      const tasks: TaskSummary[] = []
      const fields =
        query.search || query.scopePath
          ? await searchFieldsOf(
              lease.pool,
              repository.projectDirectory,
              page.map((row) => String(row.task_id)),
            )
          : undefined
      for (const row of page) {
        const shown = fields?.get(String(row.task_id))
        const waitCount = Number(row.wait_plans_count)
        tasks.push(
          summaryOf(
            row,
            shown ? matchesOf(shown, query.search, query.scopePath) : [],
            waitCount > 0
              ? await waitsOf(
                  lease.pool,
                  repository.projectDirectory,
                  String(row.task_id),
                  waitCount,
                )
              : undefined,
          ),
        )
      }
      const counted =
        query.search || query.scopePath || query.sessionID || query.includeRetired
          ? undefined
          : await storedCounts(
              lease.pool,
              repository.projectDirectory,
              effective(query.state, query.includeCompleted),
              query.states,
            )
      return {
        projectDirectory: repository.projectDirectory,
        ...(counted ? { count: counted.count } : {}),
        ...(counted && !query.cursor ? { stateCounts: counted.stateCounts } : {}),
        tasks,
        nextCursor: more && tasks.length ? cursor.encode(tasks[tasks.length - 1]!.taskID) : null,
        serverTime: new Date().toISOString(),
      }
    } finally {
      stream.close()
    }
  } finally {
    lease.release()
  }
}

/**
 * A `WindowRead` on the project's reader pool: the service's own reads of the Tasks sources (the
 * agent tools). Filters are trusted: they skip `authorize` and name the project themselves.
 */
export function poolRead(pool: StreamPool): WindowRead {
  return async (ref, options) => {
    const source = findSource(ref.name)
    if (!source) throw new Error(`Unknown source ${ref.name}`)
    const stream = openStream(pool, source as never, {
      filter: options.filter as never,
      order: options.order,
      window: options.window,
      ...(options.anchor ? { anchor: options.anchor } : {}),
    })
    try {
      await stream.ready()
      const names = Object.keys(streamColumns(source, options.window))
      // Rows are views into the frame: copy the fields before the stream closes.
      return stream.items.map((row) =>
        Object.fromEntries(names.map((name) => [name, (row as Record<string, unknown>)[name]])),
      )
    } finally {
      stream.close()
    }
  }
}

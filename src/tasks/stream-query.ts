import { effectiveTaskStateFilter } from "./state-filter.ts"
import type { TaskRepository } from "../storage.ts"
import type { TaskSpec } from "../task.ts"
import { openStream } from "../streams/client.ts"
import { acquireReaderPool } from "../streams/pool.ts"
import "../streams/sources/index.ts"
import {
  taskBucketCountsSource,
  taskScheduleSource,
  taskWaitsSource,
} from "../streams/sources/tasks.ts"
import type { StreamPool } from "../streams/client.ts"
import { bucketsFor } from "./schedule/key.ts"
import { BUCKETS } from "./schedule/buckets.ts"
import { AgentQueryInput, type TaskSummary } from "./contract.ts"
import { TaskStateFilter, effectiveTaskStateFilter as effective } from "./state-filter.ts"
import { backfillPage } from "./schedule/backfill.ts"
import { summaryOf } from "./summary-row.ts"

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

/** Where a search matched, read from the stored specification of a task on the page. */
function matchesOf(
  task: TaskSpec,
  reference: string,
  search: string,
  scopePath: string | undefined,
): TaskSummary["matches"] {
  const matches: TaskSummary["matches"] = []
  const needle = search.toLowerCase()
  const fields = {
    id: task.id,
    reference,
    objective: task.proposal.objective,
    scope: task.proposal.writeScope.join("\n"),
    acceptance: task.proposal.acceptance.map((item) => item.assertion).join("\n"),
    context: task.proposal.context.map((item) => item.reference).join("\n"),
  }
  for (const [field, value] of Object.entries(fields)) {
    const index = needle ? value.toLowerCase().indexOf(needle) : -1
    if (index >= 0 && matches.length < 4)
      matches.push({
        field,
        snippet: value.slice(Math.max(0, index - 40), index + 160).slice(0, 240),
      })
  }
  if (scopePath && matches.length < 4)
    matches.push({ field: "scope candidate", snippet: fields.scope.slice(0, 240) })
  if (needle && matches.length === 0)
    matches.push({
      field: "specification",
      snippet: "Literal match in the stored task specification.",
    })
  return matches
}

/** The stored bucket counters of the project, summed into the numbers a state filter selects. */
async function storedCounts(pool: StreamPool, project: string, state: string) {
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
      count: sum(state),
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

export async function queryTaskPage(
  repository: Pick<TaskRepository, "path" | "projectDirectory" | "get" | "read" | "atomic">,
  input: unknown,
): Promise<TaskToolPage> {
  const query = AgentQueryInput.parse(input)
  // A fresh process has no schedule owner yet: index the project here, a page per write
  // transaction, so a tool never answers that tasks which exist are missing.
  const ready = () =>
    repository.read(
      (db) =>
        db
          .query<{ ready: number }, [string]>(
            "SELECT ready FROM task_schedule_state WHERE project_directory=?",
          )
          .get(repository.projectDirectory)?.ready === 1,
    )
  while (!ready())
    repository.atomic((db) => {
      backfillPage(db, repository.projectDirectory)
    })
  const lease = acquireReaderPool(repository.path)
  try {
    const stream = openStream(lease.pool, taskScheduleSource, {
      filter: {
        project: repository.projectDirectory,
        state: effectiveTaskStateFilter(query.state, query.includeCompleted),
        includeRetired: query.includeRetired,
        ...(query.search ? { search: query.search } : {}),
        ...(query.scopePath ? { scopePath: query.scopePath } : {}),
        ...(query.sessionID ? { creator: query.sessionID } : {}),
      },
      order: query.sort,
      // One more than the page: the first row of a continued page is the marker itself.
      window: query.limit + (query.cursor ? 1 : 0) + 1,
      ...(query.cursor ? { anchor: { key: [query.cursor], place: "start" as const } } : {}),
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
        if (rows[0]?.task_id !== query.cursor) throw new Error("Invalid task cursor")
        rows.shift()
      }
      const page = rows.slice(0, query.limit)
      const more = rows.length > query.limit
      const tasks: TaskSummary[] = []
      for (const row of page) {
        const spec =
          query.search || query.scopePath ? repository.get(String(row.task_id)) : undefined
        const waitCount = Number(row.wait_plans_count)
        tasks.push(
          summaryOf(
            row,
            spec ? matchesOf(spec, String(row.reference), query.search, query.scopePath) : [],
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
            )
      return {
        projectDirectory: repository.projectDirectory,
        ...(counted ? { count: counted.count } : {}),
        ...(counted && !query.cursor ? { stateCounts: counted.stateCounts } : {}),
        tasks,
        nextCursor: more && tasks.length ? tasks[tasks.length - 1]!.taskID : null,
        serverTime: new Date().toISOString(),
      }
    } finally {
      stream.close()
    }
  } finally {
    lease.release()
  }
}

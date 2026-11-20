import { effectiveTaskStateFilter } from "./state-filter.ts"
import type { TaskRepository } from "../storage.ts"
import type { TaskSpec } from "../task.ts"
import { openStream } from "../streams/client.ts"
import { acquireReaderPool } from "../streams/pool.ts"
import "../streams/sources/index.ts"
import { taskScheduleSource } from "../streams/sources/tasks.ts"
import { AgentQueryInput, type TaskSummary } from "./contract.ts"
import { taskTitle } from "./presentation.ts"

/**
 * One window of the stored task list for an agent tool: a stream opened on the project's reader
 * pool, read once and closed. The page size is the window; the continue marker is the key of the
 * last task on the page, and the next call opens the window on it.
 */
export type TaskToolPage = {
  projectDirectory: string
  tasks: TaskSummary[]
  /** The id of the last task on this page while more follow; pass it back as `cursor`. */
  nextCursor: string | null
  serverTime: string
}

/** Where a search matched, read from the stored specification of a task on the page. */
export function matchesOf(
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

const optional = <T>(value: unknown): T | undefined =>
  value === null || value === undefined ? undefined : (value as T)

export async function queryTaskPage(
  repository: Pick<TaskRepository, "path" | "projectDirectory" | "get" | "read">,
  input: unknown,
): Promise<TaskToolPage> {
  const query = AgentQueryInput.parse(input)
  const indexed = repository.read(
    (db) =>
      db
        .query<{ ready: number }, [string]>(
          "SELECT ready FROM task_schedule_state WHERE project_directory=?",
        )
        .get(repository.projectDirectory)?.ready === 1,
  )
  if (!indexed) throw new Error("Tasks are being indexed; ask again shortly.")
  const lease = acquireReaderPool(repository.path)
  try {
    const stream = openStream(lease.pool, taskScheduleSource, {
      filter: {
        project: repository.projectDirectory,
        state: effectiveTaskStateFilter(query.state, query.includeCompleted),
        includeRetired: query.includeRetired,
        ...(query.search ? { search: query.search } : {}),
        ...(query.scopePath ? { scopePath: query.scopePath } : {}),
        ...(query.sessionID ? { session: query.sessionID } : {}),
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
      const tasks = page.map((row): TaskSummary => {
        const taskID = String(row.task_id)
        const reference = String(row.reference)
        const spec = query.search || query.scopePath ? repository.get(taskID) : undefined
        const status = String(row.status)
        const nodeState = optional<string>(row.node_state)
        const running = ["running", "verifying"].includes(String(nodeState))
        return {
          taskID,
          reference,
          ...(optional(row.source_plan) ? { sourcePlan: row.source_plan as never } : {}),
          ...(optional(row.dispatch_pause)
            ? {
                dispatchPause: row.dispatch_pause as never,
                ...(row.dispatch_pause_plan_id
                  ? { dispatchPausePlanID: String(row.dispatch_pause_plan_id) }
                  : {}),
              }
            : {}),
          revision: 1,
          status: status as TaskSummary["status"],
          ...(nodeState ? { recordedState: nodeState as never } : {}),
          ...(running && row.started_at != null ? { startedAt: Number(row.started_at) } : {}),
          ...(row.takeover ? { takeover: true as const } : {}),
          reason: optional<string>(row.reason) ?? null,
          ...(optional(row.disposition) ? { disposition: row.disposition as never } : {}),
          classification: row.classification as never,
          title: String(row.title ?? taskTitle(String(row.objective ?? ""))).slice(0, 120),
          objective: String(row.objective ?? "").slice(0, 400),
          createdAt: String(row.created_at),
          sessionID: String(row.session_id),
          matches: spec ? matchesOf(spec, reference, query.search, query.scopePath) : [],
        }
      })
      return {
        projectDirectory: repository.projectDirectory,
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

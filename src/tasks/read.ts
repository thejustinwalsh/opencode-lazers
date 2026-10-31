import { createHash } from "node:crypto"
import { z } from "zod"
import type { TaskRepository } from "../storage.ts"
import type { TaskSpec } from "../task.ts"
import { GetInput, GetOutput, QueryInput, QueryOutput } from "./contract.ts"
import type { TaskPage, TaskSummary } from "./contract.ts"
import { taskTitle } from "./presentation.ts"
import { RunnerStore } from "../runner/store.ts"

const Cursor = z.strictObject({
  filter: z.string(),
  snapshot: z.int().nonnegative(),
  before: z.int().positive(),
})

function summarize(task: TaskSpec, search: string, scopePath?: string): TaskSummary {
  const matches: TaskSummary["matches"] = []
  const needle = search.toLowerCase()
  const fields = {
    id: task.id,
    objective: task.proposal.objective,
    scope: task.proposal.writeScope.join("\n"),
    acceptance: task.proposal.acceptance.map((item) => item.assertion).join("\n"),
    context: task.proposal.context.map((item) => item.reference).join("\n"),
  }
  for (const [field, value] of Object.entries(fields)) {
    const index = needle ? value.toLowerCase().indexOf(needle) : -1
    if (index >= 0 && matches.length < 4) {
      matches.push({
        field,
        snippet: value.slice(Math.max(0, index - 40), index + 160).slice(0, 240),
      })
    }
  }
  if (scopePath && matches.length < 4) {
    matches.push({ field: "scope candidate", snippet: fields.scope.slice(0, 240) })
  }
  if (needle && matches.length === 0) {
    matches.push({
      field: "specification",
      snippet: "Literal match in the stored task specification.",
    })
  }
  return {
    taskID: task.id,
    revision: task.revision,
    status: task.status,
    title: taskTitle(task.proposal.objective),
    objective: task.proposal.objective.slice(0, 400),
    createdAt: task.createdAt,
    sessionID: task.provenance.sessionID,
    matches,
  }
}

export class TaskReads {
  readonly runner: RunnerStore
  constructor(readonly repository: TaskRepository) {
    this.runner = new RunnerStore(repository)
  }

  query(input: unknown): TaskPage {
    const query = QueryInput.parse(input)
    const filter = createHash("sha256")
      .update(
        JSON.stringify([
          this.repository.projectDirectory,
          query.sessionID,
          query.search,
          query.scopePath,
          query.includeCompleted,
        ]),
      )
      .digest("hex")
    let cursor: z.infer<typeof Cursor> | undefined
    if (query.cursor) {
      try {
        cursor = Cursor.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")))
      } catch {
        throw new Error("Invalid task cursor")
      }
      if (cursor.filter !== filter || cursor.before > cursor.snapshot) {
        throw new Error("Task cursor does not match this project, session, or filter")
      }
    }
    const page = this.repository.readPage({
      ...query,
      snapshot: cursor?.snapshot,
      before: cursor?.before,
    })
    const visible = page.rows.slice(0, query.limit)
    const last = visible.at(-1)
    const nextCursor =
      page.rows.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({ filter, snapshot: page.version, before: last.position }),
          ).toString("base64url")
        : null
    return QueryOutput.parse({
      projectDirectory: this.repository.projectDirectory,
      snapshot: page.version,
      count: page.count,
      tasks: visible.map(({ task }) => ({
        ...summarize(task, query.search, query.scopePath),
        status: this.runner.execution(task.id)?.state ?? task.status,
      })),
      nextCursor,
      serverTime: new Date().toISOString(),
    })
  }

  get(input: unknown) {
    const query = GetInput.parse(input)
    const task = this.repository.get(query.taskID)
    if (!task || (query.sessionID && task.provenance.sessionID !== query.sessionID)) {
      return GetOutput.parse({ status: "not_found" })
    }
    if (query.revision !== undefined && query.revision !== task.revision) {
      return GetOutput.parse({ status: "revision_unavailable", revision: task.revision })
    }
    const execution = this.runner.execution(task.id)
    return GetOutput.parse({ status: "found", task, ...(execution ? { execution } : {}) })
  }
}

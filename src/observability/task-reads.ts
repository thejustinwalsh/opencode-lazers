import { scheduledTaskPageSQL } from "../tasks/schedule-order.ts"
import { createHash } from "node:crypto"
import { z } from "zod"
import type { TaskRepository } from "../storage.ts"
import type { TaskSpec } from "../task.ts"
import { TaskSpecSchema } from "../task.ts"
import { taskTitle } from "../tasks/presentation.ts"
import { GetInput, GetOutput, QueryInput, QueryOutput } from "../tasks/contract.ts"
import type { TaskPage, TaskSummary } from "../tasks/contract.ts"
import { TaskReads } from "../tasks/read.ts"
import { sessionAssociations } from "./associations.ts"
import { effectiveTaskStateFilter, taskStatePredicate } from "../tasks/state-filter.ts"
import { taskClassificationFor } from "../tasks/classification.ts"

const Cursor = z.strictObject({
  filter: z.string(),
  snapshot: z.int().nonnegative(),
  before: z.int().positive(),
})

function summarize(
  task: TaskSpec,
  reference: string,
  search: string,
  scopePath: string | undefined,
  classification: TaskSummary["classification"],
): TaskSummary {
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
  return {
    taskID: task.id,
    reference,
    ...(task.proposal.sourcePlan ? { sourcePlan: task.proposal.sourcePlan } : {}),
    revision: task.revision,
    status: task.status,
    reason: null,
    classification,
    title: taskTitle(task.proposal.objective),
    objective: task.proposal.objective.slice(0, 400),
    createdAt: task.createdAt,
    sessionID: task.provenance.sessionID,
    matches,
  }
}

/** Extends the Tasks RPC's session view with persisted plan-owner/worker links. */
export class AssociationTaskReads extends TaskReads {
  constructor(repository: TaskRepository) {
    super(repository)
  }

  override query(input: unknown): TaskPage {
    const query = QueryInput.parse(input)
    if (!query.sessionID) return super.query(input)
    const sessionID = query.sessionID

    const filter = createHash("sha256")
      .update(
        JSON.stringify([
          this.repository.projectDirectory,
          sessionID,
          query.search,
          query.scopePath,
          effectiveTaskStateFilter(query.state, query.includeCompleted),
          query.includeRetired,
          query.sort,
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
      if (cursor.filter !== filter || cursor.before > cursor.snapshot)
        throw new Error("Task cursor does not match this project, session, or filter")
    }

    const page = this.repository.atomic((db) => {
      const current = this.repository.version()
      const snapshot = cursor?.snapshot ?? current
      if (snapshot > current) throw new Error("Task snapshot is unavailable; start a fresh query")
      if (cursor) {
        const mutation = db
          .query<{ n: number }, [string]>(
            "SELECT COALESCE(MAX(id),0) AS n FROM task_changes WHERE project_directory=? AND kind='mutation'",
          )
          .get(this.repository.projectDirectory)!.n
        if (mutation > snapshot) throw new Error("Task execution changed; start a fresh query")
      }

      const clauses = [
        "t.project_directory=?",
        "t.created_version<=?",
        `(
          json_extract(t.body,'$.provenance.sessionID')=?
          OR EXISTS (
            SELECT 1 FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
            WHERE n.task_id=t.id AND p.project_directory=? AND p.owner=?
          )
          OR EXISTS (
            SELECT 1 FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
            WHERE a.task_id=t.id AND p.project_directory=? AND a.session_id=?
          )
        )`,
      ]
      const values: (string | number)[] = [
        this.repository.projectDirectory,
        snapshot,
        sessionID,
        this.repository.projectDirectory,
        sessionID,
        this.repository.projectDirectory,
        sessionID,
      ]
      const statePredicate = taskStatePredicate(
        effectiveTaskStateFilter(query.state, query.includeCompleted),
        "t",
      )
      if (statePredicate) clauses.push(statePredicate)
      if (!query.includeRetired)
        clauses.push(
          "NOT EXISTS (SELECT 1 FROM task_dispositions d WHERE d.project_directory=t.project_directory AND d.task_id=t.id)",
        )
      if (query.search) {
        clauses.push(`(
          instr(lower(t.body),lower(?))>0 OR EXISTS (
            SELECT 1 FROM task_references r
            WHERE r.project_directory=t.project_directory AND r.task_id=t.id
              AND instr(lower(r.reference),lower(?))>0
          )
        )`)
        values.push(query.search)
        values.push(query.search)
      }
      if (query.scopePath) {
        clauses.push(
          "EXISTS (SELECT 1 FROM json_each(json_extract(t.body,'$.proposal.writeScope')) WHERE instr(lower(value),lower(?))>0)",
        )
        values.push(query.scopePath)
      }
      const where = clauses.join(" AND ")
      const count = db
        .query<{ count: number }, (string | number)[]>(
          `SELECT COUNT(*) AS count FROM tasks t WHERE ${where}`,
        )
        .get(...values)!.count
      const before = cursor ? " AND t.rowid<?" : ""
      const rows = db
        .query<{ body: string; position: number; reference: string }, (string | number)[]>(
          query.sort === "schedule"
            ? scheduledTaskPageSQL("t", where, Boolean(cursor))
            : `SELECT t.body,t.rowid AS position,r.reference FROM tasks t
           JOIN task_references r ON r.project_directory=t.project_directory AND r.task_id=t.id
           WHERE ${where}${before}
           ORDER BY t.rowid DESC LIMIT ?`,
        )
        .all(...values, ...(cursor ? [cursor.before] : []), query.limit + 1)
      return {
        version: snapshot,
        count,
        rows: rows.map((row) => {
          const task = TaskSpecSchema.parse(JSON.parse(row.body))
          return {
            position: row.position,
            task,
            reference: row.reference,
            classification: taskClassificationFor(db, this.repository.projectDirectory, task)
              .current,
          }
        }),
      }
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
      tasks: visible.map(({ task, reference, classification }) => {
        const execution = this.effectiveExecution(task.id)
        const disposition = this.repository.taskDisposition(task.id)
        return {
          ...summarize(task, reference, query.search, query.scopePath, classification),
          ...(disposition ? { disposition } : {}),
          ...(execution?.dispatchPause ? { dispatchPause: execution.dispatchPause } : {}),
          status: execution?.state ?? task.status,
          ...(execution ? { recordedState: this.recordedStateForTask(task.id) } : {}),
          reason: execution?.reason ?? disposition?.reason ?? null,
        }
      }),
      nextCursor,
      serverTime: new Date().toISOString(),
    })
  }

  override get(input: unknown) {
    const query = GetInput.parse(input)
    if (!query.sessionID) return super.get(input)
    const taskID = this.repository.resolveTaskID(query.taskID)
    if (!taskID) return GetOutput.parse({ status: "not_found" })
    const linked = this.repository.atomic((db) =>
      sessionAssociations(db, this.repository.projectDirectory, query.sessionID!).taskIDs.has(
        taskID,
      ),
    )
    if (!linked) return GetOutput.parse({ status: "not_found" })
    return super.get({
      taskID: query.taskID,
      ...(query.revision ? { revision: query.revision } : {}),
      ...(query.classificationRevision !== undefined
        ? { classificationRevision: query.classificationRevision }
        : {}),
    })
  }
}

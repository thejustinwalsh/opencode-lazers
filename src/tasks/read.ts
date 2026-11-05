import { createHash } from "node:crypto"
import { z } from "zod"
import type { TaskRepository } from "../storage.ts"
import type { TaskSpec } from "../task.ts"
import { GetInput, GetOutput, QueryInput, QueryOutput } from "./contract.ts"
import type { TaskPage, TaskSummary } from "./contract.ts"
import { taskTitle } from "./presentation.ts"
import { RunnerStore } from "../runner/store.ts"
import { effectiveTaskStateFilter } from "./state-filter.ts"
import { taskAdviceSnapshot } from "./advice.ts"

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
  disposition: TaskSummary["disposition"],
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
    reference,
    revision: task.revision,
    status: task.status,
    reason: null,
    ...(disposition ? { disposition } : {}),
    classification,
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
          effectiveTaskStateFilter(query.state, query.includeCompleted),
          query.includeRetired,
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
      state: effectiveTaskStateFilter(query.state, query.includeCompleted),
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
      tasks: visible.map(({ task, reference, classification }) => {
        const execution = this.effectiveExecution(task.id)
        const disposition = this.repository.taskDisposition(task.id)
        return {
          ...summarize(task, reference, query.search, query.scopePath, disposition, classification),
          status: execution?.state ?? task.status,
          reason: execution?.reason ?? disposition?.reason ?? null,
        }
      }),
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
    const disposition = this.repository.taskDisposition(task.id)
    const classifications = this.repository.taskClassification(task.id)
    if (!classifications) throw new Error("Task classification is missing from this repository")
    const reference = this.repository.referenceFor(task.id)
    if (!reference) throw new Error("Task reference is missing from this repository")
    const advice = taskAdviceSnapshot(this.repository, task.id)
    const execution = this.effectiveExecution(task.id)
    if (!execution)
      return GetOutput.parse({
        status: "found",
        task,
        classification: classifications.current,
        classificationHistory: classifications.history,
        advice,
        ...(query.classificationRevision !== undefined
          ? {
              classificationAtRevision:
                classifications.history.find(
                  (item) => item.revision === query.classificationRevision,
                ) ?? null,
            }
          : {}),
        reference,
        ...(disposition ? { disposition } : {}),
      })
    const attempts = this.runner
      .attempts(execution.planID)
      .filter((attempt) => attempt.task_id === task.id)
      .map((attempt) => ({
        id: attempt.id,
        number: attempt.number,
        state: attempt.state,
        startedAt: attempt.started_at,
        artifact: attempt.artifact,
        tokenCount: attempt.token_count,
        toolCount: attempt.tool_count,
      }))
    const activity = this.runner.activity(execution.planID, task.id).map((event) => ({
      id: event.id,
      taskID: event.task_id,
      event: event.event,
      payload: event.payload,
      createdAt: event.created_at,
    }))
    return GetOutput.parse({
      status: "found",
      task,
      classification: classifications.current,
      classificationHistory: classifications.history,
      advice,
      ...(query.classificationRevision !== undefined
        ? {
            classificationAtRevision:
              classifications.history.find(
                (item) => item.revision === query.classificationRevision,
              ) ?? null,
          }
        : {}),
      reference,
      ...(disposition ? { disposition } : {}),
      execution,
      attempts,
      activity,
    })
  }

  protected effectiveExecution(taskID: string) {
    const execution = this.runner.execution(taskID)
    if (!execution) return undefined
    const plan = this.runner.plan(execution.planID)
    return plan?.state === "cancelled"
      ? { ...execution, state: "cancelled" as const, reason: execution.reason ?? plan.reason }
      : execution
  }
}

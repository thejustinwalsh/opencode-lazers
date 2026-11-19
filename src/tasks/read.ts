import { scopePatternsConflict } from "../runner/artifacts.ts"
import { PlanInput } from "../runner/schema.ts"
import { taskAuditHistory } from "../audit/history.ts"
import { createHash } from "node:crypto"
import { z } from "zod"
import type { TaskRepository } from "../storage.ts"
import type { TaskSpec } from "../task.ts"
import { GetInput, GetOutput, QueryInput, QueryOutput } from "./contract.ts"
import type { TaskPage, TaskConcern, TaskSummary } from "./contract.ts"
import { canStruggle, readTrajectoryFacts } from "../recovery/trajectory-facts.ts"
import { openConcerns } from "../recovery/detector.ts"
import { taskTitle } from "./presentation.ts"
import { RunnerStore } from "../runner/store.ts"
import { effectiveTaskStateFilter } from "./state-filter.ts"
import { taskAdviceSnapshot } from "./advice.ts"
import { attemptModel, readAttemptSummary } from "./attempt-summary.ts"
import type { TaskState } from "../runner/schema.ts"

const TERMINAL_NODE_STATES = new Set([
  "accepted",
  "incorporated",
  "failed",
  "exhausted",
  "cancelled",
])

export type CurrentActivityTarget = {
  taskID: string
  authorized: boolean
  attempt: {
    id: string
    sessionID: string
    workspace: string
    state: string
  } | null
  recordedState: TaskState | null
  waiting: boolean
  holdReason: string | null
  planID: string | null
  nodeVersion: number | null
  planVersion: number | null
}

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
    ...(task.proposal.sourcePlan ? { sourcePlan: task.proposal.sourcePlan } : {}),
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
      if (cursor.filter !== filter || cursor.before > cursor.snapshot) {
        throw new Error("Task cursor does not match this project, session, or filter")
      }
    }
    const page = this.repository.readPage({
      ...query,
      state: effectiveTaskStateFilter(query.state, query.includeCompleted),
      snapshot: cursor?.snapshot,
      before: cursor?.before,
      stateCounts: !cursor,
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
      ...("stateCounts" in page && page.stateCounts ? { stateCounts: page.stateCounts } : {}),
      tasks: visible.map(({ task, reference, classification }) => {
        const execution = this.effectiveExecution(task.id)
        const disposition = this.repository.taskDisposition(task.id)
        return {
          ...summarize(task, reference, query.search, query.scopePath, disposition, classification),
          ...(execution?.dispatchPause
            ? { dispatchPause: execution.dispatchPause, dispatchPausePlanID: execution.planID }
            : {}),
          status: execution?.state ?? task.status,
          ...(execution
            ? { recordedState: this.recordedNodeState(task.id, execution.planID) }
            : {}),
          // Same definition as the Running filter: a running node in a plan that is not held or
          // cancelled, and not paused.
          ...(execution &&
          execution.state === "running" &&
          !["blocked", "cancelled"].includes(this.runner.plan(execution.planID)?.state ?? "") &&
          !execution.dispatchPause
            ? this.startedAt(task.id, execution.planID)
            : {}),
          ...(execution ? this.concern(task.id, execution.planID, execution.state) : {}),
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
    const auditHistory = taskAuditHistory(this.repository, task.id)
    const execution = this.effectiveExecution(task.id)
    if (!execution)
      return GetOutput.parse({
        status: "found",
        task,
        classification: classifications.current,
        classificationHistory: classifications.history,
        advice,
        ...(auditHistory ? { auditHistory } : {}),
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
    const ownAttempts = this.runner
      .attempts(execution.planID)
      .filter((attempt) => attempt.task_id === task.id)
    const latestAttempt = ownAttempts.at(-1)
    const attempts = ownAttempts.map((attempt) => {
      const model = attemptModel(attempt.policy)
      return {
        id: attempt.id,
        number: attempt.number,
        state: attempt.state,
        startedAt: attempt.started_at,
        artifact: attempt.artifact,
        tokenCount: attempt.token_count,
        toolCount: attempt.tool_count,
        ...(model ? { model } : {}),
        ...(attempt === latestAttempt ? this.attemptSummary(attempt.id) : {}),
      }
    })
    const activity = this.runner.activity(execution.planID, task.id).map((event) => ({
      id: event.id,
      taskID: event.task_id,
      event: event.event,
      payload: event.payload,
      createdAt: event.created_at,
    }))
    const architectSessionID = this.runner.plan(execution.planID)?.owner
    return GetOutput.parse({
      status: "found",
      task,
      classification: classifications.current,
      classificationHistory: classifications.history,
      advice,
      ...(auditHistory ? { auditHistory } : {}),
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
      recordedState: this.recordedNodeState(task.id, execution.planID) ?? null,
      execution,
      ...(architectSessionID ? { architectSessionID } : {}),
      attempts,
      activity,
    })
  }

  protected effectiveExecution(taskID: string) {
    const execution = this.runner.execution(taskID)
    if (!execution) return undefined
    const plan = this.runner.plan(execution.planID)
    if (plan?.state === "cancelled")
      return { ...execution, state: "cancelled" as const, reason: execution.reason ?? plan.reason }
    if (
      plan?.state !== "running" ||
      execution.dispatchPause ||
      execution.waitingOn.length ||
      !["queued", "ready"].includes(execution.state)
    )
      return execution
    let input: ReturnType<typeof PlanInput.safeParse>
    try {
      input = PlanInput.safeParse(JSON.parse(plan.body))
    } catch {
      return execution
    }
    if (!input.success) return execution
    const prerequisites = (input.data.afterPlans ?? []).flatMap((id) => {
      const required = this.runner.plan(id)
      if (required && ["cleaning", "cleanup-blocked", "integrated"].includes(required.state))
        return []
      const refs = required
        ? this.runner
            .nodes(id)
            .map((node) => this.repository.referenceFor(node.task_id) ?? node.task_id)
        : []
      return [`${refs.join(", ") || id} (${required?.state ?? "not found"})`]
    })
    if (prerequisites.length)
      return {
        ...execution,
        state: "blocked" as const,
        reason: `Waiting for prerequisite integration: ${prerequisites.join("; ")}`,
      }
    const mode = input.data.workspaceMode
    const scope = this.runner.effectiveWriteScope(taskID)
    const blockers = [
      ...new Set(
        this.runner
          .dispatchReservations()
          .filter(
            (entry) =>
              mode === "shared" || entry.shared || scopePatternsConflict(entry.scopes, scope),
          )
          .map((entry) => entry.taskID),
      ),
    ]
    if (!blockers.length) return execution
    const references = blockers.map((id) => this.repository.referenceFor(id) ?? id)
    return {
      ...execution,
      state: "blocked" as const,
      reason: `Waiting for checkout or write scope: ${references.join(", ")}`,
    }
  }

  recordedStateForTask(taskID: string): TaskState | undefined {
    const execution = this.effectiveExecution(taskID)
    return execution ? this.recordedNodeState(taskID, execution.planID) : undefined
  }

  /** The latest attempt's compact activity; a failed read leaves the pane without it. */
  protected attemptSummary(attemptID: string) {
    try {
      return {
        summary: this.repository.read((db) =>
          readAttemptSummary(db, this.repository.projectDirectory, attemptID),
        ),
      }
    } catch {
      return {}
    }
  }

  /** The open worker concern of one unsettled task with its totals, as `{ concern }`, or nothing. */
  protected concern(
    taskID: string,
    planID: string,
    state: string,
  ): { concern: TaskConcern } | Record<string, never> {
    if (!canStruggle(state)) return {}
    return this.repository.read((db): { concern: TaskConcern } | Record<string, never> => {
      const open = openConcerns(db, this.repository.projectDirectory, { taskID })
      if (!open.length) return {}
      const facts = readTrajectoryFacts(db, planID, taskID, Date.now())
      return {
        concern: {
          line: open.map((item) => item.reason).join("; "),
          reasons: open.map((item) => item.ruleID),
          totals: {
            attempts: facts.attempts,
            verifyRounds: facts.verifyRounds,
            attemptMs: facts.attemptMs,
            tokens: facts.tokens,
            toolCalls: facts.toolCalls,
            costUSD: facts.costUSD,
          },
        },
      }
    })
  }

  /** Start of the latest attempt, as `{ startedAt }`, or nothing when none is recorded. */
  protected startedAt(
    taskID: string,
    planID: string,
  ): { startedAt: number } | Record<string, never> {
    const started = this.repository.read(
      (db) =>
        db
          .query<{ started_at: number }, [string, string]>(
            "SELECT started_at FROM runner_attempts WHERE plan_id=? AND task_id=? ORDER BY number DESC,started_at DESC LIMIT 1",
          )
          .get(planID, taskID)?.started_at,
    )
    return started === undefined ? {} : { startedAt: started }
  }

  protected recordedNodeState(taskID: string, planID: string): TaskState | undefined {
    return this.repository.read(
      (db) =>
        db
          .query<{ state: TaskState }, [string, string, string, string]>(
            "SELECT state FROM runner_nodes WHERE plan_id=? AND task_id=? AND EXISTS (SELECT 1 FROM runner_plans WHERE id=? AND project_directory=?)",
          )
          .get(planID, taskID, planID, this.repository.projectDirectory)?.state,
    )
  }

  /** Read only the requested task's latest plan/attempt associations; never hold the DB across host reads. */
  currentActivityTargets(
    taskIDs: readonly string[],
    scopeSessionID?: string,
  ): CurrentActivityTarget[] {
    if (taskIDs.length > 40 || new Set(taskIDs).size !== taskIDs.length)
      throw new Error("Current activity task selection is invalid")
    return this.repository.read((db) =>
      taskIDs.map((taskID): CurrentActivityTarget => {
        const taskExists = db
          .query<{ present: number }, [string, string]>(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE project_directory=? AND id=?) AS present",
          )
          .get(this.repository.projectDirectory, taskID)?.present
        if (!taskExists) return unavailableTarget(taskID)

        if (scopeSessionID) {
          const associated = db
            .query<{ linked: number }, (string | number)[]>(
              `SELECT CASE WHEN EXISTS (
                SELECT 1 FROM tasks t WHERE t.project_directory=? AND t.id=? AND (
                  json_extract(t.body,'$.provenance.sessionID')=? OR EXISTS (
                    SELECT 1 FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
                    WHERE n.task_id=t.id AND p.project_directory=t.project_directory AND p.owner=?
                  ) OR EXISTS (
                    SELECT 1 FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
                    WHERE a.task_id=t.id AND p.project_directory=t.project_directory AND a.session_id=?
                  )
                )
              ) THEN 1 ELSE 0 END AS linked`,
            )
            .get(
              this.repository.projectDirectory,
              taskID,
              scopeSessionID,
              scopeSessionID,
              scopeSessionID,
            )?.linked
          if (!associated) return unavailableTarget(taskID)
        }

        const node = db
          .query<
            {
              plan_id: string
              node_state: TaskState
              node_version: number
              node_reason: string | null
              plan_state: string
              plan_version: number
              plan_reason: string | null
            },
            [string, string]
          >(
            `SELECT n.plan_id,n.state AS node_state,n.version AS node_version,n.reason AS node_reason,
                p.state AS plan_state,p.version AS plan_version,p.reason AS plan_reason
             FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
             WHERE p.project_directory=? AND n.task_id=?
             ORDER BY p.rowid DESC LIMIT 1`,
          )
          .get(this.repository.projectDirectory, taskID)
        if (!node) return { ...unavailableTarget(taskID), authorized: true }

        const attempt = db
          .query<
            { id: string; session_id: string; workspace: string; state: string },
            [string, string]
          >(
            `SELECT id,session_id,workspace,state FROM runner_attempts
             WHERE plan_id=? AND task_id=? ORDER BY number DESC,started_at DESC,id DESC LIMIT 1`,
          )
          .get(node.plan_id, taskID)
        const waiting =
          node.plan_state !== "cancelled" &&
          (node.node_state === "blocked" ||
            (node.plan_state === "blocked" && !TERMINAL_NODE_STATES.has(node.node_state)))
        return {
          taskID,
          authorized: true,
          attempt: attempt
            ? {
                id: attempt.id,
                sessionID: attempt.session_id,
                workspace: attempt.workspace,
                state: attempt.state,
              }
            : null,
          recordedState: node.node_state,
          waiting,
          holdReason: waiting ? (node.node_reason ?? node.plan_reason) : null,
          planID: node.plan_id,
          nodeVersion: node.node_version,
          planVersion: node.plan_version,
        }
      }),
    )
  }
}

function unavailableTarget(taskID: string): CurrentActivityTarget {
  return {
    taskID,
    authorized: false,
    attempt: null,
    recordedState: null,
    waiting: false,
    holdReason: null,
    planID: null,
    nodeVersion: null,
    planVersion: null,
  }
}

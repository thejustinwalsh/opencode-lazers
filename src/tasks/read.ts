import { scopePatternsConflict } from "../runner/artifacts.ts"
import { PlanInput } from "../runner/schema.ts"
import { prerequisitePlanAction } from "../runner/prerequisite-proof.ts"
import { taskAuditHistory } from "../audit/history.ts"
import { ReadOnlyTaskRepository } from "../storage.ts"
import type { TaskRepository } from "../storage.ts"
import { GetInput, GetOutput } from "./contract.ts"
import type { ProjectRef, UnitAccess } from "../projects/scope.ts"
import { findOwner } from "../projects/resolve.ts"
import { isTakeoverAttempt } from "../recovery/detector.ts"
import { RunnerStore } from "../runner/store.ts"
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
  /** All-projects read: the project the task belongs to. */
  project?: ProjectRef
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

/** Reads of another checkout of the shared database that cannot write; `close` releases it. */
function readsAt(path: string, directory: string) {
  const repository = new ReadOnlyTaskRepository(path, directory)
  return {
    reads: new TaskReads(repository, RunnerStore.readOnly(repository)),
    close: () => repository.close(),
  }
}

export class TaskReads {
  readonly runner: RunnerStore
  constructor(
    readonly repository: TaskRepository,
    runner?: RunnerStore,
  ) {
    this.runner = runner ?? new RunnerStore(repository)
  }

  /**
   * A task of any readable project by id or `<CODE>-<n>` reference, read from its own checkout.
   * An unknown task comes back `not_found`.
   */
  async getAll(input: unknown, access: UnitAccess) {
    const { allProjects, sessionID: _caller, ...rest } = GetInput.parse(input)
    if (!allProjects) throw new Error("Not an all-projects read")
    const query = /^[0-9a-f]{8}-/i.test(rest.taskID)
      ? { taskID: rest.taskID }
      : { reference: rest.taskID }
    const owner = findOwner(this.repository, access.units, query)
    if (!owner) return GetOutput.parse({ status: "not_found" })
    const at = readsAt(this.repository.path, owner.unit.directory)
    try {
      const found = at.reads.get(rest)
      return found.status === "found" ? { ...found, project: owner.unit.project } : found
    } finally {
      at.close()
    }
  }

  /** Targets for tasks of any readable project; an unknown one is unavailable. */
  async currentActivityTargetsAll(
    taskIDs: readonly string[],
    access: UnitAccess,
  ): Promise<CurrentActivityTarget[]> {
    if (taskIDs.length > 40 || new Set(taskIDs).size !== taskIDs.length)
      throw new Error("Current activity task selection is invalid")
    const targets: CurrentActivityTarget[] = []
    for (const taskID of taskIDs) {
      const owner = findOwner(this.repository, access.units, { taskID })
      if (!owner) {
        targets.push(unavailableTarget(taskID))
        continue
      }
      const at = readsAt(this.repository.path, owner.unit.directory)
      try {
        const [target] = at.reads.currentActivityTargets([taskID])
        targets.push({ ...target!, project: owner.unit.project })
      } finally {
        at.close()
      }
    }
    return targets
  }

  get(input: unknown) {
    const query = GetInput.parse(input)
    if (query.allProjects) throw new Error("An all-projects read is read with getAll")
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
        ...(isTakeoverAttempt(attempt.policy) ? { takeover: true as const } : {}),
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
    if (execution.waitingOnPlansComplete === false)
      return {
        ...execution,
        state: "blocked" as const,
        reason: "Prerequisite plan facts are incomplete; dependent work remains queued.",
      }
    const prerequisites = execution.waitingOnPlans ?? []
    if (prerequisites.length) {
      const count = execution.waitingOnPlansCount ?? prerequisites.length
      const details = prerequisites
        .slice(0, 4)
        .map(
          (required) =>
            `${required.title ?? "Prerequisite plan"} [${required.planID}] is ${required.state ?? "unavailable"}${required.reason ? `: ${required.reason}` : ""}`,
        )
        .join("; ")
      const more = count > prerequisites.length ? `; ${count - prerequisites.length} more` : ""
      const actions = [
        ...new Set(prerequisites.map((required) => prerequisitePlanAction(required.state ?? ""))),
      ].join(" ")
      return {
        ...execution,
        state: "blocked" as const,
        reason: `Waiting for prerequisite integration: ${details}${more}. ${actions}`,
      }
    }
    let input: ReturnType<typeof PlanInput.safeParse>
    try {
      input = PlanInput.safeParse(JSON.parse(plan.body))
    } catch {
      return execution
    }
    if (!input.success) return execution
    const mode = input.data.workspaceMode
    const scope = this.runner.effectiveReservationScope(taskID)
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

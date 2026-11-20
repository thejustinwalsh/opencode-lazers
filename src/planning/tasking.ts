import { z } from "zod"
import { PlanSubmissionInput } from "../runner/schema.ts"
import { invalidVerificationTimings } from "../runner/verification-timeout.ts"
import type { VerificationTimeoutDefaults } from "../runner/verification-timeout.ts"
import { TaskSubmissionSchema } from "../task.ts"
import { taskMarkdownLink } from "../tasks/links.ts"
import { PlanningBody, changedFields, validateBody, type TaskDraft } from "./draft.ts"
import type { PlanningStore } from "./store.ts"

export const PlanTaskInput = z.strictObject({
  planningID: z.uuid(),
  baseCommit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional()
    .describe("Defaults to the HEAD of this checkout."),
  selfReviews: z
    .array(z.strictObject({ draftID: z.string(), reviewID: z.uuid() }))
    .max(100)
    .optional()
    .describe("The lz-verify-task review ids of the drafts, recorded for measurement."),
})
export type PlanTaskInput = z.infer<typeof PlanTaskInput>

type Problem = { path: string; message: string }
export type PlanTaskResult =
  | {
      status: "tasked"
      planID: string
      tasks: { draftID: string; taskID: string; reference: string; link: string }[]
      /** Per draft (and `@plan`): the fields that changed after the last review. */
      changedAfterReview: Record<string, string[]>
    }
  | { status: "invalid"; drafts: Record<string, Problem[]>; plan: Problem[] }

export type PlanTaskerDeps = {
  store: PlanningStore
  projectID: string
  /** The shared submit-task path (`lz-submit-task`'s own function). */
  submitTask: (input: unknown, sessionID: string) => Promise<unknown>
  /** The shared submit-plan path (`lz-submit-plan`'s own function). */
  submitPlan: (input: unknown, sessionID: string) => Promise<unknown>
  headCommit: () => Promise<string>
  cancelReviews: (planningID: string, reason: string) => Promise<void>
  timeoutDefaults: VerificationTimeoutDefaults
  now?: () => number
}

const draftKey = (planningID: string, draftID: string, revision: number) =>
  `planning:${planningID}:${draftID}:r${revision}`

/** A stable, valid UUID per draft, for checking the assembled plan before any task exists. */
const placeholder = (index: number) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`

/** Dependencies first; ties keep the order the drafts were written in. */
function topological(tasks: readonly TaskDraft[]): string[] {
  const placed: string[] = []
  const remaining = [...tasks]
  while (remaining.length) {
    const at = remaining.findIndex((task) => task.dependsOn.every((id) => placed.includes(id)))
    if (at === -1) return [...placed, ...remaining.map((task) => task.draftID)]
    placed.push(remaining.splice(at, 1)[0]!.draftID)
  }
  return placed
}

/**
 * Tasks a stored plan as it is: each draft goes through the task-submission path unchanged, then
 * the assembled plan through the plan-submission path. Every check runs before anything is
 * written, and the deterministic keys make a retry after an ambiguous failure a replay.
 */
export class PlanTasker {
  constructor(private readonly deps: PlanTaskerDeps) {}

  private recorded(planningID: string): PlanTaskResult | undefined {
    const { store, projectID } = this.deps
    const planning = store.planning(planningID)!
    const rows = store.tasked(planningID)
    if (!rows.length || !planning.taskedPlanId) return undefined
    const changed: Record<string, string[]> = {}
    for (const row of rows) {
      const fields = row.changedFieldsJson ? (JSON.parse(row.changedFieldsJson) as string[]) : []
      if (fields.length) changed[row.draftId] = fields
    }
    return {
      status: "tasked",
      planID: planning.taskedPlanId,
      tasks: rows.map((row) => ({
        draftID: row.draftId,
        taskID: row.taskId!,
        reference: row.reference!,
        link: taskMarkdownLink(row.reference!, projectID),
      })),
      changedAfterReview: changed,
    }
  }

  async call(input: PlanTaskInput, caller: { sessionID: string }): Promise<PlanTaskResult> {
    const { store, projectID } = this.deps
    const planning = store.planning(input.planningID)
    const bad = (path: string, message: string): PlanTaskResult => ({
      status: "invalid",
      drafts: {},
      plan: [{ path, message }],
    })
    if (!planning || planning.projectKey !== projectID)
      return bad("planningID", "no such plan in this project")
    if (planning.state === "abandoned") return bad("planningID", "plan is abandoned")
    if (planning.state === "tasked")
      return this.recorded(planning.id) ?? bad("planningID", "plan is tasked")
    if (planning.revision === 0) return bad("planningID", "the plan has no revision")

    const revision = planning.revision
    const body = PlanningBody.parse(JSON.parse(store.revision(planning.id, revision)!.body))
    const already = new Set(store.tasked(planning.id).map((row) => row.draftId))
    const baseCommit = input.baseCommit ?? (await this.deps.headCommit())
    const problems = this.preflight(planning.id, revision, body, baseCommit, already)
    if (Object.keys(problems.drafts).length || problems.plan.length)
      return { status: "invalid", ...problems }

    // Nothing is written until every draft passes; then the open reviews stop.
    await this.deps.cancelReviews(planning.id, "plan tasked")
    const tasks: { draftID: string; taskID: string; reference: string }[] = []
    for (const draft of body.tasks) {
      const receipt = (await this.deps.submitTask(
        {
          ...(draft.proposal as object),
          idempotencyKey: draftKey(planning.id, draft.draftID, revision),
        },
        caller.sessionID,
      )) as { status?: string; taskID?: string; reference?: string; errors?: Problem[] }
      if (receipt.status !== "submitted" || !receipt.taskID || !receipt.reference)
        return {
          status: "invalid",
          drafts: {
            [draft.draftID]: receipt.errors ?? [
              { path: "", message: JSON.stringify(receipt).slice(0, 500) },
            ],
          },
          plan: [],
        }
      tasks.push({ draftID: draft.draftID, taskID: receipt.taskID, reference: receipt.reference })
    }
    const idOf = new Map(tasks.map((task) => [task.draftID, task.taskID]))
    const order = topological(body.tasks)
    const planReceipt = (await this.deps.submitPlan(
      this.assemble(planning.id, revision, body, baseCommit, (id) => idOf.get(id)!, order),
      caller.sessionID,
    )) as { planID?: string }
    if (typeof planReceipt?.planID !== "string")
      return bad("plan", JSON.stringify(planReceipt).slice(0, 500))

    const reviewed = Math.max(
      0,
      ...store
        .reviews(planning.id)
        .flatMap((review) => (review.settledAt ? [review.revision] : [])),
    )
    const changed =
      reviewed && reviewed !== revision
        ? changedFields(
            PlanningBody.parse(JSON.parse(store.revision(planning.id, reviewed)!.body)),
            body,
          )
        : {}
    const selfReview = new Map(
      (input.selfReviews ?? []).map((entry) => [entry.draftID, entry.reviewID]),
    )
    for (const task of tasks)
      store.recordTasked({
        planningId: planning.id,
        draftId: task.draftID,
        revision,
        taskId: task.taskID,
        reference: task.reference,
        planId: planReceipt.planID,
        selfReviewId: selfReview.get(task.draftID) ?? null,
        changedFieldsJson: JSON.stringify(changed[task.draftID] ?? []),
      })
    store.setTaskedPlan(planning.id, planReceipt.planID)
    store.move(planning.id, "tasked", (this.deps.now ?? Date.now)())
    return {
      status: "tasked",
      planID: planReceipt.planID,
      tasks: tasks.map((task) => ({
        ...task,
        link: taskMarkdownLink(task.reference, projectID),
      })),
      changedAfterReview: changed,
    }
  }

  private assemble(
    planningID: string,
    revision: number,
    body: PlanningBody,
    baseCommit: string,
    taskID: (draftID: string) => string,
    order: string[],
  ) {
    return {
      requestID: `planning:${planningID}:r${revision}`,
      title: body.title,
      objective: body.plan.objective,
      ...(body.plan.priority !== undefined ? { priority: body.plan.priority } : {}),
      ...(body.plan.afterPlans ? { afterPlans: body.plan.afterPlans } : {}),
      baseCommit,
      workspaceMode: body.plan.workspaceMode,
      ...(body.plan.workerAgent ? { workerAgent: body.plan.workerAgent } : {}),
      ...(body.plan.workerModel ? { workerModel: body.plan.workerModel } : {}),
      nodes: body.tasks.map((draft) => ({
        taskID: taskID(draft.draftID),
        revision: 1 as const,
        ...(draft.persona ? { persona: draft.persona } : {}),
      })),
      dependencies: body.tasks.flatMap((draft) =>
        draft.dependsOn.map((dependency) => ({
          prerequisite: taskID(dependency),
          successor: taskID(draft.draftID),
        })),
      ),
      integrationOrder: order.map(taskID),
      verification: body.plan.verification,
      acceptance: body.plan.acceptance,
    }
  }

  /** Every deferred check, before anything is written. */
  private preflight(
    planningID: string,
    revision: number,
    body: PlanningBody,
    baseCommit: string,
    already: ReadonlySet<string>,
  ): { drafts: Record<string, Problem[]>; plan: Problem[] } {
    const drafts: Record<string, Problem[]> = {}
    const add = (draftID: string, problem: Problem) => (drafts[draftID] ??= []).push(problem)
    for (const draft of body.tasks) {
      const parsed = TaskSubmissionSchema.safeParse({
        ...(draft.proposal as object),
        idempotencyKey: draftKey(planningID, draft.draftID, revision),
      })
      if (!parsed.success) {
        for (const issue of parsed.error.issues)
          add(draft.draftID, { path: issue.path.join("."), message: issue.message })
        continue
      }
      // A replay of an earlier, ambiguous attempt may lack a classification; a fresh draft may not.
      if (!parsed.data.classification && !already.has(draft.draftID))
        add(draft.draftID, {
          path: "classification",
          message: "A task needs its classification (task-kind/v1) before it is tasked",
        })
      for (const timing of invalidVerificationTimings(
        parsed.data.verification,
        this.deps.timeoutDefaults,
      ))
        add(draft.draftID, {
          path: `verification.${timing.index}.inactivityTimeoutMs`,
          message: `Inactivity allowance exceeds the hard backstop (check ${timing.checkID})`,
        })
    }
    const validation = validateBody(body)
    for (const edge of validation.graph)
      add(edge.draftID, { path: "dependsOn", message: edge.detail })
    const plan: Problem[] = [...validation.plan]
    const order = topological(body.tasks)
    const assembled = PlanSubmissionInput.safeParse(
      this.assemble(
        planningID,
        revision,
        body,
        baseCommit,
        (id) => placeholder(body.tasks.findIndex((draft) => draft.draftID === id)),
        order,
      ),
    )
    if (!assembled.success && !validation.graph.length)
      for (const issue of assembled.error.issues)
        plan.push({ path: issue.path.join("."), message: issue.message })
    return { drafts, plan }
  }
}

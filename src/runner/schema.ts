import { MAX_PRIORITY, NO_PRIORITY } from "./priority.ts"
import { z } from "zod"
import { WorkerAgent } from "./worker-agent.ts"
import { FALLOW_CHECK_ID, TaskProposalSchema, dropLegacyHumanEvidence } from "../task.ts"

export const TaskState = z.enum([
  "queued",
  "ready",
  "running",
  "verifying",
  "accepted",
  "blocked",
  "failed",
  "cancelled",
  "exhausted",
  "incorporated",
])
export type TaskState = z.infer<typeof TaskState>
export const WorkerPersona = z.enum(["ui", "systems", "small-refactoring"])
export type WorkerPersona = z.infer<typeof WorkerPersona>
export const ModelPolicy = z.strictObject({
  providerID: z.string().min(1).describe("Native OpenCode provider ID, passed through unchanged."),
  id: z.string().min(1).describe("Native OpenCode model ID, passed through unchanged."),
  variant: z.string().optional().describe("Optional native variant or reasoning-effort ID."),
})
export type ModelPolicy = z.infer<typeof ModelPolicy>
export const ArchitectContinuityInput = z
  .strictObject({
    decisions: z
      .array(
        z
          .string()
          .min(1)
          .max(1000)
          .refine((value) => value.trim().length > 0),
      )
      .max(10)
      .describe("Exact, still-relevant conversation decisions; do not summarize the transcript."),
    unresolvedQuestions: z
      .array(
        z
          .string()
          .min(1)
          .max(1000)
          .refine((value) => value.trim().length > 0),
      )
      .max(10)
      .describe("Exact, still-open questions that still need a user decision."),
  })
  .superRefine((input, context) => {
    if (
      new TextEncoder().encode(
        JSON.stringify({
          decisions: input.decisions,
          unresolvedQuestions: input.unresolvedQuestions,
        }),
      ).byteLength > 12_000
    )
      context.addIssue({
        code: "custom",
        message: "Architect continuity checkpoint must fit 12 KB",
      })
  })
export type ArchitectContinuityInput = z.infer<typeof ArchitectContinuityInput>
/** 1 is the top priority; 0 is none; larger integers are lower, up to the maximum integer. */
const PlanPriority = z.int().min(NO_PRIORITY).max(MAX_PRIORITY)
const PRIORITY_DESCRIPTION =
  "Dispatch priority: 1 is the top priority, 2 is next, and larger integers are lower (up to 2147483647). 0 or omitted means no priority and dispatches after every prioritized plan. Equal priority preserves submission order. Active workers continue."
const StrictPlanInput = z
  .strictObject({
    requestID: z.string().trim().min(1).max(200),
    title: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Optional concise Architect-authored label; preserve verbatim and do not derive from objective.",
      ),
    objective: z.string().trim().min(1).max(8000),
    draft: z
      .boolean()
      .optional()
      .describe(
        "Set true only to save the plan without admitting it. Submitting a plan otherwise admits it, and the scheduler runs its tasks; run an explicit draft later with lz-plan-command run.",
      ),
    priority: PlanPriority.optional().describe(PRIORITY_DESCRIPTION),
    afterPlans: z
      .array(z.uuid())
      .optional()
      .describe(
        "Wait for these same-project plans to be integrated before dispatching; then use the integrated checkout as the starting baseline.",
      ),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    workspaceMode: z.enum(["shared", "isolated"]).default("shared"),
    workerAgent: WorkerAgent.optional().describe(
      "Runtime worker role. Use auditor for audit/refactor requests; Architect reviews its result before integration.",
    ),
    workerModel: ModelPolicy.optional().describe(
      "Exact user-authorized native provider, model and optional variant/effort; otherwise inherit the configured implementor. LAZERS does not catalog-validate or substitute the selected route.",
    ),
    nodes: z
      .array(
        z.strictObject({
          taskID: z.uuid(),
          revision: z.literal(1),
          persona: WorkerPersona.optional().describe(
            "Optional model-independent worker guidance for this task.",
          ),
        }),
      )
      .min(1)
      .max(100),
    dependencies: z.array(z.strictObject({ prerequisite: z.uuid(), successor: z.uuid() })).max(500),
    integrationOrder: z.array(z.uuid()).min(1).max(100),
    verification: TaskProposalSchema.shape.verification,
    acceptance: TaskProposalSchema.shape.acceptance,
    dispositions: z
      .array(
        z.strictObject({
          taskID: z.uuid(),
          otherTaskID: z.uuid(),
          relation: z.enum(["distinct", "supplements", "duplicate"]),
          rationale: z.string().trim().min(1).max(2000),
        }),
      )
      .max(500)
      .default([]),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set(plan.nodes.map((n) => n.taskID))
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message })
    if (ids.size !== plan.nodes.length) fail("nodes", "Duplicate task revision")
    if (
      new Set(plan.integrationOrder).size !== ids.size ||
      plan.integrationOrder.length !== ids.size ||
      plan.integrationOrder.some((id) => !ids.has(id))
    )
      fail("integrationOrder", "List each node once in deterministic topological order")
    const edges = new Set<string>()
    for (const edge of plan.dependencies) {
      const key = `${edge.prerequisite}:${edge.successor}`
      if (edges.has(key)) fail("dependencies", "Duplicate dependency")
      edges.add(key)
      if (!ids.has(edge.prerequisite) || !ids.has(edge.successor))
        fail("dependencies", "Missing dependency node")
      if (
        plan.integrationOrder.indexOf(edge.prerequisite) >=
        plan.integrationOrder.indexOf(edge.successor)
      )
        fail("dependencies", "Cycle or integration order violates dependency")
    }
    const verificationIDs = new Set(plan.verification.map((v) => v.id))
    if (verificationIDs.size !== plan.verification.length)
      fail("verification", "Duplicate verification ID")
    if (verificationIDs.has(FALLOW_CHECK_ID))
      fail(
        "verification",
        `Verification ID ${FALLOW_CHECK_ID} is reserved for the runtime's Fallow review`,
      )
    if (new Set(plan.acceptance.map((a) => a.id)).size !== plan.acceptance.length)
      fail("acceptance", "Duplicate acceptance ID")
    for (const assertion of plan.acceptance)
      for (const evidence of assertion.evidence) {
        if (evidence.kind === "verification" && !verificationIDs.has(evidence.verificationID))
          fail("acceptance", "Reference a declared graph verification ID")
      }
    for (const disposition of plan.dispositions) {
      if (disposition.taskID === disposition.otherTaskID)
        fail("dispositions", "Cannot relate a task to itself")
      if (!ids.has(disposition.taskID)) fail("dispositions", "Source task must belong to this plan")
    }
  })
/** New plan submissions: retired `kind: "human"` evidence is rejected. */
export const PlanSubmissionInput = StrictPlanInput
/**
 * Stored plan bodies and revisions: retired `kind: "human"` acceptance evidence
 * is read and dropped, so it never gates and never makes a plan unreadable.
 */
export const PlanInput = z.preprocess(dropLegacyHumanEvidence, StrictPlanInput)
export type PlanInput = z.infer<typeof StrictPlanInput>

export const DispatchPause = z.strictObject({
  reason: z.string(),
  untilPlans: z.array(z.uuid()),
})
export type DispatchPause = z.infer<typeof DispatchPause>

export const CommandInput = z
  .strictObject({
    requestID: z.string().trim().min(1).max(200),
    planID: z.uuid(),
    action: z
      .enum([
        "run",
        "cancel",
        "pause",
        "unpause",
        "audit",
        "reconcile",
        "reassign",
        "resume",
        "retry",
        "integrated",
        "schedule",
        "amend-scope",
        "adopt-descendant",
        "settle-startup",
        "retained-repair",
        "verify-retained",
      ])
      .describe(
        "Plan controls include schedule/run/cancel and pause/unpause. Pause stops new dispatch while active workers finish; resumeAfterPlans optionally unpauses after integration. Cancellation is an intentional stop, not temporary coordination. Other controls include audit/reconcile, evidence, and reviewed integration. A held cleanup retries by itself when its observed facts change; it never forces removal. resume continues the exact retained terminal worker; it also narrowly recovers the original cancelled retained-repair attempt only when durable/native evidence proves the runtime's unprompted repair-fence failure. Supply exact taskID and attemptID; resume does not silently override intentional cancellation or unrelated holds; resolve the reason and choose explicit resume/retry, reconciliation or replanning as appropriate. Without taskID, resume re-runs the combined check of a blocked, unaccepted plan on its current candidate; it never prompts accepted workers. verify-retained binds projectID, planRevision, taskID/taskRevision, latest attemptID and exact artifact; it verifies that commit in a temporary worktree with the task's ordinary checks, without an implementation turn, and records pass or fail. Run it again after a failure; combined acceptance is the ordinary combined check. See each field description for the narrow retained-repair, descendant-adoption and startup-settlement bindings.",
      ),
    reason: z
      .string()
      .min(1)
      .max(2000)
      .describe("Brief user-facing explanation; keep detailed evidence in linked notes.")
      .optional(),
    priority: PlanPriority.optional().describe(PRIORITY_DESCRIPTION),
    afterPlans: z.array(z.uuid()).optional(),
    resumeAfterPlans: z
      .array(z.uuid())
      .optional()
      .describe(
        "For pause: automatically unpause when these same-project plans are integrated. Omit for manual unpause. Active workers finish; only new dispatch pauses.",
      ),
    workspaceMode: z.enum(["shared", "isolated"]).optional(),
    baseCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional()
      .describe(
        "Explicit retry baseline for shared retry, or to advance a wholly unstarted plan to reviewed source on current HEAD. Existing attempts retain their baseline.",
      ),
    targetSessionID: z.string().min(1).max(200).optional(),
    taskID: z
      .uuid()
      .optional()
      .describe("Exact task revision for retained candidate verification."),
    attemptID: z
      .uuid()
      .optional()
      .describe(
        "Exact latest attempt to resume or recover; retained-repair recovery does not create a replacement attempt.",
      ),
    reviewInputID: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Exact tagged native review input for reconcile. Supply taskID and attemptID."),
    scopeAdditions: TaskProposalSchema.shape.writeScope.min(1).optional(),
    scopeRemovals: TaskProposalSchema.shape.writeScope
      .min(1)
      .optional()
      .describe(
        "Exact supplemental scope patterns to revoke for stopped work; original task scope remains.",
      ),
    artifact: z
      .string()
      .max(128)
      .optional()
      .describe(
        "Exact full committed candidate identity. verify-retained also accepts the clean HEAD strictly descending from the previous artifact of the current authorized same-worker repair; original idle/resources remain separate.",
      ),
    descendantCommit: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .optional(),
    adoptionID: z.uuid().optional(),
    targetBranch: z.string().min(1).max(200).optional(),
    projectID: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Current native project identity for retained verification."),
    planRevision: z
      .int()
      .positive()
      .optional()
      .describe("Current plan revision for retained verification."),
    taskRevision: z
      .int()
      .positive()
      .optional()
      .describe("Current task revision for retained verification."),
  })
  .superRefine((input, context) => {
    if (input.scopeRemovals && input.action !== "amend-scope")
      context.addIssue({
        code: "custom",
        path: ["scopeRemovals"],
        message: "Scope removals require amend-scope",
      })
    if (input.action === "retained-repair") {
      if (!input.taskID || !input.attemptID || !input.artifact || !input.reason?.trim())
        context.addIssue({
          code: "custom",
          path: ["action"],
          message:
            "Retained repair requires taskID, attemptID, exact artifact and concrete defect reason",
        })
      if (input.artifact && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.artifact))
        context.addIssue({
          code: "custom",
          path: ["artifact"],
          message: "Retained repair requires an exact full commit identity",
        })
    }
    if (
      input.reviewInputID !== undefined &&
      (input.action !== "reconcile" || !input.taskID || !input.attemptID)
    )
      context.addIssue({
        code: "custom",
        path: ["reviewInputID"],
        message: "Review input requires reconcile, taskID and attemptID",
      })
  })
  .superRefine((command, context) => {
    if (command.action === "resume" && !command.taskID) {
      if (!command.reason?.trim())
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "Plan-level combined verification resume requires a reason",
        })
      for (const field of ["attemptID", "workspaceMode", "baseCommit"] as const)
        if (command[field] !== undefined)
          context.addIssue({
            code: "custom",
            path: [field],
            message: "Plan-level combined verification resume cannot change task controls",
          })
    }
    if (command.action === "settle-startup")
      for (const field of ["taskID", "attemptID", "reason"] as const)
        if (!command[field])
          context.addIssue({
            code: "custom",
            path: [field],
            message: `Startup settlement requires ${field}`,
          })
    if (command.action === "verify-retained") {
      for (const field of [
        "projectID",
        "planRevision",
        "taskRevision",
        "taskID",
        "attemptID",
        "artifact",
        "reason",
      ] as const)
        if (!command[field])
          context.addIssue({
            code: "custom",
            path: [field],
            message: `Retained verification requires ${field}`,
          })
      if (command.artifact && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(command.artifact))
        context.addIssue({
          code: "custom",
          path: ["artifact"],
          message: "Retained verification requires an exact full commit identity",
        })
    }
  })
export type CommandInput = z.infer<typeof CommandInput>

export type Finding = {
  id: string
  code: string
  taskIDs: string[]
  evidence: string
  actions: string[]
}
export type Execution = {
  planID: string
  taskID: string
  state: TaskState
  version: number
  reason: string | null
  waitingOn: string[]
  dispatchPause?: DispatchPause
}

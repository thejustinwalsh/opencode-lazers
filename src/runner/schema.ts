import { MAX_PRIORITY, NO_PRIORITY } from "./priority.ts"
import { z } from "zod"
import { WorkerAgent } from "./worker-agent.ts"
import { FALLOW_CHECK_IDS, TaskProposalSchema, dropLegacyHumanEvidence } from "../task.ts"
import { TaskPersonaSchema } from "../personas/schema.ts"

export const WorkerPersona = TaskPersonaSchema
export type WorkerPersona = z.infer<typeof WorkerPersona>

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
type ArchitectContinuityInput = z.infer<typeof ArchitectContinuityInput>
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
          persona: TaskPersonaSchema.optional().describe(
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
    const reserved = FALLOW_CHECK_IDS.find((id) => verificationIDs.has(id))
    if (reserved)
      fail("verification", `Verification ID ${reserved} is reserved for the runtime's Fallow audit`)
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

type IntegrationCommandFields = {
  action: string
  targetBranch?: string
  expectedTargetHead?: string
  targetBaseBranch?: string
  targetBaseRevision?: string
  targetTaskIDs?: string[]
  targetPullRequest?: unknown
  batchTaskIDs?: string[]
  taskID?: string
  reason?: string
}

type CommandValidationIssue = { path: string[]; message: string }

function integrationTargetIssues(input: IntegrationCommandFields): CommandValidationIssue[] {
  const issues: CommandValidationIssue[] = []
  const required = [
    "targetBranch",
    "expectedTargetHead",
    "targetBaseBranch",
    "targetBaseRevision",
    "targetTaskIDs",
    "reason",
  ] as const
  if (input.action === "integration-target") {
    for (const field of required)
      if (!input[field])
        issues.push({
          path: [field],
          message: `Integration target setup requires ${field}`,
        })
  } else if (
    input.targetBaseBranch !== undefined ||
    input.targetBaseRevision !== undefined ||
    input.targetTaskIDs !== undefined ||
    input.targetPullRequest !== undefined
  )
    issues.push({
      path: ["action"],
      message: "Target metadata fields require integration-target",
    })
  return issues
}

function batchIntegrationIssues(input: IntegrationCommandFields): CommandValidationIssue[] {
  const batch = input.batchTaskIDs
  if (!batch) return []
  const issues: CommandValidationIssue[] = []
  if (input.action !== "integrated")
    issues.push({ path: ["batchTaskIDs"], message: "Batch task IDs require integrated" })
  if (!input.taskID || !batch.includes(input.taskID))
    issues.push({
      path: ["batchTaskIDs"],
      message: "The integration task must belong to its shared batch",
    })
  if (new Set(batch).size !== batch.length)
    issues.push({ path: ["batchTaskIDs"], message: "Batch task IDs must be unique" })
  return issues
}

function integrationCommandIssues(input: IntegrationCommandFields): CommandValidationIssue[] {
  return [...integrationTargetIssues(input), ...batchIntegrationIssues(input)]
}

export const DispatchPause = z.strictObject({
  reason: z.string(),
  untilPlans: z.array(z.uuid()),
  /** Present when the whole project or every project is paused; absent for a plan's own pause. */
  level: z.enum(["project", "global"]).optional(),
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
        "integration-target",
        "schedule",
        "amend-scope",
        "adopt-descendant",
        "settle-startup",
        "retained-repair",
        "verify-retained",
        "takeover-submit",
      ])
      .describe(
        "Plan controls include schedule/run/cancel and pause/unpause. Pause stops new dispatch while active workers finish; resumeAfterPlans optionally unpauses after integration. Use integration-target before landing to bind selected tasks to an existing local branch created or inspected through configured repository tooling, its reviewed base, exact observed head and optional external PR metadata; integrated then records the reviewed target range without switching checkouts or merging into the default branch. Cancellation is an intentional stop, not temporary coordination. Other controls include audit/reconcile, evidence, and reviewed integration. A held cleanup retries by itself when its observed facts change; it never forces removal. resume continues the exact retained terminal worker; it also narrowly recovers the original cancelled retained-repair attempt only when durable/native evidence proves the runtime's unprompted repair-fence failure. Supply exact taskID and attemptID; resume does not silently override intentional cancellation or unrelated holds; resolve the reason and choose explicit resume/retry, reconciliation or replanning as appropriate. Without taskID, resume re-runs the combined check of a blocked, unaccepted plan on its current candidate; it never prompts accepted workers. verify-retained binds projectID, planRevision, taskID/taskRevision, latest attemptID and exact artifact; it verifies that commit in a temporary worktree with the task's ordinary checks, without an implementation turn, and records pass or fail. Run it again after a failure; combined acceptance is the ordinary combined check. takeover-submit (taskID, reason) sends a task you took over with lz-request-handoff, as committed in its workspace, to the ordinary verification. See each field description for the narrow retained-repair, descendant-adoption and startup-settlement bindings.",
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
    targetBranch: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Selected local target branch. Create or inspect branches and PRs with configured repository tooling first; the runner does not switch checkouts or merge into the default branch.",
      ),
    expectedTargetHead: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .optional(),
    targetBaseBranch: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Reviewed local base branch for integration-target."),
    targetBaseRevision: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .optional(),
    targetTaskIDs: z
      .array(z.uuid())
      .min(1)
      .max(100)
      .refine((taskIDs) => new Set(taskIDs).size === taskIDs.length)
      .optional()
      .describe("Selected same-project tasks bound to one shared integration target."),
    targetPullRequest: z
      .strictObject({
        id: z.string().min(1).max(256),
        number: z.int().positive().nullable(),
        url: z.url(),
        title: z.string().max(512).nullable(),
      })
      .nullable()
      .optional(),
    batchTaskIDs: z.array(z.uuid()).min(2).max(100).optional(),
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
    for (const issue of integrationCommandIssues(input))
      context.addIssue({ code: "custom", path: issue.path, message: issue.message })
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
export const MAX_EXECUTION_PLAN_WAIT_REFERENCES = 100
export const ExecutionPlanWait = z.strictObject({
  planID: z.uuid(),
  title: z.string().max(120).nullable(),
  state: z.string().max(80).nullable(),
  version: z.int().positive().nullable(),
  reason: z.string().max(400).nullable(),
})
export type ExecutionPlanWait = z.infer<typeof ExecutionPlanWait>
export type Execution = {
  planID: string
  taskID: string
  state: TaskState
  version: number
  reason: string | null
  waitingOn: string[]
  waitingOnPlans?: ExecutionPlanWait[]
  waitingOnPlansCount?: number
  waitingOnPlansComplete?: boolean
  dispatchPause?: DispatchPause
}

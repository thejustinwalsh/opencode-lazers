import { z } from "zod"
import { TaskProposalSchema } from "../task.ts"

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
export const PlanInput = z
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
    priority: z
      .int()
      .optional()
      .describe(
        "Higher values dispatch first; equal priority preserves submission order. Active workers continue.",
      ),
    afterPlans: z
      .array(z.uuid())
      .optional()
      .describe(
        "Wait for these same-project plans to be integrated before dispatching; then use the integrated checkout as the starting baseline.",
      ),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    workspaceMode: z.enum(["shared", "isolated"]).default("shared"),
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
export type PlanInput = z.infer<typeof PlanInput>

export const CommandInput = z
  .strictObject({
    requestID: z.string().trim().min(1).max(200),
    planID: z.uuid(),
    expectedVersion: z.int().positive(),
    action: z
      .enum([
        "run",
        "cancel",
        "audit",
        "reconcile",
        "reconcile-source-notices",
        "reassign",
        "human-evidence",
        "resume",
        "retry",
        "integrated",
        "schedule",
        "amend-scope",
        "adopt-descendant",
        "quarantine-source",
        "settle-startup",
        "retained-repair",
        "verify-retained",
        "cancel-retained-verification",
      ])
      .describe(
        "Plan controls include schedule/run/cancel, audit/reconcile, evidence, and reviewed integration. verify-retained binds projectID, planRevision, taskID/taskRevision, latest attemptID and exact artifact; it runs isolated ordinary checks without an implementation turn. cancel-retained-verification names retainedVerificationID. See each field description for the narrow retained-repair, descendant-adoption, startup-settlement and source-quarantine bindings.",
      ),
    reason: z
      .string()
      .min(1)
      .max(2000)
      .describe("Brief user-facing explanation; keep detailed evidence in linked notes.")
      .optional(),
    priority: z.int().optional(),
    afterPlans: z.array(z.uuid()).optional(),
    workspaceMode: z.enum(["shared", "isolated"]).optional(),
    baseCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional()
      .describe(
        "Explicit retry baseline for shared retry, or to advance a wholly unstarted plan to reviewed source on current HEAD. Existing attempts retain their baseline.",
      ),
    targetSessionID: z.string().min(1).max(200).optional(),
    sourceSessionID: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "For explicit reconciliation of positively owned queued legacy Architect source notices.",
      ),
    taskID: z
      .uuid()
      .optional()
      .describe("Exact task revision for retained candidate verification."),
    attemptID: z
      .uuid()
      .optional()
      .describe(
        "Latest original implementation attempt; verification does not create a replacement attempt.",
      ),
    reviewInputID: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Exact tagged native review input for reconcile or quarantine-source. Supply taskID and attemptID. Quarantine pins the current completed review for source-only archival; it does not establish task completion or background-idle proof.",
      ),
    scopeAdditions: TaskProposalSchema.shape.writeScope.min(1).optional(),
    assertionID: z.string().max(64).optional(),
    artifact: z
      .string()
      .max(128)
      .optional()
      .describe("Exact full committed candidate identity for retained verification or evidence."),
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
    retainedVerificationID: z
      .uuid()
      .optional()
      .describe(
        "Exact durable retained-verification operation to cancel or provide human evidence for.",
      ),
  })
  .superRefine((input, context) => {
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
      (!["reconcile", "quarantine-source"].includes(input.action) ||
        !input.taskID ||
        !input.attemptID)
    )
      context.addIssue({
        code: "custom",
        path: ["reviewInputID"],
        message: "Review input requires reconcile or quarantine-source, taskID and attemptID",
      })
  })
  .superRefine((input, context) => {
    if (input.sourceSessionID !== undefined && input.action !== "reconcile-source-notices")
      context.addIssue({
        code: "custom",
        path: ["sourceSessionID"],
        message: "Source notice reconciliation requires action reconcile-source-notices",
      })
    if (input.action === "reconcile-source-notices" && !input.sourceSessionID)
      context.addIssue({
        code: "custom",
        path: ["sourceSessionID"],
        message: "Source notice reconciliation requires sourceSessionID",
      })
    if (input.action === "reconcile-source-notices" && input.reviewInputID !== undefined)
      context.addIssue({
        code: "custom",
        path: ["reviewInputID"],
        message: "Source notice reconciliation cannot reconcile worker review input",
      })
  })
  .superRefine((command, context) => {
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
    if (command.action === "cancel-retained-verification" && !command.retainedVerificationID)
      context.addIssue({
        code: "custom",
        path: ["retainedVerificationID"],
        message: "Cancellation requires the exact retained verification operation ID",
      })
    if (command.adoptionID !== undefined && command.retainedVerificationID !== undefined)
      context.addIssue({
        code: "custom",
        path: ["retainedVerificationID"],
        message: "Human evidence can name only one retained operation",
      })
    if (
      command.retainedVerificationID !== undefined &&
      command.action !== "cancel-retained-verification" &&
      command.action !== "human-evidence"
    )
      context.addIssue({
        code: "custom",
        path: ["retainedVerificationID"],
        message: "Retained verification ID is valid only for cancellation or human evidence",
      })
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
}

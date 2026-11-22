import { z } from "zod"
import { fingerprint } from "../identity.ts"
import { PlanSubmissionInput, WorkerPersona } from "../runner/schema.ts"
import { TaskProposalSchema } from "../task.ts"
import type { Hashes } from "./view-assembly.ts"

export const DraftID = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)

/**
 * One task of a stored plan. The proposal is exactly what `lz-submit-task` takes, minus the
 * idempotency key, and is validated with `TaskProposalSchema`, not copied from it: an incomplete
 * draft is stored, and `validateBody` lists what is missing.
 */
const TaskDraft = z.strictObject({
  draftID: DraftID,
  dependsOn: z.array(DraftID).max(100).default([]),
  persona: WorkerPersona.optional(),
  proposal: z.unknown().optional(),
})
export type TaskDraft = z.infer<typeof TaskDraft>

const line = z.string().trim().min(1).max(2000)

export const PlanningBody = z
  .strictObject({
    title: z.string().trim().min(1).max(120),
    /** The ask as understood. */
    ask: z.string().trim().min(1).max(8000),
    assumptions: z.array(line).max(50).default([]),
    openDecisions: z
      .array(
        z.strictObject({
          id: z.string().regex(/^D\d+$/),
          question: line,
          options: z.array(line).min(2).max(4).optional(),
          answer: line.optional(),
        }),
      )
      .max(50)
      .default([]),
    /** The plan-level fields `lz-submit-plan` takes. */
    plan: z.strictObject({
      objective: PlanSubmissionInput.shape.objective,
      priority: PlanSubmissionInput.shape.priority,
      afterPlans: PlanSubmissionInput.shape.afterPlans,
      workspaceMode: PlanSubmissionInput.shape.workspaceMode,
      workerAgent: PlanSubmissionInput.shape.workerAgent,
      workerModel: PlanSubmissionInput.shape.workerModel,
      /** Validated with `TaskProposalSchema.shape.verification`; stored even when invalid. */
      verification: z.unknown().optional(),
      /** Validated with `TaskProposalSchema.shape.acceptance`; stored even when invalid. */
      acceptance: z.unknown().optional(),
    }),
    tasks: z.array(TaskDraft).min(1).max(100),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>()
    body.tasks.forEach((task, index) => {
      if (seen.has(task.draftID))
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "draftID"],
          message: `Duplicate draftID ${task.draftID}`,
        })
      seen.add(task.draftID)
    })
  })
export type PlanningBody = z.infer<typeof PlanningBody>

type Problem = { path: string; message: string }
export type Validation = {
  drafts: Record<string, Problem[]>
  plan: Problem[]
  graph: { kind: "unknown-dependency" | "cycle"; draftID: string; detail: string }[]
}

const problems = (error: z.ZodError): Problem[] =>
  error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))

/**
 * What is wrong now, never a refusal to store. Only drafts with problems have an entry. The
 * checks that need a project or a tasking context are `DEFERRED_TO_TASKING`.
 */
export function validateBody(body: PlanningBody): Validation {
  const drafts: Validation["drafts"] = {}
  for (const task of body.tasks) {
    const parsed = TaskProposalSchema.safeParse(task.proposal)
    if (!parsed.success) drafts[task.draftID] = problems(parsed.error)
  }
  const plan: Problem[] = []
  for (const key of ["verification", "acceptance"] as const) {
    const parsed = TaskProposalSchema.shape[key].safeParse(body.plan[key])
    if (!parsed.success)
      plan.push(
        ...problems(parsed.error).map((p) => ({
          ...p,
          path: [key, p.path].filter(Boolean).join("."),
        })),
      )
  }
  const graph: Validation["graph"] = []
  const ids = new Set(body.tasks.map((task) => task.draftID))
  for (const task of body.tasks)
    for (const dependency of task.dependsOn)
      if (!ids.has(dependency))
        graph.push({
          kind: "unknown-dependency",
          draftID: task.draftID,
          detail: `${task.draftID} depends on unknown draft ${dependency}`,
        })
  const edges = new Map(
    body.tasks.map((task) => [task.draftID, task.dependsOn.filter((id) => ids.has(id))]),
  )
  const state = new Map<string, "open" | "done">()
  const stack: string[] = []
  const visit = (id: string) => {
    if (state.get(id) === "done") return
    if (state.get(id) === "open") {
      const cycle = [...stack.slice(stack.indexOf(id)), id]
      graph.push({ kind: "cycle", draftID: id, detail: cycle.join(" → ") })
      return
    }
    state.set(id, "open")
    stack.push(id)
    for (const next of edges.get(id) ?? []) visit(next)
    stack.pop()
    state.set(id, "done")
  }
  for (const id of ids) visit(id)
  return { drafts, plan, graph }
}

/** Checked when the plan is tasked, not when it is stored. */
export const DEFERRED_TO_TASKING = [
  "idempotencyKey",
  "classification",
  "verification timing vs project defaults",
  "Fallow config",
  "base commit",
  "PlanSubmissionInput on the assembled plan",
  "model-route preflight",
] as const

const hash = (value: unknown) =>
  fingerprint(value === undefined ? null : JSON.parse(JSON.stringify(value)))

/**
 * SHA-256 over canonical JSON per draft field, so key order and task order change nothing. A
 * draft is keyed by its `draftID`, the plan-level fields and prose by `@plan`; `*` hashes the
 * whole unit.
 */
export function fieldHashes(body: PlanningBody): Hashes {
  const out: Hashes = {}
  for (const task of body.tasks) {
    const proposal =
      task.proposal !== null && typeof task.proposal === "object" && !Array.isArray(task.proposal)
        ? (task.proposal as Record<string, unknown>)
        : {}
    const entry: Record<string, string> = {}
    for (const [key, value] of Object.entries(proposal))
      if (value !== undefined) entry[key] = hash(value)
    entry.dependsOn = hash([...task.dependsOn].sort())
    if (task.persona !== undefined) entry.persona = hash(task.persona)
    entry["*"] = hash({
      proposal: task.proposal,
      dependsOn: [...task.dependsOn].sort(),
      persona: task.persona,
    })
    out[task.draftID] = entry
  }
  const plan: Record<string, string> = {
    title: hash(body.title),
    ask: hash(body.ask),
    assumptions: hash(body.assumptions),
    openDecisions: hash(body.openDecisions),
  }
  for (const [key, value] of Object.entries(body.plan))
    if (value !== undefined) plan[key] = hash(value)
  plan["*"] = hash({
    ...body,
    tasks: [...body.tasks].sort((a, b) => a.draftID.localeCompare(b.draftID)),
  })
  out["@plan"] = plan
  return out
}

/** Per draftID (and `@plan`): the keys whose value changed, or `added` / `removed`. */
export function changedFields(from: PlanningBody, to: PlanningBody): Record<string, string[]> {
  const before = fieldHashes(from)
  const after = fieldHashes(to)
  const out: Record<string, string[]> = {}
  for (const unit of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const then = before[unit]
    const now = after[unit]
    if (!then) out[unit] = ["added"]
    else if (!now) out[unit] = ["removed"]
    else {
      const keys = [...new Set([...Object.keys(then), ...Object.keys(now)])]
        .filter((key) => key !== "*" && then[key] !== now[key])
        .sort()
      if (keys.length) out[unit] = keys
    }
  }
  return out
}

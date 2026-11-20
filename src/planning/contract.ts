import { z } from "zod"

/**
 * The typed result every planning agent returns. A planning agent reviews a stored plan in fresh
 * context and reports; it never edits the plan. The Architect answers each finding and question.
 *
 * Silence must be distinguishable from coverage: `checked` lists what was examined and found
 * sound, and a review that could not finish is `not-run`, never an empty clean result.
 */

export const PLANNING_AGENT_IDS = [
  "comprehension",
  "readiness",
  "grounding",
  "critic",
  "zoom-out",
] as const
export const PlanningAgentId = z.enum(PLANNING_AGENT_IDS)
export type PlanningAgentId = z.infer<typeof PlanningAgentId>

const line = z.string().trim().min(1)

/** blocker: the plan would produce wrong or redone work. */
export const FindingSeverity = z.enum(["blocker", "major", "minor", "nit"])
export type FindingSeverity = z.infer<typeof FindingSeverity>

/** confirmed: traced in the code or the plan text. likely: strong reading, not traced. suspicion: a hunch worth a look. */
export const FindingConfidence = z.enum(["confirmed", "likely", "suspicion"])
export type FindingConfidence = z.infer<typeof FindingConfidence>

export const TARGET_FIELDS = [
  "objective",
  "acceptance",
  "verification",
  "write-scope",
  "dependencies",
  "exclusions",
  "assumption",
  "design-decision",
  "other",
] as const
export const TargetField = z.enum(TARGET_FIELDS)
export type TargetField = z.infer<typeof TargetField>

export const FindingTarget = z.strictObject({
  /** The task title or id, or the plan section heading, exactly as written in the plan. */
  unit: line,
  field: TargetField,
})
export type FindingTarget = z.infer<typeof FindingTarget>

export const PlanningFinding = z
  .strictObject({
    id: line,
    severity: FindingSeverity,
    confidence: FindingConfidence,
    target: FindingTarget,
    /** One or two sentences. */
    what: line,
    /** What a worker would build, or what would break. Concrete. */
    failureScenario: line,
    /** `path:line` in the repository, or a quoted line of the plan. */
    evidence: z.array(line),
    suggestion: line,
  })
  .superRefine((finding, ctx) => {
    if (finding.confidence !== "suspicion" && finding.evidence.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A finding with confidence confirmed or likely needs at least one evidence entry",
      })
  })
export type PlanningFinding = z.infer<typeof PlanningFinding>

/** changes-design: a different architecture. changes-scope: different tasks or files. changes-detail: same shape, different behaviour. */
export const QuestionWeight = z.enum(["changes-design", "changes-scope", "changes-detail"])
export type QuestionWeight = z.infer<typeof QuestionWeight>

export const PlanningQuestion = z
  .strictObject({
    id: line,
    /** One sentence, answerable without reading code. */
    question: line,
    /** What changes in the plan depending on the answer. */
    why: line,
    /** Two to four concrete answers, when they can be named. */
    options: z.array(line).min(2).max(4).optional(),
    relatedFinding: line.optional(),
    weight: QuestionWeight,
  })
  .strict()
export type PlanningQuestion = z.infer<typeof PlanningQuestion>

const base = {
  agent: PlanningAgentId,
  checked: z.array(line),
  findings: z.array(PlanningFinding),
  questions: z.array(PlanningQuestion),
}

export const PlanningResult = z
  .discriminatedUnion("status", [
    z.strictObject({ ...base, status: z.literal("reviewed") }),
    z.strictObject({
      ...base,
      status: z.literal("not-run"),
      /** Why the review did not finish. Partial `checked`, `findings` and `questions` may still be reported. */
      reason: line,
    }),
  ])
  .superRefine((result, ctx) => {
    const findings = new Set(result.findings.map((finding) => finding.id))
    if (findings.size !== result.findings.length)
      ctx.addIssue({ code: "custom", path: ["findings"], message: "Finding ids must be unique" })
    const questions = new Set(result.questions.map((question) => question.id))
    if (questions.size !== result.questions.length)
      ctx.addIssue({ code: "custom", path: ["questions"], message: "Question ids must be unique" })
    result.questions.forEach((question, index) => {
      if (question.relatedFinding && !findings.has(question.relatedFinding))
        ctx.addIssue({
          code: "custom",
          path: ["questions", index, "relatedFinding"],
          message: "relatedFinding must name a finding id in this result",
        })
    })
    if (result.status === "reviewed" && result.checked.length === 0 && result.findings.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["checked"],
        message: "A reviewed result with no findings must list what was checked",
      })
  })
export type PlanningResult = z.infer<typeof PlanningResult>

/** Parse an agent's reply: the JSON object, with or without a fenced block around it. */
export function parsePlanningResult(reply: string): PlanningResult {
  const trimmed = reply.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
  return PlanningResult.parse(JSON.parse(fenced ? fenced[1]! : trimmed))
}

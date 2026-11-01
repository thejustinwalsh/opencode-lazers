import { createHash } from "node:crypto"
import { z } from "zod"
import { TaskProposalSchema } from "../task.ts"
import { reviewProgression, REVIEW_ROUNDS } from "../review/progression.ts"
import type { ReviewDisposition, ReviewProgressionRecord } from "../review/progression.ts"
import { SystemOneRequest, systemOneClient } from "./system-one.ts"
import type { SystemOneInput, SystemOneOutput } from "./system-one.ts"
import { REVIEW_VERSION, reviewChecks, reviewQuestions } from "./review-questions.ts"
import type { ReviewCheck } from "./review-questions.ts"
import { DECISION_REVISION } from "./manifest.ts"

const text = z.string().min(1).max(6_000)
export const TaskReviewInput = z.strictObject({
  task: TaskProposalSchema,
  request: text.describe("The original user request, retained verbatim across this review."),
  evidence: z
    .array(text)
    .max(20)
    .default([])
    .describe(
      "Recorded clarifications, relevant repository facts, and concrete test procedures or sources.",
    ),
  reviewID: z
    .uuid()
    .optional()
    .describe("Omit on the first call; reuse the returned ID for revised drafts."),
})
export type ReviewInput = z.input<typeof TaskReviewInput>
type ReviewState = z.output<typeof TaskReviewInput>
type Transport = Parameters<typeof systemOneClient>[0]
export interface ReviewStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}
export interface Finding extends ReviewCheck {
  probability: number | null
  score: number | null
  disposition: ReviewDisposition
}
interface ReviewResult {
  status: "feedback" | "completed" | "completed_with_concerns" | "unavailable"
  reviewID: string
  version: string
  round: number
  maxRounds: number
  fingerprint: string
  model: { id: "d1-omni-2b"; revision: string }
  answers: SystemOneOutput["answers"]
  findings: Finding[]
  focus: Finding | null
  errors: string[]
  usage: SystemOneOutput["usage"]
  next: { action: "revise_or_clarify" | "retry" | "submit"; tool: string; instruction: string }
}
interface RecordState extends ReviewProgressionRecord<Finding> {
  version: string
  owner: string
  request: string
  busyUntil: number
  history: { state: ReviewState; result: ReviewResult }[]
}
const fingerprint = (state: ReviewState) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        version: REVIEW_VERSION,
        task: state.task,
        request: state.request,
        evidence: state.evidence,
      }),
    )
    .digest("hex")

/** One known tool, up to three changed-state rounds; d1 judges, code owns progression. */
export class TaskReviewer {
  private readonly running = new Set<string>()
  constructor(
    private readonly store: ReviewStore,
    private readonly transport: Transport,
    private readonly now = Date.now,
  ) {}

  async verify(input: unknown, owner: string, signal: AbortSignal) {
    const parsed = TaskReviewInput.safeParse(input)
    if (!parsed.success)
      return {
        status: "invalid",
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
        next: {
          action: "revise",
          tool: "lazers_verify_task",
          instruction:
            "Fix these structural errors and call this tool again. Nothing was submitted.",
        },
      }
    const state = parsed.data
    const id = state.reviewID ?? crypto.randomUUID()
    const key = `task-review.${id}`
    if (this.running.has(id))
      return { status: "busy", reviewID: id, next: "Wait for the current call to finish." }
    this.running.add(id)
    try {
      const saved = (await this.store.get(key)) as RecordState | undefined
      if (state.reviewID && !saved)
        return {
          status: "invalid",
          error: "Unknown review ID. Start a new review only for a new task.",
        }
      if (saved && saved.owner !== owner)
        return {
          status: "invalid",
          error: "This review is unavailable in this project/session/agent.",
        }
      if (saved && saved.version !== REVIEW_VERSION)
        return {
          status: "invalid",
          error:
            "The review checklist changed. Call lazers_verify_task with the same task, original request and evidence, omitting reviewID to start the current checklist.",
        }
      if (saved && saved.request !== state.request)
        return {
          status: "invalid",
          error: "Keep the original request unchanged; add new user answers to evidence.",
        }
      const record: RecordState = saved ?? {
        version: REVIEW_VERSION,
        owner,
        request: state.request,
        round: 0,
        busyUntil: 0,
        focus: null,
        previous: [],
        completed: {},
        history: [],
      }
      if (record.busyUntil > this.now())
        return {
          status: "busy",
          reviewID: id,
          next: "The earlier call is still running; retry after its deadline.",
        }
      const hash = fingerprint(state)
      const last = record.history.at(-1)?.result
      const replay = reviewProgression.inspect(last, hash, (result) =>
        result.status.startsWith("completed")
          ? "terminal"
          : result.status === "feedback"
            ? "feedback"
            : "retryable",
      )
      if (replay.kind === "replay") return replay.result
      if (replay.kind === "stale")
        return {
          status: "stale",
          reviewID: id,
          reviewedFingerprint: replay.result.fingerprint,
          next: {
            action: "verify",
            tool: "lazers_verify_task",
            instruction:
              "This completed review belongs to another draft. Verify the changed task under a new review ID before submission.",
          },
        }
      const checks = reviewChecks(state.task)
      if (checks.length > 64)
        return {
          status: "invalid",
          error:
            "This bounded review supports at most 64 concrete checks. Split the task into smaller coherent increments.",
        }
      if (!reviewProgression.hasRounds(record)) {
        const result: ReviewResult = {
          status: "completed_with_concerns",
          reviewID: id,
          version: REVIEW_VERSION,
          round: record.round,
          maxRounds: REVIEW_ROUNDS,
          fingerprint: hash,
          model: { id: "d1-omni-2b", revision: DECISION_REVISION },
          answers: {},
          findings: reviewProgression.limit(checks).map((check) => ({
            ...check,
            probability: null,
          })),
          focus: null,
          errors: ["The last verification call was interrupted; the round budget is exhausted."],
          usage: { input_tokens: 0, output_tokens: 0 },
          next: {
            action: "submit",
            tool: "lazers_submit_task",
            instruction:
              "Continue under the advisory limit policy and retain the interrupted-review concern. No semantic pass was established.",
          },
        }
        record.busyUntil = 0
        record.history.push({ state, result })
        await this.store.set(key, record)
        return result
      }
      const shared = {
        task: state.task,
        intent: { request: state.request },
        evidence: state.evidence,
      }
      const questions = Object.entries(reviewQuestions(checks))
      const batches: SystemOneInput[] = []
      for (const [name, question] of questions) {
        const batch = batches.at(-1)
        const candidate = {
          model: "d1-omni-2b" as const,
          state: shared,
          questions: { ...(batch?.questions ?? {}), [name]: question },
          timeoutMs: 60_000,
        }
        if (batch && SystemOneRequest.safeParse(candidate).success) batch.questions[name] = question
        else {
          const single = SystemOneRequest.safeParse({
            ...candidate,
            questions: { [name]: question },
          })
          if (!single.success)
            return {
              status: "invalid",
              error:
                "Task/evidence exceeds the local model request limit. Supply a smaller task; no text was truncated.",
            }
          batches.push(single.data)
        }
      }
      if (!reviewProgression.reserveRound(record))
        throw new Error("The review round budget was exhausted before reservation.")
      record.busyUntil = this.now() + 120_000
      await this.store.set(key, record)
      const answers: SystemOneOutput["answers"] = {}
      const usage = { input_tokens: 0, output_tokens: 0 as const }
      const errors: string[] = []
      const deadline = this.now() + 60_000
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      try {
        const client = systemOneClient(this.transport)
        for (const batch of batches) {
          bounded.throwIfAborted()
          const remaining = Math.floor(deadline - this.now())
          if (remaining < 1_000) throw new Error("Task review deadline exceeded")
          const result = await client.systemOne(
            { ...batch, timeoutMs: remaining },
            { signal: bounded },
          )
          Object.assign(answers, result.answers)
          usage.input_tokens += result.usage.input_tokens
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
      const observations = Object.fromEntries(
        checks.map((check) => {
          const answer = answers[check.id]
          const gate = check.appliesWhen ? answers[check.appliesWhen] : undefined
          const probability = answer?.type === "noul" ? answer.noul : null
          const applicable =
            !check.appliesWhen ||
            (gate?.type === "noul" && gate.noul >= reviewProgression.threshold)
          const absent =
            check.appliesWhen &&
            gate?.type === "noul" &&
            gate.noul <= 1 - reviewProgression.threshold
          const score =
            errors.length || probability === null
              ? null
              : !applicable && !absent
                ? 0.5
                : check.goodWhen === "yes"
                  ? probability
                  : 1 - probability
          return [check.id, { score, notApplicable: Boolean(absent) }]
        }),
      )
      const progression = reviewProgression.evaluate(
        checks,
        observations,
        record,
        errors.length > 0,
      )
      const probabilityFor = (id: string) => {
        const answer = answers[id]
        return answer?.type === "noul" ? answer.noul : null
      }
      const findings: Finding[] = progression.findings.map((finding) => ({
        ...finding,
        probability: probabilityFor(finding.id),
      }))
      const focus = findings.find((item) => item.disposition === "pending") ?? null
      const result: ReviewResult = {
        status: progression.status,
        reviewID: id,
        version: REVIEW_VERSION,
        round: record.round,
        maxRounds: REVIEW_ROUNDS,
        fingerprint: hash,
        model: { id: "d1-omni-2b", revision: DECISION_REVISION },
        answers,
        findings,
        focus,
        errors,
        usage,
        next: progression.done
          ? {
              action: "submit",
              tool: "lazers_submit_task",
              instruction:
                "Advisory hardening is complete. Submit the structurally valid task through lazers_submit_task; retain unresolved concerns. This result does not authorize work or certify correctness.",
            }
          : errors.length
            ? {
                action: "retry",
                tool: "lazers_verify_task",
                instruction:
                  "Inference failed, so no semantic pass was established. Retry this review ID within the remaining round budget, or report the limitation.",
              }
            : {
                action: "revise_or_clarify",
                tool: "lazers_verify_task",
                instruction: `Address only the focused concern: ${focus!.guidance} Then call lazers_verify_task with the revised task/evidence and this reviewID. Use the native question tool for a material missing user decision.`,
              },
      }
      record.focus = focus?.id ?? null
      record.previous = findings
      record.completed = progression.completed
      record.history.push({ state, result })
      record.busyUntil = 0
      await this.store.set(key, record)
      return result
    } finally {
      this.running.delete(id)
    }
  }
}

import { createHash } from "node:crypto"
import { z } from "zod"
import { canonical } from "../../identity.ts"
import { reviewProgression, REVIEW_ROUNDS } from "../../review/progression.ts"
import type { ReviewDisposition, ReviewProgressionRecord } from "../../review/progression.ts"
import type { HandoffActor as HandoffActorType, HandoffEvidence, HandoffUsage } from "./schema.ts"
import {
  HandoffActor,
  HandoffEvidence as HandoffEvidenceSchema,
  HandoffReviewOutcome,
  HandoffReviewReservationInput,
  JsonObjectSchema,
} from "./schema.ts"
import { HANDOFF_REVIEW_VERSION, handoffReviewChecks, handoffReviewDefinitions } from "./checks.ts"
import type { HandoffReviewDefinition } from "./checks.ts"
import { HandoffStore, HANDOFF_REVIEW_RESERVATION_LEASE_MS } from "./store.ts"
import { handoffReviewFingerprint as makeFingerprint } from "./review-state.ts"
import type { HandoffReviewContext } from "./store.ts"
import { SystemOneRequest, SystemOneAnswer, systemOneClient } from "../../webgpu/system-one.ts"
import type { SystemOneInput, SystemOneOutput } from "../../webgpu/system-one.ts"
import { DECISION_REVISION } from "../../webgpu/manifest.ts"

const ReviewInput = z.strictObject({
  requestID: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim().length > 0),
  draftVersion: z.int().positive(),
  evidence: z.array(HandoffEvidenceSchema).max(100).default([]),
  reviewID: z.uuid().optional(),
})
export type HandoffReviewInput = z.input<typeof ReviewInput>

const FindingSchema = z.strictObject({
  id: z.string(),
  path: z.string(),
  question: z.string(),
  guidance: z.string(),
  goodWhen: z.literal("yes"),
  probability: z.number().min(0).max(1).nullable(),
  score: z.number().min(0).max(1).nullable(),
  disposition: z.enum(["resolved", "not_applicable", "non_regressed", "limit", "pending"]),
})
export interface HandoffReviewFinding extends HandoffReviewDefinition {
  probability: number | null
  score: number | null
  disposition: ReviewDisposition
}

const UsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheWriteTokens: z.number().int().nonnegative().nullable(),
  costUSD: z.number().finite().nonnegative().nullable(),
})
const SystemOneUsage = z.strictObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.literal(0),
})
const HandoffReviewResultSchema = z.strictObject({
  status: z.enum(["feedback", "completed", "completed_with_concerns", "disabled", "unavailable"]),
  requestID: z.string(),
  reviewID: z.uuid(),
  version: z.string(),
  round: z.int().positive(),
  maxRounds: z.int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.strictObject({ id: z.literal("d1-omni-2b"), revision: z.string() }).optional(),
  answers: z.record(z.string(), SystemOneAnswer),
  findings: z.array(FindingSchema),
  focus: FindingSchema.nullable(),
  errors: z.array(z.string()),
  limitation: z.string().nullable(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  usage: UsageSchema,
  next: z.strictObject({
    action: z.enum(["revise_or_clarify", "retry", "continue"]),
    instruction: z.string(),
  }),
})
export type HandoffReviewResult = z.infer<typeof HandoffReviewResultSchema>

type Transport = Parameters<typeof systemOneClient>[0]
export type HandoffReviewAuthorization = (
  actor: HandoffActorType,
  requestID: string,
  phase: "context" | "reserve" | "inference" | "persist" | "recover",
) => void | Promise<void>

interface ProgressFinding extends HandoffReviewFinding {
  score: number | null
}

interface ProgressRecord extends ReviewProgressionRecord<ProgressFinding> {
  round: number
}

type ReviewResponse =
  | HandoffReviewResult
  | {
      status: "invalid"
      errors: Array<{ path: string; message: string }>
      next: { action: "revise"; instruction: string }
    }
  | {
      status: "stale"
      requestID: string
      reviewID: string
      reviewedFingerprint: string | null
      fingerprint: string
      next: { action: "continue"; instruction: string }
    }
  | { status: "busy"; requestID: string; reviewID: string; next: string }

const INFERENCE_DEADLINE_MS = 60_000

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

function deterministicReviewID(requestID: string, actor: HandoffActorType): string {
  const bytes = createHash("sha256")
    .update(canonical({ requestID, actor, version: HANDOFF_REVIEW_VERSION }))
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function effectiveContract(context: HandoffReviewContext) {
  return JsonObjectSchema.parse({
    taskID: context.request.source.task.id,
    revision: context.request.source.task.revision,
    proposal: context.request.source.task.proposal,
  })
}

function modelState(
  context: HandoffReviewContext,
  contract: ReturnType<typeof effectiveContract>,
  evidence: HandoffEvidence[],
) {
  return {
    sourceContract: contract,
    handoffRequest: context.request.request,
    draft: context.draft.draft,
    evidence,
    interpretationRules: {
      originalUserIntent:
        "Use only a supplied source reference. If the original request is not available, retain status unknown; do not infer it from the worker's interpretation.",
      failureCause:
        "Distinguish observed behavior from its cause. Keep the cause unknown unless supplied evidence establishes it.",
      executionOwnership:
        "The handoff is a worker report, not runtime proof of writer quiescence, background activity, or unresolved native effects.",
    },
  }
}

function questionFor(check: HandoffReviewDefinition) {
  return {
    type: "noul" as const,
    instructions: `${check.question}\n\nApply this fixed criterion: ${check.guidance}`,
    criteria: {
      true: "The source contract, handoff fields, and supplied evidence support the required continuity behavior.",
      false:
        "The behavior is missing, contradicted, unsupported, or stated more confidently than the evidence allows.",
    },
  }
}

function makeBatches(state: ReturnType<typeof modelState>): SystemOneInput[] | undefined {
  const batches: SystemOneInput[] = []
  for (const check of handoffReviewDefinitions) {
    const question = questionFor(check)
    const last = batches.at(-1)
    const candidate = {
      model: "d1-omni-2b" as const,
      state,
      questions: { ...(last?.questions ?? {}), [check.id]: question },
      timeoutMs: INFERENCE_DEADLINE_MS,
    }
    const combined = SystemOneRequest.safeParse(candidate)
    if (last && combined.success) last.questions[check.id] = question
    else {
      const single = SystemOneRequest.safeParse({
        ...candidate,
        questions: { [check.id]: question },
      })
      if (!single.success) return undefined
      batches.push(single.data)
    }
  }
  return batches
}

function priorResult(context: HandoffReviewContext): HandoffReviewResult | undefined {
  const last = context.rounds.at(-1)
  if (!last?.outcome || last.outcome.result === null) return undefined
  const parsed = HandoffReviewResultSchema.safeParse(last.outcome.result)
  return parsed.success ? parsed.data : undefined
}

function progressionRecord(context: HandoffReviewContext): ProgressRecord {
  const record: ProgressRecord = {
    round: context.rounds.length,
    focus: null,
    previous: [],
    completed: {},
  }
  for (const round of context.rounds) {
    const result = round.outcome?.result
      ? HandoffReviewResultSchema.safeParse(round.outcome.result)
      : undefined
    if (!result?.success) continue
    const findings = result.data.findings
    const observed = findings.filter((finding) => finding.score !== null)
    if (observed.length) {
      const byID = new Map(record.previous.map((finding) => [finding.id, finding]))
      for (const finding of observed) byID.set(finding.id, finding)
      record.previous = [...byID.values()]
      for (const finding of observed) {
        if (finding.disposition === "pending") delete record.completed[finding.id]
        else record.completed[finding.id] = finding.disposition
      }
      if (result.data.status !== "unavailable") record.focus = result.data.focus?.id ?? record.focus
    }
  }
  return record
}

function usageFrom(usage: { input_tokens: number; output_tokens: 0 } | undefined): HandoffUsage {
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage ? usage.output_tokens : null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUSD: null,
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 2_000) || "System One review failed without an error message."
}

function concernText(findings: readonly HandoffReviewFinding[]): string[] {
  return findings
    .filter(
      (finding) => finding.disposition !== "resolved" && finding.disposition !== "not_applicable",
    )
    .map((finding) => `${finding.id}: ${finding.guidance}`)
}

/** Durable source-attached review adapter; authorization and code own every transition. */
export class HandoffReviewer {
  private readonly running = new Set<string>()

  constructor(
    private readonly store: HandoffStore,
    private readonly transport: Transport,
    private readonly authorize: HandoffReviewAuthorization,
    private readonly enabled: () => boolean = () => true,
    private readonly now: () => number = Date.now,
  ) {}

  async review(input: unknown, callerInput: unknown, signal: AbortSignal): Promise<ReviewResponse> {
    const parsed = ReviewInput.safeParse(input)
    if (!parsed.success)
      return {
        status: "invalid",
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
        next: {
          action: "revise",
          instruction: "Fix the handoff review input. No semantic round was reserved.",
        },
      }
    const state = parsed.data
    const reviewer = HandoffActor.parse(callerInput)
    const checks = handoffReviewChecks()

    await this.authorize(reviewer, state.requestID, "context")
    const initialContext = this.store.readReviewContext(
      {
        requestID: state.requestID,
        draftVersion: state.draftVersion,
      },
      reviewer,
    )
    const contract = effectiveContract(initialContext)
    const contractVersion = `task-contract-${sha256(canonical(contract))}`
    const evidenceVersion = `evidence-${sha256(canonical(state.evidence))}`
    await this.authorize(reviewer, state.requestID, "context")
    const context = this.store.readReviewContext(
      {
        requestID: state.requestID,
        draftVersion: state.draftVersion,
        ...(state.reviewID ? { reviewID: state.reviewID } : {}),
        effectiveContractVersion: contractVersion,
        effectiveContract: contract,
        checkVersion: HANDOFF_REVIEW_VERSION,
        checks,
      },
      reviewer,
    )
    const id =
      state.reviewID ?? context.reviewID ?? deterministicReviewID(state.requestID, reviewer)
    const fingerprint = makeFingerprint(
      context,
      state.evidence,
      contract,
      contractVersion,
      evidenceVersion,
      checks,
    )
    if (state.reviewID && context.reviewID && state.reviewID !== context.reviewID)
      return this.staleResult(state.requestID, context.reviewID, null, fingerprint)

    const runningKey = `${state.requestID}:${id}`
    if (this.running.has(runningKey))
      return {
        status: "busy",
        requestID: state.requestID,
        reviewID: id,
        next: "The review chain already has an active call. Retry after it finishes.",
      }
    this.running.add(runningKey)
    try {
      const modelInput = modelState(context, contract, state.evidence)
      const batches = makeBatches(modelInput)
      if (!batches)
        return {
          status: "invalid",
          errors: [
            {
              path: "evidence",
              message:
                "The source contract, draft, and evidence exceed the local model request limit. Supply smaller evidence; no text was truncated and no round was reserved.",
            },
          ],
          next: {
            action: "revise",
            instruction: "Reduce the supplied evidence while retaining precise source references.",
          },
        }

      const previous = priorResult(context)
      const latestOutcome = context.rounds.at(-1)?.outcome
      if (latestOutcome && latestOutcome.result !== null && !previous)
        throw new Error(
          "Stored handoff review result is malformed; refusing to infer or overwrite it",
        )
      const replay = reviewProgression.inspect(previous, fingerprint, (result) =>
        result.status === "completed" || result.status === "completed_with_concerns"
          ? "terminal"
          : result.status === "feedback"
            ? "feedback"
            : "retryable",
      )
      if (replay.kind === "replay") return replay.result
      if (replay.kind === "stale")
        return this.staleResult(state.requestID, id, replay.result.fingerprint, fingerprint)
      if (
        !this.enabled() &&
        previous?.status === "disabled" &&
        previous.fingerprint === fingerprint
      )
        return previous

      const latest = context.rounds.at(-1)
      if (latest && !latest.outcome) {
        const sameReservation =
          latest.draftVersion === context.draft.draftVersion &&
          canonical(latest.evidence) === canonical(state.evidence) &&
          latest.evidenceVersion === evidenceVersion &&
          latest.effectiveContractVersion === contractVersion &&
          canonical(latest.effectiveContract) === canonical(contract) &&
          latest.checkVersion === HANDOFF_REVIEW_VERSION &&
          canonical(latest.checks) === canonical(checks)
        if (!sameReservation)
          return {
            status: "stale",
            requestID: state.requestID,
            reviewID: latest.reviewID,
            reviewedFingerprint: null,
            fingerprint,
            next: {
              action: "continue",
              instruction:
                "This review chain has an unfinished reservation for different draft/evidence. Reopen that exact reservation for bounded recovery; this request cannot replace or overwrite it.",
            },
          }
        const age = this.now() - Date.parse(latest.reservedAt)
        if (age < HANDOFF_REVIEW_RESERVATION_LEASE_MS)
          return {
            status: "busy",
            requestID: state.requestID,
            reviewID: latest.reviewID,
            next: "A previously reserved review round is still within its recovery window.",
          }
        await this.authorize(reviewer, state.requestID, "recover")
        await this.authorize(reviewer, state.requestID, "persist")
        const receipt = this.store.recoverReviewOutcome(
          {
            requestID: state.requestID,
            reviewID: latest.reviewID,
            round: latest.round,
          },
          reviewer,
        )
        if (receipt.status === "conflict")
          throw new Error("Interrupted handoff review result conflicted with an immutable outcome")
        const recovered = this.resultFromRecord(receipt.record.outcome?.result)
        if (
          !recovered ||
          recovered.requestID !== state.requestID ||
          recovered.reviewID !== latest.reviewID ||
          recovered.round !== latest.round ||
          recovered.fingerprint !== fingerprint
        )
          throw new Error("Stored interrupted handoff result does not match its reservation")
        return recovered
      }

      const record = progressionRecord(context)
      if (!reviewProgression.hasRounds(record)) {
        const findings = reviewProgression.limit(handoffReviewDefinitions).map((finding) => ({
          ...finding,
          probability: null,
        }))
        return HandoffReviewResultSchema.parse({
          status: "completed_with_concerns",
          requestID: state.requestID,
          reviewID: id,
          version: HANDOFF_REVIEW_VERSION,
          round: record.round,
          maxRounds: REVIEW_ROUNDS,
          fingerprint,
          answers: {},
          findings,
          focus: null,
          errors: [
            "The three reserved review rounds are exhausted; no semantic pass was established.",
          ],
          limitation: "The review round budget is exhausted.",
          elapsedMs: null,
          usage: usageFrom(undefined),
          next: {
            action: "continue",
            instruction:
              "Send the draft and its unresolved concerns to the current Architect. This review does not finalize a report or establish task success.",
          },
        })
      }

      const round = record.round + 1
      await this.authorize(reviewer, state.requestID, "reserve")
      const reservation = HandoffReviewReservationInput.parse({
        requestID: state.requestID,
        reviewID: id,
        round,
        draftVersion: context.draft.draftVersion,
        evidenceVersion,
        evidence: state.evidence,
        effectiveContractVersion: contractVersion,
        effectiveContract: contract,
        checkVersion: HANDOFF_REVIEW_VERSION,
        checks,
      })
      const reserved = this.store.reserveRound(reservation, reviewer)
      if (reserved.status === "conflict") {
        await this.authorize(reviewer, state.requestID, "context")
        const latestContext = this.store.readReviewContext(
          {
            requestID: state.requestID,
            draftVersion: state.draftVersion,
            effectiveContractVersion: contractVersion,
            effectiveContract: contract,
            checkVersion: HANDOFF_REVIEW_VERSION,
            checks,
          },
          reviewer,
        )
        if (latestContext.reviewID && latestContext.reviewID !== id)
          return this.staleResult(state.requestID, latestContext.reviewID, null, fingerprint)
        return {
          status: "busy",
          requestID: state.requestID,
          reviewID: id,
          next: "A concurrent review reserved this chain. Retry after its result is available.",
        }
      }
      if (reserved.status === "replayed") {
        return reserved.record.outcome
          ? (this.resultFromRecord(reserved.record.outcome.result) ?? {
              status: "busy",
              requestID: state.requestID,
              reviewID: id,
              next: "The reserved result is malformed; no new inference was started.",
            })
          : {
              status: "busy",
              requestID: state.requestID,
              reviewID: id,
              next: "This round is already reserved and will not be inferred a second time.",
            }
      }

      if (!this.enabled()) {
        const disabled = this.makeDisabledResult({
          requestID: state.requestID,
          reviewID: id,
          fingerprint,
          round,
        })
        await this.authorize(reviewer, state.requestID, "persist")
        const saved = this.store.recordReviewOutcome(
          {
            requestID: state.requestID,
            reviewID: id,
            round,
            outcome: this.toStoredOutcome(disabled),
          },
          reviewer,
        )
        if (saved.status === "conflict")
          throw new Error("Disabled handoff review conflicted with an immutable outcome")
        return this.resultFromRecord(saved.record.outcome?.result) ?? disabled
      }

      // Reservation and caller authorization are durable gates before any local inference.
      await this.authorize(reviewer, state.requestID, "inference")
      const startedAt = this.now()
      const answers: SystemOneOutput["answers"] = {}
      let usage: SystemOneOutput["usage"] | undefined
      const errors: string[] = []
      const client = systemOneClient({
        systemOne: async (request, options) => {
          const raw = await this.transport.systemOne(request, options)
          if (typeof raw === "object" && raw !== null && !("error" in raw)) {
            const measured = SystemOneUsage.safeParse(raw.usage)
            if (measured.success)
              usage = {
                input_tokens: (usage?.input_tokens ?? 0) + measured.data.input_tokens,
                output_tokens: 0,
              }
          }
          return raw
        },
      })
      const deadline = startedAt + INFERENCE_DEADLINE_MS
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(INFERENCE_DEADLINE_MS)])
      for (const batch of batches) {
        await this.authorize(reviewer, state.requestID, "inference")
        try {
          boundedSignal.throwIfAborted()
          const remaining = Math.floor(deadline - this.now())
          if (remaining < 1_000) throw new Error("Handoff review deadline exceeded")
          const response = await client.systemOne(
            { ...batch, timeoutMs: remaining },
            { signal: boundedSignal },
          )
          boundedSignal.throwIfAborted()
          Object.assign(answers, response.answers)
        } catch (error) {
          errors.push(boundedError(error))
          break
        }
      }
      const elapsedMs = Math.max(0, Math.floor(this.now() - startedAt))
      const result = this.evaluate({
        context,
        reviewID: id,
        fingerprint,
        record: { ...record, round },
        answers,
        errors,
        usage,
        elapsedMs,
      })
      await this.authorize(reviewer, state.requestID, "persist")
      const saved = this.store.recordReviewOutcome(
        {
          requestID: state.requestID,
          reviewID: id,
          round,
          outcome: this.toStoredOutcome(result),
        },
        reviewer,
      )
      if (saved.status === "conflict") {
        await this.authorize(reviewer, state.requestID, "context")
        const recorded = this.store.readReviewContext(
          {
            requestID: state.requestID,
            draftVersion: state.draftVersion,
            reviewID: id,
            effectiveContractVersion: contractVersion,
            effectiveContract: contract,
            checkVersion: HANDOFF_REVIEW_VERSION,
            checks,
          },
          reviewer,
        )
        const reservedRound = recorded.rounds.find(
          (entry) => entry.reviewID === id && entry.round === round,
        )
        const outcome = this.resultFromRecord(reservedRound?.outcome?.result)
        if (
          outcome?.requestID === state.requestID &&
          outcome.reviewID === id &&
          outcome.round === round &&
          outcome.fingerprint === fingerprint
        )
          return outcome
        return {
          status: "busy",
          requestID: state.requestID,
          reviewID: id,
          next: "A concurrent immutable result was recorded; retry to read this exact reservation.",
        }
      }
      return this.resultFromRecord(saved.record.outcome?.result) ?? result
    } finally {
      this.running.delete(runningKey)
    }
  }

  private evaluate(input: {
    context: HandoffReviewContext
    reviewID: string
    fingerprint: string
    record: ProgressRecord
    answers: SystemOneOutput["answers"]
    errors: string[]
    usage: SystemOneOutput["usage"] | undefined
    elapsedMs: number
  }): HandoffReviewResult {
    const probabilityFor = (id: string): number | null => {
      const answer = input.answers[id]
      return answer?.type === "noul" ? answer.noul : null
    }
    const observations = Object.fromEntries(
      handoffReviewDefinitions.map((check) => {
        const probability = probabilityFor(check.id)
        return [
          check.id,
          {
            score:
              probability === null
                ? null
                : check.goodWhen === "yes"
                  ? probability
                  : 1 - probability,
          },
        ]
      }),
    )
    const evaluated = reviewProgression.evaluate(
      handoffReviewDefinitions,
      observations,
      input.record,
      input.errors.length > 0,
    )
    const findings: HandoffReviewFinding[] = evaluated.findings.map((finding) => ({
      ...finding,
      probability: probabilityFor(finding.id),
    }))
    const focus = findings.find((finding) => finding.disposition === "pending") ?? null
    const status = evaluated.status
    const limitation = input.errors.length ? input.errors.join("; ") : null
    const result = HandoffReviewResultSchema.parse({
      status,
      requestID: input.context.request.requestID,
      reviewID: input.reviewID,
      version: HANDOFF_REVIEW_VERSION,
      round: input.record.round,
      maxRounds: REVIEW_ROUNDS,
      fingerprint: input.fingerprint,
      model: { id: "d1-omni-2b", revision: DECISION_REVISION },
      answers: input.answers,
      findings,
      focus,
      errors: input.errors,
      limitation,
      elapsedMs: input.elapsedMs,
      usage: usageFrom(input.usage),
      next: evaluated.done
        ? {
            action: "continue",
            instruction:
              "Return the reviewed draft and any retained concerns to the current Architect. This is advisory review only; it does not finalize a report or establish task success.",
          }
        : input.errors.length
          ? {
              action: "retry",
              instruction:
                "Inference did not establish all findings. Retry this review chain within its remaining reservations; no semantic pass was established.",
            }
          : {
              action: "revise_or_clarify",
              instruction: `Address only this focused concern: ${focus!.guidance}`,
            },
    })
    return result
  }

  private makeUnavailableResult(input: {
    context: HandoffReviewContext
    reviewID: string
    fingerprint: string
    record: ProgressRecord
    answers: SystemOneOutput["answers"]
    errors: string[]
    usage: SystemOneOutput["usage"] | undefined
    elapsedMs: number | null
    limitation: string
    modelUsed: boolean
  }): HandoffReviewResult {
    const result = this.evaluate({
      ...input,
      errors: input.errors,
      elapsedMs: input.elapsedMs ?? 0,
    })
    const output = { ...result }
    if (!input.modelUsed) delete output.model
    return HandoffReviewResultSchema.parse({
      ...output,
      status: result.status === "completed_with_concerns" ? result.status : "unavailable",
      limitation: input.limitation,
      elapsedMs: input.elapsedMs,
      next: {
        action: result.status === "completed_with_concerns" ? "continue" : "retry",
        instruction:
          result.status === "completed_with_concerns"
            ? "The review budget is exhausted with unresolved concerns. Return the handoff to the current Architect; no semantic pass was established."
            : "The reserved round did not produce a result. Retry this review chain only within its remaining round budget.",
      },
    })
  }

  private makeDisabledResult(input: {
    requestID: string
    reviewID: string
    fingerprint: string
    round: number
  }): HandoffReviewResult {
    const exhausted = input.round >= REVIEW_ROUNDS
    const findings: HandoffReviewFinding[] = handoffReviewDefinitions.map((check) => ({
      ...check,
      probability: null,
      score: null,
      disposition: exhausted ? "limit" : "pending",
    }))
    return HandoffReviewResultSchema.parse({
      status: exhausted ? "completed_with_concerns" : "disabled",
      requestID: input.requestID,
      reviewID: input.reviewID,
      version: HANDOFF_REVIEW_VERSION,
      round: input.round,
      maxRounds: REVIEW_ROUNDS,
      fingerprint: input.fingerprint,
      answers: {},
      findings,
      focus: null,
      errors: [],
      limitation: "Local handoff review is disabled; no semantic findings were established.",
      elapsedMs: null,
      usage: usageFrom(undefined),
      next: exhausted
        ? {
            action: "continue",
            instruction:
              "The review budget is exhausted without semantic findings. Return the draft to the current Architect with this limitation; do not treat it as reviewed or successful.",
          }
        : {
            action: "retry",
            instruction:
              "Local review is disabled. Continue ordinary recovery with this explicit limitation, or retry this review chain if local review is enabled.",
          },
    })
  }

  private toStoredOutcome(result: HandoffReviewResult) {
    const outcomeStatus = result.limitation
      ? result.errors.length
        ? "unavailable"
        : "disabled"
      : result.status
    const limitation =
      outcomeStatus === "disabled" || outcomeStatus === "unavailable"
        ? (result.limitation ??
          (outcomeStatus === "disabled" ? "Local review is disabled." : "Review was unavailable."))
        : null
    return HandoffReviewOutcome.parse({
      status: outcomeStatus,
      result,
      concerns:
        result.status === "disabled"
          ? ["Local review is disabled; no semantic findings were established."]
          : concernText(result.findings),
      errors: result.errors,
      limitation,
      elapsedMs: result.elapsedMs,
      usage: result.usage,
    })
  }

  private resultFromRecord(value: unknown): HandoffReviewResult | undefined {
    const parsed = HandoffReviewResultSchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }

  private staleResult(
    requestID: string,
    reviewID: string,
    reviewedFingerprint: string | null,
    fingerprint: string,
  ): ReviewResponse {
    return {
      status: "stale",
      requestID,
      reviewID,
      reviewedFingerprint,
      fingerprint,
      next: {
        action: "continue",
        instruction:
          "Reuse the existing reviewID for this source handoff. A different review ID cannot reset its round budget or inherit its result.",
      },
    }
  }
}

import { createHash } from "node:crypto"
import { canonical } from "../../identity.ts"
import { REVIEW_ROUNDS } from "../../review/progression.ts"
import { HANDOFF_REVIEW_VERSION } from "./checks.ts"
import { HandoffReviewOutcome, JsonObjectSchema } from "./schema.ts"
import type {
  HandoffEvidence,
  HandoffReviewCheck,
  HandoffReviewRoundRecord,
  JsonObject,
} from "./schema.ts"
import type { HandoffReviewContext } from "./store.ts"

export function handoffReviewFingerprint(
  context: HandoffReviewContext,
  evidence: HandoffEvidence[],
  contract: JsonObject,
  contractVersion: string,
  evidenceVersion: string,
  checks: HandoffReviewCheck[],
  checkVersion = HANDOFF_REVIEW_VERSION,
): string {
  const attachment = context.request.source.attachment
  return createHash("sha256")
    .update(
      canonical({
        version: checkVersion,
        requestID: context.request.requestID,
        request: context.request.request,
        source: {
          projectDirectory: attachment.projectDirectory,
          planID: attachment.planID,
          taskID: attachment.taskID,
          specRevision: attachment.specRevision,
          attemptID: attachment.attemptID,
          sourceSessionID: attachment.sourceSessionID,
          requestGeneration: attachment.requestGeneration,
        },
        draftVersion: context.draft.draftVersion,
        draft: context.draft.draft,
        evidenceVersion,
        evidence,
        contractVersion,
        contract,
        checkVersion,
        checks,
      }),
    )
    .digest("hex")
}

/** Interruption records are derived from durable inputs; they contain no model observations. */
export function interruptedHandoffReviewOutcome(
  context: HandoffReviewContext,
  reservation: HandoffReviewRoundRecord,
) {
  const exhausted = context.rounds.length >= REVIEW_ROUNDS
  const findings = reservation.checks.map((check) => ({
    ...JsonObjectSchema.parse(check.definition),
    id: check.id,
    probability: null,
    score: null,
    disposition: exhausted ? "limit" : "pending",
  }))
  const errors = ["The reserved review round was interrupted before a result was recorded."]
  const limitation =
    "The prior inference did not produce a durable result; its reservation remains consumed."
  const usage = {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUSD: null,
  }
  const result = {
    status: exhausted ? "completed_with_concerns" : "unavailable",
    requestID: reservation.requestID,
    reviewID: reservation.reviewID,
    version: reservation.checkVersion,
    round: reservation.round,
    maxRounds: REVIEW_ROUNDS,
    fingerprint: handoffReviewFingerprint(
      context,
      reservation.evidence,
      reservation.effectiveContract,
      reservation.effectiveContractVersion,
      reservation.evidenceVersion,
      reservation.checks,
      reservation.checkVersion,
    ),
    answers: {},
    findings,
    focus: exhausted ? null : (findings[0] ?? null),
    errors,
    limitation,
    elapsedMs: null,
    usage,
    next: {
      action: exhausted ? "continue" : "retry",
      instruction: exhausted
        ? "The review budget is exhausted with unresolved concerns. Return the handoff to the current Architect; no semantic pass was established."
        : "The reserved round did not produce a result. Retry this review chain only within its remaining round budget.",
    },
  }
  return HandoffReviewOutcome.parse({
    status: "unavailable",
    result,
    concerns: findings.map((check) => `${check.id}: no semantic observation was established.`),
    errors,
    limitation,
    elapsedMs: null,
    usage,
  })
}

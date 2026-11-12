import { fingerprint } from "../identity.ts"
import { z } from "zod"

export const VerificationPhase = z.enum(["task", "combined"])
export type VerificationPhase = z.infer<typeof VerificationPhase>

export const VerificationTimeoutAmendmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  amendmentID: z.uuid(),
  policyRevision: z.int().positive(),
  requestID: z.string().min(1).max(200),
  projectID: z.string().min(1).max(200),
  projectDirectory: z.string().min(1),
  planID: z.uuid(),
  planRevision: z.int().positive(),
  planVersion: z.int().positive(),
  owner: z.string().min(1),
  ownerEpoch: z.int().min(0),
  phase: VerificationPhase,
  taskID: z.uuid().nullable(),
  taskRevision: z.int().positive().nullable(),
  attemptID: z.uuid().nullable(),
  artifact: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  checkID: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  commandFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  authoredTimeoutMs: z.int().positive(),
  previousTimeoutMs: z.int().positive(),
  effectiveTimeoutMs: z.int().positive(),
  reason: z.string().min(1).max(2000),
  createdAt: z.int().min(0),
})
export type VerificationTimeoutAmendment = z.infer<typeof VerificationTimeoutAmendmentSchema>

export type VerificationTimeoutTarget = {
  projectID: string
  projectDirectory: string
  planID: string
  planRevision: number
  phase: VerificationPhase
  taskID: string | null
  taskRevision: number | null
  attemptID: string | null
  artifact: string
  checkID: string
  command: string
  authoredTimeoutMs: number
}

export type VerificationDeadline = {
  authoredTimeoutMs: number
  effectiveTimeoutMs: number
  amendmentID: string | null
  policyRevision: number
}

export function verificationCommandFingerprint(command: string): string {
  return fingerprint(command)
}

function sameTarget(amendment: VerificationTimeoutAmendment, target: VerificationTimeoutTarget) {
  return (
    amendment.projectID === target.projectID &&
    amendment.projectDirectory === target.projectDirectory &&
    amendment.planID === target.planID &&
    amendment.planRevision === target.planRevision &&
    amendment.phase === target.phase &&
    amendment.taskID === target.taskID &&
    amendment.taskRevision === target.taskRevision &&
    amendment.attemptID === target.attemptID &&
    amendment.artifact === target.artifact &&
    amendment.checkID === target.checkID &&
    amendment.commandFingerprint === verificationCommandFingerprint(target.command) &&
    amendment.authoredTimeoutMs === target.authoredTimeoutMs
  )
}

/** Resolve only a complete, monotonically extended policy chain for this exact check. */
export function verificationDeadline(
  amendments: readonly VerificationTimeoutAmendment[],
  target: VerificationTimeoutTarget,
): VerificationDeadline {
  const matching = amendments
    .filter((amendment) => sameTarget(amendment, target))
    .toSorted((left, right) => left.policyRevision - right.policyRevision)
  let previousTimeoutMs = target.authoredTimeoutMs
  for (let index = 0; index < matching.length; index++) {
    const amendment = matching[index]!
    if (
      amendment.policyRevision !== index + 1 ||
      amendment.previousTimeoutMs !== previousTimeoutMs ||
      amendment.effectiveTimeoutMs <= previousTimeoutMs
    )
      throw new Error("Verification deadline amendment history is inconsistent")
    previousTimeoutMs = amendment.effectiveTimeoutMs
  }
  const latest = matching.at(-1)
  return {
    authoredTimeoutMs: target.authoredTimeoutMs,
    effectiveTimeoutMs: latest?.effectiveTimeoutMs ?? target.authoredTimeoutMs,
    amendmentID: latest?.amendmentID ?? null,
    policyRevision: latest?.policyRevision ?? 0,
  }
}

export function effectiveVerificationCheck<T extends { timeoutMs: number }>(
  check: T,
  deadline: VerificationDeadline,
): T {
  return deadline.effectiveTimeoutMs === check.timeoutMs
    ? check
    : { ...check, timeoutMs: deadline.effectiveTimeoutMs }
}

export function verificationReceiptDeadline(deadline: VerificationDeadline) {
  return {
    authoredTimeoutMs: deadline.authoredTimeoutMs,
    effectiveTimeoutMs: deadline.effectiveTimeoutMs,
    amendmentID: deadline.amendmentID,
    policyRevision: deadline.policyRevision,
  }
}

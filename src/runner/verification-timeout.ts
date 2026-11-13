import { fingerprint } from "../identity.ts"
import { z } from "zod"

export const DEFAULT_VERIFICATION_INACTIVITY_TIMEOUT_MS = 15 * 60_000
export const DEFAULT_VERIFICATION_HARD_TIMEOUT_MS = 60 * 60_000
export const VERIFICATION_TIMING_POLICY_VERSION = 2

export const VerificationTimeoutDefaultsSchema = z.strictObject({
  inactivityTimeoutMs: z.int().positive().optional(),
  hardTimeoutMs: z.int().positive().optional(),
})
export type VerificationTimeoutDefaults = {
  inactivityTimeoutMs: number
  hardTimeoutMs: number
}

export function verificationTimeoutDefaults(value?: unknown): VerificationTimeoutDefaults {
  const overrides = VerificationTimeoutDefaultsSchema.parse(value ?? {})
  const defaults = {
    inactivityTimeoutMs:
      overrides.inactivityTimeoutMs ?? DEFAULT_VERIFICATION_INACTIVITY_TIMEOUT_MS,
    hardTimeoutMs: overrides.hardTimeoutMs ?? DEFAULT_VERIFICATION_HARD_TIMEOUT_MS,
  }
  if (defaults.inactivityTimeoutMs > defaults.hardTimeoutMs)
    throw new Error("Verification inactivity default cannot exceed its hard timeout default")
  return defaults
}

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
  authoredTimeoutMs: z.int().positive().nullable(),
  timingPolicyVersion: z.literal(VERIFICATION_TIMING_POLICY_VERSION).optional(),
  authoredInactivityTimeoutMs: z.int().positive().nullable().optional(),
  authoredHardTimeoutMs: z.int().positive().nullable().optional(),
  defaultInactivityTimeoutMs: z.int().positive().optional(),
  defaultHardTimeoutMs: z.int().positive().optional(),
  previousTimeoutMs: z.int().positive(),
  effectiveTimeoutMs: z.int().positive(),
  previousInactivityTimeoutMs: z.int().positive().optional(),
  effectiveInactivityTimeoutMs: z.int().positive().optional(),
  previousHardTimeoutMs: z.int().positive().optional(),
  effectiveHardTimeoutMs: z.int().positive().optional(),
  retainedVerificationID: z.uuid().optional(),
  retainedGeneration: z.int().positive().optional(),
  retainedTaskID: z.uuid().optional(),
  retainedTaskRevision: z.int().positive().optional(),
  retainedAttemptID: z.uuid().optional(),
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
  authoredTimeoutMs: number | null
  authoredInactivityTimeoutMs: number | null
  authoredHardTimeoutMs: number | null
  defaultInactivityTimeoutMs: number
  defaultHardTimeoutMs: number
  retainedVerificationID?: string
  retainedGeneration?: number
  retainedTaskID?: string
  retainedTaskRevision?: number
  retainedAttemptID?: string
}

export type VerificationDeadline = {
  authoredTimeoutMs: number | null
  authoredInactivityTimeoutMs: number | null
  authoredHardTimeoutMs: number | null
  defaultInactivityTimeoutMs: number
  defaultHardTimeoutMs: number
  effectiveInactivityTimeoutMs: number
  effectiveHardTimeoutMs: number
  /** Compatibility alias for the historical single wall-clock timeout. */
  effectiveTimeoutMs: number
  amendmentID: string | null
  policyRevision: number
  inactivityProvenance: "project-default" | "per-check" | "amendment"
  hardTimeoutProvenance: "project-default" | "per-check" | "amendment"
  historicalAmendmentIDs: string[]
}

export function verificationCommandFingerprint(command: string): string {
  return fingerprint(command)
}

function sameTargetIdentity(
  amendment: VerificationTimeoutAmendment,
  target: VerificationTimeoutTarget,
) {
  const matchesRetainedTarget =
    target.retainedVerificationID === undefined
      ? amendment.retainedVerificationID === undefined &&
        amendment.retainedGeneration === undefined &&
        amendment.retainedTaskID === undefined &&
        amendment.retainedTaskRevision === undefined &&
        amendment.retainedAttemptID === undefined
      : amendment.retainedVerificationID === undefined ||
        (amendment.retainedVerificationID === target.retainedVerificationID &&
          amendment.retainedGeneration === target.retainedGeneration &&
          amendment.retainedTaskID === target.retainedTaskID &&
          amendment.retainedTaskRevision === target.retainedTaskRevision &&
          amendment.retainedAttemptID === target.retainedAttemptID)
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
    amendment.authoredTimeoutMs === target.authoredTimeoutMs &&
    (amendment.authoredInactivityTimeoutMs ?? null) === target.authoredInactivityTimeoutMs &&
    (amendment.authoredHardTimeoutMs ?? null) === target.authoredHardTimeoutMs &&
    matchesRetainedTarget
  )
}

/** Resolve only a complete, monotonically extended policy chain for this exact check. */
export function verificationDeadline(
  amendments: readonly VerificationTimeoutAmendment[],
  target: VerificationTimeoutTarget,
): VerificationDeadline {
  const matching = amendments
    .filter(
      (amendment) =>
        amendment.timingPolicyVersion === VERIFICATION_TIMING_POLICY_VERSION &&
        amendment.defaultInactivityTimeoutMs === target.defaultInactivityTimeoutMs &&
        amendment.defaultHardTimeoutMs === target.defaultHardTimeoutMs &&
        sameTargetIdentity(amendment, target),
    )
    .toSorted((left, right) => left.policyRevision - right.policyRevision)
  let previousInactivityTimeoutMs =
    target.authoredInactivityTimeoutMs ?? target.defaultInactivityTimeoutMs
  let previousHardTimeoutMs = target.authoredHardTimeoutMs ?? target.defaultHardTimeoutMs
  if (previousInactivityTimeoutMs > previousHardTimeoutMs)
    throw new Error("Verification inactivity allowance cannot exceed its hard backstop")
  for (let index = 0; index < matching.length; index++) {
    const amendment = matching[index]!
    if (
      amendment.policyRevision !== index + 1 ||
      amendment.previousInactivityTimeoutMs !== previousInactivityTimeoutMs ||
      amendment.previousHardTimeoutMs !== previousHardTimeoutMs ||
      (amendment.effectiveInactivityTimeoutMs ?? 0) < previousInactivityTimeoutMs ||
      (amendment.effectiveHardTimeoutMs ?? 0) < previousHardTimeoutMs ||
      (amendment.effectiveInactivityTimeoutMs ?? previousInactivityTimeoutMs) >
        (amendment.effectiveHardTimeoutMs ?? previousHardTimeoutMs) ||
      ((amendment.effectiveInactivityTimeoutMs ?? previousInactivityTimeoutMs) ===
        previousInactivityTimeoutMs &&
        (amendment.effectiveHardTimeoutMs ?? previousHardTimeoutMs) === previousHardTimeoutMs)
    )
      throw new Error("Verification deadline amendment history is inconsistent")
    previousInactivityTimeoutMs =
      amendment.effectiveInactivityTimeoutMs ?? previousInactivityTimeoutMs
    previousHardTimeoutMs = amendment.effectiveHardTimeoutMs ?? previousHardTimeoutMs
  }
  const latest = matching.at(-1)
  let amendedInactivity = false
  let amendedHardTimeout = false
  let priorInactivity = target.authoredInactivityTimeoutMs ?? target.defaultInactivityTimeoutMs
  let priorHardTimeout = target.authoredHardTimeoutMs ?? target.defaultHardTimeoutMs
  for (const amendment of matching) {
    const nextInactivity = amendment.effectiveInactivityTimeoutMs ?? priorInactivity
    const nextHardTimeout = amendment.effectiveHardTimeoutMs ?? priorHardTimeout
    amendedInactivity ||= nextInactivity !== priorInactivity
    amendedHardTimeout ||= nextHardTimeout !== priorHardTimeout
    priorInactivity = nextInactivity
    priorHardTimeout = nextHardTimeout
  }
  const historicalAmendmentIDs = amendments
    .filter(
      (amendment) =>
        amendment.timingPolicyVersion === undefined && sameTargetIdentity(amendment, target),
    )
    .map((amendment) => amendment.amendmentID)
  return {
    authoredTimeoutMs: target.authoredTimeoutMs,
    authoredInactivityTimeoutMs: target.authoredInactivityTimeoutMs,
    authoredHardTimeoutMs: target.authoredHardTimeoutMs,
    defaultInactivityTimeoutMs: target.defaultInactivityTimeoutMs,
    defaultHardTimeoutMs: target.defaultHardTimeoutMs,
    effectiveInactivityTimeoutMs: previousInactivityTimeoutMs,
    effectiveHardTimeoutMs: previousHardTimeoutMs,
    effectiveTimeoutMs: previousHardTimeoutMs,
    amendmentID: latest?.amendmentID ?? null,
    policyRevision: latest?.policyRevision ?? 0,
    inactivityProvenance: amendedInactivity
      ? "amendment"
      : target.authoredInactivityTimeoutMs === null
        ? "project-default"
        : "per-check",
    hardTimeoutProvenance: amendedHardTimeout
      ? "amendment"
      : target.authoredHardTimeoutMs === null
        ? "project-default"
        : "per-check",
    historicalAmendmentIDs,
  }
}

export function effectiveVerificationCheck<T extends { timeoutMs?: number }>(
  check: T,
  deadline: VerificationDeadline,
): T {
  return check.timeoutMs === deadline.effectiveHardTimeoutMs &&
    (check as T & { inactivityTimeoutMs?: number }).inactivityTimeoutMs ===
      deadline.effectiveInactivityTimeoutMs &&
    (check as T & { hardTimeoutMs?: number }).hardTimeoutMs === deadline.effectiveHardTimeoutMs
    ? check
    : {
        ...check,
        timeoutMs: deadline.effectiveHardTimeoutMs,
        inactivityTimeoutMs: deadline.effectiveInactivityTimeoutMs,
        hardTimeoutMs: deadline.effectiveHardTimeoutMs,
      }
}

export function verificationCheckWithDefaults<
  T extends {
    id: string
    command: string
    timeoutMs?: number
    inactivityTimeoutMs?: number
    hardTimeoutMs?: number
  },
>(
  check: T,
  defaults: VerificationTimeoutDefaults,
): T & { timeoutMs: number; inactivityTimeoutMs: number; hardTimeoutMs: number } {
  const inactivityTimeoutMs = check.inactivityTimeoutMs ?? defaults.inactivityTimeoutMs
  const hardTimeoutMs = check.hardTimeoutMs ?? defaults.hardTimeoutMs
  if (inactivityTimeoutMs > hardTimeoutMs)
    throw new Error("Verification inactivity allowance cannot exceed its hard backstop")
  return {
    ...check,
    timeoutMs: hardTimeoutMs,
    inactivityTimeoutMs,
    hardTimeoutMs,
  } as T & { timeoutMs: number; inactivityTimeoutMs: number; hardTimeoutMs: number }
}

export function verificationReceiptDeadline(deadline: VerificationDeadline) {
  return {
    authoredTimeoutMs: deadline.authoredTimeoutMs,
    authoredInactivityTimeoutMs: deadline.authoredInactivityTimeoutMs,
    authoredHardTimeoutMs: deadline.authoredHardTimeoutMs,
    defaultInactivityTimeoutMs: deadline.defaultInactivityTimeoutMs,
    defaultHardTimeoutMs: deadline.defaultHardTimeoutMs,
    effectiveInactivityTimeoutMs: deadline.effectiveInactivityTimeoutMs,
    effectiveHardTimeoutMs: deadline.effectiveHardTimeoutMs,
    effectiveTimeoutMs: deadline.effectiveTimeoutMs,
    amendmentID: deadline.amendmentID,
    policyRevision: deadline.policyRevision,
    timingPolicyVersion: VERIFICATION_TIMING_POLICY_VERSION,
    inactivityProvenance: deadline.inactivityProvenance,
    hardTimeoutProvenance: deadline.hardTimeoutProvenance,
    historicalAmendmentIDs: deadline.historicalAmendmentIDs,
  }
}

export type VerificationDeadlineReceipt = ReturnType<typeof verificationReceiptDeadline>

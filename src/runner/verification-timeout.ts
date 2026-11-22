import { fingerprint } from "../identity.ts"
import { z } from "zod"

export const VERIFICATION_TIMING_POLICY_VERSION = 2

const VerificationTimeoutDefaultsSchema = z.strictObject({
  inactivityTimeoutMs: z.int().positive().optional(),
  hardTimeoutMs: z.int().positive().optional(),
})
/**
 * A project's own deadlines for checks that author none. Absent means none: a check runs until it
 * exits or is cancelled. The runtime invents no deadline of its own.
 */
export type VerificationTimeoutDefaults = {
  inactivityTimeoutMs?: number
  hardTimeoutMs?: number
}

export function verificationTimeoutDefaults(value?: unknown): VerificationTimeoutDefaults {
  const overrides = VerificationTimeoutDefaultsSchema.parse(value ?? {})
  const defaults: VerificationTimeoutDefaults = {
    ...(overrides.inactivityTimeoutMs === undefined
      ? {}
      : { inactivityTimeoutMs: overrides.inactivityTimeoutMs }),
    ...(overrides.hardTimeoutMs === undefined ? {} : { hardTimeoutMs: overrides.hardTimeoutMs }),
  }
  if (exceeds(defaults.inactivityTimeoutMs, defaults.hardTimeoutMs))
    throw new Error("Verification inactivity default cannot exceed its hard timeout default")
  return defaults
}

/** True only when both deadlines exist and the inactivity one is longer. */
function exceeds(inactivity: number | null | undefined, hard: number | null | undefined) {
  return inactivity != null && hard != null && inactivity > hard
}

export type VerificationTimingCheck = {
  id: string
  inactivityTimeoutMs?: number
  hardTimeoutMs?: number
}

export function invalidVerificationTimings(
  checks: readonly VerificationTimingCheck[],
  defaults: VerificationTimeoutDefaults,
): Array<{ index: number; checkID: string }> {
  return checks.flatMap((check, index) =>
    exceeds(
      check.inactivityTimeoutMs ?? defaults.inactivityTimeoutMs,
      check.hardTimeoutMs ?? defaults.hardTimeoutMs,
    )
      ? [{ index, checkID: check.id }]
      : [],
  )
}

const VerificationPhase = z.enum(["task", "combined"])
type VerificationPhase = z.infer<typeof VerificationPhase>

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
  /** Retired: older receipts carry it; it no longer binds anything. */
  ownerEpoch: z.int().min(0).optional(),
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
  defaultInactivityTimeoutMs: number | null
  defaultHardTimeoutMs: number | null
}

export type VerificationDeadline = {
  authoredTimeoutMs: number | null
  authoredInactivityTimeoutMs: number | null
  authoredHardTimeoutMs: number | null
  defaultInactivityTimeoutMs: number | null
  defaultHardTimeoutMs: number | null
  /** Null: no deadline; the check runs until it exits or is cancelled. */
  effectiveInactivityTimeoutMs: number | null
  effectiveHardTimeoutMs: number | null
  /** Compatibility alias for the historical single wall-clock timeout. */
  effectiveTimeoutMs: number | null
  amendmentID: string | null
  policyRevision: number
  inactivityProvenance: "project-default" | "per-check" | "amendment"
  hardTimeoutProvenance: "project-default" | "per-check" | "amendment"
  historicalAmendmentIDs: string[]
}

function verificationCommandFingerprint(command: string): string {
  return fingerprint(command)
}

function sameTargetIdentity(
  amendment: VerificationTimeoutAmendment,
  target: VerificationTimeoutTarget,
) {
  // Amendments recorded for a retained operation applied to that operation only; none applies now.
  const matchesRetainedTarget =
    amendment.retainedVerificationID === undefined &&
    amendment.retainedGeneration === undefined &&
    amendment.retainedTaskID === undefined &&
    amendment.retainedTaskRevision === undefined &&
    amendment.retainedAttemptID === undefined
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

/**
 * Resolve only a complete, monotonically extended policy chain for this exact check. A recorded
 * amendment extends a deadline that existed; where none exists (no authored and no project
 * deadline) there is nothing to extend and the check has no deadline.
 */
export function verificationDeadline(
  amendments: readonly VerificationTimeoutAmendment[],
  target: VerificationTimeoutTarget,
): VerificationDeadline {
  const initialInactivity = target.authoredInactivityTimeoutMs ?? target.defaultInactivityTimeoutMs
  const initialHard = target.authoredHardTimeoutMs ?? target.defaultHardTimeoutMs
  if (exceeds(initialInactivity, initialHard))
    throw new Error("Verification inactivity allowance cannot exceed its hard backstop")
  const matching =
    initialInactivity === null || initialHard === null
      ? []
      : amendments
          .filter(
            (amendment) =>
              amendment.timingPolicyVersion === VERIFICATION_TIMING_POLICY_VERSION &&
              amendment.defaultInactivityTimeoutMs === target.defaultInactivityTimeoutMs &&
              amendment.defaultHardTimeoutMs === target.defaultHardTimeoutMs &&
              sameTargetIdentity(amendment, target),
          )
          .toSorted((left, right) => left.policyRevision - right.policyRevision)
  let previousInactivityTimeoutMs = initialInactivity
  let previousHardTimeoutMs = initialHard
  let amendedInactivity = false
  let amendedHardTimeout = false
  for (let index = 0; index < matching.length; index++) {
    const amendment = matching[index]!
    const priorInactivity = previousInactivityTimeoutMs ?? 0
    const priorHard = previousHardTimeoutMs ?? 0
    const nextInactivity = amendment.effectiveInactivityTimeoutMs ?? priorInactivity
    const nextHard = amendment.effectiveHardTimeoutMs ?? priorHard
    if (
      amendment.policyRevision !== index + 1 ||
      amendment.previousInactivityTimeoutMs !== priorInactivity ||
      amendment.previousHardTimeoutMs !== priorHard ||
      (amendment.effectiveInactivityTimeoutMs ?? 0) < priorInactivity ||
      (amendment.effectiveHardTimeoutMs ?? 0) < priorHard ||
      nextInactivity > nextHard ||
      (nextInactivity === priorInactivity && nextHard === priorHard)
    )
      throw new Error("Verification deadline amendment history is inconsistent")
    amendedInactivity ||= nextInactivity !== priorInactivity
    amendedHardTimeout ||= nextHard !== priorHard
    previousInactivityTimeoutMs = nextInactivity
    previousHardTimeoutMs = nextHard
  }
  const latest = matching.at(-1)
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

type TimedCheck = { timeoutMs?: number; inactivityTimeoutMs?: number; hardTimeoutMs?: number }

/** The check with exactly the given deadlines; a null deadline leaves its field out. */
function withDeadlines<T extends TimedCheck>(
  check: T,
  inactivity: number | null | undefined,
  hard: number | null | undefined,
): T {
  const {
    timeoutMs: _timeout,
    inactivityTimeoutMs: _inactivity,
    hardTimeoutMs: _hard,
    ...rest
  } = check
  return {
    ...rest,
    ...(hard == null ? {} : { timeoutMs: hard, hardTimeoutMs: hard }),
    ...(inactivity == null ? {} : { inactivityTimeoutMs: inactivity }),
  } as T
}

export function effectiveVerificationCheck<T extends TimedCheck>(
  check: T,
  deadline: VerificationDeadline,
): T {
  const hard = deadline.effectiveHardTimeoutMs ?? undefined
  const inactivity = deadline.effectiveInactivityTimeoutMs ?? undefined
  return check.timeoutMs === hard &&
    check.inactivityTimeoutMs === inactivity &&
    check.hardTimeoutMs === hard
    ? check
    : withDeadlines(check, inactivity, hard)
}

export function verificationCheckWithDefaults<
  T extends { id: string; command: string } & TimedCheck,
>(check: T, defaults: VerificationTimeoutDefaults): T {
  const inactivityTimeoutMs = check.inactivityTimeoutMs ?? defaults.inactivityTimeoutMs
  const hardTimeoutMs = check.hardTimeoutMs ?? defaults.hardTimeoutMs
  if (exceeds(inactivityTimeoutMs, hardTimeoutMs))
    throw new Error("Verification inactivity allowance cannot exceed its hard backstop")
  return withDeadlines(check, inactivityTimeoutMs, hardTimeoutMs)
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

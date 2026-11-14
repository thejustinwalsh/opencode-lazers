import { expect, test } from "bun:test"
import { fingerprint } from "../identity.ts"
import {
  DEFAULT_VERIFICATION_HARD_TIMEOUT_MS,
  DEFAULT_VERIFICATION_INACTIVITY_TIMEOUT_MS,
  VERIFICATION_TIMING_POLICY_VERSION,
  VerificationTimeoutAmendmentSchema,
  verificationCheckWithDefaults,
  verificationDeadline,
  verificationTimeoutDefaults,
} from "./verification-timeout.ts"
import type { VerificationTimeoutTarget } from "./verification-timeout.ts"

function target(overrides: Partial<VerificationTimeoutTarget> = {}): VerificationTimeoutTarget {
  return {
    projectID: "project",
    projectDirectory: "/project",
    planID: "11111111-1111-4111-8111-111111111111",
    planRevision: 1,
    phase: "task",
    taskID: "22222222-2222-4222-8222-222222222222",
    taskRevision: 1,
    attemptID: "33333333-3333-4333-8333-333333333333",
    artifact: "a".repeat(40),
    checkID: "verify",
    command: "bun test",
    authoredTimeoutMs: 20_000,
    authoredInactivityTimeoutMs: null,
    authoredHardTimeoutMs: null,
    defaultInactivityTimeoutMs: DEFAULT_VERIFICATION_INACTIVITY_TIMEOUT_MS,
    defaultHardTimeoutMs: DEFAULT_VERIFICATION_HARD_TIMEOUT_MS,
    ...overrides,
  }
}

function amendment(
  identity: VerificationTimeoutTarget,
  overrides: Partial<ReturnType<typeof VerificationTimeoutAmendmentSchema.parse>> = {},
) {
  return VerificationTimeoutAmendmentSchema.parse({
    schemaVersion: 1,
    amendmentID: "44444444-4444-4444-8444-444444444444",
    policyRevision: 1,
    requestID: "extend",
    projectID: identity.projectID,
    projectDirectory: identity.projectDirectory,
    planID: identity.planID,
    planRevision: identity.planRevision,
    planVersion: 2,
    owner: "architect",
    ownerEpoch: 0,
    phase: identity.phase,
    taskID: identity.taskID,
    taskRevision: identity.taskRevision,
    attemptID: identity.attemptID,
    artifact: identity.artifact,
    checkID: identity.checkID,
    commandFingerprint: fingerprint(identity.command),
    authoredTimeoutMs: identity.authoredTimeoutMs,
    timingPolicyVersion: VERIFICATION_TIMING_POLICY_VERSION,
    authoredInactivityTimeoutMs: identity.authoredInactivityTimeoutMs,
    authoredHardTimeoutMs: identity.authoredHardTimeoutMs,
    defaultInactivityTimeoutMs: identity.defaultInactivityTimeoutMs,
    defaultHardTimeoutMs: identity.defaultHardTimeoutMs,
    previousTimeoutMs: DEFAULT_VERIFICATION_HARD_TIMEOUT_MS,
    effectiveTimeoutMs: 90 * 60_000,
    previousInactivityTimeoutMs: DEFAULT_VERIFICATION_INACTIVITY_TIMEOUT_MS,
    effectiveInactivityTimeoutMs: DEFAULT_VERIFICATION_INACTIVITY_TIMEOUT_MS,
    previousHardTimeoutMs: DEFAULT_VERIFICATION_HARD_TIMEOUT_MS,
    effectiveHardTimeoutMs: 90 * 60_000,
    reason: "Continue this exact settled check",
    createdAt: 1,
    ...(identity.retainedVerificationID === undefined
      ? {}
      : {
          retainedVerificationID: identity.retainedVerificationID,
          retainedGeneration: identity.retainedGeneration,
          retainedTaskID: identity.retainedTaskID,
          retainedTaskRevision: identity.retainedTaskRevision,
          retainedAttemptID: identity.retainedAttemptID,
        }),
    ...overrides,
  })
}

test("project verification defaults are generous, validated and applied instead of legacy wall limits", () => {
  expect(verificationTimeoutDefaults()).toEqual({
    inactivityTimeoutMs: 15 * 60_000,
    hardTimeoutMs: 60 * 60_000,
  })
  expect(
    verificationTimeoutDefaults({ inactivityTimeoutMs: 5_000, hardTimeoutMs: 10_000 }),
  ).toEqual({ inactivityTimeoutMs: 5_000, hardTimeoutMs: 10_000 })
  expect(() =>
    verificationTimeoutDefaults({ inactivityTimeoutMs: 10_001, hardTimeoutMs: 10_000 }),
  ).toThrow("cannot exceed")
  expect(() => verificationTimeoutDefaults({ hardTimeoutMs: 0 })).toThrow()

  expect(
    verificationCheckWithDefaults(
      { id: "legacy", command: "true", timeoutMs: 25 },
      verificationTimeoutDefaults(),
    ),
  ).toMatchObject({
    timeoutMs: 60 * 60_000,
    inactivityTimeoutMs: 15 * 60_000,
    hardTimeoutMs: 60 * 60_000,
  })
  expect(
    verificationCheckWithDefaults(
      { id: "override", command: "true", inactivityTimeoutMs: 2_000, hardTimeoutMs: 3_000 },
      verificationTimeoutDefaults(),
    ),
  ).toMatchObject({ inactivityTimeoutMs: 2_000, hardTimeoutMs: 3_000 })
  expect(() =>
    verificationCheckWithDefaults(
      { id: "invalid", command: "true", inactivityTimeoutMs: 4_000, hardTimeoutMs: 3_000 },
      verificationTimeoutDefaults(),
    ),
  ).toThrow("cannot exceed")
})

test("legacy amendments remain historical while versioned timing amendments resolve both limits", () => {
  const identity = target()
  const legacy = VerificationTimeoutAmendmentSchema.parse({
    schemaVersion: 1,
    amendmentID: "55555555-5555-4555-8555-555555555555",
    policyRevision: 1,
    requestID: "legacy-extension",
    projectID: identity.projectID,
    projectDirectory: identity.projectDirectory,
    planID: identity.planID,
    planRevision: identity.planRevision,
    planVersion: 2,
    owner: "architect",
    ownerEpoch: 0,
    phase: identity.phase,
    taskID: identity.taskID,
    taskRevision: identity.taskRevision,
    attemptID: identity.attemptID,
    artifact: identity.artifact,
    checkID: identity.checkID,
    commandFingerprint: fingerprint(identity.command),
    authoredTimeoutMs: identity.authoredTimeoutMs,
    previousTimeoutMs: 20_000,
    effectiveTimeoutMs: 40_000,
    reason: "Old single-limit amendment",
    createdAt: 1,
  })
  const initial = verificationDeadline([legacy], identity)
  expect(initial).toMatchObject({
    effectiveInactivityTimeoutMs: 15 * 60_000,
    effectiveHardTimeoutMs: 60 * 60_000,
    historicalAmendmentIDs: [legacy.amendmentID],
    amendmentID: null,
  })

  const current = amendment(identity)
  const resolved = verificationDeadline([legacy, current], identity)
  expect(resolved).toMatchObject({
    authoredTimeoutMs: 20_000,
    effectiveInactivityTimeoutMs: 15 * 60_000,
    effectiveHardTimeoutMs: 90 * 60_000,
    amendmentID: current.amendmentID,
    policyRevision: 1,
    inactivityProvenance: "project-default",
    hardTimeoutProvenance: "amendment",
    historicalAmendmentIDs: [legacy.amendmentID],
  })
})

test("a prior exact candidate deadline extension carries into isolated retained checks", () => {
  const ordinaryTarget = target({
    authoredTimeoutMs: 1_000,
    authoredInactivityTimeoutMs: 1_000,
    authoredHardTimeoutMs: 1_000,
  })
  const ordinaryAmendment = amendment(ordinaryTarget, {
    previousTimeoutMs: 1_000,
    effectiveTimeoutMs: 3_000,
    previousInactivityTimeoutMs: 1_000,
    effectiveInactivityTimeoutMs: 3_000,
    previousHardTimeoutMs: 1_000,
    effectiveHardTimeoutMs: 3_000,
  })
  const retainedTarget = target({
    ...ordinaryTarget,
    retainedVerificationID: "66666666-6666-4666-8666-666666666666",
    retainedGeneration: 1,
    retainedTaskID: ordinaryTarget.taskID!,
    retainedTaskRevision: ordinaryTarget.taskRevision!,
    retainedAttemptID: ordinaryTarget.attemptID!,
  })
  const retainedAmendment = amendment(retainedTarget, {
    amendmentID: "77777777-7777-4777-8777-777777777777",
    policyRevision: 2,
    previousTimeoutMs: 3_000,
    effectiveTimeoutMs: 5_000,
    previousInactivityTimeoutMs: 3_000,
    effectiveInactivityTimeoutMs: 4_000,
    previousHardTimeoutMs: 3_000,
    effectiveHardTimeoutMs: 5_000,
  })

  expect(
    verificationDeadline([ordinaryAmendment, retainedAmendment], retainedTarget),
  ).toMatchObject({
    effectiveInactivityTimeoutMs: 4_000,
    effectiveHardTimeoutMs: 5_000,
    amendmentID: retainedAmendment.amendmentID,
    policyRevision: 2,
    inactivityProvenance: "amendment",
    hardTimeoutProvenance: "amendment",
  })
  expect(
    verificationDeadline(
      [ordinaryAmendment, retainedAmendment],
      target({
        ...retainedTarget,
        retainedVerificationID: "88888888-8888-4888-8888-888888888888",
        retainedGeneration: 2,
      }),
    ),
  ).toMatchObject({
    effectiveInactivityTimeoutMs: 3_000,
    effectiveHardTimeoutMs: 3_000,
    amendmentID: ordinaryAmendment.amendmentID,
    policyRevision: 1,
  })
})

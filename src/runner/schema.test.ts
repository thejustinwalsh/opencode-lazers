import { expect, test } from "bun:test"
import { ArchitectContinuityInput, CommandInput, PlanInput } from "./schema.ts"
import { SourceMessagesInspectPlanSchema } from "./inspection.ts"

function planInput() {
  const taskID = crypto.randomUUID()
  return {
    requestID: "plan-title-schema",
    objective: "Run the requested work and verify the result",
    baseCommit: "a".repeat(40),
    nodes: [{ taskID, revision: 1 as const }],
    dependencies: [],
    integrationOrder: [taskID],
    verification: [{ id: "check", command: "true", timeoutMs: 1_000 }],
    acceptance: [
      {
        id: "done",
        assertion: "The graph check passes",
        evidence: [{ kind: "verification" as const, verificationID: "check" }],
      },
    ],
  }
}

test("PlanInput accepts and preserves an optional authored title verbatim", () => {
  const title = "  Release-ready graph — phase 1  "
  const parsed = PlanInput.parse({ ...planInput(), title })

  expect(parsed.title).toBe(title)
  expect(parsed.objective).toBe("Run the requested work and verify the result")
  expect(PlanInput.safeParse({ ...planInput(), title: "x".repeat(121) }).success).toBe(false)
})

test("PlanInput keeps the title absent for untitled and legacy plan bodies", () => {
  const legacyBody = planInput()
  const parsed = PlanInput.parse(legacyBody)

  expect(parsed).not.toHaveProperty("title")
  expect(JSON.parse(JSON.stringify(parsed))).not.toHaveProperty("title")
  expect(parsed.objective).toBe(legacyBody.objective)
})

test("combined verification authoring omits the historical single limit", () => {
  const plan = planInput()
  expect(
    PlanInput.safeParse({ ...plan, verification: [{ id: "check", command: "true" }] }).success,
  ).toBe(true)
})

test("startup settlement command requires exact task, attempt and decision", () => {
  const base = {
    requestID: "settle-startup-test",
    planID: crypto.randomUUID(),
    action: "settle-startup" as const,
    reason: "Native failure and absence were reviewed.",
    taskID: crypto.randomUUID(),
    attemptID: crypto.randomUUID(),
  }
  expect(CommandInput.parse(base)).toEqual(base)
  for (const field of ["taskID", "attemptID", "reason"] as const) {
    const invalid = { ...base }
    delete invalid[field]
    expect(CommandInput.safeParse(invalid).success).toBe(false)
  }
})

test("resume exposes only the exact task and attempt bindings for retained-repair recovery", () => {
  const command = {
    requestID: "resume-retained-repair-after-fence-failure",
    planID: crypto.randomUUID(),
    action: "resume" as const,
    taskID: crypto.randomUUID(),
    attemptID: crypto.randomUUID(),
    reason: "Recover the original interrupted retained repair after its runtime fence failure.",
  }
  expect(CommandInput.parse(command)).toEqual(command)
  expect(CommandInput.safeParse({ ...command, nativeInputID: "msg_caller_chosen" }).success).toBe(
    false,
  )
  expect(CommandInput.safeParse({ ...command, attemptID: undefined }).success).toBe(true)
  expect(CommandInput.shape.action.description).toContain("unprompted repair-fence failure")
})

test("plan-level resume requires a reason and excludes task or candidate controls", () => {
  const command = {
    requestID: "resume-interrupted-combined-check",
    planID: crypto.randomUUID(),
    action: "resume" as const,
    reason: "Continue the exact accepted artifacts after the settled interruption.",
  }
  expect(CommandInput.parse(command)).toEqual(command)
  expect(CommandInput.safeParse({ ...command, reason: undefined }).success).toBe(false)
  expect(CommandInput.safeParse({ ...command, attemptID: crypto.randomUUID() }).success).toBe(false)
  expect(CommandInput.safeParse({ ...command, workspaceMode: "shared" }).success).toBe(false)
  expect(CommandInput.safeParse({ ...command, baseCommit: "a".repeat(40) }).success).toBe(false)
  expect(CommandInput.shape.action.description).toContain("Without taskID")
})

test("Architect continuity preserves exact authored decisions and bounds the handoff", () => {
  const continuity = {
    decisions: [" Keep the accepted direction. "],
    unresolvedQuestions: ["Confirm rollout."],
  }
  expect(ArchitectContinuityInput.parse(continuity)).toEqual(continuity)
  expect(
    ArchitectContinuityInput.safeParse({ decisions: ["  "], unresolvedQuestions: [] }).success,
  ).toBe(false)
  expect(
    ArchitectContinuityInput.safeParse({ decisions: ["x".repeat(1001)], unresolvedQuestions: [] })
      .success,
  ).toBe(false)
  expect(
    ArchitectContinuityInput.safeParse({
      decisions: Array.from({ length: 10 }, () => "x".repeat(1000)),
      unresolvedQuestions: Array.from({ length: 10 }, () => "y".repeat(1000)),
    }).success,
  ).toBe(false)
})

test("CommandInput scopes exact review-input aliases to owner reconciliation", () => {
  const command = {
    requestID: "review-input-reconcile",
    planID: crypto.randomUUID(),
    action: "reconcile" as const,
    taskID: crypto.randomUUID(),
    attemptID: crypto.randomUUID(),
    reviewInputID: "msg_received_review_steer",
  }
  expect(CommandInput.parse(command)).toEqual(command)
  expect(
    CommandInput.safeParse({
      ...command,
      action: "quarantine-source",
      reason: "Release only source",
    }).success,
  ).toBe(false)
  expect(CommandInput.safeParse({ ...command, action: "resume" }).success).toBe(false)
  expect(CommandInput.safeParse({ ...command, attemptID: undefined }).success).toBe(false)
  expect(
    CommandInput.safeParse({ ...command, reviewInputID: undefined, extra: true }).success,
  ).toBe(false)
})

test("selected source-message inspection is bounded, unique and strict", () => {
  const input = {
    planID: crypto.randomUUID(),
    view: "source-messages" as const,
    sourceSessionID: "ses_architect_predecessor",
    messageIDs: ["msg_original_input", "msg_assistant_result"],
  }
  expect(SourceMessagesInspectPlanSchema.parse(input)).toEqual(input)
  expect(
    SourceMessagesInspectPlanSchema.safeParse({ ...input, messageIDs: ["same", "same"] }).success,
  ).toBe(false)
  expect(
    SourceMessagesInspectPlanSchema.safeParse({
      ...input,
      messageIDs: Array.from({ length: 11 }, (_, index) => `msg_${index}`),
    }).success,
  ).toBe(false)
  expect(SourceMessagesInspectPlanSchema.safeParse({ ...input, extra: true }).success).toBe(false)
})

test("retained repair commands bind the exact task attempt artifact and concrete defect", () => {
  const command = {
    requestID: "repair-accepted-candidate",
    planID: crypto.randomUUID(),
    action: "retained-repair" as const,
    taskID: crypto.randomUUID(),
    attemptID: crypto.randomUUID(),
    artifact: "a".repeat(40),
    reason: "The accepted parser candidate mishandles escaped delimiters.",
  }
  expect(CommandInput.parse(command)).toEqual(command)
  expect(CommandInput.safeParse({ ...command, artifact: "short" }).success).toBe(false)
  expect(CommandInput.safeParse({ ...command, reason: "  " }).success).toBe(false)
  expect(CommandInput.safeParse({ ...command, attemptID: undefined }).success).toBe(false)
})

test("retained verification requests bind current revisions, not a plan version", () => {
  expect(CommandInput.shape.action.description).not.toContain("quarantine")
  const command = {
    requestID: "verify-exact-retained-candidate",
    planID: crypto.randomUUID(),
    action: "verify-retained" as const,
    projectID: "project-id",
    planRevision: 2,
    taskID: crypto.randomUUID(),
    taskRevision: 1,
    attemptID: crypto.randomUUID(),
    artifact: "a".repeat(40),
    reason: "Verify the exact current candidate without replaying its worker",
  }
  expect(CommandInput.parse(command)).toEqual(command)
  for (const field of [
    "projectID",
    "planRevision",
    "taskID",
    "taskRevision",
    "attemptID",
    "artifact",
  ] as const) {
    const invalid = { ...command }
    delete invalid[field]
    expect(CommandInput.safeParse(invalid).success).toBe(false)
  }
})

test("the retained extend, continue and cancel commands and their fields are gone", () => {
  const base = {
    requestID: "retired-retained-command",
    planID: crypto.randomUUID(),
  }
  for (const action of [
    "extend-verification-deadline",
    "continue-retained-check",
    "cancel-retained-verification",
  ])
    expect(CommandInput.safeParse({ ...base, action }).success).toBe(false)
  for (const field of [
    "retainedVerificationID",
    "retainedGeneration",
    "verificationPhase",
    "checkID",
    "timeoutMs",
    "inactivityTimeoutMs",
    "hardTimeoutMs",
  ])
    expect(
      CommandInput.safeParse({ ...base, action: "audit", [field]: "x" }).success,
      `${field} must not be accepted`,
    ).toBe(false)
  expect(CommandInput.shape.action.description).not.toContain("extend-verification-deadline")
  expect(CommandInput.shape.action.description).not.toContain("continue-retained-check")
  expect(CommandInput.shape.action.description).not.toContain("cancel-retained-verification")
})

import { expect, test } from "bun:test"
import { ArchitectContinuityInput, CommandInput, PlanInput } from "./schema.ts"

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

test("startup settlement command requires exact task, attempt and decision", () => {
  const base = {
    requestID: "settle-startup-test",
    planID: crypto.randomUUID(),
    expectedVersion: 2,
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

import { expect, test } from "bun:test"
import { PlanInput } from "./schema.ts"

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

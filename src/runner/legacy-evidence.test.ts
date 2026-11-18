import { expect, test } from "bun:test"
import { PlanInput, PlanSubmissionInput } from "./schema.ts"

// Shape of a stored plan body from before the human-evidence gate was retired.
const legacyBody = {
  requestID: "legacy",
  objective: "Plan stored with retired human evidence",
  baseCommit: "b".repeat(40),
  workspaceMode: "isolated",
  nodes: [{ taskID: "11111111-1111-4111-8111-111111111111", revision: 1 }],
  dependencies: [],
  integrationOrder: ["11111111-1111-4111-8111-111111111111"],
  verification: [{ id: "combined", command: "true", timeoutMs: 1000 }],
  acceptance: [
    {
      id: "native-visual",
      assertion: "Reviewed in the native app",
      evidence: [
        { kind: "verification", verificationID: "combined" },
        { kind: "human", decision: "Review the native visual result" },
      ],
    },
    {
      id: "human-only",
      assertion: "Judged by review",
      evidence: [{ kind: "human", decision: "Approve" }],
    },
  ],
  dispositions: [],
}

test("a stored plan body with retired human evidence parses and drops it", () => {
  const plan = PlanInput.parse(legacyBody)
  expect(plan.acceptance[0]!.evidence).toEqual([
    { kind: "verification", verificationID: "combined" },
  ])
  expect(plan.acceptance[1]!.evidence).toEqual([])
  expect(PlanInput.safeParse(legacyBody).success).toBe(true)
})

test("new plan submissions cannot create human evidence", () => {
  expect(PlanSubmissionInput.safeParse(legacyBody).success).toBe(false)
})

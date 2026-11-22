import { expect, test } from "bun:test"

test("agent tools never offer all projects: their schemas have no such field and the reads refuse it", async () => {
  const { AgentGetInput, AgentQueryInput } = await import("../tasks/contract.ts")
  expect(AgentQueryInput.safeParse({ allProjects: true, sessionID: "ses-x" }).success).toBe(false)
  expect(
    AgentGetInput.safeParse({ allProjects: true, sessionID: "ses-x", taskID: crypto.randomUUID() })
      .success,
  ).toBe(false)
  expect(AgentQueryInput.safeParse({ limit: 5 }).success).toBe(true)
})

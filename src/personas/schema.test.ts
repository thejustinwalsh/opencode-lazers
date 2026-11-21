import { expect, test } from "bun:test"
import { TaskProposalSchema } from "../task.ts"
import { PlanInput, WorkerPersona as PlanWorkerPersona } from "../runner/schema.ts"
import { TaskPersonaSchema } from "./schema.ts"
import { validProposal } from "../../test/proposal.ts"

test("task and plan schemas share the strict persona enum without an import cycle", () => {
  const personas = ["ui", "systems", "small-refactoring"] as const
  expect(PlanWorkerPersona).toBe(TaskPersonaSchema)
  expect([...TaskPersonaSchema.options]).toEqual([...personas])

  const taskID = crypto.randomUUID()
  for (const persona of personas) {
    expect(TaskProposalSchema.parse({ ...validProposal(), persona }).persona).toBe(persona)
    const plan = PlanInput.parse({
      requestID: `persona-${persona}`,
      objective: "Use an explicit plan persona.",
      baseCommit: "a".repeat(40),
      nodes: [{ taskID, revision: 1, persona }],
      dependencies: [],
      integrationOrder: [taskID],
      verification: validProposal().verification,
      acceptance: validProposal().acceptance,
    })
    expect(plan.nodes[0]?.persona).toBe(persona)
  }
})

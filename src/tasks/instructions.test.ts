import { expect, test } from "bun:test"
import { validProposal } from "../../test/proposal.ts"
import { GetOutput } from "./contract.ts"
import { taskInstructions } from "./instructions.ts"

const detail = GetOutput.parse({
  status: "found",
  task: {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    status: "submitted",
    createdAt: "2026-10-31T12:00:00.000Z",
    provenance: {
      projectID: "project",
      projectDirectory: "/repo",
      workspaceDirectory: "/repo",
      sessionID: "owner",
      startingRevision: { kind: "git", commit: "0".repeat(40) },
    },
    proposal: {
      ...validProposal(),
      guidance: "Reuse the existing task read boundary; keep advice advisory.",
    },
  },
})

test("task instructions preserve goal, acceptance, boundaries, guidance, verification, and sources", () => {
  const instructions = taskInstructions(detail)

  expect(instructions).toStartWith(`# Task ${detail.status === "found" ? detail.task.id : ""}`)
  expect(instructions).toContain("Keep submitted tasks after the plugin restarts")
  expect(instructions).toContain("## Done when\n- reopen: A task can be retrieved")
  expect(instructions).toContain("Evidence: tests")
  expect(instructions).toContain("## Write scope\n- src/**\n- README.md")
  expect(instructions).toContain("## Exclusions\n- Do not dispatch workers")
  expect(instructions).toContain("## Constraints\n- Use plugin-owned SQLite storage")
  expect(instructions).toContain("## Implementation guidance (advisory)")
  expect(instructions).toContain("keep advice advisory")
  expect(instructions).toContain("## Verification\n- tests: bun test")
  expect(instructions).toContain("## Context references\n- README.md")
  expect(instructions.indexOf("## Done when")).toBeLessThan(instructions.indexOf("## Constraints"))
  expect(instructions).not.toContain('"proposal"')
})

test("task instructions retain readable missing-task and unavailable-revision outcomes", () => {
  expect(taskInstructions({ status: "not_found" })).toBe("Task not_found.")
  expect(taskInstructions({ status: "revision_unavailable", revision: 1 })).toBe(
    "Task revision_unavailable.",
  )
})

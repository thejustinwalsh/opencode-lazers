import { expect, test } from "bun:test"
import { outcomeText } from "./outcome.ts"

test("notifications carry a concise action and identity, not full check logs", () => {
  for (const status of ["task-accepted", "accepted", "blocked", "cleanup-blocked", "cancelled"]) {
    const text = outcomeText(
      JSON.stringify({
        status,
        planID: "plan",
        taskID: "task",
        artifact: "commit",
        evidence: [{ id: "all", stdout: "PRIVATE_FULL_CHECK_LOG", stderr: "PRIVATE_ERROR_LOG" }],
      }),
    )
    expect(text).toStartWith("LAZERS outcome\n")
    expect(text).not.toContain("PRIVATE_")
    expect(JSON.parse(text.split("\n").at(-1)!)).toEqual({
      status,
      planID: "plan",
      taskID: "task",
      artifact: "commit",
      evidence: ["all"],
    })
    expect(text.split("\n")[1]).not.toContain("no automatic action")
  }
  expect(outcomeText('{"status":"task-accepted","taskID":"task"}')).toContain("retained-repair")
  expect(outcomeText('{"status":"integrated"}')).toContain("no automatic action")
})

test("unresolved blockers request human input when a decision is needed", () => {
  for (const status of ["queue-review", "blocked", "retained-verification-held"]) {
    const text = outcomeText(JSON.stringify({ status, planID: "plan" }))
    expect(text).toContain("use the native question tool to state the blocker and next action")
    expect(text).toContain("ask for the human input needed")
  }
  const cleanup = outcomeText(JSON.stringify({ status: "cleanup-blocked", planID: "plan" }))
  expect(cleanup).toContain("Use the native question tool when a decision requires human input")
  expect(cleanup).toContain("recover-cleanup or integrated at the current plan version")
})

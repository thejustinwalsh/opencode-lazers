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
  for (const status of ["queue-review", "blocked", "retained-verification-failed"]) {
    const text = outcomeText(JSON.stringify({ status, planID: "plan" }))
    expect(text).toContain("use the native question tool to state the blocker and next action")
    expect(text).toContain("ask for the human input needed")
  }
  const cleanup = outcomeText(JSON.stringify({ status: "cleanup-blocked", planID: "plan" }))
  expect(cleanup).toContain("Use the native question tool when a decision requires human input")
  expect(cleanup).toContain("retries on its own when the observed facts change")
  expect(cleanup).not.toContain("recover-cleanup")
})

test("an accepted plan lists its Fallow findings with the tasks to send them back to", () => {
  const finding = (file: string, ids: object) => ({
    check: "duplication",
    file,
    line: 4,
    subject: "40 lines",
    ...ids,
  })
  const text = outcomeText(
    JSON.stringify({
      status: "accepted",
      artifact: "commit",
      evidence: [],
      fallow: {
        introduced: [finding("a.ts", { taskIDs: ["t1", "t2"] }), finding("b.ts", { taskID: "t3" })],
        concerns: [{ check: "cycle", file: "c.ts", line: 1, subject: "2 files" }],
      },
    }),
  )
  expect(text).toContain("Fallow findings on the combined plan (3):")
  expect(text).toContain("- duplication a.ts:4 40 lines (tasks t1, t2)")
  expect(text).toContain("- duplication b.ts:4 40 lines (task t3)")
  expect(text).toContain("- cycle c.ts:1 2 files\n")
  expect(outcomeText('{"status":"accepted","artifact":"x"}')).not.toContain("Fallow")
})

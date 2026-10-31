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
  expect(outcomeText('{"status":"integrated"}')).toContain("no automatic action")
})

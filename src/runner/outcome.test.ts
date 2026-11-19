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
  const finding = (file: string, ids: object, extra: object = {}) => ({
    id: `duplication:code-duplication:${file}`,
    rule: "code-duplication",
    class: "duplication",
    severity: "warn",
    attribution: "introduced",
    file,
    line: 4,
    message: "40 lines repeat x.ts:1-40",
    ...extra,
    ...ids,
  })
  const text = outcomeText(
    JSON.stringify({
      status: "accepted",
      artifact: "commit",
      evidence: [],
      fallow: {
        package: {
          verdict: "warn",
          base: "base",
          config: { source: "repo", classesNotChecked: [] },
          thresholds: { cyclomatic: 20, cognitive: 15 },
          findings: [
            finding("a.ts", { taskIDs: ["t1", "t2"] }),
            finding("b.ts", { taskID: "t3" }),
            finding("c.ts", {}, { rule: "circular-dependency", class: "architecture" }),
          ],
          summary: { errors: 0, warnings: 3, inherited: 0 },
          timings: { elapsedMs: 5 },
        },
      },
    }),
  )
  expect(text).toContain("Fallow audit of the combined plan, verdict warn (3 findings):")
  expect(text).toContain("- warn code-duplication a.ts:4 40 lines repeat x.ts:1-40 (tasks t1, t2)")
  expect(text).toContain("- warn code-duplication b.ts:4 40 lines repeat x.ts:1-40 (task t3)")
  expect(text).toContain("- warn circular-dependency c.ts:4")
  expect(outcomeText('{"status":"accepted","artifact":"x"}')).not.toContain("Fallow")
})

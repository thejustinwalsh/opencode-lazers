import { expect, test } from "bun:test"
import { firstAttemptID, makeFixture, taskID } from "../../test/trajectory/fixture.ts"
import { activeAssignmentsQuery, LIVE_LIMITS, LiveReadStore } from "./live-store.ts"

test("active assignment lookup uses the project partial index regardless of retained attempts", () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    fixture.store.atomic((db) => {
      const insert = db.query(
        `INSERT INTO runner_attempts(
          id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'failed',?)`,
      )
      for (let index = 0; index < 2_000; index++)
        insert.run(
          `historical-attempt-${index}`,
          fixture.receipt.planID,
          taskID,
          index + 10,
          `historical-session-${index}`,
          `historical-message-${index}`,
          fixture.directory,
          "base",
          "{}",
          index,
        )

      const plan = db
        .query<{ detail: string }, (string | number)[]>(
          `EXPLAIN QUERY PLAN ${activeAssignmentsQuery(false)}`,
        )
        .all(8192, 8192, 4096, 4096, fixture.directory, fixture.directory, LIVE_LIMITS.sessions + 1)
        .map((row) => row.detail)
      expect(plan.join("\n")).toContain("runner_attempts_active_project")
      expect(plan.some((detail) => /SCAN a\b/.test(detail))).toBe(false)
      expect(plan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false)
    })

    const source = new LiveReadStore(
      fixture.repository.path,
      fixture.directory,
      "project",
      new Uint8Array(32).fill(8),
    ).readCurrent(null, new AbortController().signal)
    expect(source.assignments.has("ses-failed")).toBe(true)
    expect(
      [...source.assignments.keys()].some((sessionID) => sessionID.startsWith("historical-")),
    ).toBe(false)
    expect(source.sourceRowsRead).toBeLessThanOrEqual(LIVE_LIMITS.sourceRows)
  } finally {
    fixture.close()
  }
})

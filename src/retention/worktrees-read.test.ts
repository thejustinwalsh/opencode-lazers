import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { meterDatabase } from "../runner/read-meter.fixture.ts"
import { removalBlocker, type WorktreeFinding } from "./worktrees.ts"

/** Read-meter test for the worktree removal check (design/data-handling.md, principles 1 and 8). */

/** `READ_SWEEP_NUMBERS=1 bun test ...` prints the before and after counts the report quotes. */
const show = (name: string, before: unknown, after: unknown) => {
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(
      `[read-sweep] ${name} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    )
}

test("a worktree removal check reads the attempts of its path, not every attempt ever recorded", async () => {
  const db = new Database(":memory:")
  db.exec(`CREATE TABLE runner_attempts (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL,
    workspace TEXT NOT NULL)`)
  const insert = db.query("INSERT INTO runner_attempts VALUES(?,?,?,?,?)")
  // Shared serial execution: hundreds of attempts name the same checkout.
  for (let index = 0; index < 400; index++)
    insert.run(`a${index}`, `p${index}`, `s${index}`, "accepted", "/repo/checkout")
  insert.run("t1", "plan-old", "worker-1", "accepted", "/repo/checkout.worktrees/old")
  const finding = { path: "/repo/checkout.worktrees/old" } as WorktreeFinding
  const host = { session: async () => null, worktrees: async () => [] } as never
  const probe = {
    exists: () => true,
    size: async () => 0,
    status: async () => "",
    contained: async () => ({ contained: true, reason: "contained" }),
  }
  const retired = new Set(["plan-old"])
  const { db: metered, meter } = meterDatabase(db)
  expect(await removalBlocker(metered, finding, { retired, host, probe })).toBeNull()
  // A path with in-flight work still blocks, and one with a live plan blocks as before.
  insert.run("t2", "plan-live", "worker-2", "running", "/repo/checkout.worktrees/old")
  expect(await removalBlocker(db, finding, { retired, host, probe })).toBe(
    "also recorded by work that is not finished",
  )
  expect(
    await removalBlocker(db, finding, { retired: new Set(["plan-old", "plan-live"]), host, probe }),
  ).toBe("an attempt is still in flight there")
  show("worktreeBlocker", { rows: 401 }, { rows: meter.rows })
  // Before: 401 rows with four text columns. After: two distinct paths and the one attempt.
  expect(meter.rows).toBeLessThanOrEqual(3)
  db.close()
})

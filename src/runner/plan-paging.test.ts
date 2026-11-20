import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { meterReads } from "./read-meter.fixture.ts"
import { planPrioritySortSQL } from "./priority.ts"
import { RunnerStore } from "./store.ts"

/**
 * `plans()` and `planHeads()` used to stop at 1,000 rows, so plan 1,001 was invisible to ticks,
 * guards and inspection. They now page by (priority, rowid) cursor and filter states in SQL.
 */

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const TOTAL = 1_200
const PADDING = "p".repeat(2_000)
const show = (name: string, before: unknown, after: unknown) => {
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(
      `[plan-paging] ${name} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    )
}

function seeded() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-plan-paging-")))
  const repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  cleanups.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  repository.atomic((db) => {
    const insert = db.query("INSERT INTO runner_plans VALUES(?,?,?,1,1,?,?,NULL,NULL,NULL)")
    for (let index = 0; index < TOTAL; index++)
      insert.run(
        `plan-${String(index).padStart(4, "0")}`,
        root,
        "owner",
        index % 4 === 0 ? "running" : "integrated",
        // Priorities repeat so the cursor has to break ties on rowid.
        JSON.stringify({ priority: index % 7 === 0 ? null : (index % 5) + 1, pad: PADDING }),
      )
  })
  return { root, repository, store }
}

test("plans() and planHeads() return plan 1,001 and every plan after it", () => {
  const f = seeded()
  const expected = f.store.read((db) =>
    db
      .query<{ id: string; state: "running" | "integrated" }, [string]>(
        `SELECT id,state FROM runner_plans WHERE project_directory=? ORDER BY ${planPrioritySortSQL("body")},rowid`,
      )
      .all(f.root),
  )
  expect(expected).toHaveLength(TOTAL)

  // Before: the cap. Every plan after the 1,000th in display order was invisible.
  const capped = f.store.read((db) =>
    db
      .query<{ id: string }, [string]>(
        `SELECT id FROM runner_plans WHERE project_directory=? ORDER BY ${planPrioritySortSQL("body")},rowid LIMIT 1000`,
      )
      .all(f.root),
  )
  expect(capped).toHaveLength(1_000)

  const all = f.store.plans()
  expect(all.map((plan) => plan.id)).toEqual(expected.map((row) => row.id))
  expect(new Set(all.map((plan) => plan.id)).size).toBe(TOTAL)
  expect([...f.store.eachPlan()]).toHaveLength(TOTAL)

  const running = [...f.store.planHeads(["running"])]
  expect(running).toEqual(expected.filter((row) => row.state === "running"))
  expect(running).toHaveLength(TOTAL / 4)
  expect([...f.store.planHeads(["running", "integrated"])]).toEqual(expected)
  expect([...f.store.planHeads([])]).toEqual([])
  expect(f.store.plan(expected.at(-1)!.id)?.id).toBe(expected.at(-1)!.id)
})

test("a walk reads only what its caller uses: heads read ids, not bodies", () => {
  const f = seeded()
  const old = meterReads(f.store)
  f.store.read((db) =>
    db
      .query(
        `SELECT * FROM runner_plans WHERE project_directory=? ORDER BY ${planPrioritySortSQL("body")},rowid LIMIT 1000`,
      )
      .all(f.root),
  )
  old.stop()

  const walk = meterReads(f.store)
  const ids = [...f.store.planHeads(["running"])]
  walk.stop()
  const full = meterReads(f.store)
  const bodies = f.store.plans()
  full.stop()

  expect(ids).toHaveLength(TOTAL / 4)
  expect(bodies).toHaveLength(TOTAL)
  expect(walk.of(/runner_plans/).rows).toBe(TOTAL / 4)
  expect(walk.of(/runner_plans/).bytes).toBeLessThan(old.of(/runner_plans/).bytes / 10)
  expect(full.of(/runner_plans/).rows).toBe(TOTAL)
  show("plans() / full view", old.of(/runner_plans/), full.of(/runner_plans/))
  show("planHeads(running)", old.of(/runner_plans/), walk.of(/runner_plans/))
})

import { allPlans } from "./store-plans.fixture.ts"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { meterReads, meterRepository } from "./read-meter.fixture.ts"
import { planPrioritySortSQL } from "./priority.ts"
import { RunnerStore } from "./store.ts"
import {
  COMPACT_PLANS_PER_PAGE,
  FULL_VIEW_PLANS_PER_PAGE,
  inspectPlan,
  type CompactInspectionSummary,
} from "./inspection.ts"

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

  const all = allPlans(f.store)
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
  const bodies = allPlans(f.store)
  full.stop()

  expect(ids).toHaveLength(TOTAL / 4)
  expect(bodies).toHaveLength(TOTAL)
  expect(walk.of(/runner_plans/).rows).toBe(TOTAL / 4)
  expect(walk.of(/runner_plans/).bytes).toBeLessThan(old.of(/runner_plans/).bytes / 10)
  expect(full.of(/runner_plans/).rows).toBe(TOTAL)
  show("plans() / full view", old.of(/runner_plans/), full.of(/runner_plans/))
  show("planHeads(running)", old.of(/runner_plans/), walk.of(/runner_plans/))
})

test("the project-wide full view pages: a cursor in, a page out, the same content across pages", () => {
  const f = seeded()
  const everything = allPlans(f.store)
  const pages: { ids: string[]; first: boolean }[] = []
  let after: string | undefined
  const seen: unknown[] = []
  for (;;) {
    const page = inspectPlan(f.store, {
      full: true,
      limit: 100,
      ...(after ? { plansAfter: after } : {}),
    }) as {
      plans: Array<{ id: string; waitingOnPlans: unknown }>
      paging: { plans: { next: string | null; returned: number } }
      audit?: unknown
    }
    pages.push({ ids: page.plans.map((plan) => plan.id), first: page.audit !== undefined })
    seen.push(...page.plans)
    expect(page.paging.plans.returned).toBe(page.plans.length)
    expect(page.plans.length).toBeLessThanOrEqual(100)
    if (page.paging.plans.next === null) break
    after = page.paging.plans.next
  }
  // Same plans, same order, same bodies as the old single call; the audit rides on page one only.
  expect(pages.flatMap((page) => page.ids)).toEqual(everything.map((plan) => plan.id))
  expect(pages).toHaveLength(Math.ceil(TOTAL / 100))
  expect(pages.map((page) => page.first)).toEqual(pages.map((_, index) => index === 0))
  expect(seen.map((plan) => (plan as { body: string }).body)).toEqual(
    everything.map((plan) => plan.body),
  )
  // The default page, and a cursor that does not decode.
  const defaultPage = inspectPlan(f.store, { full: true }) as { plans: unknown[] }
  expect(defaultPage.plans).toHaveLength(FULL_VIEW_PLANS_PER_PAGE)
  expect(() => inspectPlan(f.store, { full: true, plansAfter: "not-a-cursor" })).toThrow(
    "Invalid plan cursor",
  )
})

test("a full-view call holds one page of bodies, where the old call read every plan", () => {
  const f = seeded()
  const old = meterReads(f.store)
  allPlans(f.store)
  old.stop()
  const call = meterReads(f.store)
  inspectPlan(f.store, { full: true })
  call.stop()
  const rows = (meter: ReturnType<typeof meterReads>) => meter.of(/FROM runner_plans/)
  show("full view first page", rows(old), rows(call))
  // One page plus the look-ahead row; the waiting-on reads are by plan id, never a project scan.
  expect(rows(old).rows).toBe(TOTAL)
  expect(rows(call).rows).toBeLessThan(TOTAL / 4)
  expect(rows(call).bytes).toBeLessThan(rows(old).bytes / 4)
})

test("the compact project list reads no plan body, keeps every row and order, and marks more plans", () => {
  const f = seeded()
  const old = meterReads(f.store)
  f.store.read((db) =>
    db
      .query(
        `SELECT id,owner,revision,version,state,reason,model,artifact,body,
          json_extract(body,'$.title') AS title, json_extract(body,'$.objective') AS objective,
          json_extract(body,'$.priority') AS priority,
          COALESCE(json_extract(body,'$.workspaceMode'),'shared') AS workspaceMode,
          json_extract(body,'$.afterPlans') AS afterPlans,
          json_extract(body,'$.integrationOrder') AS integrationOrder
         FROM runner_plans WHERE project_directory=? ORDER BY ${planPrioritySortSQL("body")},rowid`,
      )
      .all(f.root),
  )
  old.stop()
  const everything = allPlans(f.store).map((plan) => plan.id)

  const call = meterRepository(f.repository)
  const first = inspectPlan(f.store, { full: false, limit: 1000 }) as CompactInspectionSummary
  call.stop()
  const planRead = (meter: ReturnType<typeof meterRepository>) => meter.of(/FROM runner_plans/)
  show("compact list", planRead(old), planRead(call))
  expect(first.plans.map((plan) => plan.id)).toEqual(everything.slice(0, 1000))
  expect(first.paging.plans.more).toBe(true)
  expect(first.paging.plans.next).not.toBeNull()
  expect(planRead(call).rows).toBeGreaterThan(0)
  expect(planRead(call).bytes).toBeLessThan(planRead(old).bytes / 8)

  // Pages of 200 walk the same list in the same order; only the last says no more.
  const ids: string[] = []
  let after: string | undefined
  const marks: boolean[] = []
  for (;;) {
    const page = inspectPlan(f.store, {
      full: false,
      limit: 200,
      ...(after ? { plansAfter: after } : {}),
    }) as CompactInspectionSummary
    ids.push(...page.plans.map((plan) => plan.id))
    marks.push(page.paging.plans.more)
    if (!page.paging.plans.next) break
    after = page.paging.plans.next
  }
  expect(ids).toEqual(everything)
  expect(marks).toEqual([true, true, true, true, true, false])
  // The default page is not the whole list, and says so.
  const dflt = inspectPlan(f.store, { full: false }) as CompactInspectionSummary
  expect(dflt.plans).toHaveLength(COMPACT_PLANS_PER_PAGE)
  expect(dflt.paging.plans.more).toBe(true)
})

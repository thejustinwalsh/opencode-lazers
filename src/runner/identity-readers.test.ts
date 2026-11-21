import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RetentionService } from "../retention/service.ts"
import { TaskRepository } from "../storage.ts"
import { backfillPage } from "./identity-backfill.ts"
import { attemptIs, forgetKeysReady, planIn, planIs, planJoin, samePlan } from "./identity-read.ts"
import { asLegacyHistory } from "./identity.fixture.ts"
import { RunnerStore } from "./store.ts"

/**
 * Parity of the readers moved to integer keys: each method returns what the statement it replaced
 * returns, on the same seeded rows, while the backfill is incomplete (text predicate) and after
 * it completes (integer predicate), and the integer plan uses an integer index on the history
 * table (no scan of it).
 */
const directories: string[] = []
const repositories: TaskRepository[] = []

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const PLANS = 12
const EVENTS = ["A", "VERIFICATION_DEADLINE_EXTENDED", "RETAINED_REPAIR_REQUESTED", "B"]

function seeded() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-identity-readers-"))
  directories.push(directory)
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), join(directory, "project"))
  repositories.push(repository)
  const store = new RunnerStore(repository)
  // The readers under test take a plan id; a full plan body is not the subject here.
  Object.assign(store, { requirePlan: () => undefined, plan: () => ({ version: 1 }) })
  repository.atomic((db) => {
    for (let plan = 0; plan < PLANS; plan++) {
      db.query(
        "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES(?,'d','o',1,1,'queued','{}')",
      ).run(`plan-${plan}`)
      for (let row = 0; row < 60; row++)
        db.query(
          "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
        ).run(
          `plan-${plan}`,
          row % 5 === 0 ? null : `task-${row % 3}`,
          1 + (row % 4),
          EVENTS[row % EVENTS.length]!,
          JSON.stringify({ row, sourceSessionID: `s${row % 2}`, plan }),
          row,
        )
    }
  })
  // Rows from before the key columns existed.
  asLegacyHistory(repository)
  return { repository, store }
}

/** Run `work` and return every statement text it prepared on any connection. */
function capture<T>(work: () => T): { result: T; statements: string[] } {
  const statements: string[] = []
  const original = Database.prototype.query
  Database.prototype.query = function (this: Database, sql: string) {
    statements.push(sql)
    return original.call(this, sql)
  } as typeof original
  try {
    return { result: work(), statements }
  } finally {
    Database.prototype.query = original
  }
}

type Reads = Record<string, (store: RunnerStore, plan: string) => unknown>
const reads: Reads = {
  activityEvents: (store, plan) => store.activityEvents(plan, "task-1"),
  activityEventsNewestLimited: (store, plan) =>
    store.activityEvents(plan, "task-2", { newest: true, limit: 4 }),
  activityCount: (store, plan) => store.activityCount(plan, "task-1"),
  hasActivity: (store, plan) => store.hasActivity(plan, "task-1"),
  activity: (store, plan) => store.activity(plan, "task-2"),
  latestTransition: (store, plan) => store.latestTransition(plan, null, "A"),
  latestTransitionOfTask: (store, plan) => store.latestTransition(plan, "task-1", "B"),
  latestTransitionVersion: (store, plan) => store.latestTransitionVersion(plan, "task-1", "B"),
  verificationTimeoutAmendments: (store, plan) => {
    try {
      return store.verificationTimeoutAmendments(plan)
    } catch (error) {
      // The seeded payloads are not amendments; the failure itself must be the same either way.
      return String(error).slice(0, 40)
    }
  },
  latestRetainedRepair: (store, plan) => store.latestRetainedRepair(plan),
  latestRetainedRepairOfTask: (store, plan) => store.latestRetainedRepair(plan, "task-1"),
}

const collect = (store: RunnerStore) =>
  Object.fromEntries(
    Array.from({ length: PLANS + 1 }, (_, plan) => `plan-${plan}`).map((plan) => [
      plan,
      Object.fromEntries(Object.entries(reads).map(([name, read]) => [name, read(store, plan)])),
    ]),
  )

test("moved plan-scoped transition readers return the same rows before and after the keys complete", async () => {
  const { repository, store } = seeded()
  const incomplete = collect(store)
  // A started backfill is still incomplete: readers keep the text predicate.
  repository.atomic((db) => backfillPage(db, "runner_transitions", 100))
  expect(collect(store)).toEqual(incomplete)

  await new RetentionService({ repository, host: {} as never }).backfillKeys(30_000)
  forgetKeysReady(repository.read((db) => db))
  const complete = collect(store)
  expect(complete).toEqual(incomplete)
  // Sanity: the fixture returns real rows, and the unknown plan returns none.
  expect((complete["plan-3"] as { activity: unknown[] }).activity.length).toBeGreaterThan(0)
  expect((complete["plan-12"] as { activity: unknown[] }).activity).toEqual([])
})

test("with complete keys every moved statement is planned on an integer index, not a scan", async () => {
  const { repository, store } = seeded()
  await new RetentionService({ repository, host: {} as never }).backfillKeys(30_000)
  forgetKeysReady(repository.read((db) => db))
  const { statements } = capture(() => collect(store))
  const moved = [...new Set(statements.filter((sql) => /FROM runner_transitions/.test(sql)))]
  expect(moved.length).toBeGreaterThanOrEqual(10)
  repository.read((db) => {
    for (const sql of moved) {
      const parameters = (sql.match(/\?/g) ?? []).map(() => "x")
      const plan = db
        .query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...parameters)
        .map((row) => row.detail)
        .join(" | ")
      if (process.env.EXPLAIN_VERBOSE) console.log(sql.replace(/\s+/g, " "), "=>", plan)
      expect(plan).toContain("plan_n")
      expect(plan).not.toMatch(/SCAN runner_transitions(?! USING)/)
    }
  })
})

test("recordSourceScanFailure records a changed condition once, on text and on integer keys", async () => {
  const { repository, store } = seeded()
  const failure = { renewalID: "r", sourceSessionID: "s1", error: "boom" }
  expect(store.recordSourceScanFailure("plan-1", failure)).toBe(true)
  expect(store.recordSourceScanFailure("plan-1", failure)).toBe(false)
  await new RetentionService({ repository, host: {} as never }).backfillKeys(30_000)
  forgetKeysReady(repository.read((db) => db))
  expect(store.recordSourceScanFailure("plan-1", failure)).toBe(false)
  expect(store.recordSourceScanFailure("plan-1", { ...failure, error: "other" })).toBe(true)
})

test("keyed joins and correlated reads drive from the plan into an integer index", async () => {
  const { repository } = seeded()
  await new RetentionService({ repository, host: {} as never }).backfillKeys(30_000)
  forgetKeysReady(repository.read((db) => db))
  const plan = (sql: string) =>
    repository.read((db) =>
      db
        .query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...(sql.match(/\?/g) ?? []).map(() => "x"))
        .map((row) => row.detail)
        .join(" | "),
    )
  const statements = repository.read((db) => [
    // planJoin: a project's newest transition of one event.
    `SELECT t.payload FROM runner_transitions t JOIN runner_plans p ON ${planJoin(db, "runner_transitions", "t", "p.id")}
      WHERE p.project_directory=? AND t.event=? ORDER BY t.id DESC LIMIT 1`,
    // planIs with a correlated value: the newest plan-level transition of each plan.
    `SELECT p.id,(SELECT tr.id FROM runner_transitions tr WHERE ${planIs(db, "runner_transitions", "tr", "p.id")}
      AND tr.task_id IS NULL AND tr.event='PLAN_ACCEPTED' ORDER BY tr.id DESC LIMIT 1) FROM runner_plans p
      WHERE p.project_directory=?`,
    // samePlan: retention's newest row of the same plan.
    `SELECT id FROM runner_transitions WHERE id < (SELECT MAX(l.id) FROM runner_transitions l
      WHERE ${samePlan(db, "runner_transitions", "l", "runner_transitions")}) AND rowid>? AND rowid<=?`,
    // A plan's progress by recency and an attempt's progress by sequence.
    `SELECT seq FROM runner_progress WHERE ${planIn(db, "runner_progress", "?,?")}
      ORDER BY latest_observed_at DESC,seq DESC LIMIT 5`,
    `SELECT seq FROM runner_progress WHERE project_directory=? AND ${attemptIs(db)} ORDER BY seq DESC LIMIT 1`,
  ])
  for (const sql of statements) {
    const detail = plan(sql)
    if (process.env.EXPLAIN_VERBOSE) console.log(sql.replace(/\s+/g, " "), "=>", detail)
    expect(detail).toMatch(
      /INDEX runner_(transitions|progress)_\w+ \((plan_n|project_directory=\? AND attempt_n)/,
    )
    expect(detail).not.toMatch(/SCAN (l|tr)\b(?! USING)/)
  }
})

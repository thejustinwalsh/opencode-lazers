import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { skipString, walk } from "../../scripts/check-unbounded-reads.ts"
import { cursorSecret, makeFixture, taskID } from "../../test/trajectory/fixture.ts"
import { ProjectionOwner, startProjection } from "../projections/owner.ts"
import { meterRepository } from "../runner/read-meter.fixture.ts"
import { TaskRepository } from "../storage.ts"
import { inspectTrajectory } from "../trajectory/read.ts"
import { InspectTrajectoryInput } from "../trajectory/schema.ts"
import { TASK_EVENTS_TRIGGERS } from "./task-events-schema.ts"
import { TASK_EVENTS, taskEventsProjection } from "./task-events-refresh.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const slow = {
  startMs: 60_000,
  quiet: { sliceMs: 1, waitMs: 1 },
  busy: { sliceMs: 1, waitMs: 1 },
  retryMs: 60_000,
}

/**
 * The trajectory fixture (two attempts, a failed and a passed attempt check, a plan check), with
 * the shapes the projection must also get right: a transition with no attempt and one naming an
 * unknown attempt, a plan-level transition (not shown), a plan-level effect that is not a check
 * (no time), a failed task effect with an error receipt, and an uncertain check with no receipt.
 */
function fixture() {
  const made = makeFixture()
  cleanups.push(() => made.close())
  const plan = made.receipt.planID
  const [first, second] = made.attempts
  made.store.atomic((db) => {
    const transition = db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
    )
    transition.run(plan, taskID, 3, "NOTE", JSON.stringify({ reason: "no attempt" }), 1500)
    transition.run(plan, taskID, 4, "RETRY", JSON.stringify({ attemptID: "gone" }), 1600)
    transition.run(plan, null, 5, "PLAN_ONLY", "{}", 1700)
    const effect = db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,?,'{}',?,1)")
    effect.run("plan-cleanup", plan, null, null, "worktree-remove", "completed", null)
    effect.run(
      "task-session",
      plan,
      taskID,
      first!.id,
      "session",
      "failed",
      JSON.stringify({ error: "host refused; api_key=never-shown" }),
    )
    effect.run("check-pending", plan, taskID, second!.id, "verify:late", "uncertain", null)
  })
  return made
}

type Stored = { origin: string; kind: string; at: number | null; detail: string }
const stored = (repository: TaskRepository) =>
  repository.read((db) =>
    db
      .query<Stored, [string]>(
        "SELECT origin,kind,at,detail FROM task_events WHERE task_id=? ORDER BY at,id",
      )
      .all(taskID),
  )

async function oldEvents(made: ReturnType<typeof fixture>) {
  const report = await inspectTrajectory(
    made.store,
    made.host,
    "project",
    InspectTrajectoryInput.parse({ taskID }),
    cursorSecret,
    { allEvents: true },
  )
  return (report.trajectory.events as Record<string, unknown>[]).filter((event) =>
    ["runner-transition", "runner-effect", "verification"].includes(String(event.kind)),
  )
}

const byID = (events: Record<string, unknown>[]) =>
  events.toSorted((a, b) => String(a.id).localeCompare(String(b.id)))

test("parity: transition, effect and check rows equal the trajectory read's events and checks", async () => {
  const made = fixture()
  const lease = startProjection(made.repository.path, made.directory, taskEventsProjection, {
    pacing: slow,
  })
  cleanups.push(() => lease.release())
  await lease.owner.settle()
  const rows = stored(made.repository)
  const expected = await oldEvents(made)
  expect(expected.length).toBe(10)
  expect(byID(rows.map((row) => JSON.parse(row.detail).event))).toEqual(byID(expected))
  // Columns carry what a list filters and orders by.
  for (const row of rows) {
    const event = JSON.parse(row.detail).event as Record<string, unknown>
    expect(row.at).toBe(typeof event.at === "number" ? event.at : null)
  }
  // Check rows carry the trajectory's check view, as the attempts and plans show it.
  const report = await inspectTrajectory(
    made.store,
    made.host,
    "project",
    InspectTrajectoryInput.parse({ taskID }),
    cursorSecret,
    { allEvents: true },
  )
  const checks = rows
    .filter((row) => row.kind === "check")
    .map((row) => JSON.parse(row.detail).check)
  const shown = [
    ...report.attempts.flatMap((attempt) => attempt.checks),
    ...(report.plans as { checks?: unknown[] }[]).flatMap((plan) => plan.checks ?? []),
  ]
  for (const check of checks) expect(shown).toContainEqual(check)
  // Time-less events (the plan cleanup) are stored with no time, never a made-up one.
  expect(rows.find((row) => row.origin.startsWith("ef:plan-cleanup@"))?.at).toBeNull()
  // A write after ready lands through the writer's own transaction.
  made.store.atomic((db) =>
    db
      .query("UPDATE runner_effects SET state='completed',receipt=? WHERE id='check-pending'")
      .run(JSON.stringify({ check: { exitCode: 0, timedOut: false, endedAt: 3900 } })),
  )
  expect(byID(stored(made.repository).map((row) => JSON.parse(row.detail).event))).toEqual(
    byID(await oldEvents(made)),
  )
})

test("triggers: one row per task-scoped transition; 10,000 plan-level transitions queue zero dirty entries", async () => {
  const made = fixture()
  const lease = startProjection(made.repository.path, made.directory, taskEventsProjection, {
    pacing: slow,
  })
  cleanups.push(() => lease.release())
  await lease.owner.settle()
  // A connection outside this process's drain hook: the queue keeps what the triggers wrote.
  const raw = new Database(made.repository.path)
  cleanups.push(() => raw.close())
  const plan = made.receipt.planID
  const insert = raw.query(
    "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,'X','{}',?)",
  )
  raw.transaction(() => {
    for (let i = 0; i < 10_000; i++) insert.run(plan, null, 5000 + i)
  })()
  const queued = () =>
    raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_events_dirty").get()!.n
  expect(queued()).toBe(0)
  raw.transaction(() => {
    for (let i = 0; i < 3; i++) insert.run(plan, taskID, 9000 + i)
  })()
  expect(queued()).toBe(3)
  await lease.owner.drain()
  expect(queued()).toBe(0)
  const transitions = made.repository.read(
    (db) =>
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM task_events WHERE task_id=? AND kind='transition'",
        )
        .get(taskID)!.n,
  )
  // Two from the trajectory fixture, two added above, three now.
  expect(transitions).toBe(7)
  // A deleted transition takes its row with it, in the deleting transaction.
  raw.query("DELETE FROM runner_transitions WHERE task_id=? AND created_at>=9000").run(taskID)
  expect(
    raw
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM task_events WHERE task_id=? AND kind='transition'",
      )
      .get(taskID)!.n,
  ).toBe(4)
})

test("backfill: paged, resumable after a kill, and a generation bump rewrites every row", async () => {
  const made = fixture()
  // Rows written before the projection existed: drop what the install-time drain already wrote.
  made.repository.atomic((db) => db.exec("DELETE FROM task_events; DELETE FROM projection_state"))
  const first = new ProjectionOwner(
    new TaskRepository(made.repository.path, made.directory),
    taskEventsProjection,
    { pacing: slow },
  )
  first.start()
  // Phase 0 (transitions) fits one page here; the next page starts the effects phase.
  expect(first.backfillPage()).toBe(true)
  first.close()
  const status = made.repository.read((db) =>
    db.query("SELECT phase,after,state FROM projection_state WHERE name=?").get(TASK_EVENTS),
  )
  expect(status).toEqual({ phase: 1, after: 0, state: "backfilling" })
  const lease = startProjection(made.repository.path, made.directory, taskEventsProjection, {
    pacing: slow,
  })
  await lease.owner.settle()
  expect(lease.owner.status()).toMatchObject({ state: "ready", phase: 1 })
  const ready = stored(made.repository)
  expect(ready.length).toBe(10)
  lease.release()
  // A new derivation generation: back to backfilling, and every row rewritten from the sources.
  made.repository.atomic((db) => db.exec("UPDATE task_events SET detail='stale'"))
  const bumped = startProjection(
    made.repository.path,
    made.directory,
    { ...taskEventsProjection, generation: taskEventsProjection.generation + 1 },
    { pacing: slow },
  )
  cleanups.push(() => bumped.release())
  expect(bumped.owner.status()).toMatchObject({ state: "backfilling", phase: 0, after: 0 })
  await bumped.owner.settle()
  expect(stored(made.repository)).toEqual(ready)
})

test("idle: a ready projection with no write reads nothing; a source write is drained", async () => {
  const made = fixture()
  const repository = new TaskRepository(made.repository.path, made.directory)
  const owner = new ProjectionOwner(repository, taskEventsProjection, { pacing: slow })
  cleanups.push(() => {
    owner.close()
    repository.close()
  })
  owner.start()
  await owner.settle()
  expect(owner.idle()).toBe(true)
  const meter = meterRepository(repository)
  cleanups.push(() => meter.stop())
  // An unrelated write from another connection: the owner hears of it and does nothing.
  const raw = new Database(made.repository.path)
  cleanups.push(() => raw.close())
  raw.query("UPDATE runner_attempts SET tool_count=tool_count+1").run()
  await Bun.sleep(50)
  expect(meter.statements).toEqual([])
  expect(owner.idle()).toBe(true)
  // Not vacuous: a source write from that connection is queued, and the owner drains it.
  raw.query("UPDATE runner_effects SET state='failed' WHERE id='check-pending'").run()
  for (let waited = 0; waited < 50 && meter.statements.length === 0; waited++) await Bun.sleep(10)
  await owner.drain()
  expect(meter.statements.length).toBeGreaterThan(0)
  expect(
    repository.read((db) =>
      db.query("SELECT to_state FROM task_events WHERE origin='ef:check-pending'").get(),
    ),
  ).toEqual({ to_state: "failed" })
  expect(owner.idle()).toBe(true)
})

/**
 * Review focus 1, a missed writer: every statement in `src/` that updates `runner_transitions` or
 * `runner_effects` sets only columns a queue trigger watches, or columns the derivation never
 * reads. Inserts and deletes are covered by triggers whatever their columns.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const UNREAD: Record<string, readonly string[]> = {
  runner_effects: ["payload", "fence"],
  runner_transitions: ["plan_n"],
}

function watched(table: string) {
  const columns = new Set<string>()
  for (const spec of TASK_EVENTS_TRIGGERS)
    if (spec.on === table && spec.event.startsWith("UPDATE OF "))
      for (const column of spec.event.slice("UPDATE OF ".length).split(",")) columns.add(column)
  return columns
}

function sqlLiterals(text: string): string[] {
  const found: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i)
      i = end < 0 ? text.length : end
    } else if (c === "/" && text[i + 1] === "*") i = text.indexOf("*/", i) + 2
    else if (c === '"' || c === "'" || c === "`") {
      const end = skipString(text, i)
      found.push(text.slice(i + 1, end - 1))
      i = end
    } else i++
  }
  return found
}

test("writers: every update of runner_transitions or runner_effects in src/ is watched", () => {
  const missed: string[] = []
  let seen = 0
  for (const path of walk(join(ROOT, "src")).sort())
    for (const sql of sqlLiterals(readFileSync(path, "utf8")))
      for (const m of sql.matchAll(
        /UPDATE\s+(runner_transitions|runner_effects)\s+SET\s+([^]*?)(?:\bWHERE\b|$)/gi,
      )) {
        seen++
        const table = m[1]!
        const allowed = new Set([...watched(table), ...UNREAD[table]!])
        for (const assignment of m[2]!.matchAll(/(?:^|,)\s*([a-z_]+)\s*=/gi))
          if (!allowed.has(assignment[1]!))
            missed.push(`${relative(ROOT, path)} ${table}.${assignment[1]}`)
      }
  expect(seen).toBeGreaterThan(10)
  expect(missed).toEqual([])
})

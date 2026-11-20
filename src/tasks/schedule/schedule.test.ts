import { afterEach, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { drainTaskSchedule, retryParked } from "./drain.ts"
import { TaskScheduleOwner } from "./owner.ts"
import { BACKFILL_PAGE, backfillPage } from "./backfill.ts"
import { bucketOf, encodeSortKey, priorityKeyOf, rankOf } from "./key.ts"
import { compareReads } from "./parity.ts"
import { SCHEDULE_TRIGGERS, installTaskScheduleSchema } from "./schema.ts"
import { insertTask, openFixture, submitPlan } from "./fixture.ts"
import type { Fixture } from "./fixture.ts"
import { HandoffStore } from "../../recovery/handoff/store.ts"
import { schemaModules } from "../../database-schema.ts"

const fixtures: Fixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})
const open = () => {
  const fixture = openFixture()
  fixtures.push(fixture)
  return fixture
}
const rows = <T>(f: Fixture, sql: string, ...params: (string | number)[]) =>
  f.repository.read((db) => db.query<T, (string | number)[]>(sql).all(...params))

test("a plan of two tasks with a dependency projects and matches the old read", () => {
  const f = open()
  const a = insertTask(f.repository, "alpha")
  const b = insertTask(f.repository, "beta")
  insertTask(f.repository, "loose")
  submitPlan(f, "p", [a, b], { dependencies: [[a, b]] })
  expect(compareReads(f.repository, f.reads)).toEqual([])
  expect(rows(f, "SELECT parent_task_id,child_task_id,kind FROM task_schedule_edges")).toEqual([
    { parent_task_id: b, child_task_id: a, kind: "plan" },
  ])
  expect(
    rows(f, "SELECT session_id,revision,reference FROM task_schedule WHERE task_id=?", a),
  ).toEqual([{ session_id: "session-a", revision: 1, reference: "LZ-1" }])
})

// ---- Task 1: schema -------------------------------------------------------------------------

test("the schema installs once, declares every table and plans the list reads on its indexes", () => {
  const f = open()
  const drift = f.repository.schemaDrift()
  expect(drift.undeclaredTables.filter((name) => name.startsWith("task_schedule"))).toEqual([])
  expect(drift.missingTables.filter((name) => name.startsWith("task_schedule"))).toEqual([])
  f.repository.atomic((db) => {
    installTaskScheduleSchema(db)
    installTaskScheduleSchema(db)
  })
  expect(
    rows<{ n: number }>(
      f,
      "SELECT COUNT(*) n FROM sqlite_master WHERE name='task_schedule_order'",
    )[0]!.n,
  ).toBe(1)
  for (const [where, expected] of [
    ["project_directory=? AND retired=0", "task_schedule_order"],
    ["project_directory=? AND retired=0 AND bucket='running'", "task_schedule_bucket"],
    ["project_directory=? AND session_id='s' AND retired=0", "task_schedule_creator"],
  ] as const) {
    const plan = rows<{ detail: string }>(
      f,
      `EXPLAIN QUERY PLAN SELECT task_id FROM task_schedule WHERE ${where} ORDER BY ${expected === "task_schedule_creator" ? "sort_key" : "sort_key"} LIMIT 30`,
      "/project",
    )
      .map((row) => row.detail)
      .join("\n")
    expect(plan).toContain(expected)
    expect(plan).not.toContain("TEMP B-TREE")
  }
})

test("a stored generation above the code's is refused", () => {
  const f = open()
  f.repository.atomic((db) =>
    db
      .query("UPDATE schema_modules SET generation=? WHERE module='task-schedule'")
      .run(schemaModules["task-schedule"].generation + 1),
  )
  expect(() =>
    f.repository.installSchema(
      "task-schedule",
      schemaModules["task-schedule"].generation,
      [],
      () => {},
    ),
  ).toThrow("Unsupported LAZERS schema module")
})

// ---- Task 2: triggers -----------------------------------------------------------------------

const dirty = (f: Fixture) =>
  rows<{ kind: string; ref: string }>(
    f,
    "SELECT kind,ref FROM task_schedule_dirty ORDER BY kind,ref",
  )

/** Run SQL that fires triggers without the drain, and read what was queued. */
function queued(f: Fixture, write: (db: Database) => void) {
  return f.repository.atomic((db) => {
    db.exec("DELETE FROM task_schedule_dirty")
    write(db)
    return db
      .query<{ kind: string; ref: string }, []>(
        "SELECT kind,ref FROM task_schedule_dirty ORDER BY kind,ref",
      )
      .all()
  })
}

test("triggers queue the owner of each changed row, and only for relevant columns", () => {
  const f = open()
  const a = insertTask(f.repository, "alpha")
  const planID = submitPlan(f, "p", [a])
  const attempt = crypto.randomUUID()
  const project = "/project"
  f.repository.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(attempt, planID, a, 1, "w", "m", "/worktree", "a".repeat(40), null, "{}", "running", 1),
  )
  expect(
    queued(f, (db) => db.query("UPDATE runner_nodes SET state='running' WHERE task_id=?").run(a)),
  ).toEqual([{ kind: "plan", ref: planID }])
  expect(
    queued(f, (db) => db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(planID)),
  ).toEqual([])
  expect(
    queued(f, (db) => db.query("UPDATE runner_plans SET reason='x' WHERE id=?").run(planID)),
  ).toEqual([{ kind: "plan", ref: planID }])
  expect(
    queued(f, (db) =>
      db.query("UPDATE runner_plans SET body=json_set(body,'$.priority',2) WHERE id=?").run(planID),
    ),
  ).toEqual([
    { kind: "plan", ref: planID },
    { kind: "reservations", ref: project },
  ])
  // A tool call bumps counters: nothing queued.
  expect(
    queued(f, (db) =>
      db
        .query(
          "UPDATE runner_attempts SET tool_count=tool_count+1,retry_count=retry_count+1 WHERE id=?",
        )
        .run(attempt),
    ),
  ).toEqual([])
  expect(
    queued(f, (db) =>
      db.query("UPDATE runner_attempts SET state='verifying' WHERE id=?").run(attempt),
    ),
  ).toEqual([
    { kind: "reservations", ref: project },
    { kind: "task", ref: a },
  ])
  expect(
    queued(f, (db) =>
      db
        .query(
          "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(planID, a, 1, "SCOPE_AMENDED", JSON.stringify({ writeScope: ["x/**"] }), 1),
    ),
  ).toEqual([
    { kind: "reservations", ref: project },
    { kind: "task", ref: a },
  ])
  expect(
    queued(f, (db) =>
      db
        .query(
          "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(planID, a, 1, "OUTCOME_SEND_STARTED", "{}", 2),
    ),
  ).toEqual([])
})

test("every source table has its triggers", () => {
  const f = open()
  new HandoffStore(f.repository)
  const present = new Set(
    rows<{ name: string }>(
      f,
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'task_schedule_q_%'",
    ).map((row) => row.name),
  )
  expect(present.size).toBe(SCHEDULE_TRIGGERS.length)
  const tables = new Set(SCHEDULE_TRIGGERS.map((trigger) => trigger.table))
  for (const table of [
    "tasks",
    "task_references",
    "task_dispositions",
    "task_classifications",
    "runner_plans",
    "runner_nodes",
    "runner_dependencies",
    "runner_attempts",
    "runner_adoptions",
    "runner_transitions",
    "runner_dispatch_controls",
    "lazers_dispatch_pause",
    "recovery_concern_versions",
    "recovery_concern_dispositions",
  ])
    expect(tables.has(table)).toBe(true)
})

test("the drain costs one statement when nothing is queued", () => {
  const f = open()
  insertTask(f.repository, "alpha")
  const statements: string[] = []
  f.repository.atomic((db) => {
    // Wrap the connection's query method to count statements the drain hook prepares or runs.
    const original = db.query.bind(db)
    ;(db as unknown as { query: typeof db.query }).query = ((sql: string) => {
      statements.push(sql)
      return original(sql)
    }) as typeof db.query
    f.repository.atomic(() => {})
    ;(db as unknown as { query: typeof db.query }).query = original
  })
  // The probe is prepared once per connection, so a transaction that touches no schedule table
  // prepares nothing else.
  expect(statements.filter((sql) => /task_schedule/.test(sql))).toEqual([])
})

test("empty-queue overhead per write transaction", () => {
  const f = open()
  insertTask(f.repository, "alpha")
  const noop = () => f.repository.atomic(() => {})
  for (let i = 0; i < 2000; i++) noop()
  const runs = 20000
  const start = Bun.nanoseconds()
  for (let i = 0; i < runs; i++) noop()
  const withHook = (Bun.nanoseconds() - start) / runs
  const db = (f.repository as unknown as { db: Database }).db
  const bare = () => db.transaction(() => {}).immediate()
  for (let i = 0; i < 2000; i++) bare()
  const base = Bun.nanoseconds()
  for (let i = 0; i < runs; i++) bare()
  const without = (Bun.nanoseconds() - base) / runs
  const probe = db.query("SELECT 1 FROM task_schedule_dirty LIMIT 1")
  const p0 = Bun.nanoseconds()
  for (let i = 0; i < runs; i++) probe.get()
  const probeNs = (Bun.nanoseconds() - p0) / runs
  console.log(
    `atomic with hook ${withHook.toFixed(0)} ns, bare transaction ${without.toFixed(0)} ns, probe alone ${probeNs.toFixed(0)} ns`,
  )
  expect(probeNs).toBeLessThan(20_000)
})

// ---- Task 3: key ----------------------------------------------------------------------------

test("sort key fields hold at the extremes and rank and bucket follow the old rules", () => {
  const key = encodeSortKey({
    planID: "p",
    nodeState: "accepted",
    planState: "running",
    priority: 2147483647,
    planSeq: 9e15,
    ordinal: 99,
    seq: Number.MAX_SAFE_INTEGER - 1,
    finishedAt: 0,
  })
  expect(key.length).toBe(1 + 1 + 13 + 10 + 16 + 9 + 16)
  expect(priorityKeyOf(0)).toBeGreaterThan(priorityKeyOf(2147483647))
  expect(rankOf({ nodeState: "running", planState: "blocked" })).toBe(1)
  expect(rankOf({ nodeState: "running", planState: "cancelled" })).toBe(5)
  expect(
    bucketOf({ nodeState: "queued", planState: "running", status: "blocked", paused: false }),
  ).toBe("blocked")
  expect(
    bucketOf({ nodeState: "queued", planState: "running", status: "queued", paused: true }),
  ).toBe("paused")
  expect(bucketOf({ nodeState: null, planState: null, status: "submitted", paused: false })).toBe(
    "open",
  )
})

// ---- Task 5: drain --------------------------------------------------------------------------

const breakScopes = (f: Fixture) =>
  f.repository.atomic((db) =>
    db.exec("ALTER TABLE task_schedule_scopes RENAME TO task_schedule_scopes_off"),
  )
const fixScopes = (f: Fixture) =>
  f.repository.atomic((db) =>
    db.exec("ALTER TABLE task_schedule_scopes_off RENAME TO task_schedule_scopes"),
  )
const parked = (f: Fixture) =>
  rows<{ kind: string; ref: string; attempts: number }>(
    f,
    "SELECT kind,ref,attempts FROM task_schedule_failed",
  )

test("a refresh that throws is parked, the write commits, and the entry has an exit", () => {
  const f = open()
  const a = insertTask(f.repository, "alpha")
  expect(rows<{ stale: number }>(f, "SELECT stale FROM task_schedule WHERE task_id=?", a)).toEqual([
    { stale: 0 },
  ])
  breakScopes(f)
  // A real change to the task's plan: the write commits although its refresh throws.
  const planID = submitPlan(f, "p", [a])
  expect(rows(f, "SELECT 1 FROM runner_plans WHERE id=?", planID).length).toBe(1)
  expect(dirty(f)).toEqual([])
  expect(parked(f).length).toBeGreaterThan(0)
  expect(rows<{ stale: number }>(f, "SELECT stale FROM task_schedule WHERE task_id=?", a)).toEqual([
    { stale: 1 },
  ])
  // Not due yet: the owner's retry leaves it parked.
  f.repository.atomic((db) => expect(retryParked(db)).toBe(0))
  // Once the cause is fixed, a due retry succeeds, clears the parked set and the stale mark.
  fixScopes(f)
  f.repository.atomic((db) => retryParked(db, Date.now() + 10 * 60_000))
  expect(parked(f)).toEqual([])
  expect(
    rows<{ stale: number; plan_id: string }>(
      f,
      "SELECT stale,plan_id FROM task_schedule WHERE task_id=?",
      a,
    ),
  ).toEqual([{ stale: 0, plan_id: planID }])
})

test("a real change re-queues a parked entry, and a refresh that always throws costs unrelated writes nothing", () => {
  const f = open()
  const a = insertTask(f.repository, "alpha")
  const b = insertTask(f.repository, "beta")
  const planA = submitPlan(f, "pa", [a])
  breakScopes(f)
  f.repository.atomic((db) =>
    db.query("UPDATE runner_plans SET reason='one' WHERE id=?").run(planA),
  )
  f.repository.atomic((db) =>
    db.query("UPDATE runner_plans SET reason='two' WHERE id=?").run(planA),
  )
  expect(parked(f).filter((row) => row.kind === "plan")[0]?.attempts).toBe(2)
  // An unrelated write: the hot queue is empty, so the drain hook prepares and runs nothing else.
  const seen: string[] = []
  f.repository.atomic((db) => {
    const original = db.query.bind(db)
    ;(db as unknown as { query: typeof db.query }).query = ((sql: string) => {
      seen.push(sql)
      return original(sql)
    }) as typeof db.query
    db.exec("CREATE TABLE IF NOT EXISTS unrelated_probe(x)")
    f.repository.atomic((inner) => inner.exec("INSERT INTO unrelated_probe VALUES(1)"))
    ;(db as unknown as { query: typeof db.query }).query = original
  })
  expect(seen.filter((sql) => /task_schedule/.test(sql))).toEqual([])
  expect(dirty(f)).toEqual([])
  fixScopes(f)
  expect(b).toBeTruthy()
})

test("a drain budget leaves the rest queued and a later drain finishes it", () => {
  const f = open()
  for (let i = 0; i < 12; i++) insertTask(f.repository, `t${i}`)
  f.repository.atomic((db) => {
    db.exec("DELETE FROM task_schedule WHERE 1; DELETE FROM task_schedule_counts")
    for (const row of db.query<{ id: string }, []>("SELECT id FROM tasks").all())
      db.query("INSERT OR IGNORE INTO task_schedule_dirty(kind,ref) VALUES('task',?)").run(row.id)
  })
  // The transaction above drained everything through the hook; queue again under a small budget.
  f.repository.atomic((db) => {
    db.exec("DELETE FROM task_schedule WHERE 1; DELETE FROM task_schedule_counts")
  })
  let rest = 0
  f.repository.atomic((db) => {
    for (const row of db.query<{ id: string }, []>("SELECT id FROM tasks").all())
      db.query("INSERT OR IGNORE INTO task_schedule_dirty(kind,ref) VALUES('task',?)").run(row.id)
    const first = drainTaskSchedule(db, { budget: 5 })
    expect(first.handled).toBe(5)
    rest = first.remaining
  })
  // The budget stopped the explicit drain; the transaction's own drain finished the queue.
  expect(rest).toBe(7)
  expect(dirty(f)).toEqual([])
  expect(rows<{ n: number }>(f, "SELECT COUNT(*) n FROM task_schedule")[0]!.n).toBe(12)
})

// ---- Task 6: observations -------------------------------------------------------------------

test("a recorded prerequisite observation becomes the task's scheduling decision", () => {
  const f = open()
  const a = insertTask(f.repository, "alpha")
  const planID = submitPlan(f, "p", [a])
  const decision = () =>
    rows<{ decision: string; decision_reason: string | null }>(
      f,
      "SELECT decision,decision_reason FROM task_schedule WHERE task_id=?",
      a,
    )[0]
  f.repository.atomic((db) =>
    db.query("UPDATE runner_plans SET state='running' WHERE id=?").run(planID),
  )
  expect(decision()).toEqual({ decision: "eligible", decision_reason: null })
  expect(
    f.reads.runner.recordPrerequisiteObservation(planID, a, {
      decision: "waiting",
      reason: "Ancestry not integrated",
    }),
  ).toBe(true)
  expect(decision()).toEqual({ decision: "waiting", decision_reason: "Ancestry not integrated" })
  expect(
    f.reads.runner.recordPrerequisiteObservation(planID, a, {
      decision: "waiting",
      reason: "Ancestry not integrated",
    }),
  ).toBe(false)
  f.reads.runner.recordPrerequisiteObservation(planID, a, { decision: "ready", reason: null })
  expect(decision()).toEqual({ decision: "eligible", decision_reason: null })
  f.repository.atomic((db) =>
    db.query("UPDATE runner_nodes SET state='accepted' WHERE task_id=?").run(a),
  )
  expect(decision()?.decision).toBe("not-applicable")
})

// ---- Task 7: backfill -----------------------------------------------------------------------

test("backfill pages resume at the stored watermark and end equal to the incremental rows", () => {
  const f = open()
  const ids = Array.from({ length: 9 }, (_, i) => insertTask(f.repository, `t${i}`))
  submitPlan(f, "p", ids.slice(0, 3), { dependencies: [[ids[0]!, ids[1]!]] })
  const before = rows(f, "SELECT * FROM task_schedule ORDER BY seq")
  f.repository.atomic((db) => installTaskScheduleSchema(db))
  expect(rows(f, "SELECT COUNT(*) n FROM task_schedule")).toEqual([{ n: 0 }])
  const project = f.repository.projectDirectory
  let pages = 0
  f.repository.atomic((db) => {
    expect(backfillPage(db, project, 4).done).toBe(false)
    pages++
  })
  const state = () =>
    rows<{ ready: number; backfill_after: number }>(
      f,
      "SELECT ready,backfill_after FROM task_schedule_state",
    )[0]!
  expect(state().ready).toBe(0)
  expect(rows(f, "SELECT COUNT(*) n FROM task_schedule")).toEqual([{ n: 4 }])
  // A write between pages is folded by the drain, not lost.
  const late = insertTask(f.repository, "late")
  expect(rows(f, "SELECT COUNT(*) n FROM task_schedule WHERE task_id=?", late)).toEqual([{ n: 1 }])
  for (;;) {
    let done = false
    f.repository.atomic((db) => {
      done = backfillPage(db, project, 4).done
      pages++
    })
    if (done) break
  }
  expect(pages).toBeGreaterThanOrEqual(3)
  expect(state().ready).toBe(1)
  expect(rows(f, "SELECT * FROM task_schedule ORDER BY seq").slice(0, before.length)).toEqual(
    before,
  )
  expect(BACKFILL_PAGE).toBeGreaterThan(0)
})

test("a generation reinstall drops the projection and the backfill refills it", () => {
  const f = open()
  insertTask(f.repository, "alpha")
  f.repository.atomic((db) => installTaskScheduleSchema(db))
  expect(rows(f, "SELECT COUNT(*) n FROM task_schedule")).toEqual([{ n: 0 }])
  f.repository.atomic((db) => backfillPage(db, f.repository.projectDirectory))
  expect(rows(f, "SELECT COUNT(*) n FROM task_schedule")).toEqual([{ n: 1 }])
})

// ---- Several plans for one task -------------------------------------------------------------

test("a task in two plans shows its newest plan, like currentActivityTargets", () => {
  const f = open()
  const a = insertTask(f.repository, "alpha")
  const first = submitPlan(f, "first", [a])
  const second = crypto.randomUUID()
  f.repository.atomic((db) => {
    db.query(
      "INSERT INTO runner_plans SELECT ?,project_directory,owner,revision,version,state,body,model,reason,artifact FROM runner_plans WHERE id=?",
    ).run(second, first)
    db.query(
      "INSERT INTO runner_nodes SELECT ?,task_id,2,ordinal,'running',version,reason,artifact,snapshot,machine_version FROM runner_nodes WHERE plan_id=?",
    ).run(second, first)
  })
  const row = rows<{ plan_id: string; node_state: string }>(
    f,
    "SELECT plan_id,node_state FROM task_schedule WHERE task_id=?",
    a,
  )[0]
  expect(row).toEqual({ plan_id: second, node_state: "running" })
  expect(f.reads.currentActivityTargets([a])[0]?.planID).toBe(second)
})

// ---- Owner ----------------------------------------------------------------------------------

test("the owner backfills a project until ready, drains parked work when due, and closes", async () => {
  const f = open()
  for (let i = 0; i < 30; i++) insertTask(f.repository, `t${i}`)
  f.repository.atomic((db) => installTaskScheduleSchema(db))
  const owner = new TaskScheduleOwner(f.repository)
  expect(owner.ready()).toBe(false)
  owner.start()
  await owner.settle()
  expect(owner.ready()).toBe(true)
  expect(rows<{ n: number }>(f, "SELECT COUNT(*) n FROM task_schedule")[0]!.n).toBe(30)
  // A parked refresh comes due and the owner's retry clears it.
  breakScopes(f)
  f.repository.atomic((db) =>
    db
      .query(
        "INSERT OR IGNORE INTO task_schedule_dirty(kind,ref) SELECT 'task',id FROM tasks LIMIT 1",
      )
      .run(),
  )
  expect(parked(f).length).toBe(1)
  fixScopes(f)
  f.repository.atomic((db) => db.query("UPDATE task_schedule_failed SET next_at=0").run())
  await owner.settle()
  expect(parked(f)).toEqual([])
  owner.close()
})

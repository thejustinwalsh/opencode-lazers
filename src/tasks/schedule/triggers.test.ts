import { afterEach, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { setPause } from "../../projects/pause.ts"
import { RunnerStore } from "../../runner/store.ts"
import { insertTask, openFixture, submitPlan, type Fixture } from "./fixture.ts"
import { SCHEDULE_TRIGGERS, scheduleTriggersDiffer } from "./schema.ts"

const fixtures: Fixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

const triggers = (db: Database) =>
  db
    .query<{ name: string; tbl_name: string }, []>(
      "SELECT name,tbl_name FROM sqlite_master WHERE type='trigger' AND name LIKE 'task_schedule_q_%' ORDER BY name",
    )
    .all()

const present = (db: Database, table: string) =>
  Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))

/**
 * What generations 5 and 6 left in the live database (2026-11-22): the same specs under
 * positional names (`task_schedule_q_lazers_dispatch_pause_update_22` and `…_26`), side by side,
 * each queuing with `INSERT OR IGNORE`.
 */
function installPositionalTriggers(db: Database, offset: number) {
  SCHEDULE_TRIGGERS.forEach((spec, index) => {
    if (!present(db, spec.table)) return
    const name = `task_schedule_q_${spec.table}_${spec.event.toLowerCase()}_${index + offset}`
    const body = spec.queues
      .map(
        ([kind, ref, where]) =>
          `INSERT OR IGNORE INTO task_schedule_dirty(kind,ref) SELECT '${kind}',${ref}${where ? ` WHERE ${where}` : ` WHERE ${ref} IS NOT NULL`};`,
      )
      .join("\n")
    const of = spec.columns ? ` OF ${spec.columns.join(",")}` : ""
    db.exec(
      `DROP TRIGGER IF EXISTS ${name};
       CREATE TRIGGER ${name} AFTER ${spec.event}${of} ON ${spec.table}
       ${spec.when ? `WHEN ${spec.when}` : ""} BEGIN ${body} END;`,
    )
  })
}

/** The pause writer's upsert, with the entry its trigger queues already queued. */
const unpauseWithEntryQueued = (f: Fixture) =>
  f.repository.atomic((db) => {
    db.query("INSERT INTO task_schedule_dirty(kind,ref) VALUES('pause','global')").run()
    db.query(
      `INSERT INTO lazers_dispatch_pause VALUES(?,?,?,?,?)
       ON CONFLICT(scope) DO UPDATE SET state=excluded.state,reason=excluded.reason,
         by=excluded.by,updated_at=excluded.updated_at`,
    ).run("global", "enabled", "", "owner", Date.now())
  })

test("a load drops the triggers of older generations and leaves one per table, event and kind", () => {
  const f = openFixture()
  fixtures.push(f)
  const task = insertTask(f.repository, "a")
  submitPlan(f, "p", [task])
  f.repository.atomic((db) => {
    for (const { name } of triggers(db)) db.exec(`DROP TRIGGER ${name}`)
    installPositionalTriggers(db, 0)
    installPositionalTriggers(db, 4)
  })
  setPause(f.repository, { kind: "global" }, { paused: true, reason: "hold", by: "owner" })
  // The defect: under the writer's upsert, a queued entry aborts the unpause.
  expect(() => unpauseWithEntryQueued(f)).toThrow(/UNIQUE constraint failed: task_schedule_dirty/)
  expect(f.repository.read(scheduleTriggersDiffer)).toBe(true)

  // The next load reconciles them.
  new RunnerStore(f.repository)
  const after = f.repository.read(triggers)
  expect(f.repository.read(scheduleTriggersDiffer)).toBe(false)
  expect(after.length).toBe(
    f.repository.read((db) => SCHEDULE_TRIGGERS.filter((spec) => present(db, spec.table)).length),
  )
  expect(after.filter((row) => /_\d+$/.test(row.name))).toEqual([])
  expect(
    after.filter((row) => row.tbl_name === "lazers_dispatch_pause").map((row) => row.name),
  ).toEqual([
    "task_schedule_q_lazers_dispatch_pause_insert_pause",
    "task_schedule_q_lazers_dispatch_pause_update_pause",
  ])
  // No trigger queues with a conflict clause.
  const bodies = f.repository.read((db) =>
    db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'task_schedule_q_%'",
      )
      .all(),
  )
  expect(bodies.some((row) => /INSERT OR /i.test(row.sql))).toBe(false)

  // The unpause with the entry already queued, then the real writer on and off, twice.
  expect(() => unpauseWithEntryQueued(f)).not.toThrow()
  for (let round = 0; round < 2; round++) {
    setPause(f.repository, { kind: "global" }, { paused: true, reason: "hold", by: "owner" })
    f.repository.atomic((db) =>
      db
        .query(
          "INSERT INTO task_schedule_dirty(kind,ref) SELECT 'pause','global' WHERE NOT EXISTS (SELECT 1 FROM task_schedule_dirty WHERE kind='pause' AND ref='global')",
        )
        .run(),
    )
    expect(() =>
      setPause(f.repository, { kind: "global" }, { paused: false, reason: "", by: "owner" }),
    ).not.toThrow()
  }
  // A second load finds nothing to change.
  const before = f.repository.read(triggers)
  new RunnerStore(f.repository)
  expect(f.repository.read(triggers)).toEqual(before)
})

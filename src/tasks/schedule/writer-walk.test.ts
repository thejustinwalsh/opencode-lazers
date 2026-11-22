import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { setPause } from "../../projects/pause.ts"
import { detailCorpus } from "../detail.fixture.ts"
import { SCHEDULE_TRIGGERS } from "./schema.ts"

/**
 * Every writer of every table a schedule trigger watches, with the entry each trigger queues
 * already queued when the write runs. A queue trigger runs inside the writer's statement and under
 * its conflict handling: one that throws aborts the writer's whole transaction (a pause, a runner
 * transition). Temporary BEFORE triggers queue every candidate entry first, so each write meets
 * its own entries already present.
 */
let corpus: Awaited<ReturnType<typeof detailCorpus>>
const TABLES = [...new Set(SCHEDULE_TRIGGERS.map((spec) => spec.table))]
const KINDS = ["task", "plan", "reservations", "pause", "lineage"]

const tableExists = (db: Database, table: string) =>
  Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))

/** Every ref a trigger could queue in this fixture, under every kind. */
function fillCandidates(db: Database, extra: readonly string[] = []) {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS walk_refs(ref TEXT PRIMARY KEY)")
  db.exec(`INSERT OR IGNORE INTO walk_refs SELECT id FROM tasks;
    INSERT OR IGNORE INTO walk_refs SELECT id FROM runner_plans;
    INSERT OR IGNORE INTO walk_refs SELECT DISTINCT project_directory FROM runner_plans;
    INSERT OR IGNORE INTO walk_refs SELECT id FROM runner_architect_renewals;
    INSERT OR IGNORE INTO walk_refs SELECT scope FROM lazers_dispatch_pause;
    INSERT OR IGNORE INTO walk_refs VALUES('global');`)
  for (const ref of extra) db.query("INSERT OR IGNORE INTO walk_refs VALUES(?)").run(ref)
}

function installPrefill(db: Database) {
  for (const table of TABLES) {
    if (!tableExists(db, table)) continue
    for (const event of ["INSERT", "UPDATE", "DELETE"])
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS walk_${table}_${event.toLowerCase()}
        BEFORE ${event} ON main.${table} BEGIN
          INSERT INTO task_schedule_dirty(kind,ref)
            SELECT k.kind,r.ref FROM (${KINDS.map((kind) => `SELECT '${kind}' AS kind`).join(" UNION ALL ")}) k, walk_refs r
            WHERE NOT EXISTS (SELECT 1 FROM task_schedule_dirty d WHERE d.kind=k.kind AND d.ref=r.ref);
        END`)
  }
}

beforeAll(async () => {
  corpus = await detailCorpus()
  const { f, runner } = corpus
  const plan = f.repository.read(
    (db) => db.query<{ id: string }, []>("SELECT id FROM runner_plans LIMIT 1").get()!.id,
  )
  runner.ensureContinuation(plan, {
    session_id: "ses_cont",
    parent_id: "ses_parent",
    directory: "/w",
    model: "m",
  })
  f.repository.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_architect_renewals(id,anchor_plan_id,previous_session_id,successor_session_id,
           directory,model,idle_at,generation,state,handoff_message_id,started_at)
         VALUES('walk-renewal',?,'ses_cont','ses_next','/w','m',0,1,'committed','h',1)`,
      )
      .run(plan),
  )
  setPause(f.repository, { kind: "global" }, { paused: true, reason: "hold", by: "o" })
  runner.setDispatchPause(plan, { reason: "hold", untilPlans: [] }, {})
  f.repository.atomic((db) => {
    fillCandidates(db, ["project-key", "walk-renewal-2"])
    installPrefill(db)
  })
})
afterAll(() => corpus.close())

test("the real pause writers, global, project and plan, run with their entries queued", () => {
  const { f, runner } = corpus
  const plan = f.repository.read(
    (db) => db.query<{ id: string }, []>("SELECT id FROM runner_plans LIMIT 1").get()!.id,
  )
  for (let round = 0; round < 2; round++) {
    expect(() => {
      setPause(f.repository, { kind: "global" }, { paused: false, reason: "", by: "o" })
      setPause(f.repository, { kind: "global" }, { paused: true, reason: "hold", by: "o" })
      setPause(
        f.repository,
        { kind: "project", key: "project-key" },
        { paused: true, reason: "h", by: "o" },
      )
      setPause(
        f.repository,
        { kind: "project", key: "project-key" },
        { paused: false, reason: "", by: "o" },
      )
      runner.setDispatchPause(plan, null, {})
      runner.setDispatchPause(plan, { reason: "hold", untilPlans: [] }, {})
    }).not.toThrow()
  }
  runner.setDispatchPause(plan, null, {})
  setPause(f.repository, { kind: "global" }, { paused: false, reason: "", by: "o" })
})

/** Append-only tables refuse an update or delete by their own guard; they are written by insert. */
const APPEND_ONLY = new Set(["task_classifications", "task_advice"])

type Column = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
const columnsOf = (db: Database, table: string) =>
  db
    .query<Column, []>(
      `SELECT name,type,"notnull",dflt_value,pk FROM pragma_table_info('${table}')`,
    )
    .all()

/** A value for a column of a seeded or cloned row: an existing id for a reference, else a filler. */
function valueFor(db: Database, column: Column, fresh: boolean): string | number | null {
  const first = (sql: string) => db.query<{ v: string }, []>(sql).get()?.v ?? null
  const { name } = column
  if (name === "project_directory") return corpus.f.repository.projectDirectory
  if (/(^|_)task_id$/.test(name)) return first("SELECT id AS v FROM tasks LIMIT 1")
  if (/(^|_)plan_id$/.test(name)) return first("SELECT id AS v FROM runner_plans LIMIT 1")
  if (name === "attempt_id") return first("SELECT id AS v FROM runner_attempts LIMIT 1")
  if (name === "version" || name === "revision")
    return fresh ? Math.floor(Math.random() * 1e9) + 2 : 1
  if (/INT/i.test(column.type)) return fresh && column.pk ? null : 1
  return fresh ? `walk-${crypto.randomUUID()}` : "walk"
}

/** Columns of the table's unique indexes (its primary key included). */
function uniqueColumns(db: Database, table: string) {
  const names = new Set<string>()
  for (const index of db
    .query<{ name: string; unique: number }, []>(
      `SELECT name,"unique" FROM pragma_index_list('${table}')`,
    )
    .all())
    if (index.unique)
      for (const column of db
        .query<{ name: string }, []>(`SELECT name FROM pragma_index_info('${index.name}')`)
        .all())
        names.add(column.name)
  return names
}

/** A row in each watched table the corpus left empty, from the column types. */
function seedEmpty(db: Database, table: string) {
  if (db.query(`SELECT 1 FROM ${table} LIMIT 1`).get()) return
  const columns = columnsOf(db, table).filter(
    (column) => column.notnull && column.dflt_value === null,
  )
  db.query(
    `INSERT INTO ${table}(${columns.map((c) => `"${c.name}"`).join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
  ).run(
    ...columns.map((column) => {
      // A disposition names a recorded concern version.
      const concern =
        table === "recovery_concern_dispositions" &&
        db
          .query<{ concern_id: string; version: number }, []>(
            "SELECT concern_id,version FROM recovery_concern_versions LIMIT 1",
          )
          .get()
      if (concern && column.name === "concern_id") return concern.concern_id
      if (concern && column.name === "version") return concern.version
      return valueFor(db, column, column.pk > 0)
    }),
  )
}

/**
 * Each step that a table's own constraints or guards refuse (a foreign key, an append-only guard,
 * a second unique key) writes nothing and fires nothing; it is recorded, not failed. A refusal
 * from the queue (`task_schedule_dirty`) fails the test, and every table must have had at least
 * one step whose triggers fired.
 */
const exercised = new Map<string, string[]>()
for (const table of TABLES)
  test(`${table}: insert, update and delete under an upsert, with every entry already queued`, () => {
    const { f } = corpus
    const fired: string[] = []
    const step = (name: string, run: () => void) => {
      try {
        f.repository.atomic(() => run())
        fired.push(name)
      } catch (error) {
        const message = String((error as Error).message)
        if (/task_schedule_dirty/.test(message)) throw error
      }
    }
    const columns = f.repository.read((db) => columnsOf(db, table))
    const names = columns.map((column) => `"${column.name}"`).join(",")
    const set = columns.map((column) => `"${column.name}"=excluded."${column.name}"`).join(",")
    step("seed", () => f.repository.atomic((db) => seedEmpty(db, table)))
    let clone: number | undefined
    step("insert under an upsert", () =>
      f.repository.atomic((db) => {
        const unique = uniqueColumns(db, table)
        const fresh = (column: Column) =>
          (column.pk > 0 || unique.has(column.name)) &&
          !/(^|_)(task|plan|attempt)_id$|^project_directory$/.test(column.name)
        const keys = columns.filter(fresh)
        const select = columns.map((column) => (fresh(column) ? "?" : `"${column.name}"`)).join(",")
        clone = (
          db
            .query(
              `INSERT INTO ${table}(${names}) SELECT ${select} FROM ${table} LIMIT 1
               ON CONFLICT DO UPDATE SET ${set} RETURNING rowid AS id`,
            )
            .get(...keys.map((column) => valueFor(db, column, true))) as { id: number }
        ).id
      }),
    )
    step("update under an upsert", () =>
      f.repository.atomic((db) =>
        db.exec(`INSERT INTO ${table}(${names}) SELECT ${names} FROM ${table} LIMIT 1
          ON CONFLICT DO UPDATE SET ${set}`),
      ),
    )
    step("update", () =>
      f.repository.atomic((db) =>
        db.exec(
          `UPDATE ${table} SET ${columns.map((c) => `"${c.name}"="${c.name}"`).join(",")} WHERE rowid=(SELECT rowid FROM ${table} LIMIT 1)`,
        ),
      ),
    )
    step("delete and restore", () =>
      f.repository.atomic((db) => {
        db.exec("PRAGMA defer_foreign_keys=ON")
        db.exec(`DROP TABLE IF EXISTS temp.walk_row;
          CREATE TEMP TABLE walk_row AS SELECT rowid AS walk_rowid,* FROM ${table} LIMIT 1;
          DELETE FROM ${table} WHERE rowid=(SELECT walk_rowid FROM walk_row);
          INSERT INTO ${table}(${names}) SELECT ${names} FROM walk_row;`)
      }),
    )
    if (clone !== undefined)
      step("delete", () =>
        f.repository.atomic((db) => db.exec(`DELETE FROM ${table} WHERE rowid=${clone}`)),
      )
    exercised.set(table, fired)
    expect(fired.filter((name) => name !== "seed").length).toBeGreaterThan(0)
  })

test("every watched table's insert, update and delete triggers ran in some step", () => {
  const missing = SCHEDULE_TRIGGERS.filter((spec) => {
    const steps = exercised.get(spec.table) ?? []
    if (spec.event === "INSERT")
      return !steps.some((s) => s === "insert under an upsert" || s === "seed")
    if (spec.event === "UPDATE")
      return !steps.some((s) => s === "update under an upsert" || s === "update")
    return !steps.some((s) => s === "delete" || s === "delete and restore")
  }).map((spec) => `${spec.table} ${spec.event}`)
  expect(missing).toEqual([])
})

import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { RetentionService } from "../retention/service.ts"
import { BACKFILL_TABLES, backfillPage, backfillState } from "./identity-backfill.ts"
import { planKey } from "./identity-keys.ts"
import { planIs } from "./identity-read.ts"
import { asLegacyHistory } from "./identity.fixture.ts"
import { missingKeyIndexes, remainingTextKeyIndexes } from "./transition-indexes.ts"
import { RunnerStore } from "./store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function open() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-identity-backfill-"))
  directories.push(directory)
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), join(directory, "project"))
  repositories.push(repository)
  const store = new RunnerStore(repository)
  return { repository, store }
}

/** Rows as an older build wrote them: no integer keys. */
function seedLegacy(repository: TaskRepository, plans: number, perPlan: number) {
  repository.atomic((db) => {
    for (let plan = 0; plan < plans; plan++) {
      db.query(
        "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES(?,'d','o',1,1,'queued','{}')",
      ).run(`plan-${plan}`)
      for (let row = 0; row < perPlan; row++) {
        db.query(
          "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,'E','{}',1)",
        ).run(`plan-${plan}`, `task-${row % 3}`)
        db.query(
          `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,
             source,sources_json,kind,event_ids_json,dedupe_key,payload)
           VALUES('d','prj',?,?,?,?,1,'s','[]','step','[]',?,'{}')`,
        ).run(
          `plan-${plan}`,
          `task-${row % 3}`,
          `attempt-${plan}-${row % 2}`,
          `ses-${plan}-${row % 2}`,
          `k-${plan}-${row}`,
        )
      }
    }
  })
  // The insert trigger keyed them; make them look like rows from before the columns existed.
  asLegacyHistory(repository)
}

const nulls = (repository: TaskRepository, table: string, column: string) =>
  repository.read(
    (db) =>
      db
        .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table} WHERE ${column} IS NULL`)
        .get()!.n,
  )

test("the writers key a new row; a raw insert is keyed by the trigger in its own transaction", () => {
  const { repository, store } = open()
  repository.atomic((db) =>
    db.exec(
      "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES('p','d','o',1,1,'queued','{}')",
    ),
  )
  // `record` only needs the plan's version; a full plan body is not under test here.
  Object.assign(store, { plan: () => ({ version: 1 }) })
  store.record("p", null, "EVENT", { a: 1 })
  repository.atomic((db) =>
    db.exec(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES('p',NULL,1,'RAW','{}',1)",
    ),
  )
  const key = repository.read((db) => planKey(db, "p"))
  const rows = repository.read((db) =>
    db.query<{ plan_n: number | null }, []>("SELECT plan_n FROM runner_transitions").all(),
  )
  expect(rows).toEqual([{ plan_n: key }, { plan_n: key }])
})

test("backfill keys old rows page by page, then reports complete, without moving observation revisions", () => {
  const { repository } = open()
  seedLegacy(repository, 4, 25)
  const before = repository.read((db) =>
    db.query("SELECT revision FROM observation_revisions").all(),
  )
  const pages: number[] = []
  for (;;) {
    const page = repository.atomic((db) => backfillPage(db, "runner_progress", 30))
    if (page.done) break
    pages.push(page.rows)
  }
  expect(pages).toEqual([30, 30, 30, 10])
  expect(nulls(repository, "runner_progress", "plan_n")).toBe(0)
  expect(nulls(repository, "runner_progress", "attempt_n")).toBe(0)
  expect(nulls(repository, "runner_transitions", "plan_n")).toBe(100)
  const state = repository.read((db) => backfillState(db, "runner_progress"))
  expect(state).toMatchObject({ rowsDone: 100, state: "indexing" })
  // Keys agree with the text ids they replace.
  const mismatched = repository.read(
    (db) =>
      db
        .query<{ n: number }, []>(
          `SELECT count(*) AS n FROM runner_progress p
            WHERE p.plan_n IS NOT (SELECT n FROM lazers_plan_keys WHERE plan_id=p.plan_id)
               OR p.attempt_n IS NOT (SELECT n FROM lazers_attempt_keys WHERE attempt_id=p.attempt_id)`,
        )
        .get()!.n,
  )
  expect(mismatched).toBe(0)
  expect(
    repository.read((db) => db.query("SELECT revision FROM observation_revisions").all()),
  ).toEqual(before)
})

test("rows keyed by a writer while the backfill runs are skipped, not rewritten", () => {
  const { repository } = open()
  seedLegacy(repository, 2, 10)
  repository.atomic((db) => {
    const key = planKey(db, "plan-0")
    db.query("UPDATE runner_transitions SET plan_n=? WHERE plan_id='plan-0'").run(key)
  })
  const page = repository.atomic((db) => backfillPage(db, "runner_transitions", 1_000))
  expect(page.rows).toBe(10)
  expect(nulls(repository, "runner_transitions", "plan_n")).toBe(0)
})

test("the retention idle step backfills, indexes, retires the text indexes, and resumes", async () => {
  const { repository } = open()
  seedLegacy(repository, 3, 20)
  const service = new RetentionService({
    repository,
    host: {} as never,
  })
  // While attempts run: pages only, no index build or drop.
  const busy = await service.backfillKeys(10_000, false)
  expect(busy.rows).toBe(60 + 60)
  repository.read((db) => {
    for (const table of BACKFILL_TABLES) {
      expect(backfillState(db, table).state).toBe("indexing")
      expect(remainingTextKeyIndexes(db, table).length).toBeGreaterThan(0)
    }
  })
  const quiet = await service.backfillKeys(10_000)
  expect(quiet.rows).toBe(0)
  expect(quiet.finished).toBe(true)
  expect(quiet.retired.sort()).toEqual([
    "runner_progress_attempt_seq",
    "runner_progress_plan_recency",
    "runner_transitions_lookup",
    "runner_transitions_plan_event",
    "runner_transitions_plan_id",
    "runner_transitions_task_latest",
  ])
  repository.read((db) => {
    for (const table of BACKFILL_TABLES) {
      expect(backfillState(db, table).state).toBe("text-retired")
      expect(remainingTextKeyIndexes(db, table)).toEqual([])
    }
    expect(missingKeyIndexes(db)).toEqual([])
  })
  expect(await service.backfillKeys(10_000)).toEqual({ rows: 0, retired: [], finished: true })
})

test("a budget used up mid-way resumes from the stored state on a new service", async () => {
  const { repository } = open()
  seedLegacy(repository, 5, 40)
  const first = new RetentionService({ repository, host: {} as never })
  // A zero budget keys nothing; the stored state is the only resume point.
  expect((await first.backfillKeys(0, false)).rows).toBe(0)
  repository.atomic((db) => backfillPage(db, "runner_transitions", 50))
  const second = new RetentionService({ repository, host: {} as never })
  const rest = await second.backfillKeys(10_000)
  expect(rest.rows).toBe(150 + 200)
  expect(rest.finished).toBe(true)
  expect(nulls(repository, "runner_transitions", "plan_n")).toBe(0)
})

test("a reader takes the text predicate until a table is complete, then the integer one, same rows", async () => {
  const { repository } = open()
  seedLegacy(repository, 3, 20)
  const sql = (db: import("bun:sqlite").Database, tail: string) =>
    `SELECT id FROM runner_transitions WHERE ${planIs(db, "runner_transitions")} ${tail}`
  const rows = (db: import("bun:sqlite").Database) =>
    db
      .query<{ id: number }, [string]>(sql(db, "ORDER BY id"))
      .all("plan-1")
      .map((row) => row.id)
  const before = repository.read((db) => {
    expect(planIs(db, "runner_transitions")).toBe("plan_id=?")
    return rows(db)
  })
  expect(before.length).toBe(20)
  const service = new RetentionService({ repository, host: {} as never })
  await service.backfillKeys(10_000)
  repository.read((db) => {
    expect(planIs(db, "runner_transitions")).toContain("plan_n=(SELECT n FROM lazers_plan_keys")
    expect(rows(db)).toEqual(before)
    // An unknown plan has no key and no rows, as with the text column.
    expect(db.query(sql(db, "")).all("nope")).toEqual([])
  })
})

test("an upgrade from a database without the columns adds them and leaves rows readable", () => {
  const { repository } = open()
  seedLegacy(repository, 1, 5)
  repository.atomic((db) => {
    db.exec(
      "DROP TRIGGER runner_transitions_keys; DROP TRIGGER runner_progress_keys; ALTER TABLE runner_transitions DROP COLUMN plan_n; ALTER TABLE runner_progress DROP COLUMN plan_n; ALTER TABLE runner_progress DROP COLUMN attempt_n; DELETE FROM schema_modules WHERE module='runner'",
    )
  })
  new RunnerStore(repository)
  expect(nulls(repository, "runner_transitions", "plan_n")).toBe(5)
  expect(nulls(repository, "runner_progress", "attempt_n")).toBe(5)
  expect(
    repository.read(
      (db) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM runner_transitions").get()!.n,
    ),
  ).toBe(5)
})

test("a new database keys its empty history tables at install: no text index is ever built", async () => {
  const { repository, store } = open()
  await store.transitionIndexes
  repository.read((db) => {
    for (const table of BACKFILL_TABLES) {
      expect(backfillState(db, table).state).toBe("text-retired")
      expect(remainingTextKeyIndexes(db, table)).toEqual([])
    }
    expect(missingKeyIndexes(db)).toEqual([])
    expect(planIs(db, "runner_transitions")).toContain("plan_n=")
  })
  // A reinstall of the runner schema does not bring a text index back.
  repository.atomic((db) => db.exec("DELETE FROM schema_modules WHERE module='runner'"))
  await new RunnerStore(repository).transitionIndexes
  repository.read((db) => {
    for (const table of BACKFILL_TABLES) expect(remainingTextKeyIndexes(db, table)).toEqual([])
  })
})

test("an upgraded database keeps its text indexes until its table is keyed", async () => {
  const { repository } = open()
  seedLegacy(repository, 2, 5)
  repository.atomic((db) => db.exec("DELETE FROM schema_modules WHERE module='runner'"))
  await new RunnerStore(repository).transitionIndexes
  repository.read((db) => {
    for (const table of BACKFILL_TABLES) {
      expect(backfillState(db, table).state).toBe("backfilling")
      expect(remainingTextKeyIndexes(db, table).length).toBeGreaterThan(0)
    }
    expect(planIs(db, "runner_transitions")).toBe("plan_id=?")
  })
})

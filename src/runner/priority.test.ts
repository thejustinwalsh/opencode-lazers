import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { PlanInput } from "./schema.ts"
import {
  MAX_PRIORITY,
  PRIORITY_MIGRATION_TABLE,
  comparePriority,
  hasPriority,
  installPrioritySchema,
  migrateLegacyPriorities,
  planPrioritySortSQL,
} from "./priority.ts"
import { RunnerStore } from "./store.ts"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("1 is top, larger numbers are lower, and 0 or absent sorts after every priority", () => {
  const values = [0, 3, 1, MAX_PRIORITY, -4, 2, null]
  expect(values.toSorted(comparePriority)).toEqual([1, 2, 3, MAX_PRIORITY, 0, -4, null])
  expect(comparePriority(1, 2)).toBeLessThan(0)
  expect(comparePriority(2, 1)).toBeGreaterThan(0)
  expect(comparePriority(0, MAX_PRIORITY)).toBeGreaterThan(0)
  expect(comparePriority(0, undefined)).toBe(0)
  expect(comparePriority(-5, 0)).toBe(0)
  expect([1, MAX_PRIORITY, 0, -1, undefined].map(hasPriority)).toEqual([
    true,
    true,
    false,
    false,
    false,
  ])
})

test("the SQL sort key agrees with comparePriority", () => {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE p(id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
  const bodies = [
    { priority: 5 },
    {},
    { priority: 0 },
    { priority: 1 },
    { priority: -3 },
    { priority: MAX_PRIORITY },
    { priority: 2 },
  ]
  bodies.forEach((body) => db.query("INSERT INTO p(body) VALUES(?)").run(JSON.stringify(body)))
  const sql = db
    .query<{ body: string }, []>(`SELECT body FROM p ORDER BY ${planPrioritySortSQL("body")},id`)
    .all()
    .map((row) => (JSON.parse(row.body) as { priority?: number }).priority)
  expect(sql).toEqual([1, 2, 5, MAX_PRIORITY, undefined, 0, -3])
})

test("plan priority validates as an integer from 0 up to the maximum integer", () => {
  const parse = (priority: number) =>
    PlanInput.safeParse({
      requestID: "r",
      objective: "o",
      baseCommit: "a".repeat(40),
      nodes: [],
      priority,
    })
  const reasons = (priority: number) =>
    parse(priority).error?.issues.some((issue) => issue.path[0] === "priority") ?? false
  expect(reasons(-1)).toBe(true)
  expect(reasons(1.5)).toBe(true)
  expect(reasons(MAX_PRIORITY + 1)).toBe(true)
  for (const valid of [0, 1, 2, MAX_PRIORITY]) expect(reasons(valid)).toBe(false)
})

const planRow = (db: Database, id: string, directory: string, body: object) =>
  db
    .query(
      "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES(?,?,?,1,1,'running',?)",
    )
    .run(id, directory, "owner", JSON.stringify(body))

test("legacy priorities become dense ranks per project and the old values are recorded", () => {
  const db = new Database(":memory:")
  db.exec(`CREATE TABLE runner_plans(
    id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL,
    version INTEGER NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, model TEXT, reason TEXT, artifact TEXT)`)
  const legacy: Array<[string, string, object]> = [
    ["a", "/p", { priority: 100000 }],
    ["b", "/p", { priority: 2075 }],
    ["c", "/p", { priority: 2075 }],
    ["d", "/p", { priority: 5 }],
    ["e", "/p", { priority: 0 }],
    ["f", "/p", { priority: -100 }],
    ["g", "/p", { title: "no stored priority" }],
    ["h", "/q", { priority: 7 }],
    ["i", "/q", { priority: 3 }],
  ]
  for (const [id, directory, body] of legacy) planRow(db, id, directory, body)
  expect(migrateLegacyPriorities(db)).toBe(7)
  const stored = Object.fromEntries(
    db
      .query<{ id: string; priority: number | null }, []>(
        "SELECT id,json_extract(body,'$.priority') AS priority FROM runner_plans",
      )
      .all()
      .map((row) => [row.id, row.priority]),
  )
  expect(stored).toEqual({ a: 1, b: 2, c: 2, d: 3, e: 0, f: 0, g: null, h: 1, i: 2 })
  const log = db
    .query<{ plan_id: string; legacy_priority: number; new_priority: number }, []>(
      `SELECT plan_id,legacy_priority,new_priority FROM ${PRIORITY_MIGRATION_TABLE} ORDER BY plan_id`,
    )
    .all()
  expect(log.map((row) => [row.plan_id, row.legacy_priority, row.new_priority])).toEqual([
    ["a", 100000, 1],
    ["b", 2075, 2],
    ["c", 2075, 2],
    ["d", 5, 3],
    ["e", 0, 0],
    ["f", -100, 0],
    ["h", 7, 1],
    ["i", 3, 2],
  ])
  // Running again converts nothing: the converted values are already in the current direction.
  expect(migrateLegacyPriorities(db)).toBe(0)
  expect(
    db
      .query<{ priority: number }, []>(
        "SELECT json_extract(body,'$.priority') AS priority FROM runner_plans WHERE id='a'",
      )
      .get()!.priority,
  ).toBe(1)
})

test("the priority schema module migrates once at startup and leaves later plans alone", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-priority-"))
  directories.push(directory)
  const path = join(directory, "tasks.sqlite")
  const first = new TaskRepository(path, "/project")
  new RunnerStore(first)
  // Simulate a database whose runner schema predates the priority module.
  first.atomic((db) => {
    planRow(db, "old-high", "/project", { priority: 900 })
    planRow(db, "old-low", "/project", { priority: 10 })
    db.exec(
      `DROP TABLE ${PRIORITY_MIGRATION_TABLE}; DELETE FROM schema_modules WHERE module='priority'`,
    )
  })
  first.close()
  const reopened = new TaskRepository(path, "/project")
  new RunnerStore(reopened)
  const read = (id: string) =>
    reopened.atomic((db) =>
      db
        .query<{ priority: number }, [string]>(
          "SELECT json_extract(body,'$.priority') AS priority FROM runner_plans WHERE id=?",
        )
        .get(id),
    )!.priority
  expect([read("old-high"), read("old-low")]).toEqual([1, 2])
  // A plan stored after the migration uses the new direction and is not converted on reopen.
  reopened.atomic((db) => planRow(db, "new-plan", "/project", { priority: 50 }))
  installPrioritySchema(reopened)
  reopened.close()
  const third = new TaskRepository(path, "/project")
  new RunnerStore(third)
  expect(
    third.atomic((db) =>
      db
        .query<{ priority: number }, []>(
          "SELECT json_extract(body,'$.priority') AS priority FROM runner_plans WHERE id='new-plan'",
        )
        .get(),
    )!.priority,
  ).toBe(50)
  third.close()
})

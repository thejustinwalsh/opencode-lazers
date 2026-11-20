import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "./storage.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "lazers-task-changes-"))
  directories.push(dir)
  return join(dir, "tasks.sqlite")
}
function open(path: string, project: string) {
  const repository = new TaskRepository(path, project)
  repositories.push(repository)
  return repository
}
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const A = "/repo/a"
const B = "/repo/b"

function addTask(repository: TaskRepository, id: string) {
  repository.atomic((db) =>
    db
      .query("INSERT INTO tasks(id,project_directory,created_at,body) VALUES(?,?,?,?)")
      .run(id, repository.projectDirectory, "2026-01-01T00:00:00.000Z", "{}"),
  )
}

/** What every reader takes: newest id of a project, all kinds or one kind. */
function readers(path: string, project: string) {
  const db = new Database(path, { readonly: true })
  try {
    const one = (sql: string) => db.query<{ n: number }, [string]>(sql).get(project)!.n
    return {
      version: one("SELECT COALESCE(MAX(id),0) AS n FROM task_changes WHERE project_directory=?"),
      mutation: one(
        "SELECT COALESCE(MAX(id),0) AS n FROM task_changes WHERE project_directory=? AND kind='mutation'",
      ),
      insert: one(
        "SELECT COALESCE(MAX(id),0) AS n FROM task_changes WHERE project_directory=? AND kind='insert'",
      ),
      rows: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_changes").get()!.n,
    }
  } finally {
    db.close()
  }
}

test("readers see a rising counter across writes and the table does not grow", () => {
  const path = fresh()
  const a = open(path, A)
  const b = open(path, B)
  expect(a.version()).toBe(0)
  const seen: number[] = []
  let model = 0
  for (let step = 0; step < 60; step++) {
    const repository = step % 3 === 0 ? b : a
    if (step % 2 === 0) addTask(repository, `t${step}`)
    else repository.changed()
    const version = repository.version()
    // Same semantics as the append-only log: every bump is a new, larger id.
    expect(version).toBeGreaterThan(model)
    model = version
    seen.push(version)
  }
  expect(new Set(seen).size).toBe(seen.length)
  const view = readers(path, A)
  expect(view.version).toBe(a.version())
  expect(view.version).toBe(Math.max(view.mutation, view.insert))
  // One counter per project and kind: no row is kept per write.
  expect(view.rows).toBeLessThanOrEqual(4)
  const db = new Database(path, { readonly: true })
  try {
    const stamped = db
      .query<{ n: number }, [string]>(
        "SELECT MAX(created_version) AS n FROM tasks WHERE project_directory=?",
      )
      .get(A)!.n
    expect(stamped).toBe(view.insert)
  } finally {
    db.close()
  }
})

test("a snapshot taken before a mutation is detected as stale", () => {
  const path = fresh()
  const repository = open(path, A)
  addTask(repository, "one")
  const snapshot = repository.version()
  expect(readers(path, A).mutation).toBeLessThanOrEqual(snapshot)
  repository.changed()
  expect(readers(path, A).mutation).toBeGreaterThan(snapshot)
})

test("the hot path writes no new row into the retired log", () => {
  const path = fresh()
  const repository = open(path, A)
  for (let index = 0; index < 100; index++) {
    repository.changed()
    addTask(repository, `t${index}`)
  }
  expect(readers(path, A).rows).toBe(2)
})

function downgradeToLegacy(path: string, rows: Array<[number, string, string]>, sequence: number) {
  const db = new Database(path)
  db.exec(`
    DROP TRIGGER tasks_changed;
    DROP TABLE task_changes;
    CREATE TABLE task_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, project_directory TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'insert');
    CREATE INDEX task_changes_project ON task_changes(project_directory, id);
    CREATE TRIGGER tasks_changed AFTER INSERT ON tasks BEGIN
      INSERT INTO task_changes(project_directory) VALUES (NEW.project_directory);
      UPDATE tasks SET created_version = last_insert_rowid() WHERE id = NEW.id;
    END;
    UPDATE schema_modules SET generation=8 WHERE module='tasks';
    PRAGMA user_version=8;
  `)
  db.transaction(() => {
    const add = db.query("INSERT INTO task_changes(id,project_directory,kind) VALUES(?,?,?)")
    for (const row of rows) add.run(...row)
    db.query("UPDATE sqlite_sequence SET seq=? WHERE name='task_changes'").run(sequence)
  })()
  db.close()
}

test("upgrading a populated log keeps what readers see and never reissues an id", () => {
  const path = fresh()
  const seed = open(path, A)
  addTask(seed, "task-a")
  addTask(open(path, B), "task-b")
  for (const repository of repositories.splice(0)) repository.close()

  // Interleaved log of two projects; the newest row overall is a mutation of B, and
  // the sequence ran past the surviving rows (pruned tail), as on the live database.
  const log: Array<[number, string, string]> = []
  for (let id = 1; id <= 400; id++) {
    const project = id % 3 === 0 ? B : A
    log.push([id, project, id % 4 === 0 ? "mutation" : "insert"])
  }
  log.push([401, B, "mutation"])
  downgradeToLegacy(path, log, 450)
  const db = new Database(path)
  // created_version of each project's newest task must equal its newest insert id.
  db.query("UPDATE tasks SET created_version=? WHERE id='task-a'").run(
    Math.max(...log.filter(([, p, k]) => p === A && k === "insert").map(([id]) => id)),
  )
  db.query("UPDATE tasks SET created_version=? WHERE id='task-b'").run(
    Math.max(...log.filter(([, p, k]) => p === B && k === "insert").map(([id]) => id)),
  )
  db.close()
  const before = (project: string) => {
    const mine = log.filter(([, p]) => p === project)
    const ids = (kind?: string) =>
      Math.max(0, ...mine.filter(([, , k]) => !kind || k === kind).map(([id]) => id))
    return { version: ids(), mutation: ids("mutation"), insert: ids("insert") }
  }

  const a = open(path, A)
  const b = open(path, B)
  for (const [project, repository] of [
    [A, a],
    [B, b],
  ] as const) {
    const after = readers(path, project)
    expect({ version: after.version, mutation: after.mutation, insert: after.insert }).toEqual(
      before(project),
    )
    expect(repository.version()).toBe(before(project).version)
  }
  expect(readers(path, A).rows).toBeLessThanOrEqual(4)
  const check = new Database(path, { readonly: true })
  try {
    expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: 9 })
    expect(check.query("SELECT generation FROM schema_modules WHERE module='tasks'").get()).toEqual(
      { generation: 9 },
    )
  } finally {
    check.close()
  }

  // New ids continue past the old sequence, not past the surviving maximum.
  a.changed()
  expect(a.version()).toBe(451)
  addTask(b, "task-b2")
  expect(b.version()).toBe(452)
})

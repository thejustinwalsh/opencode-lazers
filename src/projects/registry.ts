import type { Database } from "bun:sqlite"
import { realpathSync } from "node:fs"
import { basename } from "node:path"
import type { TaskRepository } from "../storage.ts"
import { projectCodeFrom, uniqueProjectCode } from "./code.ts"

export type ProjectRow = { key: string; code: string; name: string; paths: string[] }

/** A rejected code edit; `code` is `PROJECT_CODE_INVALID` or `PROJECT_CODE_TAKEN`. */
export class ProjectCodeError extends Error {
  constructor(readonly code: "PROJECT_CODE_INVALID" | "PROJECT_CODE_TAKEN") {
    super(code)
    this.name = "ProjectCodeError"
  }
}

/** 2-4 letters and up to 12 digits: the longest a task reference (40 characters) can carry. */
const CODE_PATTERN = /^[A-Z]{2,4}\d{0,12}$/

/** The folder name the owner sees for a checkout; the tail of a key when the path is empty. */
export function projectNameFor(path: string, key: string): string {
  return basename(path) || basename(key.replace(/^(?:path|root):/, "")) || key
}

function takenCodes(db: Database): Set<string> {
  return new Set(
    db
      .query<{ code: string }, []>("SELECT code FROM lazers_projects WHERE code IS NOT NULL")
      .all()
      .map((row) => row.code),
  )
}

/** Give a project that has none a unique generated code; stored once, never recomputed. */
export function assignProjectCode(db: Database, key: string, name: string, preferred?: string) {
  const code = uniqueProjectCode(preferred ?? projectCodeFrom(name), takenCodes(db))
  db.query(
    "UPDATE lazers_projects SET code=?, name=COALESCE(name,?) WHERE key=? AND code IS NULL",
  ).run(code, name, key)
}

function rowsOf(db: Database, where: string, ...params: string[]): ProjectRow[] {
  const projects = db
    .query<{ key: string; code: string | null; name: string | null }, string[]>(
      `SELECT key, code, name FROM lazers_projects ${where} ORDER BY created_at, key`,
    )
    .all(...params)
  return projects
    .filter((row) => row.code !== null)
    .map((row) => ({
      key: row.key,
      code: row.code!,
      name: row.name ?? projectNameFor("", row.key),
      paths: db
        .query<{ path: string }, [string]>(
          "SELECT path FROM lazers_project_paths WHERE key=? ORDER BY rowid",
        )
        .all(row.key)
        .map((path) => path.path),
    }))
}

export function projects(repository: TaskRepository): ProjectRow[] {
  return repository.read((db) => rowsOf(db, ""))
}

/** The project a checkout directory belongs to, through `lazers_project_paths`. */
export function projectForDirectory(
  repository: TaskRepository,
  directory: string,
): ProjectRow | undefined {
  let canonical = directory
  try {
    canonical = realpathSync(directory)
  } catch {
    /* A directory that is gone still resolves by its recorded path. */
  }
  return repository.read((db) => {
    const key = db
      .query<{ key: string }, [string, string, string]>(
        "SELECT key FROM lazers_project_paths WHERE path=? OR path=? ORDER BY path=? DESC LIMIT 1",
      )
      .get(directory, canonical, directory)?.key
    return key === undefined ? undefined : rowsOf(db, "WHERE key=?", key)[0]
  })
}

/** The project a directory belongs to, from inside a transaction: key and current code only. */
export function projectCodeForDirectoryIn(
  db: Database,
  directory: string,
): { key: string; code: string } | undefined {
  const row = db
    .query<{ key: string; code: string | null }, [string]>(
      `SELECT p.key AS key, p.code AS code FROM lazers_project_paths pp
         JOIN lazers_projects p ON p.key=pp.key WHERE pp.path=?`,
    )
    .get(directory)
  return row?.code ? { key: row.key, code: row.code } : undefined
}

/**
 * Rewrite every reference of a project that does not carry its current code. The old text stays
 * resolvable as an alias inside the project. A rewritten number already taken by another checkout
 * of the project is replaced by the next free one.
 */
export function recodeReferences(db: Database, key: string): void {
  const code = db
    .query<{ code: string | null }, [string]>("SELECT code FROM lazers_projects WHERE key=?")
    .get(key)?.code
  if (!code) return
  const rows = db
    .query<
      { project_directory: string; task_id: string; reference: string; sequence: number },
      [string, string]
    >(
      `SELECT r.project_directory, r.task_id, r.reference, r.sequence FROM task_references r
         JOIN lazers_project_paths pp ON pp.path=r.project_directory
        WHERE pp.key=? AND r.reference NOT LIKE ? ORDER BY r.rowid`,
    )
    .all(key, `${code}-%`)
  if (rows.length === 0) return
  const current = db
    .query<{ reference: string; sequence: number }, [string, string]>(
      `SELECT r.reference, r.sequence FROM task_references r
         JOIN lazers_project_paths pp ON pp.path=r.project_directory
        WHERE pp.key=? AND r.reference LIKE ?`,
    )
    .all(key, `${code}-%`)
  const used = new Set(current.map((row) => row.reference))
  let highest = Math.max(
    0,
    ...current.map((row) => row.sequence),
    ...rows.map((row) => row.sequence),
  )
  const alias = db.query(
    "INSERT OR IGNORE INTO task_reference_aliases(project_key,alias,task_id) VALUES(?,?,?)",
  )
  const update = db.query(
    "UPDATE task_references SET reference=?, sequence=? WHERE project_directory=? AND task_id=?",
  )
  for (const row of rows) {
    let sequence = row.sequence
    if (used.has(`${code}-${sequence}`)) sequence = ++highest
    const reference = `${code}-${sequence}`
    used.add(reference)
    alias.run(key, row.reference, row.task_id)
    update.run(reference, sequence, row.project_directory, row.task_id)
  }
}

/** Change a project's code. New references use it; old ones keep resolving (see `setProjectCodeIn`). */
export function setProjectCode(repository: TaskRepository, key: string, code: string): void {
  if (!CODE_PATTERN.test(code)) throw new ProjectCodeError("PROJECT_CODE_INVALID")
  repository.atomic((db) => setProjectCodeIn(db, key, code))
}

export function setProjectCodeIn(db: Database, key: string, code: string): void {
  const owner = db
    .query<{ key: string }, [string]>("SELECT key FROM lazers_projects WHERE code=?")
    .get(code)
  if (owner && owner.key !== key) throw new ProjectCodeError("PROJECT_CODE_TAKEN")
  db.query("UPDATE lazers_projects SET code=? WHERE key=?").run(code, key)
  recodeReferences(db, key)
}

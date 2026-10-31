import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { TaskSpecSchema } from "./task.ts"
import type { TaskSpec } from "./task.ts"
import { fingerprint } from "./identity.ts"

export function taskDatabasePath(dataDirectory?: string): string {
  const directory =
    dataDirectory ??
    join(
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "opencode",
      "plugins",
      "lazers",
    )
  if (!isAbsolute(directory)) throw new Error("LAZERS dataDirectory must be an absolute path")
  return join(directory, "tasks.sqlite")
}

export class TaskRepository {
  private connection: Database | undefined
  private readonly listeners = new Set<() => void>()

  private get db(): Database {
    if (!this.connection) this.connection = this.open()
    return this.connection
  }

  constructor(
    readonly path: string,
    readonly projectDirectory: string,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.connection = this.open()
  }

  private open(): Database {
    const db = new Database(this.path, { create: true, strict: true })
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON")
      db.transaction(() => {
        const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!
          .user_version
        if (version > 3) throw new Error(`Unsupported LAZERS database version ${version}`)
        db.exec(`
          CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            project_directory TEXT NOT NULL,
            created_at TEXT NOT NULL,
            body TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS tasks_project_created
            ON tasks(project_directory, created_at);
        `)
        if (version < 2) {
          db.exec(`
            ALTER TABLE tasks ADD COLUMN created_version INTEGER NOT NULL DEFAULT 0;
            UPDATE tasks SET created_version = rowid;
            CREATE TABLE task_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, project_directory TEXT NOT NULL);
            INSERT INTO task_changes (id, project_directory) SELECT rowid, project_directory FROM tasks;
            CREATE INDEX task_changes_project ON task_changes(project_directory, id);
            CREATE TRIGGER tasks_changed AFTER INSERT ON tasks BEGIN
              INSERT INTO task_changes(project_directory) VALUES (NEW.project_directory);
              UPDATE tasks SET created_version = last_insert_rowid() WHERE id = NEW.id;
            END;
            CREATE TABLE submission_requests (
              project_directory TEXT NOT NULL,
              request_id TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              task_id TEXT NOT NULL REFERENCES tasks(id),
              PRIMARY KEY(project_directory, request_id)
            );
            PRAGMA user_version = 2;
          `)
        }
        if (version < 3)
          db.exec(
            "ALTER TABLE task_changes ADD COLUMN kind TEXT NOT NULL DEFAULT 'insert'; PRAGMA user_version=3",
          )
      }).immediate()
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  /** Server-side domain services share transactions, never expose SQL to agents/RPC. */
  atomic<T>(run: (db: Database) => T): T {
    return this.db.transaction(() => run(this.db)).immediate()
  }

  changed(): void {
    this.db
      .query("INSERT INTO task_changes(project_directory,kind) VALUES (?,'mutation')")
      .run(this.projectDirectory)
  }

  submitOnce(requestID: string, proposal: unknown, create: () => unknown) {
    if (!requestID.trim() || requestID.length > 200)
      throw new Error("requestID must contain 1–200 characters")
    const hash = fingerprint(proposal)
    return this.atomic((db) => {
      const existing = db
        .query<{ fingerprint: string; task_id: string }, [string, string]>(
          "SELECT fingerprint, task_id FROM submission_requests WHERE project_directory = ? AND request_id = ?",
        )
        .get(this.projectDirectory, requestID)
      if (existing) {
        if (existing.fingerprint !== hash)
          return {
            status: "conflict" as const,
            message: "requestID already identifies different validated content",
          }
        return { status: "submitted" as const, taskID: existing.task_id, revision: 1 as const }
      }
      const task = this.insert(create())
      db.query("INSERT INTO submission_requests VALUES (?, ?, ?, ?)").run(
        this.projectDirectory,
        requestID,
        hash,
        task.id,
      )
      return { status: "submitted" as const, taskID: task.id, revision: task.revision }
    })
  }

  submissionReceipt(key: string, proposal: unknown) {
    const existing = this.db
      .query<{ fingerprint: string; task_id: string }, [string, string]>(
        "SELECT fingerprint,task_id FROM submission_requests WHERE project_directory=? AND request_id=?",
      )
      .get(this.projectDirectory, key)
    if (!existing) return undefined
    return existing.fingerprint === fingerprint(proposal)
      ? { status: "submitted" as const, taskID: existing.task_id, revision: 1 as const }
      : {
          status: "conflict" as const,
          message: "idempotencyKey already identifies different validated content",
        }
  }

  insert(input: unknown): TaskSpec {
    const task = TaskSpecSchema.parse(input)
    if (task.provenance.projectDirectory !== this.projectDirectory) {
      throw new Error("Task provenance does not match this repository")
    }
    this.db
      .query("INSERT INTO tasks (id, project_directory, created_at, body) VALUES (?, ?, ?, ?)")
      .run(task.id, this.projectDirectory, task.createdAt, JSON.stringify(task))
    // Notifications are best effort after the durable write, never part of its receipt.
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* A read observer cannot undo a committed submission. */
      }
    }
    return task
  }

  version(): number {
    return this.db
      .query<{ version: number }, [string]>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM task_changes WHERE project_directory = ?",
      )
      .get(this.projectDirectory)!.version
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readPage(input: {
    search: string
    scopePath?: string
    sessionID?: string
    limit: number
    snapshot?: number
    before?: number
    includeCompleted?: boolean
  }) {
    return this.db.transaction(() => {
      const current = this.version()
      const version = input.snapshot ?? current
      if (version > current) throw new Error("Task snapshot is unavailable; start a fresh query")
      if (input.snapshot !== undefined) {
        const mutation = this.db
          .query<{ n: number }, [string]>(
            "SELECT COALESCE(MAX(id),0) AS n FROM task_changes WHERE project_directory=? AND kind='mutation'",
          )
          .get(this.projectDirectory)!.n
        if (mutation > input.snapshot)
          throw new Error("Task execution changed; start a fresh query")
      }
      const clauses = ["project_directory = ?", "created_version <= ?"]
      const values: (string | number)[] = [this.projectDirectory, version]
      if (input.includeCompleted === false)
        clauses.push(
          "NOT EXISTS (SELECT 1 FROM runner_nodes n WHERE n.task_id=tasks.id AND n.state IN ('accepted','incorporated','cancelled'))",
        )
      if (input.sessionID) {
        clauses.push("json_extract(body, '$.provenance.sessionID') = ?")
        values.push(input.sessionID)
      }
      if (input.search) {
        clauses.push("instr(lower(body), lower(?)) > 0")
        values.push(input.search)
      }
      if (input.scopePath) {
        clauses.push(
          "EXISTS (SELECT 1 FROM json_each(json_extract(tasks.body, '$.proposal.writeScope')) WHERE instr(lower(value), lower(?)) > 0)",
        )
        values.push(input.scopePath)
      }
      const where = clauses.join(" AND ")
      const count = this.db
        .query<{ count: number }, (string | number)[]>(
          `SELECT COUNT(*) AS count FROM tasks WHERE ${where}`,
        )
        .get(...values)!.count
      const before = input.before === undefined ? "" : " AND rowid < ?"
      const rows = this.db
        .query<{ body: string; position: number }, (string | number)[]>(
          `SELECT body, rowid AS position FROM tasks WHERE ${where}${before} ORDER BY rowid DESC LIMIT ?`,
        )
        .all(...values, ...(input.before === undefined ? [] : [input.before]), input.limit + 1)
      return {
        version,
        count,
        rows: rows.map((row) => ({
          position: row.position,
          task: TaskSpecSchema.parse(JSON.parse(row.body)),
        })),
      }
    })()
  }

  get(id: string): TaskSpec | undefined {
    const row = this.db
      .query<{ body: string }, [string, string]>(
        "SELECT body FROM tasks WHERE project_directory = ? AND id = ?",
      )
      .get(this.projectDirectory, id)
    return row ? TaskSpecSchema.parse(JSON.parse(row.body)) : undefined
  }

  list(limit = 20): TaskSpec[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Use a limit from 1 to 100")
    return this.db
      .query<{ body: string }, [string, number]>(
        "SELECT body FROM tasks WHERE project_directory = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(this.projectDirectory, limit)
      .map((row) => TaskSpecSchema.parse(JSON.parse(row.body)))
  }

  close(): void {
    this.listeners.clear()
    this.connection?.close()
    this.connection = undefined
  }
}

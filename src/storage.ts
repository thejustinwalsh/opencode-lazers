import { Database, SQLiteError } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { IdempotencyKeySchema, TaskProposalSchema, TaskSpecSchema } from "./task.ts"
import type { TaskSpec } from "./task.ts"
import { canonical, fingerprint } from "./identity.ts"
import {
  dispositionPayload,
  TaskDispositionInput,
  TaskDispositionRecord,
  type TaskDispositionRecord as TaskDispositionRecordType,
} from "./task-disposition.ts"

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
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON")
      const version = () =>
        db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
      const initial = version()
      if (initial > 4) throw new Error(`Unsupported LAZERS database version ${initial}`)
      // SQLite can fail a concurrent first WAL transition immediately despite
      // busy_timeout. Retry only connection configuration, never a task write.
      const deadline = Date.now() + 5_000
      for (;;) {
        try {
          db.exec("PRAGMA journal_mode = WAL")
          break
        } catch (error) {
          if (
            !(error instanceof SQLiteError) ||
            error.code !== "SQLITE_BUSY" ||
            Date.now() >= deadline
          )
            throw error
          Bun.sleepSync(10)
        }
      }
      db.transaction(() => {
        const current = version()
        if (current > 4) throw new Error(`Unsupported LAZERS database version ${current}`)
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
        if (current < 2) {
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
        if (current < 3)
          db.exec(
            "ALTER TABLE task_changes ADD COLUMN kind TEXT NOT NULL DEFAULT 'insert'; PRAGMA user_version=3",
          )
        if (current < 4)
          db.exec(`
            CREATE TABLE IF NOT EXISTS task_dispositions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_directory TEXT NOT NULL,
              task_id TEXT NOT NULL REFERENCES tasks(id),
              request_id TEXT NOT NULL,
              payload TEXT NOT NULL,
              disposition TEXT NOT NULL,
              reason TEXT NOT NULL,
              evidence TEXT NOT NULL,
              related_task_ids TEXT NOT NULL,
              session_id TEXT NOT NULL,
              agent TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(project_directory, request_id)
            );
            CREATE INDEX IF NOT EXISTS task_dispositions_current
              ON task_dispositions(project_directory, task_id, id DESC);
            PRAGMA user_version=4;
          `)
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

  submitOnce(key: string, proposal: unknown, create: () => unknown) {
    IdempotencyKeySchema.parse(key)
    const validated = TaskProposalSchema.parse(proposal)
    const content = canonical(validated)
    let inserted = false
    // The write lock covers lookup, lazy provenance collection, and both inserts.
    // No competing caller can collect provenance or reserve this key in between.
    const receipt = this.atomic((db) => {
      const existing = db
        .query<{ body: string }, [string, string]>(
          `SELECT t.body FROM submission_requests r JOIN tasks t ON t.id = r.task_id
           AND t.project_directory = r.project_directory
           WHERE r.project_directory = ? AND r.request_id = ?`,
        )
        .get(this.projectDirectory, key)
      if (existing) {
        const task = TaskSpecSchema.parse(JSON.parse(existing.body))
        // Compare full validated structure, not just a potentially colliding hash.
        if (canonical(task.proposal) !== content)
          return {
            status: "conflict" as const,
            message: "idempotencyKey already identifies different validated content",
          }
        return { status: "submitted" as const, taskID: task.id, revision: task.revision }
      }
      const task = TaskSpecSchema.parse(create())
      if (canonical(task.proposal) !== content)
        throw new Error("Task proposal does not match validated submission")
      this.persist(task)
      db.query(
        `INSERT INTO submission_requests
        (project_directory, request_id, fingerprint, task_id) VALUES (?, ?, ?, ?)`,
      ).run(this.projectDirectory, key, fingerprint(validated), task.id)
      inserted = true
      return { status: "submitted" as const, taskID: task.id, revision: task.revision }
    })
    if (inserted) this.notify()
    return receipt
  }

  insert(input: unknown): TaskSpec {
    const task = TaskSpecSchema.parse(input)
    this.persist(task)
    this.notify()
    return task
  }

  private persist(task: TaskSpec): void {
    if (task.provenance.projectDirectory !== this.projectDirectory) {
      throw new Error("Task provenance does not match this repository")
    }
    this.db
      .query("INSERT INTO tasks (id, project_directory, created_at, body) VALUES (?, ?, ?, ?)")
      .run(task.id, this.projectDirectory, task.createdAt, JSON.stringify(task))
  }

  private notify(): void {
    // Notifications are best effort after the durable write, never part of its receipt.
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* A read observer cannot undo a committed submission. */
      }
    }
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
    includeRetired?: boolean
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
          "NOT EXISTS (SELECT 1 FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id WHERE n.task_id=tasks.id AND p.project_directory=tasks.project_directory AND p.state='cancelled')",
        )
      if (input.includeRetired !== true)
        clauses.push(
          "NOT EXISTS (SELECT 1 FROM task_dispositions d WHERE d.project_directory=tasks.project_directory AND d.task_id=tasks.id)",
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

  list(limit = 20, includeRetired = false): TaskSpec[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Use a limit from 1 to 100")
    const retired = includeRetired
      ? ""
      : " AND NOT EXISTS (SELECT 1 FROM task_dispositions d WHERE d.project_directory=tasks.project_directory AND d.task_id=tasks.id)"
    return this.db
      .query<{ body: string }, [string, number]>(
        `SELECT body FROM tasks WHERE project_directory = ?${retired} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(this.projectDirectory, limit)
      .map((row) => TaskSpecSchema.parse(JSON.parse(row.body)))
  }

  /** Return the latest durable disposition without changing the immutable task. */
  taskDisposition(taskID: string): TaskDispositionRecordType | undefined {
    const row = this.db
      .query<DispositionRow, [string, string]>(
        "SELECT * FROM task_dispositions WHERE project_directory=? AND task_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(this.projectDirectory, taskID)
    return row ? dispositionRecord(row) : undefined
  }

  /** Return the append-only disposition history for a project-local task. */
  taskDispositionHistory(taskID: string): TaskDispositionRecordType[] {
    return this.db
      .query<DispositionRow, [string, string]>(
        "SELECT * FROM task_dispositions WHERE project_directory=? AND task_id=? ORDER BY id",
      )
      .all(this.projectDirectory, taskID)
      .map(dispositionRecord)
  }

  recordDisposition(
    input: unknown,
    actor: { sessionID: string; agent: string },
  ): DispositionReceipt {
    const parsed = TaskDispositionInput.parse(input)
    let changed = false
    const receipt = this.atomic((db) => {
      const payload = canonical(dispositionPayload(parsed))
      const existingRequest = db
        .query<DispositionRow, [string, string]>(
          "SELECT * FROM task_dispositions WHERE project_directory=? AND request_id=?",
        )
        .get(this.projectDirectory, parsed.requestID)
      if (existingRequest) {
        if (existingRequest.payload !== payload)
          return {
            status: "conflict" as const,
            taskID: parsed.taskID,
            message: "requestID already identifies different disposition content",
          }
        return {
          status: "replayed" as const,
          taskID: existingRequest.task_id,
          disposition: dispositionRecord(existingRequest),
        }
      }
      const task = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM tasks WHERE project_directory=? AND id=?",
        )
        .get(this.projectDirectory, parsed.taskID)
      if (!task) throw new Error("Task not found in this project")
      if (parsed.relatedTaskIDs.length) {
        const placeholders = parsed.relatedTaskIDs.map(() => "?").join(",")
        const found = db
          .query<{ count: number }, (string | number)[]>(
            `SELECT COUNT(*) AS count FROM tasks WHERE project_directory=? AND id IN (${placeholders})`,
          )
          .get(this.projectDirectory, ...parsed.relatedTaskIDs)!.count
        if (found !== parsed.relatedTaskIDs.length)
          throw new Error("Related task must belong to this project")
      }
      const current = db
        .query<DispositionRow, [string, string]>(
          "SELECT * FROM task_dispositions WHERE project_directory=? AND task_id=? ORDER BY id DESC LIMIT 1",
        )
        .get(this.projectDirectory, parsed.taskID)
      if (current)
        return {
          status: "already_disposed" as const,
          taskID: parsed.taskID,
          disposition: dispositionRecord(current),
        }

      const activeStates = ["queued", "ready", "running", "verifying", "blocked", "exhausted"]
      const states = hasTable(db, "runner_nodes")
        ? db
            .query<{ state: string }, [string, string]>(
              `SELECT n.state FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
               WHERE p.project_directory=? AND n.task_id=?`,
            )
            .all(this.projectDirectory, parsed.taskID)
            .map((row) => row.state)
        : []
      if (states.some((state) => activeStates.includes(state)))
        throw new Error("Cannot dispose a task with active execution")
      if (
        parsed.disposition === "fulfilled" &&
        states.length > 0 &&
        states.some((state) => !["accepted", "incorporated"].includes(state))
      )
        throw new Error("Fulfilled disposition requires accepted execution or reviewed evidence")

      db.query(
        `INSERT INTO task_dispositions
         (project_directory,task_id,request_id,payload,disposition,reason,evidence,related_task_ids,session_id,agent,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        this.projectDirectory,
        parsed.taskID,
        parsed.requestID,
        payload,
        parsed.disposition,
        parsed.reason,
        JSON.stringify(parsed.evidence),
        JSON.stringify(parsed.relatedTaskIDs),
        actor.sessionID,
        actor.agent,
        new Date().toISOString(),
      )
      this.changed()
      changed = true
      const record = db
        .query<DispositionRow, [string, string]>(
          "SELECT * FROM task_dispositions WHERE project_directory=? AND request_id=?",
        )
        .get(this.projectDirectory, parsed.requestID)!
      return {
        status: "recorded" as const,
        taskID: parsed.taskID,
        disposition: dispositionRecord(record),
      }
    })
    if (changed) this.notify()
    return receipt
  }

  close(): void {
    this.listeners.clear()
    this.connection?.close()
    this.connection = undefined
  }
}

type DispositionRow = {
  id: number
  project_directory: string
  task_id: string
  request_id: string
  payload: string
  disposition: string
  reason: string
  evidence: string
  related_task_ids: string
  session_id: string
  agent: string
  created_at: string
}

export type DispositionReceipt =
  | {
      status: "recorded" | "replayed" | "already_disposed"
      taskID: string
      disposition: TaskDispositionRecordType
    }
  | { status: "conflict"; taskID: string; message: string }

function hasTable(db: Database, name: string): boolean {
  return Boolean(
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(name),
  )
}

function dispositionRecord(row: DispositionRow): TaskDispositionRecordType {
  return TaskDispositionRecord.parse({
    id: row.id,
    taskID: row.task_id,
    requestID: row.request_id,
    disposition: row.disposition,
    reason: row.reason,
    evidence: JSON.parse(row.evidence),
    relatedTaskIDs: JSON.parse(row.related_task_ids),
    sessionID: row.session_id,
    agent: row.agent,
    createdAt: row.created_at,
  })
}

import { scheduledTaskPageSQL } from "./tasks/schedule-order.ts"
import { Database, SQLiteError } from "bun:sqlite"
import { schemaModules } from "./database-schema.ts"
import { installTaskAdviceSchema } from "./tasks/advice.ts"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import {
  IdempotencyKeySchema,
  TaskProposalSchema,
  TaskReferenceSchema,
  TaskSpecSchema,
} from "./task.ts"
import type { TaskSpec } from "./task.ts"
import {
  TaskClassificationAnnotationInput,
  TaskClassificationAnnotationRecord,
  TaskClassificationAnnotationReceipt,
} from "./task-classification.ts"
import type {
  TaskClassificationAnnotationRecord as TaskClassificationAnnotationRecordType,
  TaskClassificationAnnotationReceipt as TaskClassificationAnnotationReceiptType,
  TaskClassificationSnapshot,
} from "./task-classification.ts"
import { taskClassificationFor } from "./tasks/classification.ts"
import {
  TaskCorrectionInput,
  TaskCorrectionRecord,
  TaskCorrectionReceipt,
} from "./task-correction.ts"
import type {
  TaskCorrectionRecord as TaskCorrectionRecordType,
  TaskCorrectionReceipt as TaskCorrectionReceiptType,
} from "./task-correction.ts"
import { effectiveTaskStateFilter, taskStatePredicate } from "./tasks/state-filter.ts"
import type { TaskQueryState } from "./tasks/state-filter.ts"
import { canonical, fingerprint } from "./identity.ts"
import { databaseChanges } from "./database-events.ts"
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
    try {
      installTaskAdviceSchema(this)
    } catch (error) {
      this.connection.close()
      this.connection = undefined
      throw error
    }
  }

  private open(): Database {
    const db = new Database(this.path, { create: true, strict: true })
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON")
      const version = () =>
        db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
      const initial = version()
      if (initial > 8) throw new Error(`Unsupported LAZERS database version ${initial}`)
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
      if (initial < 8)
        db.transaction(() => {
          const current = version()
          if (current > 8) throw new Error(`Unsupported LAZERS database version ${current}`)
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
          if (current < 5) {
            db.exec(`
            CREATE TABLE task_references (
              project_directory TEXT NOT NULL,
              task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
              reference TEXT NOT NULL,
              sequence INTEGER NOT NULL CHECK(sequence > 0),
              PRIMARY KEY(project_directory, task_id),
              UNIQUE(project_directory, reference),
              UNIQUE(project_directory, sequence)
            );
            CREATE INDEX task_references_project ON task_references(project_directory, reference);
          `)
            const rows = db
              .query<{ id: string; project_directory: string }, []>(
                "SELECT id, project_directory FROM tasks ORDER BY rowid",
              )
              .all()
            const nextByProject = new Map<string, number>()
            const addReference = db.query(
              "INSERT INTO task_references(project_directory, task_id, reference, sequence) VALUES(?,?,?,?)",
            )
            for (const row of rows) {
              const sequence = (nextByProject.get(row.project_directory) ?? 0) + 1
              nextByProject.set(row.project_directory, sequence)
              addReference.run(row.project_directory, row.id, `LZ-${sequence}`, sequence)
            }
            db.exec("PRAGMA user_version=5")
          }
          if (current < 6)
            db.exec(`
            CREATE TABLE task_classifications (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_directory TEXT NOT NULL,
              task_id TEXT NOT NULL REFERENCES tasks(id),
              request_id TEXT NOT NULL,
              payload TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK(revision > 0),
              classification TEXT NOT NULL,
              reason TEXT NOT NULL,
              session_id TEXT NOT NULL,
              agent TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(project_directory, request_id),
              UNIQUE(project_directory, task_id, revision)
            );
            CREATE INDEX task_classifications_history
              ON task_classifications(project_directory, task_id, revision);
            CREATE TRIGGER task_classifications_no_update BEFORE UPDATE ON task_classifications
            BEGIN SELECT RAISE(ABORT, 'Task classification annotations are append-only'); END;
            CREATE TRIGGER task_classifications_no_delete BEFORE DELETE ON task_classifications
            BEGIN SELECT RAISE(ABORT, 'Task classification annotations are append-only'); END;
            PRAGMA user_version=6;
          `)
          if (current < 7)
            db.exec(`
            CREATE TABLE task_corrections (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_directory TEXT NOT NULL,
              task_id TEXT NOT NULL REFERENCES tasks(id),
              original_task_id TEXT REFERENCES tasks(id),
              request_id TEXT NOT NULL,
              payload TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK(revision > 0),
              reason TEXT NOT NULL,
              session_id TEXT NOT NULL,
              agent TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(project_directory, request_id),
              UNIQUE(project_directory, task_id, revision),
              CHECK(original_task_id IS NULL OR original_task_id <> task_id)
            );
            CREATE INDEX task_corrections_history
              ON task_corrections(project_directory, task_id, revision);
            CREATE TRIGGER task_corrections_no_update BEFORE UPDATE ON task_corrections
            BEGIN SELECT RAISE(ABORT, 'Task correction annotations are append-only'); END;
            CREATE TRIGGER task_corrections_no_delete BEFORE DELETE ON task_corrections
            BEGIN SELECT RAISE(ABORT, 'Task correction annotations are append-only'); END;
            PRAGMA user_version=7;
          `)
          if (current < 8)
            db.exec(`
          CREATE TABLE schema_modules (
            module TEXT PRIMARY KEY,generation INTEGER NOT NULL,tables_json TEXT NOT NULL,installed_at INTEGER NOT NULL
          );
          PRAGMA user_version=8;
        `)
          db.query("INSERT OR IGNORE INTO schema_modules VALUES(?,?,?,?)").run(
            "tasks",
            8,
            JSON.stringify(schemaModules.tasks.tables),
            Date.now(),
          )
        }).immediate()
      databaseChanges.track(db, this.path)
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

  /** Single-statement reads do not acquire a write reservation. */
  read<T>(run: (db: Database) => T): T {
    return run(this.db)
  }

  /** Module upgrades are transactional; current generations need no write transaction. */
  installSchema(
    module: string,
    generation: number,
    tables: readonly string[],
    install: (db: Database) => void,
  ): void {
    const read = () =>
      this.db
        .query<{ generation: number }, [string]>(
          "SELECT generation FROM schema_modules WHERE module=?",
        )
        .get(module)
    const needsInstall = () => {
      const stored = read()?.generation
      if (stored !== undefined && stored > generation)
        throw new Error(`Unsupported LAZERS schema module ${module} generation ${stored}`)
      return stored === undefined || stored < generation
    }
    if (!needsInstall()) return
    this.atomic((db) => {
      if (!needsInstall()) return
      install(db)
      db.query(
        `INSERT INTO schema_modules VALUES(?,?,?,?) ON CONFLICT(module)
        DO UPDATE SET generation=excluded.generation,tables_json=excluded.tables_json,installed_at=excluded.installed_at`,
      ).run(module, generation, JSON.stringify(tables), Date.now())
    })
  }

  /** Advisory startup inventory: report drift without repairing or deleting data. */
  schemaDrift() {
    const actual = new Set(
      this.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((row) => row.name),
    )
    const installed = new Map(
      this.db
        .query<{ module: string; generation: number }, []>(
          "SELECT module,generation FROM schema_modules",
        )
        .all()
        .map((row) => [row.module, row.generation]),
    )
    const declarations = Object.entries(schemaModules)
    const declared = new Set<string>(declarations.flatMap(([, entry]) => [...entry.tables]))
    return {
      undeclaredTables: [...actual].filter((table) => !declared.has(table)),
      missingTables: [...declared].filter((table) => !actual.has(table)),
      generationDrift: declarations.flatMap(([module, entry]) => {
        const generation = installed.get(module) ?? null
        return generation === entry.generation
          ? []
          : [{ module, installed: generation, declared: entry.generation }]
      }),
    }
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
        return {
          status: "submitted" as const,
          taskID: task.id,
          reference: this.referenceIn(db, task.id),
          revision: task.revision,
        }
      }
      // Missing classification remains admissible only when it is the exact
      // content of an already-reserved legacy request. Never create a default.
      if (!validated.classification)
        return {
          status: "invalid" as const,
          errors: [
            {
              path: "classification",
              message: "Choose one explicit task-kind/v1 primaryKind for a new task",
            },
          ],
        }
      const task = TaskSpecSchema.parse(create())
      if (canonical(task.proposal) !== content)
        throw new Error("Task proposal does not match validated submission")
      this.persist(db, task)
      const reference = this.allocateReference(db, task.id)
      db.query(
        `INSERT INTO submission_requests
        (project_directory, request_id, fingerprint, task_id) VALUES (?, ?, ?, ?)`,
      ).run(this.projectDirectory, key, fingerprint(validated), task.id)
      inserted = true
      return { status: "submitted" as const, taskID: task.id, reference, revision: task.revision }
    })
    if (inserted) this.notify()
    return receipt
  }

  insert(input: unknown): TaskSpec {
    const task = TaskSpecSchema.parse(input)
    this.atomic((db) => {
      this.persist(db, task)
      this.allocateReference(db, task.id)
    })
    this.notify()
    return task
  }

  private persist(db: Database, task: TaskSpec): void {
    if (task.provenance.projectDirectory !== this.projectDirectory) {
      throw new Error("Task provenance does not match this repository")
    }
    db.query("INSERT INTO tasks (id, project_directory, created_at, body) VALUES (?, ?, ?, ?)").run(
      task.id,
      this.projectDirectory,
      task.createdAt,
      JSON.stringify(task),
    )
  }

  private allocateReference(db: Database, taskID: string): string {
    const existing = db
      .query<{ reference: string }, [string, string]>(
        "SELECT reference FROM task_references WHERE project_directory=? AND task_id=?",
      )
      .get(this.projectDirectory, taskID)?.reference
    if (existing) return existing
    const sequence = db
      .query<{ sequence: number }, [string]>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_references WHERE project_directory=?",
      )
      .get(this.projectDirectory)!.sequence
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw new Error("Task reference sequence is exhausted")
    const reference = `LZ-${sequence}`
    db.query(
      "INSERT INTO task_references(project_directory, task_id, reference, sequence) VALUES(?,?,?,?)",
    ).run(this.projectDirectory, taskID, reference, sequence)
    return reference
  }

  private referenceIn(db: Database, taskID: string): string {
    const row = db
      .query<{ reference: string }, [string, string]>(
        "SELECT reference FROM task_references WHERE project_directory=? AND task_id=?",
      )
      .get(this.projectDirectory, taskID)
    if (!row) throw new Error("Task reference is missing from this repository")
    return TaskReferenceSchema.parse(row.reference)
  }

  referenceFor(taskID: string): string | undefined {
    return this.db
      .query<{ reference: string }, [string, string]>(
        "SELECT reference FROM task_references WHERE project_directory=? AND task_id=?",
      )
      .get(this.projectDirectory, taskID)?.reference
  }

  resolveTaskID(idOrReference: string): string | undefined {
    if (TaskReferenceSchema.safeParse(idOrReference).success) {
      return this.db
        .query<{ task_id: string }, [string, string]>(
          "SELECT task_id FROM task_references WHERE project_directory=? AND reference=?",
        )
        .get(this.projectDirectory, idOrReference)?.task_id
    }
    return this.db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM tasks WHERE project_directory=? AND id=?",
      )
      .get(this.projectDirectory, idOrReference)?.id
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
    sort?: "recent" | "schedule"
    search: string
    scopePath?: string
    sessionID?: string
    limit: number
    snapshot?: number
    before?: number
    state?: TaskQueryState
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
      const clauses = ["tasks.project_directory = ?", "tasks.created_version <= ?"]
      const values: (string | number)[] = [this.projectDirectory, version]
      const statePredicate = taskStatePredicate(
        effectiveTaskStateFilter(input.state, input.includeCompleted),
        "tasks",
      )
      if (statePredicate) clauses.push(statePredicate)
      if (input.includeRetired !== true)
        clauses.push(
          "NOT EXISTS (SELECT 1 FROM task_dispositions d WHERE d.project_directory=tasks.project_directory AND d.task_id=tasks.id)",
        )
      if (input.sessionID) {
        clauses.push("json_extract(tasks.body, '$.provenance.sessionID') = ?")
        values.push(input.sessionID)
      }
      if (input.search) {
        clauses.push(`(
          instr(lower(tasks.body), lower(?)) > 0 OR EXISTS (
            SELECT 1 FROM task_references r
            WHERE r.project_directory=tasks.project_directory AND r.task_id=tasks.id
              AND instr(lower(r.reference), lower(?)) > 0
          )
        )`)
        values.push(input.search)
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
      const before = input.before === undefined ? "" : " AND tasks.rowid < ?"
      const rows = this.db
        .query<{ body: string; position: number; reference: string }, (string | number)[]>(
          input.sort === "schedule"
            ? scheduledTaskPageSQL("tasks", where, input.before !== undefined)
            : `SELECT tasks.body, tasks.rowid AS position, task_references.reference
           FROM tasks JOIN task_references ON task_references.project_directory=tasks.project_directory
             AND task_references.task_id=tasks.id
           WHERE ${where}${before} ORDER BY tasks.rowid DESC LIMIT ?`,
        )
        .all(...values, ...(input.before === undefined ? [] : [input.before]), input.limit + 1)
      return {
        version,
        count,
        rows: rows.map((row) => {
          const task = TaskSpecSchema.parse(JSON.parse(row.body))
          return {
            position: row.position,
            task,
            reference: TaskReferenceSchema.parse(row.reference),
            classification: taskClassificationFor(this.db, this.projectDirectory, task).current,
          }
        }),
      }
    })()
  }

  get(id: string): TaskSpec | undefined {
    const taskID = this.resolveTaskID(id)
    if (!taskID) return undefined
    const row = this.db
      .query<{ body: string }, [string, string]>(
        "SELECT body FROM tasks WHERE project_directory = ? AND id = ?",
      )
      .get(this.projectDirectory, taskID)
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

  /** Effective metadata is read independently from the immutable task body. */
  taskClassification(taskID: string): TaskClassificationSnapshot | undefined {
    return this.db
      .transaction(() => {
        const db = this.db
        const row = db
          .query<{ body: string }, [string, string]>(
            "SELECT body FROM tasks WHERE project_directory=? AND id=?",
          )
          .get(this.projectDirectory, taskID)
        if (!row) return undefined
        const task = TaskSpecSchema.parse(JSON.parse(row.body))
        return taskClassificationFor(db, this.projectDirectory, task)
      })
      .deferred()
  }

  recordTaskClassification(
    input: unknown,
    actor: { sessionID: string; agent: string },
  ): TaskClassificationAnnotationReceiptType {
    const parsed = TaskClassificationAnnotationInput.parse(input)
    let changed = false
    const receipt = this.atomic((db) => {
      const payload = canonical({
        taskID: parsed.taskID,
        expectedRevision: parsed.expectedRevision,
        classification: parsed.classification,
        reason: parsed.reason,
      })
      const existing = db
        .query<ClassificationRow, [string, string]>(
          "SELECT * FROM task_classifications WHERE project_directory=? AND request_id=?",
        )
        .get(this.projectDirectory, parsed.requestID)
      if (existing) {
        if (existing.payload !== payload)
          return TaskClassificationAnnotationReceipt.parse({
            status: "conflict",
            taskID: parsed.taskID,
            message: "requestID already identifies different classification content",
          })
        return TaskClassificationAnnotationReceipt.parse({
          status: "replayed",
          annotation: classificationRecord(existing),
        })
      }

      const taskRow = db
        .query<{ body: string }, [string, string]>(
          "SELECT body FROM tasks WHERE project_directory=? AND id=?",
        )
        .get(this.projectDirectory, parsed.taskID)
      if (!taskRow) throw new Error("Task not found in this project")
      const task = TaskSpecSchema.parse(JSON.parse(taskRow.body))
      const current = taskClassificationFor(db, this.projectDirectory, task).current
      if (parsed.expectedRevision !== current.revision)
        return TaskClassificationAnnotationReceipt.parse({
          status: "conflict",
          taskID: parsed.taskID,
          expectedRevision: parsed.expectedRevision,
          currentRevision: current.revision,
          message: "Task classification revision changed; read current history before correcting",
        })

      db.query(
        `INSERT INTO task_classifications
         (project_directory,task_id,request_id,payload,revision,classification,reason,session_id,agent,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        this.projectDirectory,
        parsed.taskID,
        parsed.requestID,
        payload,
        current.revision + 1,
        JSON.stringify(parsed.classification),
        parsed.reason,
        actor.sessionID,
        actor.agent,
        new Date().toISOString(),
      )
      this.changed()
      changed = true
      const inserted = db
        .query<ClassificationRow, [string, string]>(
          "SELECT * FROM task_classifications WHERE project_directory=? AND request_id=?",
        )
        .get(this.projectDirectory, parsed.requestID)!
      return TaskClassificationAnnotationReceipt.parse({
        status: "recorded",
        annotation: classificationRecord(inserted),
      })
    })
    if (changed) this.notify()
    return receipt
  }

  /** Append an explicit correction relation without changing task or execution history. */
  recordTaskCorrection(
    input: unknown,
    actor: { sessionID: string; agent: string },
  ): TaskCorrectionReceiptType {
    const parsed = TaskCorrectionInput.parse(input)
    let changed = false
    const receipt = this.atomic((db) => {
      const payload = canonical({
        taskID: parsed.taskID,
        originalTaskID: parsed.originalTaskID,
        expectedRevision: parsed.expectedRevision,
        reason: parsed.reason,
      })
      const existing = db
        .query<CorrectionRow, [string, string]>(
          "SELECT * FROM task_corrections WHERE project_directory=? AND request_id=?",
        )
        .get(this.projectDirectory, parsed.requestID)
      if (existing) {
        if (existing.payload !== payload)
          return TaskCorrectionReceipt.parse({
            status: "conflict",
            taskID: parsed.taskID,
            message: "requestID already identifies different task correction content",
          })
        return TaskCorrectionReceipt.parse({
          status: "replayed",
          correction: correctionRecord(existing),
        })
      }

      const taskExists = (taskID: string) =>
        Boolean(
          db
            .query<{ id: string }, [string, string]>(
              "SELECT id FROM tasks WHERE project_directory=? AND id=?",
            )
            .get(this.projectDirectory, taskID),
        )
      if (!taskExists(parsed.taskID)) throw new Error("Correction task not found in this project")
      if (parsed.originalTaskID !== null && !taskExists(parsed.originalTaskID))
        throw new Error("Original task not found in this project")

      const currentRevision =
        db
          .query<{ revision: number }, [string, string]>(
            "SELECT MAX(revision) AS revision FROM task_corrections WHERE project_directory=? AND task_id=?",
          )
          .get(this.projectDirectory, parsed.taskID)?.revision ?? null
      const revision = currentRevision ?? 0
      if (parsed.expectedRevision !== revision)
        return TaskCorrectionReceipt.parse({
          status: "conflict",
          taskID: parsed.taskID,
          expectedRevision: parsed.expectedRevision,
          currentRevision: revision,
          message: "Task correction revision changed; inspect current membership before correcting",
        })

      if (parsed.originalTaskID !== null) {
        const latest = db
          .query<Pick<CorrectionRow, "task_id" | "original_task_id">, [string, string]>(
            `SELECT correction.task_id, correction.original_task_id
             FROM task_corrections correction
             JOIN (
               SELECT task_id, MAX(revision) AS revision
               FROM task_corrections WHERE project_directory=? GROUP BY task_id
             ) current ON current.task_id=correction.task_id
                    AND current.revision=correction.revision
             WHERE correction.project_directory=?`,
          )
          .all(this.projectDirectory, this.projectDirectory)
        const parents = new Map(
          latest.flatMap((row) =>
            row.original_task_id === null ? [] : [[row.task_id, row.original_task_id] as const],
          ),
        )
        const seen = new Set<string>()
        let ancestor: string | undefined = parsed.originalTaskID
        while (ancestor !== undefined) {
          if (ancestor === parsed.taskID) throw new Error("Task correction would create a cycle")
          if (seen.has(ancestor)) throw new Error("Existing task correction links contain a cycle")
          seen.add(ancestor)
          ancestor = parents.get(ancestor)
        }
      }

      db.query(
        `INSERT INTO task_corrections
         (project_directory,task_id,original_task_id,request_id,payload,revision,reason,session_id,agent,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        this.projectDirectory,
        parsed.taskID,
        parsed.originalTaskID,
        parsed.requestID,
        payload,
        revision + 1,
        parsed.reason,
        actor.sessionID,
        actor.agent,
        new Date().toISOString(),
      )
      this.changed()
      changed = true
      const inserted = db
        .query<CorrectionRow, [string, string]>(
          "SELECT * FROM task_corrections WHERE project_directory=? AND request_id=?",
        )
        .get(this.projectDirectory, parsed.requestID)!
      return TaskCorrectionReceipt.parse({
        status: "recorded",
        correction: correctionRecord(inserted),
      })
    })
    if (changed) this.notify()
    return receipt
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
      const nodes =
        hasTable(db, "runner_nodes") && hasTable(db, "runner_plans")
          ? db
              .query<{ state: string; plan_state: string }, [string, string]>(
                `SELECT n.state,p.state AS plan_state FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
               WHERE p.project_directory=? AND n.task_id=?`,
              )
              .all(this.projectDirectory, parsed.taskID)
          : []
      const attempts = hasTable(db, "runner_attempts")
        ? db
            .query<{ state: string }, [string, string]>(
              `SELECT a.state FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
               WHERE p.project_directory=? AND a.task_id=?`,
            )
            .all(this.projectDirectory, parsed.taskID)
        : []
      const hasActiveReviewHold =
        (hasTable(db, "runner_adoptions") &&
          Boolean(
            db
              .query<{ present: number }, [string, string]>(
                `SELECT 1 AS present FROM runner_adoptions a JOIN runner_plans p ON p.id=a.plan_id
                 WHERE p.project_directory=? AND a.task_id=?
                   AND a.state IN ('pending','task-checks','combined-checks','waiting-human') LIMIT 1`,
              )
              .get(this.projectDirectory, parsed.taskID),
          )) ||
        (hasTable(db, "runner_retained_verifications") &&
          Boolean(
            db
              .query<{ present: number }, [string, string]>(
                `SELECT 1 AS present FROM runner_retained_verifications
                 WHERE project_directory=? AND task_id=?
                   AND state IN ('pending','task-checks','combined-checks','waiting-human','waiting-human-combined')
                 LIMIT 1`,
              )
              .get(this.projectDirectory, parsed.taskID),
          ))
      const activeAttemptStates = [
        "preparing",
        "running",
        "verifying",
        "held",
        "approval-held",
        "waiting-human",
        "waiting-human-combined",
      ]
      const activeNode = nodes.some(({ state, plan_state }) => {
        if (!activeStates.includes(state)) return false
        return !(parsed.disposition === "fulfilled" && state === "queued" && plan_state === "draft")
      })
      if (
        activeNode ||
        attempts.some(({ state }) => activeAttemptStates.includes(state)) ||
        hasActiveReviewHold
      )
        throw new Error("Cannot dispose a task with active execution")
      const acceptedExecution =
        nodes.length > 0 && nodes.every(({ state }) => ["accepted", "incorporated"].includes(state))
      const neverPlanned = nodes.length === 0 && attempts.length === 0
      const reviewedNeverExecuted =
        attempts.length === 0 &&
        nodes.length > 0 &&
        nodes.every(
          ({ state, plan_state }) =>
            (state === "cancelled" && plan_state === "cancelled") ||
            (state === "queued" && plan_state === "draft"),
        )
      if (
        parsed.disposition === "fulfilled" &&
        !acceptedExecution &&
        !neverPlanned &&
        !reviewedNeverExecuted
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

type ClassificationRow = {
  id: number
  project_directory: string
  task_id: string
  request_id: string
  payload: string
  revision: number
  classification: string
  reason: string
  session_id: string
  agent: string
  created_at: string
}

type CorrectionRow = {
  id: number
  project_directory: string
  task_id: string
  original_task_id: string | null
  request_id: string
  payload: string
  revision: number
  reason: string
  session_id: string
  agent: string
  created_at: string
}

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

function classificationRecord(row: ClassificationRow): TaskClassificationAnnotationRecordType {
  return TaskClassificationAnnotationRecord.parse({
    id: row.id,
    taskID: row.task_id,
    requestID: row.request_id,
    revision: row.revision,
    classification: JSON.parse(row.classification),
    reason: row.reason,
    sessionID: row.session_id,
    agent: row.agent,
    createdAt: row.created_at,
  })
}

function correctionRecord(row: CorrectionRow): TaskCorrectionRecordType {
  return TaskCorrectionRecord.parse({
    id: row.id,
    taskID: row.task_id,
    originalTaskID: row.original_task_id,
    requestID: row.request_id,
    revision: row.revision,
    reason: row.reason,
    sessionID: row.session_id,
    agent: row.agent,
    createdAt: row.created_at,
  })
}

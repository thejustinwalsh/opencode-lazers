import { drainScheduleHook, enrollScheduleConnection } from "./tasks/schedule/hook.ts"
import { drainProjections } from "./projections/hook.ts"
import { taskReferenceFor } from "./task-reference.ts"
import { Database, SQLiteError } from "bun:sqlite"
import { timeStorage } from "./diagnostics/storage-timing.ts"
import { schemaModules } from "./database-schema.ts"
import { installTaskAdviceSchema } from "./tasks/advice.ts"
import { installObservedRevisionsSchema } from "./tasks/observed-revisions.ts"
import { managedUsageSchemaModule } from "./managed-usage/schema.ts"
import { installRepoMapSchema } from "./context/repo-map-store.ts"
import { installPlanningSchema } from "./planning/store.ts"
import { mkdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
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
import { canonical, fingerprint } from "./identity.ts"
import { databaseChanges } from "./database-events.ts"
import {
  dispositionPayload,
  TaskDispositionInput,
  TaskDispositionRecord,
  type TaskDispositionRecord as TaskDispositionRecordType,
} from "./task-disposition.ts"
import { installProjectSchema } from "./project-key.ts"
import { REFERENCE_EXACT } from "./projects/code.ts"
import { projectCodeForDirectoryIn } from "./projects/registry.ts"
import { installProjectControlsSchema } from "./projects/settings.ts"
import { installProfileSchema } from "./projects/profile-store.ts"

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

/**
 * SQLite lock-wait budget per statement on the plugin's connections. All
 * in-process writers share one connection per database (see
 * `acquireSharedConnection`), so only another process (verification CLI, a second
 * service) can hold a lock. A wait inside SQLite blocks the whole event loop, so
 * it stays well under Desktop's 2s probe; `atomicAsync` waits with
 * `busy_timeout=0` and yields to the event loop between attempts instead.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 250
/**
 * Default total budget for `retryBusy`/`atomicAsync` contention retries. Sized against measured
 * lock holds: a submit transaction held the write lock for 252-459 ms on a machine under heavy CPU
 * and disk load (see fix/submission-lock-race), so 5 s is roughly ten times the worst hold seen.
 * Past it the call fails with a retryable `StorageBusyError`; the deadline is a wait bound, not a
 * refusal policy, and callers may pass their own.
 */
const ATOMIC_ASYNC_DEADLINE_MS = 5_000

/** Thrown by `atomicAsync` when a write lock could not be acquired before its deadline. */
class StorageBusyError extends Error {
  constructor(
    readonly attempts: number,
    readonly waitedMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      `LAZERS database is busy: another process held the write lock for ${waitedMs}ms across ${attempts} attempts. Retry this call; repeating it is safe.`,
      options,
    )
    this.name = "StorageBusyError"
  }
}

/**
 * Plugin load waits for the write lock this long. A schema install or an index build holds it for
 * about 1 s on a live-sized database (the integer-key index build is the longest; measured on the
 * 2026-11-21 restart), and the index worker waits 30 s on its own connection, so 30 s is thirty
 * times the longest hold seen. It bounds the wait only: when it is spent the load fails with the
 * real cause and nothing is left registered, so the next load attempt starts clean.
 */
const LOAD_LOCK_WAIT_MS = 30_000

function isSqliteBusy(error: unknown): boolean {
  return error instanceof SQLiteError && /^SQLITE_(BUSY|LOCKED)/.test(error.code ?? "")
}

function migrateTasks(db: Database): void {
  const version = () =>
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
  const initial = version()
  if (initial > TASKS_VERSION) throw new Error(`Unsupported LAZERS database version ${initial}`)
  if (initial < TASKS_VERSION)
    db.transaction(() => {
      const current = version()
      if (current > TASKS_VERSION) throw new Error(`Unsupported LAZERS database version ${current}`)
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
      if (current < 9) {
        collapseTaskChanges(db)
        db.exec("PRAGMA user_version=9")
      }
      if (current < 10) {
        // The fingerprint of the validated proposal, written with the task; existing rows are
        // filled in pages by `backfillContentFingerprints` once the schema is installed.
        const columns = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all()
        if (!columns.some((column) => column.name === "content_fingerprint"))
          db.exec("ALTER TABLE tasks ADD COLUMN content_fingerprint TEXT")
        db.exec(`
          CREATE INDEX IF NOT EXISTS tasks_project_fingerprint
            ON tasks(project_directory, content_fingerprint);
          PRAGMA user_version=10;
        `)
      }
      db.query(
        `INSERT INTO schema_modules VALUES(?,?,?,?) ON CONFLICT(module)
         DO UPDATE SET generation=excluded.generation,tables_json=excluded.tables_json`,
      ).run("tasks", TASKS_VERSION, JSON.stringify(schemaModules.tasks.tables), Date.now())
    }).immediate()
}

/** `PRAGMA user_version` of the tasks module; equals its declared schema generation. */
const TASKS_VERSION = 10

/**
 * Task change counters. Readers only ever take `MAX(id)` of a project (per `kind`), so one row per
 * project and kind carries everything they read. `AUTOINCREMENT` keeps ids rising after a row is
 * replaced, and the replace runs in the same transaction as the write that bumps it.
 */
const TASK_CHANGE_SCHEMA = `
  CREATE TABLE task_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_directory TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'insert'
  );
  CREATE INDEX task_changes_project ON task_changes(project_directory, id);
  CREATE TRIGGER tasks_changed AFTER INSERT ON tasks BEGIN
    DELETE FROM task_changes WHERE project_directory=NEW.project_directory AND kind='insert';
    INSERT INTO task_changes(project_directory,kind) VALUES (NEW.project_directory,'insert');
    UPDATE tasks SET created_version = last_insert_rowid() WHERE id = NEW.id;
  END;
`

/**
 * Replace the append-only change log (2.5 M rows on the live database) with the counters above.
 * Seeds come from the log's own indexes, then the whole table goes in one DROP TABLE, which only
 * returns pages to the free list (no row is rewritten or re-indexed).
 */
function collapseTaskChanges(db: Database): void {
  const sequence =
    db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name='task_changes'").get()
      ?.seq ?? 0
  const projects = db
    .query<{ project_directory: string; newest: number }, []>(
      "SELECT project_directory, MAX(id) AS newest FROM task_changes GROUP BY project_directory",
    )
    .all()
  const newestMutation = db.query<{ id: number | null }, [string]>(
    "SELECT id FROM task_changes WHERE project_directory=? AND kind='mutation' ORDER BY id DESC LIMIT 1",
  )
  const newestCreated = db.query<{ id: number | null }, [string]>(
    "SELECT MAX(created_version) AS id FROM tasks WHERE project_directory=?",
  )
  const seeds: Array<[number, string, string]> = []
  for (const { project_directory, newest } of projects) {
    const mutation = newestMutation.get(project_directory)?.id ?? null
    if (mutation !== null) seeds.push([mutation, project_directory, "mutation"])
    // The newest row of the project is an insert unless a mutation holds that id; otherwise the
    // insert trigger stamped its id on the task as `created_version`.
    const insert = mutation === newest ? (newestCreated.get(project_directory)?.id ?? 0) : newest
    if (insert > 0) seeds.push([insert, project_directory, "insert"])
  }
  db.exec("DROP TRIGGER IF EXISTS tasks_changed; DROP TABLE task_changes")
  db.exec(TASK_CHANGE_SCHEMA)
  const add = db.query("INSERT INTO task_changes(id,project_directory,kind) VALUES (?,?,?)")
  for (const seed of seeds) add.run(...seed)
  // Ids never reuse a value the log has issued, even when its newest rows were pruned.
  const raised = db
    .query("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='task_changes'")
    .run(sequence)
  if (raised.changes === 0 && sequence > 0)
    db.query("INSERT INTO sqlite_sequence(name,seq) VALUES('task_changes',?)").run(sequence)
}

type SharedEntry = {
  readonly key: string
  readonly mode: "write" | "readonly"
  readonly db: Database
  readonly dev: number
  readonly ino: number
  readonly once: Set<string>
  refs: number
}

/** A refcounted handle on a process-wide database connection. */
export type SharedConnection = {
  readonly db: Database
  /** Run `init` once per physical connection (schema installs, hooks); idempotent across handles. */
  once(name: string, init: (db: Database) => void): void
  /** Release this handle; the last release closes the connection. Safe to call twice. */
  release(): void
}

const CONNECTIONS = Symbol.for("lazers.storage.connections.v1")

/** Shared across module graphs: the host loads one plugin copy per location. */
function connections(): Map<string, SharedEntry> {
  const holder = globalThis as unknown as Record<symbol, Map<string, SharedEntry> | undefined>
  return (holder[CONNECTIONS] ??= new Map())
}

/** Number of live shared connections (diagnostics and tests). */
export function sharedConnectionCount(): number {
  return connections().size
}

function connectionKey(path: string, mode: "write" | "readonly"): string {
  return `${mode}:${join(realpathSync(dirname(path)), basename(path))}`
}

function openBase(path: string): Database {
  const db = new Database(path, { create: true, strict: true })
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON`)
    // WAL is persistent: once any connection has switched, later opens skip the
    // write-locking pragma. A concurrent first transition can fail immediately
    // despite busy_timeout; make a few bounded attempts and never sleep the
    // thread between them.
    if (db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode !== "wal")
      for (let attempt = 1; ; attempt++) {
        try {
          db.exec("PRAGMA journal_mode = WAL")
          break
        } catch (error) {
          if (!isSqliteBusy(error) || attempt >= 3) throw error
        }
      }
    databaseChanges.track(db, path)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/**
 * Acquire the one connection this process keeps per database path. Bun SQLite
 * transactions are synchronous, so in-process writers sharing a connection can
 * never interleave or contend; nested transactions become savepoints. A
 * read-only connection is shared separately and never creates or migrates.
 */
export function acquireSharedConnection(
  path: string,
  mode: "write" | "readonly" = "write",
): SharedConnection {
  if (mode === "write") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const key = connectionKey(path, mode)
  const registry = connections()
  let entry = registry.get(key)
  if (entry) {
    // A replaced or deleted file (fresh data directory) must not reuse the old inode.
    try {
      const stat = statSync(path)
      if (stat.ino !== entry.ino || stat.dev !== entry.dev) {
        registry.delete(key)
        entry = undefined
      }
    } catch {
      registry.delete(key)
      entry = undefined
    }
  }
  if (!entry) {
    const db =
      mode === "write" ? openBase(path) : new Database(path, { readonly: true, strict: true })
    const stat = statSync(path)
    entry = { key, mode, db, dev: stat.dev, ino: stat.ino, once: new Set(), refs: 0 }
    registry.set(key, entry)
  }
  const owned = entry
  owned.refs++
  let released = false
  return {
    db: owned.db,
    once(name, init) {
      if (owned.once.has(name)) return
      init(owned.db)
      owned.once.add(name)
    },
    release() {
      if (released) return
      released = true
      if (--owned.refs > 0) return
      if (registry.get(owned.key) === owned) registry.delete(owned.key)
      owned.db.close()
    },
  }
}

/**
 * Annotation requests recorded before the model tools dropped their revision guard stored it in the
 * request payload. A replay compares content only, so the guard never decides identity.
 */
function withoutRevisionGuard(stored: string): string {
  try {
    const value = JSON.parse(stored) as Record<string, unknown>
    if (value === null || typeof value !== "object" || !("expectedRevision" in value)) return stored
    const { expectedRevision: _guard, ...rest } = value
    return canonical(rest)
  } catch {
    return stored
  }
}

/**
 * Run a synchronous unit of start-up work that may take the write lock on its own connection,
 * yielding the event loop between attempts while another connection holds it. Each attempt must
 * leave nothing behind when it throws. Throws `StorageBusyError` (with the SQLite error as its
 * cause) once `deadlineMs` is spent.
 */
export async function waitForWriteLock<T>(
  run: () => T,
  options: { deadlineMs?: number } = {},
): Promise<T> {
  const started = Date.now()
  const deadline = started + (options.deadlineMs ?? LOAD_LOCK_WAIT_MS)
  for (let attempt = 1; ; attempt++) {
    try {
      return run()
    } catch (error) {
      if (!isSqliteBusy(error)) throw error
      const now = Date.now()
      if (now >= deadline) throw new StorageBusyError(attempt, now - started, { cause: error })
      await Bun.sleep(Math.min(5 * 2 ** Math.min(attempt - 1, 6), 250, deadline - now))
    }
  }
}

export class TaskRepository {
  private shared: SharedConnection | undefined
  private readonly listeners = new Set<() => void>()

  private get db(): Database {
    if (!this.shared) this.shared = this.open()
    return this.shared.db
  }

  constructor(
    readonly path: string,
    readonly projectDirectory: string,
  ) {
    this.shared = this.open()
  }

  /** Acquire the process-wide connection and install schema once per connection. */
  private open(): SharedConnection {
    const shared = acquireSharedConnection(this.path)
    // Schema installers call back into this repository, so it must see the handle.
    this.shared = shared
    try {
      shared.once(`tasks@${schemaModules.tasks.generation}`, migrateTasks)
      // Keyed by generation like the schema it follows, so a reload that raises it runs again.
      shared.once(`tasks-fingerprints@${schemaModules.tasks.generation}`, () =>
        this.backfillContentFingerprints(),
      )
      shared.once("task-advice-and-projects", () => {
        installTaskAdviceSchema(this)
        installProjectSchema(this)
      })
      // The connection and its `once` keys outlive a plugin reload (they hang off globalThis), so
      // a schema added later needs its own key or a reloaded service never installs it. The key
      // carries the declared generation for the same reason: a reload that raises a module's
      // generation must run its upgrade (found live on 2026-11-20: the profile and planning
      // upgrades were skipped after a reload because their keys had already run).
      const at = (module: keyof typeof schemaModules) =>
        `${module}@${schemaModules[module].generation}`
      shared.once(at("task-observations"), () => installObservedRevisionsSchema(this))
      shared.once(at("project-controls"), () => installProjectControlsSchema(this))
      shared.once(at("project-profile"), () => installProfileSchema(this))
      shared.once(at("repo-map"), () => installRepoMapSchema(this))
      shared.once(at("planning"), () => installPlanningSchema(this))
      return shared
    } catch (error) {
      this.shared = undefined
      shared.release()
      throw error
    }
  }

  /**
   * Server-side domain services share transactions, never expose SQL to agents/RPC.
   *
   * Synchronous write transaction (BEGIN IMMEDIATE). It fails fast with
   * SQLITE_BUSY after SQLITE_BUSY_TIMEOUT_MS (only another process can hold the lock) instead of sleeping the event loop.
   * Callers that can await should migrate to `atomicAsync`; pure reads use `read`.
   */
  atomic<T>(run: (db: Database) => T): T {
    const db = this.db
    return timeStorage("atomic", () =>
      db
        .transaction(() => {
          const result = run(db)
          drainScheduleHook(db)
          drainProjections(db)
          return result
        })
        .immediate(),
    )
  }

  /**
   * Write transaction that yields to the event loop while the database is
   * locked by another writer. Retries only SQLITE_BUSY with bounded backoff
   * and throws `StorageBusyError` after `deadlineMs`. `run` may execute more
   * than once (a failed attempt is rolled back), so keep side effects inside the
   * database.
   */
  async atomicAsync<T>(
    run: (db: Database) => T,
    options: { deadlineMs?: number } = {},
  ): Promise<T> {
    return this.retryBusy(() => {
      const db = this.db
      return db
        .transaction(() => {
          const result = run(db)
          drainScheduleHook(db)
          drainProjections(db)
          return result
        })
        .immediate()
    }, options)
  }

  /**
   * Run a synchronous unit of database work, yielding the event loop and retrying while another
   * process holds the write lock. Each attempt runs with `busy_timeout=0`, so nothing sleeps inside
   * SQLite. SQLITE_BUSY surfaces only when a transaction cannot begin, so the failed transaction
   * has done nothing; `run` may still repeat transactions that already committed in an earlier
   * attempt, so it must be idempotent (request-keyed writes, upserts, reads). Throws
   * `StorageBusyError` after `deadlineMs`.
   */
  async retryBusy<T>(run: () => T, options: { deadlineMs?: number } = {}): Promise<T> {
    const started = Date.now()
    const deadline = started + (options.deadlineMs ?? ATOMIC_ASYNC_DEADLINE_MS)
    for (let attempt = 1; ; attempt++) {
      const db = this.db
      try {
        db.exec("PRAGMA busy_timeout = 0")
        try {
          return timeStorage("atomic", run)
        } finally {
          db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
        }
      } catch (error) {
        if (!isSqliteBusy(error)) throw error
        const now = Date.now()
        if (now >= deadline) throw new StorageBusyError(attempt, now - started, { cause: error })
        await Bun.sleep(Math.min(5 * 2 ** Math.min(attempt - 1, 6), 250, deadline - now))
      }
    }
  }

  /**
   * Read-only access on a DEFERRED transaction: one consistent WAL snapshot, no
   * write reservation, so it never waits on writers.
   */
  read<T>(run: (db: Database) => T): T {
    const db = this.db
    return timeStorage("read", () => db.transaction(() => run(db)).deferred())
  }

  /**
   * Run `CREATE ... IF NOT EXISTS` statements only when one of the objects they name is missing, so
   * a current database takes no write lock at load. Returns whether it ran them.
   */
  installMissing(sql: string): boolean {
    const names = new Set(
      [...sql.matchAll(/CREATE\s+(?:TABLE|INDEX|TRIGGER)\s+IF NOT EXISTS\s+(\w+)/g)].map(
        (match) => match[1]!,
      ),
    )
    const present = this.read(
      (db) =>
        db
          .query<{ n: number }, []>(
            `SELECT count(*) AS n FROM sqlite_master WHERE name IN (${[...names].map((name) => `'${name}'`).join(",")})`,
          )
          .get()!.n,
    )
    if (present === names.size) return false
    this.atomic((db) => db.exec(sql))
    return true
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
    const declarations = Object.entries({
      ...schemaModules,
      "managed-usage": managedUsageSchemaModule,
    })
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
    // One counter row per project and kind: the replacement keeps `MAX(id)` rising without a log.
    this.db.transaction(() => {
      this.db
        .query("DELETE FROM task_changes WHERE project_directory=? AND kind='mutation'")
        .run(this.projectDirectory)
      this.db
        .query("INSERT INTO task_changes(project_directory,kind) VALUES (?,'mutation')")
        .run(this.projectDirectory)
    })()
  }

  submitOnce(key: string, proposal: unknown, create: () => unknown) {
    IdempotencyKeySchema.parse(key)
    const validated = TaskProposalSchema.parse(proposal)
    const outcome = this.atomic((db) => this.submitWithin(db, key, validated, create))
    if (outcome.inserted) this.notify()
    return outcome.receipt
  }

  /** The write lock covers lookup, lazy provenance collection, and both inserts. */
  private submitWithin(
    db: Database,
    key: string,
    validated: ReturnType<typeof TaskProposalSchema.parse>,
    create: () => unknown,
  ) {
    const content = canonical(validated)
    let inserted = false
    const receipt = (() => {
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
    })()
    return { receipt, inserted }
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
    db.query(
      "INSERT INTO tasks (id, project_directory, created_at, body, content_fingerprint) VALUES (?, ?, ?, ?, ?)",
    ).run(
      task.id,
      this.projectDirectory,
      task.createdAt,
      JSON.stringify(task),
      fingerprint(task.proposal),
    )
  }

  /**
   * Fill `content_fingerprint` for rows written before it existed, a page of tasks per
   * transaction. A row whose body no longer parses stays empty; readers compute it on demand.
   */
  backfillContentFingerprints(pageSize = 200): number {
    let filled = 0
    let after = 0
    for (;;) {
      const rows = this.db
        .query<{ rid: number; id: string; body: string }, [number, number]>(
          `SELECT rowid AS rid,id,body FROM tasks
           WHERE content_fingerprint IS NULL AND rowid>? ORDER BY rowid LIMIT ?`,
        )
        .all(after, pageSize)
      if (!rows.length) return filled
      this.atomic((db) => {
        const set = db.query("UPDATE tasks SET content_fingerprint=? WHERE id=?")
        for (const row of rows)
          try {
            set.run(fingerprint(TaskSpecSchema.parse(JSON.parse(row.body)).proposal), row.id)
            filled++
          } catch {
            // An unreadable body keeps no fingerprint; the audit that reads it reports it.
          }
      })
      after = rows.at(-1)!.rid
    }
  }

  private allocateReference(db: Database, taskID: string): string {
    const existing = db
      .query<{ reference: string }, [string, string]>(
        "SELECT reference FROM task_references WHERE project_directory=? AND task_id=?",
      )
      .get(this.projectDirectory, taskID)?.reference
    if (existing) return existing
    // The project's code and one sequence across every checkout of it. A directory no project owns
    // yet (before registration) keeps the original `LZ` numbering for that directory alone.
    const project = projectCodeForDirectoryIn(db, this.projectDirectory)
    const sequence = project
      ? db
          .query<{ sequence: number }, [string]>(
            `SELECT COALESCE(MAX(r.sequence), 0) + 1 AS sequence FROM task_references r
               JOIN lazers_project_paths pp ON pp.path=r.project_directory WHERE pp.key=?`,
          )
          .get(project.key)!.sequence
      : db
          .query<{ sequence: number }, [string]>(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_references WHERE project_directory=?",
          )
          .get(this.projectDirectory)!.sequence
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw new Error("Task reference sequence is exhausted")
    const reference = `${project?.code ?? "LZ"}-${sequence}`
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

  /** The code of the project this checkout belongs to; absent before the project registers. */
  projectCode(): string | undefined {
    return projectCodeForDirectoryIn(this.db, this.projectDirectory)?.code
  }

  referenceFor(taskID: string): string | undefined {
    return taskReferenceFor(this.db, this.projectDirectory, taskID)
  }

  /**
   * The task a reference names in this project: its current code, an earlier code kept as an alias,
   * any checkout of the project, any letter case. A reference of another project never resolves.
   */
  resolveReference(text: string): string | undefined {
    const reference = text.trim().toUpperCase()
    if (!REFERENCE_EXACT.test(reference)) return undefined
    const project = projectCodeForDirectoryIn(this.db, this.projectDirectory)
    if (!project)
      return this.db
        .query<{ task_id: string }, [string, string]>(
          "SELECT task_id FROM task_references WHERE project_directory=? AND reference=?",
        )
        .get(this.projectDirectory, reference)?.task_id
    return (
      this.db
        .query<{ task_id: string }, [string, string]>(
          `SELECT r.task_id AS task_id FROM task_references r
             JOIN lazers_project_paths pp ON pp.path=r.project_directory
            WHERE pp.key=? AND r.reference=? ORDER BY r.rowid LIMIT 1`,
        )
        .get(project.key, reference)?.task_id ??
      this.db
        .query<{ task_id: string }, [string, string]>(
          "SELECT task_id FROM task_reference_aliases WHERE project_key=? AND alias=?",
        )
        .get(project.key, reference)?.task_id
    )
  }

  resolveTaskID(idOrReference: string): string | undefined {
    if (REFERENCE_EXACT.test(idOrReference.trim().toUpperCase())) {
      return this.resolveReference(idOrReference)
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
        classification: parsed.classification,
        reason: parsed.reason,
      })
      const existing = db
        .query<ClassificationRow, [string, string]>(
          "SELECT * FROM task_classifications WHERE project_directory=? AND request_id=?",
        )
        .get(this.projectDirectory, parsed.requestID)
      if (existing) {
        if (withoutRevisionGuard(existing.payload) !== payload)
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
      if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== current.revision)
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
        reason: parsed.reason,
      })
      const existing = db
        .query<CorrectionRow, [string, string]>(
          "SELECT * FROM task_corrections WHERE project_directory=? AND request_id=?",
        )
        .get(this.projectDirectory, parsed.requestID)
      if (existing) {
        if (withoutRevisionGuard(existing.payload) !== payload)
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
      if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== revision)
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
      .query<DispositionRecordRow, [string, string]>(
        `SELECT ${DISPOSITION_COLUMNS} FROM task_dispositions WHERE project_directory=? AND task_id=? ORDER BY id DESC LIMIT 1`,
      )
      .get(this.projectDirectory, taskID)
    return row ? dispositionRecord(row) : undefined
  }

  /** Return the append-only disposition history for a project-local task. */
  taskDispositionHistory(taskID: string): TaskDispositionRecordType[] {
    return this.db
      .query<DispositionRecordRow, [string, string]>(
        `SELECT ${DISPOSITION_COLUMNS} FROM task_dispositions WHERE project_directory=? AND task_id=? ORDER BY id`,
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
        .query<DispositionRecordRow, [string, string]>(
          `SELECT ${DISPOSITION_COLUMNS} FROM task_dispositions WHERE project_directory=? AND task_id=? ORDER BY id DESC LIMIT 1`,
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
                   AND a.state IN ('pending','task-checks','combined-checks') LIMIT 1`,
              )
              .get(this.projectDirectory, parsed.taskID),
          )) ||
        (hasTable(db, "runner_retained_verifications") &&
          Boolean(
            db
              .query<{ present: number }, [string, string]>(
                `SELECT 1 AS present FROM runner_retained_verifications
                 WHERE project_directory=? AND task_id=?
                   AND state IN ('pending','task-checks')
                 LIMIT 1`,
              )
              .get(this.projectDirectory, parsed.taskID),
          ))
      const activeAttemptStates = ["preparing", "running", "verifying", "held", "approval-held"]
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

  /** True once `close` ran and nothing has used the repository since; late work must not reopen it. */
  get isClosed(): boolean {
    return this.shared === undefined
  }

  close(): void {
    this.listeners.clear()
    this.shared?.release()
    this.shared = undefined
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

/**
 * The columns a disposition record is built from. `payload` (the canonical request, only compared
 * on a replayed request id) and `project_directory` (already the filter) are not read.
 */
const DISPOSITION_COLUMNS =
  "id,task_id,request_id,disposition,reason,evidence,related_task_ids,session_id,agent,created_at"
type DispositionRecordRow = Omit<DispositionRow, "project_directory" | "payload">

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

function dispositionRecord(row: DispositionRecordRow): TaskDispositionRecordType {
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

/**
 * A checkout's repository for reads that must never write: every transaction is a deferred read,
 * so it takes no write lock and cannot block (or be blocked by) a writer in another connection.
 * It still opens the process-wide connection, whose schema was installed by the writable
 * repositories of this process.
 */
export class ReadOnlyTaskRepository extends TaskRepository {
  override atomic<T>(run: (db: Database) => T): T {
    return this.read(run)
  }
  override async atomicAsync<T>(run: (db: Database) => T): Promise<T> {
    return this.read(run)
  }
}

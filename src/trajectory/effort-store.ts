import type { Database } from "bun:sqlite"
import { LruMap, SESSION_MEMO_ENTRIES } from "../core/process-shared.ts"
import { parkQueueEntry, QueueRetryTimer } from "../core/queue-retry.ts"
import { databaseChanges } from "../database-events.ts"
import { schemaModules } from "../database-schema.ts"
import { ensureHostSessionStateSchema } from "../host-sessions/state.ts"
import { ensureProjectionStateSchema, resetProjectionState } from "../projections/lifecycle.ts"
import { startProjection, type ProjectionLease, type ProjectionSpec } from "../projections/owner.ts"
import { queueRef, queueRefs, queueTableSQL } from "../projections/queue.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository } from "../storage.ts"
import type { EffortRow, TaskEffortCompute } from "./effort-compute.ts"
import type { TaskEffort } from "./read.ts"

/**
 * `trajectory_task_effort`: each task's effort, stored so a panel or tool reads one row instead of
 * rebuilding it per read from every progress row of the task, a host `session.get` per attempt and
 * a price-source read.
 *
 * ```
 * runner_attempts, runner_progress, runner_nodes,  ─┐
 * runner_plans (body, model), ACCEPT transitions,   ├ triggers ─► trajectory_effort_dirty(ref)
 * host_session_state (the attempts' sessions), tasks ┘                   │
 * price evidence written (snapshots, refreshes) ─► every row of the project re-queued (reprice)
 *                                                                        ▼ async fold, per task
 *   inspectTaskEffort: plans, attempts, every progress row of the task, stored session facts
 *        ─► projectTaskEffortBasis + taskValuationProvider (await) ─► compare, then write the row
 * ```
 *
 * The read and the composition run off the main thread (`effort-compute.ts`, in the effort
 * worker); this thread claims an entry and writes the computed row. The row is the composition
 * the trajectory report makes (`composeTaskEffort` in `read.ts`), over
 * stored facts only: usage per unique worker session (the host session fold's five-category
 * snapshot first, else the retained cumulative snapshot, else the additive steps), routes, and the
 * market valuation of the same request by the configured ordered price sources. No message text
 * and no transcript (owner decision, 2026-11-21: OpenCode holds transcripts), so a session's
 * context reads `not-read`, as in the status report.
 *
 * Repricing: the valuation is not a function of stored numbers alone (the provider reads the
 * configured sources), so a price change re-runs the provider over the same inputs. Usage is
 * recomputed from the same rows and comes out unchanged; a row is written only when it differs.
 *
 * - The provider is asynchronous, so a refresh cannot run in a writer's transaction: an entry is
 *   claimed (`next_at` -1), computed, then written with the claim checked. A write during the
 *   computation re-queues the entry (the trigger resets `next_at` to 0), so it is computed again.
 * - A failed refresh stays queued with its error and a backoff (1 s to 5 min); nothing is dropped.
 * - Idle (nothing due or parked): no timer, no read; one table subscription.
 */
const MODULE = schemaModules["trajectory-effort"]
const TASK_EFFORT = "trajectory-effort"
export const TASK_EFFORT_QUEUE = "trajectory_effort_dirty"

/** Raise when the stored derivation changes: the seed queues every task again. */
const TASK_EFFORT_GENERATION = 1

const TABLES_SQL = `
  CREATE TABLE trajectory_task_effort (
    id INTEGER PRIMARY KEY,
    project_directory TEXT NOT NULL, task_id TEXT NOT NULL,
    busy INTEGER NOT NULL,
    uncached_input INTEGER, output INTEGER, reasoning INTEGER, cache_read INTEGER, cache_write INTEGER,
    sessions INTEGER NOT NULL, known_sessions INTEGER NOT NULL,
    market_value TEXT, market_status TEXT, price_index TEXT,
    effort TEXT NOT NULL, effort_key TEXT NOT NULL,
    refreshed_at INTEGER NOT NULL,
    UNIQUE(project_directory, task_id)
  );
  ${queueTableSQL(TASK_EFFORT_QUEUE)}
`

/** A queue ref names the project and the task: one queue serves every project of a database. */
const taskEffortRef = (project: string, taskID: string) => `${project}\u0000${taskID}`
const refSQL = (project: string, task: string) => `${project}||char(0)||${task}`
const queue = (project: string, task: string) => queueRef(TASK_EFFORT_QUEUE, refSQL(project, task))
const planProject = (plan: string) =>
  `(SELECT project_directory FROM runner_plans WHERE id=${plan})`
const attemptProject = (row: "NEW" | "OLD") =>
  `COALESCE(${row}.project_directory, ${planProject(`${row}.plan_id`)})`

type TriggerSpec = { name: string; on: string; event: string; when?: string; body: string }

/**
 * Every input of the composition queues its task. Each trigger names the columns the composition
 * reads, so the integer-key backfill (`plan_n`, `attempt_n`) and lease fences queue nothing.
 */
const TASK_EFFORT_TRIGGERS: readonly TriggerSpec[] = [
  ...(["INSERT", "DELETE"] as const).map((event) => {
    const row = event === "INSERT" ? "NEW" : "OLD"
    return {
      name: `trajectory_effort_q_attempt_${event.toLowerCase()}`,
      on: "runner_attempts",
      event,
      body: queue(attemptProject(row), `${row}.task_id`),
    }
  }),
  {
    name: "trajectory_effort_q_attempt_update",
    on: "runner_attempts",
    event:
      "UPDATE OF plan_id,project_directory,task_id,number,session_id,policy,state,started_at," +
      "token_count,tool_count,retry_count,cost",
    body: `${queue(attemptProject("NEW"), "NEW.task_id")} ${queue(attemptProject("OLD"), "OLD.task_id")}`,
  },
  ...(["INSERT", "DELETE"] as const).map((event) => {
    const row = event === "INSERT" ? "NEW" : "OLD"
    return {
      name: `trajectory_effort_q_progress_${event.toLowerCase()}`,
      on: "runner_progress",
      event,
      body: queue(`${row}.project_directory`, `${row}.task_id`),
    }
  }),
  {
    name: "trajectory_effort_q_progress_update",
    on: "runner_progress",
    event:
      "UPDATE OF project_directory,task_id,attempt_id,session_id,at,recorded_at,source," +
      "sources_json,kind,event_ids_json,message_id,payload",
    body: `${queue("NEW.project_directory", "NEW.task_id")} ${queue("OLD.project_directory", "OLD.task_id")}`,
  },
  ...(["INSERT", "DELETE"] as const).map((event) => {
    const row = event === "INSERT" ? "NEW" : "OLD"
    return {
      name: `trajectory_effort_q_session_${event.toLowerCase()}`,
      on: "host_session_state",
      event,
      when: `${row}.task_id IS NOT NULL`,
      body: queue(`${row}.project_directory`, `${row}.task_id`),
    }
  }),
  {
    name: "trajectory_effort_q_session_update",
    on: "host_session_state",
    event: "UPDATE",
    when: "NEW.task_id IS NOT NULL OR OLD.task_id IS NOT NULL",
    body: `${queue("NEW.project_directory", "NEW.task_id")} ${queue("OLD.project_directory", "OLD.task_id")}`,
  },
  ...(["INSERT", "DELETE"] as const).map((event) => {
    const row = event === "INSERT" ? "NEW" : "OLD"
    return {
      name: `trajectory_effort_q_node_${event.toLowerCase()}`,
      on: "runner_nodes",
      event,
      body: queue(planProject(`${row}.plan_id`), `${row}.task_id`),
    }
  }),
  {
    name: "trajectory_effort_q_node_update",
    on: "runner_nodes",
    event: "UPDATE OF state",
    body: queue(planProject("NEW.plan_id"), "NEW.task_id"),
  },
  // Only a task's ACCEPT transition is read (the accepted time); the plan-level transitions
  // (409,170 of 418,671 live) queue nothing.
  ...(["INSERT", "DELETE"] as const).map((event) => {
    const row = event === "INSERT" ? "NEW" : "OLD"
    return {
      name: `trajectory_effort_q_accept_${event.toLowerCase()}`,
      on: "runner_transitions",
      event,
      when: `${row}.task_id IS NOT NULL AND ${row}.event='ACCEPT'`,
      body: queue(planProject(`${row}.plan_id`), `${row}.task_id`),
    }
  }),
  {
    name: "trajectory_effort_q_plan_update",
    on: "runner_plans",
    event: "UPDATE OF body,model",
    body: queueRefs(
      TASK_EFFORT_QUEUE,
      `SELECT ${refSQL("NEW.project_directory", "task_id")} AS ref FROM runner_nodes WHERE plan_id=NEW.id`,
    ),
  },
  {
    name: "trajectory_effort_q_task_delete",
    on: "tasks",
    event: "DELETE",
    body: queue("OLD.project_directory", "OLD.id"),
  },
]

const hasTable = (db: Database, name: string) =>
  Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))

/** The table, queue and triggers, rebuilt from nothing; the seed and the fold refill them. */
function installTaskEffortSchema(db: Database) {
  for (const spec of TASK_EFFORT_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${spec.name}`)
  db.exec(`DROP TABLE IF EXISTS trajectory_task_effort; DROP TABLE IF EXISTS ${TASK_EFFORT_QUEUE};`)
  db.exec(TABLES_SQL)
  resetProjectionState(db, TASK_EFFORT)
  for (const spec of TASK_EFFORT_TRIGGERS) {
    if (!hasTable(db, spec.on)) continue
    db.exec(
      `CREATE TRIGGER ${spec.name} AFTER ${spec.event} ON ${spec.on}
       ${spec.when ? `WHEN ${spec.when}` : ""} BEGIN
         ${spec.body}
       END;`,
    )
  }
}

/**
 * Install through the module registry. The triggers need their source tables, so the runner's
 * tables and `host_session_state` are installed first.
 */
export function ensureTaskEffortSchema(repository: TaskRepository) {
  void new RunnerStore(repository)
  ensureHostSessionStateSchema(repository)
  ensureProjectionStateSchema(repository)
  repository.installSchema("trajectory-effort", MODULE.generation, MODULE.tables, (db) =>
    installTaskEffortSchema(db),
  )
}

/** Tasks per seed page: queue inserts only. Measured with the fold tests: 260 tasks, 2 pages. */
const TASK_EFFORT_SEED_ROWS = 200

/**
 * The seed: every task a plan of the project holds is queued once per generation; the fold
 * computes them. Scope: the project directory.
 */
export const taskEffortSeedProjection: ProjectionSpec = {
  name: TASK_EFFORT,
  generation: TASK_EFFORT_GENERATION,
  backfill: [
    {
      name: "tasks",
      page(db, scope, after) {
        const rows = db
          .query<{ id: number; task_id: string }, [number, string, number]>(
            `SELECT n.rowid AS id, n.task_id FROM runner_nodes n
               JOIN runner_plans p ON p.id=n.plan_id
             WHERE n.rowid>? AND p.project_directory=? ORDER BY n.rowid LIMIT ?`,
          )
          .all(after, scope, TASK_EFFORT_SEED_ROWS)
        const insert = db.query(
          `INSERT INTO ${TASK_EFFORT_QUEUE}(ref,next_at) VALUES(?,1) ON CONFLICT(ref) DO NOTHING`,
        )
        for (const row of rows) insert.run(taskEffortRef(scope, row.task_id))
        return { next: rows.at(-1)?.id ?? after, done: rows.length < TASK_EFFORT_SEED_ROWS }
      },
    },
  ],
}

export type StoredTaskEffort = {
  busy: boolean
  effort: TaskEffort
  refreshedAt: number
}

/** The stored effort of one task, or undefined when the fold has not written it. */
export function readTaskEffort(
  db: Database,
  project: string,
  taskID: string,
): StoredTaskEffort | undefined {
  const row = db
    .query<{ busy: number; effort: string; refreshed_at: number }, [string, string]>(
      `SELECT busy,effort,refreshed_at FROM trajectory_task_effort
       WHERE project_directory=? AND task_id=?`,
    )
    .get(project, taskID)
  return row
    ? {
        busy: row.busy === 1,
        effort: JSON.parse(row.effort) as TaskEffort,
        refreshedAt: row.refreshed_at,
      }
    : undefined
}

const COLUMNS = [
  "busy",
  "uncached_input",
  "output",
  "reasoning",
  "cache_read",
  "cache_write",
  "sessions",
  "known_sessions",
  "market_value",
  "market_status",
  "price_index",
  "effort",
  "effort_key",
] as const satisfies readonly (keyof EffortRow)[]
/** What a write compares: every column but the effort text, whose identity `effort_key` is. */
const COMPARED = COLUMNS.filter((column) => column !== "effort")

type TaskEffortWrite = "written" | "unchanged" | "deleted" | "absent"

/** Write one task's effort in the caller's transaction, only what differs; undefined deletes. */
function writeTaskEffort(
  db: Database,
  project: string,
  taskID: string,
  row: EffortRow | undefined,
  now = Date.now(),
): TaskEffortWrite {
  const stored = db
    .query<Omit<EffortRow, "effort">, [string, string]>(
      `SELECT ${COMPARED.join(",")} FROM trajectory_task_effort WHERE project_directory=? AND task_id=?`,
    )
    .get(project, taskID)
  if (!row) {
    if (!stored) return "absent"
    db.query("DELETE FROM trajectory_task_effort WHERE project_directory=? AND task_id=?").run(
      project,
      taskID,
    )
    return "deleted"
  }
  if (stored && COMPARED.every((column) => stored[column] === row[column])) return "unchanged"
  db.query(
    `INSERT INTO trajectory_task_effort(project_directory,task_id,${COLUMNS.join(",")},refreshed_at)
     VALUES(?,?,${COLUMNS.map(() => "?").join(",")},?)
     ON CONFLICT(project_directory,task_id) DO UPDATE SET
       ${COLUMNS.map((column) => `${column}=excluded.${column}`).join(",")},
       refreshed_at=excluded.refreshed_at`,
  ).run(project, taskID, ...COLUMNS.map((column) => row[column]), now)
  return "written"
}

/** The price evidence tables the valuation provider reads: a write may change every price. */
const PRICE_TABLES = [
  "model_evidence_snapshots",
  "model_evidence_refreshes",
  "model_endpoint_pricing_snapshots",
  "model_endpoint_pricing_refreshes",
] as const

/** Queue entries per read of the queue: a unit of work, the rest wait for the next read. */
const DRAIN_BATCH = 20
/** Effort rows re-queued per reprice transaction: an index range scan and inserts. */
const REPRICE_ROWS = 500
/**
 * The least time between two refreshes of one task. A running attempt writes progress rows
 * several times a second; each queues its task, and a refresh reads every progress row of the task
 * and the price sources, so refreshes of a busy task are spaced by this much (entries wait, none
 * is dropped). Measured in `effort-store.test.ts` ("refresh cost"): a task of 3,619 progress
 * rows, the largest live attempt, refreshes in a median 86 ms (173 ms on a loaded machine), so at
 * this spacing a running task keeps the effort worker about 6% busy while it runs and nothing
 * once it stops; the main thread spends only the claim and the write.
 */
const EFFORT_REFRESH_SPACING_MS = 3_000

export type TaskEffortFoldOptions = {
  onError?: (error: unknown) => void
  now?: () => number
  /** Refresh spacing; tests set 0. */
  spacingMs?: number
}

export class TaskEffortFold {
  private closed = false
  private again = false
  private draining: Promise<void> | undefined
  private readonly retry: QueueRetryTimer
  private unsubscribe: (() => void) | undefined
  private readonly controller = new AbortController()
  private readonly range: readonly [string, string]
  private readonly now: () => number
  private readonly spacingMs: number
  /** When each task was last refreshed: the spacing of a busy task's refreshes. */
  private readonly refreshedAt = new LruMap<string, number>(SESSION_MEMO_ENTRIES)
  /**
   * Refreshes, writes and reprices made, and the longest single main-thread step of a refresh
   * (its claim or its compare-and-write), in milliseconds: measurements for tests and diagnostics.
   */
  readonly counts = { refreshes: 0, written: 0, reprices: 0, longestMainMs: 0 }

  private mainMs(ms: number) {
    if (ms > this.counts.longestMainMs) this.counts.longestMainMs = ms
  }

  constructor(
    private readonly repository: TaskRepository,
    private readonly compute: TaskEffortCompute,
    private readonly options: TaskEffortFoldOptions = {},
  ) {
    const project = repository.projectDirectory
    this.range = [`${project}\u0000`, `${project}\u0001`]
    this.now = options.now ?? Date.now
    this.spacingMs = options.spacingMs ?? EFFORT_REFRESH_SPACING_MS
    this.retry = new QueueRetryTimer(repository, TASK_EFFORT_QUEUE, this.range, this.now, () => {
      void this.drain()
    })
  }

  private get project() {
    return this.repository.projectDirectory
  }

  start(): void {
    ensureTaskEffortSchema(this.repository)
    const [low, high] = this.range
    // A claim held when the process stopped is due again.
    this.repository.atomic((db) =>
      db
        .query(`UPDATE ${TASK_EFFORT_QUEUE} SET next_at=0 WHERE ref>=? AND ref<? AND next_at<0`)
        .run(low, high),
    )
    this.unsubscribe = databaseChanges.subscribeTables(this.repository.path, (tables) => {
      if (PRICE_TABLES.some((table) => tables.has(table))) void this.reprice()
      if (tables.has(TASK_EFFORT_QUEUE)) void this.drain()
    })
    void this.drain()
  }

  /** Queue one task now (a reader opened it): it is recomputed against current prices. */
  touch(taskID: string): void {
    if (this.closed) return
    try {
      this.repository.atomic((db) =>
        db
          .query(
            `INSERT INTO ${TASK_EFFORT_QUEUE}(ref,next_at) VALUES(?,0)
             ON CONFLICT(ref) DO UPDATE SET next_at=CASE WHEN next_at<0 THEN 1 ELSE 0 END,
               attempts=0,error=NULL`,
          )
          .run(taskEffortRef(this.project, taskID)),
      )
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  /**
   * Re-queue every stored task of the project behind the hinted ones: a price source changed,
   * so each is recomputed (usage comes out the same; only a changed valuation is written). An
   * entry being computed is marked so it is computed again with the new prices.
   */
  async reprice(): Promise<void> {
    if (this.closed) return
    this.counts.reprices++
    let after = 0
    try {
      for (;;) {
        const last = this.repository.atomic((db) => {
          const rows = db
            .query<{ id: number; task_id: string }, [string, number, number]>(
              `SELECT id,task_id FROM trajectory_task_effort
               WHERE project_directory=? AND id>? ORDER BY id LIMIT ?`,
            )
            .all(this.project, after, REPRICE_ROWS)
          const insert = db.query(
            `INSERT INTO ${TASK_EFFORT_QUEUE}(ref,next_at) VALUES(?,1)
             ON CONFLICT(ref) DO UPDATE SET next_at=CASE WHEN next_at<0 THEN 1 ELSE next_at END`,
          )
          for (const row of rows) insert.run(taskEffortRef(this.project, row.task_id))
          return rows.length < REPRICE_ROWS ? undefined : rows.at(-1)!.id
        })
        if (last === undefined || this.closed) break
        after = last
        await Bun.sleep(0)
      }
    } catch (error) {
      // The next price write re-queues them.
      this.options.onError?.(error)
    }
  }

  /** True when the fold holds no timer and runs nothing. */
  idle(): boolean {
    return !this.retry.pending && !this.draining
  }

  /** Compute every due task of this project; coalesces concurrent calls. */
  drain(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.again = true
    this.draining ??= (async () => {
      while (this.again && !this.closed) {
        this.again = false
        try {
          for (;;) {
            const batch = this.due()
            if (!batch.length || this.closed) break
            for (const entry of batch) {
              if (this.closed) break
              await this.refreshOne(entry.ref, entry.attempts)
            }
          }
        } catch (error) {
          // The database is busy or failing: the work stays queued for the next change or retry.
          this.options.onError?.(error)
        }
        if (!this.closed) this.retry.schedule()
      }
    })().finally(() => {
      this.draining = undefined
    })
    return this.draining
  }

  private due() {
    const [low, high] = this.range
    return this.repository.read((db) =>
      db
        .query<{ ref: string; attempts: number }, [string, string, number, number]>(
          `SELECT ref,attempts FROM ${TASK_EFFORT_QUEUE}
           WHERE ref>=? AND ref<? AND next_at>=0 AND next_at<=? ORDER BY next_at,ref LIMIT ?`,
        )
        .all(low, high, this.now(), DRAIN_BATCH),
    )
  }

  private async refreshOne(ref: string, attempts: number) {
    const taskID = ref.slice(this.range[0].length)
    const last = this.refreshedAt.get(taskID)
    if (last !== undefined && this.now() - last < this.spacingMs) {
      // Spaced: the entry waits, it is not dropped.
      this.repository.atomic((db) =>
        db
          .query(`UPDATE ${TASK_EFFORT_QUEUE} SET next_at=? WHERE ref=? AND next_at>=0`)
          .run(last + this.spacingMs, ref),
      )
      return
    }
    const claimStarted = performance.now()
    const claimed = this.repository.atomic(
      (db) =>
        db.query(`UPDATE ${TASK_EFFORT_QUEUE} SET next_at=-1 WHERE ref=? AND next_at>=0`).run(ref)
          .changes > 0,
    )
    this.mainMs(performance.now() - claimStarted)
    if (!claimed) return
    this.refreshedAt.set(taskID, this.now())
    try {
      this.counts.refreshes++
      // The read and the composition run in the effort worker; this thread only claims and writes.
      const row = await this.compute(taskID, this.controller.signal)
      if (this.closed) return
      const started = performance.now()
      await this.repository.retryBusy(() =>
        this.repository.atomic((db) => {
          if (writeTaskEffort(db, this.project, taskID, row, this.now()) === "written")
            this.counts.written++
          // A write during the computation reset the claim: leave the entry for the next pass.
          db.query(`DELETE FROM ${TASK_EFFORT_QUEUE} WHERE ref=? AND next_at=-1`).run(ref)
        }),
      )
      this.mainMs(performance.now() - started)
    } catch (error) {
      if (this.closed) return
      this.options.onError?.(error)
      try {
        parkQueueEntry(
          this.repository,
          TASK_EFFORT_QUEUE,
          { ref, attempts },
          error,
          this.now(),
          "AND next_at=-1",
        )
      } catch {
        // Still claimed: the next start makes it due again.
      }
    }
  }

  /** Drain until nothing is due: for tests and tools that must wait. */
  async settle(): Promise<void> {
    while (!this.closed && (this.draining || this.due().length)) await this.drain()
  }

  close(): void {
    this.closed = true
    this.controller.abort()
    this.retry.clear()
    this.unsubscribe?.()
  }
}

export type TaskEffortFoldLease = { readonly fold: TaskEffortFold; release(): void }

type Held = {
  fold: TaskEffortFold
  repository: TaskRepository
  seed: ProjectionLease
  refs: number
}
const registryKey = Symbol.for("lazers.task-effort-fold.v1")
const host = globalThis as typeof globalThis & { [registryKey]?: Map<string, Held> }
const held = () => (host[registryKey] ??= new Map())

/**
 * The one effort fold of `projectDirectory` over the database at `path` in this process, started
 * on the first acquire with its own connection and its seed backfill. The last release stops it.
 */
export function startTaskEffortFold(
  path: string,
  projectDirectory: string,
  compute: TaskEffortCompute,
  options: TaskEffortFoldOptions = {},
): TaskEffortFoldLease {
  const id = JSON.stringify([path, projectDirectory])
  let entry = held().get(id)
  if (!entry) {
    const repository = new TaskRepository(path, projectDirectory)
    const fold = new TaskEffortFold(repository, compute, options)
    let seed: ProjectionLease | undefined
    try {
      fold.start()
      seed = startProjection(path, projectDirectory, taskEffortSeedProjection, {
        scope: projectDirectory,
        ...(options.onError ? { onError: options.onError } : {}),
      })
    } catch (error) {
      fold.close()
      repository.close()
      throw error
    }
    entry = { fold, repository, seed, refs: 0 }
    held().set(id, entry)
  }
  entry.refs++
  const taken = entry
  let released = false
  return {
    fold: taken.fold,
    release() {
      if (released) return
      released = true
      if (--taken.refs > 0) return
      held().delete(id)
      taken.seed.release()
      taken.fold.close()
      taken.repository.close()
    },
  }
}

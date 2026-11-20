import type { Database } from "bun:sqlite"
import { Worker } from "node:worker_threads"
import { workerURL } from "../worker-url.ts"

/**
 * Plan-scoped history indexes on `runner_transitions`. They are not part of a schema
 * generation: building them on a large existing table holds the write lock for hundreds
 * of milliseconds each, so existing databases get them off the main thread.
 */
export const TRANSITION_INDEXES = [
  ["runner_transitions_plan_id", "runner_transitions(plan_id,id)"],
  ["runner_transitions_plan_event", "runner_transitions(plan_id,event)"],
  ["runner_transitions_task_latest", "runner_transitions(plan_id,task_id,id)"],
] as const

/**
 * Integer-key twins of the text indexes above and of the progress indexes, built only after the
 * key backfill has passed every row (building on a filled column is one sorted pass; building
 * before it would be maintained row by row through each backfill update). Each names the
 * statements it serves by the text index it mirrors.
 */
export const KEY_INDEXES = [
  ["runner_transitions_lookup_n", "runner_transitions(plan_n,task_id,event,id)"],
  ["runner_transitions_plan_n_id", "runner_transitions(plan_n,id)"],
  ["runner_transitions_plan_n_event", "runner_transitions(plan_n,event)"],
  ["runner_transitions_task_latest_n", "runner_transitions(plan_n,task_id,id)"],
  ["runner_progress_attempt_seq_n", "runner_progress(project_directory,attempt_n,seq)"],
  ["runner_progress_plan_recency_n", "runner_progress(plan_n,latest_observed_at DESC,seq DESC)"],
] as const

type IndexList = ReadonlyArray<readonly [name: string, target: string]>

const tableOf = (target: string) => target.slice(0, target.indexOf("("))

/** Tables at or below this many rows are indexed inline (well under 100ms). */
const INLINE_INDEX_ROW_LIMIT = 20_000

function missing(db: Database, list: IndexList, table?: string) {
  const present = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((row) => row.name),
  )
  return list.filter(
    ([name, target]) => !present.has(name) && (!table || tableOf(target) === table),
  )
}

export const missingTransitionIndexes = (db: Database) => missing(db, TRANSITION_INDEXES)
export const missingKeyIndexes = (db: Database, table?: string) => missing(db, KEY_INDEXES, table)

/** Create the missing indexes, one write transaction each so the lock is released between builds. */
export function createTransitionIndexes(db: Database) {
  for (const [name, target] of missingTransitionIndexes(db))
    db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`)
}

export function createKeyIndexes(db: Database, table?: string) {
  for (const [name, target] of missingKeyIndexes(db, table))
    db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`)
}

// OpenCode loads this module once per location with a cleared require cache, so a
// module-level map would be per copy. Share the guard process-wide instead.
const inFlightKey = Symbol.for("lazers.transition-indexes.v1")
type GlobalWithGuard = typeof globalThis & { [inFlightKey]?: Map<string, Promise<void>> }
const inFlight = ((globalThis as GlobalWithGuard)[inFlightKey] ??= new Map<string, Promise<void>>())

/**
 * Ensure the indexes exist. Small tables are indexed inline; large ones are built by a
 * worker on its own connection while the main connection (busy_timeout=0, yielding
 * retries) keeps serving. The returned promise settles when the indexes exist or the
 * background build failed (failure is non-fatal: queries stay correct, only slower).
 */
export function ensureTransitionIndexes(
  db: Database,
  path: string,
  options: { inlineRowLimit?: number; workerURL?: URL; onSpawn?: () => void } = {},
): Promise<void> {
  if (!missingTransitionIndexes(db).length) return Promise.resolve()
  // AUTOINCREMENT ids make MAX(id) an O(1) upper bound on the row count.
  const rows =
    db.query<{ n: number | null }, []>("SELECT MAX(id) AS n FROM runner_transitions").get()?.n ?? 0
  if (rows <= (options.inlineRowLimit ?? INLINE_INDEX_ROW_LIMIT) || path === ":memory:") {
    createTransitionIndexes(db)
    return Promise.resolve()
  }
  const running = inFlight.get(path)
  if (running) return running
  const build = new Promise<void>((resolve) => {
    options.onSpawn?.()
    const worker = new Worker(
      options.workerURL ?? workerURL("./transition-indexes-worker", import.meta.url),
      { workerData: { path } },
    )
    worker.unref()
    const done = () => {
      void worker.terminate().then(
        () => resolve(),
        () => resolve(),
      )
    }
    worker.once("message", done)
    worker.once("error", done)
    worker.once("exit", () => resolve())
  }).finally(() => inFlight.delete(path))
  inFlight.set(path, build)
  return build
}

/**
 * The integer-key indexes of one history table, built when its keys are complete: inline for a
 * small table, otherwise by the same worker as the transition indexes on its own connection.
 */
export function ensureKeyIndexes(
  db: Database,
  path: string,
  table: "runner_transitions" | "runner_progress",
  options: { inlineRowLimit?: number; workerURL?: URL; onSpawn?: () => void } = {},
): Promise<void> {
  if (!missingKeyIndexes(db, table).length) return Promise.resolve()
  const rowid = table === "runner_transitions" ? "id" : "seq"
  const rows =
    db.query<{ n: number | null }, []>(`SELECT MAX(${rowid}) AS n FROM ${table}`).get()?.n ?? 0
  if (rows <= (options.inlineRowLimit ?? INLINE_INDEX_ROW_LIMIT) || path === ":memory:") {
    createKeyIndexes(db, table)
    return Promise.resolve()
  }
  const key = `${path}#${table}`
  const running = inFlight.get(key)
  if (running) return running
  const build = new Promise<void>((resolve) => {
    options.onSpawn?.()
    const worker = new Worker(
      options.workerURL ?? workerURL("./transition-indexes-worker", import.meta.url),
      { workerData: { path, keyTable: table } },
    )
    worker.unref()
    const done = () => {
      void worker.terminate().then(
        () => resolve(),
        () => resolve(),
      )
    }
    worker.once("message", done)
    worker.once("error", done)
    worker.once("exit", () => resolve())
  }).finally(() => inFlight.delete(key))
  inFlight.set(key, build)
  return build
}

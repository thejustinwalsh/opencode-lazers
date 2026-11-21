import type { Database, SQLQueryBindings } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import { lifecycleTransition } from "../runner/lifecycle-machines.ts"
import type { SharedConnection } from "../storage.ts"
import type { DecisionViewRequest, DecisionViewRows } from "./decision-view.ts"

/**
 * The stored decision views (`decision-view.ts`): one `model_decision_views` row per project and
 * filter key, with its catalog entries, chart points and contributors. A view exists only while a
 * stream reads it: `openDecisionView` creates it on open, and `dropIdleDecisionViews` removes the
 * ones nobody opened for the decision projection's idle period (7 days).
 *
 * `state` is a `projection` lifecycle value: `backfilling` until the first build is written (the
 * panel shows "building"), then `ready`. A later refresh keeps `ready`: the rows it replaces stay
 * valid until its transaction commits.
 *
 * Writes compare before writing: a row whose digest is unchanged is not written, and a refresh
 * whose identity equals the stored one is not computed at all.
 */
const MODULE = schemaModules["model-decision-views"]

const TABLES_SQL = `
  CREATE TABLE model_decision_views (
    id INTEGER PRIMARY KEY,
    project_directory TEXT NOT NULL, filter_key TEXT NOT NULL,
    request TEXT NOT NULL,
    state TEXT NOT NULL,
    identity TEXT, revision INTEGER, price_identity TEXT, snapshot_id TEXT,
    context TEXT, counts TEXT, summary TEXT,
    entry_count INTEGER NOT NULL DEFAULT 0, point_count INTEGER NOT NULL DEFAULT 0,
    produced_at INTEGER, last_read_at INTEGER NOT NULL, last_error TEXT,
    UNIQUE(project_directory, filter_key)
  );
  CREATE INDEX model_decision_views_read ON model_decision_views(last_read_at);
  CREATE TABLE model_catalog_entries (
    id INTEGER PRIMARY KEY, view_id INTEGER NOT NULL,
    rank INTEGER NOT NULL, entry_key TEXT NOT NULL, label TEXT NOT NULL, tags TEXT NOT NULL,
    cost_per_task REAL, tokens REAL, accepted INTEGER, score REAL,
    frontier INTEGER NOT NULL, observed INTEGER NOT NULL, price_source TEXT,
    digest TEXT NOT NULL, detail TEXT NOT NULL,
    UNIQUE(view_id, entry_key)
  );
  CREATE INDEX model_catalog_entries_rank ON model_catalog_entries(view_id, rank, id);
  CREATE TABLE model_decision_points (
    id INTEGER PRIMARY KEY, view_id INTEGER NOT NULL,
    ord INTEGER NOT NULL, reference_ord INTEGER, configuration_id TEXT NOT NULL, label TEXT,
    x REAL, y REAL, frontier INTEGER NOT NULL, point TEXT, reference TEXT,
    digest TEXT NOT NULL,
    UNIQUE(view_id, configuration_id)
  );
  CREATE INDEX model_decision_points_order ON model_decision_points(view_id, ord, id);
  CREATE TABLE model_decision_contributors (
    id INTEGER PRIMARY KEY, view_id INTEGER NOT NULL,
    configuration_id TEXT NOT NULL, ord INTEGER NOT NULL, task_id TEXT NOT NULL,
    digest TEXT NOT NULL, detail TEXT NOT NULL,
    UNIQUE(view_id, configuration_id, ord)
  );
`
const TABLES = [
  "model_decision_views",
  "model_catalog_entries",
  "model_decision_points",
  "model_decision_contributors",
] as const

function installDecisionViewSchema(db: Database) {
  for (const table of TABLES.toReversed()) db.exec(`DROP TABLE IF EXISTS ${table}`)
  db.exec(TABLES_SQL)
}

/** Install once per connection and generation; the views are derived, so a bump drops them. */
export function ensureDecisionViewSchema(shared: SharedConnection) {
  shared.once(`model-decision-views@${MODULE.generation}`, (db) => {
    const registry = Boolean(
      db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_modules'").get(),
    )
    const stored = registry
      ? db
          .query<{ generation: number }, [string]>(
            "SELECT generation FROM schema_modules WHERE module=?",
          )
          .get("model-decision-views")?.generation
      : undefined
    if (stored !== undefined && stored >= MODULE.generation) return
    db.transaction(() => {
      installDecisionViewSchema(db)
      if (registry)
        db.query(
          `INSERT INTO schema_modules VALUES(?,?,?,?) ON CONFLICT(module) DO UPDATE SET
           generation=excluded.generation,tables_json=excluded.tables_json,installed_at=excluded.installed_at`,
        ).run("model-decision-views", MODULE.generation, JSON.stringify(MODULE.tables), Date.now())
    }).immediate()
  })
}

/** The stable key of a request: the filters, basis and task, in one order. */
const decisionViewKey = (request: DecisionViewRequest) =>
  JSON.stringify([
    request.filters.persona,
    request.filters.taskKind,
    request.filters.period.from,
    request.filters.period.to,
    request.basis,
    request.taskID,
  ])

export type StoredView = {
  id: number
  state: "backfilling" | "ready"
  identity: string | null
  request: string
}

/** The view of `request`, created when missing; every open records the read. A point write. */
export function openDecisionView(
  db: Database,
  projectDirectory: string,
  request: DecisionViewRequest,
  now = Date.now(),
): StoredView {
  const key = decisionViewKey(request)
  db.query(
    `INSERT INTO model_decision_views(project_directory,filter_key,request,state,last_read_at)
     VALUES(?,?,?,'backfilling',?)
     ON CONFLICT(project_directory,filter_key) DO UPDATE SET last_read_at=excluded.last_read_at`,
  ).run(projectDirectory, key, JSON.stringify(request), now)
  return db
    .query<StoredView, [string, string]>(
      "SELECT id,state,identity,request FROM model_decision_views WHERE project_directory=? AND filter_key=?",
    )
    .get(projectDirectory, key)!
}

export const storedView = (db: Database, viewID: number) =>
  db
    .query<StoredView, [number]>(
      "SELECT id,state,identity,request FROM model_decision_views WHERE id=?",
    )
    .get(viewID) ?? undefined

const digestOf = (value: unknown) => Bun.hash(JSON.stringify(value)).toString(36)

export type ViewWrite = { transactions: number; written: number; deleted: number; ms: number[] }

/**
 * Rows per transaction while a view is written; a unit of work, not a ceiling. Measured on the
 * live-sized copy (see `.agents/plans/panel-streams.md`, Task 9).
 */
const VIEW_WRITE_PAGE_ROWS = 400

type Upsert = { key: SQLQueryBindings[]; digest: string; values: SQLQueryBindings[] }

/**
 * Replace one table's rows of a view with `rows`, writing only those whose digest changed. Each
 * call is one transaction; the caller pages.
 */
function upsertRows(
  db: Database,
  table: string,
  keyColumns: readonly string[],
  columns: readonly string[],
  viewID: number,
  rows: readonly Upsert[],
) {
  const where = keyColumns.map((column) => `${column}=?`).join(" AND ")
  const existing = db.query<{ id: number; digest: string }, SQLQueryBindings[]>(
    `SELECT id,digest FROM ${table} WHERE view_id=? AND ${where}`,
  )
  const insert = db.query(
    `INSERT INTO ${table}(view_id,${[...keyColumns, ...columns, "digest"].join(",")})
     VALUES(?,${[...keyColumns, ...columns, "digest"].map(() => "?").join(",")})`,
  )
  const update = db.query(
    `UPDATE ${table} SET ${[...columns, "digest"].map((column) => `${column}=?`).join(",")} WHERE id=?`,
  )
  let written = 0
  for (const row of rows) {
    const found = existing.get(viewID, ...row.key)
    if (found?.digest === row.digest) continue
    if (found) update.run(...row.values, row.digest, found.id)
    else insert.run(viewID, ...row.key, ...row.values, row.digest)
    written++
  }
  return written
}

const bool = (value: boolean) => (value ? 1 : 0)
const json = (value: unknown) =>
  value === null || value === undefined ? null : JSON.stringify(value)

/**
 * Write a computed view: its entries and points, then contributors, `VIEW_WRITE_PAGE_ROWS` rows
 * per transaction, then the view row, which moves the view to `ready`. A stream reads each page as
 * it commits; a configuration's contributors are written in one page with their deletions.
 */
export function writeDecisionView(
  db: Database,
  viewID: number,
  rows: DecisionViewRows,
  now = Date.now(),
): ViewWrite {
  const result: ViewWrite = { transactions: 0, written: 0, deleted: 0, ms: [] }
  const run = (work: () => void) => {
    const started = performance.now()
    db.transaction(work).immediate()
    result.ms.push(performance.now() - started)
    result.transactions++
  }
  const entries: Upsert[] = rows.entries.map((entry) => ({
    key: [entry.key],
    digest: digestOf(entry),
    values: [
      entry.rank,
      entry.label,
      entry.tags,
      entry.costPerTask,
      entry.tokens,
      entry.accepted,
      entry.score,
      bool(entry.frontier),
      bool(entry.observed),
      entry.priceSource,
      JSON.stringify(entry.detail),
    ],
  }))
  const points: Upsert[] = rows.points.map((point) => ({
    key: [point.configurationID],
    digest: digestOf(point),
    values: [
      point.ord,
      point.referenceOrd,
      point.label,
      point.x,
      point.y,
      bool(point.frontier),
      json(point.point),
      json(point.reference),
    ],
  }))
  const pages = <T>(items: readonly T[]) => {
    const out: T[][] = []
    for (let at = 0; at < items.length; at += VIEW_WRITE_PAGE_ROWS)
      out.push(items.slice(at, at + VIEW_WRITE_PAGE_ROWS))
    return out.length ? out : [[]]
  }
  const entryColumns = [
    "rank",
    "label",
    "tags",
    "cost_per_task",
    "tokens",
    "accepted",
    "score",
    "frontier",
    "observed",
    "price_source",
    "detail",
  ]
  const pointColumns = ["ord", "reference_ord", "label", "x", "y", "frontier", "point", "reference"]
  for (const [index, page] of pages(entries).entries())
    run(() => {
      result.written += upsertRows(
        db,
        "model_catalog_entries",
        ["entry_key"],
        entryColumns,
        viewID,
        page,
      )
      if (index === 0)
        result.deleted += db
          .query(
            `DELETE FROM model_catalog_entries WHERE view_id=?
               AND entry_key NOT IN (SELECT value FROM json_each(?))`,
          )
          .run(viewID, JSON.stringify(rows.entries.map((entry) => entry.key))).changes
    })
  for (const [index, page] of pages(points).entries())
    run(() => {
      result.written += upsertRows(
        db,
        "model_decision_points",
        ["configuration_id"],
        pointColumns,
        viewID,
        page,
      )
      if (index === 0)
        result.deleted += db
          .query(
            `DELETE FROM model_decision_points WHERE view_id=?
               AND configuration_id NOT IN (SELECT value FROM json_each(?))`,
          )
          .run(viewID, JSON.stringify(rows.points.map((point) => point.configurationID))).changes
    })
  // Contributors: whole configurations per page, each with the removal of its surplus rows.
  const byConfiguration = Map.groupBy(rows.contributors, (row) => row.configurationID)
  const writeConfiguration = (configurationID: string, list: DecisionViewRows["contributors"]) => {
    result.written += upsertRows(
      db,
      "model_decision_contributors",
      ["configuration_id", "ord"],
      ["task_id", "detail"],
      viewID,
      list.map((row) => ({
        key: [row.configurationID, row.ord],
        digest: digestOf(row.detail),
        values: [row.taskID, JSON.stringify(row.detail)],
      })),
    )
    result.deleted += db
      .query(
        "DELETE FROM model_decision_contributors WHERE view_id=? AND configuration_id=? AND ord>=?",
      )
      .run(viewID, configurationID, list.length).changes
  }
  let batch: [string, DecisionViewRows["contributors"]][] = []
  let size = 0
  for (const entry of byConfiguration) {
    batch.push(entry)
    size += entry[1].length
    if (size < VIEW_WRITE_PAGE_ROWS) continue
    const work = batch
    run(() => {
      for (const [configurationID, list] of work) writeConfiguration(configurationID, list)
    })
    batch = []
    size = 0
  }
  run(() => {
    for (const [configurationID, list] of batch) writeConfiguration(configurationID, list)
    result.deleted += db
      .query(
        `DELETE FROM model_decision_contributors WHERE view_id=?
           AND configuration_id NOT IN (SELECT value FROM json_each(?))`,
      )
      .run(viewID, JSON.stringify([...byConfiguration.keys()])).changes
    const current = db
      .query<{ state: "backfilling" | "ready" }, [number]>(
        "SELECT state FROM model_decision_views WHERE id=?",
      )
      .get(viewID)
    if (!current) return
    db.query(
      `UPDATE model_decision_views SET state=?,identity=?,revision=?,price_identity=?,snapshot_id=?,
         context=?,counts=?,summary=?,entry_count=?,point_count=?,produced_at=?,last_error=NULL
       WHERE id=?`,
    ).run(
      lifecycleTransition("projection", current.state, "ready"),
      rows.identity,
      rows.revision,
      rows.priceIdentity,
      rows.snapshotID,
      JSON.stringify(rows.context),
      JSON.stringify(rows.counts),
      JSON.stringify(rows.summary),
      rows.entries.length,
      rows.points.length,
      now,
      viewID,
    )
  })
  return result
}

/** Record a failed build; the view keeps its rows and state, and the next open or change retries. */
export function recordDecisionViewError(db: Database, viewID: number, error: string) {
  db.query("UPDATE model_decision_views SET last_error=? WHERE id=?").run(
    error.slice(0, 500),
    viewID,
  )
}

/** Rows deleted per transaction while an idle view is dropped; a unit of work. */
const DROP_PAGE_ROWS = 5_000

/** Drop the views nobody opened since `now - idleMs`, a page of rows per transaction. */
export function dropIdleDecisionViews(db: Database, options: { now: number; idleMs: number }) {
  let dropped = 0
  const next = db.query<{ id: number }, [number]>(
    "SELECT id FROM model_decision_views WHERE last_read_at<? ORDER BY last_read_at LIMIT 1",
  )
  for (
    let view = next.get(options.now - options.idleMs);
    view;
    view = next.get(options.now - options.idleMs)
  ) {
    for (const table of TABLES.slice(1))
      while (
        db
          .transaction(
            () =>
              db
                .query(
                  `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE view_id=? LIMIT ?)`,
                )
                .run(view!.id, DROP_PAGE_ROWS).changes,
          )
          .immediate() >= DROP_PAGE_ROWS
      );
    db.query("DELETE FROM model_decision_views WHERE id=?").run(view.id)
    dropped++
  }
  return dropped
}

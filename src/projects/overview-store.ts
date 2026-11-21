import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import { ensureProjectionStateSchema, resetProjectionState } from "../projections/lifecycle.ts"
import type { ProjectionSpec } from "../projections/owner.ts"
import { enrollProjectionConnection, registerProjectionDrain } from "../projections/hook.ts"
import { drainQueue, queueTableSQL } from "../projections/queue.ts"
import type { TaskRepository } from "../storage.ts"
import { activeProfileForKey } from "./profile-store.ts"
import { projectNameFor } from "./registry.ts"
import { canonicalPath } from "./scope.ts"
import { GLOBAL_SCOPE } from "./setting-schemas.ts"
import {
  globalSettingsIn,
  projectSettingsIn,
  type GlobalSettings,
  type ProjectSettings,
} from "./settings.ts"

/**
 * `project_overview` (one row per registered project) and `project_global` (one row): what the
 * Projects section shows, stored so a stream reads rows instead of the section re-reading the
 * registry, pauses, settings, Architect contact and profile every 3 s.
 *
 * ```
 * lazers_projects, lazers_project_paths, lazers_settings, lazers_dispatch_pause,
 * runner_architect_contact, lazers_profile_revisions
 *   ── guarded triggers ─► project_overview_dirty(ref: project key, or "global")
 *   ── drain in the writer's transaction (projections hook), or the owner ─► rows
 * ```
 *
 * Every writer of those tables is covered by the triggers with no code of its own. Settings are
 * stored resolved: plugin-option defaults are known at service start, which queues every row once
 * (the owner's one-page backfill). `canonical_checkouts` is the checkouts' real paths, which
 * `project_presence` (`presence.ts`) is matched against for "loaded".
 */
const MODULE = schemaModules["project-overview"]
const PROJECT_OVERVIEW = "project-overview"
const QUEUE = "project_overview_dirty"

const TABLES_SQL = `
  CREATE TABLE project_overview (
    id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, code TEXT NOT NULL, name TEXT NOT NULL,
    created_at TEXT NOT NULL, checkouts TEXT NOT NULL, canonical_checkouts TEXT NOT NULL,
    paused INTEGER NOT NULL, pause_reason TEXT, pause_by TEXT, pause_at INTEGER,
    architect_contact INTEGER NOT NULL, architect_contact_reason TEXT,
    settings TEXT NOT NULL, profile_state TEXT NOT NULL, profile_revision INTEGER
  );
  CREATE INDEX project_overview_order ON project_overview(created_at, key);
  CREATE TABLE project_global (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    paused INTEGER NOT NULL, pause_reason TEXT, pause_by TEXT, pause_at INTEGER,
    settings TEXT NOT NULL
  );
  CREATE TABLE project_presence (
    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, canonical TEXT NOT NULL,
    instance TEXT NOT NULL, loaded_at INTEGER NOT NULL
  );
  CREATE INDEX project_presence_canonical ON project_presence(canonical);
  ${queueTableSQL(QUEUE)}
`

/**
 * Queue the refs a select names. No `INSERT OR REPLACE`: SQLite applies an outer statement's
 * conflict handling to the statements of its triggers, so under a writer's upsert
 * (`ON CONFLICT DO UPDATE`, as `setPause` and the settings writer use) a second queue of the same
 * ref fails the writer with a UNIQUE error. Reset an existing entry, then insert a missing one.
 */
const queueSelect = (select: string) => `
  UPDATE ${QUEUE} SET next_at=0,attempts=0,error=NULL WHERE ref IN (${select});
  INSERT INTO ${QUEUE}(ref) SELECT ref FROM (${select}) WHERE ref NOT IN (SELECT ref FROM ${QUEUE});`
const queue = (ref: string) => queueSelect(`SELECT ${ref} AS ref`)
const keysOfPath = (path: string) =>
  queueSelect(`SELECT DISTINCT key AS ref FROM lazers_project_paths WHERE path=${path}`)

/** The triggers, per source table: every insert, update and delete queues the row it names. */
const TRIGGERS: { on: string; body: (row: "NEW" | "OLD") => string }[] = [
  { on: "lazers_projects", body: (row) => queue(`${row}.key`) },
  { on: "lazers_project_paths", body: (row) => queue(`${row}.key`) },
  { on: "lazers_settings", body: (row) => queue(`${row}.scope`) },
  { on: "lazers_dispatch_pause", body: (row) => queue(`${row}.scope`) },
  { on: "runner_architect_contact", body: (row) => keysOfPath(`${row}.project_directory`) },
  { on: "lazers_profile_revisions", body: (row) => queue(`${row}.project_key`) },
]
const EVENTS = [
  ["insert", "INSERT", ["NEW"]],
  ["update", "UPDATE", ["OLD", "NEW"]],
  ["delete", "DELETE", ["OLD"]],
] as const
const triggerName = (on: string, event: string) => `project_overview_${on}_${event}`

const hasTable = (db: Database, name: string) =>
  Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))

/** Create the triggers on every source table that exists now; safe to run again. */
/** Each trigger the existing source tables need, with the SQL that creates it. */
function overviewTriggers(db: Database) {
  if (!hasTable(db, "project_overview")) return []
  return TRIGGERS.filter((trigger) => hasTable(db, trigger.on)).flatMap((trigger) =>
    EVENTS.map(([suffix, event, rows]) => ({
      name: triggerName(trigger.on, suffix),
      sql: `CREATE TRIGGER ${triggerName(trigger.on, suffix)} AFTER ${event} ON ${trigger.on} BEGIN
           ${rows.map(trigger.body).join("\n")}
         END`,
    })),
  )
}

/** The triggers missing or stale (a source table created after the module): none on a current database. */
function staleOverviewTriggers(db: Database) {
  const stored = new Map(
    db
      .query<{ name: string; sql: string }, []>(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'project_overview_%'",
      )
      .all()
      .map((row) => [row.name, row.sql]),
  )
  return overviewTriggers(db).filter((trigger) => stored.get(trigger.name) !== trigger.sql)
}

function installProjectOverviewTriggers(db: Database) {
  for (const trigger of staleOverviewTriggers(db))
    db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}; ${trigger.sql};`)
}

function installProjectOverviewSchema(db: Database) {
  for (const trigger of TRIGGERS)
    for (const [suffix] of EVENTS)
      db.exec(`DROP TRIGGER IF EXISTS ${triggerName(trigger.on, suffix)}`)
  db.exec(`DROP TABLE IF EXISTS project_overview; DROP TABLE IF EXISTS project_global;
    DROP TABLE IF EXISTS project_presence; DROP TABLE IF EXISTS ${QUEUE};`)
  db.exec(TABLES_SQL)
  resetProjectionState(db, PROJECT_OVERVIEW)
  installProjectOverviewTriggers(db)
}

/**
 * Install through the module registry; a trigger missing or stale is re-created on every call, so
 * a source table created after the module (the runner's contact table in a database that had
 * none) is covered from the next start.
 */
export function ensureProjectOverviewSchema(repository: TaskRepository) {
  ensureProjectionStateSchema(repository)
  repository.installSchema("project-overview", MODULE.generation, MODULE.tables, (db) =>
    installProjectOverviewSchema(db),
  )
  // Read first: a current database has every trigger, and its load takes no write lock.
  if (repository.read((db) => staleOverviewTriggers(db).length > 0))
    repository.atomic((db) => installProjectOverviewTriggers(db))
  registerProjectionDrain(PROJECT_OVERVIEW, QUEUE, (db) => void drainOverview(db))
  repository.read((db) => enrollProjectionConnection(db, PROJECT_OVERVIEW))
}

export type ProjectsDefaults = {
  global?: Partial<GlobalSettings>
  project?: Partial<ProjectSettings>
}

/** The plugin-option defaults of settings never set, from the plugin options. */
export function projectsDefaultsOf(options: Record<string, unknown>): ProjectsDefaults {
  return {
    global: {},
    project:
      typeof options.workerSpendCeilingTokens === "number" && options.workerSpendCeilingTokens > 0
        ? { spendCeilingTokens: options.workerSpendCeilingTokens }
        : {},
  }
}

/** The defaults the stored settings were resolved with; one service process per database. */
const defaultsKey = Symbol.for("lazers.project-overview.defaults.v1")
const host = globalThis as typeof globalThis & { [defaultsKey]?: ProjectsDefaults }
const defaults = () => host[defaultsKey] ?? {}

type PauseRow = { reason: string; by: string; updated_at: number }
const pauseOf = (db: Database, scope: string) =>
  db
    .query<PauseRow, [string]>(
      "SELECT reason,by,updated_at FROM lazers_dispatch_pause WHERE scope=? AND state='paused'",
    )
    .get(scope)

function writeIfChanged(db: Database, table: string, key: string, row: Record<string, unknown>) {
  const columns = Object.keys(row)
  const stored = db
    .query<Record<string, unknown>, [string | number]>(
      `SELECT ${columns.join(",")} FROM ${table} WHERE ${key}=?`,
    )
    .get(row[key] as string | number)
  if (stored && columns.every((column) => stored[column] === row[column])) return
  db.query(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})
     ON CONFLICT(${key}) DO UPDATE SET ${columns.map((column) => `${column}=excluded.${column}`).join(",")}`,
  ).run(...(columns.map((column) => row[column]) as never[]))
}

/** Recompute one stored row from the source tables, in the caller's transaction. */
function refreshOverview(db: Database, ref: string) {
  const pause = pauseOf(db, ref)
  const paused = {
    paused: Number(Boolean(pause)),
    pause_reason: pause?.reason ?? null,
    pause_by: pause?.by ?? null,
    pause_at: pause?.updated_at ?? null,
  }
  if (ref === GLOBAL_SCOPE) {
    writeIfChanged(db, "project_global", "id", {
      id: 1,
      ...paused,
      settings: JSON.stringify(globalSettingsIn(db, defaults().global)),
    })
    return
  }
  const project = db
    .query<{ code: string | null; name: string | null; created_at: string }, [string]>(
      "SELECT code,name,created_at FROM lazers_projects WHERE key=?",
    )
    .get(ref)
  // A project without a code is not listed (as the registry read leaves it out).
  if (!project?.code) {
    db.query("DELETE FROM project_overview WHERE key=?").run(ref)
    return
  }
  const paths = db
    .query<{ path: string }, [string]>(
      "SELECT path FROM lazers_project_paths WHERE key=? ORDER BY rowid",
    )
    .all(ref)
    .map((row) => row.path)
  const contact = hasTable(db, "runner_architect_contact")
    ? paths
        .map((path) =>
          db
            .query<{ reason: string }, [string]>(
              "SELECT reason FROM runner_architect_contact WHERE project_directory=? AND state='paused'",
            )
            .get(path),
        )
        .find(Boolean)
    : undefined
  const active = activeProfileForKey({ read: <T>(run: (db: Database) => T) => run(db) }, ref)
  writeIfChanged(db, "project_overview", "key", {
    key: ref,
    code: project.code,
    name: project.name ?? projectNameFor("", ref),
    created_at: project.created_at,
    checkouts: JSON.stringify(paths),
    canonical_checkouts: JSON.stringify(paths.map(canonicalPath)),
    ...paused,
    architect_contact: Number(Boolean(contact)),
    architect_contact_reason: contact?.reason ?? null,
    settings: JSON.stringify(projectSettingsIn(db, ref, defaults().project)),
    profile_state: active ? "active" : "none",
    profile_revision: active?.revision ?? null,
  })
}

/** Rows per drain transaction: three live projects; a unit of work, not a cap. */
const DRAIN_BUDGET = 50

const drainOverview = (db: Database) =>
  drainQueue(db, QUEUE, refreshOverview, { budget: DRAIN_BUDGET })

function queueEverything(db: Database) {
  db.query(`INSERT OR REPLACE INTO ${QUEUE}(ref) VALUES(?)`).run(GLOBAL_SCOPE)
  db.exec(`INSERT OR REPLACE INTO ${QUEUE}(ref) SELECT key FROM lazers_projects`)
}

/**
 * Settings are resolved with these defaults from now on. When they differ from the ones the rows
 * hold (a new service, or a changed plugin option), every row is queued and refreshed in the same
 * transaction.
 */
export function setProjectOverviewDefaults(repository: TaskRepository, next: ProjectsDefaults) {
  if (JSON.stringify(host[defaultsKey]) === JSON.stringify(next)) return
  repository.atomic((db) => {
    queueEverything(db)
    drainOverview(db)
  })
  // Recorded once written: a busy database leaves the next call to write them.
  host[defaultsKey] = next
}

/**
 * The owner: a one-page backfill (queue every project and the global row, drain them) and the
 * queue's parked entries. Database-wide: scope "".
 */
export const projectOverviewProjection: ProjectionSpec = {
  name: PROJECT_OVERVIEW,
  generation: 1,
  backfill: [
    {
      name: "rows",
      page(db) {
        queueEverything(db)
        drainOverview(db)
        return { next: 0, done: true }
      },
    },
  ],
  queue: { table: QUEUE, drain: drainOverview },
}

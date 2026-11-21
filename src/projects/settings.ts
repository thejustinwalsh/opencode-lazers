import { installScheduleTriggers } from "../tasks/schedule/schema.ts"
import type { Database } from "bun:sqlite"
import { z } from "zod"
import { schemaModules } from "../database-schema.ts"
import type { TaskRepository } from "../storage.ts"
import {
  GLOBAL_SCOPE,
  globalSettingDefs,
  projectSettingDefs,
  type GlobalSettings,
  type ProjectSettings,
  type SettingDef,
} from "./setting-schemas.ts"

/**
 * Two-level settings: every setting has exactly one level. A value stored here (set in
 * Settings) wins; a plugin option is only the default for a value never set; built-in defaults
 * come last. Storing `undefined` clears the value. Tables live in the `project-controls` module.
 */
export type { GlobalSettings, ProjectSettings }

const schemasOf = (defs: Record<string, SettingDef>) =>
  Object.fromEntries(Object.entries(defs).map(([name, def]) => [name, def.schema])) as Record<
    string,
    z.ZodType
  >
const builtInsOf = <T>(defs: Record<string, SettingDef>) =>
  Object.fromEntries(Object.entries(defs).map(([name, def]) => [name, def.builtIn])) as T
const globalSchema = schemasOf(globalSettingDefs)
const projectSchema = schemasOf(projectSettingDefs)

const builtInGlobal = builtInsOf<GlobalSettings>(globalSettingDefs)
const builtInProject = builtInsOf<ProjectSettings>(projectSettingDefs)

type Controls = Pick<TaskRepository, "read" | "atomic" | "changed">

export function installProjectControlsSchema(repository: TaskRepository): void {
  const module = schemaModules["project-controls"]
  repository.installSchema(
    "project-controls",
    module.generation,
    module.tables,
    createControlTables,
  )
}

/** The control tables, then the schedule projection's triggers on them (a no-op until it installs). */
export function createControlTables(db: Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS lazers_settings (
        scope TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope, name)
      );
      CREATE TABLE IF NOT EXISTS lazers_dispatch_pause (
        scope TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('enabled','paused')),
        reason TEXT NOT NULL, by TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
    `)
  installScheduleTriggers(db)
}

/** The project a checkout directory belongs to; undefined until the project is registered. */
export function projectKeyOfDirectory(
  repository: Pick<TaskRepository, "read">,
  directory: string,
): string | undefined {
  return repository.read(
    (db) =>
      db
        .query<{ key: string }, [string]>("SELECT key FROM lazers_project_paths WHERE path=?")
        .get(directory)?.key,
  )
}

function resolve<T extends Record<string, unknown>>(
  schema: Record<string, z.ZodType>,
  builtIn: T,
  defaults: Partial<T>,
  stored: Map<string, string>,
): T {
  const out: Record<string, unknown> = { ...builtIn }
  for (const name of Object.keys(schema) as (keyof T & string)[]) {
    const fallback = schema[name]!.safeParse(defaults[name])
    if (fallback.success && defaults[name] !== undefined) out[name] = fallback.data
    const raw = stored.get(name)
    if (raw === undefined) continue
    try {
      const parsed = schema[name]!.safeParse(JSON.parse(raw))
      if (parsed.success) out[name] = parsed.data
    } catch {
      // A corrupt stored value falls back to the default.
    }
  }
  return out as T
}

function storedValues(db: Database, scope: string) {
  return new Map(
    db
      .query<{ name: string; value: string }, [string]>(
        "SELECT name,value FROM lazers_settings WHERE scope=?",
      )
      .all(scope)
      .map((row) => [row.name, row.value]),
  )
}

export function globalSettings(
  repository: Pick<TaskRepository, "read">,
  defaults: Partial<GlobalSettings> = {},
): GlobalSettings {
  return resolve(
    globalSchema,
    builtInGlobal,
    defaults,
    repository.read((db) => storedValues(db, GLOBAL_SCOPE)),
  )
}

export function projectSettings(
  repository: Pick<TaskRepository, "read">,
  key: string,
  defaults: Partial<ProjectSettings> = {},
): ProjectSettings {
  return resolve(
    projectSchema,
    builtInProject,
    defaults,
    repository.read((db) => storedValues(db, key)),
  )
}

/** `globalSettings` inside an open transaction (the Projects overview refresh). */
export function globalSettingsIn(
  db: Database,
  defaults: Partial<GlobalSettings> = {},
): GlobalSettings {
  return resolve(globalSchema, builtInGlobal, defaults, storedValues(db, GLOBAL_SCOPE))
}

/**
 * `projectSettings` inside an open transaction (dispatch admission reads it there). A database
 * without the settings table yet reads as never set.
 */
export function projectSettingsIn(
  db: Database,
  key: string,
  defaults: Partial<ProjectSettings> = {},
): ProjectSettings {
  const table = db
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lazers_settings'")
    .get()
  return resolve(projectSchema, builtInProject, defaults, table ? storedValues(db, key) : new Map())
}

function write(
  repository: Controls,
  scope: string,
  schema: Record<string, z.ZodType>,
  name: string,
  value: unknown,
) {
  const rule = schema[name]
  if (!rule) throw new Error(`Unknown setting ${name}`)
  if (value !== undefined) {
    const parsed = rule.safeParse(value)
    if (!parsed.success) throw new Error(`Invalid ${name}: ${parsed.error.issues[0]?.message}`)
  }
  repository.atomic((db) => {
    if (value === undefined)
      db.query("DELETE FROM lazers_settings WHERE scope=? AND name=?").run(scope, name)
    else
      db.query(
        `INSERT INTO lazers_settings VALUES(?,?,?,?)
         ON CONFLICT(scope,name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      ).run(scope, name, JSON.stringify(value), Date.now())
    repository.changed()
  })
}

export function setGlobalSetting<K extends keyof GlobalSettings>(
  repository: Controls,
  name: K,
  value: GlobalSettings[K] | undefined,
): void {
  write(repository, GLOBAL_SCOPE, globalSchema, name, value)
}

export function setProjectSetting<K extends keyof ProjectSettings>(
  repository: Controls,
  key: string,
  name: K,
  value: ProjectSettings[K] | undefined,
): void {
  if (!key || key === GLOBAL_SCOPE) throw new Error("A project setting needs a project key")
  write(repository, key, projectSchema, name, value)
}

/** The worker spend ceiling for a checkout: a stored value, else the plugin option, else none. */
export function spendCeilingFor(
  repository: Pick<TaskRepository, "read">,
  directory: string,
  option: unknown,
): number | undefined {
  const defaults: Partial<ProjectSettings> =
    typeof option === "number" && option > 0 ? { spendCeilingTokens: option } : {}
  const key = projectKeyOfDirectory(repository, directory)
  const value = key
    ? projectSettings(repository, key, defaults).spendCeilingTokens
    : (defaults.spendCeilingTokens ?? null)
  return value ?? undefined
}

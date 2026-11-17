import type { Database } from "bun:sqlite"
import { realpathSync } from "node:fs"
import { schemaModules } from "./database-schema.ts"
import type { TaskRepository } from "./storage.ts"

/** Stable LAZERS project identity: survives OpenCode project-id and history changes. */

export type AliasKind = "opencode-project-id" | "remote" | "root-commit"

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** `git@host:o/r`, `ssh://git@host/o/r`, `https://u:p@Host/o/r.git` -> `host/o/r`. */
export function normalizeRemote(url: string): string {
  let value = url.trim()
  if (!value) return ""
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(value)
  if (scp && !SCHEME.test(value)) value = `ssh://${scp[1]}/${scp[2]}`
  let host: string
  let path: string
  try {
    const parsed = new URL(SCHEME.test(value) ? value : `ssh://${value}`)
    host = parsed.hostname
    path = parsed.pathname
  } catch {
    return value.toLowerCase()
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
  return `${host.toLowerCase()}/${path}`
}

async function git(directory: string, ...args: string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "-C", directory, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    })
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return code === 0 ? text.trim() : undefined
  } catch {
    return undefined
  }
}

/** Upstream remote of the current branch, else `origin`, else the only remote. */
async function defaultRemote(directory: string): Promise<string | undefined> {
  const remotes = ((await git(directory, "remote")) ?? "").split("\n").filter(Boolean)
  if (remotes.length === 0) return undefined
  const branch = await git(directory, "symbolic-ref", "--short", "-q", "HEAD")
  const tracked = branch ? await git(directory, "config", "--get", `branch.${branch}.remote`) : ""
  const name =
    tracked && remotes.includes(tracked)
      ? tracked
      : remotes.includes("origin")
        ? "origin"
        : remotes.length === 1
          ? remotes[0]
          : undefined
  return name ? git(directory, "remote", "get-url", name) : undefined
}

export type ProjectKey = {
  key: string
  remoteURL: string | undefined
  rootCommit: string | undefined
  canonicalPath: string
}

function canonicalPath(directory: string): string {
  try {
    return realpathSync(directory)
  } catch {
    return directory
  }
}

/** Key: normalized default remote, else `root:<root commit>`, else `path:<canonical dir>`. */
export async function projectKeyFor(directory: string): Promise<ProjectKey> {
  const path = canonicalPath(directory)
  const [remote, roots] = await Promise.all([
    defaultRemote(path),
    git(path, "rev-list", "--max-parents=0", "HEAD"),
  ])
  const rootCommit = roots?.split("\n").filter(Boolean).sort()[0]
  const normalized = remote ? normalizeRemote(remote) : ""
  const key = normalized || (rootCommit ? `root:${rootCommit}` : `path:${path}`)
  return { key, remoteURL: normalized || undefined, rootCommit, canonicalPath: path }
}

export function installProjectSchema(repository: TaskRepository): void {
  const module = schemaModules.projects
  repository.installSchema("projects", module.generation, module.tables, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lazers_projects (
        key TEXT PRIMARY KEY, created_at TEXT NOT NULL, remote_url TEXT, root_commit TEXT
      );
      CREATE TABLE IF NOT EXISTS lazers_project_aliases (
        alias TEXT PRIMARY KEY, key TEXT NOT NULL REFERENCES lazers_projects(key),
        kind TEXT NOT NULL CHECK(kind IN ('opencode-project-id','remote','root-commit')),
        first_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lazers_project_aliases_key ON lazers_project_aliases(key);
      CREATE TABLE IF NOT EXISTS lazers_project_paths (
        path TEXT PRIMARY KEY, key TEXT NOT NULL REFERENCES lazers_projects(key),
        last_seen_at TEXT NOT NULL
      );
    `)
  })
}

// In-process alias groups, filled from lazers_project_aliases. Sync lookups keep
// ownership checks cheap; unknown ids match only themselves.
const idToKey = new Map<string, string>()
const keyToIds = new Map<string, Set<string>>()

function remember(id: string, key: string): void {
  const previous = idToKey.get(id)
  if (previous && previous !== key) keyToIds.get(previous)?.delete(id)
  idToKey.set(id, key)
  let ids = keyToIds.get(key)
  if (!ids) keyToIds.set(key, (ids = new Set()))
  ids.add(id)
}

export function resetProjectAliasCache(): void {
  idToKey.clear()
  keyToIds.clear()
}

/** Every OpenCode project id known to share a project with `id`; always includes `id`. */
export function projectIdsFor(id: string): string[] {
  const key = idToKey.get(id)
  const ids = key ? keyToIds.get(key) : undefined
  return ids?.has(id) ? [...ids] : [id, ...(ids ?? [])]
}

export function sameProject(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const key = idToKey.get(a)
  return key !== undefined && key === idToKey.get(b)
}

/** SQL helper: bind as one parameter to `col IN (SELECT value FROM json_each(?))`. */
export function projectIdsJSON(id: string): string {
  return JSON.stringify(projectIdsFor(id))
}

export function hydrateProjectAliases(repository: TaskRepository): void {
  for (const row of repository.read((db) =>
    db
      .query<{ alias: string; key: string }, []>(
        "SELECT alias,key FROM lazers_project_aliases WHERE kind='opencode-project-id'",
      )
      .all(),
  ))
    remember(row.alias, row.key)
}

export function projectIdsForKey(repository: TaskRepository, key: string): string[] {
  return repository
    .read((db) =>
      db
        .query<{ alias: string }, [string]>(
          "SELECT alias FROM lazers_project_aliases WHERE key=? AND kind='opencode-project-id'",
        )
        .all(key),
    )
    .map((row) => row.alias)
}

export function aliasesFor(repository: TaskRepository, opencodeProjectID: string): string[] {
  const row = repository.read((db) =>
    db
      .query<{ key: string }, [string]>("SELECT key FROM lazers_project_aliases WHERE alias=?")
      .get(opencodeProjectID),
  )
  return row ? projectIdsForKey(repository, row.key) : [opencodeProjectID]
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
}

/** OpenCode's shared id for non-project sessions; never a stable identity. */
const GLOBAL_PROJECT_ID = "global"

const BACKFILL_TABLES = [
  "runner_progress",
  "recovery_progress_facts",
  "native_tool_calls",
  "context_publications",
] as const

/** Distinct project ids already recorded for one canonical project directory. */
export function recordedProjectIds(db: Database, projectDirectory: string): string[] {
  const ids = new Set<string>()
  for (const table of BACKFILL_TABLES) {
    if (!tableExists(db, table)) continue
    for (const row of db
      .query<{ id: string }, [string]>(
        `SELECT DISTINCT project_id AS id FROM ${table} WHERE project_directory=?`,
      )
      .all(projectDirectory))
      if (row.id && row.id !== GLOBAL_PROJECT_ID) ids.add(row.id)
  }
  for (const row of db
    .query<{ id: string | null }, [string]>(
      "SELECT DISTINCT json_extract(body,'$.provenance.projectID') AS id FROM tasks WHERE project_directory=?",
    )
    .all(projectDirectory))
    if (row.id && row.id !== GLOBAL_PROJECT_ID) ids.add(row.id)
  return [...ids]
}

export type ProjectRegistration = { key: string; aliased: string[] }

/**
 * Register the current location. The synchronous part hydrates the alias cache
 * from the database; the returned promise resolves the key (async git) and
 * upserts the project, its aliases, its path and backfilled historical ids.
 */
export function registerProject(
  repository: TaskRepository,
  input: { directory: string; opencodeProjectID: string },
  now: () => Date = () => new Date(),
): Promise<ProjectRegistration> {
  hydrateProjectAliases(repository)
  return projectKeyFor(input.directory).then((resolved) => {
    const at = now().toISOString()
    return repository.atomic((db) => {
      db.query(
        `INSERT INTO lazers_projects(key,created_at,remote_url,root_commit) VALUES(?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET remote_url=COALESCE(excluded.remote_url,remote_url),
           root_commit=COALESCE(excluded.root_commit,root_commit)`,
      ).run(resolved.key, at, resolved.remoteURL ?? null, resolved.rootCommit ?? null)
      const alias = (value: string, kind: AliasKind) =>
        db
          .query(
            "INSERT OR IGNORE INTO lazers_project_aliases(alias,key,kind,first_seen_at) VALUES(?,?,?,?)",
          )
          .run(value, resolved.key, kind, at)
      const aliased = new Set<string>()
      // Historical ids are a closed set; scan the large tables once per path and key.
      const known = db
        .query("SELECT 1 FROM lazers_project_paths WHERE path=? AND key=?")
        .get(repository.projectDirectory, resolved.key)
      for (const id of [
        input.opencodeProjectID,
        ...(known
          ? []
          : [
              ...recordedProjectIds(db, repository.projectDirectory),
              ...recordedProjectIds(db, resolved.canonicalPath),
            ]),
      ]) {
        alias(id, "opencode-project-id")
        aliased.add(id)
      }
      if (resolved.remoteURL) alias(resolved.remoteURL, "remote")
      if (resolved.rootCommit) alias(resolved.rootCommit, "root-commit")
      for (const path of new Set([resolved.canonicalPath, repository.projectDirectory]))
        db.query(
          `INSERT INTO lazers_project_paths(path,key,last_seen_at) VALUES(?,?,?)
           ON CONFLICT(path) DO UPDATE SET key=excluded.key,last_seen_at=excluded.last_seen_at`,
        ).run(path, resolved.key, at)
      for (const id of aliased) {
        const owner = db
          .query<{ key: string }, [string]>("SELECT key FROM lazers_project_aliases WHERE alias=?")
          .get(id)
        if (owner) remember(id, owner.key)
      }
      return { key: resolved.key, aliased: [...aliased] }
    })
  })
}

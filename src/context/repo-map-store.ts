import { schemaModules } from "../database-schema.ts"
import { activeProfile } from "../projects/profile-store.ts"
import type { TaskRepository } from "../storage.ts"
import {
  buildRepoMap,
  deriveSourceDefinition,
  type RepoMap,
  type SourceDefinition,
} from "./repo-map.ts"

type Storage = Pick<TaskRepository, "read" | "atomic">

/** Tables, per project source setting, per plan frozen map, and per session delivery facts. */
export function installRepoMapSchema(repository: TaskRepository): void {
  const module = schemaModules["repo-map"]
  repository.installSchema("repo-map", module.generation, module.tables, (db) => {
    db.exec(`
      DROP TABLE IF EXISTS context_workspaces;
      DROP TABLE IF EXISTS context_cache;
      DROP TABLE IF EXISTS context_publications;
      CREATE TABLE IF NOT EXISTS repo_map_sources (
        project_directory TEXT PRIMARY KEY, include TEXT NOT NULL, exclude TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repo_maps (
        plan_id TEXT PRIMARY KEY, hash TEXT NOT NULL, tokens INTEGER NOT NULL,
        files INTEGER NOT NULL, names INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repo_map_deliveries (
        session_id TEXT NOT NULL, task_id TEXT NOT NULL, plan_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('worker','architect')),
        map_hash TEXT, map_tokens INTEGER, source_context_tokens INTEGER,
        delivered_at INTEGER NOT NULL, PRIMARY KEY(session_id, task_id)
      );
    `)
  })
}

/** The project's stored source definition, if one was set; the default derivation applies otherwise. */
export function repoMapSource(
  repository: Pick<TaskRepository, "read">,
  directory: string,
): SourceDefinition | undefined {
  const row = repository.read((db) =>
    db
      .query<{ include: string; exclude: string }, [string]>(
        "SELECT include,exclude FROM repo_map_sources WHERE project_directory=?",
      )
      .get(directory),
  )
  if (!row) return undefined
  try {
    return { include: JSON.parse(row.include), exclude: JSON.parse(row.exclude) }
  } catch {
    return undefined
  }
}

/**
 * Build the map for a checkout. The source is, in order: the project's confirmed profile (any
 * language, exported names for TypeScript only), a stored source filter, else the derived default.
 * `projectDirectory` names the project whose profile applies; it defaults to the checkout.
 */
export async function currentRepoMap(
  repository: Pick<TaskRepository, "read">,
  directory: string,
  projectDirectory: string = directory,
): Promise<RepoMap> {
  const profile = activeProfile(repository, projectDirectory)
  if (profile) return await buildRepoMap(directory, profile.profile.source, { anyExtension: true })
  const definition =
    repoMapSource(repository, directory) ?? (await deriveSourceDefinition(directory))
  return await buildRepoMap(directory, definition)
}

type FrozenRow = {
  hash: string
  tokens: number
  files: number
  names: number
  text: string
}

export function frozenPlanMap(
  repository: Pick<TaskRepository, "read">,
  planID: string,
): RepoMap | undefined {
  return (
    repository.read((db) =>
      db
        .query<FrozenRow, [string]>(
          "SELECT hash,tokens,files,names,text FROM repo_maps WHERE plan_id=?",
        )
        .get(planID),
    ) ?? undefined
  )
}

/**
 * Capture the map for a plan: the first capture wins, so every worker of the plan reads the same
 * bytes whichever of plan submission and first worker read gets here first.
 */
export async function freezePlanMap(
  repository: Storage,
  planID: string,
  directory: string,
  projectDirectory: string = directory,
): Promise<RepoMap> {
  const existing = frozenPlanMap(repository, planID)
  if (existing) return existing
  const map = await currentRepoMap(repository, directory, projectDirectory)
  repository.atomic((db) => {
    db.query("INSERT OR IGNORE INTO repo_maps VALUES(?,?,?,?,?,?,?)").run(
      planID,
      map.hash,
      map.tokens,
      map.files,
      map.names,
      map.text,
      Date.now(),
    )
  })
  return frozenPlanMap(repository, planID) ?? map
}

/** The plan a worker session belongs to, from its attempt record. */
export function planOfSession(
  repository: Pick<TaskRepository, "read">,
  sessionID: string,
): string | undefined {
  return repository.read((db) => {
    const table = db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_attempts'")
      .get()
    if (!table) return undefined
    return db
      .query<{ plan_id: string }, [string]>(
        "SELECT plan_id FROM runner_attempts WHERE session_id=?",
      )
      .get(sessionID)?.plan_id
  })
}

/** What an agent session was given at its start, joinable to attempts by session id. */
export function recordMapDelivery(
  repository: Storage,
  delivery: {
    sessionID: string
    taskID?: string
    planID?: string
    role: "worker" | "architect"
    map?: Pick<RepoMap, "hash" | "tokens">
    sourceContextTokens?: number
  },
): void {
  repository.atomic((db) => {
    db.query(
      `INSERT INTO repo_map_deliveries VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id,task_id) DO UPDATE SET plan_id=excluded.plan_id,
         map_hash=excluded.map_hash,map_tokens=excluded.map_tokens,
         source_context_tokens=excluded.source_context_tokens,delivered_at=excluded.delivered_at`,
    ).run(
      delivery.sessionID,
      delivery.taskID ?? "",
      delivery.planID ?? null,
      delivery.role,
      delivery.map?.hash ?? null,
      delivery.map?.tokens ?? null,
      delivery.sourceContextTokens ?? null,
      Date.now(),
    )
  })
}

/** The block agents read. Its single staleness line is part of the frozen prefix. */
export function repoMapBlock(map: RepoMap, asOf: "plan start" | "session start"): string {
  return `## Repository map\nNames files and exports as of ${asOf}; it does not follow later edits. Use the host's read and grep for current content.\n\n${map.text}`
}

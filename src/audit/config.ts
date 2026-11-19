import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fingerprint } from "../identity.ts"
import type { TaskRepository } from "../storage.ts"

const REPO_CONFIG_CANDIDATES = [".fallowrc.json", ".fallowrc.jsonc", "fallow.toml", ".fallow.toml"]

/** Shared by review.ts: `undefined` means the command failed, never thrown. */
export async function runGit(directory: string, ...args: string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "-C", directory, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    })
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return code === 0 ? text : undefined
  } catch {
    return undefined
  }
}

/** Reads a repo config candidate at the base commit, root only (matches Fallow's own upward search). */
async function readRepoConfigAtBase(
  directory: string,
  baseCommit: string,
): Promise<{ path: string; content: string } | undefined> {
  for (const path of REPO_CONFIG_CANDIDATES) {
    const content = await runGit(directory, "show", `${baseCommit}:${path}`)
    if (content !== undefined) return { path, content }
  }
  return undefined
}

function isRemoteExtends(config: unknown): boolean {
  const extends_ =
    config !== null && typeof config === "object"
      ? (config as { extends?: unknown }).extends
      : undefined
  const values = Array.isArray(extends_) ? extends_ : extends_ === undefined ? [] : [extends_]
  return values.some((value) => typeof value === "string" && /^https?:\/\//i.test(value))
}

/** Index just past a `// line` comment starting at `start`. */
function skipLineComment(content: string, start: number): number {
  let i = start
  while (i < content.length && content[i] !== "\n") i++
  return i
}

/** Index just past a `/* block *\/` comment starting at `start`. */
function skipBlockComment(content: string, start: number): number {
  let i = start + 2
  while (i < content.length && content.slice(i, i + 2) !== "*/") i++
  return i + 2
}

/** Strips `//` and block comments from JSONC text, leaving string contents untouched. */
function stripJsonComments(content: string): string {
  let result = ""
  let inString = false
  let i = 0
  while (i < content.length) {
    const two = content.slice(i, i + 2)
    if (!inString && two === "//") {
      i = skipLineComment(content, i)
      continue
    }
    if (!inString && two === "/*") {
      i = skipBlockComment(content, i)
      continue
    }
    const char = content[i]!
    if (char === '"' && content[i - 1] !== "\\") inString = !inString
    result += char
    i++
  }
  return result
}

/** Parses a `.fallowrc.json`/`.jsonc` text config. TOML configs are passed through as opaque text. */
function parseJsonConfig(path: string, content: string): object | null {
  const text = path.endsWith(".jsonc") ? stripJsonComments(content) : content
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("config-invalid: expected a JSON object")
  return parsed as object
}

async function materialise(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lz-fallow-config-"))
  const path = join(directory, name)
  await writeFile(path, content, "utf8")
  return path
}

export type ResolvedFallowConfig = {
  source: "repo" | "lazers"
  path?: string
  sha256?: string
  config: object | null
  /** Materialised temp file to pass as `configPath`, outside the repository. Caller must clean it up. */
  configPath?: string
}

/** Every project needs a Fallow config; none resolves to this typed error, never a silent default. */
export class FallowConfigMissingError extends Error {
  readonly code = "FALLOW_CONFIG_MISSING"
  constructor(readonly projectDirectory: string) {
    super(
      `FALLOW_CONFIG_MISSING: ${projectDirectory} has no Fallow config. Use lz-fallow-config (modes suggest and dry-run) and lz-fallow-config-set.`,
    )
  }
}

/**
 * Config precedence, never merged: a repo config file at the base commit, else the stored
 * LAZERS project config, else Fallow defaults (dead code off). The caller must remove
 * `configPath` (via `cleanupResolvedFallowConfig`) once the analyzer call finishes.
 */
export async function resolveFallowConfig(input: {
  directory: string
  baseCommit: string
  repository: TaskRepository
}): Promise<ResolvedFallowConfig> {
  const repoFile = await readRepoConfigAtBase(input.directory, input.baseCommit)
  if (repoFile) {
    const config =
      repoFile.path.endsWith(".json") || repoFile.path.endsWith(".jsonc")
        ? parseJsonConfig(repoFile.path, repoFile.content)
        : null
    if (config && isRemoteExtends(config))
      throw new Error("remote-extends-unsupported: config extends a remote URL")
    const configPath = await materialise(repoFile.path.split("/").pop()!, repoFile.content)
    return {
      source: "repo",
      path: repoFile.path,
      sha256: fingerprint(repoFile.content),
      config,
      configPath,
    }
  }
  const stored = getLatestFallowConfig(input.repository)
  if (stored) {
    if (isRemoteExtends(stored.config))
      throw new Error("remote-extends-unsupported: config extends a remote URL")
    const text = JSON.stringify(stored.config)
    const configPath = await materialise(".fallowrc.json", text)
    return {
      source: "lazers",
      sha256: stored.sha256,
      config: stored.config,
      configPath,
    }
  }
  throw new FallowConfigMissingError(input.repository.projectDirectory)
}

/** Whether a repo config file at `ref` or a stored LAZERS config exists, without materialising it. */
export async function hasFallowConfig(input: {
  directory: string
  ref: string
  repository: TaskRepository
}): Promise<boolean> {
  if (await readRepoConfigAtBase(input.directory, input.ref)) return true
  return getLatestFallowConfig(input.repository) !== undefined
}

export async function cleanupResolvedFallowConfig(resolved: ResolvedFallowConfig): Promise<void> {
  if (!resolved.configPath) return
  await rm(resolved.configPath, { recursive: false, force: true }).catch(() => {})
}

/** Resolves the effective config at the workspace's current HEAD, for tools with no base commit. */
export async function resolveCurrentFallowConfig(input: {
  directory: string
  repository: TaskRepository
}): Promise<ResolvedFallowConfig> {
  const head = await runGit(input.directory, "rev-parse", "HEAD")
  return resolveFallowConfig({ ...input, baseCommit: head?.trim() ?? "HEAD" })
}

const DEFAULT_THRESHOLDS = { cyclomatic: 20, cognitive: 15 }

/** Complexity limits from the effective config's `health` section, else Fallow's defaults. */
export function thresholdsFrom(config: object | null): { cyclomatic: number; cognitive: number } {
  const health = (config as { health?: Record<string, unknown> } | null)?.health
  const cyclomatic = typeof health?.maxCyclomatic === "number" ? health.maxCyclomatic : undefined
  const cognitive = typeof health?.maxCognitive === "number" ? health.maxCognitive : undefined
  return {
    cyclomatic: cyclomatic ?? DEFAULT_THRESHOLDS.cyclomatic,
    cognitive: cognitive ?? DEFAULT_THRESHOLDS.cognitive,
  }
}

/** Whether the effective config explicitly turns the unused-class-members rule on. */
export function classMembersRuleEnabled(config: object | null): boolean {
  const rules = (config as { rules?: Record<string, unknown> } | null)?.rules
  return rules?.["unused-class-members"] === "on"
}

// --- LAZERS project config store (append-only revisions in the task database) ---

export type FallowConfigRevision = {
  sha256: string
  config: object
  sessionID: string
  agent: string
  createdAt: number
  /** Why the config was set, in the author's words. */
  reason?: string
}

function installFallowConfigSchema(repository: TaskRepository): void {
  repository.atomic((db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS lazers_fallow_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_directory TEXT NOT NULL,
        sha256 TEXT NOT NULL, payload TEXT NOT NULL, session_id TEXT NOT NULL,
        agent TEXT NOT NULL, created_at INTEGER NOT NULL, reason TEXT
      );
      CREATE INDEX IF NOT EXISTS lazers_fallow_config_project
        ON lazers_fallow_config(project_directory, created_at);
    `),
  )
  repository.atomic((db) => {
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(lazers_fallow_config)").all()
    if (!columns.some((c) => c.name === "reason"))
      db.exec("ALTER TABLE lazers_fallow_config ADD COLUMN reason TEXT")
  })
}

export function getLatestFallowConfig(
  repository: TaskRepository,
): FallowConfigRevision | undefined {
  installFallowConfigSchema(repository)
  const row = repository.read((db) =>
    db
      .query<
        {
          sha256: string
          payload: string
          session_id: string
          agent: string
          created_at: number
          reason: string | null
        },
        [string]
      >(
        `SELECT sha256,payload,session_id,agent,created_at,reason FROM lazers_fallow_config
         WHERE project_directory=? ORDER BY created_at DESC,id DESC LIMIT 1`,
      )
      .get(repository.projectDirectory),
  )
  if (!row) return undefined
  return {
    sha256: row.sha256,
    config: JSON.parse(row.payload),
    sessionID: row.session_id,
    agent: row.agent,
    createdAt: row.created_at,
    ...(row.reason ? { reason: row.reason } : {}),
  }
}

export function listFallowConfigRevisions(repository: TaskRepository): FallowConfigRevision[] {
  installFallowConfigSchema(repository)
  return repository
    .read((db) =>
      db
        .query<
          {
            sha256: string
            payload: string
            session_id: string
            agent: string
            created_at: number
            reason: string | null
          },
          [string]
        >(
          `SELECT sha256,payload,session_id,agent,created_at,reason FROM lazers_fallow_config
           WHERE project_directory=? ORDER BY created_at DESC,id DESC`,
        )
        .all(repository.projectDirectory),
    )
    .map((row) => ({
      sha256: row.sha256,
      config: JSON.parse(row.payload),
      sessionID: row.session_id,
      agent: row.agent,
      createdAt: row.created_at,
      ...(row.reason ? { reason: row.reason } : {}),
    }))
}

export function setFallowConfig(
  repository: TaskRepository,
  config: unknown,
  actor: { sessionID: string; agent: string },
  reason: string,
): FallowConfigRevision {
  if (config === null || typeof config !== "object" || Array.isArray(config))
    throw new Error("config-invalid: expected a JSON object")
  installFallowConfigSchema(repository)
  const payload = JSON.stringify(config)
  const revision: FallowConfigRevision = {
    sha256: fingerprint(config),
    config: config as object,
    sessionID: actor.sessionID,
    agent: actor.agent,
    createdAt: Date.now(),
    reason,
  }
  repository.atomic((db) =>
    db
      .query(
        `INSERT INTO lazers_fallow_config(project_directory,sha256,payload,session_id,agent,created_at,reason)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        repository.projectDirectory,
        revision.sha256,
        payload,
        actor.sessionID,
        actor.agent,
        revision.createdAt,
        reason,
      ),
  )
  return revision
}

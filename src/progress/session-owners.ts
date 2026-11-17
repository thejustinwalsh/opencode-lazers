import { realpathSync } from "node:fs"
import type { TaskRepository } from "../storage.ts"
import { databaseChanges } from "../database-events.ts"

/**
 * Process-wide session -> assignment membership for one project database.
 *
 * Native events arrive for every session visible to a location, but only runner-assigned
 * worker sessions have anything to record. This answers "could this session be assigned?"
 * in O(1) so unowned events never build facts, open transactions or enqueue reconstruction.
 *
 * - Positive entries are permanent: attempt rows are never reassigned to another session.
 * - Negative entries expire (TTL) and are dropped on every observed database change, so a
 *   freshly inserted assignment is visible before its first worker event is handled.
 * - The answer is a conservative superset; callers still run their exact assignment query.
 */
export type SessionOwners = {
  has(sessionID: string): boolean
  markOwned(sessionID: string): void
  /** Drop negative entries; assignments may have been written. */
  invalidateNegatives(): void
}

type Entry = { owned: boolean; expiresAt: number }
type Registry = {
  sessions: Map<string, Entry>
  unsubscribe?: () => void
}

export const SESSION_OWNER_NEGATIVE_TTL_MS = 2_000
const MAX_ENTRIES = 20_000

const registryKey = Symbol.for("opencode-lazers.session-owners.v1")
const host = globalThis as typeof globalThis & { [registryKey]?: Map<string, Registry> }
const registries: Map<string, Registry> = (host[registryKey] ??= new Map())

export function sessionOwners(repository: TaskRepository): SessionOwners {
  let canonical = repository.path
  try {
    canonical = realpathSync(repository.path)
  } catch {
    // In-memory or removed databases fall back to the raw path.
  }
  const key = JSON.stringify([canonical, repository.projectDirectory])
  let registry = registries.get(key)
  if (!registry) {
    registry = { sessions: new Map() }
    registries.set(key, registry)
    const created = registry
    try {
      created.unsubscribe = databaseChanges.subscribe(
        repository.path,
        () => invalidate(created),
        () => created.sessions.clear(),
      )
    } catch {
      // TTL alone bounds staleness when change notification is unavailable.
    }
  }
  const target = registry
  return {
    has(sessionID) {
      const entry = target.sessions.get(sessionID)
      if (entry && (entry.owned || entry.expiresAt > Date.now())) return entry.owned
      let owned: boolean
      try {
        owned =
          repository.read((db) =>
            db
              .query<{ found: number }, [string, string]>(
                `SELECT 1 AS found FROM runner_attempts a
                 JOIN runner_plans p ON p.id=a.plan_id
                 WHERE a.session_id=? AND p.project_directory=? LIMIT 1`,
              )
              .get(sessionID, repository.projectDirectory),
          ) !== null
      } catch {
        // Unknown means "maybe": the exact query decides.
        return true
      }
      remember(target, sessionID, owned)
      return owned
    },
    markOwned(sessionID) {
      remember(target, sessionID, true)
    },
    invalidateNegatives() {
      invalidate(target)
    },
  }
}

function remember(registry: Registry, sessionID: string, owned: boolean) {
  registry.sessions.delete(sessionID)
  registry.sessions.set(sessionID, {
    owned,
    expiresAt: owned ? Infinity : Date.now() + SESSION_OWNER_NEGATIVE_TTL_MS,
  })
  if (registry.sessions.size > MAX_ENTRIES) {
    const oldest = registry.sessions.keys().next().value
    if (oldest !== undefined) registry.sessions.delete(oldest)
  }
}

function invalidate(registry: Registry) {
  for (const [sessionID, entry] of registry.sessions)
    if (!entry.owned) registry.sessions.delete(sessionID)
}

import type { HostSession } from "./host.ts"

/**
 * Prompt-cache warmth window. Advertised prompt-cache lifetimes differ by
 * provider; five minutes is the common floor. Anthropic's default cache TTL is
 * five minutes and is refreshed on a hit. OpenAI documents cached prefixes
 * surviving roughly five to ten minutes of inactivity. OpenRouter passes
 * through the underlying provider's caching. A session idle longer than this is
 * treated as cold; the estimate is a cost heuristic, not a guarantee.
 */
export const DEFAULT_ARCHITECT_CACHE_WINDOW_MS = 5 * 60_000

/** A cold cache over a context this small is cheap to rebuild, so the session is reused. */
export const DEFAULT_ARCHITECT_REUSE_MAX_CONTEXT_TOKENS = 32_000

export type ArchitectRoutingOptions = {
  architectCacheWindowMs: number
  architectReuseMaxContextTokens: number
}

export type ArchitectRoute =
  | { action: "reuse" | "queue"; sessionID: string; reason: "warm" | "small-context" }
  | { action: "fresh"; sessionID: null; reason: "cold-large" | "missing" }

export function architectCacheWindowMs(value: unknown): number {
  if (value === undefined) return DEFAULT_ARCHITECT_CACHE_WINDOW_MS
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("architectCacheWindowMs must be a positive integer number of milliseconds")
  return value
}

export function architectReuseMaxContextTokens(value: unknown): number {
  if (value === undefined) return DEFAULT_ARCHITECT_REUSE_MAX_CONTEXT_TOKENS
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("architectReuseMaxContextTokens must be a positive integer number of tokens")
  return value
}

/**
 * Context size is the newest request's prompt size. `usage` and `tokens` are cumulative spend
 * over the whole session, so they say nothing about how full the window is and are never a
 * context size. Unknown is treated as large.
 */
export function architectContextTokens(session: HostSession): number | null {
  return session.contextTokens ?? null
}

/**
 * Decide which Architect receives work that needs judgement. Pure: callers
 * record the returned reason in a transition before acting on it.
 *
 * 1. A live owner whose cache is likely warm is reused (queued when busy).
 * 2. Otherwise a small context is reused: a cold cache there is cheap.
 * 3. Otherwise a fresh Architect is created with compact plan context.
 * An archived or missing owner always gets a fresh Architect.
 */
export function routeArchitect(
  owner: HostSession | null | undefined,
  now: number,
  options: ArchitectRoutingOptions,
): ArchitectRoute {
  if (!owner || owner.archived || owner.agent !== "architect")
    return { action: "fresh", sessionID: null, reason: "missing" }
  const lastActivity = owner.activityAt ?? owner.idleAt
  // A busy session without a reported timestamp is mid-request; its cache is being refreshed.
  const warm =
    lastActivity === undefined ? owner.busy : now - lastActivity < options.architectCacheWindowMs
  const action = owner.busy ? "queue" : "reuse"
  if (warm) return { action, sessionID: owner.id, reason: "warm" }
  const tokens = architectContextTokens(owner)
  if (tokens !== null && tokens < options.architectReuseMaxContextTokens)
    return { action, sessionID: owner.id, reason: "small-context" }
  return { action: "fresh", sessionID: null, reason: "cold-large" }
}

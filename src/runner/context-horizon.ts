import { DEFAULT_ARCHITECT_CACHE_WINDOW_MS } from "./architect-routing.ts"

/**
 * When stubs may change what a model request carries. A stub rewrites old content, and a provider's
 * prompt cache is keyed on the prefix, so rewriting it on every request would make every request
 * miss. The horizon is the id of the last message that may be stubbed; it moves only when the
 * prefix is already going to change or the cache is already cold, and stays put between those
 * points, so the same stored messages and the same horizon give identical bytes on every request.
 *
 * The cold-cache gap is the Architect cache window (`architectCacheWindowMs`, default
 * {@link DEFAULT_ARCHITECT_CACHE_WINDOW_MS}): the floor of the advertised lifetimes (Anthropic's
 * default is five minutes and each hit refreshes it; OpenAI documents five to ten minutes of
 * inactivity) and OpenCode's own default when a model sets no `cache.ttl` (`CACHE_LIFETIME = 5 *
 * 60_000`, `packages/core/src/session/compaction.ts`). The hook sees neither the model's TTL nor
 * cache statistics, so a model with a longer TTL pays one avoidable miss per advance; a shorter
 * one is cold anyway.
 */
export type HorizonReason = "first-request" | "cache-cold" | "prefix-changed"

type Entry = { readonly id?: string | undefined; readonly role: string }

type Record_ = { at: number; horizon: string | undefined; first: string | undefined }

export class StubHorizons {
  private readonly sessions = new Map<string, Record_>()

  constructor(
    readonly gapMs: number = DEFAULT_ARCHITECT_CACHE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The horizon for this request of `sessionID`, recording the request. Advances when the session
   * is new to this process (a renewed Architect, or a restart), after a gap longer than the cache
   * window, and when compaction replaced the start of the history (the old horizon or first message
   * is gone).
   */
  horizonFor(
    sessionID: string,
    messages: readonly Entry[],
  ): { horizon: string | undefined; advanced: HorizonReason | undefined } {
    const at = this.now()
    const record = this.sessions.get(sessionID)
    const first = messages[0]?.id
    const advanced: HorizonReason | undefined = !record
      ? "first-request"
      : at - record.at > this.gapMs
        ? "cache-cold"
        : first !== record.first ||
            (record.horizon !== undefined && !messages.some((m) => m.id === record.horizon))
          ? "prefix-changed"
          : undefined
    const horizon = advanced ? turnBoundary(messages) : record!.horizon
    this.sessions.set(sessionID, { at, horizon, first })
    // A record older than the gap decides the same as no record (the cache is cold either way).
    for (const [id, other] of this.sessions)
      if (at - other.at > this.gapMs) this.sessions.delete(id)
    return { horizon, advanced }
  }
}

/**
 * The last user-role message: stubbing never reaches into the turn in progress (the assistant
 * message and tool results after it), whose thinking blocks and tool calls a provider may require
 * unmodified.
 */
export function turnBoundary(messages: readonly Entry[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === "user" && message.id !== undefined) return message.id
  }
  return undefined
}

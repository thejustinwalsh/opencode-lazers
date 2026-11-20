import { randomUUID } from "node:crypto"
import { historyCacheBytes } from "./history.ts"

type Entry = { identity: string; events: Map<string, string>; expiresAt: number; bytes: number }

/**
 * How long a delivery baseline stays valid. A product choice (a person reading one panel,
 * the same as the history cursor's TTL), not measured; an expired baseline is a reset.
 */
const TTL_MS = 5 * 60_000

/**
 * Process-local delivery baselines in a memory-budgeted LRU. Nothing here refuses a read:
 * baselines are evicted, least recently used first, to stay inside `maxBytes`, and a
 * projection larger than the whole budget is delivered in full without being cached. Losing
 * a baseline causes a full reset, never lost history. A baseline is one panel's serialized
 * event list, the same data a history capture holds, so the budget defaults to the
 * `historyCacheMB` default rather than to a separate unmeasured number.
 */
export class TrajectoryLiveCache {
  private readonly entries = new Map<string, Entry>()
  private bytes = 0
  private readonly limits: { maxBytes: number; ttlMs: number }

  constructor(limits: { maxBytes?: number; ttlMs?: number } = {}) {
    this.limits = {
      maxBytes: limits.maxBytes ?? historyCacheBytes(undefined),
      ttlMs: limits.ttlMs ?? TTL_MS,
    }
  }

  project<T extends Record<string, unknown>>(
    identity: string,
    events: readonly T[],
    cursor?: string,
    now = Date.now(),
  ) {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.remove(key)
    const candidate = cursor ? this.entries.get(cursor) : undefined
    const previous = candidate?.identity === identity ? candidate : undefined
    // Reading a baseline makes it the most recently used.
    if (previous && cursor) {
      this.entries.delete(cursor)
      this.entries.set(cursor, previous)
    }
    const serialized = new Map<string, string>()
    const changed: T[] = []
    let bytes = 0
    for (const event of events) {
      if (typeof event.id !== "string") throw new Error("Live event identity is missing")
      const value = JSON.stringify(event)
      serialized.set(event.id, value)
      bytes += Buffer.byteLength(event.id) + Buffer.byteLength(value)
      if (previous?.events.get(event.id) !== value) changed.push(event)
    }
    const removed = previous ? [...previous.events.keys()].filter((id) => !serialized.has(id)) : []
    if (previous && changed.length === 0 && removed.length === 0)
      return {
        events: changed,
        live: { mode: "patch" as const, baseCursor: cursor!, cursor: cursor!, removed },
      }

    const next = randomUUID()
    // Keep old baselines until eviction: a lost response must be safe to retry. One larger
    // than the whole budget is not kept; the next read resets from the full data.
    if (bytes <= this.limits.maxBytes) {
      while (this.entries.size > 0 && this.bytes + bytes > this.limits.maxBytes)
        this.remove(this.entries.keys().next().value!)
      this.entries.set(next, {
        identity,
        events: serialized,
        expiresAt: now + this.limits.ttlMs,
        bytes,
      })
      this.bytes += bytes
    }
    return {
      events: previous ? changed : [...events],
      live: {
        mode: previous ? ("patch" as const) : ("reset" as const),
        baseCursor: previous ? cursor! : null,
        cursor: this.entries.has(next) ? next : null,
        removed,
      },
    }
  }

  private remove(key: string) {
    const entry = this.entries.get(key)
    if (entry) this.bytes -= entry.bytes
    this.entries.delete(key)
  }
}

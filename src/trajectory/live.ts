import { randomUUID } from "node:crypto"

type Entry = { identity: string; events: Map<string, string>; expiresAt: number; bytes: number }

/** Process-local delivery baselines. Losing one causes a full reset, never lost history. */
export class TrajectoryLiveCache {
  private readonly entries = new Map<string, Entry>()
  private bytes = 0

  constructor(
    private readonly limits = { maxEntries: 16, maxBytes: 8 * 1024 * 1024, ttlMs: 5 * 60_000 },
  ) {}

  project<T extends Record<string, unknown>>(
    identity: string,
    events: readonly T[],
    cursor?: string,
    now = Date.now(),
  ) {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.remove(key)
    const candidate = cursor ? this.entries.get(cursor) : undefined
    const previous = candidate?.identity === identity ? candidate : undefined
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
    // Keep old baselines until eviction: a lost response must be safe to retry.
    this.entries.set(next, {
      identity,
      events: serialized,
      expiresAt: now + this.limits.ttlMs,
      bytes,
    })
    this.bytes += bytes
    while (this.entries.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes)
      this.remove(this.entries.keys().next().value!)
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

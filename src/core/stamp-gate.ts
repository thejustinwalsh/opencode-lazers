import type { Database } from "bun:sqlite"

/**
 * Stamp gate: run a read only when its stamp moved since the last run, otherwise return the
 * cached result. One instance per project core; every entry shares one byte budget.
 *
 * ```ts
 * const gate = new StampGate<Topology>({ maxBytes })
 * const stamp = observationRevisionStamp(db, projectDirectory) // or a host stamp
 * const value = await gate.run("topology:all", stamp, () => readTopology(db))
 * ```
 *
 * - `key` names the read and its arguments (`JSON.stringify([name, ...args])`).
 * - `stamp` is any string or number that changes whenever the read's inputs may have: the
 *   project's `observation_revisions` revision, or a host stamp (`time.updated` plus a message
 *   cursor). Equal stamp -> cached value, `read` is not called. A moved stamp re-runs `read`
 *   and replaces the entry.
 * - Concurrent calls with the same key and stamp share one in-flight read.
 * - A rejected read is never cached.
 * - Results are held by reference: callers must treat them as immutable.
 * - The cache is a byte-budgeted LRU. It never refuses a read: older entries are evicted, and
 *   a result larger than the whole budget is returned without being kept. `sizeOf` defaults to
 *   the JSON length of the value, measured once when the entry is stored. `maxBytes` has no
 *   measured default here; callers pass the budget they own (see `historyCacheBytes`).
 */
export class StampGate<T> {
  private readonly entries = new Map<string, { stamp: string | number; value: T; bytes: number }>()
  private readonly inflight = new Map<string, { stamp: string | number; promise: Promise<T> }>()
  private bytes = 0
  private maxBytes: number
  private readonly sizeOf: (value: T) => number
  /** Reads actually executed and reads served from the cache; for tests and measurement. */
  readonly counts = { ran: 0, hit: 0 }

  constructor(options: { maxBytes: number; sizeOf?: (value: T) => number }) {
    this.maxBytes = options.maxBytes
    this.sizeOf = options.sizeOf ?? ((value) => JSON.stringify(value)?.length ?? 0)
  }

  async run(key: string, stamp: string | number, read: () => T | Promise<T>): Promise<T> {
    const entry = this.entries.get(key)
    if (entry && entry.stamp === stamp) {
      this.entries.delete(key)
      this.entries.set(key, entry)
      this.counts.hit++
      return entry.value
    }
    const pending = this.inflight.get(key)
    if (pending && pending.stamp === stamp) return pending.promise
    this.counts.ran++
    const promise = (async () => read())()
    this.inflight.set(key, { stamp, promise })
    try {
      const value = await promise
      this.store(key, stamp, value)
      return value
    } finally {
      if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key)
    }
  }

  /** Bytes held now. */
  get size() {
    return this.bytes
  }

  setMaxBytes(maxBytes: number) {
    this.maxBytes = maxBytes
    while (this.entries.size > 0 && this.bytes > maxBytes) this.evictOldest()
  }

  clear() {
    this.entries.clear()
    this.bytes = 0
  }

  private store(key: string, stamp: string | number, value: T) {
    const previous = this.entries.get(key)
    if (previous) {
      this.bytes -= previous.bytes
      this.entries.delete(key)
    }
    const bytes = this.sizeOf(value)
    if (bytes > this.maxBytes) return
    while (this.entries.size > 0 && this.bytes + bytes > this.maxBytes) this.evictOldest()
    this.entries.set(key, { stamp, value, bytes })
    this.bytes += bytes
  }

  private evictOldest() {
    const first = this.entries.keys().next().value as string | undefined
    if (first === undefined) return
    this.bytes -= this.entries.get(first)!.bytes
    this.entries.delete(first)
  }
}

/** The project's observation revision: one indexed row read; 0 when it has none yet. */
export function observationRevisionStamp(db: Database, projectDirectory: string): number {
  try {
    return (
      db
        .query<{ revision: number }, [string]>(
          "SELECT revision FROM observation_revisions WHERE project_directory=?",
        )
        .get(projectDirectory)?.revision ?? 0
    )
  } catch {
    return 0
  }
}

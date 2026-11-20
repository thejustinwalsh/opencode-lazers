/**
 * Process-wide, byte-budgeted LRU caches. OpenCode loads one module copy per location, so a
 * module-scope Map would multiply by the copy count; named caches live on globalThis and every
 * copy shares one. Eviction only drops the oldest entries: a miss re-reads, it never refuses.
 */
export type ByteLru<V> = {
  get(key: string): V | undefined
  set(key: string, value: V, bytes: number): void
  delete(key: string): void
  /** Drops every entry whose key starts with `prefix`. */
  deleteByPrefix(prefix: string): void
  clear(): void
  readonly size: number
  readonly bytes: number
  readonly stats: { hits: number; misses: number }
}

type Entry<V> = { value: V; bytes: number }
type Registry = Map<string, ByteLru<unknown>>

const registryKey = Symbol.for("lazers.models.byteLru.v1")
const host = globalThis as typeof globalThis & { [registryKey]?: Registry }

function createByteLru<V>(budget: () => number): ByteLru<V> {
  const entries = new Map<string, Entry<V>>()
  let total = 0
  const stats = { hits: 0, misses: 0 }
  const evict = () => {
    // The newest entry stays even when it alone exceeds the budget: the read that built it
    // must still be served, and the next insert evicts it.
    while (total > budget() && entries.size > 1) {
      const oldest = entries.keys().next().value!
      total -= entries.get(oldest)!.bytes
      entries.delete(oldest)
    }
  }
  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) {
        stats.misses++
        return undefined
      }
      stats.hits++
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value, bytes) {
      const previous = entries.get(key)
      if (previous) total -= previous.bytes
      entries.delete(key)
      entries.set(key, { value, bytes })
      total += bytes
      evict()
    },
    delete(key) {
      const entry = entries.get(key)
      if (!entry) return
      total -= entry.bytes
      entries.delete(key)
    },
    deleteByPrefix(prefix) {
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) this.delete(key)
    },
    clear() {
      entries.clear()
      total = 0
    },
    get size() {
      return entries.size
    },
    get bytes() {
      return total
    },
    stats,
  }
}

/** The one cache of this name in the process; `budgetBytes` is read on every insert (tunable). */
export function sharedByteLru<V>(name: string, budgetBytes: () => number): ByteLru<V> {
  const registry = (host[registryKey] ??= new Map())
  let cache = registry.get(name)
  if (!cache) {
    cache = createByteLru<unknown>(budgetBytes)
    registry.set(name, cache)
  }
  return cache as ByteLru<V>
}

/** Reads a byte budget from an environment variable, in MiB, with a fallback. */
export function budgetFromEnv(name: string, fallbackMiB: number): () => number {
  return () => {
    const parsed = Number(process.env[name])
    return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMiB) * 1024 * 1024
  }
}

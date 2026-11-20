/**
 * State that belongs to the process, not to a plugin copy. OpenCode loads every location with a
 * fresh module instance, so a module-level `Map` is one per copy: N copies hold N caches of the
 * same sessions. `processShared` returns one instance per name for the whole process, kept on
 * globalThis the way the core registry is.
 */
const sharedKey = Symbol.for("lazers.process-shared.v1")
const host = globalThis as typeof globalThis & { [sharedKey]?: Map<string, unknown> }

export function processShared<T>(name: string, create: () => T): T {
  const all = (host[sharedKey] ??= new Map<string, unknown>())
  if (!all.has(name)) all.set(name, create())
  return all.get(name) as T
}

/**
 * Least-recently-used map. Eviction only costs the work the entry saved; it never refuses an
 * insert. Callers state their measured entry size beside the bound they pass.
 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, V>()
  constructor(private readonly maxEntries: number) {}
  get size() {
    return this.entries.size
  }
  has(key: K) {
    return this.get(key) !== undefined
  }
  get(key: K): V | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }
  set(key: K, value: V) {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value!)
    return this
  }
  delete(key: K) {
    return this.entries.delete(key)
  }
}

/** Session IDs are about 30 characters; an entry is roughly 100 bytes, so 16,384 is about 1.6 MB. */
export const SESSION_MEMO_ENTRIES = 16_384

/** A set of session IDs shared by the whole process, least recently used out first. */
export function sharedSessionSet(name: string) {
  const entries = processShared(name, () => new LruMap<string, true>(SESSION_MEMO_ENTRIES))
  return {
    has: (id: string) => entries.has(id),
    add: (id: string) => void entries.set(id, true),
  }
}

/** In-flight work shared by the whole process: one promise per key while it runs. */
export function sharedInFlight<V>(name: string) {
  return processShared(name, () => new Map<string, Promise<V>>())
}

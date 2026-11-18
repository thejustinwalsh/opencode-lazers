/**
 * Last good content per scope key, kept at module level so a re-mounted panel or a view switch
 * renders what it showed before and refreshes in place. The skeleton belongs to the first load
 * only; once content has been shown it stays.
 */
const stores = new Set<Map<string, unknown>>()

export function createKept<T>(limit = 8) {
  const entries = new Map<string, T>()
  stores.add(entries)
  return {
    get: (key: string) => entries.get(key),
    set(key: string, value: T) {
      if (!key) return
      entries.delete(key)
      entries.set(key, value)
      for (const oldest of entries.keys()) {
        if (entries.size <= limit) break
        entries.delete(oldest)
      }
    },
  }
}

/** For tests and sign-out: forget everything kept. */
export function clearKept() {
  for (const entries of stores) entries.clear()
}

import { createHash } from "node:crypto"

/** Canonical validated JSON; object key order is not submission identity. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("Identity requires JSON")
  return encoded
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

/**
 * `fingerprint(values)` for a list of strings, fed one value at a time so a caller can stream
 * pages of ids from SQLite without holding the list. The digest equals `fingerprint([...values])`
 * because `canonical` of a string array is its JSON.
 */
export function fingerprintStrings(values: Iterable<string>): {
  count: number
  fingerprint: string
} {
  const hash = createHash("sha256").update("[")
  let count = 0
  for (const value of values) {
    hash.update(count ? `,${JSON.stringify(value)}` : JSON.stringify(value))
    count++
  }
  return { count, fingerprint: hash.update("]").digest("hex") }
}

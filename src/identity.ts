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

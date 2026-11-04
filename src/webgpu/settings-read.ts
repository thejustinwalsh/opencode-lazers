import type { Features } from "./features.ts"

type Entry = { pending?: Promise<Features>; value?: Features; readAt: number }
const registryKey = Symbol.for("opencode-lazers.inference-settings-read.v1")
const host = globalThis as typeof globalThis & { [registryKey]?: Map<unknown, Entry> }
const reads = (host[registryKey] ??= new Map())
export const defaultSettingsAuthority = Symbol.for(
  "opencode-lazers.inference-settings-authority.v1",
)

/** Settings polling shares an in-flight read and at most one value per poll interval. */
export function readFeatureSettings(
  authority: unknown,
  read: () => Promise<Features>,
  now = performance.now(),
): Promise<Features> {
  let entry = reads.get(authority)
  if (!entry) {
    entry = { readAt: -Infinity }
    reads.set(authority, entry)
  }
  if (entry.pending) return entry.pending
  if (entry.value && now - entry.readAt < 1000) return Promise.resolve(entry.value)
  const target = entry
  const pending = Promise.resolve()
    .then(read)
    .then((value) => {
      target.value = value
      target.readAt = now
      return value
    })
    .finally(() => {
      if (target.pending === pending) target.pending = undefined
    })
  entry.pending = pending
  return pending
}

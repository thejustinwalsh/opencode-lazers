/**
 * Synchronous time spent inside `TaskRepository.read`/`atomic`/`retryBusy`, per call site.
 * Opt-in: inactive unless the heap sampler saw `diagnostics/heap.on` (it calls
 * `setStorageTiming`). Inactive cost is one property read per call. Active cost is a pair of
 * `performance.now()` reads; the call site is resolved from a stack trace only for calls of
 * at least `SITE_THRESHOLD_MS`, faster calls add to an unattributed per-kind total.
 * Only the outermost call is timed, so a `read` inside an `atomic` is not counted twice.
 * State lives on `globalThis` so every loaded copy of the plugin shares one table.
 */
export type StorageTiming = {
  site: string
  kind: "read" | "atomic"
  count: number
  totalMs: number
  maxMs: number
}

/** Calls shorter than this are not attributed to a site (no stack capture). */
const SITE_THRESHOLD_MS = 2
/** Sites kept; beyond this the entry with the smallest `totalMs` is evicted. */
const MAX_SITES = 512
export const FAST_SITE = "(under 2ms)"

type State = { on: boolean; depth: number; syncMs: number; sites: Map<string, StorageTiming> }
const key = Symbol.for("lazers.storage-timing.v1")
const holder = globalThis as typeof globalThis & { [key]?: State }
const state: State = (holder[key] ??= { on: false, depth: 0, syncMs: 0, sites: new Map() })

export function setStorageTiming(on: boolean) {
  state.on = on
}

/** Storage entry points whose own frame may sit between `timeStorage` and the caller. */
const WRAPPERS = new Set(["read", "atomic", "atomicAsync", "retryBusy"])
const FRAME = /^at (?:async )?(?:(.*?) \()?([^()]+?):(\d+):\d+\)?$/

/**
 * `fn (file:line)` of the first frame outside the storage layer, or `file:line` for an
 * anonymous function. Frames are skipped by what they are (`callSite`, `timeStorage`, and at
 * most one storage wrapper by function name), not by file, because the service runs one
 * bundled file. The engine may elide the wrapper's frame (tail calls), so it is optional.
 */
function callSite(): string {
  const frames = (new Error().stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .map((line) => FRAME.exec(line))
  let index = 0
  while (index < frames.length && ["callSite", "timeStorage"].includes(frames[index]?.[1] ?? ""))
    index++
  const method = frames[index]?.[1]?.split(".").pop()
  if (method !== undefined && WRAPPERS.has(method)) index++
  const match = frames[index]
  if (!match) return "(unknown)"
  const [, name, file, line] = match
  return name ? `${name} (${file}:${line})` : `${file}:${line}`
}

function record(kind: "read" | "atomic", site: string, ms: number) {
  const id = `${kind} ${site}`
  const entry = state.sites.get(id)
  if (entry) {
    entry.count++
    entry.totalMs += ms
    if (ms > entry.maxMs) entry.maxMs = ms
    return
  }
  if (state.sites.size >= MAX_SITES) {
    let smallest: string | undefined
    let least = Infinity
    for (const [name, value] of state.sites)
      if (value.totalMs < least) {
        least = value.totalMs
        smallest = name
      }
    if (smallest !== undefined) state.sites.delete(smallest)
  }
  state.sites.set(id, { site, kind, count: 1, totalMs: ms, maxMs: ms })
}

/** Runs `run`, recording its wall time under the caller's site when timing is active. */
export function timeStorage<T>(kind: "read" | "atomic", run: () => T): T {
  if (!state.on || state.depth > 0) return run()
  state.depth++
  const start = performance.now()
  try {
    return run()
  } finally {
    state.depth--
    const ms = performance.now() - start
    state.syncMs += ms
    record(kind, ms >= SITE_THRESHOLD_MS ? callSite() : FAST_SITE, ms)
  }
}

/** Top sites by `totalMs` since the last drain, plus the total synchronous ms. Resets. */
export function drainStorageReport(top: number): { storage: StorageTiming[]; syncMs: number } {
  const storage = [...state.sites.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, top)
  const syncMs = state.syncMs
  state.sites.clear()
  state.syncMs = 0
  return { storage, syncMs }
}

export function drainStorageTiming(top: number): StorageTiming[] {
  return drainStorageReport(top).storage
}

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

/**
 * One in this many calls under the threshold also captures its call site into `sampled`, so a
 * reader estimates per-site counts as `samples * SAMPLE_RATE`. Cost is a counter increment per
 * fast call plus one stack capture and map update per sample: measured on a
 * `SELECT 1` read (about 1.55 µs bare): the flag adds about 0.18 µs per call in all, of which
 * sampling is about 0.1 µs amortised; with the flag off the cost is one property read.
 */
export const SAMPLE_RATE = 32

export type SampledSite = {
  site: string
  kind: "read" | "atomic"
  samples: number
  sampledMs: number
}

type State = {
  on: boolean
  depth: number
  syncMs: number
  sites: Map<string, StorageTiming>
  /** Fast calls seen since the last sample was taken. */
  tick?: number
  sampled?: Map<string, SampledSite>
}
const key = Symbol.for("lazers.storage-timing.v1")
const holder = globalThis as typeof globalThis & { [key]?: State }
const state: State = (holder[key] ??= { on: false, depth: 0, syncMs: 0, sites: new Map() })
// A copy loaded earlier may have created the shared state without the sampling fields.
state.tick ??= 0
state.sampled ??= new Map()

export function setStorageTiming(on: boolean) {
  state.on = on
}

/** Storage entry points whose own frame may sit between `timeStorage` and the caller. */
const WRAPPERS = /^(read|atomic|atomicAsync|retryBusy)\d*$/
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
  // Frame 0 is this function. The capture runs directly in `timeStorage`'s own body (never in
  // a helper), so frame 1 is `timeStorage` under whatever name the bundler gave it; skip both
  // by position. The wrapper frame after it is optional and matched with its bundler suffix.
  let index = 2
  const method = frames[index]?.[1]?.split(".").pop()
  if (method !== undefined && WRAPPERS.test(method)) index++
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

function sample(kind: "read" | "atomic", site: string, ms: number) {
  const sampled = state.sampled!
  const id = `${kind} ${site}`
  const entry = sampled.get(id)
  if (entry) {
    entry.samples++
    entry.sampledMs += ms
    return
  }
  if (sampled.size >= MAX_SITES) {
    let smallest: string | undefined
    let least = Infinity
    for (const [name, value] of sampled)
      if (value.samples < least) {
        least = value.samples
        smallest = name
      }
    if (smallest !== undefined) sampled.delete(smallest)
  }
  sampled.set(id, { site, kind, samples: 1, sampledMs: ms })
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
    if (ms >= SITE_THRESHOLD_MS) record(kind, callSite(), ms)
    else {
      record(kind, FAST_SITE, ms)
      if (++state.tick! >= SAMPLE_RATE) {
        state.tick = 0
        sample(kind, callSite(), ms)
      }
    }
  }
}

/** Top sites by `totalMs`, top sampled fast-call sites by samples, and total ms. Resets. */
export function drainStorageReport(top: number): {
  storage: StorageTiming[]
  syncMs: number
  sampled: SampledSite[]
  sampleRate: number
} {
  const storage = [...state.sites.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, top)
  const sampled = [...state.sampled!.values()].sort((a, b) => b.samples - a.samples).slice(0, top)
  const syncMs = state.syncMs
  state.sites.clear()
  state.sampled!.clear()
  state.syncMs = 0
  return { storage, syncMs, sampled, sampleRate: SAMPLE_RATE }
}

export function drainStorageTiming(top: number): StorageTiming[] {
  return drainStorageReport(top).storage
}

import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { Effect } from "effect"
import {
  enableProfiler,
  type ProfileOptions,
  type ProfileSummary,
  type StallProfiler,
} from "./stall-profile.ts"

/**
 * Always-on event-loop stall attribution. Named sections time synchronous slices of
 * LAZERS code; a 50ms drift timer notices when the loop was blocked and names the
 * long sections that ended since the previous tick. One probe per process (globalThis),
 * shared by every module copy OpenCode loads.
 *
 * Section kinds:
 *  - "sync":         a synchronous function, measured exactly.
 *  - "async-prefix": the synchronous prefix of an async function (until it first yields).
 *  - "effect":       wall time of an Effect run. It may span awaits, so it is only a
 *                    stall candidate when it started and ended inside the stalled window.
 */
const probeKey = Symbol.for("lazers.stall-probe.v1")

export type SectionKind = "sync" | "async-prefix" | "effect"
export type LongSection = {
  name: string
  ms: number
  /** performance.now() when the section ended. */
  at: number
  kind: SectionKind
  /** performance.now() when the section started. */
  start: number
}
export type SectionTotal = { count: number; totalMs: number; maxMs: number }
export type StallRecord = {
  event: "lazers.stall"
  at: string
  pid: number
  lagMs: number
  /** Synchronous sections executing when the timer finally ran (normally empty). */
  sectionStack: string[]
  /** Long sections that ended during the stalled window, longest first. */
  culprits: LongSection[]
  /** Last 20 long sections (sync and effect), oldest first. */
  recent: LongSection[]
  locations: number
  cores: number
  /** JS stack samples inside the stall window; present only when profiling is enabled. */
  profile?: ProfileSummary
}
export type ProbeOptions = {
  /** Directory holding tasks.sqlite; diagnostics/stalls.jsonl is written beneath it. */
  dataDirectory?: string
  /** Receives at most one summary line per 10s. */
  log?: (message: string, fields: Record<string, unknown>) => void
  /** Live core count. */
  cores?: () => number
  /** Sampling-profile attribution; enabled by `diagnostics/profile.on` beside stalls.jsonl. */
  profile?: ProfileOptions
}

export const SLICE_THRESHOLD_MS = 50
export const DRIFT_THRESHOLD_MS = 200
const TICK_MS = 50
const RING = 20
const MAX_BYTES = 5 * 1024 * 1024
const FLUSH_MS = 1000
const LOG_EVERY_MS = 10_000

class Ring {
  private items: LongSection[] = []
  private head = 0
  push(item: LongSection) {
    if (this.items.length < RING) this.items.push(item)
    else {
      this.items[this.head] = item
      this.head = (this.head + 1) % RING
    }
  }
  ordered() {
    return [...this.items.slice(this.head), ...this.items.slice(0, this.head)]
  }
}

export class StallProbe {
  /** Currently executing synchronous section names (outermost first). */
  readonly stack: string[] = []
  readonly totals = new Map<string, SectionTotal>()
  locations = 0
  stalls = 0
  private readonly slices = new Ring()
  private readonly effects = new Ring()
  private options: ProbeOptions = {}
  private path: string | undefined
  private buffer: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private flushing: Promise<void> = Promise.resolve()
  private size = 0
  private sized = false
  private timer: ReturnType<typeof setInterval> | undefined
  private lastTick = performance.now()
  private lastLog = 0
  private pendingSummary = 0
  private worst: StallRecord | undefined
  private profiler: StallProfiler | undefined
  private profilerChecked = false

  configure(options: ProbeOptions) {
    this.options = { ...this.options, ...options }
    if (options.dataDirectory !== undefined && isAbsolute(options.dataDirectory)) {
      const path = join(options.dataDirectory, "diagnostics", "stalls.jsonl")
      if (path !== this.path) {
        this.path = path
        this.sized = false
        this.size = 0
        if (this.buffer.length) this.scheduleFlush()
      }
      if (!this.profilerChecked) {
        this.profilerChecked = true
        this.profiler = enableProfiler(
          join(options.dataDirectory, "diagnostics", "profile.on"),
          this.options.profile,
        )
      }
    }
    this.start()
  }

  start() {
    if (this.timer) return
    this.lastTick = performance.now()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.profiler?.stop()
  }

  /** Time a synchronous function. */
  section<T>(name: string, fn: () => T): T {
    const start = performance.now()
    this.stack.push(name)
    try {
      return fn()
    } finally {
      this.stack.pop()
      this.record(name, start, performance.now(), "sync")
    }
  }

  /**
   * Time an async function. The synchronous prefix (until fn returns its promise)
   * is a stall candidate; total wall time is tracked under `<name>:total`.
   */
  sectionAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now()
    this.stack.push(name)
    let promise: Promise<T>
    try {
      promise = fn()
    } catch (error) {
      this.stack.pop()
      this.record(name, start, performance.now(), "async-prefix")
      throw error
    }
    this.stack.pop()
    this.record(name, start, performance.now(), "async-prefix")
    // Observe on a side chain: the caller gets the original promise, so no extra microtask
    // turns change their ordering. The handlers also mark rejections as handled for this chain only.
    const total = () => this.record(`${name}:total`, start, performance.now(), "effect")
    promise.then(total, total)
    return promise
  }

  /** Time an Effect run (wall time, per run; see SectionKind "effect"). */
  effect<A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>),
  ): Effect.Effect<A, E, R> {
    return Effect.suspend(() => {
      const start = performance.now()
      // A thunk is evaluated here so eager work done while building the Effect is timed too.
      const built = typeof effect === "function" ? this.section(`${name}:build`, effect) : effect
      return built.pipe(
        Effect.ensuring(Effect.sync(() => this.record(name, start, performance.now(), "effect"))),
      )
    })
  }

  /** Records one finished section. Public so wrappers can report their own spans. */
  record(name: string, start: number, end: number, kind: SectionKind) {
    const ms = end - start
    const total = this.totals.get(name)
    if (total) {
      total.count++
      total.totalMs += ms
      if (ms > total.maxMs) total.maxMs = ms
    } else this.totals.set(name, { count: 1, totalMs: ms, maxMs: ms })
    if (ms < SLICE_THRESHOLD_MS) return
    const item: LongSection = { name, ms: Math.round(ms), at: end, kind, start }
    if (kind === "effect") this.effects.push(item)
    else this.slices.push(item)
  }

  private recent() {
    return [...this.slices.ordered(), ...this.effects.ordered()].sort((a, b) => a.at - b.at)
  }

  private tick() {
    const now = performance.now()
    const previous = this.lastTick
    this.lastTick = now
    const lag = now - previous - TICK_MS
    if (lag > DRIFT_THRESHOLD_MS) this.report(Math.round(lag), previous)
    if (this.pendingSummary > 0 && now - this.lastLog >= LOG_EVERY_MS) this.summarize(now)
  }

  /** Builds, buffers and queues one stall record. `since` is the previous tick time. */
  report(lagMs: number, since: number) {
    const recent = this.recent()
    const culprits = recent
      .filter((item) => item.at >= since && (item.kind !== "effect" || item.start >= since))
      .sort((a, b) => b.ms - a.ms)
    const record: StallRecord = {
      event: "lazers.stall",
      at: new Date().toISOString(),
      pid: process.pid,
      lagMs,
      sectionStack: [...this.stack],
      culprits,
      recent,
      locations: this.locations,
      cores: this.options.cores?.() ?? 0,
    }
    if (this.profiler && lagMs >= this.profiler.minStallMs) {
      try {
        // Draining here (not on the blocked drain timer) yields the samples inside the window.
        record.profile = this.profiler.summarize(since, since + lagMs + TICK_MS)
      } catch {
        // Profiling must never break stall recording.
      }
    }
    this.stalls++
    this.pendingSummary++
    if (!this.worst || lagMs > this.worst.lagMs) this.worst = record
    this.buffer.push(JSON.stringify(record))
    this.scheduleFlush()
    return record
  }

  private summarize(now: number) {
    const worst = this.worst
    const count = this.pendingSummary
    this.pendingSummary = 0
    this.worst = undefined
    this.lastLog = now
    if (!worst) return
    try {
      this.options.log?.("LAZERS stall", {
        stalls: count,
        worstLagMs: worst.lagMs,
        culprit: worst.culprits[0]?.name ?? worst.sectionStack.at(-1) ?? "unknown",
        culpritMs: worst.culprits[0]?.ms,
        locations: worst.locations,
        cores: worst.cores,
      })
    } catch {
      // Logging must never throw into the timer.
    }
  }

  private scheduleFlush() {
    if (this.flushTimer || !this.path) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, FLUSH_MS)
    this.flushTimer.unref?.()
  }

  /** Batched, async append with size-capped rotation (path -> path.1). Never throws. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      const path = this.path
      if (!path || this.buffer.length === 0) return
      const text = `${this.buffer.join("\n")}\n`
      this.buffer = []
      try {
        await mkdir(dirname(path), { recursive: true })
        if (!this.sized) {
          this.sized = true
          this.size = await stat(path).then(
            (info) => info.size,
            () => 0,
          )
        }
        if (this.size + text.length > MAX_BYTES) {
          await rename(path, `${path}.1`).catch(() => {})
          this.size = 0
        }
        await appendFile(path, text)
        this.size += text.length
      } catch {
        // Diagnostics are best effort.
      }
    })
    return this.flushing
  }

  /** Per-section totals, heaviest first. */
  snapshot() {
    return [...this.totals.entries()]
      .map(([name, total]) => ({ name, ...total }))
      .sort((a, b) => b.totalMs - a.totalMs)
  }
}

type Host = typeof globalThis & { [probeKey]?: StallProbe }
const host = globalThis as Host

/** Process-wide singleton, shared across module copies. */
export function stallProbe(): StallProbe {
  const existing = host[probeKey]
  if (existing) return existing
  const probe = new StallProbe()
  host[probeKey] = probe
  probe.start()
  return probe
}

export const section = <T>(name: string, fn: () => T): T => stallProbe().section(name, fn)
export const sectionAsync = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
  stallProbe().sectionAsync(name, fn)
export const sectionEffect = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>),
) => stallProbe().effect(name, effect)

/**
 * Wrap each handler of one RPC implementation as a section named `rpc:<contract id>.<method>`.
 * Effect results are timed per run; promises by prefix and total; plain values synchronously.
 */
export function instrumentHandlers<H extends object>(contractID: string, handlers: H): H {
  const wrapped: Record<string, unknown> = {}
  for (const [method, handler] of Object.entries(handlers)) {
    if (typeof handler !== "function") {
      wrapped[method] = handler
      continue
    }
    const name = `rpc:${contractID}.${method}`
    wrapped[method] = (...args: unknown[]) => {
      const probe = stallProbe()
      const start = performance.now()
      probe.stack.push(name)
      let result: unknown
      try {
        result = handler(...args)
      } catch (error) {
        probe.stack.pop()
        probe.record(name, start, performance.now(), "sync")
        throw error
      }
      probe.stack.pop()
      if (Effect.isEffect(result)) {
        probe.record(`${name}:build`, start, performance.now(), "sync")
        return probe.effect(name, result)
      }
      probe.record(name, start, performance.now(), "async-prefix")
      return result
    }
  }
  return wrapped as H
}

/** Proxy that replaces one method, leaving every other property and `this` binding intact. */
function overlay<T extends object>(
  target: T,
  key: string,
  make: (original: unknown) => unknown,
): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property === key) {
        const original = Reflect.get(object, property)
        return make(typeof original === "function" ? original.bind(object) : original)
      }
      return Reflect.get(object, property, receiver)
    },
  })
}

/**
 * `ctx.rpc` with timed handlers. Keeps the original type so handler literals stay
 * contextually typed: `timedRpc(ctx.rpc).register(Contract, { ... })`.
 */
export function timedRpc<R extends { register: (...args: never[]) => unknown }>(rpc: R): R {
  return overlay(
    rpc,
    "register",
    (register) => (definition: { id: string }, handlers: object) =>
      (register as (...args: unknown[]) => unknown)(
        definition,
        instrumentHandlers(definition.id, handlers),
      ),
  )
}

/**
 * A hook domain (`ctx.tool`, `ctx.session`, `ctx.permission`) with timed hooks, named
 * `hook:<domain>.<name>`: `timedHooks(ctx.tool, "tool").hook("execute.before", fn)`.
 */
export function timedHooks<D extends { hook: (...args: never[]) => unknown }>(
  domain: D,
  label: string,
): D {
  return overlay(
    domain,
    "hook",
    (hook) => (name: string, handler: (...args: unknown[]) => unknown) =>
      (hook as (...args: unknown[]) => unknown)(name, (...args: unknown[]) => {
        const result = handler(...args)
        return Effect.isEffect(result)
          ? stallProbe().effect(`hook:${label}.${name}`, result)
          : result
      }),
  )
}

/**
 * Opt-in process-wide JS stack attribution for stall records. Uses JavaScriptCore's
 * sampling profiler (`bun:jsc`), which samples on its own thread and so keeps collecting
 * while the main loop is blocked. Enabled only when `diagnostics/profile.on` exists at
 * probe start. One profiler per process (globalThis), however many plugin instances load.
 *
 * Clock: sample timestamps are monotonic seconds since boot (CLOCK_MONOTONIC), not
 * `performance.now()`. The offset is calibrated once with a short busy spin whose last
 * sample is matched to `performance.now()` (error about one sampling interval).
 * Draining `samplingProfilerStackTraces()` clears the engine's buffer, so every drain
 * appends only new samples to our own bounded ring.
 */
import { existsSync } from "node:fs"

export type ProfileSummary = {
  samples: number
  windowMs: number
  intervalMs: number
  /** Top self (innermost) frames: `name @ file:line`. */
  self: { frame: string; samples: number }[]
  /** Top frames anywhere in the stack, counted once per sample. */
  inclusive: { frame: string; samples: number }[]
  /** Most common full stacks, innermost first, truncated. */
  stacks: { samples: number; frames: string[] }[]
}
export type ProfileOptions = {
  /** Flag file whose existence enables profiling. Default: `<dataDirectory>/diagnostics/profile.on`. */
  flagPath?: string
  /** Stalls at or above this lag get a `profile`. Default 2000. */
  minStallMs?: number
  /** Drain period. Default 1000. */
  drainMs?: number
  /** globalThis registry key (tests isolate with their own). */
  hostKey?: symbol
}

type Frame = { name?: string; sourceURL?: string; line?: number }
type Trace = { timestamp: number; frames: Frame[] }
type Jsc = {
  startSamplingProfiler(): void
  samplingProfilerStackTraces(): { interval: number; traces: Trace[] }
}
type Sample = { at: number; frames: string[] }

export const PROFILE_MIN_STALL_MS = 2000
const DRAIN_MS = 1000
const RING_SAMPLES = 30_000
const MAX_FRAMES = 40
const STACK_FRAMES = 30
const TOP = 25
const TOP_STACKS = 5
const INTERN_CAP = 8000
const defaultKey = Symbol.for("lazers.stall-profiler.v1")

/** Keep the package/file tail of a source URL. */
export function shortenURL(url: string | undefined) {
  if (!url) return "native"
  const clean = url.replace(/^file:\/\//, "").replace(/[?#].*$/, "")
  const modules = clean.lastIndexOf("node_modules/")
  if (modules >= 0) return clean.slice(modules + "node_modules/".length)
  return clean.split("/").slice(-2).join("/")
}

export class StallProfiler {
  private ring: Sample[] = []
  private head = 0
  private offsetMs: number | undefined
  private interval = 1
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly interned = new Map<string, string>()
  readonly minStallMs: number
  constructor(
    private readonly jsc: Jsc,
    options: ProfileOptions = {},
  ) {
    this.minStallMs = options.minStallMs ?? PROFILE_MIN_STALL_MS
    this.jsc.startSamplingProfiler()
    this.calibrate()
    this.timer = setInterval(() => this.drain(), options.drainMs ?? DRAIN_MS)
    this.timer.unref?.()
  }

  get calibrated() {
    return this.offsetMs !== undefined
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private calibrate() {
    for (const spin of [3, 25]) {
      const end = performance.now() + spin
      while (performance.now() < end);
      const traces = this.jsc.samplingProfilerStackTraces().traces
      const last = traces.at(-1)
      if (last) {
        this.offsetMs = last.timestamp * 1000 - performance.now()
        this.ingest(traces)
        return
      }
    }
  }

  private frame(frame: Frame) {
    const where = frame.sourceURL ? `${shortenURL(frame.sourceURL)}:${frame.line ?? 0}` : "native"
    const text = `${frame.name || "(anonymous)"} @ ${where}`
    const known = this.interned.get(text)
    if (known) return known
    if (this.interned.size >= INTERN_CAP) this.interned.clear()
    this.interned.set(text, text)
    return text
  }

  private ingest(traces: Trace[]) {
    const offset = this.offsetMs
    if (offset === undefined) return
    for (const trace of traces) {
      const sample: Sample = {
        at: trace.timestamp * 1000 - offset,
        frames: trace.frames.slice(0, MAX_FRAMES).map((frame) => this.frame(frame)),
      }
      if (this.ring.length < RING_SAMPLES) this.ring.push(sample)
      else {
        this.ring[this.head] = sample
        this.head = (this.head + 1) % RING_SAMPLES
      }
    }
  }

  /** Move new engine samples into the ring. Never throws. */
  drain() {
    try {
      const result = this.jsc.samplingProfilerStackTraces()
      if (result.interval > 0) this.interval = result.interval * 1000
      this.ingest(result.traces)
    } catch {
      // Diagnostics are best effort.
    }
  }

  /** Aggregate samples whose time lies in [from, to] (performance.now() ms). */
  summarize(from: number, to: number): ProfileSummary {
    this.drain()
    const self = new Map<string, number>()
    const inclusive = new Map<string, number>()
    const stacks = new Map<string, { samples: number; frames: string[] }>()
    let samples = 0
    for (const sample of this.ring) {
      if (sample.at < from || sample.at > to || sample.frames.length === 0) continue
      samples++
      const innermost = sample.frames[0]!
      self.set(innermost, (self.get(innermost) ?? 0) + 1)
      for (const frame of new Set(sample.frames))
        inclusive.set(frame, (inclusive.get(frame) ?? 0) + 1)
      const frames = sample.frames.slice(0, STACK_FRAMES)
      const key = frames.join("\n")
      const entry = stacks.get(key)
      if (entry) entry.samples++
      else stacks.set(key, { samples: 1, frames })
    }
    const top = (map: Map<string, number>) =>
      [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP)
        .map(([frame, count]) => ({ frame, samples: count }))
    return {
      samples,
      windowMs: Math.round(to - from),
      intervalMs: this.interval,
      self: top(self),
      inclusive: top(inclusive),
      stacks: [...stacks.values()].sort((a, b) => b.samples - a.samples).slice(0, TOP_STACKS),
    }
  }
}

type Registry = Record<symbol, StallProfiler | undefined>

/** The process profiler when the flag file exists; starts it once. Undefined when disabled or unsupported. */
export function enableProfiler(
  flagPath: string | undefined,
  options: ProfileOptions = {},
): StallProfiler | undefined {
  const registry = globalThis as unknown as Registry
  const key = options.hostKey ?? defaultKey
  const existing = registry[key]
  if (existing) return existing
  const path = options.flagPath ?? flagPath
  if (!path || !existsSync(path)) return undefined
  try {
    const jsc = require("bun:jsc") as Jsc
    if (typeof jsc.startSamplingProfiler !== "function") return undefined
    const profiler = new StallProfiler(jsc, options)
    if (!profiler.calibrated) {
      profiler.stop()
      return undefined
    }
    registry[key] = profiler
    return profiler
  } catch {
    return undefined
  }
}

export function activeProfiler(hostKey: symbol = defaultKey) {
  return (globalThis as unknown as Registry)[hostKey]
}

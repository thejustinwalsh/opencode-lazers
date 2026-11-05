// Temporary explicit diagnostic for the idle-service investigation. Remove its
// RPC registration after attribution; it is not a model tool or background job.
import { profile } from "bun:jsc"
import type { SamplingProfile } from "bun:jsc"
import { setTimeout as delay } from "node:timers/promises"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import type { ServiceCPUProfile } from "./contract.ts"

const registryKey = Symbol.for("opencode-lazers.service-cpu-profile.v1")
const registryHost = globalThis as typeof globalThis & { [registryKey]?: { active: boolean } }
const registry = (registryHost[registryKey] ??= { active: false })
const durationMs = 10_000
const sampleIntervalUs = 1_000

type Dependencies = {
  sample(callback: () => Promise<void>, interval: number): Promise<SamplingProfile>
  wait(signal: AbortSignal): Promise<void>
}
const native: Dependencies = {
  sample: (callback, interval) => profile(callback, interval),
  wait: async (signal) => {
    await delay(durationMs, undefined, { signal })
  },
}

export function summarizeServiceProfile(capture: SamplingProfile) {
  // Older Bun versions returned this metadata as a JSON string.
  const traces = (
    typeof capture.stackTraces === "string" ? JSON.parse(capture.stackTraces) : capture.stackTraces
  ) as SamplingProfile["stackTraces"]
  const sources = new Map(traces.sources.map((source) => [source.sourceID, source.url]))
  const frames: ServiceCPUProfile["frames"] = []
  const frameIDs = new Map<string, number>()
  const stacks = new Map<string, { frames: number[]; samples: number }>()
  const stats = privacyStats()
  const coordinate = (value: number) =>
    Number.isSafeInteger(value) && value > 0 && value < 4_294_967_295 ? value : null
  for (const trace of traces.traces) {
    const ids = trace.frames.map((frame) => {
      const file = frame.sourceURL ?? sources.get(frame.sourceID) ?? null
      const key = JSON.stringify([frame.name, file, frame.line, frame.column, frame.category])
      let id = frameIDs.get(key)
      if (id === undefined) {
        id = frames.length
        frameIDs.set(key, id)
        frames.push({
          id,
          name: safeText(frame.name, stats, 300),
          file: file === null ? null : safeText(file, stats, 2000),
          line: coordinate(frame.line),
          column: coordinate(frame.column),
          category: safeText(frame.category, stats, 80),
          selfSamples: 0,
          totalSamples: 0,
        })
      }
      return id
    })
    const first = ids[0]
    if (first !== undefined) frames[first]!.selfSamples++
    for (const id of new Set(ids)) frames[id]!.totalSamples++
    const key = ids.join(",")
    const stack = stacks.get(key)
    if (stack) stack.samples++
    else stacks.set(key, { frames: ids, samples: 1 })
  }
  return { sampleCount: traces.traces.length, frames, stacks: [...stacks.values()] }
}

export async function captureServiceCPU(
  signal: AbortSignal,
  dependencies = native,
): Promise<ServiceCPUProfile> {
  signal.throwIfAborted()
  if (registry.active) throw new Error("A service CPU capture is already active")
  registry.active = true
  const startedAt = Date.now()
  const start = performance.now()
  try {
    const capture = await dependencies.sample(() => dependencies.wait(signal), sampleIntervalUs)
    const elapsedMs = performance.now() - start
    const endedAt = Date.now()
    signal.throwIfAborted()
    return {
      pid: process.pid,
      startedAt,
      endedAt,
      elapsedMs,
      requestedDurationMs: durationMs,
      sampleIntervalUs,
      ...summarizeServiceProfile(capture),
    }
  } finally {
    registry.active = false
  }
}

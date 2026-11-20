/**
 * Opt-in live heap diagnostic. While `diagnostics/heap.on` exists (checked on every sample,
 * so no restart is needed), appends one JSON line per minute to `diagnostics/heap.jsonl`
 * beside `stalls.jsonl`: process memory plus JavaScriptCore heap statistics and the top
 * object types. Separates retained JavaScript objects from native/external memory.
 *
 * One sampler per process (globalThis, however many plugin instances load). Each module
 * generation carries its own id; a different generation replaces and stops the old sampler.
 */
import { existsSync } from "node:fs"
import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { drainStorageReport, setStorageTiming, type StorageTiming } from "./storage-timing.ts"

export type HeapContext = { locations: number; cores: number }
export type HeapSamplerOptions = {
  /** Directory beside `stalls.jsonl` (`<data>/diagnostics`). */
  directory: string
  /** Sampling period. Default 60 000 ms. */
  intervalMs?: number
  /** Loaded LAZERS locations and cores, read at each sample. */
  context?: () => HeapContext
  /** Rotate to `.1` beyond this size. Default 5 MiB. */
  maxBytes?: number
  /** Module generation id; tests pass their own. */
  generation?: string
  /** `bun:jsc` stand-in for tests. */
  jsc?: Jsc
  /** globalThis registry key (tests isolate with their own). */
  hostKey?: symbol
}
type TypeCounts = Record<string, number>
type HeapStats = {
  heapSize: number
  heapCapacity: number
  extraMemorySize: number
  objectCount: number
  protectedObjectCount: number
  globalObjectCount: number
  objectTypeCounts?: TypeCounts
  protectedObjectTypeCounts?: TypeCounts
}
type Jsc = { heapStats(): HeapStats }
export type HeapRecord = {
  event: "lazers.heap"
  at: string
  pid: number
  memory: {
    rss: number
    heapTotal: number
    heapUsed: number
    external: number
    arrayBuffers: number
  }
  heap: Omit<HeapStats, "objectTypeCounts" | "protectedObjectTypeCounts">
  objectTypeCounts: [string, number][]
  protectedObjectTypeCounts: [string, number][]
  locations: number
  cores: number
  /** Wall time of `heapStats()`. */
  sampleMs: number
  /** Top 20 call sites by synchronous database time since the previous sample. */
  storage: StorageTiming[]
  /** Total synchronous database ms since the previous sample. */
  storageSyncMs: number
}

const INTERVAL_MS = 60_000
const MAX_BYTES = 5 * 1024 * 1024
const TOP = 25
const defaultKey = Symbol.for("lazers.heap-sampler.v1")
const moduleGeneration = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

const top = (counts: TypeCounts | undefined): [string, number][] =>
  Object.entries(counts ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)

export class HeapSampler {
  private timer: ReturnType<typeof setInterval> | undefined
  private writing: Promise<void> = Promise.resolve()
  private size: number | undefined
  readonly flagPath: string
  readonly outputPath: string
  constructor(
    readonly generation: string,
    private readonly options: HeapSamplerOptions,
  ) {
    this.flagPath = join(options.directory, "heap.on")
    this.outputPath = join(options.directory, "heap.jsonl")
    setStorageTiming(existsSync(this.flagPath))
    this.timer = setInterval(() => void this.sample(), options.intervalMs ?? INTERVAL_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    setStorageTiming(false)
    this.timer = undefined
  }

  get running() {
    return this.timer !== undefined
  }

  /** Takes one sample when the flag file exists; resolves once written. Never throws. */
  sample(): Promise<void> {
    const flagged = existsSync(this.flagPath)
    setStorageTiming(flagged)
    if (!flagged) return this.writing
    let line: string
    try {
      const jsc = this.options.jsc ?? (require("bun:jsc") as Jsc)
      const start = performance.now()
      const stats = jsc.heapStats()
      const sampleMs = Math.round((performance.now() - start) * 100) / 100
      const memory = process.memoryUsage()
      const { objectTypeCounts, protectedObjectTypeCounts, ...heap } = stats
      const context = this.options.context?.() ?? { locations: 0, cores: 0 }
      const record: HeapRecord = {
        event: "lazers.heap",
        at: new Date().toISOString(),
        pid: process.pid,
        memory: {
          rss: memory.rss,
          heapTotal: memory.heapTotal,
          heapUsed: memory.heapUsed,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
        },
        heap: {
          heapSize: heap.heapSize,
          heapCapacity: heap.heapCapacity,
          extraMemorySize: heap.extraMemorySize,
          objectCount: heap.objectCount,
          protectedObjectCount: heap.protectedObjectCount,
          globalObjectCount: heap.globalObjectCount,
        },
        objectTypeCounts: top(objectTypeCounts),
        protectedObjectTypeCounts: top(protectedObjectTypeCounts),
        ...context,
        sampleMs,
        ...(({ storage, syncMs }) => ({ storage, storageSyncMs: Math.round(syncMs * 100) / 100 }))(
          drainStorageReport(20),
        ),
      }
      line = `${JSON.stringify(record)}\n`
    } catch {
      return this.writing
    }
    this.writing = this.writing.then(() => this.append(line))
    return this.writing
  }

  private async append(text: string) {
    const path = this.outputPath
    try {
      await mkdir(dirname(path), { recursive: true })
      this.size ??= await stat(path).then(
        (info) => info.size,
        () => 0,
      )
      if (this.size + text.length > (this.options.maxBytes ?? MAX_BYTES)) {
        await rename(path, `${path}.1`).catch(() => {})
        this.size = 0
      }
      await appendFile(path, text)
      this.size += text.length
    } catch {
      // Diagnostics are best effort.
    }
  }
}

type Registry = Record<symbol, HeapSampler | undefined>

/**
 * Starts this module generation's sampler, stopping one from another generation.
 * Repeat calls from the same generation return the running sampler.
 */
export function startHeapSampler(options: HeapSamplerOptions): HeapSampler {
  const registry = globalThis as unknown as Registry
  const key = options.hostKey ?? defaultKey
  const generation = options.generation ?? moduleGeneration
  const existing = registry[key]
  if (existing?.running && existing.generation === generation) return existing
  existing?.stop()
  const sampler = new HeapSampler(generation, options)
  registry[key] = sampler
  return sampler
}

export function activeHeapSampler(hostKey: symbol = defaultKey) {
  return (globalThis as unknown as Registry)[hostKey]
}

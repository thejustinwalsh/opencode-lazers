import { Worker } from "node:worker_threads"
import { moduleGeneration } from "../core/generation.ts"
import { workerURL } from "../worker-url.ts"
import { connectRevisions } from "./revisions.ts"
import type { Anchor, FromReader, ReaderStats, ToReader } from "./protocol.ts"

/**
 * Reader pool: the read workers of one database in one process. Streams are assigned to
 * workers round-robin; a worker that errors or exits is replaced and its streams reopen on the
 * new worker at the anchor of their last delivered frame, replaying any slide or seek that had
 * not been answered. Nothing grows unboundedly: a pool holds its workers and, per open stream,
 * one small record.
 */
export type OpenRequest = Omit<Extract<ToReader, { type: "open" }>, "type" | "stream" | "sequence">
export type StreamCommand = { type: "slide"; delta: number } | { type: "seek"; anchor: Anchor }

export type PoolStream = {
  readonly id: number
  /** Move or re-anchor the window; the reader answers with one frame carrying the returned op (0 when closed). */
  post(command: StreamCommand): number
  /** Transfer tier: send a consumed buffer home to the worker that allocated it. */
  release(buffer: ArrayBuffer): void
  /** Close the stream on its worker. Idempotent. */
  close(): void
}

export type ReaderPoolOptions = {
  /** Worker count; defaults to `LAZERS_STREAM_READERS` or 2. */
  workers?: number
  /** Worker script; defaults to the reader worker beside this module or the server bundle. */
  workerURL?: URL
  /** Modules the worker imports before serving, for sources defined outside the reader bundle. */
  sourceModules?: readonly string[]
}

export type ReaderPoolCounters = ReaderStats & { workers: number }

export type ReaderPool = {
  readonly databasePath: string
  /** Open a stream. The listener receives every message the reader sends for it. */
  attach(request: OpenRequest, listener: (message: FromReader) => void): PoolStream
  /** The main thread committed `revision` after writing `tables` (all when omitted); each worker refreshes the open streams whose sources read them. */
  revision(revision: number, tables?: readonly string[]): void
  stats(): Promise<ReaderStats[]>
  /** Counters for diagnostics, without waiting: workers and streams now, worker counters as of the last `stats()` (this call starts the next one). */
  snapshot(): ReaderPoolCounters
  /** Fault injection for tests: terminate the worker serving `stream` as a crash would. */
  terminateWorkerOf(stream: number): Promise<void>
  /** Closes databases, then terminates the workers. */
  close(): Promise<void>
}

type Slot = {
  worker: Worker | undefined
  control: SharedArrayBuffer
  streams: Set<number>
  /** Consecutive replacements without a delivered frame. */
  restarts: number
}

type Tracked = {
  id: number
  request: OpenRequest
  listener: (message: FromReader) => void
  slot: Slot
  anchor: Anchor | undefined
  sequence: number
  nextOp: number
  unanswered: { op: number; command: StreamCommand }[]
  closed: boolean
}

const MAX_RESTARTS = 5
const SHUTDOWN_GRACE_MS = 2_000
const STATS_TIMEOUT_MS = 500
const registryKey = Symbol.for("lazers.streams.reader-pools.v2")
type Entry = { key: string; pool: ReaderPool; refs: number; disconnect(): void }
const host = globalThis as typeof globalThis & { [registryKey]?: Map<string, Entry> }
const entries = () => (host[registryKey] ??= new Map())

const defaultWorkers = () => {
  const configured = Number(process.env.LAZERS_STREAM_READERS)
  return Number.isInteger(configured) && configured > 0 ? configured : 2
}

const entryFor = (databasePath: string, options: ReaderPoolOptions): Entry => {
  // OpenCode loads every plugin location with its own module copy, so the registry hangs off
  // globalThis; a reload that changes the code gets its own pool and the old one closes when its
  // last holder releases it, as the decision worker does.
  const key = `${moduleGeneration()}\u0000${databasePath}\u0000${options.workerURL?.href ?? ""}`
  const all = entries()
  let entry = all.get(key)
  if (!entry) {
    let created: Entry
    const pool = createReaderPool(databasePath, options, () => {
      created.disconnect()
      if (all.get(key) === created) all.delete(key)
    })
    let disconnect = () => {}
    try {
      disconnect = connectRevisions(pool, databasePath)
    } catch {
      // A database that does not exist yet has no writer to follow; revisions can be sent by hand.
    }
    created = { key, pool, refs: 0, disconnect }
    all.set(key, created)
    entry = created
  }
  return entry
}

/** The reader pool of one database in this process, created on first use and never auto-closed. */
export function readerPool(databasePath: string, options: ReaderPoolOptions = {}): ReaderPool {
  return entryFor(databasePath, options).pool
}

export type ReaderPoolLease = {
  readonly pool: ReaderPool
  /** Drops this holder; the last release closes the workers. Idempotent. */
  release(): void
}

/** Hold the pool of a database; the last release closes it (its workers close their databases first). */
export function acquireReaderPool(
  databasePath: string,
  options: ReaderPoolOptions = {},
): ReaderPoolLease {
  const entry = entryFor(databasePath, options)
  entry.refs++
  let released = false
  return {
    pool: entry.pool,
    release() {
      if (released) return
      released = true
      if (--entry.refs > 0) return
      void entry.pool.close()
    },
  }
}

/** Diagnostic: live pools and their holders. */
export function readerPoolSnapshot() {
  return [...entries().values()].map(({ key, refs, pool }) => ({ key, refs, ...pool.snapshot() }))
}

function createReaderPool(
  databasePath: string,
  options: ReaderPoolOptions,
  onClosed: () => void,
): ReaderPool {
  const slots: Slot[] = Array.from({ length: options.workers ?? defaultWorkers() }, () => ({
    worker: undefined,
    control: new SharedArrayBuffer(4),
    streams: new Set<number>(),
    restarts: 0,
  }))
  const tracked = new Map<number, Tracked>()
  /** Which worker allocated a transferred buffer; only that worker takes it back. */
  const owners = new WeakMap<ArrayBuffer, Worker>()
  const statWaiters = new Map<number, (stats: ReaderStats) => void>()
  let nextStream = 0
  let nextSlot = 0
  let nextStat = 0
  let cachedStats: ReaderStats[] = []
  let latestRevision: number | undefined
  let closed = false

  const dispatch = (slot: Slot, worker: Worker, message: FromReader) => {
    if (message.type === "stats") {
      statWaiters.get(message.id)?.(message)
      statWaiters.delete(message.id)
      return
    }
    if (message.type === "closed") return
    const stream = tracked.get(message.stream)
    if (!stream || stream.closed) return
    if (message.type === "frame") {
      slot.restarts = 0
      stream.anchor = message.anchor
      stream.sequence = message.sequence
      if (message.op !== undefined)
        stream.unanswered = stream.unanswered.filter((entry) => entry.op > message.op!)
      if (message.buffer) owners.set(message.buffer, worker)
    }
    stream.listener(message)
  }

  const reopen = (stream: Tracked, worker: Worker) => {
    worker.postMessage({
      type: "open",
      stream: stream.id,
      ...stream.request,
      anchor: stream.anchor ?? stream.request.anchor,
      sequence: stream.sequence,
    } satisfies ToReader)
    for (const { op, command } of stream.unanswered)
      worker.postMessage({ ...command, stream: stream.id, op } satisfies ToReader)
  }

  const spawn = (slot: Slot): Worker => {
    Atomics.store(new Int32Array(slot.control), 0, 0)
    const worker = new Worker(options.workerURL ?? workerURL("./reader-worker", import.meta.url), {
      workerData: {
        path: databasePath,
        control: slot.control,
        ...(options.sourceModules ? { sourceModules: options.sourceModules } : {}),
      },
    })
    worker.unref()
    slot.worker = worker
    if (latestRevision !== undefined)
      worker.postMessage({ type: "revision", revision: latestRevision } satisfies ToReader)
    worker.on("message", (message: FromReader) => dispatch(slot, worker, message))
    const lost = (reason: string) => {
      if (slot.worker !== worker) return
      slot.worker = undefined
      if (closed) return
      replace(slot, reason)
    }
    worker.on("error", (error) => lost(error instanceof Error ? error.message : String(error)))
    worker.on("exit", (code) => lost(`Stream reader exited with code ${code}`))
    return worker
  }

  const replace = (slot: Slot, reason: string) => {
    const ids = [...slot.streams]
    if (ids.length === 0) return
    if (++slot.restarts > MAX_RESTARTS) {
      for (const id of ids) {
        const stream = tracked.get(id)
        slot.streams.delete(id)
        tracked.delete(id)
        if (stream && !stream.closed)
          stream.listener({
            type: "failed",
            stream: id,
            message: `Stream reader keeps failing: ${reason}`,
          })
      }
      return
    }
    const worker = spawn(slot)
    for (const id of ids) {
      const stream = tracked.get(id)
      if (stream && !stream.closed) reopen(stream, worker)
    }
  }

  const post = (slot: Slot, message: ToReader) => (slot.worker ?? spawn(slot)).postMessage(message)

  return {
    databasePath,
    attach(request, listener) {
      if (closed) throw new Error("Reader pool is closed")
      const slot = slots[nextSlot++ % slots.length]!
      const stream: Tracked = {
        id: ++nextStream,
        request,
        listener,
        slot,
        anchor: undefined,
        sequence: 0,
        nextOp: 0,
        unanswered: [],
        closed: false,
      }
      tracked.set(stream.id, stream)
      slot.streams.add(stream.id)
      post(slot, { type: "open", stream: stream.id, ...request })
      return {
        id: stream.id,
        post(command) {
          if (stream.closed) return 0
          const op = ++stream.nextOp
          stream.unanswered.push({ op, command })
          post(slot, { ...command, stream: stream.id, op })
          return op
        },
        release(buffer) {
          const owner = owners.get(buffer)
          owners.delete(buffer)
          if (owner && slot.worker === owner)
            owner.postMessage({ type: "return", buffer }, [buffer])
        },
        close() {
          if (stream.closed) return
          stream.closed = true
          tracked.delete(stream.id)
          slot.streams.delete(stream.id)
          slot.worker?.postMessage({ type: "close", stream: stream.id } satisfies ToReader)
        },
      }
    },
    revision(revision, tables) {
      latestRevision = revision
      for (const slot of slots)
        slot.worker?.postMessage({
          type: "revision",
          revision,
          ...(tables ? { tables } : {}),
        } satisfies ToReader)
    },
    stats() {
      const asked = slots
        .filter((slot) => slot.worker)
        .map(
          (slot) =>
            new Promise<ReaderStats | undefined>((resolve) => {
              const id = ++nextStat
              const timer = setTimeout(() => {
                statWaiters.delete(id)
                resolve(undefined)
              }, STATS_TIMEOUT_MS)
              statWaiters.set(id, (stats) => {
                clearTimeout(timer)
                resolve(stats)
              })
              slot.worker!.postMessage({ type: "stats", id } satisfies ToReader)
            }),
        )
      return Promise.all(asked).then((all) => {
        cachedStats = all.filter((stats): stats is ReaderStats => stats !== undefined)
        return cachedStats
      })
    },
    snapshot() {
      const workers = slots.filter((slot) => slot.worker).length
      if (workers > 0 && !closed) void this.stats()
      const total = cachedStats.reduce(
        (sum, stats) => ({
          statements: sum.statements + stats.statements,
          rowsRead: sum.rowsRead + stats.rowsRead,
          buffersAllocated: sum.buffersAllocated + stats.buffersAllocated,
          buffersPooled: sum.buffersPooled + stats.buffersPooled,
        }),
        { statements: 0, rowsRead: 0, buffersAllocated: 0, buffersPooled: 0 },
      )
      return { ...total, streams: tracked.size, workers }
    },
    async terminateWorkerOf(id) {
      await tracked.get(id)?.slot.worker?.terminate()
    },
    async close() {
      if (closed) return
      closed = true
      onClosed()
      for (const stream of tracked.values()) stream.closed = true
      tracked.clear()
      await Promise.all(
        slots.map(async (slot) => {
          const worker = slot.worker
          slot.worker = undefined
          slot.streams.clear()
          if (!worker) return
          // The worker closes its database on `shutdown`; a worker stuck in a synchronous loop
          // answers nothing, so the stop flag and a grace period bound the wait.
          Atomics.store(new Int32Array(slot.control), 0, 1)
          const done = new Promise<void>((resolve) => {
            worker.once("exit", () => resolve())
            worker.on("message", (message: FromReader) => {
              if (message.type === "closed") resolve()
            })
          })
          worker.postMessage({ type: "shutdown" } satisfies ToReader)
          const timer = setTimeout(() => void worker.terminate(), SHUTDOWN_GRACE_MS)
          await done
          clearTimeout(timer)
          await worker.terminate()
        }),
      )
    },
  }
}

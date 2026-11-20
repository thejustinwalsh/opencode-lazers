import { parentPort, workerData } from "node:worker_threads"
import { createModelDecisionReader } from "./decision-read.ts"
import { observationRevisionStamp } from "../core/stamp-gate.ts"
import { acquireSharedConnection } from "../storage.ts"
import { WarmGate } from "./warm-pass.ts"
import { openReadOnlyObservationLedger } from "./observation-ledger-read.ts"
import { readDecisionPriceState, readPriceIdentity } from "./price-state.ts"
import type { PriceInputs } from "./price-state.ts"
import type { WorkerRequest, WorkerResponse } from "./decision-worker-protocol.ts"

/**
 * Hosts the decision readers (ledger capture + projection + snapshot cache) for every project of
 * one database on a single thread with read-only SQLite connections. The main thread supplies
 * only the OpenCode-owned price inputs; evidence is read here, from SQLite, by snapshot id.
 */
const port = parentPort
if (!port) throw new Error("decision-worker must run in a worker thread")
const { path, warmIntervalMs } = workerData as { path: string; warmIntervalMs?: number }

const send = (message: WorkerResponse) => port.postMessage(message)
const controllers = new Map<number, AbortController>()
const callBySignal = new WeakMap<AbortSignal, number>()
const priceWaiters = new Map<
  number,
  { resolve(inputs: PriceInputs): void; reject(error: Error): void }
>()
let priceSeq = 0

/** One price-input request per call: identity and state reads of the same call share it. */
const inputsBySignal = new WeakMap<AbortSignal, Promise<PriceInputs>>()

const requestInputs = (signal?: AbortSignal) => {
  signal?.throwIfAborted()
  const cached = signal ? inputsBySignal.get(signal) : undefined
  if (cached) return cached
  const requestID = ++priceSeq
  const pending = new Promise<PriceInputs>((resolve, reject) => {
    priceWaiters.set(requestID, { resolve, reject })
    signal?.addEventListener(
      "abort",
      () => {
        priceWaiters.delete(requestID)
        reject(signal.reason)
      },
      { once: true },
    )
    send({
      type: "price",
      requestID,
      callID: signal ? (callBySignal.get(signal) ?? -1) : -1,
    })
  })
  if (signal) inputsBySignal.set(signal, pending)
  return pending
}

type ProjectReader = {
  reader: ReturnType<typeof createModelDecisionReader>
  lastUsed: number
  warmInputs: Map<string, { input: unknown; lastRead: number }>
}
const readers = new Map<string, ProjectReader>()

const readerFor = (projectDirectory: string) => {
  let entry = readers.get(projectDirectory)
  if (!entry) {
    entry = {
      reader: createModelDecisionReader({
        projectDirectory,
        openLedger: () => openReadOnlyObservationLedger(path, projectDirectory),
        async readPriceState(routes, signal) {
          const inputs = await requestInputs(signal)
          return readDecisionPriceState({ path, projectDirectory, inputs, routes, signal })
        },
        async readPriceIdentity(signal) {
          const inputs = await requestInputs(signal)
          return readPriceIdentity({ path, projectDirectory, inputs, signal })
        },
      }),
      lastUsed: Date.now(),
      warmInputs: new Map(),
    }
    readers.set(projectDirectory, entry)
  }
  return entry
}

/**
 * Keep-warm: a project under active work changes its observation revision constantly, which
 * invalidates the cached snapshot and made every open pay for a full rebuild. While a panel has
 * read the overview in the last WARM_IDLE_MS, rebuild it here, off the open path, whenever the
 * revision moved. Nothing reads, warms or stays resident once WARM_IDLE_MS passes with no read:
 * the timer stops and the project's reader and its snapshots are closed.
 */
const WARM_INTERVAL_MS = warmIntervalMs ?? 15_000
const WARM_IDLE_MS = 10 * 60_000
const MAX_WARM_INPUTS = 3
let warmTimer: ReturnType<typeof setInterval> | undefined
let warming = false
const warmGate = new WarmGate()
/** The revision stamp is one indexed row on the shared read-only connection. */
const readonlyDatabase = () => acquireSharedConnection(path, "readonly").db

const warmTick = async () => {
  // A person's read in flight is already doing this work; never queue behind or ahead of it.
  if (warming || controllers.size > 0) return
  const now = Date.now()
  for (const [projectDirectory, entry] of readers) {
    for (const [key, warm] of entry.warmInputs)
      if (now - warm.lastRead > WARM_IDLE_MS) entry.warmInputs.delete(key)
    if (now - entry.lastUsed > WARM_IDLE_MS) {
      entry.reader.close()
      readers.delete(projectDirectory)
    }
  }
  if (readers.size === 0) {
    clearInterval(warmTimer)
    warmTimer = undefined
    warmGate.clear()
    return
  }
  warming = true
  try {
    for (const [projectDirectory, entry] of readers) {
      if (controllers.size > 0) return
      await warmGate.pass(
        projectDirectory,
        observationRevisionStamp(readonlyDatabase(), projectDirectory),
        entry.warmInputs,
        (input) => entry.reader.warm(input as never),
        () => controllers.size > 0,
      )
    }
  } finally {
    warming = false
  }
}

const noteRead = (entry: ProjectReader, method: string, input: unknown) => {
  entry.lastUsed = Date.now()
  if (method === "overview") {
    const key = JSON.stringify(input)
    entry.warmInputs.delete(key)
    entry.warmInputs.set(key, { input, lastRead: entry.lastUsed })
    while (entry.warmInputs.size > MAX_WARM_INPUTS)
      entry.warmInputs.delete(entry.warmInputs.keys().next().value!)
  }
  if (!warmTimer) {
    warmTimer = setInterval(() => void warmTick(), WARM_INTERVAL_MS)
    warmTimer.unref()
  }
}

const run = async (id: number, projectDirectory: string, method: string, input: unknown) => {
  const controller = new AbortController()
  controllers.set(id, controller)
  callBySignal.set(controller.signal, id)
  try {
    const entry = readerFor(projectDirectory)
    const options = { signal: controller.signal }
    const call = (
      entry.reader as unknown as Record<string, (i: unknown, o: typeof options) => Promise<unknown>>
    )[method]
    if (!call) throw new Error(`Unknown decision method ${method}`)
    const value = await call.call(entry.reader, input, options)
    noteRead(entry, method, input)
    send({ type: "result", id, value })
  } catch (error) {
    send({ type: "error", id, message: error instanceof Error ? error.message : String(error) })
  } finally {
    controllers.delete(id)
  }
}

port.on("message", (message: WorkerRequest) => {
  if (message.type === "call")
    void run(message.id, message.projectDirectory, message.method, message.input)
  else if (message.type === "abort") controllers.get(message.id)?.abort(new Error(message.reason))
  else if (message.type === "price") {
    const waiter = priceWaiters.get(message.requestID)
    priceWaiters.delete(message.requestID)
    if (!waiter) return
    if (message.error !== undefined || !message.inputs)
      waiter.reject(new Error(message.error ?? "Price inputs are unavailable"))
    else waiter.resolve(message.inputs)
  } else if (message.type === "close") {
    clearInterval(warmTimer)
    for (const entry of readers.values()) entry.reader.close()
    readers.clear()
    port.close()
  }
})

import { parentPort, workerData } from "node:worker_threads"
import { createModelDecisionReader } from "./decision-read.ts"
import type { ModelDecisionPriceState } from "./decision-read.ts"
import { openReadOnlyObservationLedger } from "./observation-ledger-read.ts"
import type { WorkerRequest, WorkerResponse } from "./decision-worker-protocol.ts"

/**
 * Hosts the decision reader (ledger capture + projection + snapshot cache) on its own thread
 * with its own read-only SQLite connection. Price state needs OpenCode-owned access, so it is
 * requested from the main thread, which only reads settings and cached evidence.
 */
const port = parentPort
if (!port) throw new Error("decision-worker must run in a worker thread")
const { path, projectDirectory, warmIntervalMs } = workerData as {
  path: string
  projectDirectory: string
  warmIntervalMs?: number
}

const send = (message: WorkerResponse) => port.postMessage(message)
const controllers = new Map<number, AbortController>()
const callBySignal = new WeakMap<AbortSignal, number>()
const priceWaiters = new Map<
  number,
  { resolve(state: ModelDecisionPriceState): void; reject(error: Error): void }
>()
let priceSeq = 0

const reader = createModelDecisionReader({
  projectDirectory,
  openLedger: () => openReadOnlyObservationLedger(path, projectDirectory),
  readPriceState(routes, signal) {
    signal?.throwIfAborted()
    const requestID = ++priceSeq
    return new Promise<ModelDecisionPriceState>((resolve, reject) => {
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
        routes,
      })
    })
  },
})

/**
 * Keep-warm: a project under active work changes its observation revision constantly, which
 * invalidates the cached snapshot and made every open pay for a full rebuild. While a panel has
 * read the overview in the last WARM_IDLE_MS, rebuild it here, off the open path, whenever the
 * revision moved. An idle worker does no work: the loop ends WARM_IDLE_MS after the last read.
 */
const WARM_INTERVAL_MS = warmIntervalMs ?? 15_000
const WARM_IDLE_MS = 10 * 60_000
const MAX_WARM_INPUTS = 3
const warmInputs = new Map<string, { input: unknown; lastRead: number }>()
let warmTimer: ReturnType<typeof setInterval> | undefined
let warming = false

const warmTick = async () => {
  // A person's read in flight is already doing this work; never queue behind or ahead of it.
  if (warming || controllers.size > 0) return
  const now = Date.now()
  for (const [key, entry] of warmInputs)
    if (now - entry.lastRead > WARM_IDLE_MS) warmInputs.delete(key)
  if (warmInputs.size === 0) {
    clearInterval(warmTimer)
    warmTimer = undefined
    return
  }
  warming = true
  try {
    for (const { input } of warmInputs.values()) {
      if (controllers.size > 0) return
      await reader.warm(input as never).catch(() => undefined)
    }
  } finally {
    warming = false
  }
}

const noteRead = (method: string, input: unknown) => {
  if (method !== "overview") return
  const key = JSON.stringify(input)
  warmInputs.delete(key)
  warmInputs.set(key, { input, lastRead: Date.now() })
  while (warmInputs.size > MAX_WARM_INPUTS) warmInputs.delete(warmInputs.keys().next().value!)
  if (!warmTimer) {
    warmTimer = setInterval(() => void warmTick(), WARM_INTERVAL_MS)
    warmTimer.unref()
  }
}

const run = async (id: number, method: string, input: unknown) => {
  const controller = new AbortController()
  controllers.set(id, controller)
  callBySignal.set(controller.signal, id)
  try {
    const options = { signal: controller.signal }
    const call = (
      reader as unknown as Record<string, (i: unknown, o: typeof options) => Promise<unknown>>
    )[method]
    if (!call) throw new Error(`Unknown decision method ${method}`)
    const value = await call.call(reader, input, options)
    noteRead(method, input)
    send({ type: "result", id, value })
  } catch (error) {
    send({ type: "error", id, message: error instanceof Error ? error.message : String(error) })
  } finally {
    controllers.delete(id)
  }
}

port.on("message", (message: WorkerRequest) => {
  if (message.type === "call") void run(message.id, message.method, message.input)
  else if (message.type === "abort") controllers.get(message.id)?.abort(new Error(message.reason))
  else if (message.type === "price") {
    const waiter = priceWaiters.get(message.requestID)
    priceWaiters.delete(message.requestID)
    if (!waiter) return
    if (message.error !== undefined) waiter.reject(new Error(message.error))
    else waiter.resolve(message.state!)
  } else if (message.type === "close") {
    clearInterval(warmTimer)
    reader.close()
    port.close()
  }
})

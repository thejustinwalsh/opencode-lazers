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
const { path, projectDirectory } = workerData as { path: string; projectDirectory: string }

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
    send({ type: "result", id, value: await call.call(reader, input, options) })
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
    reader.close()
    port.close()
  }
})

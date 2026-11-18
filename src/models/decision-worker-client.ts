import { Worker } from "node:worker_threads"
import type { ModelDecisionReader } from "./decision-contract.ts"
import type { ModelDecisionPriceState } from "./decision-read.ts"
import type { CurrentPriceApplicability } from "./current-price-index.ts"
import type {
  DecisionWorkerMethod,
  WorkerRequest,
  WorkerResponse,
} from "./decision-worker-protocol.ts"

export type ThreadedDecisionReaderOptions = {
  path: string
  projectDirectory: string
  readPriceState(
    routes: readonly CurrentPriceApplicability[],
    signal?: AbortSignal,
  ): Promise<ModelDecisionPriceState>
  workerURL?: URL
}

type Pending = {
  resolve(value: never): void
  reject(error: Error): void
  controller: AbortController
}

/**
 * Decision reads run on a worker thread so ledger capture and projection never occupy the
 * OpenCode service event loop. The worker owns the snapshot cache; this proxy only posts
 * requests and awaits results.
 */
export function createThreadedDecisionReader(
  options: ThreadedDecisionReaderOptions,
): ModelDecisionReader & { close(): void } {
  let worker: Worker | undefined
  let nextID = 0
  let closed = false
  const pending = new Map<number, Pending>()

  const failAll = (error: Error) => {
    for (const [id, entry] of pending) {
      pending.delete(id)
      entry.reject(error)
    }
  }

  const acquire = () => {
    if (closed) throw new Error("Model decision reader is closed")
    if (worker) return worker
    const created = new Worker(
      options.workerURL ?? new URL("./decision-worker.ts", import.meta.url),
      { workerData: { path: options.path, projectDirectory: options.projectDirectory } },
    )
    created.unref()
    worker = created
    const reply = (message: WorkerRequest) => created.postMessage(message)
    created.on("message", (message: WorkerResponse) => {
      if (message.type === "price") {
        options.readPriceState(message.routes, pending.get(message.callID)?.controller.signal).then(
          (state) => reply({ type: "price", requestID: message.requestID, state }),
          (error: unknown) =>
            reply({
              type: "price",
              requestID: message.requestID,
              error: error instanceof Error ? error.message : String(error),
            }),
        )
        return
      }
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.type === "result") entry.resolve(message.value as never)
      else entry.reject(new Error(message.message))
    })
    const dead = (error: Error) => {
      if (worker === created) worker = undefined
      failAll(error)
    }
    created.on("error", (error) => dead(error instanceof Error ? error : new Error(String(error))))
    created.on("exit", (code) => dead(new Error(`Model decision worker exited with code ${code}`)))
    return created
  }

  const call = <T>(method: DecisionWorkerMethod, input: unknown, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const target = acquire()
    const id = ++nextID
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      const onAbort = () => {
        if (!pending.delete(id)) return
        controller.abort(signal?.reason)
        target.postMessage({
          type: "abort",
          id,
          reason: String(signal?.reason ?? "aborted"),
        } satisfies WorkerRequest)
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Model decision read aborted"),
        )
      }
      pending.set(id, { resolve: resolve as never, reject, controller })
      signal?.addEventListener("abort", onAbort, { once: true })
      target.postMessage({ type: "call", id, method, input } satisfies WorkerRequest)
    })
  }

  return {
    overview: (input, opts) => call("overview", input, opts?.signal),
    rows: (input, opts) => call("rows", input, opts?.signal),
    configurations: (input, opts) => call("configurations", input, opts?.signal),
    inspect: (input, opts) => call("inspect", input, opts?.signal),
    close() {
      if (closed) return
      closed = true
      failAll(new Error("Model decision reader is closed"))
      const target = worker
      worker = undefined
      if (target) {
        target.postMessage({ type: "close" } satisfies WorkerRequest)
        void target.terminate()
      }
    },
  }
}

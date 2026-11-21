import { Worker } from "node:worker_threads"
import { workerURL } from "../worker-url.ts"
import type { ModelDecisionReader } from "./decision-contract.ts"
import type { PriceInputs } from "./price-state.ts"
import type { DecisionViewCall, DecisionViewResult } from "./decision-view.ts"
import type {
  DecisionWorkerMethod,
  WorkerRequest,
  WorkerResponse,
} from "./decision-worker-protocol.ts"

export type ThreadedDecisionWorkerOptions = {
  path: string
  /** The OpenCode-owned price inputs; the worker reads all evidence itself. */
  readPriceInputs(signal?: AbortSignal): Promise<PriceInputs>
  workerURL?: URL
  /** How often the worker re-checks a recently read snapshot; tests shorten it. */
  warmIntervalMs?: number
}

export type ThreadedDecisionWorker = {
  /** A reader for one project of this database; all readers share the worker thread. */
  reader(projectDirectory: string): ModelDecisionReader
  /** A stored view's rows for one project (`decision-view.ts`), computed on the worker. */
  view(
    projectDirectory: string,
    call: DecisionViewCall,
    signal?: AbortSignal,
  ): Promise<DecisionViewResult>
  close(): void
}

type Pending = {
  resolve(value: never): void
  reject(error: Error): void
  controller: AbortController
}

/**
 * Decision reads run on a worker thread so ledger capture and projection never occupy the
 * OpenCode service event loop. One worker serves every project of a database; it owns the
 * snapshot caches, and this proxy only posts requests and awaits results.
 */
export function createThreadedDecisionWorker(
  options: ThreadedDecisionWorkerOptions,
): ThreadedDecisionWorker {
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
      options.workerURL ?? workerURL("./decision-worker", import.meta.url),
      {
        workerData: {
          path: options.path,
          ...(options.warmIntervalMs === undefined
            ? {}
            : { warmIntervalMs: options.warmIntervalMs }),
        },
      },
    )
    created.unref()
    worker = created
    const reply = (message: WorkerRequest) => created.postMessage(message)
    created.on("message", (message: WorkerResponse) => {
      if (message.type === "price") {
        options.readPriceInputs(pending.get(message.callID)?.controller.signal).then(
          (inputs) => reply({ type: "price", requestID: message.requestID, inputs }),
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

  const call = <T>(
    projectDirectory: string,
    method: DecisionWorkerMethod,
    input: unknown,
    signal?: AbortSignal,
  ) => {
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
      target.postMessage({
        type: "call",
        id,
        projectDirectory,
        method,
        input,
      } satisfies WorkerRequest)
    })
  }

  return {
    reader: (projectDirectory) => ({
      overview: (input, opts) => call(projectDirectory, "overview", input, opts?.signal),
      rows: (input, opts) => call(projectDirectory, "rows", input, opts?.signal),
      configurations: (input, opts) =>
        call(projectDirectory, "configurations", input, opts?.signal),
      inspect: (input, opts) => call(projectDirectory, "inspect", input, opts?.signal),
    }),
    view: (projectDirectory, input, signal) => call(projectDirectory, "view", input, signal),
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

/** A single-project reader on its own worker; tests and one-off readers use it. */
export function createThreadedDecisionReader(
  options: ThreadedDecisionWorkerOptions & { projectDirectory: string },
): ModelDecisionReader & { close(): void } {
  const worker = createThreadedDecisionWorker(options)
  return { ...worker.reader(options.projectDirectory), close: () => worker.close() }
}

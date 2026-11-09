import type { MainContext } from "@opencode/plugin/gui/main"
import { Worker } from "node:worker_threads"
import ELK from "elkjs/lib/elk-api.js"
import { panelErrorMessage } from "../panel-error.ts"
import { RadarLayout } from "./layout-ipc.ts"
import type { RadarLayoutInput, RadarLayoutResult } from "./layout-ipc.ts"
import { elkGraph, radarLayoutResult } from "./layout-graph.ts"

declare const __LAZERS_RADAR_WORKER_SOURCE__: string

type MainWorker = {
  postMessage(message: { id?: number }): void
  terminate(): void
  onmessage: ((event: MessageEvent) => void) | null
}

function workerAdapter(worker: Worker): MainWorker {
  const pending = new Set<number>()
  const adapter: MainWorker = {
    onmessage: null,
    postMessage(message) {
      if (message.id !== undefined) pending.add(message.id)
      worker.postMessage(message)
    },
    terminate() {
      void worker.terminate()
    },
  }
  worker.on("message", (data: { id?: number }) => {
    if (data.id !== undefined) pending.delete(data.id)
    adapter.onmessage?.({ data } as MessageEvent)
  })
  worker.on("error", (error) => {
    const message = panelErrorMessage(error)
    for (const id of pending) {
      pending.delete(id)
      adapter.onmessage?.({ data: { id, error: { message } } } as MessageEvent)
    }
  })
  worker.on("exit", (code) => {
    for (const id of pending) {
      pending.delete(id)
      adapter.onmessage?.({
        data: { id, error: { message: `ELK worker exited with code ${code}` } },
      } as MessageEvent)
    }
  })
  return adapter
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    signal.addEventListener("abort", aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
  })
}

export function createRadarLayoutService(workerSource: string, options?: { eval: boolean }) {
  let current: { worker: Worker; api: InstanceType<typeof ELK>; pending: number } | undefined
  let idleFailure: Error | undefined
  let disposed = false
  const acquire = () => {
    if (current) return current
    const worker = new Worker(workerSource, options)
    const factory = (() => workerAdapter(worker)) as unknown as () => globalThis.Worker
    const entry = { worker, api: new ELK({ workerFactory: factory }), pending: 0 }
    current = entry
    const failed = (error: Error) => {
      if (current !== entry) return
      current = undefined
      if (!disposed && entry.pending === 0) idleFailure = error
    }
    worker.on("error", failed)
    worker.on("exit", (code) => failed(new Error(`ELK worker exited with code ${code}`)))
    return entry
  }
  return {
    async layout(input: RadarLayoutInput, signal: AbortSignal): Promise<RadarLayoutResult> {
      signal.throwIfAborted()
      if (disposed) throw new Error("ELK layout service is disposed")
      if (idleFailure) {
        const error = idleFailure
        idleFailure = undefined
        throw error
      }
      const entry = acquire()
      entry.pending++
      const startedAt = performance.now()
      const layout = entry.api.layout(elkGraph(input)).finally(() => entry.pending--)
      const graph = await abortable(layout, signal)
      signal.throwIfAborted()
      return radarLayoutResult(input, graph, performance.now() - startedAt, entry.worker.threadId)
    },
    async dispose() {
      disposed = true
      idleFailure = undefined
      const entry = current
      current = undefined
      if (entry) await entry.worker.terminate()
    },
  }
}

export function setupRadarLayoutMain(ctx: MainContext) {
  const service = createRadarLayoutService(__LAZERS_RADAR_WORKER_SOURCE__, { eval: true })
  const provider = ctx.provide(RadarLayout, {
    layout: (input, caller) => service.layout(input, caller.signal),
  })
  return async () => {
    provider.dispose()
    await service.dispose()
  }
}

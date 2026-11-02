import type { MainContext } from "@opencode/plugin/gui/main"
import { Worker } from "node:worker_threads"
import { join } from "node:path"
import ELK from "elkjs/lib/elk-api.js"
import { RadarLayout } from "./layout-ipc.ts"
import type { RadarLayoutInput, RadarLayoutResult } from "./layout-ipc.ts"
import { elkGraph, radarLayoutResult } from "./layout-graph.ts"

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
    const message = error instanceof Error ? error.message : String(error)
    for (const id of pending) {
      pending.delete(id)
      adapter.onmessage?.({ data: { id, error: { message } } } as MessageEvent)
    }
  })
  worker.on("exit", (code) => {
    if (code === 0) return
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

export function createRadarLayoutService(workerPath: string) {
  return {
    async layout(input: RadarLayoutInput, signal: AbortSignal): Promise<RadarLayoutResult> {
      signal.throwIfAborted()
      const worker = new Worker(workerPath)
      try {
        const factory = (() => workerAdapter(worker)) as unknown as () => globalThis.Worker
        const api = new ELK({ workerFactory: factory })
        const startedAt = performance.now()
        const graph = await abortable(api.layout(elkGraph(input)), signal)
        signal.throwIfAborted()
        return radarLayoutResult(input, graph, performance.now() - startedAt, worker.threadId)
      } finally {
        await worker.terminate()
      }
    },
  }
}

export function setupRadarLayoutMain(ctx: MainContext) {
  const workerPath = join(__dirname, "radar-layout-worker.cjs")
  const service = createRadarLayoutService(workerPath)
  const provider = ctx.provide(RadarLayout, {
    layout: (input, caller) => service.layout(input, caller.signal),
  })
  return async () => {
    provider.dispose()
  }
}

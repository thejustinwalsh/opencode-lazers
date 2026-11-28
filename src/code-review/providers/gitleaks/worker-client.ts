import { Worker } from "node:worker_threads"
import { workerURL } from "../../../worker-url.ts"
import type { GitleaksFailureCode } from "./contract.ts"
import type { GitleaksWorkerMessage } from "./gitleaks-worker.ts"
import type { GitleaksWasmRequest, GitleaksWasmResponse } from "./wasm-contract.ts"

export type GitleaksWorkerRun = (
  module: WebAssembly.Module,
  request: GitleaksWasmRequest,
  signal: AbortSignal,
  timeoutMs: number,
) => Promise<GitleaksWasmResponse>

/** One request per worker keeps cancellation and linear memory ownership unambiguous. */
export const runGitleaksWorker: GitleaksWorkerRun = async (module, request, signal, timeoutMs) => {
  if (signal.aborted) throw new WorkerFailure("cancelled")

  const worker = new Worker(workerURL("./gitleaks-worker", import.meta.url))
  try {
    return await new Promise<GitleaksWasmResponse>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        worker.removeAllListeners("message")
        worker.removeAllListeners("error")
        worker.removeAllListeners("exit")
        callback()
      }
      const abort = () => finish(() => reject(new WorkerFailure("cancelled")))
      const timer = setTimeout(() => finish(() => reject(new WorkerFailure("timeout"))), timeoutMs)

      worker.once("message", (response: GitleaksWasmResponse) => finish(() => resolve(response)))
      worker.once("error", () => finish(() => reject(new WorkerFailure("worker-failed"))))
      worker.once("exit", (code) => {
        if (!settled) finish(() => reject(new WorkerFailure("worker-exit")))
        else if (code !== 0) return
      })
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      worker.postMessage({ module, request } satisfies GitleaksWorkerMessage)
    })
  } finally {
    await worker.terminate().catch(() => 0)
  }
}

export class WorkerFailure extends Error {
  constructor(readonly code: GitleaksFailureCode) {
    super(code)
  }
}

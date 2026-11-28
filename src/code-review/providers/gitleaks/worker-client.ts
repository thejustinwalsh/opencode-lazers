import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  onStarted?: () => void,
) => Promise<GitleaksWasmResponse>

/** One request per worker keeps cancellation and linear memory ownership unambiguous. */
export const runGitleaksWorker: GitleaksWorkerRun = async (
  module,
  request,
  signal,
  timeoutMs,
  onStarted,
) => {
  if (signal.aborted) throw new WorkerFailure("cancelled")

  const root = mkdtempSync(join(tmpdir(), "lazers-gitleaks-"))
  let worker: Worker | undefined
  let response: GitleaksWasmResponse | undefined
  let runFailed = false
  let runError: unknown
  try {
    worker = new Worker(workerURL("./gitleaks-worker", import.meta.url))
    const activeWorker = worker
    response = await new Promise<GitleaksWasmResponse>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        activeWorker.removeAllListeners("message")
        activeWorker.removeAllListeners("error")
        activeWorker.removeAllListeners("exit")
        callback()
      }
      const abort = () => finish(() => reject(new WorkerFailure("cancelled")))
      const timer = setTimeout(() => finish(() => reject(new WorkerFailure("timeout"))), timeoutMs)

      activeWorker.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "started"
        ) {
          onStarted?.()
          return
        }
        finish(() => resolve(message as GitleaksWasmResponse))
      })
      activeWorker.once("error", () => finish(() => reject(new WorkerFailure("worker-failed"))))
      activeWorker.once("exit", (code) => {
        if (!settled) finish(() => reject(new WorkerFailure("worker-exit")))
        else if (code !== 0) return
      })
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      activeWorker.postMessage({ module, request, root } satisfies GitleaksWorkerMessage)
    })
  } catch (error) {
    runFailed = true
    runError = error
  }

  let cleanupFailed = false
  if (worker) {
    try {
      await worker.terminate()
    } catch {
      cleanupFailed = true
    }
  }
  try {
    rmSync(root, { recursive: true })
  } catch {
    cleanupFailed = true
  }
  if (cleanupFailed) throw new WorkerFailure("worker-cleanup-failed")
  if (runFailed) throw runError
  if (!response) throw new WorkerFailure("worker-failed")
  return response
}

export class WorkerFailure extends Error {
  constructor(readonly code: GitleaksFailureCode) {
    super(code)
  }
}

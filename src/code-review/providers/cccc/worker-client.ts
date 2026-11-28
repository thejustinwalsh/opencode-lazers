import { Worker } from "node:worker_threads"
import { workerURL } from "../../../worker-url.ts"
import type { CcccFileReport, CcccSourceAnalyzer } from "./types.ts"
import type { CcccWorkerFailure, CcccWorkerMessage, CcccWorkerRequest } from "./worker-protocol.ts"

export class CcccWorkerError extends Error {
  constructor(
    readonly code:
      "worker-unavailable" | "worker-invalid-output" | "analysis-timeout" | "cancelled",
    message: string,
  ) {
    super(message)
  }
}

export interface CcccWorkerOptions {
  workerURL?: URL
}

export function createCcccWorkerAnalyzer(options: CcccWorkerOptions = {}): CcccSourceAnalyzer {
  const url = options.workerURL ?? workerURL("./code-review-cccc-worker", import.meta.url)
  return (files, { signal, timeoutMs }) =>
    new Promise<CcccFileReport[]>((resolve, reject) => {
      if (signal.aborted) {
        reject(new CcccWorkerError("cancelled", "cccc analysis was cancelled"))
        return
      }
      const worker = new Worker(url)
      const request: CcccWorkerRequest = { id: 1, files }
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        worker.removeAllListeners()
        callback()
      }
      const stop = () => void worker.terminate()
      const abort = () => {
        finish(() => {
          stop()
          reject(new CcccWorkerError("cancelled", "cccc analysis was cancelled"))
        })
      }
      const timer = setTimeout(() => {
        finish(() => {
          stop()
          reject(new CcccWorkerError("analysis-timeout", "cccc analysis exceeded its time limit"))
        })
      }, timeoutMs)
      worker.on("message", (message: CcccWorkerMessage) => {
        if ("ready" in message) {
          worker.postMessage(request)
          return
        }
        if (message.id !== request.id) return
        finish(() => {
          if (!message.ok) {
            reject(workerFailure(message))
            return
          }
          resolve(message.reports)
        })
        stop()
      })
      worker.once("error", () => {
        finish(() => {
          stop()
          reject(new CcccWorkerError("worker-unavailable", "cccc analysis worker failed"))
        })
      })
      worker.once("exit", (code) => {
        if (settled || code === 0) return
        finish(() => reject(new CcccWorkerError("worker-unavailable", "cccc worker exited early")))
      })
      signal.addEventListener("abort", abort, { once: true })
    })
}

function workerFailure(message: CcccWorkerFailure): CcccWorkerError {
  return message.code === "worker-invalid-output"
    ? new CcccWorkerError("worker-invalid-output", "cccc returned an invalid report")
    : new CcccWorkerError("worker-unavailable", "cccc could not analyze the captured source")
}

export const defaultCcccWorkerAnalyzer = createCcccWorkerAnalyzer()

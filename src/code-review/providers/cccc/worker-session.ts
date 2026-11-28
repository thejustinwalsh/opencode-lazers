import type { Worker } from "node:worker_threads"
import type { CcccFileReport } from "./types.ts"
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

export function runCcccWorkerSession(
  worker: Worker,
  request: CcccWorkerRequest,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CcccFileReport[]> {
  return new Promise<CcccFileReport[]>((resolve, reject) => {
    let settled = false
    let workerExited = false
    let requestSent = false
    let abort: () => void = () => undefined

    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      worker.removeAllListeners()
    }

    const stopWorker = async () => {
      if (workerExited) return true
      try {
        await worker.terminate()
        return true
      } catch {
        return workerExited
      }
    }

    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)

      const settleAfterTermination = async () => {
        const stopped = await stopWorker()
        cleanup()
        if (!stopped) {
          reject(
            new CcccWorkerError("worker-unavailable", "cccc analysis worker could not be stopped"),
          )
          return
        }
        complete()
      }
      void settleAfterTermination().catch(() => {
        cleanup()
        reject(
          new CcccWorkerError("worker-unavailable", "cccc analysis worker could not be stopped"),
        )
      })
    }

    abort = () =>
      finish(() => reject(new CcccWorkerError("cancelled", "cccc analysis was cancelled")))

    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new CcccWorkerError("analysis-timeout", "cccc analysis exceeded its time limit")),
        ),
      timeoutMs,
    )

    worker.on("message", (message: CcccWorkerMessage) => {
      if (!message || typeof message !== "object") {
        finish(() =>
          reject(new CcccWorkerError("worker-invalid-output", "cccc returned an invalid report")),
        )
        return
      }
      if ("ready" in message) {
        if (requestSent) return
        requestSent = true
        try {
          worker.postMessage(request)
        } catch {
          finish(() =>
            reject(new CcccWorkerError("worker-unavailable", "cccc analysis worker failed")),
          )
        }
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
    })
    worker.once("error", () => {
      finish(() => reject(new CcccWorkerError("worker-unavailable", "cccc analysis worker failed")))
    })
    worker.once("exit", () => {
      workerExited = true
      if (!settled)
        finish(() => reject(new CcccWorkerError("worker-unavailable", "cccc worker exited early")))
    })
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

function workerFailure(message: CcccWorkerFailure): CcccWorkerError {
  return message.code === "worker-invalid-output"
    ? new CcccWorkerError("worker-invalid-output", "cccc returned an invalid report")
    : new CcccWorkerError("worker-unavailable", "cccc could not analyze the captured source")
}

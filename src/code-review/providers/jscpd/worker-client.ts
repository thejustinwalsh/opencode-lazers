import { Worker } from "node:worker_threads"
import { workerURL } from "../../../worker-url.ts"
import type { DuplicationFailureCode, JscpdSideReport, WasmScanRequest } from "./contract.ts"
import type { JscpdWorkerRequest, JscpdWorkerResponse } from "./jscpd-worker.ts"
import { isDuplicationFailureCode } from "./worker-protocol.ts"

type WorkerReply = JscpdWorkerResponse | { ready: true }

export class DuplicationAnalysisError extends Error {
  constructor(readonly code: DuplicationFailureCode) {
    super(
      code === "analyzer-timeout"
        ? "The duplication analysis timed out."
        : code === "analyzer-memory"
          ? "The duplication analyzer ran out of memory."
          : code === "invalid-request"
            ? "The duplication analyzer rejected its request."
            : "The duplication analyzer is unavailable.",
    )
    this.name = "DuplicationAnalysisError"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isWorkerReply(value: unknown): value is WorkerReply {
  if (!record(value)) return false
  if ("ready" in value) return value.ready === true
  if (value.id !== 1) return false
  if (value.ok === true) return record(value.report)
  return value.ok === false && isDuplicationFailureCode(value.code)
}

/** Each side gets a fresh worker: terminating it releases its WASI instance and source buffers. */
export function runJscpdSide(
  scan: WasmScanRequest,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<JscpdSideReport> {
  const { signal, timeoutMs } = options
  if (signal?.aborted)
    return Promise.reject(new DOMException("Duplication analysis was cancelled.", "AbortError"))

  const worker = new Worker(workerURL("./jscpd-worker", import.meta.url))
  return new Promise<JscpdSideReport>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      void worker.terminate().catch(() => undefined)
      action()
    }
    const abort = () =>
      finish(() => reject(new DOMException("Duplication analysis was cancelled.", "AbortError")))
    const timer = setTimeout(
      () => finish(() => reject(new DuplicationAnalysisError("analyzer-timeout"))),
      timeoutMs,
    )

    worker.on("message", (value: unknown) => {
      if (!isWorkerReply(value) || "ready" in value) return
      if (!value.ok) {
        finish(() => reject(new DuplicationAnalysisError(value.code)))
        return
      }
      finish(() => resolve(value.report))
    })
    worker.on("error", () => finish(() => reject(new DuplicationAnalysisError("worker-failed"))))
    worker.on("exit", () => {
      finish(() => reject(new DuplicationAnalysisError("worker-failed")))
    })
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    try {
      worker.postMessage({ id: 1, scan } satisfies JscpdWorkerRequest)
    } catch {
      finish(() => reject(new DuplicationAnalysisError("worker-failed")))
    }
  })
}

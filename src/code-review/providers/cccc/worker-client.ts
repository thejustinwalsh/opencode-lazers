import { Worker } from "node:worker_threads"
import { workerURL } from "../../../worker-url.ts"
import type { CcccFileReport, CcccSourceAnalyzer } from "./types.ts"
import { CcccWorkerError, runCcccWorkerSession } from "./worker-session.ts"
import type { CcccWorkerRequest } from "./worker-protocol.ts"

export interface CcccWorkerOptions {
  workerURL?: URL
}

export function createCcccWorkerAnalyzer(options: CcccWorkerOptions = {}): CcccSourceAnalyzer {
  const url = options.workerURL ?? workerURL("./code-review-cccc-worker", import.meta.url)
  return (files, { signal, timeoutMs }): Promise<CcccFileReport[]> => {
    if (signal.aborted)
      return Promise.reject(new CcccWorkerError("cancelled", "cccc analysis was cancelled"))

    let worker: Worker
    try {
      worker = new Worker(url)
    } catch {
      return Promise.reject(
        new CcccWorkerError("worker-unavailable", "cccc analysis worker failed to start"),
      )
    }
    const request: CcccWorkerRequest = { id: 1, files }
    return runCcccWorkerSession(worker, request, signal, timeoutMs)
  }
}

export { CcccWorkerError } from "./worker-session.ts"
export const defaultCcccWorkerAnalyzer = createCcccWorkerAnalyzer()

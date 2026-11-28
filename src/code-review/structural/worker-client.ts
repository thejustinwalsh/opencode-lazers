import { readFile } from "node:fs/promises"
import { Worker } from "node:worker_threads"
import { gunzip } from "node:zlib"
import { promisify } from "node:util"
import { workerURL, wasmURL } from "../../worker-url.ts"
import {
  StructuralCompareRequestSchema,
  StructuralDiffSchema,
  type StructuralDegradedReason,
  type StructuralCompareRequest,
  type StructuralDiff,
  type ValidStructuralCompareRequest,
} from "./contract.ts"
import { coarseLineDiff } from "./coarse-line-diff.ts"
import type { DifftasticWorkerRequest, DifftasticWorkerResponse } from "./difftastic-worker.ts"
import { binaryDiff } from "./line-diff.ts"

const gunzipAsync = promisify(gunzip)
const DEFAULT_TIMEOUT_MS = 30_000
const FALLBACK_TIMEOUT_MS = 5_000

let compiledModule: Promise<WebAssembly.Module> | undefined

class WorkerTimeoutError extends Error {}

function loadWasmModule(): Promise<WebAssembly.Module> {
  if (!compiledModule) {
    compiledModule = readFile(wasmURL("./difftastic.wasm.gz", import.meta.url))
      .then(gunzipAsync)
      .then((bytes) => WebAssembly.compile(bytes))
      .catch((error: unknown) => {
        compiledModule = undefined
        throw error
      })
  }
  return compiledModule
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("Structural diff was cancelled", "AbortError")
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(abortError(signal))
    }
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

function runWorker(
  message: DifftasticWorkerRequest,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<StructuralDiff> {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  const worker = new Worker(workerURL("./difftastic-worker", import.meta.url))
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      worker.removeListener("message", onMessage)
      worker.removeListener("error", onError)
      worker.removeListener("exit", onExit)
    }
    const settle = (
      outcome: { ok: true; result: StructuralDiff } | { ok: false; error: Error },
    ) => {
      if (settled) return
      settled = true
      cleanup()
      void Promise.resolve()
        .then(() => worker.terminate())
        .catch(() => undefined)
        .then(() => {
          if (outcome.ok) resolve(outcome.result)
          else reject(outcome.error)
        })
    }

    const abort = () =>
      settle({
        ok: false,
        error: signal
          ? abortError(signal)
          : new DOMException("Structural diff was cancelled", "AbortError"),
      })
    const onMessage = (response: DifftasticWorkerResponse) => {
      if (!response.ok) {
        settle({ ok: false, error: new Error(response.error) })
        return
      }
      try {
        settle({ ok: true, result: StructuralDiffSchema.parse(response.result) })
      } catch {
        settle({ ok: false, error: new Error("Structural diff worker returned invalid output") })
      }
    }
    const onError = (error: Error) => settle({ ok: false, error })
    const onExit = (code: number) => {
      if (!settled)
        settle({ ok: false, error: new Error(`Structural diff worker exited with code ${code}`) })
    }
    const timer = setTimeout(
      () => settle({ ok: false, error: new WorkerTimeoutError() }),
      timeoutMs,
    )
    worker.on("message", onMessage)
    worker.on("error", onError)
    worker.on("exit", onExit)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    try {
      worker.postMessage(message)
    } catch (error) {
      settle({
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  })
}

async function fallbackDiff(
  request: ValidStructuralCompareRequest,
  degraded: StructuralDegradedReason,
  signal?: AbortSignal,
): Promise<StructuralDiff> {
  if (signal?.aborted) throw abortError(signal)
  try {
    return await runWorker({ kind: "fallback", request, degraded }, signal, FALLBACK_TIMEOUT_MS)
  } catch {
    if (signal?.aborted) throw abortError(signal)
    return coarseLineDiff(request, degraded)
  }
}

/** Compute one Oaink-shaped structural diff; abort terminates the WASM worker. */
export async function compareStructural(
  input: StructuralCompareRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<StructuralDiff> {
  const request = StructuralCompareRequestSchema.parse(input)
  if (options.signal?.aborted) throw abortError(options.signal)
  if (request.binary) return binaryDiff(request)

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("timeoutMs must be a positive safe integer")

  let module: WebAssembly.Module
  try {
    module = await awaitWithAbort(loadWasmModule(), options.signal)
  } catch {
    if (options.signal?.aborted) throw abortError(options.signal)
    return fallbackDiff(request, "analysis-failure", options.signal)
  }
  if (options.signal?.aborted) throw abortError(options.signal)
  try {
    return await runWorker({ kind: "compare", module, request }, options.signal, timeoutMs)
  } catch (error) {
    if (options.signal?.aborted) throw abortError(options.signal)
    return fallbackDiff(
      request,
      error instanceof WorkerTimeoutError ? "timeout" : "analysis-failure",
      options.signal,
    )
  }
}

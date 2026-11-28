import { readFile } from "node:fs/promises"
import { Worker } from "node:worker_threads"
import { gunzip } from "node:zlib"
import { promisify } from "node:util"
import { workerURL, wasmURL } from "../../worker-url.ts"
import {
  StructuralCompareRequestSchema,
  StructuralDiffSchema,
  type StructuralCompareRequest,
  type StructuralDiff,
  type ValidStructuralCompareRequest,
} from "./contract.ts"
import type { DifftasticWorkerRequest, DifftasticWorkerResponse } from "./difftastic-worker.ts"
import { binaryDiff, lineDiff } from "./line-diff.ts"

const gunzipAsync = promisify(gunzip)
const DEFAULT_TIMEOUT_MS = 30_000

let compiledModule: Promise<WebAssembly.Module> | undefined

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

function workerDiff(
  request: ValidStructuralCompareRequest,
  module: WebAssembly.Module,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<StructuralDiff> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(workerURL("./difftastic-worker", import.meta.url))
    } catch {
      resolve(lineDiff(request, "analysis-failure"))
      return
    }
    let settled = false
    const finish = (result: StructuralDiff) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      void worker.terminate()
      resolve(result)
    }
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      void worker.terminate()
      if (signal?.aborted) reject(abortError(signal))
      else resolve(lineDiff(request, "analysis-failure"))
    }
    const abort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      void worker.terminate()
      reject(
        signal
          ? abortError(signal)
          : new DOMException("Structural diff was cancelled", "AbortError"),
      )
    }
    const timer = setTimeout(() => finish(lineDiff(request, "timeout")), timeoutMs)
    worker.once("message", (response: DifftasticWorkerResponse) => {
      if (!response.ok) {
        fail()
        return
      }
      try {
        finish(StructuralDiffSchema.parse(response.result))
      } catch {
        fail()
      }
    })
    worker.once("error", () => fail())
    worker.once("exit", (code) => {
      if (!settled) {
        void code
        fail()
      }
    })
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    try {
      worker.postMessage({ module, request } satisfies DifftasticWorkerRequest)
    } catch {
      fail()
    }
  })
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
    return lineDiff(request, "analysis-failure")
  }
  if (options.signal?.aborted) throw abortError(options.signal)
  return workerDiff(request, module, options.signal, timeoutMs)
}

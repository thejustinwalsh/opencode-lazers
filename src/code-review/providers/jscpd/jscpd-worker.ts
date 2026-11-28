import { parentPort } from "node:worker_threads"
import { wasmURL } from "../../../worker-url.ts"
import type { DuplicationFailureCode, JscpdSideReport, WasmScanRequest } from "./contract.ts"
import { executeJscpdScan, parseJscpdResponse } from "./wasm-scan.ts"
import { duplicationFailureCode } from "./worker-protocol.ts"

export type JscpdWorkerRequest = { id: number; scan: WasmScanRequest }
export type JscpdWorkerResponse =
  | { id: number; ok: true; report: JscpdSideReport }
  | { id: number; ok: false; code: DuplicationFailureCode }

const port = parentPort
if (!port) throw new Error("jscpd-worker must run in a worker thread")
const workerPort = port

let modulePromise: Promise<WebAssembly.Module> | undefined

function loadWasm(): Promise<WebAssembly.Module> {
  modulePromise ??= Bun.file(wasmURL("./jscpd.wasm", import.meta.url))
    .arrayBuffer()
    .then((bytes) => WebAssembly.compile(bytes))
  return modulePromise
}

async function analyze(scan: WasmScanRequest): Promise<JscpdSideReport> {
  try {
    return parseJscpdResponse(executeJscpdScan(await loadWasm(), scan))
  } finally {
    Bun.gc(true)
  }
}

async function handleRequest(request: JscpdWorkerRequest): Promise<void> {
  let response: JscpdWorkerResponse
  try {
    response = { id: request.id, ok: true, report: await analyze(request.scan) }
  } catch (error) {
    response = { id: request.id, ok: false, code: duplicationFailureCode(error) }
  }
  workerPort.postMessage(response)
}

let queue: Promise<void> = Promise.resolve()
workerPort.on("message", (request: JscpdWorkerRequest) => {
  queue = queue.then(() => handleRequest(request))
})

workerPort.postMessage({ ready: true })

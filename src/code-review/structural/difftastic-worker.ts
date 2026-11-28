import { parentPort } from "node:worker_threads"
import { WASI } from "node:wasi"
import {
  StructuralDiffSchema,
  type StructuralDegradedReason,
  type StructuralDiff,
  type ValidStructuralCompareRequest,
} from "./contract.ts"
import { parseDifftasticJson } from "./difftastic-json.ts"
import { lineDiff } from "./line-diff.ts"
import { fallbackReason } from "./structural-diff.ts"
import { toStructuralDiff } from "./difftastic-result.ts"

if (!parentPort) throw new Error("Difftastic worker requires a worker thread")

export type DifftasticWorkerRequest =
  | {
      kind: "compare"
      module: WebAssembly.Module
      request: ValidStructuralCompareRequest
    }
  | {
      kind: "fallback"
      degraded: StructuralDegradedReason
      request: ValidStructuralCompareRequest
    }

export type DifftasticWorkerResponse =
  { ok: true; result: StructuralDiff } | { ok: false; error: string }

type DifftasticExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory
  alloc(length: number): number
  compare(pointer: number, length: number): bigint
  dealloc(pointer: number, length: number): void
}

function runDifftastic(module: WebAssembly.Module, request: ValidStructuralCompareRequest): string {
  const wasi = new WASI({
    version: "preview1",
    args: ["difft"],
    env: {},
    preopens: {},
    returnOnExit: true,
  })
  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  })
  const exports = instance.exports as DifftasticExports
  // This is a reactor module with a custom C ABI, not a WASI command exporting _start.
  // Bind its memory to Bun's WASI implementation with an empty start callback.
  wasi.start({ exports: { memory: exports.memory, _start: () => {} } } as never)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const input = encoder.encode(
    JSON.stringify({
      path: request.path,
      base: request.base,
      head: request.head,
      byteLimit: request.limits.byteLimit,
      graphLimit: request.limits.graphLimit,
      parseErrorLimit: request.limits.parseErrorLimit,
    }),
  )
  const inputPointer = exports.alloc(input.length)
  new Uint8Array(exports.memory.buffer, inputPointer, input.length).set(input)
  const packed = exports.compare(inputPointer, input.length)
  exports.dealloc(inputPointer, input.length)

  const outputPointer = Number(packed & 0xffff_ffffn)
  const outputLength = Number(packed >> 32n)
  const output = new Uint8Array(exports.memory.buffer, outputPointer, outputLength).slice()
  exports.dealloc(outputPointer, outputLength)
  return decoder.decode(output)
}

function compareDifftastic(
  module: WebAssembly.Module,
  request: ValidStructuralCompareRequest,
): StructuralDiff {
  const file = parseDifftasticJson(runDifftastic(module, request))
  const reason = fallbackReason(file.language)
  return reason
    ? lineDiff(request, reason)
    : StructuralDiffSchema.parse(toStructuralDiff(file, request))
}

parentPort.once("message", (message: DifftasticWorkerRequest) => {
  let response: DifftasticWorkerResponse
  try {
    const result =
      message.kind === "fallback"
        ? lineDiff(message.request, message.degraded)
        : compareDifftastic(message.module, message.request)
    response = { ok: true, result }
  } catch (error) {
    response = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  parentPort!.postMessage(response)
  parentPort!.close()
})

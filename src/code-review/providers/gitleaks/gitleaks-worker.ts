import { parentPort } from "node:worker_threads"
import { memoryExhausted, runFallowModule, WasiTrap } from "../../../audit/fallow-wasi.ts"
import type {
  GitleaksWasmRequest,
  GitleaksWasmResult,
  GitleaksWasmResponse,
} from "./wasm-contract.ts"

const port = parentPort

type Message = { module: WebAssembly.Module; request: GitleaksWasmRequest; root: string }

export type GitleaksWorkerMessage = Message

const startedMessage = { type: "started" } as const

function parseOutput(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function failedOutput(parsed: Record<string, unknown>): GitleaksWasmResponse {
  return {
    ok: false,
    code: typeof parsed.code === "string" ? parsed.code : "detector-failed",
  }
}

function successfulOutput(parsed: Record<string, unknown>): GitleaksWasmResponse {
  const result = parsed.result
  if (typeof result !== "object" || result === null) return { ok: false, code: "invalid-output" }
  return { ok: true, result: result as GitleaksWasmResult }
}

export function decodeGitleaksWasmOutput(
  stdout: string,
  exitCode: number | null,
): GitleaksWasmResponse {
  if (exitCode !== 0) return { ok: false, code: "worker-exit" }
  const parsed = parseOutput(stdout)
  if (!parsed || typeof parsed.ok !== "boolean") return { ok: false, code: "invalid-output" }
  return parsed.ok ? successfulOutput(parsed) : failedOutput(parsed)
}

function wasiFailure(error: unknown): GitleaksWasmResponse {
  if (error instanceof WasiTrap) {
    return {
      ok: false,
      code: memoryExhausted(error.stderr) === undefined ? "wasi-trap" : "memory-exhausted",
    }
  }
  return { ok: false, code: "detector-failed" }
}

function responseFor({ module, request, root }: Message): GitleaksWasmResponse {
  try {
    // WASI receives an empty, read-only directory. Captured source only crosses stdin.
    const outcome = runFallowModule(module, { op: "gitleaks", root, payload: request })
    return decodeGitleaksWasmOutput(outcome.stdout, outcome.exitCode ?? null)
  } catch (error) {
    return wasiFailure(error)
  }
}

port?.on("message", (message: GitleaksWorkerMessage) => {
  port.postMessage(startedMessage)
  port.postMessage(responseFor(message))
})

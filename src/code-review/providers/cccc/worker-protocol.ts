import type { CcccFileReport, CcccRawFunctionReport, CcccSide, CcccSourceInput } from "./types.ts"

export interface CcccWorkerRequest {
  id: number
  files: readonly CcccSourceInput[]
}

export interface CcccWorkerResponse {
  id: number
  ok: true
  reports: CcccFileReport[]
}

export interface CcccWorkerFailure {
  id: number
  ok: false
  code: "worker-invalid-output" | "analysis-failed"
}

export type CcccWorkerMessage = CcccWorkerResponse | CcccWorkerFailure | { ready: true }

export interface CcccWasmReport {
  path: string
  cognitive: number
  cyclomatic: number
  functions: CcccRawFunctionReport[]
  parse_errors?: string[]
}

export interface CcccWasmFile {
  side: CcccSide
  language: string
  report: CcccWasmReport
}

export interface CcccWasmOutput {
  reports: CcccWasmFile[]
}

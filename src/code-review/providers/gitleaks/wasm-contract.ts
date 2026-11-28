import type { GitleaksChangedFile } from "./contract.ts"

export interface GitleaksWasmSide {
  files: { path: string; content: string }[]
  config: string
  configPresent: boolean
  ignore: string
  configFiles: Record<string, string>
}

export type GitleaksWasmLineRange = [number, number]

export interface GitleaksWasmRequest {
  comparisonID: string
  baseRevision: string
  headRevision: string
  salt: string
  base: GitleaksWasmSide
  head: GitleaksWasmSide
  changedFiles: {
    path: string
    previousPath: string
    status: GitleaksChangedFile["status"]
  }[]
  headChanges: Record<string, GitleaksWasmLineRange[]>
  baseComplete: boolean
  headComplete: boolean
  changesComplete: boolean
}

export interface GitleaksWasmFinding {
  rule: string
  description: string
  location: {
    path: string
    startLine: number
    startCol: number
    endLine: number
    endCol: number
  }
  fingerprint: string
  masked: string
  entropy?: number
}

export interface GitleaksWasmResult {
  comparisonID: string
  baseRevision: string
  headRevision: string
  introduced: GitleaksWasmFinding[]
  unclassified: (GitleaksWasmFinding & { reason: "incomplete-snapshot" })[]
  inline: {
    path: string
    line: number
    matches: { rule: string; fingerprint: string; masked: string }[]
    exact: boolean
  }[]
  allowlist?: {
    files: { path: string; change: "added" | "modified" | "removed" }[]
    added: string[]
    total: number
    leftOut: number
    exact: boolean
  }
}

export type GitleaksWasmResponse =
  { ok: true; result: GitleaksWasmResult } | { ok: false; code: string }

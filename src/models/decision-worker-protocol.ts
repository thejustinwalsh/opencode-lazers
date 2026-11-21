import type { PriceInputs } from "./price-state.ts"

export type DecisionWorkerMethod = "overview" | "rows" | "view" | "candidates"

/**
 * One worker serves every project of a database. Only ids, filters and the few hundred bytes of
 * OpenCode-owned price inputs cross the boundary; the worker reads evidence and history itself.
 */
export type WorkerRequest =
  | {
      type: "call"
      id: number
      projectDirectory: string
      method: DecisionWorkerMethod
      input: unknown
    }
  | { type: "abort"; id: number; reason: string }
  | { type: "price"; requestID: number; inputs?: PriceInputs; error?: string }
  | { type: "close" }

export type WorkerResponse =
  | { type: "result"; id: number; value: unknown }
  | { type: "page"; id: number; rows: unknown }
  | { type: "error"; id: number; message: string }
  | { type: "price"; requestID: number; callID: number }

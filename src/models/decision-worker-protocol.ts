import type { CurrentPriceApplicability } from "./current-price-index.ts"
import type { ModelDecisionPriceState } from "./decision-read.ts"

export type DecisionWorkerMethod = "overview" | "rows" | "configurations" | "inspect"

export type WorkerRequest =
  | { type: "call"; id: number; method: DecisionWorkerMethod; input: unknown }
  | { type: "abort"; id: number; reason: string }
  | { type: "price"; requestID: number; state?: ModelDecisionPriceState; error?: string }
  | { type: "close" }

export type WorkerResponse =
  | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; message: string }
  | {
      type: "price"
      requestID: number
      callID: number
      routes: readonly CurrentPriceApplicability[]
    }

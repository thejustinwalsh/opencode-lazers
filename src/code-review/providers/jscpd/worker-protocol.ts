import type { DuplicationFailureCode } from "./contract.ts"

const FAILURE_CODES: readonly DuplicationFailureCode[] = [
  "analyzer-unavailable",
  "analyzer-memory",
  "analyzer-timeout",
  "invalid-request",
  "worker-failed",
]

export function isDuplicationFailureCode(value: unknown): value is DuplicationFailureCode {
  return typeof value === "string" && FAILURE_CODES.includes(value as DuplicationFailureCode)
}

export function duplicationFailureCode(error: unknown): DuplicationFailureCode {
  if (!(error instanceof Error) || !("code" in error)) return "analyzer-unavailable"
  return isDuplicationFailureCode(error.code) ? error.code : "analyzer-unavailable"
}

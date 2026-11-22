import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

const MAX_RECEIPT_BYTES = 256 * 1024
const SYNTHETIC_FALLOW_COMMAND = "lazers:fallow-audit"

export type CheckReceiptIdentity = {
  state: "missing" | "invalid" | "observed"
  startedAt?: number
  rootPIDs: number[]
  settled: boolean
  reason?: string
}

type ExpectedCheck = {
  id: string
  command: string
  workspace: string
  phaseCommands: readonly string[]
}

type ProcessCleanup = {
  state?: unknown
  capability?: unknown
  rootPID?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function receiptCheck(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if (isRecord(value.check)) return value.check
  if (isRecord(value.result) && isRecord(value.result.check)) return value.result.check
  if (typeof value.command === "string") return value
  return undefined
}

function parseReceiptText(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_RECEIPT_BYTES)
    throw new Error("verification receipt exceeds the inspection limit")
  return JSON.parse(text) as unknown
}

function readReceiptFile(path: string): { kind: "missing" } | { kind: "read"; value: unknown } {
  if (!isAbsolute(path)) throw new Error("verification receipt path is not absolute")
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "missing" }
    throw new Error(`verification receipt could not be inspected: ${errorText(error)}`, {
      cause: error,
    })
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("verification receipt is not a regular file")
  if (stat.size > MAX_RECEIPT_BYTES)
    throw new Error("verification receipt exceeds the inspection limit")
  return { kind: "read", value: parseReceiptText(readFileSync(path, "utf8")) }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function canonicalPath(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function terminalCleanup(value: unknown): value is ProcessCleanup {
  if (!isRecord(value)) return false
  const cleanup = value as ProcessCleanup
  return (
    (cleanup.state === "settled" || cleanup.state === "terminated") &&
    (cleanup.capability === "process-group" || cleanup.capability === "windows-process-tree") &&
    typeof cleanup.rootPID === "number" &&
    Number.isSafeInteger(cleanup.rootPID) &&
    cleanup.rootPID > 0
  )
}

function processPIDs(check: Record<string, unknown>): number[] {
  const cleanups: unknown[] = [check.processCleanup]
  if (Array.isArray(check.phases))
    for (const phase of check.phases) if (isRecord(phase)) cleanups.push(phase.processCleanup)
  return cleanups.flatMap((cleanup) =>
    isRecord(cleanup) &&
    cleanup.state !== "settled" &&
    cleanup.state !== "terminated" &&
    (cleanup.capability === "process-group" || cleanup.capability === "windows-process-tree") &&
    typeof cleanup.rootPID === "number" &&
    Number.isSafeInteger(cleanup.rootPID) &&
    cleanup.rootPID > 0
      ? [cleanup.rootPID]
      : [],
  )
}

function checkIsSettled(check: Record<string, unknown>, expected: ExpectedCheck): boolean {
  if (
    check.id !== expected.id ||
    check.command !== expected.command ||
    typeof check.cwd !== "string" ||
    canonicalPath(check.cwd) !== canonicalPath(expected.workspace) ||
    typeof check.startedAt !== "number" ||
    !Number.isSafeInteger(check.startedAt) ||
    typeof check.endedAt !== "number" ||
    !Number.isSafeInteger(check.endedAt) ||
    check.endedAt < check.startedAt
  )
    return false

  if (expected.command === SYNTHETIC_FALLOW_COMMAND)
    return (
      isRecord(check.fallow) &&
      ["clean", "findings", "unavailable"].includes(String(check.fallow.status))
    )

  if (Array.isArray(check.phases)) {
    if (check.phases.length === 0 || check.phases.length > expected.phaseCommands.length)
      return false
    return check.phases.every(
      (phase, index) =>
        isRecord(phase) &&
        phase.command === expected.phaseCommands[index] &&
        terminalCleanup(phase.processCleanup),
    )
  }
  return terminalCleanup(check.processCleanup)
}

function receiptIdentity(value: unknown, expected: ExpectedCheck): CheckReceiptIdentity {
  const check = receiptCheck(value)
  if (!check) return { state: "invalid", rootPIDs: [], settled: false, reason: "malformed receipt" }
  if (
    check.id !== expected.id ||
    check.command !== expected.command ||
    typeof check.cwd !== "string" ||
    canonicalPath(check.cwd) !== canonicalPath(expected.workspace) ||
    typeof check.startedAt !== "number" ||
    !Number.isSafeInteger(check.startedAt) ||
    check.startedAt < 0
  )
    return {
      state: "invalid",
      rootPIDs: [],
      settled: false,
      reason: "receipt identity does not match the open check",
    }
  return {
    state: "observed",
    startedAt: check.startedAt,
    rootPIDs: processPIDs(check),
    settled: checkIsSettled(check, expected),
  }
}

export function inspectCheckReceipt(input: {
  databaseReceipt: string | null
  receiptPath: string | undefined
  expected: ExpectedCheck
}): CheckReceiptIdentity {
  if (input.receiptPath) {
    const file = readReceiptFile(input.receiptPath)
    if (file.kind === "read") return receiptIdentity(file.value, input.expected)
  }
  if (input.databaseReceipt) {
    try {
      return receiptIdentity(parseReceiptText(input.databaseReceipt), input.expected)
    } catch (error) {
      return {
        state: "invalid",
        rootPIDs: [],
        settled: false,
        reason: errorText(error),
      }
    }
  }
  return { state: "missing", rootPIDs: [], settled: false }
}

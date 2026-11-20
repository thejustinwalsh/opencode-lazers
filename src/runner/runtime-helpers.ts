import { lstatSync } from "node:fs"
import { fingerprint } from "../identity.ts"
import { checkResourcesSettled, type CheckReceipt } from "./artifacts.ts"
import type { EffectRow } from "./store.ts"
import type { VerificationActivity } from "./verification-activities.ts"

export const messageID = () => `msg_${crypto.randomUUID().replaceAll("-", "")}`

export const isCommitID = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const verificationTimingFields = new Set(["timeoutMs", "inactivityTimeoutMs", "hardTimeoutMs"])
const verificationCheckIdentity = (check: unknown): unknown =>
  isRecord(check)
    ? Object.fromEntries(
        Object.entries(check).filter(([key]) => !verificationTimingFields.has(key)),
      )
    : check
export const sameVerificationCheckIdentity = (left: unknown, right: unknown): boolean =>
  fingerprint(verificationCheckIdentity(left)) === fingerprint(verificationCheckIdentity(right))

export function actualCheckResultFromEffect(effect: EffectRow): CheckReceipt | undefined {
  if (!effect.receipt) return undefined
  try {
    const envelope: unknown = JSON.parse(effect.receipt)
    if (!isRecord(envelope)) return undefined
    if (isRecord(envelope.check)) return envelope.check as unknown as CheckReceipt
    if (isRecord(envelope.result) && isRecord(envelope.result.check))
      return envelope.result.check as unknown as CheckReceipt
    return undefined
  } catch {
    return undefined
  }
}

export function checkSettlementProblem(activity: VerificationActivity): string | undefined {
  if (activity.state === "failed") return errorText(activity.error)
  if (activity.state !== "completed") return "Verification is still running"
  if (activity.metadata.kind === "retained-advance") return undefined
  const receipt = activity.result as CheckReceipt | undefined
  if (!receipt) return "Verification has no final receipt"
  if (!checkResourcesSettled(receipt))
    return `Command exited ${receipt.exitCode ?? "unknown"} with timedOut=${receipt.timedOut}; subprocess cleanup remains uncertain: ${receipt.processCleanup?.detail ?? "process-tree settlement was not confirmed"}`
  return undefined
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message || String(error) : String(error)

export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false
    throw error
  }
}

export const WORKTREE_CLEANUP_FALLBACK_MS = 60_000
/** A live-activity blocker (running shell, busy session) is cheap to re-observe. */
export const WORKTREE_CLEANUP_LIVE_RETRY_MS = 5_000

/** Verification effects only read the candidate; a missing receipt means run the check again. */
export function isRerunnableEffect(kind: string): boolean {
  return kind.startsWith("verify:") || kind.startsWith("graph-verify:") || kind === "mechanical-fix"
}

export type StartupRecoveryAuthorization = {
  schema: "lazers-worktree-startup-authorization/v1"
  recoveryID: string
  sourceEffectID: string
  settlementRequestID: string
  requestID: string
  owner: string
  planVersion: number
  planRevision: number
  taskID: string
  attemptID: string
  sessionID: string
  messageID: string
  workspace: string
  base: string
  policy: string
}

export type WorkerObservationFence = {
  planID: string
  planVersion: number
  planState: string
  owner: string
  reconcileRequestID: number
  taskID: string
  attemptID: string
  attemptState: string
  sessionID: string
  workspace: string
  messageID: string
  policy: string
  nodeState: string
  nodeVersion: number
}

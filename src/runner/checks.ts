import { join, dirname, isAbsolute, basename } from "node:path"
import type { CheckReceipt } from "./artifacts.ts"

/** Desktop services may start without the user's package-manager directory on PATH. */
export function checkEnvironment(environment: Record<string, string | undefined> = process.env) {
  const result = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  if (Bun.which("bun", { PATH: result.PATH ?? "" })) return result
  const candidates = [
    result.BUN_INSTALL && join(result.BUN_INSTALL, "bin"),
    result.HOME && join(result.HOME, ".bun", "bin"),
    /^(?:bun|bun.exe)$/.test(basename(process.execPath)) && dirname(process.execPath),
  ]
  for (const directory of candidates) {
    if (!directory || !isAbsolute(directory)) continue
    const executable = Bun.which("bun", { PATH: directory })
    if (!executable) continue
    result.PATH = [dirname(executable), result.PATH].filter(Boolean).join(":")
    break
  }
  return result
}

/** Command outcomes establish checks. Workspace and environment metadata are diagnostics. */
export function checkSucceeded(
  receipt: Pick<CheckReceipt, "exitCode" | "timedOut"> &
    Partial<Pick<CheckReceipt, "phasesComplete" | "aborted">>,
) {
  return (
    receipt.exitCode === 0 &&
    !receipt.timedOut &&
    !receipt.aborted &&
    receipt.phasesComplete !== false
  )
}

/** A retryable interruption is distinct from a completed test failure or timeout. */
export function isConclusiveNonTimeoutInterruption(receipt: CheckReceipt): boolean {
  const processSettled = (cleanup: CheckReceipt["processCleanup"] | undefined) =>
    Boolean(
      cleanup &&
      cleanup.state !== "uncertain" &&
      cleanup.capability !== "direct-child" &&
      Number.isSafeInteger(cleanup.rootPID) &&
      cleanup.rootPID! > 0,
    )
  const phases = receipt.phases
  const interruptedPhase = phases?.at(-1)
  return Boolean(
    receipt.aborted === true &&
    receipt.timedOut === false &&
    receipt.stopCause === "cancelled" &&
    receipt.phasesComplete === false &&
    phases?.length &&
    processSettled(receipt.processCleanup) &&
    phases.every((phase) => processSettled(phase.processCleanup)) &&
    phases
      .slice(0, -1)
      .every(
        (phase) =>
          phase.exitCode === 0 &&
          phase.timedOut === false &&
          phase.aborted !== true &&
          phase.stopCause == null,
      ) &&
    interruptedPhase?.aborted === true &&
    interruptedPhase.timedOut === false &&
    interruptedPhase.stopCause === "cancelled" &&
    interruptedPhase.exitCode === receipt.exitCode,
  )
}

export function checkFailureReason(receipt: CheckReceipt) {
  if (receipt.aborted) return `Verification ${receipt.id} was interrupted before completion`
  if (receipt.phasesComplete === false && receipt.exitCode === 0 && !receipt.timedOut)
    return `Verification ${receipt.id} did not complete every declared phase`
  if (receipt.timedOut) return `Verification ${receipt.id} timed out`
  if (receipt.exitCode === 126 || receipt.exitCode === 127)
    return `Verification ${receipt.id} could not start: ${receipt.stderr.trim().split("\n")[0] || `exit ${receipt.exitCode}`}`
  return `Verification ${receipt.id} exited with code ${receipt.exitCode ?? "unknown"}`
}

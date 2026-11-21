import { join, dirname, isAbsolute, basename, delimiter } from "node:path"
import { toolchainFacts } from "../projects/toolchains.ts"
import type { RunnerCheckReceipt } from "./artifacts.ts"

/** Desktop services may start without the user's package-manager directory on PATH. */
export function checkEnvironment(
  environment: Record<string, string | undefined> = process.env,
  toolchains?: readonly string[],
) {
  const result = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  // A project with a profile names its toolchains; Bun is not assumed.
  if (toolchains !== undefined) {
    for (const name of toolchains) {
      const facts = toolchainFacts(name)
      if (Bun.which(facts.executable, { PATH: result.PATH ?? "" })) continue
      const found = locateTool(facts.executable, facts.homes(result, process.execPath), result)
      if (found.path)
        result.PATH = [dirname(found.path), result.PATH].filter(Boolean).join(delimiter)
    }
    return result
  }
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

/** Searches PATH, then the toolchain's known homes; `searched` lists every directory tried. */
function locateTool(
  executable: string,
  homes: readonly string[],
  environment: Record<string, string>,
): { path?: string; searched: string[] } {
  const searched = [...(environment.PATH ?? "").split(delimiter).filter(Boolean), ...homes]
  for (const directory of searched) {
    const path = Bun.which(executable, { PATH: directory })
    if (path) return { path, searched }
  }
  return { searched }
}

/** Command outcomes establish checks. Workspace and environment metadata are diagnostics. */
export function checkSucceeded(
  receipt: Pick<RunnerCheckReceipt, "exitCode" | "timedOut"> &
    Partial<Pick<RunnerCheckReceipt, "phasesComplete" | "aborted">>,
) {
  return (
    receipt.exitCode === 0 &&
    !receipt.timedOut &&
    !receipt.aborted &&
    receipt.phasesComplete !== false
  )
}

/** A retryable interruption is distinct from a completed test failure or timeout. */
export function isConclusiveNonTimeoutInterruption(receipt: RunnerCheckReceipt): boolean {
  const processSettled = (cleanup: RunnerCheckReceipt["processCleanup"] | undefined) =>
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

export function checkFailureReason(receipt: RunnerCheckReceipt) {
  if (receipt.aborted) return `Verification ${receipt.id} was interrupted before completion`
  if (receipt.phasesComplete === false && receipt.exitCode === 0 && !receipt.timedOut)
    return `Verification ${receipt.id} did not complete every declared phase`
  if (receipt.timedOut) return `Verification ${receipt.id} timed out`
  if (receipt.exitCode === 126 || receipt.exitCode === 127)
    return `Verification ${receipt.id} could not start: ${receipt.stderr.trim().split("\n")[0] || `exit ${receipt.exitCode}`}`
  return `Verification ${receipt.id} exited with code ${receipt.exitCode ?? "unknown"}`
}

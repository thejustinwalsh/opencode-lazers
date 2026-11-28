import { checkResourcesSettled } from "../artifacts.ts"
import type { RunnerCheckReceipt } from "../artifacts.ts"
import type { EffectRow } from "../store.ts"

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRecord(value: string | null): JsonRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value ?? "null")
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function receiptCheck(value: unknown, depth = 0): unknown {
  if (depth > 8 || !isRecord(value)) return undefined
  if ("check" in value) return value.check
  const nested = receiptCheckResult(value.result, depth + 1)
  if (nested !== undefined) return nested
  if (value.superseded === true && "previous" in value)
    return receiptCheck(value.previous, depth + 1)
  return undefined
}

function receiptCheckResult(value: unknown, depth: number): unknown {
  if (!isRecord(value)) return undefined
  const nested = receiptCheck(value, depth)
  if (nested !== undefined) return nested
  return "id" in value && "inputIdentity" in value ? value : undefined
}

function validCleanup(cleanup: unknown): boolean {
  if (cleanup === undefined) return true
  if (!isRecord(cleanup)) return false
  return (
    ["settled", "terminated", "uncertain"].includes(String(cleanup.state)) &&
    ["process-group", "windows-process-tree", "direct-child"].includes(
      String(cleanup.capability),
    ) &&
    (cleanup.rootPID === undefined || Number.isSafeInteger(cleanup.rootPID)) &&
    (cleanup.detail === undefined || typeof cleanup.detail === "string")
  )
}

function validStopCause(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    ["inactivity", "hard-backstop", "cancelled"].includes(String(value))
  )
}

function validOptionalCommand(value: JsonRecord): boolean {
  if (
    typeof value.command !== "string" ||
    (value.effectiveCommand !== undefined && typeof value.effectiveCommand !== "string")
  )
    return false
  return true
}

function validPhaseResult(value: JsonRecord): boolean {
  return (
    (value.exitCode === null || typeof value.exitCode === "number") &&
    typeof value.timedOut === "boolean" &&
    validStopCause(value.stopCause) &&
    (value.aborted === undefined || typeof value.aborted === "boolean")
  )
}

function validPhaseOutput(value: JsonRecord): boolean {
  return (
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.environmentIdentity === "string" &&
    validCleanup(value.processCleanup)
  )
}

function validPhase(value: unknown): boolean {
  return (
    isRecord(value) &&
    validOptionalCommand(value) &&
    validPhaseResult(value) &&
    validPhaseOutput(value)
  )
}

function validReceiptIdentity(value: JsonRecord): boolean {
  return (
    typeof value.id === "string" &&
    validOptionalCommand(value) &&
    typeof value.cwd === "string" &&
    typeof value.artifact === "string" &&
    typeof value.inputIdentity === "string" &&
    typeof value.environmentIdentity === "string"
  )
}

function validReceiptResult(value: JsonRecord): boolean {
  return (
    Number.isFinite(value.startedAt) &&
    Number.isFinite(value.endedAt) &&
    (value.exitCode === null || typeof value.exitCode === "number") &&
    typeof value.timedOut === "boolean" &&
    validStopCause(value.stopCause) &&
    (value.aborted === undefined || typeof value.aborted === "boolean")
  )
}

function validReceiptOutput(value: JsonRecord): boolean {
  return (
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    validCleanup(value.processCleanup)
  )
}

function validReceiptPhases(value: JsonRecord): boolean {
  return (
    value.phases === undefined || (Array.isArray(value.phases) && value.phases.every(validPhase))
  )
}

function isCheckReceipt(value: unknown): value is RunnerCheckReceipt {
  if (!isRecord(value)) return false
  if (
    !validReceiptIdentity(value) ||
    !validReceiptResult(value) ||
    !validReceiptOutput(value) ||
    !validReceiptPhases(value)
  )
    return false
  return checkResourcesSettled(value as unknown as RunnerCheckReceipt)
}

function graphCreationSources(effects: EffectRow[], workspace: string): EffectRow[] {
  return effects.filter(
    (effect) =>
      effect.kind === "graph-worktree" &&
      effect.state === "completed" &&
      parseRecord(effect.receipt)?.workspace === workspace,
  )
}

function validCreationWorkspace(
  payload: JsonRecord,
  receipt: JsonRecord,
  workspace: string,
): boolean {
  return (
    typeof payload.workspace === "string" &&
    payload.workspace.length > 0 &&
    payload.workspace === workspace &&
    receipt.workspace === workspace
  )
}

function validCreationBase(
  payload: JsonRecord,
  receipt: JsonRecord,
): payload is JsonRecord & {
  base: string
} {
  return (
    typeof payload.base === "string" && payload.base.length > 0 && receipt.base === payload.base
  )
}

function graphCreationArtifact(effects: EffectRow[], workspace: string): string {
  const sources = graphCreationSources(effects, workspace)
  if (sources.length !== 1)
    throw new Error("Combined worktree creation evidence is missing or ambiguous; preserve it")

  const source = sources[0]!
  const payload = parseRecord(source.payload)
  const receipt = parseRecord(source.receipt)
  if (!payload || !receipt || !validCreationWorkspace(payload, receipt, workspace))
    throw new Error("Combined worktree creation evidence is malformed; preserve it")
  if (!validCreationBase(payload, receipt))
    throw new Error("Combined worktree creation evidence is malformed; preserve it")
  return payload.base
}

type GraphCheck = { id: string; command: string }

function isGraphCheckEffect(
  effect: EffectRow,
  payload: JsonRecord,
  workspace: string,
  artifact: string,
): payload is JsonRecord & { check: GraphCheck } {
  const check = payload.check
  return (
    payload.workspace === workspace &&
    payload.artifact === artifact &&
    isRecord(check) &&
    typeof check.id === "string" &&
    typeof check.command === "string" &&
    effect.kind === `graph-verify:${check.id}` &&
    ["completed", "uncertain", "failed"].includes(effect.state)
  )
}

function isReceiptForGraphCheck(
  receipt: unknown,
  check: GraphCheck,
  workspace: string,
  artifact: string,
): receipt is RunnerCheckReceipt {
  return (
    isCheckReceipt(receipt) &&
    receipt.id === check.id &&
    receipt.command === check.command &&
    receipt.cwd === workspace &&
    receipt.artifact === artifact &&
    receipt.inputIdentity === artifact
  )
}

function assertSettledWorkspaceCheck(effect: EffectRow, workspace: string, artifact: string) {
  const payload = parseRecord(effect.payload)
  if (!payload || !isGraphCheckEffect(effect, payload, workspace, artifact))
    throw new Error("Combined worktree check activity is not conclusively complete; preserve it")

  const recorded = parseRecord(effect.receipt)
  const receipt = receiptCheck(recorded)
  if (!isReceiptForGraphCheck(receipt, payload.check, workspace, artifact))
    throw new Error("Combined worktree check activity is not conclusively complete; preserve it")
}

function assertOtherWorkspaceCheckIsNotForWorkspace(effect: EffectRow, workspace: string) {
  const receipt = receiptCheck(parseRecord(effect.receipt))
  if (isRecord(receipt) && receipt.cwd === workspace)
    throw new Error("Combined worktree check activity is not conclusively complete; preserve it")
}

/** Check the durable activity owned by one graph workspace, independent of the plan's newest candidate. */
export function assertGraphWorkspaceQuiescent(effects: EffectRow[], workspace: string): void {
  const artifact = graphCreationArtifact(effects, workspace)
  for (const effect of effects) {
    if (!effect.kind.startsWith("graph-verify:")) continue
    const payload = parseRecord(effect.payload)
    if (!payload || typeof payload.workspace !== "string" || payload.workspace.length === 0)
      throw new Error("Combined worktree check ownership is ambiguous; preserve the workspace")
    if (payload.workspace !== workspace) {
      assertOtherWorkspaceCheckIsNotForWorkspace(effect, workspace)
      continue
    }
    assertSettledWorkspaceCheck(effect, workspace, artifact)
  }
}

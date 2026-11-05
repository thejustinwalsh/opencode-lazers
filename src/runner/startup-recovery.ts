import { basename, isAbsolute, resolve } from "node:path"
import { AbsolutePath } from "@opencode/schema/schema"
import { Worktree } from "@opencode/schema/worktree"
import { Schema } from "effect"

const DirectoryUnavailableErrorShape = Schema.Struct({
  _tag: Schema.Literal("Worktree.DirectoryUnavailableError"),
  directory: AbsolutePath,
})

type NativeWorktreeOperationFailureEvidence = {
  schema: "lazers-native-worktree-failure/v2"
  api: "worktree.create"
  nativeTag: "Worktree.OperationError"
  message: string
  forceRequired?: boolean
}

type NativeWorktreeDirectoryFailureEvidence = {
  schema: "lazers-native-worktree-failure/v2"
  api: "worktree.create"
  nativeTag: "Worktree.DirectoryUnavailableError"
  directory: string
}

export type NativeWorktreeFailureEvidence =
  NativeWorktreeOperationFailureEvidence | NativeWorktreeDirectoryFailureEvidence

const legacyDirectoryUnavailableReceipt = '{"error":"Worktree.DirectoryUnavailableError"}'
export const UNCERTAIN_EFFECT_RECEIPT_SCHEMA = "lazers-effect-uncertain-receipt/v1" as const

export type LegacyStartupFailureEvidence = {
  schema: "lazers-worktree-startup-legacy-failure/v1"
  classification: "legacy-error-only-inference"
  errorText: "Worktree.DirectoryUnavailableError"
  rawReceipt: string
  provenance: {
    kind: "legacy-untyped-error-inference"
    nativeErrorIdentity: "unknown"
    sourceFile: "src/runner/runtime.ts"
    writer: "TaskRuntime.uncertain"
    projection: "JSON.stringify({ error: errorText(error) })"
  }
  binding: {
    planID: string
    taskID: string
    attemptID: string
    effectID: string
    sessionID: string
    messageID: string
    workspace: string
    base: string
  }
}

export type StartupWorktreeFailureEvidence =
  | { kind: "native-typed-failure"; nativeFailure: NativeWorktreeFailureEvidence }
  | { kind: "legacy-error-only-inference"; legacyFailure: LegacyStartupFailureEvidence }

type StartupAbsenceEvidenceBase = {
  kind: "worktree-startup-failure-settled-absent"
  schema: "lazers-worktree-startup-settlement/v1"
  requestID: string
  planID: string
  taskID: string
  attemptID: string
  effectID: string
  sessionID: string
  workspace: string
  base: string
  observedAt: number
  observations: {
    candidates: string[]
    nativeAbsent: true
    gitAbsent: true
    filesystemAbsent: true
    sessionAbsent: true
  }
}

export type StartupAbsenceEvidence = StartupAbsenceEvidenceBase &
  (
    | { nativeFailure: NativeWorktreeFailureEvidence; legacyFailure?: never }
    | { legacyFailure: LegacyStartupFailureEvidence; nativeFailure?: never }
  )

export class NativeWorktreeCreationFailure extends Error {
  readonly evidence: NativeWorktreeFailureEvidence

  constructor(evidence: NativeWorktreeFailureEvidence) {
    const detail =
      evidence.nativeTag === "Worktree.OperationError"
        ? evidence.message
        : `Unavailable directory ${evidence.directory}`
    super(`${evidence.nativeTag}: ${detail}`)
    this.name = "NativeWorktreeCreationFailure"
    this.evidence = evidence
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined

function validNativeFailure(value: unknown): value is NativeWorktreeFailureEvidence {
  const candidate = record(value)
  if (
    candidate?.schema !== "lazers-native-worktree-failure/v2" ||
    candidate.api !== "worktree.create"
  )
    return false
  if (candidate.nativeTag === "Worktree.OperationError")
    return (
      typeof candidate.message === "string" &&
      candidate.message.length > 0 &&
      (candidate.forceRequired === undefined || typeof candidate.forceRequired === "boolean")
    )
  return (
    candidate.nativeTag === "Worktree.DirectoryUnavailableError" &&
    typeof candidate.directory === "string" &&
    candidate.directory.length > 0 &&
    isAbsolute(candidate.directory)
  )
}

function validLegacyStartupFailure(value: unknown): value is LegacyStartupFailureEvidence {
  const candidate = record(value)
  const provenance = record(candidate?.provenance)
  const binding = record(candidate?.binding)
  if (
    candidate?.schema !== "lazers-worktree-startup-legacy-failure/v1" ||
    candidate.classification !== "legacy-error-only-inference" ||
    candidate.errorText !== "Worktree.DirectoryUnavailableError" ||
    typeof candidate.rawReceipt !== "string" ||
    candidate.rawReceipt !== legacyDirectoryUnavailableReceipt ||
    "nativeFailure" in candidate ||
    "directory" in candidate ||
    provenance?.kind !== "legacy-untyped-error-inference" ||
    provenance.nativeErrorIdentity !== "unknown" ||
    provenance.sourceFile !== "src/runner/runtime.ts" ||
    provenance.writer !== "TaskRuntime.uncertain" ||
    provenance.projection !== "JSON.stringify({ error: errorText(error) })" ||
    !binding ||
    typeof binding.planID !== "string" ||
    typeof binding.taskID !== "string" ||
    typeof binding.attemptID !== "string" ||
    typeof binding.effectID !== "string" ||
    typeof binding.sessionID !== "string" ||
    typeof binding.messageID !== "string" ||
    typeof binding.workspace !== "string" ||
    typeof binding.base !== "string" ||
    !binding.planID ||
    !binding.taskID ||
    !binding.attemptID ||
    !binding.effectID ||
    !binding.sessionID ||
    !binding.messageID ||
    !isAbsolute(binding.workspace) ||
    basename(resolve(binding.workspace)) !== binding.attemptID ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(binding.base)
  )
    return false
  return true
}

/**
 * Classify typed failures as native evidence and the exact historical
 * error-only shape as an inference bound to its current runtime records.
 */
export function startupWorktreeFailureEvidence(input: {
  planID: string
  taskID: string
  attemptID: string
  effectID: string
  kind: string
  state: string
  receipt: string | null
  payload: string
  sessionID: string
  messageID: string
  workspace: string
  base: string
}): StartupWorktreeFailureEvidence | undefined {
  let payload: Record<string, unknown> | undefined
  try {
    payload = record(JSON.parse(input.payload))
  } catch {
    return undefined
  }
  const payloadMatches =
    input.kind === "worktree"
      ? input.payload === JSON.stringify({ workspace: input.workspace, base: input.base })
      : input.kind === "worktree-recovery" &&
        payload?.schema === "lazers-worktree-recovery-operation/v1" &&
        payload.workspace === input.workspace &&
        payload.base === input.base
  if (!payloadMatches || input.state !== "uncertain") return undefined
  const nativeFailure = nativeWorktreeFailureFromReceipt(input.receipt)
  if (nativeFailure) return { kind: "native-typed-failure", nativeFailure }

  let rawReceipt: string | undefined
  try {
    const parsed = input.receipt ? record(JSON.parse(input.receipt)) : undefined
    if (
      parsed &&
      Object.keys(parsed).length === 1 &&
      parsed.error === "Worktree.DirectoryUnavailableError" &&
      JSON.stringify(parsed) === input.receipt
    )
      rawReceipt = input.receipt
  } catch {
    return undefined
  }
  if (
    input.kind !== "worktree" ||
    !rawReceipt ||
    !isAbsolute(input.workspace) ||
    basename(resolve(input.workspace)) !== input.attemptID ||
    !input.planID ||
    !input.taskID ||
    !input.attemptID ||
    !input.effectID ||
    !input.sessionID ||
    !input.messageID
  )
    return undefined

  return {
    kind: "legacy-error-only-inference",
    legacyFailure: {
      schema: "lazers-worktree-startup-legacy-failure/v1",
      classification: "legacy-error-only-inference",
      errorText: "Worktree.DirectoryUnavailableError",
      rawReceipt,
      provenance: {
        kind: "legacy-untyped-error-inference",
        nativeErrorIdentity: "unknown",
        sourceFile: "src/runner/runtime.ts",
        writer: "TaskRuntime.uncertain",
        projection: "JSON.stringify({ error: errorText(error) })",
      },
      binding: {
        planID: input.planID,
        taskID: input.taskID,
        attemptID: input.attemptID,
        effectID: input.effectID,
        sessionID: input.sessionID,
        messageID: input.messageID,
        workspace: input.workspace,
        base: input.base,
      },
    },
  }
}

/** Recognize only the pinned public worktree API's typed terminal failure. */
export function nativeWorktreeFailureEvidence(
  error: unknown,
): NativeWorktreeFailureEvidence | undefined {
  if (error instanceof NativeWorktreeCreationFailure)
    return validNativeFailure(error.evidence) ? error.evidence : undefined

  if (error instanceof Error && Schema.is(Worktree.OperationError)(error)) {
    const nativeError = error as Worktree.OperationError
    return {
      schema: "lazers-native-worktree-failure/v2",
      api: "worktree.create",
      nativeTag: "Worktree.OperationError",
      message: nativeError.message,
      ...(typeof nativeError.forceRequired === "boolean"
        ? { forceRequired: nativeError.forceRequired }
        : {}),
    }
  }

  // DirectoryUnavailableError is a public core failure but is not re-exported
  // by the plugin package. Validate its pinned tagged payload structurally
  // because separately loaded plugin/core copies have distinct constructors.
  if (
    error instanceof Error &&
    Schema.is(DirectoryUnavailableErrorShape)(error) &&
    isAbsolute(error.directory)
  )
    return {
      schema: "lazers-native-worktree-failure/v2",
      api: "worktree.create",
      nativeTag: "Worktree.DirectoryUnavailableError",
      directory: error.directory,
    }
  return undefined
}

export function nativeWorktreeFailureFromReceipt(
  receipt: string | null,
): NativeWorktreeFailureEvidence | undefined {
  if (!receipt) return undefined
  try {
    const parsed = record(JSON.parse(receipt))
    return validNativeFailure(parsed?.nativeFailure) ? parsed.nativeFailure : undefined
  } catch {
    return undefined
  }
}

/** The native Git strategy may choose one of the documented collision suffixes. */
export function startupWorktreeCandidates(workspace: string): string[] {
  const intended = resolve(workspace)
  return [intended, ...Array.from({ length: 9 }, (_, index) => `${intended}-${index + 2}`)]
}

export function isStartupWorktreeCandidate(workspace: string, candidate: string): boolean {
  const normalized = resolve(candidate)
  return startupWorktreeCandidates(workspace).some((path) => resolve(path) === normalized)
}

export function startupFailureSettlementFromReceipt(
  receipt: string | null,
): StartupAbsenceEvidence | undefined {
  if (!receipt) return undefined
  try {
    const parsed = record(JSON.parse(receipt))
    const history = parsed?.history
    if (!Array.isArray(history)) return undefined
    const settlement = history
      .map(record)
      .find(
        (entry) =>
          entry?.kind === "worktree-startup-failure-settled-absent" &&
          entry.schema === "lazers-worktree-startup-settlement/v1",
      )
    if (
      !settlement ||
      typeof settlement.requestID !== "string" ||
      typeof settlement.planID !== "string" ||
      typeof settlement.taskID !== "string" ||
      typeof settlement.attemptID !== "string" ||
      typeof settlement.effectID !== "string" ||
      typeof settlement.sessionID !== "string" ||
      typeof settlement.workspace !== "string" ||
      typeof settlement.base !== "string" ||
      typeof settlement.observedAt !== "number"
    )
      return undefined
    const nativeFailure = validNativeFailure(settlement.nativeFailure)
      ? settlement.nativeFailure
      : undefined
    const legacyFailure = validLegacyStartupFailure(settlement.legacyFailure)
      ? settlement.legacyFailure
      : undefined
    const hasNativeFailure = Object.hasOwn(settlement, "nativeFailure")
    const hasLegacyFailure = Object.hasOwn(settlement, "legacyFailure")
    if (
      (nativeFailure && (!hasNativeFailure || hasLegacyFailure)) ||
      (!nativeFailure &&
        (!legacyFailure ||
          hasNativeFailure ||
          !hasLegacyFailure ||
          history.length !== 2 ||
          JSON.stringify(record(history[0])) !== legacyFailure.rawReceipt ||
          parsed?.error !== legacyFailure.errorText ||
          Object.keys(parsed ?? {})
            .sort()
            .join(",") !== "error,history" ||
          Boolean(parsed && ("nativeFailure" in parsed || "directory" in parsed)) ||
          legacyFailure.binding.planID !== settlement.planID ||
          legacyFailure.binding.taskID !== settlement.taskID ||
          legacyFailure.binding.attemptID !== settlement.attemptID ||
          legacyFailure.binding.effectID !== settlement.effectID ||
          legacyFailure.binding.sessionID !== settlement.sessionID ||
          legacyFailure.binding.workspace !== settlement.workspace ||
          legacyFailure.binding.base !== settlement.base))
    )
      return undefined
    const observations = record(settlement.observations)
    if (
      !observations ||
      !Array.isArray(observations.candidates) ||
      !observations.candidates.every((path) => typeof path === "string") ||
      JSON.stringify(observations.candidates) !==
        JSON.stringify(startupWorktreeCandidates(settlement.workspace)) ||
      observations.nativeAbsent !== true ||
      observations.gitAbsent !== true ||
      observations.filesystemAbsent !== true ||
      observations.sessionAbsent !== true
    )
      return undefined
    if (nativeFailure)
      return { ...(settlement as unknown as StartupAbsenceEvidenceBase), nativeFailure }
    return {
      ...(settlement as unknown as StartupAbsenceEvidenceBase),
      legacyFailure: legacyFailure!,
    }
  } catch {
    return undefined
  }
}

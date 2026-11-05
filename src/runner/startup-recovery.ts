import { isAbsolute, resolve } from "node:path"
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

export type StartupAbsenceEvidence = {
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
  nativeFailure: NativeWorktreeFailureEvidence
  observations: {
    candidates: string[]
    nativeAbsent: true
    gitAbsent: true
    filesystemAbsent: true
    sessionAbsent: true
  }
}

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
      typeof settlement.observedAt !== "number" ||
      !validNativeFailure(settlement.nativeFailure)
    )
      return undefined
    const observations = record(settlement.observations)
    if (
      !observations ||
      !Array.isArray(observations.candidates) ||
      !observations.candidates.every((path) => typeof path === "string") ||
      observations.nativeAbsent !== true ||
      observations.gitAbsent !== true ||
      observations.filesystemAbsent !== true ||
      observations.sessionAbsent !== true
    )
      return undefined
    return settlement as unknown as StartupAbsenceEvidence
  } catch {
    return undefined
  }
}

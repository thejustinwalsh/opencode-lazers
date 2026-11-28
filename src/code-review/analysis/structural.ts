import { fingerprint } from "../../identity.ts"
import {
  CodeReviewStructuralResultSchema,
  type CodeReviewStructuralInput,
  type CodeReviewStructuralResult,
  type CodeReviewSourceIdentity,
} from "../contract.ts"
import { isConfidentialSourcePath } from "../comparisons/git.ts"
import { StructuralSourceReadError, type CodeReviewResolver } from "../comparisons/resolver.ts"
import type { StoredCodeReviewFile } from "../comparisons/store.ts"
import { DIFFTASTIC_VERSION } from "../structural/contract.ts"
import { createStructuralDiffService } from "../structural/service.ts"

type StoredComparison = NonNullable<ReturnType<CodeReviewResolver["store"]["comparison"]>>

type PinnedSide = {
  side: "base" | "head" | "staged" | "unstaged" | "untracked"
  path: string
  file: StoredCodeReviewFile
  source: CodeReviewSourceIdentity | null
}

type StructuralSourcePair =
  | { baseText: string | null; headText: string | null }
  | { reason: NonNullable<CodeReviewStructuralResult["reason"]> }

function requireComparison(resolver: CodeReviewResolver, comparisonID: string): StoredComparison {
  const comparison = resolver.store.comparison(comparisonID)
  if (!comparison || comparison.identity.projectID !== resolver.projectID)
    throw new Error("Comparison is unavailable in this project")
  return comparison
}

function pinnedSide(
  resolver: CodeReviewResolver,
  comparison: StoredComparison,
  side: PinnedSide["side"],
  path: string,
): PinnedSide {
  const file = resolver.store.file(comparison.identity.comparisonID, side, path)
  if (!file) throw new Error(`Path is not present on the selected ${side} side`)
  return {
    side,
    path,
    file,
    source:
      file.kind === "absent" || !file.objectID
        ? null
        : resolver.sourceIdentity(comparison, side, path),
  }
}

function selectedSides(
  resolver: CodeReviewResolver,
  comparison: StoredComparison,
  input: Pick<CodeReviewStructuralInput, "path" | "previousPath" | "baseSide" | "headSide">,
) {
  const baseSide = input.baseSide ?? "base"
  const headSide = input.headSide ?? "head"
  if (!comparison.sides.includes(baseSide) || !comparison.sides.includes(headSide))
    throw new Error("Selected side is unavailable in this comparison")
  return {
    base: pinnedSide(resolver, comparison, baseSide, input.previousPath ?? input.path),
    head: pinnedSide(resolver, comparison, headSide, input.path),
  }
}

function sourceReference(side: PinnedSide) {
  return {
    side: side.side,
    path: side.path,
    kind: side.file.kind,
    mode: side.file.mode,
    objectID: side.file.objectID,
    size: side.file.size,
    status: side.file.status,
    source: side.source,
  }
}

function unavailable(
  comparison: StoredComparison,
  sourceID: string,
  baseSource: CodeReviewSourceIdentity | null,
  headSource: CodeReviewSourceIdentity | null,
  reason: NonNullable<CodeReviewStructuralResult["reason"]>,
): CodeReviewStructuralResult {
  return CodeReviewStructuralResultSchema.parse({
    comparison: comparison.identity,
    sourceID,
    baseSource,
    headSource,
    status: "unavailable",
    diff: null,
    reason,
  })
}

function unsupportedFileReason(file: StoredCodeReviewFile) {
  if (file.kind === "binary") return "binary" as const
  if (file.kind === "absent" || file.kind === "text" || file.kind === "unknown") return null
  return "unsupported-kind" as const
}

function unsupportedReason(base: PinnedSide, head: PinnedSide) {
  if (isConfidentialSourcePath(base.path) || isConfidentialSourcePath(head.path))
    return "confidential" as const
  const baseReason = unsupportedFileReason(base.file)
  if (baseReason) return baseReason
  const headReason = unsupportedFileReason(head.file)
  if (headReason) return headReason
  return null
}

function sourceUnavailableReason(
  base: PinnedSide,
  head: PinnedSide,
): CodeReviewStructuralResult["reason"] {
  if (base.file.kind === "absent" && head.file.kind === "absent") return "both-absent"
  const unsupported = unsupportedReason(base, head)
  if (unsupported) return unsupported
  if (
    (base.file.kind !== "absent" && !base.source) ||
    (head.file.kind !== "absent" && !head.source)
  )
    return "source-unavailable"
  return null
}

async function readSourcePair(
  resolver: CodeReviewResolver,
  base: PinnedSide,
  head: PinnedSide,
  signal: AbortSignal,
): Promise<StructuralSourcePair> {
  const reads = await Promise.allSettled([
    base.source ? resolver.structuralSourceText(base.source, signal) : Promise.resolve(null),
    head.source ? resolver.structuralSourceText(head.source, signal) : Promise.resolve(null),
  ])
  signal.throwIfAborted()
  const failedRead = reads.find((read): read is PromiseRejectedResult => read.status === "rejected")
  if (failedRead)
    return {
      reason:
        failedRead.reason instanceof StructuralSourceReadError
          ? failedRead.reason.reason
          : "source-unavailable",
    }
  return {
    baseText: reads[0]!.status === "fulfilled" ? reads[0]!.value : null,
    headText: reads[1]!.status === "fulfilled" ? reads[1]!.value : null,
  }
}

/** Resolve one comparison's immutable source pair and run Difftastic without shared cancellation state. */
export async function readStructuralComparison(
  resolver: CodeReviewResolver,
  input: Pick<
    CodeReviewStructuralInput,
    "comparisonID" | "path" | "previousPath" | "baseSide" | "headSide"
  >,
  signal: AbortSignal,
): Promise<CodeReviewStructuralResult> {
  signal.throwIfAborted()
  const comparison = requireComparison(resolver, input.comparisonID)
  const { base, head } = selectedSides(resolver, comparison, input)
  const sourceID = fingerprint({
    comparison: comparison.identity,
    engineVersion: DIFFTASTIC_VERSION,
    base: sourceReference(base),
    head: sourceReference(head),
  })

  const unavailableReason = sourceUnavailableReason(base, head)
  if (unavailableReason)
    return unavailable(comparison, sourceID, base.source, head.source, unavailableReason)
  const sourcePair = await readSourcePair(resolver, base, head, signal)
  if ("reason" in sourcePair)
    return unavailable(comparison, sourceID, base.source, head.source, sourcePair.reason)
  const service = createStructuralDiffService()
  const result = await service.compare(
    {
      identity: { comparisonID: comparison.identity.comparisonID, sourceID },
      request: {
        path: input.path,
        ...(input.previousPath === undefined ? {} : { previousPath: input.previousPath }),
        base: sourcePair.baseText,
        head: sourcePair.headText,
      },
    },
    { signal },
  )
  signal.throwIfAborted()
  if (!result) throw new Error("Structural comparison was superseded")
  return CodeReviewStructuralResultSchema.parse({
    comparison: comparison.identity,
    sourceID,
    baseSource: base.source,
    headSource: head.source,
    status: "ready",
    diff: result.diff,
    reason: null,
  })
}

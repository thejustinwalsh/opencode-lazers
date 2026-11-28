import type {
  StructuralDegradedReason,
  StructuralDiff,
  ValidStructuralCompareRequest,
} from "./contract.ts"
import { projectLineOperations, type LineDiffOperation } from "./line-diff.ts"
import { splitSourceLines } from "./utf-coordinates.ts"

/**
 * Bounded fallback used only when an isolated diff worker cannot start. Matching the common ends
 * preserves useful context without running Myers' edit-distance trace on the project thread.
 */
export function coarseLineDiff(
  request: ValidStructuralCompareRequest,
  degraded: StructuralDegradedReason,
): StructuralDiff {
  const baseLines = splitSourceLines(request.base ?? "")
  const headLines = splitSourceLines(request.head ?? "")
  let prefix = 0
  while (
    prefix < baseLines.length &&
    prefix < headLines.length &&
    baseLines[prefix] === headLines[prefix]
  )
    prefix++

  let suffix = 0
  while (
    suffix < baseLines.length - prefix &&
    suffix < headLines.length - prefix &&
    baseLines[baseLines.length - suffix - 1] === headLines[headLines.length - suffix - 1]
  )
    suffix++

  const operations: LineDiffOperation[] = []
  for (let index = 0; index < prefix; index++) operations.push("equal")

  const baseMiddle = baseLines.length - prefix - suffix
  const headMiddle = headLines.length - prefix - suffix
  for (let index = 0; index < Math.max(baseMiddle, headMiddle); index++) {
    if (index < baseMiddle) operations.push("remove")
    if (index < headMiddle) operations.push("add")
  }

  for (let index = 0; index < suffix; index++) operations.push("equal")
  return projectLineOperations(request, degraded, operations)
}

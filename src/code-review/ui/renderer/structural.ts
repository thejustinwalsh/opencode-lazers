// Ported from Oaink `packages/pierre/src/structural.ts` (the same author's review tool). Pierre renders the
// engine's alignment, changed rows and changed tokens; it computes no diff of its own for a structural file.
import { createStructuralDiff, parseDiffFromFile } from "@pierre/diffs"
import type { FileDiffMetadata, IntraLineRange, StructuralRow } from "@pierre/diffs"
import type { StructuralDiff } from "../../structural/contract.ts"

/** Both texts of one file. `null` is a file absent on that side; `""` is an empty file. */
export interface FileTexts {
  base: string | null
  head: string | null
}

/** Unchanged rows Pierre keeps around a changed row. */
export const CONTEXT_LINES = 3

/**
 * The changed tokens of one line as runs: tokens with nothing or only blanks between them form one
 * run, so a run of changed tokens draws one mark instead of one per token.
 */
export function tokenRuns(
  tokens: readonly { start: number; end: number }[],
  line: string,
): IntraLineRange[] {
  const runs: IntraLineRange[] = []
  for (const { start, end } of [...tokens].sort((a, b) => a.start - b.start)) {
    const last = runs.at(-1)
    if (last && (start < last.end || /^[ \t]*$/.test(line.slice(last.end, start))))
      last.end = Math.max(last.end, end)
    else runs.push({ start, end })
  }
  return runs
}

/**
 * Pierre metadata for one file, built only from the engine's structural diff. A created or deleted
 * file has changed lines and no token marks: a mark on every token says nothing, so one-sided files
 * keep the theme's full syntax colors.
 */
export function toPierreDiff(
  diff: StructuralDiff,
  texts: FileTexts,
  contextLines = CONTEXT_LINES,
): FileDiffMetadata {
  const rows: StructuralRow[] = diff.alignedLines.map(([base, head]) => [
    base === null ? null : base - 1,
    head === null ? null : head - 1,
  ])
  const changedDeletionLines = new Set<number>()
  const changedAdditionLines = new Set<number>()
  const deletions: Record<number, IntraLineRange[]> = {}
  const additions: Record<number, IntraLineRange[]> = {}
  const baseLines = (texts.base ?? "").split("\n")
  const headLines = (texts.head ?? "").split("\n")
  const oneSided = diff.status === "created" || diff.status === "deleted"
  if (oneSided)
    for (const [base, head] of diff.alignedLines) {
      if (base !== null) changedDeletionLines.add(base - 1)
      if (head !== null) changedAdditionLines.add(head - 1)
    }
  for (const row of oneSided ? [] : diff.hunks.flat()) {
    // A paired row is changed on both sides even when only one side has changed tokens.
    if (row.base) {
      changedDeletionLines.add(row.base.line - 1)
      if (row.base.tokens.length > 0)
        deletions[row.base.line - 1] = tokenRuns(
          row.base.tokens,
          baseLines[row.base.line - 1] ?? "",
        )
    }
    if (row.head) {
      changedAdditionLines.add(row.head.line - 1)
      if (row.head.tokens.length > 0)
        additions[row.head.line - 1] = tokenRuns(
          row.head.tokens,
          headLines[row.head.line - 1] ?? "",
        )
    }
  }
  const built = createStructuralDiff(
    { name: diff.previousPath ?? diff.path, contents: texts.base ?? "" },
    { name: diff.path, contents: texts.head ?? "" },
    {
      rows,
      changedDeletionLines,
      changedAdditionLines,
      contextLines,
      intraLineRanges: { deletions, additions },
    },
  )
  // The engine's status is the authority over the type Pierre infers from the texts.
  if (diff.status === "created") built.type = "new"
  else if (diff.status === "deleted") built.type = "deleted"
  return built
}

/**
 * A conventional line diff of two texts, for a file the structural engine has not compared (no
 * analysis yet, unsupported syntax, an analysis failure). Rendered as a fallback: no muting of
 * unchanged code and no token marks claimed from the engine.
 */
export function toLineDiff(path: string, previousPath: string | undefined, texts: FileTexts) {
  const built = parseDiffFromFile(
    { name: previousPath ?? path, contents: texts.base ?? "" },
    { name: path, contents: texts.head ?? "" },
  )
  if (texts.base === null) built.type = "new"
  else if (texts.head === null) built.type = "deleted"
  return built
}

/** One changed region of a file, 1-based and inclusive, on the head side when it has head lines. */
export interface ChangedRegion {
  side: "additions" | "deletions"
  line: number
  endLine: number
}

type Hunk = StructuralDiff["hunks"][number]

function regionOf(hunk: Hunk): ChangedRegion | undefined {
  const head = hunk.flatMap((row) => (row.head ? [row.head.line] : []))
  const base = hunk.flatMap((row) => (row.base ? [row.base.line] : []))
  const [side, lines] =
    head.length > 0 ? (["additions", head] as const) : (["deletions", base] as const)
  if (lines.length === 0) return undefined
  return { side, line: Math.min(...lines), endLine: Math.max(...lines) }
}

/** The changed regions of a structural diff, in file order; next/previous change steps through them. */
export function changedRegions(diff: StructuralDiff): ChangedRegion[] {
  return diff.hunks.flatMap((hunk) => regionOf(hunk) ?? []).sort((a, b) => a.line - b.line)
}

/** The changed regions of a built Pierre diff (structural or line), in head-side order. */
export function pierreRegions(diff: FileDiffMetadata): ChangedRegion[] {
  const regions: ChangedRegion[] = []
  for (const hunk of diff.hunks) {
    let additionLine = hunk.additionStart
    let deletionLine = hunk.deletionStart
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        additionLine += content.lines
        deletionLine += content.lines
        continue
      }
      if (content.additions > 0)
        regions.push({
          side: "additions",
          line: additionLine,
          endLine: additionLine + content.additions - 1,
        })
      else if (content.deletions > 0)
        regions.push({
          side: "deletions",
          line: deletionLine,
          endLine: deletionLine + content.deletions - 1,
        })
      additionLine += content.additions
      deletionLine += content.deletions
    }
  }
  return regions
}

/** Added and removed line counts of a built diff, for the file row. */
export function lineCounts(diff: FileDiffMetadata): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of diff.hunks)
    for (const content of hunk.hunkContent)
      if (content.type === "change") {
        added += content.additions
        removed += content.deletions
      }
  return { added, removed }
}

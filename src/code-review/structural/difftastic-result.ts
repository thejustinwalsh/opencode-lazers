import {
  DIFFTASTIC_VERSION,
  type DiffRow,
  type DiffToken,
  type StructuralCompareRequest,
  type StructuralDiff,
} from "./contract.ts"
import type {
  DifftasticChange,
  DifftasticFile,
  DifftasticRow,
  DifftasticSide,
} from "./difftastic-json.ts"
import { byteOffsetToUtf16Column, splitSourceLines, utf8Bytes } from "./utf-coordinates.ts"

const PER_CHARACTER_RUN = 5

function perCharacterFallback(changes: readonly DifftasticChange[]): boolean {
  let run = 0
  let lastEnd = Number.NEGATIVE_INFINITY
  for (const change of changes) {
    run = change.end - change.start === 1 ? (change.start === lastEnd ? run + 1 : 1) : 0
    if (run >= PER_CHARACTER_RUN) return true
    lastEnd = change.end
  }
  return false
}

function coversNonWhitespace(changes: readonly DifftasticChange[], bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  const covered = new Uint8Array(bytes.length)
  for (const change of changes)
    covered.fill(1, Math.max(0, change.start), Math.min(bytes.length, change.end))
  return bytes.every((byte, index) => covered[index] === 1 || byte === 0x20 || byte === 0x09)
}

function mapChangesToTokens(
  changes: readonly DifftasticChange[],
  line: string,
  bytes: Uint8Array,
): DiffToken[] {
  const tokens: DiffToken[] = []
  for (const change of changes) {
    const start = byteOffsetToUtf16Column(line, bytes, change.start)
    const end = byteOffsetToUtf16Column(line, bytes, change.end)
    if (end <= start) continue
    tokens.push({
      start,
      end,
      highlight: change.highlight === "tree_sitter_error" ? "parse-error" : change.highlight,
    })
  }
  return tokens.sort((a, b) => a.start - b.start)
}

function toTokens(side: DifftasticSide, lines: readonly string[], oneSided: boolean): DiffToken[] {
  const line = lines[side.line_number] ?? ""
  const bytes = utf8Bytes(line)
  if (perCharacterFallback(side.changes)) {
    const start = line.length - line.trimStart().length
    const end = line.trimEnd().length
    return oneSided || end <= start ? [] : [{ start, end, highlight: "normal" }]
  }
  if (oneSided && coversNonWhitespace(side.changes, bytes)) return []
  return mapChangesToTokens(side.changes, line, bytes)
}

function addHeadComments(
  side: DifftasticSide,
  headLines: readonly string[],
  byLine: Map<number, [number, number]>,
): void {
  const line = headLines[side.line_number] ?? ""
  const bytes = utf8Bytes(line)
  for (const change of side.changes) {
    if (change.highlight !== "comment") continue
    const start = byteOffsetToUtf16Column(line, bytes, change.start)
    const end = byteOffsetToUtf16Column(line, bytes, change.end)
    if (end <= start) continue
    const lineNumber = side.line_number + 1
    const previous = byLine.get(lineNumber)
    byLine.set(
      lineNumber,
      previous ? [Math.min(previous[0], start), Math.max(previous[1], end)] : [start, end],
    )
  }
}

function commentsFor(
  file: DifftasticFile,
  headLines: readonly string[],
): [number, number, number][] {
  const byLine = new Map<number, [number, number]>()
  for (const chunk of file.chunks ?? []) {
    for (const row of chunk) if (row.rhs) addHeadComments(row.rhs, headLines, byLine)
  }
  return [...byLine]
    .sort(([left], [right]) => left - right)
    .map(([line, [start, end]]): [number, number, number] => [line, start, end])
}

function toDiffRow(
  row: DifftasticRow,
  baseLines: readonly string[],
  headLines: readonly string[],
): DiffRow {
  const oneSided = !(row.lhs && row.rhs)
  return {
    ...(row.lhs
      ? {
          base: {
            line: row.lhs.line_number + 1,
            tokens: toTokens(row.lhs, baseLines, oneSided),
          },
        }
      : {}),
    ...(row.rhs
      ? {
          head: {
            line: row.rhs.line_number + 1,
            tokens: toTokens(row.rhs, headLines, oneSided),
          },
        }
      : {}),
  }
}

function alignedLines(
  file: DifftasticFile,
  status: StructuralDiff["status"],
  baseLines: readonly string[],
  headLines: readonly string[],
): [number | null, number | null][] {
  const aligned =
    file.aligned_lines ??
    (status === "created"
      ? headLines.map((_, index) => [null, index] as [null, number])
      : status === "deleted"
        ? baseLines.map((_, index) => [index, null] as [number, null])
        : baseLines.map((_, index) => [index, index] as [number, number]))

  return aligned
    .map(([base, head]): [number | null, number | null] => [
      base === null || base >= baseLines.length ? null : base + 1,
      head === null || head >= headLines.length ? null : head + 1,
    ])
    .filter(([base, head]) => base !== null || head !== null)
}

export function toStructuralDiff(
  file: DifftasticFile,
  request: Pick<StructuralCompareRequest, "path" | "previousPath" | "base" | "head">,
): StructuralDiff {
  const baseLines = splitSourceLines(request.base ?? "")
  const headLines = splitSourceLines(request.head ?? "")
  const status =
    request.base === null
      ? request.head === null
        ? "unchanged"
        : "created"
      : request.head === null
        ? "deleted"
        : file.status
  const hunks: DiffRow[][] = (file.chunks ?? []).map((chunk) =>
    chunk.map((row) => toDiffRow(row, baseLines, headLines)),
  )
  const comments = commentsFor(file, headLines)
  return {
    path: request.path,
    ...(request.previousPath && request.previousPath !== request.path
      ? { previousPath: request.previousPath }
      : {}),
    engineVersion: DIFFTASTIC_VERSION,
    status,
    language: file.language,
    engine: "difftastic",
    alignedLines: alignedLines(file, status, baseLines, headLines),
    hunks,
    ...(comments.length > 0 ? { comments } : {}),
  }
}

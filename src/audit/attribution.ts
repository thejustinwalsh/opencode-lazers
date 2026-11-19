/** Pure parsing of `git diff -U0` into added line ranges; the engine does all attribution. */

export type LineRange = { startLine: number; endLine: number }

/** A `+++ b/<path>` file header line, or `undefined` path for `+++ /dev/null` (a deleted file). */
function fileHeaderPath(line: string): { matched: boolean; path?: string } {
  const fileHeader = /^\+\+\+ b\/(.+)$/.exec(line)
  if (fileHeader)
    return { matched: true, path: fileHeader[1] === "/dev/null" ? undefined : fileHeader[1] }
  return { matched: line.startsWith("+++ ") }
}

/** The added range of an `@@ -a,b +c,d @@` hunk header, or `undefined` for a pure deletion. */
function addedRangeOf(line: string): LineRange | undefined {
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
  if (!hunk) return undefined
  const start = Number(hunk[1])
  const count = hunk[2] === undefined ? 1 : Number(hunk[2])
  return count > 0 ? { startLine: start, endLine: start + count - 1 } : undefined
}

function recordRange(result: Map<string, LineRange[]>, path: string, range: LineRange): void {
  const ranges = result.get(path) ?? []
  ranges.push(range)
  result.set(path, ranges)
}

/** Parses `git diff -U0 <base>..<artifact>` output into added line ranges per post-diff path. */
export function addedLineRangesFromDiff(diffText: string): Map<string, LineRange[]> {
  const result = new Map<string, LineRange[]>()
  let currentPath: string | undefined
  for (const line of diffText.split("\n")) {
    const header = fileHeaderPath(line)
    if (header.matched) {
      currentPath = header.path
      continue
    }
    const range = addedRangeOf(line)
    if (range && currentPath) recordRange(result, currentPath, range)
  }
  return result
}

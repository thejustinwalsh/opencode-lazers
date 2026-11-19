/** Pure attribution: no git, no analyzer — only the comparison logic the review needs. */

export type ComplexityPoint = {
  path: string
  name: string
  cyclomatic: number
  cognitive: number
  line?: number
}

export type ComplexityAttribution = {
  path: string
  name: string
  cyclomatic: number
  cognitive: number
  line?: number
  status: "introduced" | "worsened"
  before?: { cyclomatic: number; cognitive: number }
}

/** Groups by path, preserving order of appearance, for positional name-collision matching. */
function byPathInOrder<T extends { path: string }>(points: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const point of points) {
    const list = map.get(point.path)
    if (list) list.push(point)
    else map.set(point.path, [point])
  }
  return map
}

/**
 * Matches candidate functions over a limit to their base-side counterpart by path + name; when a
 * name repeats in a file, matches by order of appearance among same-named functions. A candidate
 * absent at base, or within limits at base, is `introduced`. Over at base and higher now (either
 * metric) is `worsened`. Over at base and not higher is dropped (ignored).
 */
export function attributeComplexity(
  base: readonly ComplexityPoint[],
  candidate: readonly ComplexityPoint[],
  limits: { cyclomatic: number; cognitive: number },
): ComplexityAttribution[] {
  const baseByPath = byPathInOrder(base)
  const seenIndex = new Map<string, number>()
  const result: ComplexityAttribution[] = []
  for (const point of candidate) {
    const overLimit = point.cyclomatic > limits.cyclomatic || point.cognitive > limits.cognitive
    if (!overLimit) continue
    const key = `${point.path}\u0000${point.name}`
    const occurrence = seenIndex.get(key) ?? 0
    seenIndex.set(key, occurrence + 1)
    const candidatesAtPath = baseByPath.get(point.path) ?? []
    const sameName = candidatesAtPath.filter((b) => b.name === point.name)
    const before = sameName[occurrence]
    const baseOverLimit = before
      ? before.cyclomatic > limits.cyclomatic || before.cognitive > limits.cognitive
      : false
    if (!before || !baseOverLimit) {
      result.push({ ...point, status: "introduced" })
      continue
    }
    const higherNow = point.cyclomatic > before.cyclomatic || point.cognitive > before.cognitive
    if (higherNow)
      result.push({
        ...point,
        status: "worsened",
        before: { cyclomatic: before.cyclomatic, cognitive: before.cognitive },
      })
  }
  return result
}

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

export type DuplicationInstance = { file: string; startLine: number; endLine: number }
export type DuplicationAttribution = { instances: DuplicationInstance[]; status: "introduced" }

function overlaps(a: LineRange, b: DuplicationInstance): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine
}

/** A clone group is introduced when at least one instance overlaps a line the diff added. */
export function attributeDuplication(
  groups: readonly { instances: readonly DuplicationInstance[] }[],
  addedRanges: ReadonlyMap<string, readonly LineRange[]>,
): DuplicationAttribution[] {
  const result: DuplicationAttribution[] = []
  for (const group of groups) {
    const introduced = group.instances.some((instance) =>
      (addedRanges.get(instance.file) ?? []).some((range) => overlaps(range, instance)),
    )
    if (introduced) result.push({ instances: [...group.instances], status: "introduced" })
  }
  return result
}

export type DeadCodeKey = { kind: string; path: string; name: string }

/** Dead-code finding key: kind + path + name, no line. Introduced when absent at base. */
export function attributeDeadCode(
  base: readonly DeadCodeKey[],
  candidate: readonly DeadCodeKey[],
): DeadCodeKey[] {
  const baseKeys = new Set(base.map((k) => `${k.kind}\u0000${k.path}\u0000${k.name}`))
  return candidate.filter((k) => !baseKeys.has(`${k.kind}\u0000${k.path}\u0000${k.name}`))
}

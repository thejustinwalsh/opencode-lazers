import type {
  DiffRow,
  StructuralDegradedReason,
  StructuralDiff,
  ValidStructuralCompareRequest,
} from "./contract.ts"
import { DIFFTASTIC_VERSION } from "./contract.ts"
import { splitSourceLines } from "./utf-coordinates.ts"

export type LineDiffOperation = "equal" | "remove" | "add"
const MAX_EDIT_DISTANCE = 5000

function movesDown(
  vector: Int32Array,
  offset: number,
  diagonal: number,
  distance: number,
): boolean {
  return (
    diagonal === -distance ||
    (diagonal !== distance &&
      (vector[offset + diagonal - 1] ?? 0) < (vector[offset + diagonal + 1] ?? 0))
  )
}

function advanceDiagonal(
  vector: Int32Array,
  offset: number,
  diagonal: number,
  distance: number,
  a: readonly string[],
  b: readonly string[],
): { x: number; y: number; down: boolean } {
  const down = movesDown(vector, offset, diagonal, distance)
  let x = down ? (vector[offset + diagonal + 1] ?? 0) : (vector[offset + diagonal - 1] ?? 0) + 1
  let y = x - diagonal
  while (x < a.length && y < b.length && a[x] === b[y]) {
    x++
    y++
  }
  return { x, y, down }
}

type Point = { x: number; y: number }

function appendEqualOperations(operations: LineDiffOperation[], from: Point, until: Point): Point {
  let { x, y } = from
  while (x > until.x && y > until.y) {
    operations.push("equal")
    x--
    y--
  }
  return { x, y }
}

function previousPoint(
  trace: readonly Int32Array[],
  depth: number,
  offset: number,
  diagonal: number,
): { point: Point; down: boolean } {
  const vector = trace[depth]!
  const down = movesDown(vector, offset, diagonal, depth)
  const previousDiagonal = down ? diagonal + 1 : diagonal - 1
  const x = vector[offset + previousDiagonal] ?? 0
  return { point: { x, y: x - previousDiagonal }, down }
}

function backtrack(
  trace: readonly Int32Array[],
  distance: number,
  n: number,
  m: number,
  offset: number,
): LineDiffOperation[] {
  const operations: LineDiffOperation[] = []
  let current = { x: n, y: m }
  for (let depth = distance; depth > 0; depth--) {
    const previous = previousPoint(trace, depth, offset, current.x - current.y)
    current = appendEqualOperations(operations, current, previous.point)
    operations.push(previous.down ? "add" : "remove")
    current = {
      x: current.x - Number(!previous.down),
      y: current.y - Number(previous.down),
    }
  }
  appendEqualOperations(operations, current, { x: 0, y: 0 })
  return operations.reverse()
}

/** Myers' shortest edit script, capped so a pathological fallback cannot grow without bound. */
function myers(a: readonly string[], b: readonly string[]): LineDiffOperation[] | undefined {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_EDIT_DISTANCE)
  const offset = max + 1
  let vector = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []

  for (let distance = 0; distance <= max; distance++) {
    trace.push(vector)
    const next = vector.slice()
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const path = advanceDiagonal(vector, offset, diagonal, distance, a, b)
      next[offset + diagonal] = path.x
      if (path.x >= n && path.y >= m) return backtrack(trace, distance, n, m, offset)
    }
    vector = next
  }
  return undefined
}

function editScript(a: readonly string[], b: readonly string[]): LineDiffOperation[] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++

  const middleA = a.slice(prefix, a.length - suffix)
  const middleB = b.slice(prefix, b.length - suffix)
  const middle = myers(middleA, middleB) ?? [
    ...middleA.map((): LineDiffOperation => "remove"),
    ...middleB.map((): LineDiffOperation => "add"),
  ]
  return [
    ...new Array<LineDiffOperation>(prefix).fill("equal"),
    ...middle,
    ...new Array<LineDiffOperation>(suffix).fill("equal"),
  ]
}

function fileFields(
  request: Pick<ValidStructuralCompareRequest, "path" | "previousPath">,
): Pick<StructuralDiff, "path" | "previousPath"> {
  return {
    path: request.path,
    ...(request.previousPath && request.previousPath !== request.path
      ? { previousPath: request.previousPath }
      : {}),
  }
}

export function projectLineOperations(
  request: ValidStructuralCompareRequest,
  degraded: StructuralDegradedReason,
  operations: readonly LineDiffOperation[],
): StructuralDiff {
  const alignedLines: [number | null, number | null][] = []
  const hunks: DiffRow[][] = []
  let baseLine = 0
  let headLine = 0
  let removed: number[] = []
  let added: number[] = []

  const flush = () => {
    if (removed.length === 0 && added.length === 0) return
    const hunk: DiffRow[] = []
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      const base = removed[index]
      const head = added[index]
      alignedLines.push([base ?? null, head ?? null])
      hunk.push({
        ...(base === undefined ? {} : { base: { line: base, tokens: [] } }),
        ...(head === undefined ? {} : { head: { line: head, tokens: [] } }),
      })
    }
    hunks.push(hunk)
    removed = []
    added = []
  }

  for (const operation of operations) {
    if (operation === "remove") removed.push(++baseLine)
    else if (operation === "add") added.push(++headLine)
    else {
      flush()
      alignedLines.push([++baseLine, ++headLine])
    }
  }
  flush()

  return {
    ...fileFields(request),
    engineVersion: DIFFTASTIC_VERSION,
    status:
      request.base === null && request.head !== null
        ? "created"
        : request.head === null && request.base !== null
          ? "deleted"
          : hunks.length > 0
            ? "changed"
            : "unchanged",
    language: "Text",
    engine: "line",
    degraded,
    alignedLines,
    hunks,
  }
}

export function lineDiff(
  request: ValidStructuralCompareRequest,
  degraded: StructuralDegradedReason,
): StructuralDiff {
  const baseLines = splitSourceLines(request.base ?? "")
  const headLines = splitSourceLines(request.head ?? "")
  return projectLineOperations(request, degraded, editScript(baseLines, headLines))
}

export function binaryDiff(request: ValidStructuralCompareRequest): StructuralDiff {
  return {
    ...fileFields(request),
    engineVersion: DIFFTASTIC_VERSION,
    status:
      request.base === null && request.head !== null
        ? "created"
        : request.head === null && request.base !== null
          ? "deleted"
          : request.base === request.head
            ? "unchanged"
            : "changed",
    language: "Binary",
    engine: "line",
    degraded: "binary",
    alignedLines: [],
    hunks: [],
  }
}

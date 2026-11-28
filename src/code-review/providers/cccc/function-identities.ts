import type { FlatFunction } from "./compare.ts"
import type {
  CcccFunctionIdentity,
  CcccFunctionIdentityInput,
  CcccSide,
  CcccSnapshotReader,
} from "./types.ts"

export async function collectFunctionIdentities(
  reader: CcccSnapshotReader,
  comparisonID: string,
  side: CcccSide,
  path: string,
  source: string,
  functions: readonly FlatFunction[],
  signal: AbortSignal,
): Promise<Map<FlatFunction, string>> {
  const result = new Map<FlatFunction, string>()
  if (!reader.functionIdentity) return result
  const lines = source.split("\n")
  for (const fn of functions) {
    signal.throwIfAborted()
    const line = lines[fn.line - 1] ?? ""
    const identity = await readIdentity(reader, {
      comparisonID,
      side,
      path,
      line: fn.line,
      column: line.length - line.trimStart().length,
      signal,
    })
    addIdentity(result, fn, identity, lines.length)
  }
  return result
}

async function readIdentity(
  reader: CcccSnapshotReader,
  input: CcccFunctionIdentityInput,
): Promise<string | CcccFunctionIdentity | undefined> {
  try {
    return await reader.functionIdentity?.(input)
  } catch {
    input.signal.throwIfAborted()
    return undefined
  }
}

function addIdentity(
  result: Map<FlatFunction, string>,
  fn: FlatFunction,
  identity: string | CcccFunctionIdentity | undefined,
  lineCount: number,
): void {
  if (typeof identity === "string") {
    if (identity) result.set(fn, identity)
    return
  }
  if (!identity) return
  setFunctionEndLine(fn, identity.endLine, lineCount)
  if (typeof identity.key === "string" && identity.key) result.set(fn, identity.key)
}

function setFunctionEndLine(fn: FlatFunction, endLine: number | undefined, lineCount: number) {
  if (
    endLine !== undefined &&
    Number.isSafeInteger(endLine) &&
    endLine >= fn.line &&
    endLine <= lineCount
  )
    fn.endLine = endLine
}

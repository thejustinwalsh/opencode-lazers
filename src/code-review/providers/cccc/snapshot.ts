import { languageOf } from "./languages.ts"
import { safeRepositoryPath } from "./privacy.ts"
import type {
  CcccChangedFile,
  CcccComparisonSnapshot,
  CcccCoverage,
  CcccProviderIssue,
  CcccSide,
  CcccSnapshotReader,
  CcccSourceInput,
} from "./types.ts"

export interface SnapshotSources {
  inputs: CcccSourceInput[]
  files: Array<{ change: CcccChangedFile; basePath: string }>
  coverage: CcccCoverage
  issues: CcccProviderIssue[]
}

function repositoryPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false
  const parts = path.split("/")
  return parts.every((part) => part !== "" && part !== "." && part !== "..")
}

function sourceSides(change: CcccChangedFile, basePath: string): Array<[CcccSide, string]> {
  return [
    ...(change.status === "added" ? [] : [["base", basePath] as [CcccSide, string]]),
    ...(change.status === "removed" ? [] : [["head", change.path] as [CcccSide, string]]),
  ]
}

export async function readSnapshotSources(
  reader: CcccSnapshotReader,
  snapshot: CcccComparisonSnapshot,
  signal: AbortSignal,
): Promise<SnapshotSources> {
  const state = emptySources()
  for (const change of snapshot.changedFiles) {
    signal.throwIfAborted()
    await collectChange(reader, snapshot, change, state, signal)
  }
  signal.throwIfAborted()
  return state
}

interface MutableSources extends SnapshotSources {
  sources: Map<string, string | undefined>
  includedInputs: Set<string>
  changedPaths: Set<string>
}

function emptySources(): MutableSources {
  return {
    inputs: [],
    files: [],
    issues: [],
    coverage: {
      supportedFiles: 0,
      analyzedFiles: 0,
      unsupportedFiles: 0,
      unavailableFiles: 0,
      unclassifiedFiles: 0,
      parseErrorFiles: 0,
      parseErrors: 0,
    },
    sources: new Map(),
    includedInputs: new Set(),
    changedPaths: new Set(),
  }
}

async function collectChange(
  reader: CcccSnapshotReader,
  snapshot: CcccComparisonSnapshot,
  change: CcccChangedFile,
  state: MutableSources,
  signal: AbortSignal,
): Promise<void> {
  const basePath = change.status === "renamed" ? (change.previousPath ?? change.path) : change.path
  if (
    !repositoryPath(change.path) ||
    (change.previousPath !== undefined && !repositoryPath(change.previousPath)) ||
    state.changedPaths.has(change.path)
  )
    throw new TypeError("cccc received an invalid comparison path")
  state.changedPaths.add(change.path)
  state.files.push({ change, basePath })
  if (change.binary) return

  const sides = sourceSides(change, basePath)
  const supportedSides = sides.filter(([, path]) => languageOf(path) !== undefined)
  recordSupportCoverage(state, change, sides.length, supportedSides.length)
  for (const [side, path] of supportedSides)
    await collectSide(reader, snapshot, state, side, path, signal)
}

function recordSupportCoverage(
  state: MutableSources,
  change: CcccChangedFile,
  sideCount: number,
  supportedCount: number,
): void {
  if (supportedCount === 0) {
    state.coverage.unsupportedFiles++
    state.issues.push({
      code: "unsupported-extension",
      path: safeRepositoryPath(change.path),
    })
    return
  }
  state.coverage.supportedFiles++
  if (supportedCount !== sideCount) {
    state.coverage.unsupportedFiles++
    state.issues.push({
      code: "unsupported-extension",
      path: safeRepositoryPath(change.path),
    })
  }
  if (
    change.status !== "added" &&
    change.status !== "removed" &&
    change.changedLines === undefined
  ) {
    state.coverage.unclassifiedFiles++
    state.issues.push({
      code: "changed-lines-unavailable",
      path: safeRepositoryPath(change.path),
    })
  }
}

async function collectSide(
  reader: CcccSnapshotReader,
  snapshot: CcccComparisonSnapshot,
  state: MutableSources,
  side: CcccSide,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const key = `${side}\0${path}`
  if (!state.sources.has(key)) {
    try {
      const source = await reader.readSource(snapshot.comparisonID, side, path, signal)
      state.sources.set(key, typeof source === "string" ? source : undefined)
    } catch {
      signal.throwIfAborted()
      state.sources.set(key, undefined)
    }
  }
  const source = state.sources.get(key)
  if (source === undefined) {
    state.coverage.unavailableFiles++
    state.issues.push({ code: "source-unavailable", side, path: safeRepositoryPath(path) })
    return
  }
  if (state.includedInputs.has(key)) return
  state.includedInputs.add(key)
  state.inputs.push({ side, path, source })
}

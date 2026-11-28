import { createHash } from "node:crypto"
import { lstat, readFile, readlink, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import {
  bytesAreText,
  isConfidentialSourcePath,
  isKnownBinaryPath,
  isSourcePath,
  type GitFile,
  type GitHunk,
} from "./git.ts"
import type { CodeReviewFileKind, CodeReviewHunk, CodeReviewSide } from "../contract.ts"
import type { ComparisonBlob, ComparisonFile } from "./store.ts"

export type SnapshotEntry = {
  path: string
  mode: string | null
  objectID: string | null
  size: number | null
  kind: CodeReviewFileKind
  conflicted?: true
}

export type LiveCapture = {
  headRevision: string
  snapshotID: string
  sides: Map<CodeReviewSide, Map<string, SnapshotEntry>>
  hunks: Map<CodeReviewSide, Map<string, CodeReviewHunk[]>>
  blobs: ComparisonBlob[]
  capturedAt: number
  attribution: "assigned-workspace" | "shared-workspace-unowned"
}

export function lineCount(bytes: Uint8Array): number | null {
  if (!bytesAreText(bytes)) return null
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (text.length === 0) return 0
  let count = 1
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++
  return text.endsWith("\n") ? count - 1 : count
}

export function lineOffsets(text: string): number[] {
  if (text.length === 0) return []
  const offsets = [0]
  for (let index = 0; index < text.length; index++)
    if (text.charCodeAt(index) === 10 && index + 1 < text.length) offsets.push(index + 1)
  return offsets
}

export function kindFor(path: string, mode: string | null, bytes?: Uint8Array): CodeReviewFileKind {
  if (!mode) return "absent"
  if (mode === "120000") return "symlink"
  if (mode === "160000") return "submodule"
  if (isConfidentialSourcePath(path)) return "unknown"
  if (isKnownBinaryPath(path)) return "binary"
  if (bytes) return bytesAreText(bytes) ? "text" : "binary"
  return isSourcePath(path) ? "text" : "unknown"
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

export function gitFileEntry(file: GitFile): SnapshotEntry {
  return {
    path: file.path,
    mode: file.mode,
    objectID: file.objectID,
    size: file.size,
    kind: file.kind,
  }
}

function statusBetween(
  before: SnapshotEntry | undefined,
  after: SnapshotEntry | undefined,
): ComparisonFile["status"] {
  const beforeFile = presentEntry(before)
  const afterFile = presentEntry(after)
  if (beforeFile?.conflicted || afterFile?.conflicted) return "conflicted"
  if (!beforeFile) return afterFile ? "added" : "unchanged"
  if (!afterFile) return "deleted"
  return sameFile(beforeFile, afterFile) ? "unchanged" : "modified"
}

function presentEntry(entry: SnapshotEntry | undefined): SnapshotEntry | undefined {
  return entry?.kind === "absent" ? undefined : entry
}

function sameFile(beforeFile: SnapshotEntry, afterFile: SnapshotEntry): boolean {
  const sameObject = beforeFile.objectID === afterFile.objectID
  const bothHaveObjects = Boolean(beforeFile.objectID && afterFile.objectID)
  return sameObject && (!bothHaveObjects || beforeFile.mode === afterFile.mode)
}

export function hunkMapForSide(
  before: Map<string, SnapshotEntry>,
  after: Map<string, SnapshotEntry>,
  hunks: Map<string, GitHunk[]>,
): Map<string, CodeReviewHunk[]> {
  const result = new Map<string, CodeReviewHunk[]>()
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (hunks.has(path)) result.set(path, hunks.get(path)!)
    else if (!before.has(path) && after.has(path)) {
      result.set(path, [{ baseStart: 0, baseEnd: 0, headStart: 1, headEnd: 1 }])
    }
  }
  return result
}

export function allPairRows(
  before: Map<string, SnapshotEntry>,
  after: Map<string, SnapshotEntry>,
  sides: { before: CodeReviewSide; after: CodeReviewSide },
  hunks: Map<string, CodeReviewHunk[]>,
  attribution: ReadonlyMap<string, readonly string[]> = new Map(),
): ComparisonFile[] {
  const files: ComparisonFile[] = []
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const baseFile = before.get(path)
    const headFile = after.get(path)
    const status = statusBetween(baseFile, headFile)
    const changed = status !== "unchanged"
    const pathHunks = hunks.get(path) ?? []
    const attributionTaskIDs = [...(attribution.get(path) ?? [])].sort()
    for (const [side, file] of [
      [sides.before, baseFile],
      [sides.after, headFile],
    ] as const) {
      files.push({
        side,
        path,
        mode: file?.mode ?? null,
        objectID: file?.objectID ?? null,
        size: file?.size ?? null,
        kind: file?.kind ?? "absent",
        status,
        changed,
        hunks: pathHunks,
        attributionTaskIDs,
      })
    }
  }
  return files
}

function exactFileRows(
  entries: Map<string, SnapshotEntry>,
  side: CodeReviewSide,
  status: ReadonlyMap<string, ComparisonFile["status"]>,
  hunks: ReadonlyMap<string, CodeReviewHunk[]>,
  attribution: ReadonlyMap<string, readonly string[]> = new Map(),
): ComparisonFile[] {
  return [...entries.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => {
      const fileStatus = status.get(file.path) ?? "unchanged"
      return {
        side,
        path: file.path,
        mode: file.mode,
        objectID: file.objectID,
        size: file.size,
        kind: file.kind,
        status: fileStatus,
        changed: fileStatus !== "unchanged",
        hunks: [...(hunks.get(file.path) ?? [])],
        attributionTaskIDs: [...(attribution.get(file.path) ?? [])].sort(),
      }
    })
}

export function liveFileRows(
  base: Map<string, SnapshotEntry>,
  head: Map<string, SnapshotEntry>,
  capture: LiveCapture,
): ComparisonFile[] {
  const staged = withAbsentEntries(head, capture.sides.get("staged")!)
  const unstaged = withAbsentEntries(staged, capture.sides.get("unstaged")!)
  const untracked = capture.sides.get("untracked")!
  const stagedRows = exactFileRows(
    staged,
    "staged",
    compareStatus(head, staged),
    capture.hunks.get("staged")!,
  )
  const unstagedRows = exactFileRows(
    unstaged,
    "unstaged",
    compareStatus(staged, unstaged),
    capture.hunks.get("unstaged")!,
  )
  const untrackedStatus = new Map([...untracked.keys()].map((path) => [path, "added" as const]))
  const untrackedRows = exactFileRows(
    untracked,
    "untracked",
    untrackedStatus,
    capture.hunks.get("untracked")!,
  )
  return [
    ...allPairRows(base, head, { before: "base", after: "head" }, capture.hunks.get("base")!),
    ...stagedRows,
    ...unstagedRows,
    ...untrackedRows,
  ]
}

function withAbsentEntries(
  before: Map<string, SnapshotEntry>,
  after: Map<string, SnapshotEntry>,
): Map<string, SnapshotEntry> {
  const complete = new Map(after)
  for (const path of before.keys())
    if (!complete.has(path))
      complete.set(path, { path, mode: null, objectID: null, size: null, kind: "absent" })
  return complete
}

function compareStatus(
  before: Map<string, SnapshotEntry>,
  after: Map<string, SnapshotEntry>,
): Map<string, ComparisonFile["status"]> {
  const result = new Map<string, ComparisonFile["status"]>()
  for (const path of new Set([...before.keys(), ...after.keys()]))
    result.set(path, statusBetween(before.get(path), after.get(path)))
  return result
}

export function flattenPlanAttribution(taskFiles: Record<string, string[]>): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const [taskID, paths] of Object.entries(taskFiles))
    for (const path of paths) {
      const ids = result.get(path) ?? []
      ids.push(taskID)
      result.set(path, ids)
    }
  return result
}

export function setKindFromBytes(entry: SnapshotEntry, bytes: Uint8Array): SnapshotEntry {
  return { ...entry, size: bytes.byteLength, kind: kindFor(entry.path, entry.mode, bytes) }
}

function readMode(mode: number): string {
  return (mode & 0o111) !== 0 ? "100755" : "100644"
}

export async function readWorkingEntry(
  workspace: string,
  path: string,
): Promise<{ entry: SnapshotEntry; content?: Uint8Array; stamp: string }> {
  const location = resolve(workspace, path)
  const stat = await lstat(location).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined
    throw error
  })
  if (!stat)
    return {
      entry: { path, mode: null, objectID: null, size: null, kind: "absent" },
      stamp: "absent",
    }
  const parent = await realpath(dirname(location))
  const parentRelative = relative(workspace, parent)
  if (
    isAbsolute(parentRelative) ||
    parentRelative === ".." ||
    parentRelative.startsWith(`..${sep}`)
  )
    throw new Error("The assigned workspace path resolves outside its Git root")
  const symlink = stat.isSymbolicLink()
  const mode = symlink ? "120000" : stat.isFile() ? readMode(stat.mode) : null
  const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.mode}`
  if (!mode)
    return {
      entry: { path, mode: null, objectID: null, size: stat.size, kind: "unknown" },
      stamp,
    }
  const captured = symlink
    ? new TextEncoder().encode(await readlink(location))
    : await readFile(location)
  const content =
    !symlink &&
    !isConfidentialSourcePath(path) &&
    !isKnownBinaryPath(path) &&
    bytesAreText(captured)
      ? captured
      : undefined
  const objectID = `sha256:${createHash("sha256").update(captured).digest("hex")}`
  return {
    entry: {
      path,
      mode,
      objectID,
      size: captured.byteLength,
      kind: kindFor(path, mode, captured),
    },
    ...(content ? { content } : {}),
    stamp,
  }
}

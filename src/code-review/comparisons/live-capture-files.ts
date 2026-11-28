import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import {
  kindFor,
  lineCount,
  readWorkingEntry,
  sameBytes,
  setKindFromBytes,
  type SnapshotEntry,
} from "./inventory.ts"
import {
  blobBatch,
  blobSizes,
  bytesAreText,
  gitBytes,
  gitText,
  isConfidentialSourcePath,
  isKnownBinaryPath,
  type GitIndexFile,
} from "./git.ts"

export type CapturedPaths = {
  entries: Map<string, SnapshotEntry>
  stamps: Map<string, string>
  blobs: Map<string, Uint8Array>
}

export function indexEntries(
  rows: readonly GitIndexFile[],
  headEntries: Map<string, SnapshotEntry>,
): Map<string, SnapshotEntry> {
  const conflicted = new Set<string>()
  const entries = new Map<string, SnapshotEntry>()
  for (const file of rows) {
    if (file.stage !== 0) {
      conflicted.add(file.path)
      continue
    }
    const head = headEntries.get(file.path)
    entries.set(file.path, {
      path: file.path,
      mode: file.mode,
      objectID: file.objectID,
      size: head?.objectID === file.objectID ? head.size : null,
      kind: head?.objectID === file.objectID ? head.kind : kindFor(file.path, file.mode),
    })
  }
  for (const path of conflicted)
    entries.set(path, {
      path,
      mode: null,
      objectID: null,
      size: null,
      kind: "unknown",
      conflicted: true,
    })
  return entries
}

async function stableWorkingEntry(workspace: string, path: string) {
  const before = await readWorkingEntry(workspace, path)
  const after = await readWorkingEntry(workspace, path)
  const changed =
    before.stamp !== after.stamp ||
    before.entry.objectID !== after.entry.objectID ||
    Boolean(before.content) !== Boolean(after.content) ||
    (before.content !== undefined &&
      after.content !== undefined &&
      !sameBytes(before.content, after.content))
  if (changed)
    throw new Error("The assigned workspace changed during Live capture; retry the comparison")
  const entry = before.content ? setKindFromBytes(before.entry, before.content) : before.entry
  return { entry, content: before.content, stamp: before.stamp }
}

export async function capturePaths(
  workspace: string,
  paths: readonly string[],
  signal: AbortSignal,
  indexed?: Map<string, SnapshotEntry>,
  changedWorktreePaths?: ReadonlySet<string>,
): Promise<CapturedPaths> {
  const captured: CapturedPaths = {
    entries: new Map(),
    stamps: new Map(),
    blobs: new Map(),
  }
  for (const path of paths) {
    signal.throwIfAborted()
    const indexedEntry = indexed?.get(path)
    if (indexedEntry && changedWorktreePaths?.has(path) === false) {
      captured.entries.set(path, indexedEntry)
      continue
    }
    const current = await stableWorkingEntry(workspace, path)
    captured.entries.set(path, current.entry)
    captured.stamps.set(path, current.stamp)
    if (current.content && current.entry.objectID)
      captured.blobs.set(current.entry.objectID, current.content)
  }
  return captured
}

export async function enrichIndexEntries(
  root: string,
  entries: Map<string, SnapshotEntry>,
  headEntries: Map<string, SnapshotEntry>,
  signal: AbortSignal,
): Promise<Map<string, Uint8Array>> {
  const sourceIDs = [
    ...new Set(
      [...entries.values()]
        .filter(
          (file) =>
            file.objectID &&
            file.mode !== "160000" &&
            file.mode !== "120000" &&
            !isConfidentialSourcePath(file.path) &&
            !isKnownBinaryPath(file.path) &&
            headEntries.get(file.path)?.objectID !== file.objectID,
        )
        .map((file) => file.objectID!),
    ),
  ]
  const sourceBytes = await blobBatch(root, sourceIDs, signal)
  const idsNeedingSize = [
    ...new Set(
      [...entries.values()].flatMap((file) =>
        file.objectID && file.mode !== "160000" && file.size === null ? [file.objectID] : [],
      ),
    ),
  ]
  const sizes = await blobSizes(root, idsNeedingSize, signal)
  for (const [path, file] of entries) {
    if (!file.objectID) continue
    const content = sourceBytes.get(file.objectID)
    const size = sizes.get(file.objectID) ?? file.size
    entries.set(path, content ? setKindFromBytes({ ...file, size }, content) : { ...file, size })
  }
  return sourceBytes
}

export async function assertLiveWorkspaceStable(
  workspace: string,
  start: {
    statusBefore: Uint8Array
    indexBefore: Uint8Array
    headRevision: string
  },
  stamps: ReadonlyMap<string, string>,
  capturedFiles: ReadonlyMap<string, SnapshotEntry>,
  signal: AbortSignal,
): Promise<{ headIndexText: string; indexWorktreeText: string }> {
  for (const [path, stamp] of stamps) {
    signal.throwIfAborted()
    const current = await readWorkingEntry(workspace, path)
    if (current.stamp !== stamp || current.entry.objectID !== capturedFiles.get(path)?.objectID)
      throw new Error("The assigned workspace changed during Live capture; retry the comparison")
  }
  const [headIndexText, indexWorktreeText, statusAfter, indexAfter, headAfter] = await Promise.all([
    gitText(
      workspace,
      [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-color",
        "--no-renames",
        "--unified=0",
        "HEAD",
        "--",
      ],
      signal,
    ),
    gitText(
      workspace,
      ["diff", "--no-ext-diff", "--no-color", "--no-renames", "--unified=0", "--"],
      signal,
    ),
    gitBytes(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal),
    gitBytes(workspace, ["ls-files", "--stage", "-z"], signal),
    gitText(workspace, ["rev-parse", "--verify", "HEAD^{commit}"], signal),
  ])
  if (
    !sameBytes(start.statusBefore, statusAfter) ||
    !sameBytes(start.indexBefore, indexAfter) ||
    headAfter.trim() !== start.headRevision
  )
    throw new Error("The assigned workspace changed during Live capture; retry the comparison")
  return { headIndexText, indexWorktreeText }
}

export function liveSnapshotID(
  base: string,
  head: string,
  index: Uint8Array,
  status: Uint8Array,
  stamps: ReadonlyMap<string, string>,
  blobs: ReadonlyMap<string, Uint8Array>,
  files: readonly SnapshotEntry[],
): string {
  const signature = JSON.stringify({
    base,
    head,
    index: Buffer.from(index).toString("base64"),
    status: Buffer.from(status).toString("base64"),
    paths: [...stamps].sort(([left], [right]) => left.localeCompare(right)),
    contents: [...blobs.keys()].sort(),
    fileRevisions: files
      .map((file) => [file.path, file.objectID])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  })
  return createHash("sha256").update(signature).digest("hex")
}

export function untrackedHunks(
  entries: ReadonlyMap<string, SnapshotEntry>,
  blobs: ReadonlyMap<string, Uint8Array>,
) {
  const hunks = new Map<
    string,
    { baseStart: number; baseEnd: number; headStart: number; headEnd: number }[]
  >()
  for (const [path, file] of entries) {
    let lines = 1
    const content = file.objectID ? blobs.get(file.objectID) : undefined
    if (content && bytesAreText(content)) lines = lineCount(content) ?? 0
    hunks.set(path, [{ baseStart: 0, baseEnd: 0, headStart: 1, headEnd: lines }])
  }
  return hunks
}

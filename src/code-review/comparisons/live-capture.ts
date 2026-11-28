import type { AttemptRow } from "../../runner/store.ts"
import { bytesAreText, diffHunks, diffHunksFromText } from "./git.ts"
import { hunkMapForSide, type LiveCapture, type SnapshotEntry } from "./inventory.ts"
import { prepareLiveWorkspace } from "./live-capture-workspace.ts"
import {
  assertLiveWorkspaceStable,
  capturePaths,
  enrichIndexEntries,
  indexEntries,
  liveSnapshotID,
  untrackedHunks,
} from "./live-capture-files.ts"

/** Captures one assigned workspace without writing its index, tree or working files. */
export async function captureLive(
  projectDirectory: string,
  attempt: Pick<AttemptRow, "workspace">,
  base: string,
  signal: AbortSignal,
): Promise<LiveCapture> {
  const start = await prepareLiveWorkspace(projectDirectory, attempt.workspace, base, signal)
  const stageZero = indexEntries(start.indexRows, start.headEntries)
  const changedWorktreePaths = new Set(start.worktreeChangedPaths)
  const [working, untracked] = await Promise.all([
    capturePaths(start.workspaceReal, start.trackedPaths, signal, stageZero, changedWorktreePaths),
    capturePaths(start.workspaceReal, start.untrackedPaths, signal),
  ])
  const stagedSourceBytes = await enrichIndexEntries(
    start.rootReal,
    stageZero,
    start.headEntries,
    signal,
  )
  const capturedFiles = new Map<string, SnapshotEntry>([...working.entries, ...untracked.entries])
  const stamps = new Map([...working.stamps, ...untracked.stamps])
  const liveBlobs = new Map([...working.blobs, ...untracked.blobs])
  const deltas = await assertLiveWorkspaceStable(
    start.workspaceReal,
    start,
    stamps,
    capturedFiles,
    signal,
  )
  const baseHeadHunks = await diffHunks(
    start.rootReal,
    start.baseRevision,
    start.headRevision,
    signal,
  )
  const stagedHunks = hunkMapForSide(
    start.headEntries,
    stageZero,
    diffHunksFromText(deltas.headIndexText),
  )
  const unstagedHunks = hunkMapForSide(
    stageZero,
    working.entries,
    diffHunksFromText(deltas.indexWorktreeText),
  )
  const untrackedFileHunks = untrackedHunks(untracked.entries, liveBlobs)
  const snapshotID = liveSnapshotID(
    start.baseRevision,
    start.headRevision,
    start.indexBefore,
    start.statusBefore,
    stamps,
    liveBlobs,
    [...working.entries.values(), ...untracked.entries.values()],
  )
  return {
    headRevision: start.headRevision,
    snapshotID,
    sides: new Map([
      ["head", start.headEntries],
      ["staged", stageZero],
      ["unstaged", working.entries],
      ["untracked", untracked.entries],
    ]),
    hunks: new Map([
      ["base", baseHeadHunks],
      ["head", baseHeadHunks],
      ["staged", stagedHunks],
      ["unstaged", unstagedHunks],
      ["untracked", untrackedFileHunks],
    ]),
    blobs: [
      ...[...liveBlobs].map(([id, content]) => ({ id, content })),
      ...[...stagedSourceBytes]
        .filter(([, content]) => bytesAreText(content))
        .map(([id, content]) => ({ id, content })),
    ],
    capturedAt: Date.now(),
    attribution:
      start.workspaceReal === start.rootReal ? "shared-workspace-unowned" : "assigned-workspace",
  }
}

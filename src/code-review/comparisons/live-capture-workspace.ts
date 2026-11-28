import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import type { SnapshotEntry } from "./inventory.ts"
import {
  gitBytes,
  gitText,
  indexFiles,
  nulStrings,
  requireCommit,
  treeFiles,
  type GitIndexFile,
} from "./git.ts"
import { gitFileEntry } from "./inventory.ts"

export type LiveWorkspaceStart = {
  rootReal: string
  workspaceReal: string
  statusBefore: Uint8Array
  indexBefore: Uint8Array
  headRevision: string
  baseRevision: string
  headEntries: Map<string, SnapshotEntry>
  indexRows: GitIndexFile[]
  trackedPaths: string[]
  untrackedPaths: string[]
  worktreeChangedPaths: string[]
}

async function assertSameGitRoot(root: string, workspace: string, signal: AbortSignal) {
  const [workspaceCommon, rootCommon] = await Promise.all([
    gitText(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
    gitText(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
  ])
  const [workspaceReal, rootReal] = await Promise.all([
    realpath(resolve(workspace, workspaceCommon.trim())),
    realpath(resolve(root, rootCommon.trim())),
  ])
  if (workspaceReal !== rootReal)
    throw new Error("The recorded workspace belongs to another Git repository")
}

export async function prepareLiveWorkspace(
  projectDirectory: string,
  workspace: string,
  base: string,
  signal: AbortSignal,
): Promise<LiveWorkspaceStart> {
  const rootReal = await realpath(projectDirectory)
  const workspaceReal = await realpath(workspace).catch(() => {
    throw new Error("The assigned workspace is unavailable; no workspace was recreated")
  })
  await assertSameGitRoot(rootReal, workspaceReal, signal)
  const [statusBefore, indexBefore, headText] = await Promise.all([
    gitBytes(workspaceReal, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal),
    gitBytes(workspaceReal, ["ls-files", "--stage", "-z"], signal),
    gitText(workspaceReal, ["rev-parse", "--verify", "HEAD^{commit}"], signal),
  ])
  const headRevision = headText.trim()
  const baseRevision = await requireCommit(rootReal, base, signal)
  const verifiedHead = await requireCommit(rootReal, headRevision, signal)
  const [headTree, trackedPaths, untrackedPaths, worktreeChangedPaths] = await Promise.all([
    treeFiles(rootReal, verifiedHead, signal),
    gitBytes(workspaceReal, ["ls-files", "-z", "--cached"], signal).then(nulStrings),
    gitBytes(workspaceReal, ["ls-files", "-z", "--others", "--exclude-standard"], signal).then(
      nulStrings,
    ),
    gitBytes(workspaceReal, ["diff", "--name-only", "-z", "--no-renames"], signal).then(nulStrings),
  ])
  return {
    rootReal,
    workspaceReal,
    statusBefore,
    indexBefore,
    headRevision,
    baseRevision,
    headEntries: new Map([...headTree].map(([path, file]) => [path, gitFileEntry(file)])),
    indexRows: indexFiles(indexBefore),
    trackedPaths,
    untrackedPaths,
    worktreeChangedPaths,
  }
}

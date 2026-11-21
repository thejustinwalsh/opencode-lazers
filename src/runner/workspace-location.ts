import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

/** The native worktree parent shared by every checkout of one canonical project. */
export function canonicalProjectWorktreeParent(projectDirectory: string): string {
  return resolve(`${realpathSync(projectDirectory)}.worktrees`)
}

/** Propose a stable leaf under the canonical project's durable sibling parent. */
export function canonicalProjectWorktreePath(projectDirectory: string, leaf: string): string {
  return resolve(canonicalProjectWorktreeParent(projectDirectory), leaf)
}

function physicalWorkspace(path: string): string {
  let ancestor = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync(ancestor), ...missing)
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT") ||
        lstatSync(ancestor, { throwIfNoEntry: false }) !== undefined
      )
        throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

export const samePhysicalWorkspace = (left: string, right: string) => {
  try {
    return physicalWorkspace(left) === physicalWorkspace(right)
  } catch {
    return true
  }
}

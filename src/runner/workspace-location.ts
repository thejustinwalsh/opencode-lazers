import { realpathSync } from "node:fs"
import { resolve } from "node:path"

/** The native worktree parent shared by every checkout of one canonical project. */
export function canonicalProjectWorktreeParent(projectDirectory: string): string {
  return resolve(`${realpathSync(projectDirectory)}.worktrees`)
}

/** Propose a stable leaf under the canonical project's durable sibling parent. */
export function canonicalProjectWorktreePath(projectDirectory: string, leaf: string): string {
  return resolve(canonicalProjectWorktreeParent(projectDirectory), leaf)
}

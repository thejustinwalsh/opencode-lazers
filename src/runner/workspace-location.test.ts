import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canonicalProjectWorktreeParent,
  canonicalProjectWorktreePath,
} from "./workspace-location.ts"

test("project checkout aliases converge on the canonical sibling parent and projects stay isolated", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-workspace-location-")))
  const project = join(root, "project")
  const otherProject = join(root, "other-project")
  const alias = join(root, "project-alias")
  try {
    mkdirSync(project)
    mkdirSync(otherProject)
    symlinkSync(project, alias, "dir")

    const parent = `${project}.worktrees`
    expect(canonicalProjectWorktreeParent(project)).toBe(parent)
    expect(canonicalProjectWorktreeParent(alias)).toBe(parent)
    expect(canonicalProjectWorktreePath(project, "attempt")).toBe(join(parent, "attempt"))
    expect(canonicalProjectWorktreeParent(otherProject)).not.toBe(parent)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

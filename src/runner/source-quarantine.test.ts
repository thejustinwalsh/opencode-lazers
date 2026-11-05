import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { samePhysicalWorkspace } from "./source-quarantine.ts"

test("missing reserved workspaces remain distinct from existing retained worktrees", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-workspace-identity-"))
  try {
    const retained = join(root, "retained")
    const reserved = join(root, "new", "reserved")
    mkdirSync(retained)
    expect(samePhysicalWorkspace(reserved, retained)).toBe(false)
    expect(samePhysicalWorkspace(retained, reserved)).toBe(false)
    expect(samePhysicalWorkspace(reserved, reserved)).toBe(true)
    expect(samePhysicalWorkspace(reserved, join(root, "new", "other"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("existing symlink ancestors preserve identity for absent children", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-workspace-alias-"))
  try {
    const real = join(root, "real")
    const alias = join(root, "alias")
    mkdirSync(real)
    symlinkSync(real, alias)
    expect(samePhysicalWorkspace(real, alias)).toBe(true)
    expect(samePhysicalWorkspace(join(real, "future", "task"), join(alias, "future", "task"))).toBe(
      true,
    )
    expect(
      samePhysicalWorkspace(join(real, "future", "task"), join(alias, "future", "other")),
    ).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("unresolvable symlinks and filesystem errors remain conservative", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-workspace-unknown-"))
  try {
    const dangling = join(root, "dangling")
    symlinkSync(join(root, "missing-target"), dangling)
    expect(samePhysicalWorkspace(dangling, root)).toBe(true)
    expect(samePhysicalWorkspace(join(root, "invalid\0path"), root)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

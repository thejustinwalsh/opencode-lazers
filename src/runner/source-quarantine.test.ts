import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import {
  beginSourceGuard,
  samePhysicalWorkspace,
  sourceGuardInstalled,
  sourceGuardMatches,
} from "./source-quarantine.ts"

test("a failed replacement restores the surviving installed source guard", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-guard-survivor-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  const store = { repository }
  const a = beginSourceGuard({ directory: root, projectDirectory: root })
  a.install(store)
  expect(sourceGuardMatches(store, root, a.registrationID)).toBe(true)
  const b = beginSourceGuard({ directory: root, projectDirectory: root })
  try {
    expect(sourceGuardInstalled(store, root)).toBe(false)
    expect(sourceGuardMatches(store, root, a.registrationID)).toBe(false)
    b.dispose()
    // S1-1: a failed replacement must restore the surviving installed hook scope.
    expect(sourceGuardInstalled(store, root)).toBe(true)
    expect(sourceGuardMatches(store, root, a.registrationID)).toBe(true)
    expect(sourceGuardMatches(store, root, b.registrationID)).toBe(false)
  } finally {
    b.dispose()
    a.dispose()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("source guard disposal selects the latest installed survivor without reviving disposed scopes", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-guard-order-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  const store = { repository }
  const a = beginSourceGuard({ directory: root, projectDirectory: root })
  a.install(store)
  const b = beginSourceGuard({ directory: root, projectDirectory: root })
  b.install(store)
  const c = beginSourceGuard({ directory: root, projectDirectory: root })
  c.install(store)
  try {
    c.dispose()
    // S1-1: restoring the newest installed survivor keeps older scopes fenced.
    expect(sourceGuardMatches(store, root, b.registrationID)).toBe(true)
    expect(sourceGuardMatches(store, root, a.registrationID)).toBe(false)
    c.dispose()
    expect(sourceGuardMatches(store, root, b.registrationID)).toBe(true)
    a.dispose()
    expect(sourceGuardMatches(store, root, b.registrationID)).toBe(true)
    b.dispose()
    expect(sourceGuardInstalled(store, root)).toBe(false)
  } finally {
    c.dispose()
    b.dispose()
    a.dispose()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  }
})

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

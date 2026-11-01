import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { artifactExists, commitArtifact, git } from "./artifacts.ts"

test("artifact evidence accepts regular files and non-empty workspace-contained directories", () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-artifact-evidence-"))
  try {
    const lz37 = join(root, ".agents", "docs", "evidence", "037-artifact-evidence")
    mkdirSync(lz37, { recursive: true })
    writeFileSync(join(lz37, "verification.md"), "")
    expect(artifactExists(root, ".agents/docs/evidence/037-artifact-evidence")).toBe(true)
    expect(artifactExists(root, ".agents/docs/evidence/037-artifact-evidence/")).toBe(true)
    expect(
      artifactExists(root, ".agents/docs/evidence/037-artifact-evidence/verification.md"),
    ).toBe(true)

    const nested = join(root, "nested", "one", "two")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "empty.txt"), "")
    expect(artifactExists(root, "nested")).toBe(true)
    expect(artifactExists(root, "nested/")).toBe(true)
    expect(artifactExists(root, "nested/one/two/empty.txt")).toBe(true)

    mkdirSync(join(root, "empty"))
    mkdirSync(join(root, "empty-tree", "nested"), { recursive: true })
    expect(artifactExists(root, "empty")).toBe(false)
    expect(artifactExists(root, "empty-tree")).toBe(false)
    expect(artifactExists(root, "missing")).toBe(false)
    expect(artifactExists(root, "")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("artifact evidence never uses paths outside the workspace or follows symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-artifact-safe-"))
  const outside = mkdtempSync(join(tmpdir(), "lazers-artifact-outside-"))
  try {
    const outsideFile = join(outside, "proof.txt")
    writeFileSync(outsideFile, "proof")
    symlinkSync(outside, join(root, "ancestor-link"))
    symlinkSync(outsideFile, join(root, "leaf-link"))
    const linkedTree = join(root, "linked-tree")
    mkdirSync(linkedTree)
    symlinkSync(outsideFile, join(linkedTree, "proof.txt"))
    const linkedDirectoryTree = join(root, "linked-directory-tree")
    mkdirSync(linkedDirectoryTree)
    symlinkSync(outside, join(linkedDirectoryTree, "external-directory"))
    const mixedTree = join(root, "mixed-tree")
    mkdirSync(mixedTree)
    symlinkSync(outsideFile, join(mixedTree, "external.txt"))
    writeFileSync(join(mixedTree, "local.txt"), "")

    expect(artifactExists(root, "ancestor-link/proof.txt")).toBe(false)
    expect(artifactExists(root, "leaf-link")).toBe(false)
    expect(artifactExists(root, "linked-tree")).toBe(false)
    expect(artifactExists(root, "linked-directory-tree")).toBe(false)
    expect(artifactExists(root, "mixed-tree")).toBe(true)
    expect(artifactExists(root, outsideFile)).toBe(false)
    expect(artifactExists(root, "../outside/proof.txt")).toBe(false)
    expect(artifactExists(root, "https://example.invalid/proof.txt")).toBe(false)
    expect(artifactExists(root, "file:/outside/proof.txt")).toBe(false)
    expect(artifactExists(root, "C:/outside/proof.txt")).toBe(false)
    expect(artifactExists(root, "\\\\server\\share\\proof.txt")).toBe(false)

    const specialTree = join(root, "special-tree")
    mkdirSync(specialTree)
    const fifo = join(specialTree, "pipe")
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0)
    expect(artifactExists(root, "special-tree")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("worker commits are retained and their committed changes remain subject to scope checks", () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-worker-commit-"))
  try {
    git(root, ["init", "--initial-branch=main"])
    const commit = (message: string) =>
      git(root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        message,
      ])
    writeFileSync(join(root, "source.txt"), "baseline")
    git(root, ["add", "source.txt"])
    commit("baseline")
    const base = git(root, ["rev-parse", "HEAD"])
    writeFileSync(join(root, "source.txt"), "implemented")
    git(root, ["add", "source.txt"])
    commit("worker implementation")
    const head = git(root, ["rev-parse", "HEAD"])
    const artifact = commitArtifact(root, base, ["source.txt"])
    expect(artifact.commit).toBe(head)
    expect(artifact.paths).toEqual(["source.txt"])
    expect(() => commitArtifact(root, base, ["other.txt"])).toThrow("Out-of-scope")
    writeFileSync(join(root, "source.txt"), "repair")
    const dirty = commitArtifact(root, base, ["source.txt"])
    expect(git(root, ["rev-parse", `${dirty.commit}^`])).toBe(head)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("isolated rebases exclude reviewed main changes while retaining worker scope checks", () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-rebased-worker-"))
  try {
    git(root, ["init", "--initial-branch=main"])
    const commit = (message: string) => {
      git(root, ["add", "--all"])
      git(root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        message,
      ])
      return git(root, ["rev-parse", "HEAD"])
    }
    writeFileSync(join(root, "source.txt"), "baseline")
    const base = commit("baseline")
    git(root, ["checkout", "-b", "worker"])
    writeFileSync(join(root, "source.txt"), "worker implementation")
    commit("worker change")
    git(root, ["checkout", "main"])
    writeFileSync(join(root, "reviewed-other.txt"), "independent reviewed integration")
    const reviewed = commit("reviewed main change")
    git(root, ["checkout", "worker"])
    git(root, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=test@example.invalid",
      "rebase",
      "main",
    ])
    const candidate = git(root, ["rev-parse", "HEAD"])
    expect(commitArtifact(root, base, ["source.txt"], true, reviewed)).toEqual({
      commit: candidate,
      identity: candidate,
      paths: ["source.txt"],
      scopeBase: reviewed,
    })
    // Shared execution still compares against its admitted baseline.
    expect(() => commitArtifact(root, base, ["source.txt"], false, reviewed)).toThrow(
      "Out-of-scope",
    )
    expect(commitArtifact(root, reviewed, ["source.txt"], true, base).scopeBase).toBe(reviewed)
    writeFileSync(join(root, "escape.txt"), "unreviewed worker edit")
    expect(() => commitArtifact(root, base, ["source.txt"], true, reviewed)).toThrow("escape.txt")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

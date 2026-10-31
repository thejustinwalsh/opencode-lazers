import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitArtifact, git } from "./artifacts.ts"

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

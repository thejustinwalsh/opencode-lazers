import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  artifactExists,
  commitArtifact,
  git,
  verificationEnvironmentIdentity,
} from "./artifacts.ts"

test("verification identity uses runtime generations without hashing unrelated credentials", () => {
  const identity = verificationEnvironmentIdentity()
  const previous = process.env.LAZERS_IDENTITY_SECRET_CANARY
  const previousLanguage = process.env.LANG
  process.env.LAZERS_IDENTITY_SECRET_CANARY = "must-not-be-persisted-or-hashed"
  try {
    expect(verificationEnvironmentIdentity()).toBe(identity)
    expect(verificationEnvironmentIdentity("different-process-generation")).not.toBe(identity)
    expect(identity).not.toContain("must-not-be-persisted-or-hashed")
    process.env.LANG = `${previousLanguage ?? ""}.lazers-test`
    expect(verificationEnvironmentIdentity()).not.toBe(identity)
  } finally {
    if (previous === undefined) delete process.env.LAZERS_IDENTITY_SECRET_CANARY
    else process.env.LAZERS_IDENTITY_SECRET_CANARY = previous
    if (previousLanguage === undefined) delete process.env.LANG
    else process.env.LANG = previousLanguage
  }
})

function initRepository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  git(root, ["init", "--initial-branch=main"])
  git(root, ["config", "user.name", "fixture"])
  git(root, ["config", "user.email", "test@example.invalid"])
  return root
}

function commitAll(root: string, message: string): string {
  git(root, ["add", "--all"])
  git(root, ["commit", "-m", message])
  return git(root, ["rev-parse", "HEAD"])
}

function divergentBaselineFixture() {
  const root = initRepository("lazers-divergent-artifact-")
  try {
    writeFileSync(join(root, "origin.txt"), "shared origin")
    const origin = commitAll(root, "common origin")

    git(root, ["checkout", "-b", "admitted", origin])
    writeFileSync(join(root, "prerequisite.txt"), "admitted prerequisite")
    const base = commitAll(root, "admitted prerequisite baseline")

    git(root, ["checkout", "-b", "reviewed", origin])
    writeFileSync(join(root, "reviewed.txt"), "reviewed contribution")
    const incorporated = commitAll(root, "reviewed contribution")
    writeFileSync(join(root, "review-tail.txt"), "not merged into worker")
    const reviewedHead = commitAll(root, "unmerged reviewed tail")

    git(root, ["checkout", "-b", "worker", base])
    git(root, ["merge", "--no-ff", "--no-edit", incorporated])
    const workerHead = git(root, ["rev-parse", "HEAD"])
    return { root, origin, base, incorporated, reviewedHead, workerHead }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function treeHasPath(root: string, tree: string, path: string): boolean {
  try {
    git(root, ["cat-file", "-e", `${tree}:${path}`])
    return true
  } catch {
    return false
  }
}

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

test("divergent isolated repairs compare against the safe merge of admitted and incorporated work", () => {
  const fixture = divergentBaselineFixture()
  const { root, base, incorporated, reviewedHead, workerHead } = fixture
  try {
    expect(git(root, ["merge-base", workerHead, reviewedHead])).toBe(incorporated)
    expect(git(root, ["merge-base", base, incorporated])).toBe(fixture.origin)

    // Shared execution still measures from the admitted base, not isolated review ancestry.
    expect(() => commitArtifact(root, base, ["repair/**"], false, reviewedHead)).toThrow(
      "reviewed.txt",
    )

    mkdirSync(join(root, "repair"), { recursive: true })
    writeFileSync(join(root, "repair", "fix.ts"), "repair")
    const artifact = commitArtifact(root, base, ["repair/**"], true, reviewedHead)

    expect(artifact.paths).toEqual(["repair/fix.ts"])
    expect(artifact.commit).toBe(artifact.identity)
    expect(git(root, ["rev-parse", `${artifact.commit}^`])).toBe(workerHead)
    expect(git(root, ["cat-file", "-t", artifact.scopeBase])).toBe("tree")
    expect(treeHasPath(root, artifact.scopeBase, "prerequisite.txt")).toBe(true)
    expect(treeHasPath(root, artifact.scopeBase, "reviewed.txt")).toBe(true)
    expect(treeHasPath(root, artifact.scopeBase, "review-tail.txt")).toBe(false)
    expect(treeHasPath(root, workerHead, "review-tail.txt")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("edits to reviewed paths and unauthorized files remain violations in every Git state", () => {
  const variants = ["committed", "staged", "unstaged", "untracked"] as const
  for (const variant of variants) {
    const fixture = divergentBaselineFixture()
    const { root, base, reviewedHead, workerHead } = fixture
    try {
      if (variant === "untracked") {
        writeFileSync(join(root, "unauthorized.txt"), "untracked worker change")
      } else {
        writeFileSync(join(root, "reviewed.txt"), `worker edit: ${variant}`)
        if (variant === "staged") git(root, ["add", "reviewed.txt"])
        if (variant === "committed") commitAll(root, "unauthorized reviewed-path edit")
      }

      const violation = variant === "untracked" ? "unauthorized.txt" : "reviewed.txt"
      expect(() => commitArtifact(root, base, ["repair/**"], true, reviewedHead)).toThrow(violation)
      if (variant === "committed") {
        expect(git(root, ["rev-parse", "HEAD"])).not.toBe(workerHead)
      } else {
        expect(git(root, ["rev-parse", "HEAD"])).toBe(workerHead)
      }
      if (variant === "staged")
        expect(git(root, ["diff", "--cached", "--name-only"])).toBe("reviewed.txt")
      if (variant === "unstaged") expect(git(root, ["diff", "--name-only"])).toBe("reviewed.txt")
      if (variant === "untracked")
        expect(git(root, ["ls-files", "--others", "--exclude-standard"])).toBe("unauthorized.txt")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test("reviewed content copied without shared ancestry is not exempted", () => {
  const root = initRepository("lazers-copied-reviewed-artifact-")
  try {
    writeFileSync(join(root, "origin.txt"), "shared origin")
    const origin = commitAll(root, "common origin")
    git(root, ["checkout", "-b", "admitted", origin])
    writeFileSync(join(root, "prerequisite.txt"), "admitted prerequisite")
    const base = commitAll(root, "admitted prerequisite")
    git(root, ["checkout", "-b", "reviewed", origin])
    writeFileSync(join(root, "copied.txt"), "main content")
    const reviewedHead = commitAll(root, "reviewed main content")
    git(root, ["checkout", "-b", "worker", base])
    writeFileSync(join(root, "copied.txt"), "main content")
    const workerHead = commitAll(root, "copy reviewed content without ancestry")

    expect(git(root, ["merge-base", workerHead, reviewedHead])).toBe(origin)
    expect(() => commitArtifact(root, base, ["repair/**"], true, reviewedHead)).toThrow(
      "copied.txt",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("conflicting virtual baselines fail before staging even when the worker resolved its merge", () => {
  const root = initRepository("lazers-conflicting-artifact-baseline-")
  try {
    writeFileSync(join(root, "conflict.txt"), "origin")
    const origin = commitAll(root, "common origin")
    git(root, ["checkout", "-b", "admitted", origin])
    writeFileSync(join(root, "conflict.txt"), "admitted")
    const base = commitAll(root, "admitted conflict side")
    git(root, ["checkout", "-b", "reviewed", origin])
    writeFileSync(join(root, "conflict.txt"), "reviewed")
    const reviewedHead = commitAll(root, "reviewed conflict side")

    git(root, ["checkout", "-b", "worker", base])
    expect(() => git(root, ["merge", "--no-ff", "--no-commit", reviewedHead])).toThrow()
    writeFileSync(join(root, "conflict.txt"), "worker-resolved merge")
    git(root, ["add", "conflict.txt"])
    git(root, ["commit", "-m", "worker resolved the conflict"])
    const workerHead = git(root, ["rev-parse", "HEAD"])
    mkdirSync(join(root, "repair"), { recursive: true })
    writeFileSync(join(root, "repair", "allowed.ts"), "must remain unstaged")

    expect(() => commitArtifact(root, base, ["repair/**"], true, reviewedHead)).toThrow(
      "conflict-free reviewed artifact baseline",
    )
    expect(git(root, ["rev-parse", "HEAD"])).toBe(workerHead)
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("")
    expect(git(root, ["ls-files", "--others", "--exclude-standard"])).toBe("repair/allowed.ts")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("ambiguous reviewed ancestry fails closed before staging", () => {
  const root = initRepository("lazers-ambiguous-artifact-baseline-")
  try {
    writeFileSync(join(root, "origin.txt"), "origin")
    const origin = commitAll(root, "common origin")
    git(root, ["checkout", "-b", "first", origin])
    writeFileSync(join(root, "first.txt"), "first")
    const first = commitAll(root, "first side")
    git(root, ["checkout", "-b", "second", origin])
    writeFileSync(join(root, "second.txt"), "second")
    const second = commitAll(root, "second side")

    git(root, ["checkout", "first"])
    git(root, ["merge", "--no-ff", "--no-edit", second])
    const workerHead = git(root, ["rev-parse", "HEAD"])
    git(root, ["checkout", "second"])
    git(root, ["merge", "--no-ff", "--no-edit", first])
    const reviewedHead = git(root, ["rev-parse", "HEAD"])
    expect(git(root, ["merge-base", "--all", workerHead, reviewedHead]).split("\n")).toHaveLength(2)

    git(root, ["checkout", "first"])
    mkdirSync(join(root, "repair"), { recursive: true })
    writeFileSync(join(root, "repair", "allowed.ts"), "must remain unstaged")
    expect(() => commitArtifact(root, origin, ["repair/**"], true, reviewedHead)).toThrow(
      "unique merge base",
    )
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("")
    expect(git(root, ["ls-files", "--others", "--exclude-standard"])).toBe("repair/allowed.ts")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

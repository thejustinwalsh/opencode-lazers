import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "bun:test"
import { verifyContribution } from "./verify-runntime-contribution.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function command(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args])
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().trim()
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

interface Fixture {
  stage: string
  repository: string
  baseCommit: string
  manifest: Record<string, unknown>
  patchPaths: string[]
}

function fixture(
  options: {
    outsideScope?: boolean
    sourcePath?: string
    stage?: "d1-reference" | "d1-safety-correction"
  } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "runntime-contribution-test-"))
  temporaryDirectories.push(root)
  const repository = join(root, "runntime")
  const contributionStage = options.stage ?? "d1-reference"
  const stage = join(root, "contributions", contributionStage)
  mkdirSync(repository)
  mkdirSync(join(stage, "patches"), { recursive: true })
  mkdirSync(join(stage, "evidence"), { recursive: true })
  command(repository, "init", "--quiet", "--initial-branch=main")
  command(repository, "config", "user.name", "Verifier Test")
  command(repository, "config", "user.email", "verifier@example.invalid")

  const sourcePath = options.outsideScope
    ? "README.md"
    : (options.sourcePath ?? "packages/runntime/src/zoo/d1/model.ts")
  const source = join(repository, sourcePath)
  mkdirSync(join(source, ".."), { recursive: true })
  writeFileSync(source, "base\n")
  command(repository, "add", sourcePath)
  command(repository, "commit", "--quiet", "-m", "base")
  const baseCommit = command(repository, "rev-parse", "HEAD")
  const baseTree = command(repository, "rev-parse", "HEAD^{tree}")

  writeFileSync(source, "first\n")
  command(repository, "add", sourcePath)
  command(repository, "commit", "--quiet", "-m", "fix: retain first behavior")
  const firstCommit = command(repository, "rev-parse", "HEAD")

  const secondPath = "packages/runntime/test/zoo/d1/model.test.ts"
  mkdirSync(join(repository, "packages/runntime/test/zoo/d1"), { recursive: true })
  writeFileSync(join(repository, secondPath), "second\n")
  command(repository, "add", secondPath)
  command(repository, "commit", "--quiet", "-m", "test: retain second behavior")
  const secondCommit = command(repository, "rev-parse", "HEAD")

  const commits = [firstCommit, secondCommit]
  const patchPaths: string[] = []
  let parent = baseCommit
  const patches = commits.map((commit, index) => {
    const patch = command(
      repository,
      "format-patch",
      "--stdout",
      "--full-index",
      "--binary",
      "-1",
      commit,
    )
    const path = `patches/${String(index + 1).padStart(4, "0")}.patch`
    const bytes = Buffer.from(patch)
    writeFileSync(join(stage, path), bytes)
    patchPaths.push(join(stage, path))
    const tree = command(repository, "rev-parse", `${commit}^{tree}`)
    const current = { commit, parent, tree, path, sha256: sha256(bytes) }
    parent = commit
    return current
  })

  const evidence = [
    { kind: "unit", command: "pnpm --filter runntime test:unit", file: "evidence/unit.txt" },
    { kind: "gpu", command: "pnpm --filter runntime test:gpu", file: "evidence/gpu.txt" },
    ...(contributionStage === "d1-safety-correction"
      ? [
          {
            kind: "typecheck",
            command: "pnpm --filter runntime typecheck",
            file: "evidence/typecheck.txt",
          },
          { kind: "lint", command: "pnpm lint", file: "evidence/lint.txt" },
          { kind: "build", command: "pnpm --filter runntime build", file: "evidence/build.txt" },
        ]
      : []),
  ].map((check) => {
    const bytes = Buffer.from(`${check.kind} checks passed\n`)
    writeFileSync(join(stage, check.file), bytes)
    return {
      kind: check.kind,
      command: check.command,
      exitCode: 0,
      path: check.file,
      sha256: sha256(bytes),
    }
  })

  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    stage: contributionStage,
    base: { repository: "local test repository", commit: baseCommit, tree: baseTree },
    tip: { commit: secondCommit, tree: command(repository, "rev-parse", "HEAD^{tree}") },
    patches,
    checks: evidence,
  }
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2))
  return { stage, repository, baseCommit, manifest, patchPaths }
}

function saveManifest(stage: string, manifest: Record<string, unknown>): void {
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2))
}

describe("ruNNtime contribution reconstruction", () => {
  it("replays each actual commit tree in order from the exact base", () => {
    const test = fixture()
    const result = verifyContribution({
      stageDirectory: test.stage,
      repositoryDirectory: test.repository,
      expectedBaseCommit: test.baseCommit,
    })
    expect(result.patchesApplied).toBe(2)
    expect(result.tipCommit).toBe((test.manifest.tip as { commit: string }).commit)
    expect(result.checks).toEqual(["unit", "gpu"])
  })

  it("rejects patches recorded out of commit order", () => {
    const test = fixture()
    const manifest = test.manifest
    manifest.patches = [...(manifest.patches as unknown[]).reverse()]
    saveManifest(test.stage, manifest)
    expect(() =>
      verifyContribution({
        stageDirectory: test.stage,
        repositoryDirectory: test.repository,
        expectedBaseCommit: test.baseCommit,
      }),
    ).toThrow("out of order")
  })

  it("rejects patches that touch paths outside the assigned sibling scope", () => {
    const test = fixture({ outsideScope: true })
    expect(() =>
      verifyContribution({
        stageDirectory: test.stage,
        repositoryDirectory: test.repository,
        expectedBaseCommit: test.baseCommit,
      }),
    ).toThrow("escapes write scope")
  })

  it("uses the safety-correction base and permits scoped executor ownership fixes", () => {
    const test = fixture({
      stage: "d1-safety-correction",
      sourcePath: "packages/runntime/src/core/nn/layers.ts",
    })
    expect(() =>
      verifyContribution({
        stageDirectory: test.stage,
        repositoryDirectory: test.repository,
      }),
    ).toThrow("base commit mismatch: expected 735fbd94195a8c2a7c40a12aec6b86fa34ebd48c")

    const result = verifyContribution({
      stageDirectory: test.stage,
      repositoryDirectory: test.repository,
      expectedBaseCommit: test.baseCommit,
    })
    expect(result.stage).toBe("d1-safety-correction")
    expect(result.patchesApplied).toBe(2)
    expect(result.checks).toContain("typecheck")
    expect(result.checks).toContain("build")

    const graph = fixture({
      stage: "d1-safety-correction",
      sourcePath: "packages/runntime/src/core/graph/evalCore.ts",
    })
    expect(
      verifyContribution({
        stageDirectory: graph.stage,
        repositoryDirectory: graph.repository,
        expectedBaseCommit: graph.baseCommit,
      }).stage,
    ).toBe("d1-safety-correction")

    const escaped = fixture({ stage: "d1-safety-correction", outsideScope: true })
    expect(() =>
      verifyContribution({
        stageDirectory: escaped.stage,
        repositoryDirectory: escaped.repository,
        expectedBaseCommit: escaped.baseCommit,
      }),
    ).toThrow("escapes write scope")
  })

  it("rejects a base commit or tree identity that differs from the expected starting point", () => {
    const test = fixture()
    expect(() =>
      verifyContribution({
        stageDirectory: test.stage,
        repositoryDirectory: test.repository,
        expectedBaseCommit: "0".repeat(40),
      }),
    ).toThrow("base commit mismatch")

    const manifest = test.manifest
    manifest.base = { ...(manifest.base as object), tree: "0".repeat(40) }
    saveManifest(test.stage, manifest)
    expect(() =>
      verifyContribution({
        stageDirectory: test.stage,
        repositoryDirectory: test.repository,
        expectedBaseCommit: test.baseCommit,
      }),
    ).toThrow("base tree does not match")
  })

  it("rejects modified, missing, or tree-incomplete patches", () => {
    const changed = fixture()
    const patchPath = changed.patchPaths[0]!
    writeFileSync(patchPath, `${readFileSync(patchPath, "utf8")}\n# changed\n`)
    expect(() =>
      verifyContribution({
        stageDirectory: changed.stage,
        repositoryDirectory: changed.repository,
        expectedBaseCommit: changed.baseCommit,
      }),
    ).toThrow("patch digest mismatch")

    const missing = fixture()
    rmSync(missing.patchPaths[1]!)
    expect(() =>
      verifyContribution({
        stageDirectory: missing.stage,
        repositoryDirectory: missing.repository,
        expectedBaseCommit: missing.baseCommit,
      }),
    ).toThrow()

    const incomplete = fixture()
    const changedPatch = readFileSync(incomplete.patchPaths[0]!, "utf8").replace(
      "+first\n",
      "+incomplete\n",
    )
    const bytes = Buffer.from(changedPatch)
    writeFileSync(incomplete.patchPaths[0]!, bytes)
    const manifest = incomplete.manifest
    const patches = manifest.patches
    if (!Array.isArray(patches) || !isRecord(patches[0]))
      throw new Error("test manifest has no first patch")
    patches[0].sha256 = sha256(bytes)
    saveManifest(incomplete.stage, manifest)
    expect(() =>
      verifyContribution({
        stageDirectory: incomplete.stage,
        repositoryDirectory: incomplete.repository,
        expectedBaseCommit: incomplete.baseCommit,
      }),
    ).toThrow("reconstructed")
  })

  it("rejects tampered check evidence and an incomplete quality check set", () => {
    const changedEvidence = fixture({ stage: "d1-safety-correction" })
    writeFileSync(
      join(changedEvidence.stage, "evidence/typecheck.txt"),
      "modified typecheck evidence\n",
    )
    expect(() =>
      verifyContribution({
        stageDirectory: changedEvidence.stage,
        repositoryDirectory: changedEvidence.repository,
        expectedBaseCommit: changedEvidence.baseCommit,
      }),
    ).toThrow("check evidence digest mismatch")

    for (const missingKind of ["unit", "gpu", "typecheck", "lint"]) {
      const incomplete = fixture({ stage: "d1-safety-correction" })
      const manifest = incomplete.manifest
      if (!Array.isArray(manifest.checks)) throw new Error("test manifest has no checks")
      manifest.checks = manifest.checks.filter(
        (check) => isRecord(check) && check.kind !== missingKind,
      )
      saveManifest(incomplete.stage, manifest)
      expect(() =>
        verifyContribution({
          stageDirectory: incomplete.stage,
          repositoryDirectory: incomplete.repository,
          expectedBaseCommit: incomplete.baseCommit,
        }),
      ).toThrow("passing unit, GPU, typecheck and lint evidence")
    }
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

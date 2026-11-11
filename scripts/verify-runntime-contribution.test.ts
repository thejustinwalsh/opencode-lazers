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

function fixture(options: { outsideScope?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "runntime-contribution-test-"))
  temporaryDirectories.push(root)
  const repository = join(root, "runntime")
  const stage = join(root, "contributions", "d1-reference")
  mkdirSync(repository)
  mkdirSync(join(stage, "patches"), { recursive: true })
  mkdirSync(join(stage, "evidence"), { recursive: true })
  command(repository, "init", "--quiet", "--initial-branch=main")
  command(repository, "config", "user.name", "Verifier Test")
  command(repository, "config", "user.email", "verifier@example.invalid")

  const sourcePath = options.outsideScope ? "README.md" : "packages/runntime/src/zoo/d1/model.ts"
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
    stage: "d1-reference",
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

  it("rejects tampered check evidence and an incomplete unit/GPU check set", () => {
    const changedEvidence = fixture()
    writeFileSync(join(changedEvidence.stage, "evidence/unit.txt"), "modified unit evidence\n")
    expect(() =>
      verifyContribution({
        stageDirectory: changedEvidence.stage,
        repositoryDirectory: changedEvidence.repository,
        expectedBaseCommit: changedEvidence.baseCommit,
      }),
    ).toThrow("check evidence digest mismatch")

    const missingGpuCheck = fixture()
    const manifest = missingGpuCheck.manifest
    if (!Array.isArray(manifest.checks)) throw new Error("test manifest has no checks")
    manifest.checks = manifest.checks.filter((check) => isRecord(check) && check.kind === "unit")
    saveManifest(missingGpuCheck.stage, manifest)
    expect(() =>
      verifyContribution({
        stageDirectory: missingGpuCheck.stage,
        repositoryDirectory: missingGpuCheck.repository,
        expectedBaseCommit: missingGpuCheck.baseCommit,
      }),
    ).toThrow("passing unit and GPU evidence")
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

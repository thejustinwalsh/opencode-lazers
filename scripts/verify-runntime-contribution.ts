/** Reconstructs a retained ruNNtime patch series from its exact sibling base. */

import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const STAGES = {
  "d1-reference": {
    baseCommit: "68f3a12506bada2c9ac6cb3629426f3e06a56349",
    directory: "contributions/runntime/d1-reference",
    allowedPaths: [
      "packages/runntime/src/zoo/d1/",
      "packages/runntime/src/core/gpu/dispatch/shape.ts",
      "packages/runntime/src/core/gpu/dispatch/spec.ts",
      "packages/runntime/src/core/gpu/eval.ts",
      "packages/runntime/test/",
      "packages/runntime/playground/d1/",
    ],
  },
  "d1-safety-correction": {
    baseCommit: "735fbd94195a8c2a7c40a12aec6b86fa34ebd48c",
    directory: "contributions/runntime/d1-safety-correction",
    allowedPaths: [
      "packages/runntime/src/zoo/d1/",
      "packages/runntime/src/core/gpu/",
      "packages/runntime/src/core/graph/evalCore.ts",
      "packages/runntime/src/core/nn/layers.ts",
      "packages/runntime/test/",
      "packages/runntime/playground/d1/",
    ],
  },
  "d1-q8": {
    baseCommit: "fd28773ca30facdaf6e56d8e9fba06e242ff623d",
    directory: "contributions/runntime/d1-q8",
    allowedPaths: [
      "packages/runntime/src/zoo/",
      "packages/runntime/test/zoo/d1/",
      "packages/runntime/test/core/weights/",
      "packages/runntime/playground/d1/",
      "tools/python/",
      "apps/docs/astro.config.mjs",
      "apps/docs/src/content/docs/zoo/",
    ],
  },
  "lfm3-base-chat": {
    baseCommit: "f394a74fdaf1b78625039ee8a39bfe95ba5548ac",
    directory: "contributions/runntime/lfm3-base-chat",
    allowedPaths: [
      "README.md",
      "apps/docs/astro.config.mjs",
      "apps/docs/src/content/docs/zoo/lfm3-chat.mdx",
      "packages/runntime/src/core/gpu/dispatch/conv.ts",
      "packages/runntime/src/core/gpu/dispatch/elementwise.ts",
      "packages/runntime/src/core/gpu/dispatch/registry.ts",
      "packages/runntime/src/core/graph/ops.ts",
      "packages/runntime/src/core/graph/ops/conv/conv1d.ts",
      "packages/runntime/src/core/graph/ops/elementwise.ts",
      "packages/runntime/src/core/graph/value.ts",
      "packages/runntime/src/core/index.ts",
      "packages/runntime/src/core/kernels/conv/depthwiseConv1d.ts",
      "packages/runntime/src/core/kernels/elementwise/elementwiseF32.ts",
      "packages/runntime/src/zoo/index.ts",
      "packages/runntime/src/zoo/models.ts",
      "packages/runntime/src/zoo/tasks/nlp/lfm3.ts",
      "packages/runntime/src/zoo/lfm3/",
      "packages/runntime/test/core/graph/ops/conv/depthwiseConv1d.test.ts",
      "packages/runntime/test/core/graph/ops/elementwise.test.ts",
      "packages/runntime/test/core/kernels/conv/depthwiseConv1d.gpu.test.ts",
      "packages/runntime/test/core/kernels/elementwise/elementwiseF32.gpu.test.ts",
      "packages/runntime/test/zoo/lfm3/",
      "packages/runntime/playground/lfm3/",
    ],
  },
  "lfm3-base-audio": {
    baseCommit: "e8a4604d5d2603b20447c334ca0a6d6c5edc1374",
    directory: "contributions/runntime/lfm3-base-audio",
    allowedPaths: [
      "README.md",
      "apps/docs/astro.config.mjs",
      "apps/docs/src/content/docs/zoo/lfm3-audio.mdx",
      "apps/docs/src/content/docs/zoo/lfm3-chat.mdx",
      "packages/runntime/playground/lfm3/",
      "packages/runntime/src/core/gpu/dispatch/conv.ts",
      "packages/runntime/src/core/gpu/dispatch/registry.ts",
      "packages/runntime/src/core/graph/ops/conv/conv1d.ts",
      "packages/runntime/src/core/graph/ops/conv/conv2d.ts",
      "packages/runntime/src/core/kernels/conv/",
      "packages/runntime/src/zoo/index.ts",
      "packages/runntime/src/zoo/lfm3/",
      "packages/runntime/src/zoo/models.ts",
      "packages/runntime/src/zoo/tasks/audio/lfm3.ts",
      "packages/runntime/src/zoo/tasks/nlp/lfm3.ts",
      "packages/runntime/test/core/graph/ops/conv/",
      "packages/runntime/test/core/kernels/conv/",
      "packages/runntime/test/zoo/lfm3/",
    ],
  },
  "omni-published-chat": {
    baseCommit: "e8a4604d5d2603b20447c334ca0a6d6c5edc1374",
    directory: "contributions/runntime/omni-published-chat",
    allowedPaths: [
      "README.md",
      "apps/docs/src/content/docs/zoo/lfm3-chat.mdx",
      "packages/runntime/src/core/gpu/dispatch/matmul.ts",
      "packages/runntime/src/core/graph/ops/matmul.ts",
      "packages/runntime/src/core/index.ts",
      "packages/runntime/src/core/kernels/matmul/",
      "packages/runntime/src/core/kernels/quantCommon.ts",
      "packages/runntime/src/core/nn/layers.ts",
      "packages/runntime/src/core/nn/loadStateDict.ts",
      "packages/runntime/src/core/nn/module.ts",
      "packages/runntime/src/core/weights/gguf.ts",
      "packages/runntime/src/core/weights/safetensors.ts",
      "packages/runntime/src/core/weights/sha256.ts",
      "packages/runntime/src/core/weights/transforms.ts",
      "packages/runntime/src/zoo/lfm3/gguf.ts",
      "packages/runntime/src/zoo/lfm3/model.ts",
      "packages/runntime/src/zoo/models.ts",
      "packages/runntime/src/zoo/tasks/nlp/lfm3.ts",
      "packages/runntime/test/core/graph/ops/matmul.test.ts",
      "packages/runntime/test/core/kernels/matmul/",
      "packages/runntime/test/core/nn/layers.test.ts",
      "packages/runntime/test/core/nn/loadStateDict.test.ts",
      "packages/runntime/test/core/weights/gguf.test.ts",
      "packages/runntime/test/core/weights/sha256.test.ts",
      "packages/runntime/test/core/weights/transforms.test.ts",
      "packages/runntime/test/zoo/lfm3/liquid-reference.gpu.test.ts",
      "packages/runntime/test/zoo/lfm3/liquid-reference.json",
      "packages/runntime/test/zoo/lfm3/native-reference.gpu.test.ts",
      "packages/runntime/test/zoo/lfm3/packed-consumer.mjs",
      "packages/runntime/test/zoo/lfm3/public.gpu.test.ts",
      "packages/runntime/test/zoo/lfm3/recovery.gpu.test.ts",
      "packages/runntime/test/zoo/lfm3/stateDictHooks.test.ts",
    ],
  },
  "omni-published-audio": {
    baseCommit: "b824c956ad79a9273876d27c2ac1b09fc8fa19cc",
    directory: "contributions/runntime/omni-published-audio",
    allowedPaths: [
      "apps/docs/astro.config.mjs",
      "apps/docs/src/content/docs/zoo/lfm3-audio.mdx",
      "packages/runntime/src/core/weights/gguf.ts",
      "packages/runntime/src/zoo/index.ts",
      "packages/runntime/src/zoo/lfm3/",
      "packages/runntime/src/zoo/models.ts",
      "packages/runntime/src/zoo/tasks/audio/lfm3.ts",
      "packages/runntime/src/zoo/tasks/nlp/lfm3.ts",
      "packages/runntime/test/core/weights/gguf.test.ts",
      "packages/runntime/test/zoo/lfm3/",
    ],
  },
  "lfm3-voice": {
    baseCommit: "68e9e608dda71aad6c41263d435ed262d2a32de3",
    directory: "contributions/runntime/lfm3-voice",
    allowedPaths: [
      "packages/runntime/src/zoo/index.ts",
      "packages/runntime/src/zoo/lfm3/audio/prompts.ts",
      "packages/runntime/src/zoo/tasks/audio/lfm3.ts",
      "packages/runntime/test/zoo/lfm3/audio/prompts.test.ts",
    ],
  },
} as const
type ContributionStage = keyof typeof STAGES
const HASH = /^[a-f0-9]{40}$/
const DIGEST = /^[a-f0-9]{64}$/

interface PatchRecord {
  commit: string
  parent: string
  tree: string
  path: string
  sha256: string
}

interface EvidenceRecord {
  kind:
    | "unit"
    | "gpu"
    | "typecheck"
    | "lint"
    | "build"
    | "conversion"
    | "parity"
    | "package"
    | "resource"
  command: string
  exitCode: number
  path: string
  sha256: string
}

interface Manifest {
  schemaVersion: 1
  stage: ContributionStage
  base: { repository: string; commit: string; tree: string }
  tip: { commit: string; tree: string }
  patches: PatchRecord[]
  checks: EvidenceRecord[]
}

export interface VerifyOptions {
  stageDirectory: string
  repositoryDirectory: string
  expectedBaseCommit?: string
}

export interface VerifyResult {
  stage: string
  baseCommit: string
  baseTree: string
  tipCommit: string
  reconstructedTree: string
  patchesApplied: number
  checks: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isContributionStage(value: unknown): value is ContributionStage {
  return typeof value === "string" && Object.hasOwn(STAGES, value)
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where} must be an object`)
  return value
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where} must be nonempty`)
  return value
}

function hash(value: unknown, where: string): string {
  const result = string(value, where)
  if (!HASH.test(result)) throw new Error(`${where} must be a 40-character lowercase Git hash`)
  return result
}

function digest(value: unknown, where: string): string {
  const result = string(value, where)
  if (!DIGEST.test(result))
    throw new Error(`${where} must be a 64-character lowercase SHA-256 digest`)
  return result
}

function safeArtifactPath(value: unknown, where: string): string {
  const path = string(value, where)
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${where} must be a normalized relative path`)
  }
  return path
}

function run(command: string, args: string[], cwd?: string): string {
  const result = Bun.spawnSync([command, ...args], { cwd })
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString().trim()}`,
    )
  }
  return result.stdout.toString().trim()
}

function git(repository: string, ...args: string[]): string {
  return run("git", ["-C", repository, ...args])
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function allowedPath(path: string, stage: ContributionStage): boolean {
  return STAGES[stage].allowedPaths.some((prefix) =>
    prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix,
  )
}

function patchPaths(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
    paths.push(match[1]!, match[2]!)
  }
  if (paths.length === 0) throw new Error("patch contains no Git file sections")
  return paths
}

function readManifest(stageDirectory: string): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(join(stageDirectory, "manifest.json"), "utf8"))
  const root = record(parsed, "manifest")
  if (root.schemaVersion !== 1) throw new Error("manifest.schemaVersion must be 1")
  if (!isContributionStage(root.stage)) {
    throw new Error(`manifest.stage must be one of ${Object.keys(STAGES).join(", ")}`)
  }
  const stage = root.stage

  const base = record(root.base, "manifest.base")
  const tip = record(root.tip, "manifest.tip")
  if (!Array.isArray(root.patches) || root.patches.length === 0) {
    throw new Error("manifest.patches must contain the complete nonempty series")
  }
  if (!Array.isArray(root.checks)) throw new Error("manifest.checks must be an array")

  const patches = root.patches.map((item, index): PatchRecord => {
    const patch = record(item, `manifest.patches[${index}]`)
    return {
      commit: hash(patch.commit, `manifest.patches[${index}].commit`),
      parent: hash(patch.parent, `manifest.patches[${index}].parent`),
      tree: hash(patch.tree, `manifest.patches[${index}].tree`),
      path: safeArtifactPath(patch.path, `manifest.patches[${index}].path`),
      sha256: digest(patch.sha256, `manifest.patches[${index}].sha256`),
    }
  })

  const checks = root.checks.map((item, index): EvidenceRecord => {
    const check = record(item, `manifest.checks[${index}]`)
    if (
      check.kind !== "unit" &&
      check.kind !== "gpu" &&
      check.kind !== "typecheck" &&
      check.kind !== "lint" &&
      check.kind !== "build" &&
      check.kind !== "conversion" &&
      check.kind !== "parity" &&
      check.kind !== "package" &&
      check.kind !== "resource"
    ) {
      throw new Error(
        `manifest.checks[${index}].kind must be unit, gpu, typecheck, lint, build, conversion, parity, package or resource`,
      )
    }
    if (check.exitCode !== 0) throw new Error(`manifest.checks[${index}] did not pass`)
    return {
      kind: check.kind,
      command: string(check.command, `manifest.checks[${index}].command`),
      exitCode: 0,
      path: safeArtifactPath(check.path, `manifest.checks[${index}].path`),
      sha256: digest(check.sha256, `manifest.checks[${index}].sha256`),
    }
  })

  return {
    schemaVersion: 1,
    stage,
    base: {
      repository: string(base.repository, "manifest.base.repository"),
      commit: hash(base.commit, "manifest.base.commit"),
      tree: hash(base.tree, "manifest.base.tree"),
    },
    tip: {
      commit: hash(tip.commit, "manifest.tip.commit"),
      tree: hash(tip.tree, "manifest.tip.tree"),
    },
    patches,
    checks,
  }
}

function verifyEvidence(
  stageDirectory: string,
  stage: ContributionStage,
  checks: EvidenceRecord[],
): string[] {
  const kinds = new Set<EvidenceRecord["kind"]>()
  for (const check of checks) {
    const path = resolve(stageDirectory, check.path)
    if (!path.startsWith(`${resolve(stageDirectory)}${sep}`)) {
      throw new Error(`check evidence escapes the contribution: ${check.path}`)
    }
    const bytes = readFileSync(path)
    if (sha256(bytes) !== check.sha256)
      throw new Error(`check evidence digest mismatch: ${check.path}`)
    kinds.add(check.kind)
  }
  const required: EvidenceRecord["kind"][] =
    stage === "d1-safety-correction"
      ? ["unit", "gpu", "typecheck", "lint"]
      : stage === "lfm3-voice"
        ? ["unit", "typecheck", "build", "package"]
        : stage === "d1-q8" ||
            stage === "lfm3-base-chat" ||
            stage === "lfm3-base-audio" ||
            stage === "omni-published-chat" ||
            stage === "omni-published-audio"
          ? [
              "unit",
              "gpu",
              "typecheck",
              "lint",
              "build",
              "conversion",
              "parity",
              "package",
              "resource",
            ]
          : ["unit", "gpu"]
  if (required.some((kind) => !kinds.has(kind))) {
    const expected =
      stage === "d1-safety-correction"
        ? "unit, GPU, typecheck and lint"
        : stage === "lfm3-voice"
          ? "unit, typecheck, build and package"
          : stage === "d1-q8" ||
              stage === "lfm3-base-chat" ||
              stage === "lfm3-base-audio" ||
              stage === "omni-published-chat" ||
              stage === "omni-published-audio"
            ? "unit, GPU, typecheck, lint, build, conversion, parity, package and resource"
            : "unit and GPU"
    throw new Error(`retained checks must include passing ${expected} evidence`)
  }
  return checks.map((check) => check.kind)
}

/** Validates, applies and compares every retained patch against the sibling commits. */
export function verifyContribution(options: VerifyOptions): VerifyResult {
  const stageDirectory = resolve(options.stageDirectory)
  const repository = resolve(options.repositoryDirectory)
  const manifest = readManifest(stageDirectory)
  const expectedBase = options.expectedBaseCommit ?? STAGES[manifest.stage].baseCommit
  if (manifest.base.commit !== expectedBase) {
    throw new Error(`base commit mismatch: expected ${expectedBase}, got ${manifest.base.commit}`)
  }

  const sourceBase = git(repository, "rev-parse", "--verify", `${manifest.base.commit}^{commit}`)
  if (sourceBase !== manifest.base.commit) throw new Error("base commit identity changed")
  const sourceBaseTree = git(repository, "rev-parse", `${manifest.base.commit}^{tree}`)
  if (sourceBaseTree !== manifest.base.tree)
    throw new Error("base tree does not match the sibling repository")

  let parent = manifest.base.commit
  for (const [index, patch] of manifest.patches.entries()) {
    if (patch.parent !== parent)
      throw new Error(`patch ${index + 1} is out of order or has the wrong parent`)
    const sourceParents = git(repository, "show", "-s", "--format=%P", patch.commit)
      .split(" ")
      .filter(Boolean)
    if (sourceParents.length !== 1 || sourceParents[0] !== patch.parent) {
      throw new Error(`patch ${index + 1} parent does not match commit history`)
    }
    const sourceTree = git(repository, "show", "-s", "--format=%T", patch.commit)
    if (sourceTree !== patch.tree)
      throw new Error(`patch ${index + 1} tree does not match commit history`)
    parent = patch.commit
  }
  if (manifest.tip.commit !== parent)
    throw new Error("tip commit does not end the ordered patch series")
  if (manifest.tip.tree !== manifest.patches.at(-1)!.tree) {
    throw new Error("tip tree does not match the final patch tree")
  }

  const checks = verifyEvidence(stageDirectory, manifest.stage, manifest.checks)
  const temporaryRoot = mkdtempSync(join(tmpdir(), "runntime-contribution-"))
  const reconstruction = join(temporaryRoot, "repo")
  try {
    run("git", ["clone", "--shared", "--quiet", "--no-checkout", repository, reconstruction])
    git(reconstruction, "checkout", "--quiet", "--detach", manifest.base.commit)
    if (git(reconstruction, "rev-parse", "HEAD^{tree}") !== manifest.base.tree) {
      throw new Error("checked out base tree does not match manifest.base.tree")
    }

    for (const [index, patch] of manifest.patches.entries()) {
      const path = resolve(stageDirectory, patch.path)
      if (!path.startsWith(`${stageDirectory}${sep}`))
        throw new Error(`patch escapes contribution: ${patch.path}`)
      const bytes = readFileSync(path)
      if (sha256(bytes) !== patch.sha256) throw new Error(`patch digest mismatch: ${patch.path}`)
      const text = new TextDecoder().decode(bytes)
      const header = /^From ([a-f0-9]{40}) /m.exec(text)?.[1]
      if (header !== patch.commit)
        throw new Error(`patch ${index + 1} does not identify its recorded commit`)
      for (const touched of patchPaths(text)) {
        if (!allowedPath(touched, manifest.stage))
          throw new Error(`patch ${index + 1} escapes write scope: ${touched}`)
      }
      git(reconstruction, "apply", "--index", "--binary", path)
      const reconstructedTree = git(reconstruction, "write-tree")
      if (reconstructedTree !== patch.tree) {
        throw new Error(
          `patch ${index + 1} reconstructed ${reconstructedTree}, expected ${patch.tree}`,
        )
      }
    }

    const reconstructedTree = git(reconstruction, "write-tree")
    if (reconstructedTree !== manifest.tip.tree) throw new Error("reconstructed tip tree mismatch")
    return {
      stage: manifest.stage,
      baseCommit: manifest.base.commit,
      baseTree: manifest.base.tree,
      tipCommit: manifest.tip.commit,
      reconstructedTree,
      patchesApplied: manifest.patches.length,
      checks,
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

function main(args: string[]): void {
  const stageIndex = args.indexOf("--stage")
  const stage = stageIndex < 0 ? undefined : args[stageIndex + 1]
  if (!isContributionStage(stage)) {
    throw new Error(
      `usage: bun scripts/verify-runntime-contribution.ts --stage ${Object.keys(STAGES).join(" | ")}`,
    )
  }
  const repositoryIndex = args.indexOf("--repository")
  const repository = repositoryIndex < 0 ? undefined : args[repositoryIndex + 1]
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const result = verifyContribution({
    stageDirectory: join(root, STAGES[stage].directory),
    repositoryDirectory: repository ? resolve(repository) : join(root, "..", "runntime"),
  })
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SourceDefinition } from "../context/repo-map.ts"
import { runGit } from "./config.ts"

/**
 * What the audit reads. A change that touches none of these cannot change a finding, so the
 * review skips the run (the engine's docs-only fast path, taken before any analysis starts).
 */
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".astro",
  ".mdx",
  ".css",
  ".scss",
  ".sass",
  ".less",
]
const CONFIG_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  ".fallowrc.json",
  ".fallowrc.jsonc",
  "fallow.toml",
  ".fallow.toml",
]

/**
 * Without a source definition, today's filter: any file Fallow can read. With a project profile's
 * `source`, a readable file also has to be inside it, so vendored trees, records and build output
 * never reach the audit. Config files always count.
 */
function isAuditRelevant(path: string, source?: SourceDefinition): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1)
  if (CONFIG_FILES.includes(name)) return true
  if (!SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext))) return false
  if (!source) return true
  const matches = (patterns: readonly string[]) =>
    patterns.some((pattern) => new Bun.Glob(pattern).match(path))
  return matches(source.include) && !matches(source.exclude)
}

/**
 * Pathspecs of the files a base tree needs: everything the analysis reads, and nothing else (a
 * checkout is mostly assets, documents and vendored crates the analysis never opens).
 */
const BASE_TREE_PATHSPECS = [
  ...SOURCE_EXTENSIONS.map((ext) => `*${ext}`),
  "*.json",
  "*.jsonc",
  "*.yaml",
  "*.yml",
  "*.toml",
  ".gitignore",
]

/**
 * Files that differ between `base` and the workspace (its working tree: committed, staged,
 * unstaged and untracked, which is what the audit itself compares), restricted to the ones a
 * finding can depend on.
 */
export async function changedAuditFiles(
  directory: string,
  base: string,
  source?: SourceDefinition,
): Promise<string[]> {
  const tracked = await runGit(directory, "diff", "--name-only", "-z", base)
  const untracked = await runGit(directory, "ls-files", "--others", "--exclude-standard", "-z")
  if (tracked === undefined || untracked === undefined)
    throw new Error("git diff --name-only failed")
  return [...new Set([...tracked.split("\0"), ...untracked.split("\0")])].filter(
    (line) => line.length > 0 && isAuditRelevant(line, source),
  )
}

/** Added line ranges per changed file: a diff of the working tree against `base`, no context lines. */
export async function addedRangesForFiles(
  directory: string,
  base: string,
  files: readonly string[],
): Promise<Map<string, { startLine: number; endLine: number }[]>> {
  if (files.length === 0) return new Map()
  const text = await runGit(directory, "diff", "-U0", base, "--", ...files)
  if (text === undefined) throw new Error("git diff -U0 failed")
  const { addedLineRangesFromDiff } = await import("./attribution.ts")
  return addedLineRangesFromDiff(text)
}

/**
 * The merge-base with the repository's default branch, else `HEAD~1`, for a read-only preview
 * that has no runner-assigned base commit.
 */
export async function resolvePreviewBaseCommit(directory: string): Promise<string> {
  const originHead = (
    await runGit(directory, "symbolic-ref", "-q", "refs/remotes/origin/HEAD")
  )?.trim()
  const candidates = [originHead, "origin/main", "origin/master", "main", "master"].filter(
    (c): c is string => Boolean(c),
  )
  for (const candidate of candidates) {
    const mergeBase = await runGit(directory, "merge-base", "HEAD", candidate)
    if (mergeBase) return mergeBase.trim()
  }
  const previous = await runGit(directory, "rev-parse", "HEAD~1")
  if (previous) return previous.trim()
  throw new Error("Could not resolve a base commit for the preview")
}

export type MaterialisedBaseTree = { directory: string; cleanup: () => Promise<void> }

async function exitCode(command: string[]): Promise<number> {
  const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  return proc.exited
}

/**
 * The whole tree at `base`, extracted with `git archive` into a fresh temp directory outside the
 * repository. Unlike a worktree it writes nothing into the repository's own metadata.
 */
export async function materialiseBaseArchive(
  repoDirectory: string,
  base: string,
  pathspecs: readonly string[] = BASE_TREE_PATHSPECS,
): Promise<MaterialisedBaseTree> {
  const directory = await mkdtemp(join(tmpdir(), "lz-fallow-base-tree-"))
  const cleanup = () => rm(directory, { recursive: true, force: true })
  const archive = join(directory, ".base.tar")
  const tree = join(directory, "tree")
  try {
    await mkdir(tree)
    // A pathspec that matches nothing fails the archive; the whole tree is the safe retry.
    const archived = (specs: readonly string[]) =>
      exitCode(["git", "-C", repoDirectory, "archive", "-o", archive, base, ...specs])
    if ((await archived(["--", ...pathspecs])) !== 0 && (await archived([])) !== 0)
      throw new Error("git archive failed")
    if ((await exitCode(["tar", "-xf", archive, "-C", tree])) !== 0) throw new Error("tar failed")
    await rm(archive, { force: true })
  } catch (error) {
    await cleanup()
    throw error
  }
  return { directory: tree, cleanup }
}

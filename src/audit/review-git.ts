import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runGit } from "./config.ts"

/** Extensions Fallow analyses; everything else is ignored when scoping the review. */
export const ANALYSABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]

function isAnalysable(path: string): boolean {
  return ANALYSABLE_EXTENSIONS.some((ext) => path.endsWith(ext))
}

/** Files that differ between `base` and `artifact`, restricted to analysable extensions. */
export async function changedAnalysableFiles(
  directory: string,
  base: string,
  artifact: string,
): Promise<string[]> {
  const text = await runGit(directory, "diff", "--name-only", base, artifact)
  if (text === undefined) throw new Error("git diff --name-only failed")
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isAnalysable(line))
}

/** Added line ranges per changed file, from an extensionless-unified diff between the two trees. */
export async function addedRangesForFiles(
  directory: string,
  base: string,
  artifact: string,
  files: readonly string[],
): Promise<Map<string, { startLine: number; endLine: number }[]>> {
  if (files.length === 0) return new Map()
  const text = await runGit(directory, "diff", "-U0", base, artifact, "--", ...files)
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

/**
 * Writes each file's content at `base` into a fresh temp directory outside the repository,
 * preserving relative paths. A file absent at base (new in the candidate) is simply omitted.
 */
export async function materialiseBaseTree(
  repoDirectory: string,
  base: string,
  files: readonly string[],
): Promise<MaterialisedBaseTree> {
  const directory = await mkdtemp(join(tmpdir(), "lz-fallow-base-"))
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fallow-base" }))
  for (const file of files) {
    const content = await runGit(repoDirectory, "show", `${base}:${file}`)
    if (content === undefined) continue
    const destination = join(directory, file)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content)
  }
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

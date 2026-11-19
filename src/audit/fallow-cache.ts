import { copyFile, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FALLOW_CACHE_MAX_MB } from "./fallow-wasi.ts"

/**
 * Fallow's cache lives in `<root>/.fallow` and carries its own `.gitignore` (`*`), so it never
 * shows in `git status`. This module moves it between checkouts of one project. Entries are
 * keyed by file content hash and by a hash of the config, so a stale or foreign entry is a miss
 * and a corrupt file is discarded by Fallow, never an error.
 */

/**
 * Projects with more source files than this run without the cache. A cold run that writes the
 * cache holds it decoded and encoded on top of the analysis: at 10,000 files a dead-code run
 * peaked at 1.27 GB with the cache against 0.51 GB without (a warm run: 0.70 GB in a tenth of
 * the time). The ceiling is 4 GiB, so the bound keeps a cold run well inside it.
 */
export const CACHE_MAX_FILES = 12_000

const CACHE_FILES = ["cache.bin", "churn.bin", "graph-cache.bin"]
const MAX_BYTES = FALLOW_CACHE_MAX_MB * 1024 * 1024 * 2

async function plainDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

async function cacheFiles(directory: string): Promise<string[]> {
  if (!(await plainDirectory(directory))) return []
  const found: string[] = []
  for (const name of await readdir(directory).catch(() => [])) {
    if (!CACHE_FILES.includes(name)) continue
    const info = await lstat(join(directory, name)).catch(() => undefined)
    if (info?.isFile() && info.size <= MAX_BYTES) found.push(name)
  }
  return found
}

async function copyCache(from: string, to: string): Promise<number> {
  const names = await cacheFiles(from)
  if (names.length === 0) return 0
  // `to` must be a real directory or absent: never write through a link.
  const exists = await lstat(to).catch(() => undefined)
  if (exists && !exists.isDirectory()) return 0
  await mkdir(to, { recursive: true })
  await writeFile(join(to, ".gitignore"), "*\n")
  let copied = 0
  for (const name of names) {
    const temporary = join(to, `${name}.seed-${process.pid}.tmp`)
    try {
      await copyFile(join(from, name), temporary)
      await rename(temporary, join(to, name))
      copied++
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  return copied
}

/** Give `root` the cache of another checkout of the same project when it has none of its own. */
export async function seedCache(root: string, from: string): Promise<number> {
  const mine = join(root, ".fallow")
  if ((await cacheFiles(mine)).length > 0) return 0
  return copyCache(join(from, ".fallow"), mine)
}

/** Hand the cache `root` just built to the canonical checkout, for the worktrees made later. */
export async function publishCache(root: string, to: string): Promise<number> {
  if (root === to) return 0
  return copyCache(join(root, ".fallow"), join(to, ".fallow"))
}

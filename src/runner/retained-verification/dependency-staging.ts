import { cpSync, lstatSync, readdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined
    throw error
  }
}

function moveEntry(source: string, target: string) {
  try {
    renameSync(source, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
    cpSync(source, target, { recursive: true, verbatimSymlinks: true })
    rmSync(source, { recursive: true, force: false })
  }
}

function replaceEntry(source: string, target: string) {
  if (lstatIfPresent(target)) rmSync(target, { recursive: true, force: false })
  moveEntry(source, target)
}

/** Merge a package scope or executable bin folder without dropping unrelated native entries. */
function mergeGroup(source: string, target: string) {
  const sourceInfo = lstatSync(source)
  const targetInfo = lstatIfPresent(target)
  if (
    !sourceInfo.isDirectory() ||
    sourceInfo.isSymbolicLink() ||
    (targetInfo && (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()))
  ) {
    replaceEntry(source, target)
    return
  }
  if (!targetInfo) {
    moveEntry(source, target)
    return
  }
  for (const entry of readdirSync(source)) replaceEntry(join(source, entry), join(target, entry))
  rmSync(source, { recursive: true, force: false })
}

/**
 * Adopt the profile install tree into its already-owned dependency resource.
 * Installer output wins duplicate packages; scoped package and .bin containers merge by entry.
 */
export function stageCandidateDependencies(candidate: string, owned: string): void {
  const candidateInfo = lstatSync(candidate)
  const ownedInfo = lstatSync(owned)
  if (
    !candidateInfo.isDirectory() ||
    candidateInfo.isSymbolicLink() ||
    !ownedInfo.isDirectory() ||
    ownedInfo.isSymbolicLink()
  )
    throw new Error("Candidate dependency install left an unexpected node_modules entry")

  for (const entry of readdirSync(candidate)) {
    const source = join(candidate, entry)
    const target = join(owned, entry)
    if (entry === ".bin" || entry.startsWith("@")) mergeGroup(source, target)
    else replaceEntry(source, target)
  }
  rmSync(candidate, { recursive: true, force: false })
}

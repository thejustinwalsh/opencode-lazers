import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { z } from "zod"

/** A project as every row of an all-projects read names it. */
export const ProjectRef = z.strictObject({
  key: z.string().min(1),
  code: z.string().min(2),
  name: z.string(),
  /** A live OpenCode location of this project exists in this server. */
  loaded: z.boolean(),
})

export const canonicalPath = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Canonical form of every live project root, for `isLoaded`. */
export function liveDirectories(loaded: () => Iterable<string>): Set<string> {
  return new Set([...loaded()].map(canonicalPath))
}

/** A project is loaded when any of its checkouts is a live location. */
export function isLoaded(paths: readonly string[], live: ReadonlySet<string>): boolean {
  return paths.some((path) => live.has(canonicalPath(path)))
}

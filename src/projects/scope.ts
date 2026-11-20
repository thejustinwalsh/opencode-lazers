import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { z } from "zod"
import type { TaskRepository } from "../storage.ts"
import { projects } from "./registry.ts"

/** A project as every row of an all-projects read names it. */
export const ProjectRef = z.strictObject({
  key: z.string().min(1),
  code: z.string().min(2).max(6),
  name: z.string(),
  /** A live OpenCode location of this project exists in this server. */
  loaded: z.boolean(),
})
export type ProjectRef = z.infer<typeof ProjectRef>

/** One checkout of one project: the unit an all-projects page reads. */
export type ProjectUnit = { project: ProjectRef; directory: string }

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

/**
 * Every checkout of every registered project in registry order (`created_at`, `key`), then
 * checkout order. `loaded` is read on each call, so a later page sees a location registered since.
 */
export function projectUnits(
  repository: TaskRepository,
  loaded: () => Iterable<string>,
): ProjectUnit[] {
  const live = liveDirectories(loaded)
  return projects(repository).flatMap((project) => {
    const ref: ProjectRef = {
      key: project.key,
      code: project.code,
      name: project.name,
      loaded: isLoaded(project.paths, live),
    }
    return project.paths.map((directory) => ({ project: ref, directory }))
  })
}

/** Cursor of the next page: the unit to read and, inside it, that read's own cursor. */
export type UnitCursor = { directory: string; inner?: string }

const Cursor = z.strictObject({
  v: z.literal(1),
  directory: z.string().min(1),
  inner: z.string().min(1).optional(),
})

export function encodeUnitCursor(cursor: UnitCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor })).toString("base64url")
}

export function decodeUnitCursor(value: string): UnitCursor {
  try {
    const { v: _version, ...cursor } = Cursor.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    )
    return cursor
  } catch {
    throw new Error("Invalid project cursor")
  }
}

/** Index of the unit a cursor names; 0 without a cursor. A unit that is gone is a refused cursor. */
export function unitIndex(units: readonly ProjectUnit[], cursor?: UnitCursor): number {
  if (!cursor) return 0
  const index = units.findIndex((unit) => unit.directory === cursor.directory)
  if (index < 0) throw new Error("Invalid project cursor")
  return index
}

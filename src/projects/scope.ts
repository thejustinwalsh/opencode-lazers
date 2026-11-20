import { createHash } from "node:crypto"
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
export type UnitCursor = { unit: string; inner?: string }

/** A unit is named by a hash of its checkout path, so a cursor never carries a path. */
export const unitToken = (directory: string) =>
  createHash("sha256").update(directory).digest("hex").slice(0, 32)

const Cursor = z.strictObject({
  v: z.literal(1),
  unit: z.string().min(1),
  inner: z.string().min(1).optional(),
})

export function encodeUnitCursor(cursor: { directory: string; inner?: string }): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      unit: unitToken(cursor.directory),
      ...(cursor.inner ? { inner: cursor.inner } : {}),
    }),
  ).toString("base64url")
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
  const index = units.findIndex((unit) => unitToken(unit.directory) === cursor.unit)
  if (index < 0) throw new Error("Invalid project cursor")
  return index
}

/** The checkouts an all-projects read covers: every registered project, in registry order. */
export type UnitAccess = { units: readonly ProjectUnit[] }

/** The unit the cursor names (the first without one) and the cursor of the unit after it. */
export function pickUnit(
  units: readonly ProjectUnit[],
  cursor: string | undefined,
): { unit: ProjectUnit; index: number; inner?: string; nextCursor: string | null } | undefined {
  const position = cursor ? decodeUnitCursor(cursor) : undefined
  const index = unitIndex(units, position)
  const unit = units[index]
  if (!unit) return undefined
  const next = units[index + 1]
  return {
    unit,
    index,
    ...(position?.inner ? { inner: position.inner } : {}),
    nextCursor: next ? encodeUnitCursor({ directory: next.directory }) : null,
  }
}

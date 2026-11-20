import type { TaskReads } from "../read.ts"
import { TaskStateFilter } from "../state-filter.ts"
import type { TaskRepository } from "../../storage.ts"
import { bucketsFor } from "./key.ts"
import { BUCKETS } from "./schema.ts"

/**
 * Old read versus projection. `compareReads` pages the old `Tasks.query` and reads the stored
 * rows in the same order; an empty result means they agree, apart from the differences named in
 * `INTENTIONAL_DIFFERENCES`, the one place the expectations deviate from the old read.
 */
export type Divergence = {
  filter: string
  sort: "schedule" | "recent"
  index: number
  old: string | null
  new: string | null
}

type OldRow = {
  taskID: string
  status: string
  recordedState?: string
  reason: string | null
  startedAt?: number
  takeover?: true
  concern?: { line: string }
  dispatchPause?: unknown
  waitingOnPlans?: { planID: string }[]
  reference: string
  title: string
}

/**
 * Every deliberate departure from the old read, so a parity failure is never explained away
 * elsewhere:
 *  1. A task whose displayed status is Blocked (held by a reservation, a prerequisite plan or an
 *     adoption) counts under the Blocked chip, not Queued (lead decision 4). The old filters read
 *     only stored node and plan state.
 *  2. A plan whose body does not parse no longer reports "prerequisite plan facts are incomplete".
 *  3. Waits are whole: no 100-item caps and no "incomplete" flags.
 */
export const INTENTIONAL_DIFFERENCES = {
  chipFollowsDisplayedStatus(chip: string, row: OldRow, inOldFilter: boolean): boolean {
    const heldBack =
      row.status === "blocked" && ["queued", "ready"].includes(row.recordedState ?? "")
    if (chip === "queued") return inOldFilter && !heldBack
    if (chip === "blocked") return inOldFilter || heldBack
    return inOldFilter
  },
}

/** The stored rows of a chip in schedule order, optionally for one creating session. */
export function projectedIDs(
  repository: TaskRepository,
  chip: string,
  sort: "schedule" | "recent",
  creator?: string,
): string[] {
  const buckets = bucketsFor(chip) ?? BUCKETS
  return repository.read((db) =>
    db
      .query<{ task_id: string }, (string | number)[]>(
        `SELECT task_id FROM task_schedule WHERE project_directory=? AND retired=0
         AND bucket IN (${(buckets as readonly string[]).map(() => "?").join(",")})
         ${creator ? "AND session_id=?" : ""}
         ORDER BY ${sort === "schedule" ? "sort_key" : "seq DESC"},task_id`,
      )
      .all(
        repository.projectDirectory,
        ...(buckets as readonly string[]),
        ...(creator ? [creator] : []),
      )
      .map((row) => row.task_id),
  )
}

function allOld(reads: TaskReads, input: object): OldRow[] {
  const rows: OldRow[] = []
  let cursor: string | undefined
  do {
    const page = reads.query({ limit: 100, ...input, ...(cursor ? { cursor } : {}) })
    rows.push(...(page.tasks as unknown as OldRow[]))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return rows
}

export function compareReads(
  repository: TaskRepository,
  reads: TaskReads,
  options: { creator?: string } = {},
): Divergence[] {
  const out: Divergence[] = []
  for (const sort of ["schedule", "recent"] as const) {
    const base = { sort, state: "all", ...(options.creator ? { sessionID: options.creator } : {}) }
    const everything = allOld(reads, base)
    const chips = [...TaskStateFilter.options.filter((name) => name !== "all"), "all", "legacy"]
    for (const chip of chips) {
      const input =
        chip === "legacy"
          ? { sort, ...(options.creator ? { sessionID: options.creator } : {}) }
          : { ...base, state: chip }
      const inOld = new Set(allOld(reads, input).map((row) => row.taskID))
      const expected = everything
        .filter((row) =>
          INTENTIONAL_DIFFERENCES.chipFollowsDisplayedStatus(chip, row, inOld.has(row.taskID)),
        )
        .map((row) => row.taskID)
      const actual = projectedIDs(repository, chip, sort, options.creator)
      const length = Math.max(expected.length, actual.length)
      for (let index = 0; index < length; index++)
        if (expected[index] !== actual[index]) {
          out.push({
            filter: chip,
            sort,
            index,
            old: expected[index] ?? null,
            new: actual[index] ?? null,
          })
          break
        }
    }
    if (sort === "schedule") {
      const stored = repository.read((db) =>
        db
          .query<Record<string, string | number | null>, [string]>(
            "SELECT * FROM task_schedule WHERE project_directory=?",
          )
          .all(repository.projectDirectory),
      )
      const byID = new Map(stored.map((row) => [row.task_id as string, row]))
      everything.forEach((old, index) => {
        const row = byID.get(old.taskID)
        const mismatch = (field: string, a: unknown, b: unknown) => {
          if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null))
            out.push({
              filter: `field:${field}`,
              sort,
              index,
              old: JSON.stringify(a ?? null),
              new: JSON.stringify(b ?? null),
            })
        }
        if (!row)
          return void out.push({ filter: "missing", sort, index, old: old.taskID, new: null })
        mismatch("status", old.status, row.status)
        mismatch("reason", old.reason, row.reason)
        mismatch("recordedState", old.recordedState ?? null, row.node_state)
        mismatch("startedAt", old.startedAt, row.started_at)
        mismatch("takeover", old.takeover ? 1 : 0, row.takeover)
        mismatch(
          "concern",
          old.concern?.line,
          row.concern ? JSON.parse(String(row.concern)).line : null,
        )
        mismatch("dispatchPause", old.dispatchPause ? 1 : 0, row.dispatch_pause ? 1 : 0)
        mismatch(
          "waitingOnPlans",
          (old.waitingOnPlans ?? []).map((wait) => wait.planID),
          reads.repository.read((db) =>
            db
              .query<{ plan_id: string }, [string]>(
                "SELECT plan_id FROM task_schedule_waits WHERE task_id=? ORDER BY ord",
              )
              .all(old.taskID)
              .map((wait) => wait.plan_id),
          ),
        )
        mismatch("reference", old.reference, row.reference)
        mismatch("title", old.title, row.title)
      })
    }
  }
  return out
}

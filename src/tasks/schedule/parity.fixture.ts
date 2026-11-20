import { readFileSync } from "node:fs"
import { expect } from "bun:test"
import { TaskStateFilter } from "../state-filter.ts"
import type { TaskRepository } from "../../storage.ts"
import { bucketsFor } from "./key.ts"
import { BUCKETS } from "./schema.ts"

/**
 * The stored list against what the old `Tasks.query` showed, which `recorded-projection.json`
 * keeps from before that read was removed. Deliberate departures from the old read:
 *  1. A task whose displayed status is Blocked (held by a reservation, a prerequisite plan or an
 *     adoption) counts under the Blocked chip, not Queued (lead decision 4). The old filters read
 *     only stored node and plan state. The recorded chips already follow this.
 *  2. A plan whose body does not parse no longer reports "prerequisite plan facts are incomplete".
 *  3. Waits are whole: no 100-item caps and no "incomplete" flags.
 */

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

/**
 * What the stored list shows, in names a fixture chose, so a recorded expectation survives the
 * random ids of a run: the order of every chip in both sorts, and each task's displayed fields.
 */
export type ProjectionFacts = {
  order: Record<string, string[]>
  tasks: Record<
    string,
    {
      reference: string
      status: string
      reason: string | null
      recordedState: string | null
      /** Whether an attempt start is shown; the instant is the run's clock. */
      started: boolean
      takeover: number
      concern: string | null
      paused: number
      waits: string[]
    }
  >
}

const CHIPS = [...TaskStateFilter.options.filter((name) => name !== "all"), "all", "legacy"]

function namesOf(repository: TaskRepository) {
  const names = new Map<string, string>()
  repository.read((db) => {
    for (const row of db
      .query<{ id: string; objective: string | null }, [string]>(
        "SELECT id,json_extract(body,'$.proposal.objective') AS objective FROM tasks WHERE project_directory=?",
      )
      .all(repository.projectDirectory))
      names.set(row.id, row.objective ?? row.id)
    for (const row of db
      .query<{ id: string; objective: string | null }, [string]>(
        "SELECT id,json_extract(body,'$.objective') AS objective FROM runner_plans WHERE project_directory=?",
      )
      .all(repository.projectDirectory))
      names.set(row.id, `plan ${row.objective ?? row.id}`)
  })
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
  return {
    name: (id: string) => names.get(id) ?? id,
    text: (value: string | null) =>
      value
        ?.replace(UUID, (id) => names.get(id) ?? "<id>")
        .replace(/\/[^\s]*lazers-[^\s]*?(?=<|\s|$)/g, "<path>") ?? null,
  }
}

/** The stored list, as facts. Chips that sort differently from `recent` are keyed by sort. */
export function storedFacts(repository: TaskRepository): ProjectionFacts {
  const { name, text } = namesOf(repository)
  const order: ProjectionFacts["order"] = {}
  for (const sort of ["schedule", "recent"] as const)
    for (const chip of CHIPS)
      order[`${sort}/${chip}`] = projectedIDs(repository, chip, sort).map(name)
  const tasks: ProjectionFacts["tasks"] = {}
  repository.read((db) => {
    for (const row of db
      .query<Record<string, string | number | null>, [string]>(
        "SELECT * FROM task_schedule WHERE project_directory=? AND retired=0",
      )
      .all(repository.projectDirectory)) {
      tasks[name(row.task_id as string)] = {
        reference: row.reference as string,
        status: row.status as string,
        reason: text(row.reason as string | null),
        recordedState: (row.node_state as string | null) ?? null,
        started: row.started_at != null,
        takeover: row.takeover as number,
        concern: row.concern ? (JSON.parse(String(row.concern)).line as string) : null,
        paused: row.dispatch_pause ? 1 : 0,
        waits: db
          .query<{ plan_id: string }, [string]>(
            "SELECT plan_id FROM task_schedule_waits WHERE task_id=? ORDER BY ord",
          )
          .all(row.task_id as string)
          .map((wait) => name(wait.plan_id)),
      }
    }
  })
  return { order, tasks }
}

const RECORDED = new URL("./recorded-projection.json", import.meta.url)

/** The stored list equals what the old read showed for this scenario, from `recorded-projection.json`. */
export function expectProjection(key: string, repository: TaskRepository) {
  const recorded: Record<string, ProjectionFacts> = JSON.parse(readFileSync(RECORDED, "utf8"))
  expect({ key, facts: storedFacts(repository) }).toEqual({ key, facts: recorded[key]! })
}

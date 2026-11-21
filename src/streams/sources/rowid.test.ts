import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { databaseChanges } from "../../database-events.ts"
import { TaskRepository } from "../../storage.ts"
import { TaskScheduleOwner } from "../../tasks/schedule/owner.ts"
import { ProgressRecorder } from "../../progress/recorder.ts"
import { installProgressDisplaySchema } from "../../progress/display-store.ts"
import { RunnerStore } from "../../runner/store.ts"
import { ensureTaskScheduleSchema } from "../../tasks/schedule/schema.ts"
import { ensureModelCandidatesSchema } from "../../models/candidate-store.ts"
import { ensureDecisionViewSchema } from "../../models/decision-store.ts"
import { acquireSharedConnection } from "../../storage.ts"
import { ensureHostSessionStateSchema } from "../../host-sessions/state.ts"
import { ensureProjectOverviewSchema } from "../../projects/overview-store.ts"
import "./index.ts"
import type { Source } from "../source.ts"
import type { Columns } from "../frame.ts"

const sources = () => {
  const host = globalThis as unknown as Record<symbol, Map<string, Source<never, Columns>>>
  return [...host[Symbol.for("lazers.streams.sources.v1")]!.values()]
}

/** Every `source table` pair whose declared SQL says WITHOUT ROWID, and how many tables were checked. */
function withoutRowid(declared: Map<string, string>) {
  const violations: string[] = []
  let checked = 0
  for (const source of sources())
    for (const table of source.readsTables) {
      const sql = declared.get(table)
      if (!sql) continue
      checked++
      if (/WITHOUT ROWID/i.test(sql)) violations.push(`${source.name} ${table}`)
    }
  return { violations, checked }
}

function declaredTables() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-rowid-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/p")
  try {
    ensureTaskScheduleSchema(repository)
    ensureModelCandidatesSchema(repository)
    const shared = acquireSharedConnection(repository.path)
    ensureDecisionViewSchema(shared)
    shared.release()
    new ProgressRecorder(new RunnerStore(repository), "p")
    repository.atomic((db) => installProgressDisplaySchema(db))
    ensureHostSessionStateSchema(repository)
    ensureProjectOverviewSchema(repository)
    return new Map(
      repository.read((db) =>
        db
          .query<{ name: string; sql: string }, []>(
            "SELECT name,sql FROM sqlite_master WHERE type='table'",
          )
          .all()
          .map((row) => [row.name, row.sql] as const),
      ),
    )
  } finally {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

test("no registered source reads a WITHOUT ROWID table: SQLite's update hook never names one", () => {
  const { violations, checked } = withoutRowid(declaredTables())
  expect(violations).toEqual([])
  expect(checked).toBeGreaterThan(5)
})

test("the check can fail: a source table declared WITHOUT ROWID in a scratch copy of the schema is reported", () => {
  const declared = declaredTables()
  const scratch = new Map(declared)
  // A scratch copy of one table's declaration, never installed by product code.
  scratch.set(
    "task_schedule_counts",
    `${declared.get("task_schedule_counts")!.replace(/\)\s*$/, ") WITHOUT ROWID")}`,
  )
  const { violations } = withoutRowid(scratch)
  expect(violations.some((entry) => entry.endsWith(" task_schedule_counts"))).toBe(true)
  expect(withoutRowid(declared).violations).toEqual([])
})

test("the owner wakes on a dirty row another connection queued", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-owner-wake-"))
  const path = join(directory, "tasks.sqlite")
  const first = new TaskRepository(path, "/p")
  ensureTaskScheduleSchema(first)
  const owner = new TaskScheduleOwner(first)
  const other = new TaskRepository(path, "/p")
  const heard: string[][] = []
  const off = databaseChanges.subscribeTables(path, (tables) => heard.push([...tables]))
  try {
    owner.start()
    await owner.settle()
    other.atomic((db) =>
      db.query("INSERT INTO task_schedule_dirty(kind,ref) VALUES('task','x')").run(),
    )
    await Bun.sleep(100)
    expect(heard.flat()).toContain("task_schedule_dirty")
    // The owner drained the row the other connection queued.
    expect(
      first.read(
        (db) =>
          db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_schedule_dirty").get()!.n,
      ),
    ).toBe(0)
  } finally {
    off()
    owner.close()
    other.close()
    first.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

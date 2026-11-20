import { expect, test } from "bun:test"
import { firstAttemptID, makeFixture } from "../../test/trajectory/fixture.ts"
import { meterRepository } from "../runner/read-meter.fixture.ts"
import {
  backfillProgressDisplayPage,
  ProgressDisplayBackfill,
  startProgressDisplayBackfill,
  resetProgressDisplayBackfill,
} from "./display-backfill.ts"
import { LiveReadStore } from "../observability/live-store.ts"
import { DISPLAY_VERSION } from "./display.ts"
import { refreshProgressDisplay } from "./display-store.ts"
import { installProgressDisplayBackfill } from "./display-backfill.ts"

const ROWS = 450

/** Progress rows as an older version stored them: no display row beside them. */
function seedLegacy(fixture: ReturnType<typeof makeFixture>, rows = ROWS) {
  fixture.store.atomic((db) => {
    const plan = db
      .query<{ plan_id: string; task_id: string }, [string]>(
        "SELECT plan_id,task_id FROM runner_attempts WHERE id=?",
      )
      .get(firstAttemptID)!
    const insert = db.query(
      `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,
        at,recorded_at,source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,?,'[]','tool','[]',?,?,?,?)`,
    )
    for (let i = 0; i < rows; i++)
      insert.run(
        fixture.store.repository.projectDirectory,
        "project",
        plan.plan_id,
        plan.task_id,
        firstAttemptID,
        "ses-failed",
        1_000 + i,
        2_000 + i,
        "runtime",
        `call-${i}`,
        `msg-${i}`,
        `legacy-${i}`,
        JSON.stringify({ tool: i % 2 ? "read" : "edit", status: "succeeded", result: `r${i}` }),
      )
    resetProgressDisplayBackfill(db)
  })
}

const stored = (fixture: ReturnType<typeof makeFixture>) =>
  fixture.store.read((db) =>
    db
      .query<{ seq: number; tool: string | null; status: string | null }, []>(
        "SELECT seq,tool,status FROM runner_progress_display ORDER BY seq",
      )
      .all(),
  )

test("legacy rows get their display in small transactions, newest first, and the watermark resumes", () => {
  const fixture = makeFixture()
  try {
    seedLegacy(fixture)
    expect(stored(fixture)).toEqual([])
    const repository = fixture.store.repository
    const atomic = repository.atomic.bind(repository)
    const transactions: number[] = []
    repository.atomic = ((run: Parameters<typeof atomic>[0]) =>
      atomic((db) => {
        const before = Number(
          db.query<{ n: number }, []>("SELECT count(*) AS n FROM runner_progress_display").get()!.n,
        )
        const result = run(db)
        transactions.push(
          Number(
            db.query<{ n: number }, []>("SELECT count(*) AS n FROM runner_progress_display").get()!
              .n,
          ) - before,
        )
        return result
      })) as typeof repository.atomic
    const first = new ProgressDisplayBackfill(fixture.store.repository)
    // One page of 100 rows: the newest hundred.
    first.slice(0)
    const afterOne = stored(fixture)
    expect(afterOne).toHaveLength(100)
    expect(afterOne[0]!.seq).toBe(ROWS - 99)
    expect(afterOne.at(-1)!.seq).toBe(ROWS)

    // A restart picks up where the watermark was left; the old instance's memory is not needed.
    const second = new ProgressDisplayBackfill(fixture.store.repository)
    let written = 0
    let slices = 0
    while (!second.done) {
      written += second.slice(0)
      slices++
    }
    repository.atomic = atomic
    expect(written).toBe(ROWS - 100)
    expect(slices).toBe(4)
    const all = stored(fixture)
    expect(all.map((row) => row.seq)).toEqual(Array.from({ length: ROWS }, (_, i) => i + 1))
    expect(all[0]).toEqual({ seq: 1, tool: "edit", status: "succeeded" })
    // Every page was its own transaction of at most one page: never one statement over all rows.
    expect(transactions.every((rows) => rows <= 100)).toBe(true)
    expect(transactions.length).toBe(5)

    // Done is remembered, and a later call reads nothing.
    const quiet = meterRepository(fixture.store.repository)
    expect(second.slice(0)).toBe(0)
    expect(new ProgressDisplayBackfill(fixture.store.repository).slice(0)).toBe(0)
    quiet.stop()
    expect(
      quiet.statements.filter((sql) => /runner_progress\b/.test(sql) && !/backfill/.test(sql)),
    ).toEqual([])
  } finally {
    fixture.close()
  }
})

test("a legacy row the writer already refreshed is not written twice, and the page count is exact", () => {
  const fixture = makeFixture()
  try {
    seedLegacy(fixture, 250)
    fixture.store.atomic((db) => {
      // The recorder touched this legacy row (a merged update) before the backfill reached it.
      db.query("UPDATE runner_progress SET payload=? WHERE seq=40").run(
        JSON.stringify({ tool: "bash", status: "failed", error: { message: "boom" } }),
      )
      refreshProgressDisplay(db, 40)
    })
    const pages: number[] = []
    for (;;) {
      const page = fixture.store.atomic((db) => backfillProgressDisplayPage(db, 100))
      pages.push(page.written)
      if (page.done) break
    }
    expect(pages).toEqual([100, 100, 49])
    const rows = fixture.store.read((db) =>
      db
        .query<{ tool: string; error: string | null }, []>(
          "SELECT tool,error FROM runner_progress_display WHERE seq=40",
        )
        .all(),
    )
    // The writer's value stays; the backfill never overwrote it with the stale projection.
    expect(rows).toEqual([{ tool: "bash", error: "boom" }])
  } finally {
    fixture.close()
  }
})

test("an empty or fresh database is done at once", () => {
  const fixture = makeFixture()
  try {
    const backfill = new ProgressDisplayBackfill(fixture.store.repository)
    expect(backfill.slice(0)).toBe(0)
    expect(backfill.done).toBe(true)
  } finally {
    fixture.close()
  }
})

test("the driver fills every legacy row on its own timer, and stops when told", async () => {
  const fixture = makeFixture()
  try {
    seedLegacy(fixture, 250)
    const pace = { sliceMs: 0, waitMs: 1 }
    const driver = startProgressDisplayBackfill(fixture.store.repository, {
      pacing: { startMs: 1, quiet: pace, busy: pace, retryMs: 5 },
    })
    for (let i = 0; i < 200 && !driver.done; i++) await Bun.sleep(5)
    expect(driver.done).toBe(true)
    expect(stored(fixture)).toHaveLength(250)
    driver.stop()
    const idle = startProgressDisplayBackfill(fixture.store.repository, {
      pacing: { startMs: 1, quiet: pace, busy: pace, retryMs: 5 },
    })
    idle.stop()
    expect(idle.done).toBe(false)
  } finally {
    fixture.close()
  }
})

test("rows written under an older display version are walked again, with no manual step", () => {
  const fixture = makeFixture()
  try {
    seedLegacy(fixture, 250)
    const backfill = new ProgressDisplayBackfill(fixture.store.repository)
    while (!backfill.done) backfill.slice(0)
    // Stand in for rows an older build wrote: stale values, the previous version, a finished watermark.
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_progress_display SET tool='stale', version=?").run(
        DISPLAY_VERSION - 1,
      )
      db.query("UPDATE runner_progress_display_backfill SET version=?, below_seq=0").run(
        DISPLAY_VERSION - 1,
      )
    })
    // The next install (a restart on the new code) sees the version differ and starts over.
    fixture.store.atomic((db) => installProgressDisplayBackfill(db))
    const marks = () =>
      fixture.store.read((db) =>
        db
          .query<{ below_seq: number; version: number }, []>(
            "SELECT below_seq,version FROM runner_progress_display_backfill",
          )
          .get(),
      )
    expect(marks()).toEqual({ below_seq: 251, version: DISPLAY_VERSION })
    const again = new ProgressDisplayBackfill(fixture.store.repository)
    while (!again.done) again.slice(0)
    const rows = fixture.store.read((db) =>
      db
        .query<{ tool: string; version: number }, []>(
          "SELECT DISTINCT tool,version FROM runner_progress_display ORDER BY tool",
        )
        .all(),
    )
    expect(rows).toEqual([
      { tool: "edit", version: DISPLAY_VERSION },
      { tool: "read", version: DISPLAY_VERSION },
    ])
    // The same version again changes nothing.
    fixture.store.atomic((db) => installProgressDisplayBackfill(db))
    expect(marks()).toEqual({ below_seq: 0, version: DISPLAY_VERSION })
  } finally {
    fixture.close()
  }
})

test("the attempt read says older calls are still being indexed until the backfill reaches the attempt's oldest row", () => {
  const fixture = makeFixture()
  try {
    seedLegacy(fixture, 250)
    const store = new LiveReadStore(
      fixture.store.repository.path,
      fixture.store.repository.projectDirectory,
      "project",
    )
    const read = () =>
      store.readAttempt(
        { scope: { kind: "project", sessionID: "ses-owner" }, sessionID: "ses-failed" },
        new AbortController().signal,
      )?.historyIndexing
    expect(read()).toBe(true)
    const backfill = new ProgressDisplayBackfill(fixture.store.repository)
    backfill.slice(0)
    expect(read()).toBe(true)
    while (!backfill.done) backfill.slice(0)
    expect(read()).toBeUndefined()
  } finally {
    fixture.close()
  }
})

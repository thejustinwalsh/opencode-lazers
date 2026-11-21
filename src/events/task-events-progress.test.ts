import { afterEach, expect, test } from "bun:test"
import { firstAttemptID, makeFixture, taskID } from "../../test/trajectory/fixture.ts"
import { seedDisplayCorpus, type StoredDisplay } from "../progress/display.fixture.ts"
import { startProjection } from "../projections/owner.ts"
import type { TaskRepository } from "../storage.ts"
import {
  DRAIN_BUDGET,
  drainTaskEvents,
  PROGRESS_PAGE_ROWS,
  TASK_EVENTS,
  taskEventsProjection,
} from "./task-events-refresh.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const slow = {
  startMs: 60_000,
  quiet: { sliceMs: 1, waitMs: 1 },
  busy: { sliceMs: 1, waitMs: 1 },
  retryMs: 60_000,
}

type Display = StoredDisplay & { project_directory: string; attempt_id: string; session_id: string }
type Event = {
  origin: string
  project_directory: string
  task_id: string
  plan_id: string
  attempt_id: string
  session_id: string
  at: number
  event: string
  status: string | null
  tool: string | null
  route_provider: string | null
  route_model: string | null
  route_variant: string | null
  detail: string | null
}

const displays = (repository: TaskRepository) =>
  repository.read((db) =>
    db.query<Display, []>("SELECT * FROM runner_progress_display ORDER BY seq LIMIT 5000").all(),
  )
const progressEvents = (repository: TaskRepository) =>
  repository.read((db) =>
    db
      .query<Event, []>(
        `SELECT origin,project_directory,task_id,plan_id,attempt_id,session_id,at,event,status,tool,
           route_provider,route_model,route_variant,detail
         FROM task_events WHERE kind='progress' ORDER BY at,id LIMIT 5000`,
      )
      .all(),
  )

/** What `task_events` must hold for one display row: its listed fields, and the rest as detail. */
function mirrored(display: Display, plan: string): Event {
  return {
    origin: `pg:${display.seq}`,
    project_directory: display.project_directory,
    task_id: taskID,
    plan_id: plan,
    attempt_id: display.attempt_id,
    session_id: display.session_id,
    at: display.at,
    event: display.kind,
    status: display.status,
    tool: display.tool,
    route_provider: display.route_provider,
    route_model: display.route_model,
    route_variant: display.route_variant,
    detail: null,
  }
}

/** More rows than one drain budget and several backfill pages. */
const BULK = DRAIN_BUDGET + PROGRESS_PAGE_ROWS * 2

function fixture() {
  const made = makeFixture()
  cleanups.push(() => made.close())
  return made
}

test("parity: each progress display row has one task event with its fields, written in the recorder's transaction", () => {
  const made = fixture()
  seedDisplayCorpus(made)
  const rows = displays(made.repository)
  expect(rows.length).toBeGreaterThan(10)
  // Written by the drain at the end of the seeding transaction: no owner involved.
  expect(progressEvents(made.repository)).toEqual(
    rows
      .toSorted((a, b) => a.at - b.at || a.seq - b.seq)
      .map((row) => mirrored(row, made.receipt.planID)),
  )
  // A display rewrite (the recorder refreshing a row) moves the event in place.
  const [first] = rows
  const before = made.repository.read((db) =>
    db.query("SELECT id FROM task_events WHERE origin=?").get(`pg:${first!.seq}`),
  )
  made.store.atomic((db) =>
    db.query("UPDATE runner_progress_display SET status='done' WHERE seq=?").run(first!.seq),
  )
  expect(
    made.repository.read((db) =>
      db.query("SELECT id,status FROM task_events WHERE origin=?").get(`pg:${first!.seq}`),
    ),
  ).toEqual({ ...(before as { id: number }), status: "done" })
  // Deleting the progress row deletes its display (existing trigger) and its event (ours).
  made.store.atomic((db) => db.query("DELETE FROM runner_progress WHERE seq=?").run(first!.seq))
  expect(
    made.repository.read((db) =>
      db.query("SELECT 1 FROM task_events WHERE origin=?").get(`pg:${first!.seq}`),
    ),
  ).toBeNull()
})

test("backfill: display rows from before the projection are mirrored in pages, resuming after a kill", async () => {
  const made = fixture()
  seedDisplayCorpus(made)
  const seeded = displays(made.repository).length
  // Many more rows than one page, all older than the projection.
  made.store.atomic((db) => {
    const insert = db.query(
      `INSERT INTO runner_progress_display(project_directory,project_id,attempt_id,session_id,at,kind,source,
         observations_json,payload_available,version) VALUES(?,?,?,?,?,'tool','runtime','[]',0,2)`,
    )
    for (let i = 0; i < BULK; i++)
      insert.run(made.directory, "project", firstAttemptID, "ses-failed", 10_000 + i)
  })
  // One write transaction drains a budget of entries; the rest wait for the owner.
  expect(
    made.repository.read(
      (db) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_events_dirty").get()!.n,
    ),
  ).toBe(BULK - DRAIN_BUDGET)
  while (made.repository.atomic((db) => drainTaskEvents(db)).remaining > 0);
  const expected = progressEvents(made.repository)
  expect(expected.length).toBe(BULK + seeded)
  made.repository.atomic((db) => db.exec("DELETE FROM task_events; DELETE FROM projection_state"))
  const first = startProjection(made.repository.path, made.directory, taskEventsProjection, {
    pacing: slow,
  })
  // Transitions, effects, then the first progress page; killed there.
  for (let page = 0; page < 3; page++) first.owner.backfillPage()
  first.release()
  expect(
    made.repository.read((db) =>
      db.query("SELECT phase,state FROM projection_state WHERE name=?").get(TASK_EVENTS),
    ),
  ).toEqual({ phase: 2, state: "backfilling" })
  expect(progressEvents(made.repository).length).toBe(PROGRESS_PAGE_ROWS)
  const lease = startProjection(made.repository.path, made.directory, taskEventsProjection, {
    pacing: slow,
  })
  cleanups.push(() => lease.release())
  await lease.owner.settle()
  expect(lease.owner.status()).toMatchObject({ state: "ready", phase: 2 })
  expect(progressEvents(made.repository)).toEqual(expected)
})

test("a display row of no runner attempt has no event", () => {
  const made = fixture()
  made.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_progress_display(project_directory,project_id,attempt_id,session_id,at,kind,source,
           observations_json,payload_available,version) VALUES(?,?,'ghost','ses-ghost',1,'tool','runtime','[]',0,2)`,
      )
      .run(made.directory, "project"),
  )
  expect(displays(made.repository).length).toBe(1)
  expect(progressEvents(made.repository)).toEqual([])
})

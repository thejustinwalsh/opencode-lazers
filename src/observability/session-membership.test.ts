import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { meterDatabase } from "../runner/read-meter.fixture.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { associatedSessionIDs, projectSessionIDs } from "./associations.ts"
import { ObservationChangeTracker } from "./changes.ts"
import { ObservationReads } from "./read.ts"
import type { RadarSessionHost } from "./native.ts"

/** The read before this change: every task, plan, attempt and continuation row, ids repeated. */
function legacyAssociatedSessionIDs(db: Database, projectDirectory: string) {
  const ids = new Set<string>()
  for (const row of db
    .query<{ session_id: string }, [string]>(
      `SELECT CASE WHEN json_valid(body) THEN json_extract(body,'$.provenance.sessionID') END AS session_id
       FROM tasks WHERE project_directory=?`,
    )
    .all(projectDirectory))
    if (row.session_id) ids.add(row.session_id)
  for (const row of db
    .query<{ session_id: string }, [string]>(
      "SELECT owner AS session_id FROM runner_plans WHERE project_directory=?",
    )
    .all(projectDirectory))
    ids.add(row.session_id)
  for (const row of db
    .query<{ session_id: string }, [string]>(
      `SELECT a.session_id FROM runner_attempts a
       JOIN runner_plans p ON p.id=a.plan_id WHERE p.project_directory=?`,
    )
    .all(projectDirectory))
    ids.add(row.session_id)
  for (const row of db
    .query<{ session_id: string | null; parent_id: string | null }, [string]>(
      `SELECT c.session_id,c.parent_id FROM runner_continuations c
       JOIN runner_plans p ON p.id=c.plan_id WHERE p.project_directory=?`,
    )
    .all(projectDirectory)) {
    if (row.session_id) ids.add(row.session_id)
    if (row.parent_id) ids.add(row.parent_id)
  }
  return ids
}

const TASKS = 400
const SESSIONS = 8

function seed(fixture: ReturnType<typeof makeFixture>) {
  fixture.store.atomic((db) => {
    const insert = db.query(
      "INSERT INTO tasks(id,project_directory,created_at,body) VALUES(?,?,?,?)",
    )
    for (let index = 0; index < TASKS; index++)
      insert.run(
        `task-membership-${index}`,
        fixture.directory,
        "2026-10-31T12:00:00.000Z",
        JSON.stringify({ provenance: { sessionID: `ses-member-${index % SESSIONS}` } }),
      )
    // Tasks without a session id: the statement must not return them either.
    insert.run(
      "task-membership-none",
      fixture.directory,
      "2026-10-31T12:00:00.000Z",
      JSON.stringify({ provenance: {} }),
    )
    insert.run("task-membership-bad", fixture.directory, "2026-10-31T12:00:00.000Z", "not json")
  })
}

test("project session ids equal the legacy read and return distinct ids, not a row per task", () => {
  const fixture = makeFixture()
  try {
    seed(fixture)
    const { before, after, same } = fixture.store.atomic((db) => {
      const legacy = meterDatabase(db)
      const expected = legacyAssociatedSessionIDs(legacy.db, fixture.directory)
      const current = meterDatabase(db)
      const actual = associatedSessionIDs(current.db, fixture.directory)
      return {
        before: { rows: legacy.meter.rows, bytes: legacy.meter.bytes },
        after: { rows: current.meter.rows, bytes: current.meter.bytes },
        same: [...actual].toSorted().join() === [...expected].toSorted().join(),
      }
    })
    expect(same).toBe(true)
    console.log(`associatedSessionIDs read-meter, ${TASKS} tasks over ${SESSIONS} sessions:`, {
      before,
      after,
    })
    expect(after.rows).toBeLessThan(before.rows / 10)
    expect(after.bytes).toBeLessThan(before.bytes / 10)
  } finally {
    fixture.close()
  }
})

test("an unchanged project reads no session rows; a write re-reads and the set matches the full read", () => {
  const fixture = makeFixture()
  try {
    seed(fixture)
    const secret = new Uint8Array(32).fill(21)
    const read = () =>
      fixture.store.atomic((db) => {
        const metered = meterDatabase(db)
        const ids = projectSessionIDs(metered.db, fixture.directory, secret)
        return {
          ids,
          rows: metered.meter.of(/FROM (tasks|runner_plans|runner_attempts|runner_continuations)/)
            .rows,
          expected: associatedSessionIDs(db, fixture.directory),
        }
      })
    const first = read()
    expect(first.rows).toBeGreaterThan(0)
    expect([...first.ids].toSorted()).toEqual([...first.expected].toSorted())

    const second = read()
    expect(second.rows).toBe(0)
    expect([...second.ids].toSorted()).toEqual([...first.ids].toSorted())

    // The returned set is the caller's own: mutating it never changes the held list.
    second.ids.add("ses-caller-added")
    expect(read().ids.has("ses-caller-added")).toBe(false)

    fixture.store.atomic((db) => {
      db.run("INSERT INTO tasks(id,project_directory,created_at,body) VALUES(?,?,?,?)", [
        "task-membership-late",
        fixture.directory,
        "2026-10-31T12:00:00.000Z",
        JSON.stringify({ provenance: { sessionID: "ses-late" } }),
      ])
    })
    const third = read()
    expect(third.rows).toBeGreaterThan(0)
    expect(third.ids.has("ses-late")).toBe(true)
    expect([...third.ids].toSorted()).toEqual([...third.expected].toSorted())
  } finally {
    fixture.close()
  }
})

test("a project radar read does not rescan session membership while the revision is unchanged", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(22)
  const none: RadarSessionHost = {
    get: async () => null,
    project: async () => ({ sessions: [], truncated: false }),
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret, none)
  const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
  tracker.initialize()
  const membership = (queries: string[]) =>
    queries.filter((sql) => /SELECT DISTINCT (session_id FROM \(|owner AS session_id)/.test(sql))
  const radar = async () => {
    const spy = spyOn(Database.prototype, "query")
    try {
      await reads.radar(
        { scope: { kind: "project", sessionID: "ses-owner" }, includeUnmanagedSessions: false },
        tracker,
        new AbortController().signal,
      )
      return spy.mock.calls.map(([sql]) => String(sql))
    } finally {
      spy.mockRestore()
    }
  }
  try {
    expect(membership(await radar()).length).toBeGreaterThan(0)
    expect(membership(await radar())).toEqual([])
    fixture.store.atomic((db) => {
      db.run("UPDATE runner_plans SET reason='moved' WHERE project_directory=?", [
        fixture.directory,
      ])
    })
    expect(membership(await radar()).length).toBeGreaterThan(0)
  } finally {
    tracker.close()
    fixture.close()
  }
})

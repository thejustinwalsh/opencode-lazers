import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { ObservationReads } from "./read.ts"
import { ObservationChangeTracker } from "./changes.ts"

function sqlDuring(action: () => void) {
  const queries = spyOn(Database.prototype, "query")
  try {
    action()
    return queries.mock.calls.map(([query]) => String(query))
  } finally {
    queries.mockRestore()
  }
}

test("topology never selects plan bodies in bulk and an unchanged project is not reread", () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(7)
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret)
  const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  try {
    tracker.initialize()
    const first = sqlDuring(() => reads.topology(scope, tracker))
    // No query lists every plan body of the project.
    expect(
      first.filter((sql) =>
        /SELECT[^;]*\bbody\b[^;]*FROM runner_plans WHERE project_directory/i.test(sql),
      ),
    ).toEqual([])
    expect(first.some((sql) => /body FROM runner_plans WHERE id=\?/.test(sql))).toBe(true)

    // Unchanged stamp: no plan header scan, no plan body read, no dependency closure.
    const second = sqlDuring(() => reads.topology(scope, tracker))
    expect(second.filter((sql) => /FROM runner_plans WHERE project_directory/.test(sql))).toEqual(
      [],
    )
    expect(second.filter((sql) => /body FROM runner_plans/.test(sql))).toEqual([])
    expect(
      second.filter((sql) => /SELECT task_id FROM runner_nodes WHERE plan_id IN/.test(sql)),
    ).toEqual([])

    // A write moves the observation revision: the gated read runs again.
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_plans SET reason='moved' WHERE project_directory=?").run(
        fixture.directory,
      )
    })
    const third = sqlDuring(() => reads.topology(scope, tracker))
    expect(
      third.filter((sql) => /SELECT id,revision,version,state,reason FROM runner_plans/.test(sql))
        .length,
    ).toBe(1)
  } finally {
    fixture.close()
  }
})

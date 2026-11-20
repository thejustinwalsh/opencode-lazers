import { expect, test } from "bun:test"
import { makeFixture, secondAttemptID } from "../../test/trajectory/fixture.ts"
import { ProgressRecorder, verdictStats } from "./recorder.ts"

test("repeated assignment scans parse each task body once and skip unchanged revisions", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const before = verdictStats.parses
    const first = recorder.assignments()
    expect(first.length).toBe(2)
    const firstParses = verdictStats.parses - before
    expect(firstParses).toBeGreaterThan(0)

    // 50 five-second ticks with no database change: no query result is rebuilt and no body parsed.
    for (let tick = 0; tick < 50; tick++) expect(recorder.assignments()).toEqual(first)
    expect(verdictStats.parses - before).toBe(firstParses)

    // A new recorder copy (another plugin location) shares the verdicts: scan, no parse.
    const other = new ProgressRecorder(fixture.store, "project")
    expect(other.assignments()).toEqual(first)
    expect(verdictStats.parses - before).toBe(firstParses)

    // A real change moves the revision; the rescan reflects it, still without re-parsing bodies.
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const changed = recorder.assignments()
    expect(changed.find((value) => value.attemptID === secondAttemptID)?.attemptState).toBe(
      "running",
    )
    expect(verdictStats.parses - before).toBe(firstParses)
  } finally {
    fixture.close()
  }
})

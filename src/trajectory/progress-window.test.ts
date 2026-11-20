import { expect, test } from "bun:test"
import { firstAttemptID, makeFixture, secondAttemptID } from "../../test/trajectory/fixture.ts"
import { projectProgressFact } from "../progress/projection.ts"
import { meterReads } from "../runner/read-meter.fixture.ts"

const KINDS = ["tool", "step", "commentary", "gap", "usage-snapshot", "visible-text"]
const TOTAL = 3_200

function seed(fixture: ReturnType<typeof makeFixture>) {
  fixture.store.atomic((db) => {
    const insert = db.query(
      `INSERT INTO runner_progress
       (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,source,
        sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (let index = 0; index < TOTAL; index++) {
      const kind = KINDS[index % KINDS.length]!
      insert.run(
        fixture.directory,
        "project",
        fixture.attempts[0]!.plan_id,
        fixture.attempts[0]!.task_id,
        index % 3 === 0 ? secondAttemptID : firstAttemptID,
        "ses-window",
        index,
        index % 5 === 0 ? null : index,
        "native-event",
        '["native-event"]',
        kind,
        "[]",
        kind === "tool" ? `call-${index}` : null,
        null,
        `window-${index}`,
        JSON.stringify({
          tool: "read",
          status: "succeeded",
          content: "x".repeat(600),
          usage: { input: index, output: 1 },
          text: `row ${index}`,
        }),
      )
    }
  })
}

test("the progress window yields the same newest rows as progressFacts, a page at a time", () => {
  const fixture = makeFixture()
  try {
    seed(fixture)
    const ids = [firstAttemptID, secondAttemptID]
    const all = fixture.store.progressFacts(ids, 10_001)
    expect(all).toHaveLength(TOTAL)
    for (const visible of [10_000, TOTAL, TOTAL - 1, 1_000, 1]) {
      const window = fixture.store.progressReportWindow(ids, visible, 500)
      const pages = [...window.pages]
      const rows = pages.flat()
      const expected = all.slice(-visible)
      expect(window.truncated).toBe(all.length > visible)
      expect(rows.map((row) => row.seq)).toEqual(expected.map((row) => row.seq))
      // The report's projection of each row is identical.
      expect(rows.map(projectProgressFact)).toEqual(expected.map(projectProgressFact))
      // No page holds more than a page of payloads.
      expect(Math.max(...pages.map((page) => page.length))).toBeLessThanOrEqual(500)
    }
    expect([...fixture.store.progressReportWindow([], 10, 5).pages]).toEqual([])
    expect([...fixture.store.progressReportWindow(ids, 10, 5).pages].flat()).toHaveLength(10)
  } finally {
    fixture.close()
  }
})

test("the window reads fewer bytes in total and at most a page at once", () => {
  const fixture = makeFixture()
  try {
    seed(fixture)
    const ids = [firstAttemptID, secondAttemptID]
    const before = meterReads(fixture.store)
    fixture.store.progressFacts(ids)
    before.stop()
    const after = meterReads(fixture.store)
    const pages = [...fixture.store.progressReportWindow(ids).pages]
    after.stop()
    const of = (meter: ReturnType<typeof meterReads>) => meter.of(/FROM runner_progress/)
    console.log("progress read-meter, 3,200 rows with 700 B payloads", {
      before: { ...of(before), peakRowsHeld: TOTAL },
      after: { ...of(after), peakRowsHeld: Math.max(...pages.map((page) => page.length)) },
    })
    expect(of(after).bytes).toBeLessThan(of(before).bytes)
  } finally {
    fixture.close()
  }
})

test("a progress table without recorded_at still reads, with a null recording time", () => {
  const fixture = makeFixture()
  try {
    seed(fixture)
    fixture.store.atomic((db) => db.exec("ALTER TABLE runner_progress DROP COLUMN recorded_at"))
    const rows = [...fixture.store.progressReportWindow([firstAttemptID], 50, 20).pages].flat()
    expect(rows).toHaveLength(50)
    expect(rows.every((row) => row.recorded_at === null)).toBe(true)
  } finally {
    fixture.close()
  }
})

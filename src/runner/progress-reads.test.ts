import { expect, test } from "bun:test"
import { firstAttemptID, makeFixture, secondAttemptID } from "../../test/trajectory/fixture.ts"
import { meterReads } from "./read-meter.fixture.ts"
import { isUnavailableSessionRecoveryGap } from "./startup-settlement.ts"

type Fixture = ReturnType<typeof makeFixture>

let counter = 0
function insertProgress(
  fixture: Fixture,
  attemptID: string,
  row: { kind: string; source?: string; callID?: string | null; payload: object },
) {
  fixture.store.atomic((db) => {
    db.query(
      `INSERT INTO runner_progress
       (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,source,
        sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      fixture.directory,
      "project",
      fixture.attempts[0]!.plan_id,
      fixture.attempts[0]!.task_id,
      attemptID,
      "ses-progress",
      ++counter,
      counter,
      row.source ?? "recovery",
      JSON.stringify([row.source ?? "recovery"]),
      row.kind,
      "[]",
      row.callID ?? null,
      null,
      `progress-read-${counter}`,
      JSON.stringify(row.payload),
    )
  })
}
const unavailableGap = (index: number) => ({
  kind: "gap",
  payload: {
    reason: `Assigned native session is unavailable: ses-${index}`,
    note: "x".repeat(400),
  },
})
const otherGap = { kind: "gap", payload: { reason: "Native events were missed" } }

/** The read before this change: every progress row of the attempt, then a JS predicate. */
const legacy = (fixture: Fixture, attemptID: string) =>
  fixture.store.progressFacts([attemptID]).some((fact) => !isUnavailableSessionRecoveryGap(fact))
const current = (fixture: Fixture, attemptID: string) =>
  fixture.store.hasProgressBeyond(attemptID, isUnavailableSessionRecoveryGap)

test("meaningful worker progress matches the full read across row shapes and reads no payloads for it", () => {
  const fixture = makeFixture()
  try {
    // No rows at all.
    expect(current(fixture, firstAttemptID)).toBe(legacy(fixture, firstAttemptID))
    expect(current(fixture, firstAttemptID)).toBe(false)

    // Only unavailable-session gaps, more than one page of them: still not meaningful.
    for (let index = 0; index < 450; index++)
      insertProgress(fixture, firstAttemptID, unavailableGap(index))
    expect(current(fixture, firstAttemptID)).toBe(legacy(fixture, firstAttemptID))
    expect(current(fixture, firstAttemptID)).toBe(false)

    // Another attempt's rows never count.
    insertProgress(fixture, secondAttemptID, {
      kind: "tool",
      callID: "c1",
      payload: { tool: "read" },
    })
    expect(current(fixture, firstAttemptID)).toBe(false)

    // A gap with another reason is meaningful, found past the first page of ignorable gaps.
    insertProgress(fixture, firstAttemptID, otherGap)
    expect(current(fixture, firstAttemptID)).toBe(legacy(fixture, firstAttemptID))
    expect(current(fixture, firstAttemptID)).toBe(true)
  } finally {
    fixture.close()
  }

  const second = makeFixture()
  try {
    // A tool row decides at once, whatever else the attempt holds.
    for (let index = 0; index < 450; index++)
      insertProgress(second, firstAttemptID, unavailableGap(index))
    insertProgress(second, firstAttemptID, {
      kind: "tool",
      source: "native",
      callID: "c1",
      payload: { tool: "read" },
    })
    expect(current(second, firstAttemptID)).toBe(legacy(second, firstAttemptID))
    expect(current(second, firstAttemptID)).toBe(true)
    // A gap that carries a call id is not the recovery shape.
    const third = makeFixture()
    try {
      insertProgress(third, firstAttemptID, { kind: "gap", callID: "c9", payload: { reason: "x" } })
      expect(current(third, firstAttemptID)).toBe(legacy(third, firstAttemptID))
      expect(current(third, firstAttemptID)).toBe(true)
    } finally {
      third.close()
    }
  } finally {
    second.close()
  }
})

test("the meaningful-progress check reads one row where the full read returned every payload", () => {
  const fixture = makeFixture()
  try {
    for (let index = 0; index < 300; index++)
      insertProgress(fixture, firstAttemptID, {
        kind: "tool",
        source: "native",
        callID: `c${index}`,
        payload: { tool: "read", content: "x".repeat(1_000) },
      })
    const meter = meterReads(fixture.store)
    legacy(fixture, firstAttemptID)
    const before = { rows: meter.rows, bytes: meter.bytes }
    const mark = { rows: meter.rows, bytes: meter.bytes }
    current(fixture, firstAttemptID)
    const after = { rows: meter.rows - mark.rows, bytes: meter.bytes - mark.bytes }
    meter.stop()
    console.log("hasMeaningfulWorkerProgress read-meter, 300 tool rows of 1 KB:", { before, after })
    expect(after.rows).toBe(1)
    expect(after.bytes).toBeLessThan(before.bytes / 100)
  } finally {
    fixture.close()
  }
})

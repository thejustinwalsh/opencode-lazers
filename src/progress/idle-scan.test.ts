import { expect, test } from "bun:test"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { meterRepository } from "../runner/read-meter.fixture.ts"
import { ProgressRecorder } from "./recorder.ts"

/**
 * Idle behaviour (design/data-handling.md, principle 8): the reconstruction poll asks the recorder
 * for its assignments every five seconds. With the observation revision unmoved it reads that
 * one revision row, never an attempt, plan, task or progress row.
 */
test("an idle assignment scan reads the observation stamp and no history", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    fixture.store.atomic((db) => {
      for (let n = 0; n < 300; n++)
        db.query(
          `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,source,sources_json,kind,event_ids_json,dedupe_key,payload)
           VALUES(?,?,?,?,?,?,?,?,'seed','[]','tool','[]',?,'{}')`,
        ).run(
          fixture.directory,
          "project",
          fixture.receipt.planID,
          "task",
          "attempt",
          "session",
          n,
          n,
          `seed:${n}`,
        )
    })
    const first = recorder.assignments()
    expect(first.length).toBeGreaterThan(0)

    const meter = meterRepository(fixture.repository)
    for (let tick = 0; tick < 50; tick++) expect(recorder.assignments()).toEqual(first)
    meter.stop()
    if (process.env.READ_SWEEP_NUMBERS)
      console.log(
        `[read-sweep] idle assignment scan x50 rows=${meter.rows} bytes=${meter.bytes} statements=${meter.statements.length}`,
      )
    expect(
      meter.of(/runner_attempts|runner_plans|FROM tasks|runner_progress|native_tool_calls/).rows,
    ).toBe(0)
    expect(meter.rows).toBeLessThanOrEqual(50)
  } finally {
    fixture.close()
  }
})

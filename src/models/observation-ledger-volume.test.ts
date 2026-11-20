import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { openReadOnlyObservationLedger } from "./observation-ledger-read.ts"
import { makeLedgerFixture } from "../../test/models-observation-ledger/fixtures/ledger.ts"

type Fixture = ReturnType<typeof makeLedgerFixture>

/** Appends progress facts to the retry task's accepted attempt, straight into the table. */
function addFacts(
  fixture: Fixture,
  count: number,
  payload: (index: number) => Record<string, unknown>,
  eventIDs: (index: number) => string[] = () => [],
) {
  const attempt = fixture.attempts.accepted
  const db = new Database(fixture.path)
  try {
    const projectDirectory = db
      .query<{ project_directory: string }, [string]>(
        "SELECT project_directory FROM runner_plans WHERE id=?",
      )
      .get(attempt.plan_id)!.project_directory
    const insert = db.query(
      `INSERT INTO runner_progress
       (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
        source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    db.transaction(() => {
      for (let index = 0; index < count; index++)
        insert.run(
          projectDirectory,
          fixture.projectID,
          attempt.plan_id,
          attempt.task_id,
          attempt.id,
          attempt.session_id,
          10_000 + index,
          10_000 + index,
          "runtime",
          JSON.stringify(["runtime"]),
          "step",
          JSON.stringify(eventIDs(index)),
          null,
          null,
          `volume-${index}`,
          JSON.stringify(payload(index)),
        )
    })()
  } finally {
    db.close()
  }
}

function readComplete(fixture: Fixture) {
  const reader = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory, {
    cursorSecret: fixture.cursorSecret,
  })
  try {
    return reader.read({ limit: 100 })
  } finally {
    reader.close()
  }
}

const baseline = (() => {
  const fixture = makeLedgerFixture()
  try {
    return readComplete(fixture).tasks.find((t) => t.taskID === fixture.tasks.retry!.id)!
      .progressFacts.length
  } finally {
    fixture.close()
  }
})()

test("a ledger with more than 10,000 progress facts is read whole and complete", () => {
  const fixture = makeLedgerFixture()
  try {
    addFacts(fixture, 10_050, () => ({ measurementBasis: null, usage: null }))
    const output = readComplete(fixture)
    const retry = output.tasks.find((t) => t.taskID === fixture.tasks.retry!.id)!
    expect(retry.progressFacts).toHaveLength(baseline + 10_050)
    expect(output.completeness.status).toBe("complete")
    expect(output.status).toBe("available")
  } finally {
    fixture.close()
  }
})

test("a capture above 64 MiB of retained rows is read whole and complete", () => {
  const fixture = makeLedgerFixture()
  try {
    const padding = "x".repeat(6 * 1024 * 1024)
    addFacts(fixture, 12, () => ({ measurementBasis: null, usage: null, padding }))
    const output = readComplete(fixture)
    const retry = output.tasks.find((t) => t.taskID === fixture.tasks.retry!.id)!
    expect(retry.progressFacts).toHaveLength(baseline + 12)
    expect(output.completeness.status).toBe("complete")
    expect(output.completeness.reasons).toEqual([])
  } finally {
    fixture.close()
  }
})

test("a fact with hundreds of event ids and observations keeps every one", () => {
  const fixture = makeLedgerFixture()
  try {
    addFacts(
      fixture,
      1,
      () => ({
        measurementBasis: null,
        usage: null,
        observations: Array.from({ length: 300 }, (_, index) => ({
          source: "native-event",
          eventType: "session.step.started",
          at: null,
          messageID: null,
          callID: null,
          route: { providerID: "openai", modelID: `model-${index % 3}`, variant: null },
        })),
      }),
      () => Array.from({ length: 1321 }, (_, index) => `evt-${index}`),
    )
    const output = readComplete(fixture)
    const retry = output.tasks.find((t) => t.taskID === fixture.tasks.retry!.id)!
    const fact = retry.progressFacts.find((f) => f.observations.length === 300)!
    expect(fact.eventIDs).toHaveLength(1321)
    expect(fact).toMatchObject({ observationCoverage: "complete", omittedObservationCount: 0 })
    expect(output.completeness.status).toBe("complete")
  } finally {
    fixture.close()
  }
})

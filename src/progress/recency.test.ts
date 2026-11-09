import { expect, test } from "bun:test"
import { makeFixture, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { RunnerStore } from "../runner/store.ts"
import { ProgressRecorder } from "./recorder.ts"

test("S8-3 observation recency migration preserves facts and updates once for legacy writers", () => {
  const f = makeFixture()
  try {
    new ProgressRecorder(f.store, "project").recordNativeEvent({
      id: "recency-migration-start",
      type: "session.step.started",
      created: 1000,
      data: { sessionID: "ses-failed", assistantMessageID: "recency-message" },
    })
    f.store.atomic((db) => {
      db.exec(
        "DROP TRIGGER runner_progress_recency_inserted; DROP TRIGGER runner_progress_recency_updated; DROP INDEX runner_progress_plan_recency; ALTER TABLE runner_progress DROP COLUMN latest_observed_at",
      )
      db.query(
        "UPDATE runner_progress SET payload=json_set(payload,'$.observations',json_array(json_object('at',5000))) WHERE attempt_id=?",
      ).run(firstAttemptID)
      db.exec("UPDATE schema_modules SET generation=2 WHERE module='runner'")
    })
    const snapshot = () =>
      f.store.atomic((db) => ({
        facts: db
          .query("SELECT seq,at,recorded_at,kind,payload FROM runner_progress ORDER BY seq")
          .all(),
        changes: db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM recovery_progress_facts")
          .get()!.count,
        revision: db
          .query<{ revision: number }, [string]>(
            "SELECT revision FROM observation_revisions WHERE project_directory=?",
          )
          .get(f.directory)!.revision,
      }))
    const before = snapshot()
    const reopened = new RunnerStore(f.repository)
    expect(snapshot()).toEqual(before)
    const recency = () =>
      reopened.atomic(
        (db) =>
          db
            .query<{ latest_observed_at: number }, [string]>(
              "SELECT latest_observed_at FROM runner_progress WHERE attempt_id=?",
            )
            .get(firstAttemptID)!.latest_observed_at,
      )
    expect(recency()).toBe(5000)
    reopened.atomic((db) =>
      db
        .query(
          "UPDATE runner_progress SET payload=json_set(payload,'$.observations',json_array(json_object('at',7000))) WHERE attempt_id=?",
        )
        .run(firstAttemptID),
    )
    expect(recency()).toBe(7000)
    expect(snapshot().changes).toBe(before.changes + 1)
    expect(snapshot().revision).toBe(before.revision + 1)
    const plan = reopened.atomic((db) =>
      db
        .query(
          "EXPLAIN QUERY PLAN SELECT seq,latest_observed_at FROM runner_progress WHERE plan_id=? ORDER BY latest_observed_at DESC,seq DESC LIMIT 5001",
        )
        .all(f.receipt.planID),
    )
    expect(JSON.stringify(plan)).toContain("runner_progress_plan_recency")
  } finally {
    f.close()
  }
})

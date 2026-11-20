import { afterEach, expect, test } from "bun:test"
import { makeFixture } from "../test/trajectory/fixture.ts"
import { ProgressRecorder } from "./progress/recorder.ts"
import { RecoveryJournal } from "./recovery/journal.ts"
import { ModelEvidenceStore } from "./models/source-store.ts"
import { RunnerStore } from "./runner/store.ts"

const fixtures: Array<ReturnType<typeof makeFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

const RETIRED = [
  "runner_progress_plan_seq",
  "native_tool_calls_session",
  "recovery_progress_facts_project_source",
  "model_evidence_snapshots_project_source",
] as const

function setup() {
  const fixture = makeFixture()
  fixtures.push(fixture)
  new ProgressRecorder(fixture.store, "project")
  new ModelEvidenceStore(fixture.repository.path, fixture.directory)
  return fixture
}

const present = (fixture: ReturnType<typeof makeFixture>) =>
  fixture.store.atomic((db) =>
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((row) => row.name),
  )

const plan = (fixture: ReturnType<typeof makeFixture>, sql: string, ...values: string[]) =>
  fixture.store
    .atomic((db) =>
      db.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...values),
    )
    .map((row) => row.detail)
    .join(" | ")

test("a fresh database never creates the retired indexes", () => {
  const names = present(setup())
  for (const name of RETIRED) expect(names).not.toContain(name)
})

test("upgrading a database that has them drops them, and the statements they could serve keep an index", () => {
  const fixture = setup()
  fixture.store.atomic((db) => {
    db.exec(`
      CREATE INDEX runner_progress_plan_seq ON runner_progress(plan_id,seq);
      CREATE INDEX native_tool_calls_session ON native_tool_calls(project_directory,session_id,first_observed_at);
      CREATE INDEX recovery_progress_facts_project_source ON recovery_progress_facts(project_directory,source_seq,change_id);
      UPDATE schema_modules SET generation=15 WHERE module='runner';
    `)
  })
  expect(present(fixture)).toContain("runner_progress_plan_seq")
  // A reload builds new stores on the same connection: the upgrade must run again.
  new RunnerStore(fixture.repository)
  new RecoveryJournal(fixture.repository)
  const names = present(fixture)
  for (const name of RETIRED) expect(names).not.toContain(name)
  expect(
    plan(fixture, "SELECT seq FROM runner_progress WHERE plan_id=? ORDER BY seq", "p"),
  ).toContain("runner_progress_plan_recency")
  expect(
    plan(
      fixture,
      "SELECT * FROM native_tool_calls WHERE project_directory=? AND session_id=?",
      "d",
      "s",
    ),
  ).toContain("native_tool_calls_local")
  expect(
    plan(
      fixture,
      "SELECT change_id FROM recovery_progress_facts WHERE project_directory=? ORDER BY change_id DESC LIMIT 257",
      "d",
    ),
  ).toContain("recovery_progress_facts_project_cursor")
  expect(
    plan(
      fixture,
      "SELECT body FROM model_evidence_snapshots WHERE project_directory=? AND source=? ORDER BY generation DESC LIMIT 1",
      "d",
      "s",
    ),
  ).toMatch(/sqlite_autoindex_model_evidence_snapshots_\d/)
})

test("the hot path creates no retired index", () => {
  const fixture = setup()
  for (let round = 0; round < 3; round++) {
    new RunnerStore(fixture.repository)
    new RecoveryJournal(fixture.repository)
    new ModelEvidenceStore(fixture.repository.path, fixture.directory)
  }
  const names = present(fixture)
  for (const name of RETIRED) expect(names).not.toContain(name)
})

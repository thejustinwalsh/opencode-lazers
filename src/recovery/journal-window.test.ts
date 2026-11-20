import { afterEach, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { makeFixture, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { RecoveryJournal, RECOVERY_FACT_WINDOW } from "./journal.ts"
import { previewRetention, retireSlice } from "../retention/retention.ts"

const fixtures: Array<ReturnType<typeof makeFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

function setup() {
  const fixture = makeFixture()
  fixtures.push(fixture)
  const journal = new RecoveryJournal(fixture.repository)
  return { fixture, journal }
}

function addProgress(fixture: ReturnType<typeof makeFixture>, from: number, count: number) {
  fixture.store.atomic((db) => {
    const insert = db.query(
      `INSERT INTO runner_progress (
        project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,
        source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload
      ) VALUES(?,?,?,?,?,?,?,'native-event','["native-event"]','tool','[]',NULL,NULL,?,?)`,
    )
    for (let index = from; index < from + count; index++)
      insert.run(
        fixture.directory,
        "project",
        fixture.receipt.planID,
        fixture.task.id,
        firstAttemptID,
        "ses-failed",
        index,
        `window-${index}`,
        "{}",
      )
  })
}

/** The exact query the live radar diagnostic runs (src/observability/live-store.ts). */
function newestFacts(db: Database, directory: string, limit = 257) {
  return db
    .query<{ change_id: number; source_seq: number }, [string, number]>(
      `SELECT change_id,source_seq FROM recovery_progress_facts
        WHERE project_directory=? ORDER BY change_id DESC LIMIT ?`,
    )
    .all(directory, limit)
}
const total = (db: Database) =>
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM recovery_progress_facts").get()!.n

test("the diagnostic's newest facts are unchanged while the table stays within the window", () => {
  const { fixture } = setup()
  const writes = RECOVERY_FACT_WINDOW + 300
  addProgress(fixture, 1, writes)
  fixture.store.atomic((db) => {
    expect(total(db)).toBe(RECOVERY_FACT_WINDOW)
    const facts = newestFacts(db, fixture.directory)
    expect(facts).toHaveLength(257)
    // Newest first, one fact per insert, in write order: what an unwindowed log would return.
    const seqs = db
      .query<{ seq: number }, [number]>("SELECT seq FROM runner_progress ORDER BY seq DESC LIMIT ?")
      .all(257)
      .map((row) => row.seq)
    expect(facts.map((fact) => fact.source_seq)).toEqual(seqs)
  })
})

test("updates also journal and prune", () => {
  const { fixture } = setup()
  addProgress(fixture, 1, 10)
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_progress SET payload='{\"a\":1}' WHERE dedupe_key='window-3'").run()
    expect(total(db)).toBe(11)
    expect(
      db
        .query<{ change_kind: string }, []>(
          "SELECT change_kind FROM recovery_progress_facts ORDER BY change_id DESC LIMIT 1",
        )
        .get()!.change_kind,
    ).toBe("modified")
  })
})

test("a registered consumer keeps every fact it has not reached", () => {
  const { fixture, journal } = setup()
  journal.page("lagging", 10)
  addProgress(fixture, 1, RECOVERY_FACT_WINDOW + 200)
  fixture.store.atomic((db) => expect(total(db)).toBe(RECOVERY_FACT_WINDOW + 200))
  let page = journal.page("lagging", 250)
  expect(page.facts[0]!.changeID).toBe(1)
  journal.advance(page)
  while (page.hasMore) {
    page = journal.page("lagging", 250)
    journal.advance(page)
  }
  addProgress(fixture, 100_000, 1)
  fixture.store.atomic((db) => expect(total(db)).toBeLessThan(RECOVERY_FACT_WINDOW + 201))
})

test("upgrading a populated journal drains the backlog in bounded steps and bulk retention clears it", async () => {
  const { fixture } = setup()
  const backlog = 5000
  fixture.store.atomic((db) => {
    // The shape of an old database: triggers without the window, facts piled up.
    db.exec("DROP TRIGGER recovery_progress_inserted; DROP TRIGGER recovery_progress_modified;")
    const insert = db.query(
      `INSERT INTO recovery_progress_facts(project_directory,project_id,plan_id,task_id,attempt_id,session_id,
         source_seq,source_at,change_kind,source_kind,source,previous_status,status,changed_fields)
       VALUES(?,?,?,?,?,?,?,?,'inserted','tool','native-event',NULL,NULL,'insert')`,
    )
    for (let index = 1; index <= backlog; index++)
      insert.run(
        fixture.directory,
        "project",
        fixture.receipt.planID,
        fixture.task.id,
        firstAttemptID,
        "ses-failed",
        index,
        index,
      )
  })
  const before = fixture.store.atomic((db) => newestFacts(db, fixture.directory))
  const reopened = new RecoveryJournal(fixture.repository)
  expect(reopened.coverage().projectDirectory).toBe(fixture.directory)
  fixture.store.atomic((db) => {
    // Installing deletes nothing: the upgrade does not rewrite the large table.
    expect(total(db)).toBe(backlog)
    expect(newestFacts(db, fixture.directory)).toEqual(before)
  })
  addProgress(fixture, 10_000, 10)
  fixture.store.atomic((db) => {
    // Each write adds one fact and removes at most 64 old ones.
    expect(total(db)).toBe(backlog + 10 - 10 * 64)
  })

  const now = Date.now()
  const preview = fixture.repository.read((db) => previewRetention(db, { now, days: 30 }))
  const window = (await preview).kinds.find((kind) => kind.id === "recovery-fact-window")!
  expect(window.rows).toBe(backlog + 10 - 10 * 64 - RECOVERY_FACT_WINDOW)
  expect(window.bytes).toBeGreaterThan(0)
  const slice = await retireSlice(
    (run) => fixture.store.atomic(run),
    (run) => fixture.repository.read(run),
    { now, days: 30, budgetMs: 10_000, batch: 500 },
  )
  expect(slice.removed["recovery-fact-window"]?.rows).toBe(window.rows)
  fixture.store.atomic((db) => {
    expect(total(db)).toBe(RECOVERY_FACT_WINDOW)
    expect(newestFacts(db, fixture.directory)[0]!.source_seq).toBe(10)
  })
})

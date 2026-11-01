import { expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "../runner/store.ts"
import { firstAttemptID, makeFixture } from "../../test/trajectory/fixture.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { RecoveryJournal } from "./journal.ts"

function insertProgress(
  db: Database,
  input: {
    projectDirectory: string
    projectID: string
    planID: string
    taskID: string
    attemptID: string
    sessionID: string
    at: number
    dedupeKey: string
    payload: string
  },
) {
  db.query(
    `INSERT INTO runner_progress (
      project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,
      source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload
    ) VALUES(?,?,?,?,?, ?,?,'native-event','["native-event"]','tool','[]',NULL,NULL,?,?)`,
  ).run(
    input.projectDirectory,
    input.projectID,
    input.planID,
    input.taskID,
    input.attemptID,
    input.sessionID,
    input.at,
    input.dedupeKey,
    input.payload,
  )
}

function factInput(fixture: ReturnType<typeof makeFixture>, dedupeKey: string, at = 1234) {
  return {
    projectDirectory: fixture.directory,
    projectID: "project",
    planID: fixture.receipt.planID,
    taskID: fixture.task.id,
    attemptID: firstAttemptID,
    sessionID: "ses-failed",
    at,
    dedupeKey,
    payload: JSON.stringify({ status: "running" }),
  }
}

test("journal captures inserts and in-place modifications, ignores replay, and survives reopen", () => {
  const fixture = makeFixture()
  let reopenedRepository: TaskRepository | undefined
  try {
    const journal = new RecoveryJournal(fixture.repository)
    const coverage = journal.coverage()
    expect(coverage).toMatchObject({
      kind: "legacy-or-unavailable",
      source: "runner_progress",
      sourceSequence: 0,
      afterChangeID: 0,
    })

    const input = factInput(fixture, "call-modified-with-stable-seq-at")
    fixture.store.atomic((db) => insertProgress(db, input))
    const insertedPage = journal.page("rule-engine", 10)
    expect(insertedPage.facts).toHaveLength(1)
    const inserted = insertedPage.facts[0]!
    expect(inserted).toMatchObject({
      projectDirectory: fixture.directory,
      projectID: "project",
      planID: fixture.receipt.planID,
      taskID: fixture.task.id,
      attemptID: firstAttemptID,
      sessionID: "ses-failed",
      sourceAt: input.at,
      changeKind: "inserted",
      sourceKind: "tool",
      status: "running",
    })
    journal.advance(insertedPage)

    fixture.store.atomic((db) => {
      db.query("UPDATE runner_progress SET payload=? WHERE dedupe_key=?").run(
        JSON.stringify({ status: "failed", error: "api_key=not-retained" }),
        input.dedupeKey,
      )
    })
    const modifiedPage = journal.page("rule-engine", 10)
    expect(modifiedPage.facts).toHaveLength(1)
    const modified = modifiedPage.facts[0]!
    expect(modified).toMatchObject({
      sourceSequence: inserted.sourceSequence,
      sourceAt: inserted.sourceAt,
      changeKind: "modified",
      previousStatus: "running",
      status: "failed",
      changedFields: ["payload"],
    })
    expect(JSON.stringify(modifiedPage)).not.toContain("api_key=not-retained")
    journal.advance(modifiedPage)

    // An identical source write is not a new modification fact.
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_progress SET payload=? WHERE dedupe_key=?").run(
        JSON.stringify({ status: "failed", error: "api_key=not-retained" }),
        input.dedupeKey,
      )
      db.query(
        `INSERT OR IGNORE INTO runner_progress (
          project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,
          source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload
        ) VALUES(?,?,?,?,?, ?,?,'native-event','["native-event"]','tool','[]',NULL,NULL,?,?)`,
      ).run(
        input.projectDirectory,
        input.projectID,
        input.planID,
        input.taskID,
        input.attemptID,
        input.sessionID,
        input.at,
        input.dedupeKey,
        input.payload,
      )
    })
    const unchanged = journal.page("rule-engine", 10)
    expect(unchanged.facts).toEqual([])
    expect(unchanged.metrics).toEqual({
      pageCount: 1,
      serializedBytesRead: 0,
      sourcePayloadsRead: 0,
    })

    const dbPath = fixture.repository.path
    const projectDirectory = fixture.repository.projectDirectory
    fixture.repository.close()
    reopenedRepository = new TaskRepository(dbPath, projectDirectory)
    new RunnerStore(reopenedRepository)
    const reopenedJournal = new RecoveryJournal(reopenedRepository)
    const resumed = reopenedJournal.page("rule-engine", 10)
    expect(resumed.facts).toEqual([])

    reopenedRepository.atomic((db) =>
      insertProgress(db, {
        ...input,
        dedupeKey: "after-reopen",
        at: 5678,
        payload: JSON.stringify({ status: "started" }),
      }),
    )
    const continuation = reopenedJournal.page("rule-engine", 10)
    expect(continuation.facts.map((fact) => [fact.changeKind, fact.status])).toEqual([
      ["inserted", "started"],
    ])

    const replay = reopenedJournal.page("new-consumer", 10)
    expect(replay.coverage).toEqual(coverage)
    expect(replay.facts.map((fact) => [fact.changeKind, fact.sourceSequence, fact.status])).toEqual(
      [
        ["inserted", inserted.sourceSequence, "running"],
        ["modified", inserted.sourceSequence, "failed"],
        ["inserted", continuation.facts[0]!.sourceSequence, "started"],
      ],
    )
  } finally {
    reopenedRepository?.close()
    fixture.close()
  }
})

test("pre-journal rows are represented by an explicit starting boundary, not fabricated history", () => {
  const fixture = makeFixture()
  try {
    let legacySequence = 0
    fixture.store.atomic((db) => {
      insertProgress(db, factInput(fixture, "legacy-row"))
      legacySequence = db.query<{ seq: number }, []>("SELECT last_insert_rowid() AS seq").get()!.seq
    })
    const journal = new RecoveryJournal(fixture.repository)
    const page = journal.page("consumer", 10)
    expect(journal.coverage()).toMatchObject({
      kind: "legacy-or-unavailable",
      sourceSequence: legacySequence,
      reason: expect.stringContaining("no modification history"),
    })
    expect(page.coverage.sourceSequence).toBe(legacySequence)
    expect(page.facts).toEqual([])

    fixture.store.atomic((db) => {
      db.query("UPDATE runner_progress SET payload=? WHERE dedupe_key='legacy-row'").run(
        JSON.stringify({ status: "failed" }),
      )
    })
    const change = journal.page("consumer", 10)
    expect(change.facts).toHaveLength(1)
    expect(change.facts[0]).toMatchObject({
      sourceSequence: legacySequence,
      changeKind: "modified",
      status: "failed",
    })
  } finally {
    fixture.close()
  }
})

test("a native terminal failure modifies the recorder's existing call without changing its identity", () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const journal = new RecoveryJournal(fixture.repository)
    const recorder = new ProgressRecorder(fixture.store, "project")
    const call = {
      tool: "Bash",
      sessionID: "ses-failed",
      agent: "lazers-implementor",
      messageID: "assistant-message-recovery",
      callID: "recovery-call",
      status: "completed" as const,
      result: { content: [{ type: "text" as const, text: "initially successful" }] },
    }
    recorder.recordToolHook(call)
    const inserted = journal.page("recovery-rule", 10)
    expect(inserted.facts).toHaveLength(1)
    expect(inserted.facts[0]!.status).toBe("succeeded")
    journal.advance(inserted)

    recorder.recordNativeEvent({
      id: "late-native-failure",
      type: "session.tool.failed",
      created: 9876,
      data: {
        sessionID: call.sessionID,
        assistantMessageID: call.messageID,
        id: call.callID,
        error: { type: "ToolError", message: "final result failed" },
      },
    })
    const modified = journal.page("recovery-rule", 10)
    expect(modified.facts).toHaveLength(1)
    expect(modified.facts[0]).toMatchObject({
      sourceSequence: inserted.facts[0]!.sourceSequence,
      sourceAt: inserted.facts[0]!.sourceAt,
      changeKind: "modified",
      previousStatus: "succeeded",
      status: "failed",
    })
  } finally {
    fixture.close()
  }
})

test("source writes and journal facts roll back together; caller result and cursor share a transaction", () => {
  const fixture = makeFixture()
  try {
    const journal = new RecoveryJournal(fixture.repository)
    const input = factInput(fixture, "rollback-source")
    expect(() =>
      fixture.store.atomic((db) => {
        insertProgress(db, input)
        throw new Error("abort source write")
      }),
    ).toThrow("abort source write")
    expect(journal.page("rollback-check", 10).facts).toEqual([])

    fixture.store.atomic((db) => insertProgress(db, factInput(fixture, "caller-transaction")))
    expect(() =>
      fixture.store.atomic((db) => {
        db.query("UPDATE runner_progress SET payload=? WHERE dedupe_key='caller-transaction'").run(
          JSON.stringify({ status: "failed" }),
        )
        throw new Error("abort source modification")
      }),
    ).toThrow("abort source modification")
    fixture.store.atomic((db) =>
      db.exec("CREATE TABLE IF NOT EXISTS recovery_result_probe (id INTEGER PRIMARY KEY)"),
    )
    expect(() =>
      fixture.store.atomic((db) => {
        const page = journal.pageIn(db, "transactional-consumer", 10)
        expect(page.facts).toHaveLength(1)
        db.query("INSERT INTO recovery_result_probe(id) VALUES(1)").run()
        journal.advanceIn(db, page)
        throw new Error("abort result and cursor")
      }),
    ).toThrow("abort result and cursor")

    const stillPending = journal.page("transactional-consumer", 10)
    expect(stillPending.facts).toHaveLength(1)
    const probe = fixture.store.atomic(
      (db) =>
        db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM recovery_result_probe")
          .get()!.count,
    )
    expect(probe).toBe(0)
    fixture.store.atomic((db) => journal.advanceIn(db, stillPending))
    expect(journal.page("transactional-consumer", 10).facts).toEqual([])
  } finally {
    fixture.close()
  }
})

test("bounded pages measure observed journal reads and unchanged polls do not reread history", () => {
  const fixture = makeFixture()
  try {
    const journal = new RecoveryJournal(fixture.repository)
    fixture.store.atomic((db) => {
      for (let index = 0; index < 11; index++)
        insertProgress(db, factInput(fixture, `bounded-${index}`, 2000 + index))
    })

    let calls = 0
    let serializedBytesRead = 0
    let seen = 0
    for (;;) {
      const page = journal.page("bounded-consumer", 3)
      calls += page.metrics.pageCount
      serializedBytesRead += page.metrics.serializedBytesRead
      seen += page.facts.length
      expect(page.facts.length).toBeLessThanOrEqual(3)
      expect(page.metrics.serializedBytesRead).toBe(
        new TextEncoder().encode(JSON.stringify(page.facts)).byteLength,
      )
      if (page.facts.length) journal.advance(page)
      if (!page.hasMore) break
    }
    expect({ calls, seen }).toEqual({ calls: 4, seen: 11 })
    expect(serializedBytesRead).toBeGreaterThan(0)

    const unchanged = journal.page("bounded-consumer", 3)
    expect(unchanged.facts).toEqual([])
    expect(unchanged.hasMore).toBe(false)
    expect(unchanged.metrics).toEqual({
      pageCount: 1,
      serializedBytesRead: 0,
      sourcePayloadsRead: 0,
    })
  } finally {
    fixture.close()
  }
})

test("project isolation and stale cursor checks cannot skip journal facts", () => {
  const fixture = makeFixture()
  let otherRepository: TaskRepository | undefined
  try {
    const journal = new RecoveryJournal(fixture.repository)
    otherRepository = new TaskRepository(fixture.repository.path, `${fixture.directory}/other`)
    new RunnerStore(otherRepository)
    const otherJournal = new RecoveryJournal(otherRepository)

    fixture.store.atomic((db) => insertProgress(db, factInput(fixture, "local-fact")))
    const otherInput = {
      ...factInput(fixture, "foreign-fact"),
      projectDirectory: `${fixture.directory}/other`,
      projectID: "other-project",
      planID: fixture.receipt.planID,
      sessionID: "ses-other",
    }
    fixture.store.atomic((db) => insertProgress(db, otherInput))

    const localPage = journal.page("project-consumer", 10)
    expect(localPage.facts.map((fact) => fact.projectDirectory)).toEqual([fixture.directory])
    expect(() =>
      journal.advance({ ...localPage, projectDirectory: otherInput.projectDirectory }),
    ).toThrow("different project")

    const stale = journal.page("project-consumer", 10)
    journal.advance(localPage)
    expect(() => journal.advance(stale)).toThrow("Stale recovery journal cursor")

    fixture.store.atomic((db) => insertProgress(db, factInput(fixture, "after-stale-page", 9000)))
    const next = journal.page("project-consumer", 10)
    expect(next.facts).toHaveLength(1)
    expect(next.facts[0]!.sourceAt).toBe(9000)
    expect(otherJournal.page("project-consumer", 10).facts.map((fact) => fact.projectID)).toEqual([
      "other-project",
    ])
  } finally {
    otherRepository?.close()
    fixture.close()
  }
})

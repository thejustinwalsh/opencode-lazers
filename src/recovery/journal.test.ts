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

test.each([1, 10])(
  "captured page advances its exact prefix after later appends (limit %i)",
  (limit) => {
    const fixture = makeFixture()
    try {
      const journal = new RecoveryJournal(fixture.repository)
      journal.coverage()
      fixture.store.atomic((db) => insertProgress(db, factInput(fixture, "captured-first")))
      const captured = journal.page("captured-prefix", limit)
      expect(captured.facts).toHaveLength(1)
      expect(captured.hasMore).toBe(false)
      fixture.store.atomic((db) => insertProgress(db, factInput(fixture, "appended-later", 1235)))
      journal.advance(captured)
      const remaining = journal.page("captured-prefix", limit)
      expect(remaining.facts).toHaveLength(1)
      expect(remaining.fromChangeID).toBe(captured.throughChangeID)
      expect(remaining.facts[0]!.changeID).toBeGreaterThan(captured.throughChangeID)
      expect(() => journal.advance(captured)).toThrow("Stale recovery journal cursor")
      journal.advance(remaining)
      expect(journal.page("captured-prefix", limit).facts).toEqual([])
    } finally {
      fixture.close()
    }
  },
)

test("an empty captured page cannot consume facts appended before advancement", () => {
  const fixture = makeFixture()
  try {
    const journal = new RecoveryJournal(fixture.repository)
    const empty = journal.page("empty-capture", 10)
    expect(empty.facts).toEqual([])
    fixture.store.atomic((db) => insertProgress(db, factInput(fixture, "after-empty-capture")))
    journal.advance(empty)
    const remaining = journal.page("empty-capture", 10)
    expect(remaining.fromChangeID).toBe(empty.fromChangeID)
    expect(remaining.facts).toHaveLength(1)
  } finally {
    fixture.close()
  }
})

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

    // Replaying an older delivery after persistence changed is ignored upstream,
    // not recorded as another persisted modification.
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
    const persistedPayload = fixture.store.atomic(
      (db) =>
        db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM runner_progress WHERE dedupe_key=?",
          )
          .get(input.dedupeKey)!.payload,
    )
    expect(JSON.parse(persistedPayload)).toMatchObject({ status: "failed" })
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
      afterChangeID: 0,
      sourceSequence: legacySequence,
      reason: expect.stringContaining("unavailable history"),
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

test("late project initialization retains facts captured by another project's triggers", () => {
  const fixture = makeFixture()
  let otherRepository: TaskRepository | undefined
  let reopenedRepository: TaskRepository | undefined
  try {
    const otherDirectory = `${fixture.directory}/other`
    const legacySequence = fixture.store.atomic((db) => {
      insertProgress(db, {
        ...factInput(fixture, "late-project-legacy"),
        projectDirectory: otherDirectory,
        projectID: "other-project",
      })
      return db
        .query<{ seq: number }, [string, string]>(
          "SELECT seq FROM runner_progress WHERE project_directory=? AND dedupe_key=?",
        )
        .get(otherDirectory, "late-project-legacy")!.seq
    })

    // This installation creates database-wide triggers but only records
    // project-specific coverage for the fixture project.
    new RecoveryJournal(fixture.repository)
    const capturedSequence = fixture.store.atomic((db) => {
      insertProgress(db, {
        ...factInput(fixture, "late-project-captured"),
        projectDirectory: otherDirectory,
        projectID: "other-project",
      })
      const sequence = db
        .query<{ seq: number }, [string, string]>(
          "SELECT seq FROM runner_progress WHERE project_directory=? AND dedupe_key=?",
        )
        .get(otherDirectory, "late-project-captured")!.seq
      db.query(
        "UPDATE runner_progress SET payload=? WHERE project_directory=? AND dedupe_key=?",
      ).run(JSON.stringify({ status: "failed" }), otherDirectory, "late-project-captured")
      return sequence
    })

    otherRepository = new TaskRepository(fixture.repository.path, otherDirectory)
    new RunnerStore(otherRepository)
    const otherJournal = new RecoveryJournal(otherRepository)
    const page = otherJournal.page("late-project-consumer", 10)
    expect(page.coverage.afterChangeID).toBe(0)
    expect(page.coverage.reason).toContain(
      "facts captured before this project's initialization remain eligible",
    )
    expect(page.coverage.sourceSequence).toBe(capturedSequence)
    expect(
      page.facts.map(({ changeKind, sourceSequence, status }) => [
        changeKind,
        sourceSequence,
        status,
      ]),
    ).toEqual([
      ["inserted", capturedSequence, "running"],
      ["modified", capturedSequence, "failed"],
    ])
    expect(page.facts.some((fact) => fact.sourceSequence === legacySequence)).toBe(false)

    otherJournal.advance(page)
    const dbPath = otherRepository.path
    otherRepository.close()
    otherRepository = undefined
    reopenedRepository = new TaskRepository(dbPath, otherDirectory)
    new RunnerStore(reopenedRepository)
    const reopenedJournal = new RecoveryJournal(reopenedRepository)
    expect(reopenedJournal.page("late-project-consumer", 10).facts).toEqual([])
    expect(reopenedJournal.page("late-project-new-consumer", 10).facts).toEqual(page.facts)
  } finally {
    reopenedRepository?.close()
    otherRepository?.close()
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

test("advance rejects forged IDs, substituted facts, and invalid boundaries atomically", () => {
  const fixture = makeFixture()
  let otherRepository: TaskRepository | undefined
  try {
    const journal = new RecoveryJournal(fixture.repository)
    const otherDirectory = `${fixture.directory}/other`
    otherRepository = new TaskRepository(fixture.repository.path, otherDirectory)
    new RunnerStore(otherRepository)

    fixture.store.atomic((db) => {
      insertProgress(db, factInput(fixture, "exact-page-first"))
      insertProgress(db, factInput(fixture, "exact-page-second", 1235))
      insertProgress(db, {
        ...factInput(fixture, "exact-page-foreign", 1236),
        projectDirectory: otherDirectory,
        projectID: "other-project",
      })
    })
    const foreignChangeID = fixture.store.atomic(
      (db) =>
        db
          .query<{ change_id: number }, [string]>(
            "SELECT change_id FROM recovery_progress_facts WHERE project_directory=?",
          )
          .get(otherDirectory)!.change_id,
    )
    const page = journal.page("exact-page-consumer", 2)
    expect(page.facts.map((fact) => fact.changeID)).toHaveLength(2)
    expect(foreignChangeID).toBeGreaterThan(page.facts[1]!.changeID)

    fixture.store.atomic((db) =>
      db.exec("CREATE TABLE recovery_result_probe (id INTEGER PRIMARY KEY)"),
    )
    const probeCount = () =>
      fixture.store.atomic(
        (db) =>
          db
            .query<{ count: number }, []>("SELECT count(*) AS count FROM recovery_result_probe")
            .get()!.count,
      )
    const rejectWithoutResult = (candidate: typeof page) => {
      expect(() =>
        fixture.store.atomic((db) => {
          db.query("INSERT INTO recovery_result_probe(id) VALUES(1)").run()
          journal.advanceIn(db, candidate)
        }),
      ).toThrow()
      expect(probeCount()).toBe(0)
      expect(journal.page("exact-page-consumer", 2).facts).toEqual(page.facts)
    }

    rejectWithoutResult({
      ...page,
      facts: [page.facts[0]!, { ...page.facts[1]!, changeID: foreignChangeID }],
      throughChangeID: foreignChangeID,
    })
    rejectWithoutResult({
      ...page,
      facts: [page.facts[0]!, { ...page.facts[1]!, status: "failed" }],
    })
    rejectWithoutResult({ ...page, throughChangeID: page.facts[1]!.changeID - 1 })
    rejectWithoutResult({ ...page, fromChangeID: -1 })
    const sparse = page.facts.slice()
    delete sparse[0]
    rejectWithoutResult({ ...page, facts: sparse })

    fixture.store.atomic((db) => {
      db.query("INSERT INTO recovery_result_probe(id) VALUES(1)").run()
      journal.advanceIn(db, page)
    })
    expect(probeCount()).toBe(1)
    expect(journal.page("exact-page-consumer", 2).facts).toEqual([])
  } finally {
    otherRepository?.close()
    fixture.close()
  }
})

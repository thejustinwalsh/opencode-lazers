import { expect, test } from "bun:test"
import { TaskRepository } from "../storage.ts"
import { firstAttemptID, makeFixture } from "../../test/trajectory/fixture.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { RunnerStore, type ProgressRow } from "../runner/store.ts"
import { RecoveryJournal } from "./journal.ts"

type CapturedFactRow = {
  change_id: number
  project_directory: string
  project_id: string
  plan_id: string
  task_id: string
  attempt_id: string
  session_id: string
  source_seq: number
  source_at: number
  change_kind: "inserted" | "modified"
  source_kind: string
  source: string
  previous_status: string | null
  status: string | null
  changed_fields: string
}

function capturedFacts(store: RunnerStore) {
  return store.atomic((db) =>
    db
      .query<CapturedFactRow, [string]>(
        `SELECT change_id,project_directory,project_id,plan_id,task_id,attempt_id,session_id,
                source_seq,source_at,change_kind,source_kind,source,previous_status,status,changed_fields
         FROM recovery_progress_facts WHERE project_directory=? ORDER BY change_id`,
      )
      .all(store.repository.projectDirectory),
  )
}

function progressRow(store: RunnerStore, dedupeKey: string): ProgressRow | null {
  return store.atomic((db) =>
    db
      .query<ProgressRow, [string, string]>(
        "SELECT * FROM runner_progress WHERE project_directory=? AND dedupe_key=?",
      )
      .get(store.repository.projectDirectory, dedupeKey),
  )
}

function recoveryTriggers(store: RunnerStore) {
  return store.atomic((db) =>
    db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='trigger'
         AND name IN ('recovery_progress_inserted','recovery_progress_modified') ORDER BY name`,
      )
      .all()
      .map(({ name }) => name),
  )
}

function activateAttempt(store: RunnerStore) {
  store.atomic((db) =>
    db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
  )
}

function toolCall(callID = "producer-call", messageID = "producer-message") {
  return {
    tool: "Bash",
    sessionID: "ses-failed",
    agent: "lazers-implementor",
    messageID,
    callID,
    status: "completed" as const,
    result: { content: [{ type: "text" as const, text: "private-tool-output-body" }] },
  }
}

function terminalFailure(callID: string, messageID: string, eventID: string) {
  return {
    id: eventID,
    type: "session.tool.failed",
    created: 9876,
    data: {
      sessionID: "ses-failed",
      assistantMessageID: messageID,
      id: callID,
      input: { command: "private-tool-input-body" },
      content: [{ type: "text", text: "private-native-output-body" }],
      error: { type: "ToolError", message: "private-tool-error-body" },
    },
  }
}

function runnerSnapshot(store: RunnerStore) {
  return store.atomic((db) => ({
    plans: db
      .query<{ id: string; state: string; version: number }, [string]>(
        "SELECT id,state,version FROM runner_plans WHERE project_directory=? ORDER BY id",
      )
      .all(store.repository.projectDirectory),
    nodes: db
      .query<{ plan_id: string; task_id: string; state: string; version: number }, [string]>(
        `SELECT n.plan_id,n.task_id,n.state,n.version FROM runner_nodes n
         JOIN runner_plans p ON p.id=n.plan_id WHERE p.project_directory=? ORDER BY n.plan_id,n.task_id`,
      )
      .all(store.repository.projectDirectory),
    attempts: db
      .query<{ id: string; state: string }, [string]>(
        `SELECT a.id,a.state FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
         WHERE p.project_directory=? ORDER BY a.id`,
      )
      .all(store.repository.projectDirectory),
    transitionCount: db
      .query<{ count: number }, [string]>(
        `SELECT count(*) AS count FROM runner_transitions t
         JOIN runner_plans p ON p.id=t.plan_id WHERE p.project_directory=?`,
      )
      .get(store.repository.projectDirectory)!.count,
    taskChangeCount: db
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM task_changes WHERE project_directory=?",
      )
      .get(store.repository.projectDirectory)!.count,
    observationRevision: db
      .query<{ revision: number }, [string]>(
        "SELECT revision FROM observation_revisions WHERE project_directory=?",
      )
      .get(store.repository.projectDirectory)?.revision,
  }))
}

test("ordinary RunnerStore initialization captures real recorder inserts and coalesced failures", () => {
  const fixture = makeFixture()
  try {
    activateAttempt(fixture.store)
    const recorder = new ProgressRecorder(fixture.store, "project")
    const call = toolCall()
    const insertedSequence = recorder.recordToolHook(call)

    // Inspect the automatic producer before constructing a test-side journal.
    expect(recoveryTriggers(fixture.store)).toEqual([
      "recovery_progress_inserted",
      "recovery_progress_modified",
    ])
    const insertedFacts = capturedFacts(fixture.store)
    expect(insertedFacts).toHaveLength(1)
    expect(insertedFacts[0]).toMatchObject({
      project_directory: fixture.directory,
      project_id: "project",
      plan_id: fixture.receipt.planID,
      task_id: fixture.task.id,
      attempt_id: firstAttemptID,
      session_id: "ses-failed",
      source_seq: insertedSequence,
      change_kind: "inserted",
      source_kind: "tool",
      status: "succeeded",
    })

    recorder.recordNativeEvent(terminalFailure(call.callID, call.messageID, "late-failure"))
    const facts = capturedFacts(fixture.store)
    expect(facts).toHaveLength(2)
    expect(facts[1]).toMatchObject({
      project_directory: fixture.directory,
      project_id: "project",
      plan_id: fixture.receipt.planID,
      task_id: fixture.task.id,
      attempt_id: firstAttemptID,
      session_id: "ses-failed",
      source_seq: insertedFacts[0]!.source_seq,
      source_at: insertedFacts[0]!.source_at,
      change_kind: "modified",
      previous_status: "succeeded",
      status: "failed",
    })
    expect(facts[1]!.changed_fields.split(",")).toContain("payload")

    const row = progressRow(fixture.store, `tool:${call.sessionID}:${call.callID}`)!
    expect(row).toMatchObject({
      seq: insertedFacts[0]!.source_seq,
      at: insertedFacts[0]!.source_at,
    })
    expect(JSON.parse(row.payload)).toMatchObject({ status: "failed" })
    expect(JSON.stringify(facts)).not.toMatch(
      /private-tool-(?:input|output|error)-body|private-native-output-body/,
    )

    const journal = new RecoveryJournal(fixture.repository)
    const page = journal.page("producer-capture", 10)
    expect(
      page.facts.map(({ changeKind, previousStatus, status }) => [
        changeKind,
        previousStatus,
        status,
      ]),
    ).toEqual([
      ["inserted", null, "succeeded"],
      ["modified", "succeeded", "failed"],
    ])
    expect(JSON.stringify(page)).not.toMatch(
      /private-tool-(?:input|output|error)-body|private-native-output-body/,
    )
  } finally {
    fixture.close()
  }
})

test("identical recorder replay is inert and real inserts or coalesced updates roll back atomically", () => {
  const fixture = makeFixture()
  try {
    activateAttempt(fixture.store)
    const recorder = new ProgressRecorder(fixture.store, "project")
    const call = toolCall("replay-call", "replay-message")
    recorder.recordToolHook(call)
    const originalRow = progressRow(fixture.store, `tool:${call.sessionID}:${call.callID}`)!
    const originalFacts = capturedFacts(fixture.store)
    expect(originalFacts).toHaveLength(1)

    expect(recorder.recordToolHook(call)).toBe(originalRow.seq)
    expect(progressRow(fixture.store, `tool:${call.sessionID}:${call.callID}`)).toEqual(originalRow)
    expect(capturedFacts(fixture.store)).toEqual(originalFacts)

    const rolledBackInsert = toolCall("rolled-back-insert", "rolled-back-message")
    expect(() =>
      fixture.store.atomic(() => {
        recorder.recordToolHook(rolledBackInsert)
        throw new Error("abort recorder insert")
      }),
    ).toThrow("abort recorder insert")
    expect(
      progressRow(fixture.store, `tool:${rolledBackInsert.sessionID}:${rolledBackInsert.callID}`),
    ).toBeNull()
    expect(capturedFacts(fixture.store)).toEqual(originalFacts)

    expect(() =>
      fixture.store.atomic(() => {
        recorder.recordNativeEvent(
          terminalFailure(call.callID, call.messageID, "rolled-back-terminal-failure"),
        )
        throw new Error("abort recorder update")
      }),
    ).toThrow("abort recorder update")
    expect(progressRow(fixture.store, `tool:${call.sessionID}:${call.callID}`)).toEqual(originalRow)
    expect(capturedFacts(fixture.store)).toEqual(originalFacts)
  } finally {
    fixture.close()
  }
})

test("captured producer prefix survives independent initialization and reopen", () => {
  const fixture = makeFixture()
  let independentRepository: TaskRepository | undefined
  let reopenedRepository: TaskRepository | undefined
  try {
    activateAttempt(fixture.store)
    const recorder = new ProgressRecorder(fixture.store, "project")
    const firstCall = toolCall("prefix-first", "prefix-message-first")
    recorder.recordToolHook(firstCall)
    recorder.recordNativeEvent(
      terminalFailure(firstCall.callID, firstCall.messageID, "prefix-failure"),
    )

    // The first real recorder writes were captured before any journal object exists.
    expect(capturedFacts(fixture.store)).toHaveLength(2)
    const journal = new RecoveryJournal(fixture.repository)
    const coverage = journal.coverage()
    expect(coverage).toMatchObject({
      projectDirectory: fixture.directory,
      kind: "legacy-or-unavailable",
      afterChangeID: 0,
      sourceSequence: 0,
    })
    const captured = journal.page("producer-prefix", 2)
    expect(captured.facts).toHaveLength(2)
    expect(captured.hasMore).toBe(false)

    const secondCall = toolCall("prefix-second", "prefix-message-second")
    recorder.recordToolHook(secondCall)
    journal.advance(captured)
    const pending = journal.page("producer-prefix", 2)
    expect(pending.facts).toHaveLength(1)
    expect(pending.facts[0]!.changeID).toBeGreaterThan(captured.throughChangeID)
    expect(pending.facts[0]!.sourceSequence).toBeGreaterThan(captured.facts.at(-1)!.sourceSequence)
    expect(pending.facts[0]!.changeID).toBeGreaterThan(coverage.afterChangeID)
    expect(pending.facts[0]!.sourceSequence).toBeGreaterThan(coverage.sourceSequence)
    expect(pending.facts[0]!.sourceSequence).toBe(
      progressRow(fixture.store, `tool:${secondCall.sessionID}:${secondCall.callID}`)!.seq,
    )

    let notifications = 0
    const unsubscribe = fixture.repository.subscribe(() => notifications++)
    const beforeRunnerInit = runnerSnapshot(fixture.store)
    try {
      new RunnerStore(fixture.repository)
    } finally {
      unsubscribe()
    }
    expect(runnerSnapshot(fixture.store)).toEqual(beforeRunnerInit)
    expect(notifications).toBe(0)

    independentRepository = new TaskRepository(fixture.repository.path, fixture.directory)
    const independentStore = new RunnerStore(independentRepository)
    const independentJournal = new RecoveryJournal(independentRepository)
    expect(recoveryTriggers(independentStore)).toEqual([
      "recovery_progress_inserted",
      "recovery_progress_modified",
    ])
    expect(independentJournal.coverage()).toEqual(coverage)
    expect(independentJournal.page("producer-prefix", 2).facts).toEqual(pending.facts)
    const allFacts = independentJournal.page("producer-all", 10)
    expect(allFacts.facts).toEqual(captured.facts.concat(pending.facts))
    independentRepository.close()
    independentRepository = undefined

    const dbPath = fixture.repository.path
    fixture.repository.close()
    reopenedRepository = new TaskRepository(dbPath, fixture.directory)
    const reopenedStore = new RunnerStore(reopenedRepository)
    const reopenedJournal = new RecoveryJournal(reopenedRepository)
    expect(recoveryTriggers(reopenedStore)).toEqual([
      "recovery_progress_inserted",
      "recovery_progress_modified",
    ])
    expect(reopenedJournal.coverage()).toEqual(coverage)
    expect(reopenedJournal.page("producer-prefix", 2).facts).toEqual(pending.facts)
    expect(reopenedJournal.page("producer-replay", 10).facts).toEqual(
      captured.facts.concat(pending.facts),
    )
  } finally {
    independentRepository?.close()
    reopenedRepository?.close()
    fixture.close()
  }
})

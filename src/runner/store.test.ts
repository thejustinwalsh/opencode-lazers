import { afterEach, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { fingerprint } from "../identity.ts"
import { TaskRepository } from "../storage.ts"
import { scopePatternsConflict } from "./artifacts.ts"
import { meterReads } from "./read-meter.fixture.ts"
import { PlanInput } from "./schema.ts"
import { appendRunnerEffectReceipt, RunnerStore } from "./store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []

function captureDatabaseExec<T>(run: () => T) {
  const statements: string[] = []
  const original = Database.prototype.exec
  const wrapped = function (this: Database, sql: string, ...bindings: SQLQueryBindings[]) {
    statements.push(sql)
    return Reflect.apply(original, this, [sql, ...bindings])
  }
  Database.prototype.exec = wrapped as typeof original
  try {
    return { value: run(), statements }
  } finally {
    Database.prototype.exec = original
  }
}

const isAttemptProjectDirectoryBackfill = (sql: string) =>
  /UPDATE\s+runner_attempts\s+SET\s+project_directory\s*=\s*\(SELECT\s+project_directory\s+FROM\s+runner_plans\s+WHERE\s+id=runner_attempts\.plan_id\)\s+WHERE\s+project_directory\s+IS\s+NOT/i.test(
    sql,
  )

test("active-attempt project-key migration backfills legacy rows once, not on reopen", () => {
  const f = fixture("active-attempt-project-key-migration")
  const receipt = f.store.submit(f.input, "owner")
  const taskID = f.input.nodes[0]!.taskID
  const retainedAttempts = 2_000

  f.repository.atomic((db) => {
    const insert = db.query(
      `INSERT INTO runner_attempts(
        id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'failed',?)`,
    )
    for (let index = 0; index < retainedAttempts; index++)
      insert.run(
        `legacy-attempt-${index}`,
        receipt.planID,
        taskID,
        index + 100,
        `legacy-session-${index}`,
        `legacy-message-${index}`,
        f.projectDirectory,
        "base",
        "{}",
        index,
      )
  })

  f.repository.atomic((db) =>
    db.exec(`
      -- S2-4: this historical fixture predates the runner module generation.
      DELETE FROM schema_modules WHERE module='runner';
      DROP TRIGGER runner_attempts_project_directory_insert;
      DROP TRIGGER runner_attempts_project_directory_plan_update;
      DROP TRIGGER runner_plans_project_directory_update;
      DROP TRIGGER observation_revision_runner_attempts_INSERT;
      DROP TRIGGER observation_revision_runner_attempts_UPDATE;
      DROP TRIGGER observation_revision_runner_attempts_DELETE;
      DROP INDEX runner_attempts_active_project;
      ALTER TABLE runner_attempts DROP COLUMN project_directory;
    `),
  )

  const migration = captureDatabaseExec(() => new RunnerStore(f.repository))
  expect(migration.statements.filter(isAttemptProjectDirectoryBackfill)).toHaveLength(1)
  expect(
    f.repository.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            `SELECT COUNT(*) AS count FROM runner_attempts
            WHERE session_id LIKE 'legacy-session-%' AND project_directory=?`,
          )
          .get(f.projectDirectory)!.count,
    ),
  ).toBe(retainedAttempts)

  f.repository.atomic((db) => {
    db.query(
      `INSERT INTO runner_attempts(
        id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'failed',?)`,
    ).run(
      "trigger-populated-attempt",
      receipt.planID,
      taskID,
      retainedAttempts + 100,
      "trigger-populated-session",
      "trigger-populated-message",
      f.projectDirectory,
      "base",
      "{}",
      retainedAttempts,
    )
    expect(
      db
        .query<{ project_directory: string }, [string]>(
          "SELECT project_directory FROM runner_attempts WHERE id=?",
        )
        .get("trigger-populated-attempt")?.project_directory,
    ).toBe(f.projectDirectory)
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='runner_attempts_active_project'",
        )
        .get()?.name,
    ).toBe("runner_attempts_active_project")
    expect(
      db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='trigger'
            AND name IN (
              'runner_attempts_project_directory_insert',
              'runner_attempts_project_directory_plan_update',
              'runner_plans_project_directory_update'
            ) ORDER BY name`,
        )
        .all()
        .map(({ name }) => name),
    ).toEqual([
      "runner_attempts_project_directory_insert",
      "runner_attempts_project_directory_plan_update",
      "runner_plans_project_directory_update",
    ])
    const movedProjectDirectory = `${f.projectDirectory}-moved`
    db.query("UPDATE runner_plans SET project_directory=? WHERE id=?").run(
      movedProjectDirectory,
      receipt.planID,
    )
    expect(
      db
        .query<{ project_directory: string }, [string]>(
          "SELECT project_directory FROM runner_attempts WHERE id=?",
        )
        .get("legacy-attempt-0")?.project_directory,
    ).toBe(movedProjectDirectory)
    db.query("UPDATE runner_plans SET project_directory=? WHERE id=?").run(
      f.projectDirectory,
      receipt.planID,
    )
  })

  f.repository.close()
  const reopened = new TaskRepository(f.databasePath, f.projectDirectory)
  repositories.push(reopened)
  const reopen = captureDatabaseExec(() => new RunnerStore(reopened))
  expect(reopen.statements.filter(isAttemptProjectDirectoryBackfill)).toHaveLength(0)
  expect(
    reopened.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            `SELECT COUNT(*) AS count FROM runner_attempts
            WHERE session_id LIKE 'legacy-session-%' AND project_directory=?`,
          )
          .get(f.projectDirectory)!.count,
    ),
  ).toBe(retainedAttempts)
})

test("legacy Architect renewal rows migrate to store an explicit continuity snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-architect-continuity-migration-"))
  directories.push(directory)
  const projectDirectory = join(directory, "project")
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), projectDirectory)
  repositories.push(repository)
  repository.atomic((db) =>
    db.exec(`
      CREATE TABLE runner_architect_renewals (
        id TEXT PRIMARY KEY, anchor_plan_id TEXT NOT NULL, previous_session_id TEXT NOT NULL,
        successor_session_id TEXT NOT NULL, directory TEXT NOT NULL, model TEXT NOT NULL,
        idle_at INTEGER NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
        handoff_message_id TEXT NOT NULL, handoff_outbox_id TEXT, input_message_id TEXT,
        error TEXT, started_at INTEGER NOT NULL
      )
    `),
  )

  new RunnerStore(repository)

  expect(
    repository.atomic((db) =>
      db
        .query<{ name: string }, []>("PRAGMA table_info(runner_architect_renewals)")
        .all()
        .map((column) => column.name),
    ),
  ).toContain("continuity_json")
})

test("startup settlement receipt appends evidence without replacing the original operation failure", () => {
  const nativeFailure = { nativeFailure: { nativeTag: "WorktreeError", message: "setup failed" } }
  const settlement = { kind: "worktree-startup-failure-settled-absent", attemptID: "attempt" }
  const receipt = JSON.parse(appendRunnerEffectReceipt(JSON.stringify(nativeFailure), settlement))

  expect(receipt.history).toEqual([nativeFailure, settlement])
  expect(appendRunnerEffectReceipt(null, settlement)).toBe(
    JSON.stringify({ history: [settlement] }),
  )
})

test("legacy Architect input rows survive migration into the durable source journal", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-architect-input-migration-"))
  directories.push(directory)
  const projectDirectory = join(directory, "project")
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), projectDirectory)
  repositories.push(repository)
  repository.atomic((db) => {
    db.exec(`
      CREATE TABLE runner_architect_renewals (
        id TEXT PRIMARY KEY, anchor_plan_id TEXT NOT NULL, previous_session_id TEXT NOT NULL,
        successor_session_id TEXT NOT NULL, directory TEXT NOT NULL, model TEXT NOT NULL,
        idle_at INTEGER NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
        handoff_message_id TEXT NOT NULL, handoff_outbox_id TEXT, input_message_id TEXT,
        error TEXT, started_at INTEGER NOT NULL
      );
      CREATE TABLE runner_architect_inputs (
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
        renewal_id TEXT REFERENCES runner_architect_renewals(id),
        PRIMARY KEY(session_id,message_id)
      );
      CREATE INDEX runner_architect_inputs_recent
        ON runner_architect_inputs(session_id,observed_at);
    `)
    db.query(
      "INSERT INTO runner_architect_inputs(session_id,message_id,observed_at,renewal_id) VALUES(?,?,?,NULL)",
    ).run("ses_predecessor", "msg_observed_before_upgrade", 100)
  })

  const store = new RunnerStore(repository)
  const migrated = store.atomic((db) =>
    db
      .query<
        {
          message_id: string
          native_type: string | null
          disposition: string
          referenced_revision: number
          last_seen_sweep: number
        },
        [string]
      >(
        `SELECT message_id,native_type,disposition,referenced_revision,last_seen_sweep
         FROM runner_architect_inputs WHERE session_id=?`,
      )
      .get("ses_predecessor"),
  )
  const sourceTableExists = repository.atomic((db) =>
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='runner_architect_sources'",
      )
      .get(),
  )

  expect(migrated).toEqual({
    message_id: "msg_observed_before_upgrade",
    native_type: null,
    disposition: "unknown",
    referenced_revision: 0,
    last_seen_sweep: 0,
  })
  expect(sourceTableExists?.name).toBe("runner_architect_sources")
})

function fixture(requestID = "plan-title-store") {
  const directory = mkdtempSync(join(tmpdir(), "lazers-plan-title-"))
  directories.push(directory)
  const projectDirectory = join(directory, "project")
  const databasePath = join(directory, "tasks.sqlite")
  const repository = new TaskRepository(databasePath, projectDirectory)
  repositories.push(repository)
  const task = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory,
      workspaceDirectory: projectDirectory,
      sessionID: "owner",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  })
  const store = new RunnerStore(repository)
  const input = {
    requestID,
    objective: "Execute operational work and verify its outcome",
    baseCommit: "b".repeat(40),
    nodes: [{ taskID: task.id, revision: 1 as const }],
    dependencies: [],
    integrationOrder: [task.id],
    verification: task.proposal.verification,
    acceptance: task.proposal.acceptance,
  }
  return { databasePath, projectDirectory, repository, store, input }
}

test("F-S4-3 unchanged conditions do not append transitions or advance the repository watermark", () => {
  const f = fixture()
  const plan = f.store.submit(f.input, "owner")
  const payload = { continuityRevision: 1, uncoveredInputID: "new-input" }
  expect(f.store.recordOnce(plan.planID, null, "TEST_CONDITION", payload)).toBe(true)
  const version = f.repository.version()
  const other = new RunnerStore(f.repository)
  for (let index = 0; index < 100; index++) {
    expect(
      other.recordOnce(plan.planID, null, "TEST_CONDITION", {
        uncoveredInputID: "new-input",
        continuityRevision: 1,
      }),
    ).toBe(false)
  }
  expect(f.repository.version()).toBe(version)
  expect(
    other.recordOnce(plan.planID, null, "TEST_CONDITION", { ...payload, continuityRevision: 2 }),
  ).toBe(true)
  expect(f.repository.version()).toBeGreaterThan(version)
  expect(other.recordOnce(plan.planID, f.input.nodes[0]!.taskID, "TEST_CONDITION", payload)).toBe(
    true,
  )
  expect(other.recordOnce(plan.planID, null, "TEST_CONDITION", payload)).toBe(true)
  expect(
    (f.store.detail(plan.planID).activity as { event: string }[]).filter(
      (row) => row.event === "TEST_CONDITION",
    ),
  ).toHaveLength(4)
})

test("S2-4 runner module upgrade installs the shared lookup indexes and skips current DDL", () => {
  const f = fixture()
  const indexes = [
    ["runner_progress_plan_seq", "SELECT * FROM runner_progress WHERE plan_id=? ORDER BY seq"],
    ["runner_attempts_plan", "SELECT * FROM runner_attempts WHERE plan_id=?"],
  ] as const
  f.store.atomic((db) => {
    for (const [index] of indexes) db.exec(`DROP INDEX ${index}`)
    db.query("DELETE FROM schema_modules WHERE module='runner'").run()
  })
  new RunnerStore(f.repository)
  for (const [index, sql] of indexes) {
    expect(
      f.repository
        .read((db) =>
          db.query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${sql}`).all("unused"),
        )
        .some((row) => row.detail.includes(index)),
    ).toBe(true)
  }
  // S2-4: the two session lookups already use UNIQUE autoindexes; do not duplicate them.
  for (const table of ["runner_attempts"]) {
    const plan = f.repository.read((db) =>
      db
        .query<{ detail: string }, [string]>(
          `EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE session_id=?`,
        )
        .all("unused"),
    )
    expect(
      plan.some(
        (row) => row.detail.includes("USING INDEX") && row.detail.includes("(session_id=?)"),
      ),
    ).toBe(true)
  }
  const current = captureDatabaseExec(() => new RunnerStore(f.repository))
  expect(
    current.statements.some((sql) => /CREATE TABLE IF NOT EXISTS runner_plans/.test(sql)),
  ).toBe(false)
  const stored = f.repository.read((db) =>
    db
      .query<{ tables_json: string; installed_at: number }, []>(
        "SELECT tables_json,installed_at FROM schema_modules WHERE module='runner'",
      )
      .get(),
  )!
  expect(JSON.parse(stored.tables_json)).toContain("runner_progress")
  expect(stored.installed_at).toBeGreaterThan(0)
})

test("conflict scans are retired: the upgrade drops the table and a hot path never recreates it", () => {
  const f = fixture()
  const tables = () =>
    f.store.atomic((db) =>
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name IN ('runner_conflict_scans','runner_audits')",
        )
        .all(),
    )
  expect(tables()).toEqual([])
  // A database from before the retirement: populated table, runner generation 14.
  f.store.atomic((db) => {
    db.exec(
      "CREATE TABLE runner_conflict_scans (id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, watermark INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)",
    )
    db.query("INSERT INTO runner_conflict_scans VALUES(?,?,?,?,?)").run("old", "/p", 1, "[]", 1)
    db.exec("UPDATE schema_modules SET generation=14 WHERE module='runner'")
  })
  const before = f.store.atomic((db) => db.query("SELECT * FROM runner_plans").all())
  new RunnerStore(f.repository)
  expect(tables()).toEqual([])
  expect(f.store.atomic((db) => db.query("SELECT * FROM runner_plans").all())).toEqual(before)
  // A still-loaded older plugin can recreate its table during an upgrade overlap.
  f.store.atomic((db) => db.exec("CREATE TABLE runner_audits (id TEXT)"))
  new RunnerStore(f.repository)
  expect(tables()).toEqual([])
  f.store.audit()
  expect(tables()).toEqual([])
})

test("F-S4-1 selected duplicate checks match the audit without execution/scope scans or writes", () => {
  const f = fixture()
  const original = f.repository.get(f.input.nodes[0]!.taskID)!
  const copy = (objective = original.proposal.objective) =>
    f.repository.insert({
      ...original,
      id: crypto.randomUUID(),
      proposal: { ...original.proposal, objective },
    })
  const duplicate = copy()
  const related = copy()
  const retired = copy()
  copy("Unrelated duplicate proposal")
  copy("Unrelated duplicate proposal")
  for (let index = 0; index < 30; index++) copy(`Independent task ${index}`)
  f.repository.recordDisposition(
    {
      taskID: retired.id,
      requestID: "retire-duplicate",
      disposition: "duplicate",
      reason: "Already covered",
      evidence: [{ kind: "human", reference: "fixture" }],
      relatedTaskIDs: [original.id],
    },
    { sessionID: "owner", agent: "architect" },
  )
  f.store.atomic((db) =>
    db
      .query("INSERT INTO runner_relations VALUES(?,?,?,?,?,?,?)")
      .run(
        f.projectDirectory,
        related.id,
        original.id,
        "distinct",
        "Intentional distinct work",
        "owner",
        100,
      ),
  )
  const expected = f.store
    .audit()
    .findings.filter(
      (finding) => finding.code === "exact-content" && finding.taskIDs.includes(original.id),
    )
  expect(expected).toHaveLength(1)
  const get = f.repository.get.bind(f.repository)
  let reads = 0
  f.repository.get = (id) => {
    reads++
    return get(id)
  }
  f.store.effectiveWriteScope = () => {
    throw new Error("Scope scan on duplicate hot path")
  }
  f.store.execution = () => {
    throw new Error("Execution scan on duplicate hot path")
  }
  const version = f.repository.version()
  expect(f.store.exactContentConflicts([original.id])).toEqual({
    watermark: version,
    findings: expected,
  })
  expect(reads).toBe(35)
  expect(
    f.store.exactContentConflicts([duplicate.id, original.id, original.id]).findings,
  ).toHaveLength(2)
  expect(f.store.exactContentConflicts([crypto.randomUUID()]).findings).toEqual([])
  expect(f.repository.version()).toBe(version)
})

function seedAuditTasks(f: ReturnType<typeof fixture>, count: number) {
  const scopes = [
    ["src/a/**"],
    ["src/b/x.ts"],
    ["docs/**"],
    ["docs/guide.md", "lib/z/**"],
    ["lib/**"],
    ["README.md"],
    ["**/*.ts"],
    ["src/a*"],
  ]
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const proposal = {
      ...validProposal(),
      objective: `Audit fixture objective ${i % 7 === 0 ? "shared" : i}`,
      writeScope: scopes[i % scopes.length]!,
    }
    ids.push(
      f.repository.insert({
        schemaVersion: 1,
        id: crypto.randomUUID(),
        revision: 1,
        status: "submitted",
        createdAt: new Date().toISOString(),
        provenance: {
          projectID: "project",
          projectDirectory: f.projectDirectory,
          workspaceDirectory: f.projectDirectory,
          sessionID: "owner",
          startingRevision: { kind: "unborn" },
        },
        proposal,
      }).id,
    )
  }
  return ids
}

/** The pre-optimization all-pairs audit, kept as the behavioral oracle. */
function referenceAudit(f: ReturnType<typeof fixture>, ids: string[]) {
  const out: { code: string; taskIDs: string[] }[] = []
  for (const id of ids) if (!f.store.execution(id)) out.push({ code: "unplanned", taskIDs: [id] })
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const exact =
        fingerprint(f.repository.get(ids[i]!)!.proposal) ===
        fingerprint(f.repository.get(ids[j]!)!.proposal)
      const overlap = scopePatternsConflict(
        f.store.effectiveWriteScope(ids[i]!),
        f.store.effectiveWriteScope(ids[j]!),
      )
      if (exact || overlap)
        out.push({ code: exact ? "exact-content" : "scope-overlap", taskIDs: [ids[i]!, ids[j]!] })
    }
  return out
}

test("audit findings equal the all-pairs result on a mixed fixture", () => {
  const f = fixture("audit-equivalence")
  const ids = [f.input.nodes[0]!.taskID, ...seedAuditTasks(f, 60)]
  f.store.submit(f.input, "owner")
  const actual = f.store.audit().findings.map(({ code, taskIDs }) => ({ code, taskIDs }))
  const expected = referenceAudit(
    f,
    ids.filter((id) => !f.repository.taskDisposition(id)),
  )
  expect(actual).toEqual(expected)
  expect(actual.some((x) => x.code === "exact-content")).toBe(true)
  expect(actual.some((x) => x.code === "scope-overlap")).toBe(true)
})

test("audit reads each task once instead of once per pair", () => {
  const f = fixture("audit-linear")
  const count = 600
  seedAuditTasks(f, count)
  const get = f.repository.get.bind(f.repository)
  let reads = 0
  f.repository.get = (id) => {
    reads++
    return get(id)
  }
  const audit = f.store.audit()
  expect(audit.findings.length).toBeGreaterThan(0)
  expect(reads).toBeLessThanOrEqual(count + 1)
})

test("retained repair generations remain task-bound and the latest plan operation is observable", () => {
  const f = fixture("repair-generation-store")
  const plan = f.store.submit(f.input, "owner")
  const taskID = f.input.nodes[0]!.taskID
  const otherTaskID = crypto.randomUUID()
  f.store.record(plan.planID, taskID, "RETAINED_REPAIR_REQUESTED", {
    operationID: "task-operation-1",
  })
  f.store.record(plan.planID, otherTaskID, "RETAINED_REPAIR_REQUESTED", {
    operationID: "other-task-operation",
  })
  f.store.record(plan.planID, taskID, "RETAINED_REPAIR_REQUESTED", {
    operationID: "task-operation-2",
  })

  expect(f.store.latestRetainedRepair<{ operationID: string }>(plan.planID)).toEqual({
    operationID: "task-operation-2",
  })
  expect(f.store.latestRetainedRepair<{ operationID: string }>(plan.planID, taskID)).toEqual({
    operationID: "task-operation-2",
  })
  expect(f.store.latestRetainedRepair(plan.planID, otherTaskID)).toEqual({
    operationID: "other-task-operation",
  })
})

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("Architect source journal pages traverse large retained sources and invalidate foreign or stale cursors", () => {
  const f = fixture("architect-source-journal")
  const anchor = f.store.submit(f.input, "owner")
  const source = seedSourceJournal(f.store, anchor.planID, 804, 3_839)
  const snapshot = () =>
    f.store.atomic((db) => ({
      journalRevision:
        db
          .query<{ revision: number }, [string, string]>(
            `SELECT revision FROM runner_architect_journal_revisions
             WHERE project_directory=? AND plan_id=?`,
          )
          .get(f.projectDirectory, source.mappedPlanID)?.revision ?? 0,
      source: db
        .query("SELECT revision,state FROM runner_architect_sources WHERE session_id=?")
        .get(source.sourceSessionID),
      inputs: db
        .query(
          "SELECT count(*) AS count,sum(referenced_revision) AS referencesMade FROM runner_architect_inputs WHERE session_id=?",
        )
        .get(source.sourceSessionID),
      results: db
        .query(
          "SELECT count(*) AS count,sum(referenced_revision) AS referencesMade FROM runner_architect_source_results WHERE session_id=?",
        )
        .get(source.sourceSessionID),
      notices: db
        .query("SELECT count(*) AS count FROM runner_outbox WHERE session_id=?")
        .get(source.sourceSessionID),
    }))
  const scanDiagnostics = () =>
    f.store.atomic((db) =>
      db
        .query(
          "SELECT scan_cursor,scan_sweep,updated_at FROM runner_architect_sources WHERE session_id=?",
        )
        .get(source.sourceSessionID),
    )
  const before = snapshot()
  const beforeScanDiagnostics = scanDiagnostics()
  const first = f.store.architectSourceJournalPage(source.mappedPlanID, 73)
  expect(first.records[0]).toMatchObject({
    kind: "source",
    sourceSessionID: source.sourceSessionID,
    predecessorSessionID: source.sourceSessionID,
    successorSessionID: source.successorSessionID,
    anchorPlanID: anchor.planID,
    associatedPlanID: source.mappedPlanID,
    sourceRevision: 12,
    scan: { sweep: 9, cursorPresent: true },
  })
  expect(first.coverage).toMatchObject({
    kind: "metadata-only",
    messageBodies: "not-included",
    transcriptCompleteness: "unknown",
    nativeConsumption: "unknown",
    checkpointCoverage: "not-asserted",
  })
  expect(snapshot()).toEqual(before)

  const records = [...first.records]
  let cursor = first.nextCursor ?? undefined
  let scanCursor: string | null = null
  let scan = 0
  while (cursor) {
    const schedulerOwner = "large-journal-noop-scan"
    const now = 1_000 + scan
    const fence = f.store.claim(schedulerOwner, now)
    expect(fence).not.toBeNull()
    const nextScanCursor = `noop-scan-${++scan}`
    f.store.recordArchitectSourcePage({
      schedulerOwner,
      fence: fence!,
      sessionID: source.sourceSessionID,
      cursor: scanCursor,
      nextCursor: nextScanCursor,
      inbox: [],
      messages: [],
      now,
      projectID: "project",
    })
    scanCursor = nextScanCursor
    const page = f.store.architectSourceJournalPage(source.mappedPlanID, 73, cursor)
    expect(page.page.snapshotRevision).toBe(first.page.snapshotRevision)
    expect(page.page.hasMore).toBe(page.nextCursor !== null)
    records.push(...page.records)
    cursor = page.nextCursor ?? undefined
  }

  const inputIDs = Array.from(
    { length: 804 },
    (_, index) => `input:${source.sourceSessionID}:msg_input_${String(index).padStart(4, "0")}`,
  )
  const resultIDs = Array.from(
    { length: 3_839 },
    (_, index) => `result:${source.sourceSessionID}:msg_result_${String(index).padStart(4, "0")}`,
  )
  const expectedIDs = [`source:${source.sourceSessionID}`, ...inputIDs, ...resultIDs].toSorted()
  const actualIDs = records.map((record) => record.recordID)
  expect(records).toHaveLength(1 + 804 + 3_839)
  expect(new Set(actualIDs).size).toBe(actualIDs.length)
  expect(actualIDs.toSorted()).toEqual(expectedIDs)
  expect(records.find((record) => record.recordID === inputIDs[0])).toMatchObject({
    kind: "input",
    messageID: "msg_input_0000",
    disposition: "pending",
    referencedSourceRevision: 1,
  })
  expect(records.find((record) => record.recordID === resultIDs[0])).toMatchObject({
    kind: "result",
    messageID: "msg_result_0000",
    sourceRevision: 12,
    resultRevision: 1,
    referencedSourceRevision: 1,
    toolCounts: { completed: 2 },
  })
  expect(JSON.stringify(records)).not.toContain("ORIGINAL_MESSAGE_BODY")
  expect(snapshot()).toEqual(before)
  expect(scanDiagnostics()).not.toEqual(beforeScanDiagnostics)
  expect(scan).toBeGreaterThan(1)

  const cursorPage = f.store.architectSourceJournalPage(source.mappedPlanID, 2)
  expect(cursorPage.nextCursor).toBeString()
  expect(
    f.store.architectSourceJournalPage(source.mappedPlanID, 2, cursorPage.nextCursor!),
  ).toEqual(f.store.architectSourceJournalPage(source.mappedPlanID, 2, cursorPage.nextCursor!))
  expect(() =>
    f.store.architectSourceJournalPage(anchor.planID, 2, cursorPage.nextCursor!),
  ).toThrow("Journal cursor does not match this project and plan")
  const cursorBody = JSON.parse(
    Buffer.from(cursorPage.nextCursor!, "base64url").toString("utf8"),
  ) as {
    version: 1
    planID: string
    scope: string
    revision: number
    after: { sourceSessionID: string; kind: string; messageID: string }
  }
  const foreignSourceBody = {
    version: cursorBody.version,
    planID: cursorBody.planID,
    scope: cursorBody.scope,
    revision: cursorBody.revision,
    after: { sourceSessionID: "ses_not_associated_with_this_plan", kind: "source", messageID: "" },
  }
  const foreignSourceCursor = Buffer.from(
    JSON.stringify({ ...foreignSourceBody, checksum: fingerprint(foreignSourceBody) }),
  ).toString("base64url")
  expect(() =>
    f.store.architectSourceJournalPage(source.mappedPlanID, 2, foreignSourceCursor),
  ).toThrow("Journal cursor does not identify a record in this plan")
  expect(() => f.store.architectSourceJournalPage(source.mappedPlanID, 2, "")).toThrow(
    "Invalid journal cursor",
  )

  const foreignRepository = new TaskRepository(f.databasePath, join(f.projectDirectory, "foreign"))
  repositories.push(foreignRepository)
  const foreignStore = new RunnerStore(foreignRepository)
  expect(() =>
    foreignStore.architectSourceJournalPage(source.mappedPlanID, 2, cursorPage.nextCursor!),
  ).toThrow("Journal cursor does not match this project and plan")

  const resultMarkers = () =>
    f.store.atomic((db) =>
      db
        .query(
          "SELECT count(*) AS count,max(updated_at) AS latestUpdate FROM runner_architect_source_results WHERE session_id=?",
        )
        .get(source.sourceSessionID),
    )
  const markersBeforeMutation = resultMarkers()
  f.store.atomic((db) =>
    db
      .query(
        "UPDATE runner_architect_source_results SET result_revision=result_revision+1 WHERE session_id=? AND message_id=?",
      )
      .run(source.sourceSessionID, "msg_result_0000"),
  )
  expect(resultMarkers()).toEqual(markersBeforeMutation)
  expect(() =>
    f.store.architectSourceJournalPage(source.mappedPlanID, 2, cursorPage.nextCursor!),
  ).toThrow("Journal changed since this page; restart the journal view")
})

test("journal revision triggers are replaced on a second connection without resetting counters", () => {
  const f = fixture("architect-journal-trigger-reopen")
  const anchor = f.store.submit(f.input, "owner")
  const source = seedSourceJournal(f.store, anchor.planID, 0, 0)
  const revision = (store: RunnerStore) =>
    store.atomic(
      (db) =>
        db
          .query<{ revision: number }, [string, string]>(
            `SELECT revision FROM runner_architect_journal_revisions
             WHERE project_directory=? AND plan_id=?`,
          )
          .get(f.projectDirectory, source.mappedPlanID)?.revision ?? 0,
    )
  const initialRevision = revision(f.store)
  expect(initialRevision).toBeGreaterThan(0)

  f.store.atomic((db) => {
    db.exec(`
      -- S2-4: exercise an upgrade from the historical trigger generation.
      DELETE FROM schema_modules WHERE module='runner';
      DROP TRIGGER architect_journal_revision_runner_architect_sources_UPDATE;
      CREATE TRIGGER architect_journal_revision_runner_architect_sources_UPDATE
      AFTER UPDATE ON runner_architect_sources BEGIN
        INSERT INTO runner_architect_journal_revisions(project_directory,plan_id,revision)
        SELECT mapped.project_directory,mapped.id,1
        FROM runner_architect_sources source
        JOIN runner_architect_renewal_plans mapping ON mapping.renewal_id=source.renewal_id
        JOIN runner_plans mapped ON mapped.id=mapping.plan_id
        WHERE source.session_id=NEW.session_id
        ON CONFLICT(project_directory,plan_id) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER observation_revision_runner_architect_sources_UPDATE
      AFTER UPDATE ON runner_architect_sources BEGIN
        UPDATE observation_revisions SET revision=revision+1
        WHERE project_directory=(
          SELECT project_directory FROM runner_plans WHERE id=NEW.anchor_plan_id
        );
      END;
    `)
  })

  const reopenedRepository = new TaskRepository(f.databasePath, f.projectDirectory)
  repositories.push(reopenedRepository)
  const reopenedStore = new RunnerStore(reopenedRepository)
  expect(revision(reopenedStore)).toBe(initialRevision)
  const triggerState = reopenedStore.atomic((db) => ({
    current: db
      .query<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
      )
      .get("architect_journal_revision_runner_architect_sources_UPDATE")?.sql,
    obsolete: db
      .query<{ present: number }, [string]>(
        "SELECT 1 AS present FROM sqlite_master WHERE type='trigger' AND name=?",
      )
      .get("observation_revision_runner_architect_sources_UPDATE"),
  }))
  expect(triggerState.current).toBeString()
  expect(triggerState.current).not.toContain("scan_cursor")
  expect(triggerState.current).toContain('OLD."revision" IS NOT NEW."revision"')
  expect(triggerState.obsolete).toBeNull()

  const schedulerOwner = "trigger-reopen-scheduler"
  const fence = reopenedStore.claim(schedulerOwner, 10_000)!
  reopenedStore.recordArchitectSourcePage({
    schedulerOwner,
    fence,
    sessionID: source.sourceSessionID,
    cursor: "native-history-cursor",
    nextCursor: "live-scan-cursor",
    inbox: [],
    messages: [],
    now: 10_001,
    projectID: "project",
  })
  expect(revision(reopenedStore)).toBe(initialRevision)
  reopenedRepository.close()
  repositories.splice(repositories.indexOf(reopenedRepository), 1)
})

test("active project reservations preserve priority and attempt order and refresh across transitions and reopen", () => {
  const f = fixture("reservation-facts")
  const task = f.repository.get(f.input.nodes[0]!.taskID)!
  const addPlan = (priority: number, foreign = false) => {
    const next = f.repository.insert({ ...task, id: crypto.randomUUID() })
    const plan = f.store.submit(
      {
        ...f.input,
        requestID: crypto.randomUUID(),
        priority,
        nodes: [{ taskID: next.id, revision: 1 }],
        integrationOrder: [next.id],
      },
      "owner",
    )
    if (foreign)
      f.store.atomic((db) =>
        db
          .query("UPDATE runner_plans SET project_directory=? WHERE id=?")
          .run("/foreign/project", plan.planID),
      )
    return { id: plan.planID, taskID: next.id }
  }
  const low = addPlan(0)
  const high = addPlan(5)
  const foreign = addPlan(10, true)
  const insert = (plan: typeof low, id: string, number: number, startedAt: number, state: string) =>
    f.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_attempts
      (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          plan.id,
          plan.taskID,
          number,
          `ses_${id}`,
          `msg_${id}`,
          f.projectDirectory,
          f.input.baseCommit,
          "{}",
          state,
          startedAt,
        ),
    )
  insert(low, "low-later", 1, 200, "preparing")
  insert(low, "low-first", 2, 100, "running")
  insert(low, "low-terminal", 3, 1, "accepted")
  insert(high, "high", 1, 300, "verifying")
  insert(foreign, "foreign", 1, 0, "running")
  const expected = () =>
    f.store
      .plans()
      .flatMap((plan) =>
        f.store
          .attempts(plan.id)
          .filter((attempt) => ["preparing", "running", "verifying"].includes(attempt.state)),
      )
  expect(f.store.activeProjectAttempts()).toEqual(expected())
  expect(f.store.activeProjectAttempts().map((attempt) => attempt.id)).toEqual([
    "high",
    "low-first",
    "low-later",
  ])
  // A second connection publishes changes between decisions; no cached reservation survives.
  const other = new TaskRepository(f.databasePath, f.projectDirectory)
  repositories.push(other)
  other.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='accepted' WHERE id='high'").run()
    db.query("UPDATE runner_attempts SET state='preparing' WHERE id='low-terminal'").run()
    db.query(
      "UPDATE runner_attempts SET session_id='ses_new',workspace='/new/workspace' WHERE id='low-first'",
    ).run()
  })
  const refreshed = f.store.activeProjectAttempts()
  expect(refreshed).toEqual(expected())
  expect(refreshed.map((attempt) => attempt.id)).toEqual(["low-terminal", "low-first", "low-later"])
  expect(refreshed[1]).toMatchObject({ session_id: "ses_new", workspace: "/new/workspace" })
  f.repository.close()
  const reopened = new TaskRepository(f.databasePath, f.projectDirectory)
  repositories.push(reopened)
  expect(new RunnerStore(reopened).activeProjectAttempts()).toEqual(refreshed)
})

test("F-S4-2 live reservations and runnable pages survive more than 1000 retained plans", () => {
  const f = fixture()
  const receipt = f.store.submit(f.input, "owner")
  const taskID = f.input.nodes[0]!.taskID
  f.store.atomic((db) => {
    const clone = db.query(`INSERT INTO runner_plans
      SELECT ?,project_directory,owner,revision,version,?,json_set(body,'$.priority',?),model,reason,artifact
      FROM runner_plans WHERE id=?`)
    for (let i = 0; i < 1005; i++) clone.run(`history-${i}`, "integrated", 100, receipt.planID)
    for (let i = 0; i < 1005; i++) clone.run(`runnable-${i}`, "running", i % 3, receipt.planID)
    clone.run("cancel-first", "cancelling", -100, receipt.planID)
    // Plan lifecycle is not resource ownership: this terminal plan still has a live writer.
    db.query("UPDATE runner_plans SET state='cleanup-blocked' WHERE id=?").run(receipt.planID)
    db.query(
      `INSERT INTO runner_attempts
      (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
      VALUES('hidden-live',?,?,1,'session','message',?,'base','{}','running',1)`,
    ).run(receipt.planID, taskID, f.projectDirectory)
  })
  expect(f.store.plans().some((plan) => plan.id === receipt.planID)).toBe(false)
  expect(f.store.activeProjectAttempts().map((attempt) => attempt.id)).toEqual(["hidden-live"])
  const rows = [...f.store.runnablePlans(new Set(["integrated", "cleanup-blocked"]))]
  expect(rows).toHaveLength(1006)
  expect(new Set(rows.map((row) => row.id)).size).toBe(1006)
  expect(rows[0]!.id).toBe("cancel-first")
  // Priority 1 is the top, then 2; unprioritized (0) plans sort after every prioritized one. The
  // order holds across the 1000-row page boundary.
  const priorities = rows.slice(1).map((row) => JSON.parse(f.store.plan(row.id)!.body).priority)
  expect(priorities.slice(0, 335).every((priority) => priority === 1)).toBe(true)
  expect(priorities.slice(335, 670).every((priority) => priority === 2)).toBe(true)
  expect(priorities.slice(670).every((priority) => priority === 0)).toBe(true)
  f.store.atomic((db) =>
    db.query("UPDATE runner_attempts SET state='accepted' WHERE id='hidden-live'").run(),
  )
  expect(f.store.activeProjectAttempts()).toEqual([])
})

test("F-S4-2 transitive dependent ownership is found outside the display window", () => {
  const f = fixture()
  const receipt = f.store.submit(f.input, "owner")
  const task = f.repository.insert({
    ...f.repository.get(f.input.nodes[0]!.taskID)!,
    id: crypto.randomUUID(),
  })
  f.store.atomic((db) => {
    const clone = db.query(`INSERT INTO runner_plans
      SELECT ?,project_directory,owner,revision,version,'integrated',json_set(body,'$.priority',100),model,reason,artifact
      FROM runner_plans WHERE id=?`)
    for (let i = 0; i < 1005; i++) clone.run(`history-${i}`, receipt.planID)
    clone.run("middle", receipt.planID)
    clone.run("dependent", receipt.planID)
    db.query(
      "UPDATE runner_plans SET body=json_set(body,'$.priority',-1,'$.afterPlans',json(?)) WHERE id=?",
    ).run(JSON.stringify([receipt.planID]), "middle")
    db.query(
      "UPDATE runner_plans SET body=json_set(body,'$.priority',-1,'$.afterPlans',json(?)) WHERE id=?",
    ).run(JSON.stringify(["middle"]), "dependent")
    db.query(
      `INSERT INTO runner_nodes
      SELECT 'dependent',?,spec_revision,ordinal,state,version,reason,artifact,snapshot,machine_version
      FROM runner_nodes WHERE plan_id=?`,
    ).run(task.id, receipt.planID)
    db.query(
      `INSERT INTO runner_attempts
      (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at)
      VALUES('old-attempt','dependent',?,1,'session','message',?,'base','{}','accepted',1)`,
    ).run(task.id, f.projectDirectory)
  })
  expect(f.store.plans().some((plan) => plan.id === "dependent")).toBe(false)
  expect(f.store.startedDependentPlan(receipt.planID)?.id).toBe("dependent")
  f.store.atomic((db) =>
    db.query("UPDATE runner_plans SET project_directory='/foreign' WHERE id='dependent'").run(),
  )
  expect(f.store.startedDependentPlan(receipt.planID)).toBeNull()
})

test("terminal cleanup discovery includes plans outside the display limit", () => {
  const f = fixture("terminal-cleanup-discovery")
  const cleanupBlocked = crypto.randomUUID()
  const cancelled = crypto.randomUUID()
  f.repository.atomic((db) => {
    const insert = db.query(
      "INSERT INTO runner_plans VALUES(?,?,?,1,1,'accepted',?,NULL,NULL,NULL)",
    )
    for (let index = 0; index < 1_001; index++)
      insert.run(crypto.randomUUID(), f.projectDirectory, "owner", JSON.stringify({ priority: 1 }))
    insert.run(
      cleanupBlocked,
      f.projectDirectory,
      "owner",
      JSON.stringify({ priority: 0, state: "cleanup-blocked" }),
    )
    db.query("UPDATE runner_plans SET state='cleanup-blocked' WHERE id=?").run(cleanupBlocked)
    insert.run(
      cancelled,
      f.projectDirectory,
      "owner",
      JSON.stringify({ priority: 0, state: "cancelled" }),
    )
    db.query("UPDATE runner_plans SET state='cancelled' WHERE id=?").run(cancelled)
  })

  expect(f.store.plans()).toHaveLength(1_000)
  expect(f.store.plans().map((plan) => plan.id)).not.toContain(cleanupBlocked)
  expect(f.store.plans().map((plan) => plan.id)).not.toContain(cancelled)
  expect(f.store.terminalCleanupPlanIDs()).toEqual([cleanupBlocked, cancelled])
})

test("delivery lists only pending notices and leaves delivered and superseded history in place", () => {
  const f = fixture("bounded-outbox")
  const plan = f.store.submit(f.input, "owner")
  f.store.atomic((db) => {
    for (const [id, version, state] of [
      ["old-delivered", 1, "delivered"],
      ["old-superseded", 2, "superseded"],
      ["latest-pending", 3, "pending"],
    ] as const)
      db.query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,?,?,?,?,1)",
      ).run(
        id,
        plan.planID,
        "owner",
        `msg_${id}`,
        JSON.stringify({ planID: plan.planID, version, status: "blocked" }),
        state,
      )
  })
  expect(f.store.outboxForDelivery().map((row) => row.id)).toEqual(["latest-pending"])
  expect(f.store.detail(plan.planID).delivery as unknown[]).toHaveLength(3)
})

test("delivery reads pending notices in insertion order, scoped to the project, with numeric versions", () => {
  const f = fixture("ranked-outbox")
  const first = f.store.submit(f.input, "owner")
  const second = { planID: "second-plan" }
  const foreign = { planID: "foreign-plan" }
  f.store.atomic((db) => {
    for (const id of [second.planID, foreign.planID])
      db.query(
        `INSERT INTO runner_plans
        SELECT ?,project_directory,owner,revision,version,state,body,model,reason,artifact
        FROM runner_plans WHERE id=?`,
      ).run(id, first.planID)
    db.query("UPDATE runner_plans SET project_directory=? WHERE id=?").run(
      "/foreign/project",
      foreign.planID,
    )
    const rows = [
      ["first-null", first.planID, null, "delivered"],
      ["first-pending", first.planID, 1, "pending"],
      ["second-null", second.planID, null, "pending"],
      ["first-delivered", first.planID, 5, "delivered"],
      ["first-fraction", first.planID, 10.9, "pending"],
      ["first-superseded", first.planID, 9, "superseded"],
      ["foreign-pending", foreign.planID, 100, "pending"],
    ] as const
    for (const [id, planID, version, state] of rows)
      db.query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,?,?,?,?,1)",
      ).run(id, planID, "owner", `msg_${id}`, JSON.stringify({ version }), state)
  })
  // Foreign history must be scoped out before evaluating its JSON version.
  f.store.atomic((db) =>
    db.query("UPDATE runner_outbox SET payload='not json' WHERE id='foreign-pending'").run(),
  )
  const rows = f.store.outboxForDelivery()
  expect(rows.map((row) => [row.id, row.version as number | null])).toEqual([
    ["first-pending", 1],
    ["second-null", null],
    ["first-fraction", 10],
  ])
  expect(rows.map((row) => row.sequence)).toEqual(
    rows.map((row) => row.sequence).toSorted((a, b) => a - b),
  )
  // Delivery does not erase historical rows or their payloads.
  expect(f.store.detail(first.planID).delivery as unknown[]).toHaveLength(5)
  f.store.atomic((db) =>
    db.query("UPDATE runner_outbox SET payload='not json' WHERE id='first-pending'").run(),
  )
  expect(() => f.store.outboxForDelivery()).toThrow("malformed JSON")
})

test("legacy delivered outbox schema migrates across an actual close and reopen as delivered", () => {
  const f = fixture("legacy-outbox")
  const plan = f.store.submit(f.input, "owner")
  f.store.atomic((db) => {
    db.query(
      "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,?,?,?,'delivered',1)",
    ).run(
      "legacy-outbox-id",
      plan.planID,
      "owner",
      "msg_legacy_outbox",
      JSON.stringify({ planID: plan.planID, status: "accepted" }),
    )
    // S2-4: the historical table also predates the runner module generation.
    db.query("DELETE FROM schema_modules WHERE module='runner'").run()
    // Reconstruct the historical table before observation triggers existed.
    for (const event of ["INSERT", "UPDATE", "DELETE"])
      db.exec(`DROP TRIGGER observation_revision_runner_outbox_${event}`)
    db.exec(
      "ALTER TABLE runner_outbox DROP COLUMN metadata; ALTER TABLE runner_outbox DROP COLUMN receipt",
    )
  })
  f.repository.close()
  const repository = new TaskRepository(f.databasePath, f.projectDirectory)
  repositories.push(repository)
  const reopened = new RunnerStore(repository)
  const row = reopened.atomic((db) =>
    db
      .query<{ id: string; message_id: string; state: string; receipt: string }, [string]>(
        "SELECT id,message_id,state,receipt FROM runner_outbox WHERE id=?",
      )
      .get("legacy-outbox-id"),
  )!
  expect(row.id).toBe("legacy-outbox-id")
  expect(row.message_id).toBe("msg_legacy_outbox")
  expect(row.state).toBe("delivered")
})

test("legacy continuation session uniqueness migrates so one renewal can own multiple plans", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-continuation-migration-"))
  directories.push(directory)
  const projectDirectory = join(directory, "project")
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), projectDirectory)
  repositories.push(repository)
  repository.atomic((db) => {
    db.exec(`
      CREATE TABLE runner_plans (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, owner TEXT NOT NULL,
        revision INTEGER NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
        body TEXT NOT NULL, model TEXT, reason TEXT, artifact TEXT
      );
      CREATE TABLE runner_continuations (
        plan_id TEXT PRIMARY KEY REFERENCES runner_plans(id), session_id TEXT NOT NULL UNIQUE,
        parent_id TEXT, directory TEXT NOT NULL, model TEXT, generation INTEGER NOT NULL
      );
    `)
    for (const id of ["legacy-plan-a", "legacy-plan-b"])
      db.query("INSERT INTO runner_plans VALUES(?,?,?,1,1,'running','{}',NULL,NULL,NULL)").run(
        id,
        projectDirectory,
        "owner",
      )
    db.query("INSERT INTO runner_continuations VALUES(?,?,?,?,?,1)").run(
      "legacy-plan-a",
      "ses_shared-architect",
      null,
      projectDirectory,
      null,
    )
  })

  const store = new RunnerStore(repository)
  store.atomic((db) =>
    db
      .query("INSERT INTO runner_continuations VALUES(?,?,?,?,?,1)")
      .run("legacy-plan-b", "ses_shared-architect", null, projectDirectory, null),
  )
  expect(
    store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM runner_continuations WHERE session_id=?",
          )
          .get("ses_shared-architect")!.count,
    ),
  ).toBe(2)
})

function revisions(store: RunnerStore, planID: string) {
  return store.atomic((db) =>
    db
      .query<{ revision: number; body: string }, [string]>(
        "SELECT revision,body FROM runner_plan_revisions WHERE plan_id=? ORDER BY revision",
      )
      .all(planID),
  )
}

function seedLegacyPlan(store: RunnerStore, projectDirectory: string, body: string) {
  const planID = crypto.randomUUID()
  store.atomic((db) => {
    db.query("INSERT INTO runner_plans VALUES(?,?,?,1,1,'draft',?,NULL,NULL,NULL)").run(
      planID,
      projectDirectory,
      "legacy-owner",
      body,
    )
    db.query("INSERT INTO runner_plan_revisions VALUES(?,1,?,?,?)").run(
      planID,
      body,
      "legacy-owner",
      Date.now(),
    )
  })
  return planID
}

test("authored plan titles survive persistence, reopen, and idempotent replay unchanged", () => {
  const f = fixture()
  const legacyBody = JSON.stringify(PlanInput.parse(f.input))
  const legacyPlanID = seedLegacyPlan(f.store, f.projectDirectory, legacyBody)
  const legacyRevisions = revisions(f.store, legacyPlanID)
  const title = "  Ship the dependency graph — first release  "
  const input = { ...f.input, title }
  const receipt = f.store.submit(input, "owner")
  const original = f.store.plan(receipt.planID)!
  const originalRevisions = revisions(f.store, receipt.planID)

  expect(JSON.parse(original.body).title).toBe(title)
  expect(original.revision).toBe(1)
  expect(originalRevisions).toEqual([{ revision: 1, body: original.body }])
  expect(f.store.plan(legacyPlanID)!.body).toBe(legacyBody)
  expect(legacyRevisions).toEqual([{ revision: 1, body: legacyBody }])

  f.repository.close()
  const reopenedRepository = new TaskRepository(f.databasePath, f.projectDirectory)
  repositories.push(reopenedRepository)
  const reopened = new RunnerStore(reopenedRepository)

  expect(reopened.plan(receipt.planID)!.body).toBe(original.body)
  expect(reopened.plan(receipt.planID)!.revision).toBe(1)
  expect(reopened.plan(legacyPlanID)!.body).toBe(legacyBody)
  expect(reopened.plan(legacyPlanID)!.revision).toBe(1)
  expect(reopened.submit(input, "owner")).toEqual(receipt)
  expect(reopened.plan(receipt.planID)!.body).toBe(original.body)
  expect(reopened.plan(receipt.planID)!.revision).toBe(1)
  expect(revisions(reopened, receipt.planID)).toEqual(originalRevisions)
  expect(revisions(reopened, legacyPlanID)).toEqual(legacyRevisions)
  expect(() => reopened.submit({ ...input, title: "A changed authored title" }, "owner")).toThrow(
    "Request identity conflict",
  )
  expect(reopened.plan(receipt.planID)!.body).toBe(original.body)
  expect(revisions(reopened, receipt.planID)).toEqual(originalRevisions)
})

test("new and legacy untitled plan bodies remain title-absent across reopen and replay", () => {
  const f = fixture("legacy-untitled-plan")
  const receipt = f.store.submit(f.input, "owner")
  const original = f.store.plan(receipt.planID)!
  const originalRevisions = revisions(f.store, receipt.planID)
  const body = JSON.parse(original.body) as Record<string, unknown>

  expect(body).not.toHaveProperty("title")
  expect(body.objective).toBe(f.input.objective)

  f.repository.close()
  const reopenedRepository = new TaskRepository(f.databasePath, f.projectDirectory)
  repositories.push(reopenedRepository)
  const reopened = new RunnerStore(reopenedRepository)

  expect(reopened.plan(receipt.planID)!.body).toBe(original.body)
  expect(reopened.submit(f.input, "owner")).toEqual(receipt)
  expect(reopened.plan(receipt.planID)!.body).toBe(original.body)
  expect(reopened.plan(receipt.planID)!.revision).toBe(1)
  expect(revisions(reopened, receipt.planID)).toEqual(originalRevisions)
})

test("runner XState transitions survive a reopened database connection", () => {
  const f = fixture("lifecycle-connection-reopen")
  const receipt = f.store.submit(f.input, "owner")
  f.repository.close()
  f.store.atomic((db) =>
    db
      .query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running') WHERE id=?",
      )
      .run(receipt.planID),
  )
  expect(f.store.plan(receipt.planID)?.state).toBe("running")
  expect(() =>
    f.store.atomic((db) =>
      db
        .query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'integrated') WHERE id=?",
        )
        .run(receipt.planID),
    ),
  ).toThrow("Invalid plan transition")
  expect(f.store.plan(receipt.planID)?.state).toBe("running")
})

function seedSourceJournal(
  store: RunnerStore,
  planID: string,
  inputCount: number,
  resultCount: number,
) {
  const renewalID = crypto.randomUUID()
  const mappedPlanID = crypto.randomUUID()
  const sourceSessionID = "ses_retained_architect_predecessor"
  const successorSessionID = "ses_current_architect_owner"
  store.atomic((db) => {
    db.query(
      `INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body,model,reason,artifact)
       SELECT ?,project_directory,owner,revision,version,state,body,model,reason,artifact
       FROM runner_plans WHERE id=?`,
    ).run(mappedPlanID, planID)
    db.query(
      `INSERT INTO runner_architect_renewals(
         id,anchor_plan_id,previous_session_id,successor_session_id,directory,model,idle_at,
         generation,state,handoff_message_id,started_at
       ) VALUES(?,?,?,?,?,?,?,?,'committed',?,?)`,
    ).run(
      renewalID,
      planID,
      sourceSessionID,
      successorSessionID,
      "/project",
      "{}",
      100,
      2,
      "msg_handoff",
      200,
    )
    const mapping = db.query(
      "INSERT INTO runner_architect_renewal_plans(renewal_id,plan_id,prior_continuation,transferred) VALUES(?,?,NULL,1)",
    )
    mapping.run(renewalID, planID)
    mapping.run(renewalID, mappedPlanID)
    db.query(
      `INSERT INTO runner_architect_sources(
         session_id,renewal_id,anchor_plan_id,scan_cursor,scan_sweep,revision,state,updated_at
       ) VALUES(?,?,?,?,?,?,'active',?)`,
    ).run(sourceSessionID, renewalID, planID, "native-history-cursor", 9, 12, 300)

    const inputInsert = db.query(
      `INSERT INTO runner_architect_inputs(
         session_id,message_id,observed_at,renewal_id,native_type,delivery,disposition,
         metadata_json,last_seen_sweep,referenced_revision,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (let index = 0; index < inputCount; index++) {
      const id = `msg_input_${String(index).padStart(4, "0")}`
      const disposition = ["pending", "steering", "delivered", "unknown"][index % 4]!
      inputInsert.run(
        sourceSessionID,
        id,
        400 + index,
        renewalID,
        "user",
        disposition === "steering" ? "steer" : null,
        disposition,
        JSON.stringify({ privateBodyCanary: "ORIGINAL_MESSAGE_BODY" }),
        9,
        1,
        400 + index,
      )
    }

    const resultInsert = db.query(
      `INSERT INTO runner_architect_source_results(
         session_id,renewal_id,message_id,state,finish,tool_running,tool_completed,tool_failed,
         tool_other,result_fingerprint,result_revision,referenced_revision,updated_at
      ) VALUES(?,?,?,'completed','stop',0,2,0,0,?,1,1,?)`,
    )
    for (let index = 0; index < resultCount; index++) {
      const id = `msg_result_${String(index).padStart(4, "0")}`
      resultInsert.run(sourceSessionID, renewalID, id, `fingerprint-${index}`, 800 + index)
    }
  })
  return { renewalID, mappedPlanID, sourceSessionID, successorSessionID }
}

function seedOutbox(f: ReturnType<typeof fixture>, planID: string, id: string, state = "pending") {
  f.store.atomic((db) =>
    db
      .query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,?,?,?,?,1)",
      )
      .run(id, planID, "owner", `msg_${id}`, JSON.stringify({ planID, version: 1 }), state),
  )
}

test("outbox receipts append as child rows and never grow the parent", () => {
  const f = fixture("outbox-receipt-append")
  const plan = f.store.submit(f.input, "owner")
  seedOutbox(f, plan.planID, "notice")
  const parentBytes = () =>
    f.store.read(
      (db) =>
        db
          .query<{ n: number }, []>(
            `SELECT length(id)+length(payload)+length(COALESCE(metadata,''))+length(COALESCE(receipt,'')) AS n
             FROM runner_outbox WHERE id='notice'`,
          )
          .get()!.n,
    )
  const before = parentBytes()
  for (let index = 0; index < 500; index++)
    f.store.noteOutboxReceipt("notice", { kind: index === 499 ? "last" : "held", index })
  const row = f.store.read((db) =>
    db
      .query<{ receipt: string | null; receipt_count: number; receipt_last_kind: string }, []>(
        "SELECT receipt,receipt_count,receipt_last_kind FROM runner_outbox WHERE id='notice'",
      )
      .get(),
  )!
  expect(row).toEqual({ receipt: null, receipt_count: 500, receipt_last_kind: "last" })
  expect(parentBytes()).toBe(before)
  const entries = f.store.outboxReceipts("notice") as { index: number }[]
  expect(entries.map((entry) => entry.index)).toEqual([...Array(500).keys()])
  // The pending page carries no receipt entries.
  const pending = f.store.outboxForDelivery()
  expect(pending.map((pendingRow) => pendingRow.receipt)).toEqual([null])
  expect(pending[0]!.receipt_count).toBe(500)
  // Detail still shows the history as one document.
  const shown = f.store.detail(plan.planID).delivery as { receipt: string }[]
  expect(JSON.parse(shown[0]!.receipt).history).toHaveLength(500)
})

test("coalesced ids and the retired-session marker are read from receipt rows", () => {
  const f = fixture("outbox-receipt-queries")
  const plan = f.store.submit(f.input, "owner")
  seedOutbox(f, plan.planID, "merged")
  seedOutbox(f, plan.planID, "cleaned", "delivered")
  seedOutbox(f, plan.planID, "uncleaned", "delivered")
  f.store.noteOutboxReceipt("merged", { kind: "coalesced", coalescedOutboxIDs: ["a", "b"] })
  f.store.noteOutboxReceipt("merged", { kind: "coalesced", coalescedOutboxIDs: ["b", "c"] })
  expect(f.store.coalescedOutboxIDs("merged").toSorted()).toEqual(["a", "b", "c"])
  f.store.noteOutboxReceipt("cleaned", { kind: "retired-session-cleaned", sessionID: "owner" })
  const outside = f.store
    .deliveredOutsideSession([plan.planID], "other")
    .map((outboxRow) => outboxRow.id)
  expect(outside).toEqual(["uncleaned"])
})

test("legacy receipt documents migrate to child rows with the same entries in order", () => {
  const f = fixture("outbox-receipt-migration")
  const plan = f.store.submit(f.input, "owner")
  seedOutbox(f, plan.planID, "history")
  seedOutbox(f, plan.planID, "single")
  seedOutbox(f, plan.planID, "opaque")
  seedOutbox(f, plan.planID, "none")
  f.store.atomic((db) => {
    const set = db.query("UPDATE runner_outbox SET receipt=? WHERE id=?")
    set.run(
      JSON.stringify({
        history: [
          { kind: "x", n: 1 },
          { kind: "y", n: 2 },
        ],
      }),
      "history",
    )
    set.run(JSON.stringify({ kind: "solo" }), "single")
    set.run("not json", "opaque")
    db.query("DELETE FROM schema_modules WHERE module='runner'").run()
  })
  f.repository.close()
  const repository = new TaskRepository(f.databasePath, f.projectDirectory)
  repositories.push(repository)
  const reopened = new RunnerStore(repository)
  expect(reopened.outboxReceipts("history")).toEqual([
    { kind: "x", n: 1 },
    { kind: "y", n: 2 },
  ])
  expect(reopened.outboxReceipts("single")).toEqual([{ kind: "solo" }])
  expect(reopened.outboxReceipts("opaque")).toEqual([{ legacyReceipt: "not json" }])
  expect(reopened.outboxReceipts("none")).toEqual([])
  const parent = reopened.read((db) =>
    db
      .query<
        {
          id: string
          receipt: string | null
          receipt_count: number
          receipt_last_kind: string | null
        },
        []
      >("SELECT id,receipt,receipt_count,receipt_last_kind FROM runner_outbox ORDER BY id")
      .all(),
  )
  expect(parent).toEqual([
    { id: "history", receipt: null, receipt_count: 2, receipt_last_kind: "y" },
    { id: "none", receipt: null, receipt_count: 0, receipt_last_kind: null },
    { id: "opaque", receipt: null, receipt_count: 1, receipt_last_kind: null },
    { id: "single", receipt: null, receipt_count: 1, receipt_last_kind: "solo" },
  ])
})

test("pending notices are read in pages without receipt history", () => {
  const f = fixture("outbox-pages")
  const plan = f.store.submit(f.input, "owner")
  for (let index = 0; index < 7; index++) seedOutbox(f, plan.planID, `n${index}`)
  f.store.noteOutboxReceipt("n3", { kind: "held", text: "x".repeat(10_000) })
  const meter = meterReads(f.store)
  const ids = [...f.store.pendingOutbox(f.projectDirectory, 3)].map((row) => row.id)
  meter.stop()
  expect(ids).toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6"])
  expect(meter.of(/runner_outbox/).rows).toBe(7)
  expect(meter.of(/runner_outbox/).bytes).toBeLessThan(5_000)
})

test("runnable plan paging returns scheduling columns, not plan bodies", () => {
  const f = fixture("runnable-heads")
  const receipt = f.store.submit(f.input, "owner")
  f.store.atomic((db) => {
    const clone = db.query(`INSERT INTO runner_plans
      SELECT ?,project_directory,owner,revision,version,'running',json_set(body,'$.padding',?),model,reason,artifact
      FROM runner_plans WHERE id=?`)
    for (let index = 0; index < 30; index++)
      clone.run(`padded-${index}`, "p".repeat(40_000), receipt.planID)
  })
  const meter = meterReads(f.store)
  const rows = [...f.store.runnablePlans(new Set(["integrated"]))]
  meter.stop()
  expect(rows).toHaveLength(31)
  expect(Object.keys(rows[0]!)).not.toContain("body")
  // 30 padded bodies are 1.2 MB; the page is the ids, states and ranks.
  expect(meter.bytes).toBeLessThan(10_000)
})

test("the latest attempt, open effect and node are single-row reads however long the history", () => {
  const f = fixture("latest-attempt-sql")
  const receipt = f.store.submit(f.input, "owner")
  const taskID = f.input.nodes[0]!.taskID
  f.store.atomic((db) => {
    const insert = db.query(
      `INSERT INTO runner_attempts(
        id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'failed',?)`,
    )
    for (let index = 0; index < 300; index++)
      insert.run(
        `attempt-${index}`,
        receipt.planID,
        taskID,
        index + 1,
        `session-${index}`,
        `message-${index}`,
        f.projectDirectory,
        "base",
        JSON.stringify({ padding: "p".repeat(2_000) }),
        index,
      )
  })
  const meter = meterReads(f.store)
  expect(f.store.latestAttemptID(receipt.planID, taskID)).toBe("attempt-299")
  expect(f.store.hasOpenEffect(receipt.planID, "attempt-299")).toBe(false)
  expect(f.store.node(receipt.planID, taskID)?.task_id).toBe(taskID)
  expect(f.store.planStatus(receipt.planID)?.id).toBe(receipt.planID)
  meter.stop()
  // 300 attempts hold 600 KB of policy; the four reads return a handful of small rows.
  expect(meter.rows).toBeLessThanOrEqual(3)
  expect(meter.bytes).toBeLessThan(5_000)
})

test("task activity is filtered in SQL: counts, existence and the latest row read no history", () => {
  const f = fixture("activity-sql")
  const receipt = f.store.submit(f.input, "owner")
  const taskID = f.input.nodes[0]!.taskID
  f.store.atomic((db) => {
    const insert = db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,?,?,?)",
    )
    for (let index = 0; index < 400; index++)
      insert.run(
        receipt.planID,
        taskID,
        "TOOL_NOISE",
        JSON.stringify({ attemptID: "a1", padding: "p".repeat(2_000) }),
        index,
      )
    insert.run(
      receipt.planID,
      taskID,
      "ATTEMPT_RESUMED",
      JSON.stringify({ attemptID: "a1", n: 1 }),
      500,
    )
    insert.run(
      receipt.planID,
      taskID,
      "ATTEMPT_RESUMED",
      JSON.stringify({ attemptID: "a2", n: 2 }),
      501,
    )
    insert.run(
      receipt.planID,
      taskID,
      "ATTEMPT_RESUMED",
      JSON.stringify({ attemptID: "a1", n: 3 }),
      502,
    )
    insert.run(receipt.planID, taskID, "ATTEMPT_RESUMED", "not json", 503)
  })
  const meter = meterReads(f.store)
  expect(f.store.activityCount(receipt.planID, taskID, { events: ["ATTEMPT_RESUMED"] })).toBe(4)
  expect(
    f.store.activityCount(receipt.planID, taskID, {
      events: ["ATTEMPT_RESUMED"],
      payload: { attemptID: "a1" },
    }),
  ).toBe(2)
  expect(
    f.store.hasActivity(receipt.planID, taskID, {
      events: ["ATTEMPT_RESUMED"],
      payload: { attemptID: "a2" },
      payloadAny: { n: 9, previousMessageID: "x" },
    }),
  ).toBe(false)
  expect(
    f.store.hasActivity(receipt.planID, taskID, {
      events: ["ATTEMPT_RESUMED"],
      payloadAny: { n: 2, previousMessageID: "x" },
    }),
  ).toBe(true)
  const latest = f.store.activityEvents(receipt.planID, taskID, {
    events: ["ATTEMPT_RESUMED"],
    payload: { attemptID: "a1" },
    newest: true,
    limit: 1,
  })
  expect(JSON.parse(latest[0]!.payload).n).toBe(3)
  meter.stop()
  // The 400 padded noise rows (800 KB) are never returned.
  expect(meter.bytes).toBeLessThan(2_000)
})

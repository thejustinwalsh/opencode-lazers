import { afterEach, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { fingerprint } from "../identity.ts"
import { TaskRepository } from "../storage.ts"
import { PlanInput } from "./schema.ts"
import { appendRunnerEffectReceipt, RunnerStore } from "./store.ts"
import { outcomeText } from "./outcome.ts"

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

test("legacy adoption evidence remains auditable but cannot satisfy phase-bound evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-adoption-evidence-migration-"))
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
      CREATE TABLE runner_adoptions (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES runner_plans(id),
        task_id TEXT NOT NULL, request_id TEXT NOT NULL, owner TEXT NOT NULL,
        plan_version INTEGER NOT NULL, task_revision INTEGER NOT NULL, attempt_id TEXT NOT NULL,
        node_state TEXT NOT NULL, attempt_state TEXT NOT NULL,
        old_artifact TEXT NOT NULL, descendant_commit TEXT NOT NULL, target_branch TEXT NOT NULL,
        landing_head TEXT NOT NULL, candidate_tree TEXT NOT NULL, input_fingerprint TEXT NOT NULL,
        environment_identity TEXT NOT NULL, reason TEXT NOT NULL, combined_artifact TEXT NOT NULL,
        task_workspace TEXT, combined_workspace TEXT, state TEXT NOT NULL, hold_reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE runner_adoption_evidence (
        id TEXT PRIMARY KEY, adoption_id TEXT NOT NULL REFERENCES runner_adoptions(id),
        assertion_id TEXT NOT NULL, artifact TEXT NOT NULL, body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    db.query(`INSERT INTO runner_plans VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      "plan",
      projectDirectory,
      "owner",
      1,
      2,
      "blocked",
      "{}",
      null,
      null,
      null,
    )
    db.query(
      `INSERT INTO runner_adoptions(
         id,plan_id,task_id,request_id,owner,plan_version,task_revision,attempt_id,node_state,
         attempt_state,old_artifact,descendant_commit,target_branch,landing_head,candidate_tree,
         input_fingerprint,environment_identity,reason,combined_artifact,state,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "adoption",
      "plan",
      "task",
      "request",
      "owner",
      1,
      1,
      "attempt",
      "failed",
      "failed",
      "old",
      "descendant",
      "main",
      "descendant",
      "tree",
      "fingerprint",
      "environment",
      "reviewed",
      "descendant",
      "held",
      1,
      1,
    )
    db.query("INSERT INTO runner_adoption_evidence VALUES(?,?,?,?,?,?)").run(
      "evidence",
      "adoption",
      "shared-assertion",
      "descendant",
      JSON.stringify({ decision: "legacy unqualified proof" }),
      1,
    )
  })

  const store = new RunnerStore(repository)
  expect(store.adoption("adoption")?.reviewed_baseline).toBe("")
  expect(store.adoptionEvidence("adoption")).toMatchObject([
    { id: "evidence", task_id: null, phase: "legacy", assertion_id: "shared-assertion" },
  ])
  expect(
    store.hasAdoptionEvidence("adoption", "task", "task", "shared-assertion", "descendant"),
  ).toBe(false)
  expect(
    store.hasAdoptionEvidence("adoption", "combined", null, "shared-assertion", "descendant"),
  ).toBe(false)
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

test("F-S4-1 conflict scan migration preserves history without restarting persistence", () => {
  const f = fixture()
  f.store.atomic((db) => {
    db.exec("ALTER TABLE runner_conflict_scans RENAME TO runner_audits")
    db.query("INSERT INTO runner_audits VALUES(?,?,?,?,?)").run(
      "old-scan",
      f.projectDirectory,
      1,
      "[]",
      100,
    )
  })
  const store = new RunnerStore(f.repository)
  store.audit()
  store.audit()
  expect(store.atomic((db) => db.query("SELECT id,body FROM runner_conflict_scans").all())).toEqual(
    [{ id: "old-scan", body: "[]" }],
  )
  expect(
    store.atomic((db) => db.query("SELECT 1 FROM sqlite_master WHERE name='runner_audits'").get()),
  ).toBeNull()
  new RunnerStore(f.repository)
  expect(
    store.atomic((db) => db.query("SELECT COUNT(*) AS n FROM runner_conflict_scans").get()),
  ).toEqual({ n: 1 })
  // A still-loaded older plugin can recreate its table during an upgrade overlap.
  store.atomic((db) => {
    db.exec("CREATE TABLE runner_audits AS SELECT * FROM runner_conflict_scans WHERE 0")
    db.query("INSERT INTO runner_audits VALUES(?,?,?,?,?)").run(
      "overlap-scan",
      f.projectDirectory,
      2,
      "[]",
      200,
    )
  })
  new RunnerStore(f.repository)
  expect(
    store.atomic((db) => db.query("SELECT id FROM runner_conflict_scans ORDER BY id").all()),
  ).toEqual([{ id: "old-scan" }, { id: "overlap-scan" }])
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
  expect(
    f.store.atomic((db) => db.query("SELECT COUNT(*) AS n FROM runner_conflict_scans").get()),
  ).toEqual({ n: 0 })
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

test("plan control epochs change on owner/cancellation controls but ignore task activity", () => {
  const f = fixture("plan-control-epoch-store")
  const plan = f.store.submit(f.input, "owner")
  const taskID = f.input.nodes[0]!.taskID
  const initial = f.store.planControlEpoch(plan.planID)

  f.store.record(plan.planID, taskID, "RETAINED_REPAIR_REQUESTED", { operationID: "repair" })
  expect(f.store.planControlEpoch(plan.planID)).toBe(initial)

  f.store.record(plan.planID, null, "OWNER_REASSIGNED", { from: "owner", to: "other" })
  const away = f.store.planControlEpoch(plan.planID)
  expect(away).toBeGreaterThan(initial)
  f.store.record(plan.planID, null, "OWNER_REASSIGNED", { from: "other", to: "owner" })
  const returned = f.store.planControlEpoch(plan.planID)
  expect(returned).toBeGreaterThan(away)

  f.store.record(plan.planID, null, "CANCEL_REQUESTED", { caller: "owner" })
  expect(f.store.planControlEpoch(plan.planID)).toBeGreaterThan(returned)
})

test("owner-transfer evidence is exact, plan-scoped and time-bounded", () => {
  const f = fixture("plan-owner-transfer-evidence")
  const plan = f.store.submit(f.input, "owner")
  const sourceTask = f.store.repository.get(f.input.nodes[0]!.taskID)!
  const otherTask = f.store.repository.insert({
    ...structuredClone(sourceTask),
    id: crypto.randomUUID(),
  })
  const otherPlan = f.store.submit(
    {
      ...f.input,
      requestID: "other-owner-transfer-plan",
      nodes: [{ taskID: otherTask.id, revision: 1 }],
      integrationOrder: [otherTask.id],
    },
    "owner",
  )
  const taskID = f.input.nodes[0]!.taskID
  const predecessor = f.store.plan(plan.planID)!.owner
  const successor = "successor"

  f.store.record(plan.planID, null, "OWNER_REASSIGNED", {
    from: "unrelated-predecessor",
    to: successor,
  })
  f.store.record(plan.planID, taskID, "OWNER_REASSIGNED", {
    from: predecessor,
    to: successor,
  })
  f.store.record(otherPlan.planID, null, "OWNER_REASSIGNED", {
    from: predecessor,
    to: successor,
  })
  expect(f.store.hasPlanOwnerTransfer(plan.planID, predecessor, successor, 0)).toBe(false)

  f.store.record(plan.planID, null, "OWNER_CONTINUED", {
    from: predecessor,
    to: successor,
    renewalID: "renewal-evidence",
  })
  expect(f.store.hasPlanOwnerTransfer(plan.planID, predecessor, successor, 0)).toBe(true)
  expect(f.store.hasPlanOwnerTransfer(plan.planID, predecessor, successor, Date.now() + 1000)).toBe(
    false,
  )
  expect(f.store.hasPlanOwnerTransfer(plan.planID, successor, predecessor, 0)).toBe(false)
})

test("owner-transfer evidence follows an ordered same-plan continuation and reassignment path", () => {
  const f = fixture("ordered-plan-owner-transfer-evidence")
  const plan = f.store.submit(f.input, "owner")
  const originalOwner = "original-owner"
  const renewedOwner = "renewed-owner"
  const successor = "current-owner"

  // A later edge cannot prove a path before its predecessor has transferred.
  f.store.record(plan.planID, null, "OWNER_REASSIGNED", {
    from: renewedOwner,
    to: successor,
  })
  f.store.record(plan.planID, null, "OWNER_CONTINUED", {
    from: originalOwner,
    to: renewedOwner,
  })
  expect(f.store.hasPlanOwnerTransfer(plan.planID, originalOwner, successor, 0)).toBe(false)

  f.store.record(plan.planID, null, "OWNER_REASSIGNED", {
    from: renewedOwner,
    to: successor,
  })
  expect(f.store.hasPlanOwnerTransfer(plan.planID, originalOwner, successor, 0)).toBe(true)
  expect(f.store.hasPlanOwnerTransfer(plan.planID, successor, originalOwner, 0)).toBe(false)
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

test("source-notice pointer readers materialize only current owners or exact replacement IDs", () => {
  const f = fixture("architect-bounded-source-notice-reads")
  const anchor = f.store.submit(f.input, "owner")
  const source = seedSourceJournal(f.store, anchor.planID, 4, 3)
  const owners = ["ses_current_owner_a", "ses_current_owner_b"]
  f.store.atomic((db) => {
    db.query("UPDATE runner_plans SET owner=? WHERE id=?").run(owners[0]!, anchor.planID)
    db.query("UPDATE runner_plans SET owner=? WHERE id=?").run(owners[1]!, source.mappedPlanID)
  })
  const plan = f.store.plan(anchor.planID)!
  const ensured = f.store.ensureArchitectSourceChangeNotices({
    planID: plan.id,
    sourceSessionID: source.sourceSessionID,
    expectedOwner: owners[0]!,
    expectedPlanVersion: plan.version,
    projectID: "project",
  })
  expect(ensured.targets.map((target) => target.owner)).toEqual(owners)
  expect(ensured.notices).toHaveLength(2)

  const padding = "historical-notice-payload-".repeat(512)
  f.store.atomic((db) => {
    const insert = db.query(
      `INSERT INTO runner_outbox(
         id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt
       ) VALUES(?,?,?,?,?,'admitted',0,NULL,NULL)`,
    )
    for (let index = 0; index < 512; index++) {
      const payload = JSON.stringify({
        status: "architect-source-reference",
        sourceSessionID: source.sourceSessionID,
        version: index,
        padding,
      })
      insert.run(
        `historical-source-reference-${index}`,
        anchor.planID,
        index % 3 === 0 ? "ses_retired_owner" : owners[index % 2]!,
        `msg_historical_source_reference_${index}`,
        payload,
      )
    }
  })
  const backlog = f.store.atomic((db) =>
    db
      .query<{ count: number; payloadBytes: number }, [string, string]>(
        `SELECT count(*) AS count,sum(length(o.payload)) AS payloadBytes
         FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id
         WHERE p.project_directory=? AND json_extract(o.payload,'$.sourceSessionID')=?
           AND json_extract(o.payload,'$.status')='architect-source-reference'`,
      )
      .get(f.projectDirectory, source.sourceSessionID)!,
  )
  expect(backlog.count).toBe(512)
  expect(backlog.payloadBytes).toBeGreaterThan(6_000_000)

  const pointers = f.store.architectCurrentSourceChangeNoticeRows(source.sourceSessionID)
  expect(pointers.map((row) => row.session_id)).toEqual(owners)
  expect(pointers.map((row) => row.id).sort()).toEqual(
    ensured.notices.map((notice) => notice.id).sort(),
  )
  expect(pointers.reduce((bytes, row) => bytes + Buffer.byteLength(row.payload), 0)).toBeLessThan(
    2_000,
  )

  const exact = f.store.architectSourceChangeNoticeRowsByIDs(
    source.sourceSessionID,
    ensured.notices,
  )
  expect(exact.map((row) => row.id).sort()).toEqual(
    ensured.notices.map((notice) => notice.id).sort(),
  )
  expect(exact).toHaveLength(2)
  expect(exact.reduce((bytes, row) => bytes + Buffer.byteLength(row.payload), 0)).toBeLessThan(
    2_000,
  )
  expect(
    f.store.architectSourceChangeNoticeRowsByIDs(source.sourceSessionID, [ensured.notices[0]!]),
  ).toHaveLength(1)
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

test("804-input/3839-result and doubled journals keep handoff and current pointer bytes compact", () => {
  const f = fixture("architect-compact-source-growth")
  const anchor = f.store.submit(f.input, "owner")
  const source = seedSourceJournal(f.store, anchor.planID, 804, 3_839)
  f.store.atomic((db) =>
    db
      .query(
        `UPDATE runner_plans SET owner=?,version=version+1
         WHERE id IN (SELECT plan_id FROM runner_architect_renewal_plans WHERE renewal_id=?)`,
      )
      .run(source.successorSessionID, source.renewalID),
  )
  const currentPlan = f.store.plan(anchor.planID)!
  const handoffPayload = {
    status: "architect-handoff",
    planID: anchor.planID,
    planIDs: [anchor.planID, source.mappedPlanID],
    version: 1,
    label: "Continue the existing project work",
    predecessorSessionID: source.sourceSessionID,
    sourceCoverage: { complete: true, cursor: null },
    continuity: { decisions: ["Preserve the current accepted work."], unresolvedQuestions: [] },
  }
  const handoffMetadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: "project",
    lazersProjectDirectory: f.projectDirectory,
    lazersPlanID: anchor.planID,
    lazersOutboxID: "handoff-fixture",
    lazersMessageID: "msg_handoff_fixture",
    lazersSessionID: source.successorSessionID,
    lazersStatus: "architect-handoff",
    lazersVersion: 1,
  }
  f.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_outbox(
           id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt
         ) VALUES(?,?,?,? ,?,'admitted',0,?,?)`,
      )
      .run(
        "handoff-fixture",
        anchor.planID,
        source.successorSessionID,
        "msg_handoff_fixture",
        JSON.stringify(handoffPayload),
        JSON.stringify(handoffMetadata),
        JSON.stringify({ history: [{ kind: "native-admission" }] }),
      ),
  )

  const measure = (expectedRecords: number) => {
    const handoff = f.store
      .outboxForDelivery(f.projectDirectory)
      .find((row) => JSON.parse(row.payload).status === "architect-handoff")!
    const activePointers = f.store
      .architectSourceNoticeRows(source.sourceSessionID)
      .filter((row) => JSON.parse(row.payload).status === "architect-source-change")
      .filter((row) => !["consumed", "superseded"].includes(row.state))
    expect(activePointers).toHaveLength(1)
    const pointer = activePointers[0]!
    const handoffText = outcomeText(handoff.payload)
    const pointerText = outcomeText(pointer.payload)
    const nativeInboxEntryBytes = (row: (typeof activePointers)[number], text: string) =>
      Buffer.byteLength(
        JSON.stringify({
          id: row.message_id,
          type: "synthetic",
          delivery: "queue",
          payload: { text, metadata: row.metadata ? JSON.parse(row.metadata) : null },
        }),
      )
    const nativeSyntheticRequestBytes = (row: (typeof activePointers)[number], text: string) =>
      Buffer.byteLength(
        JSON.stringify({
          sessionID: row.session_id,
          id: row.message_id,
          text,
          ...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
          resume: false,
          delivery: "queue",
          description: "LAZERS task outcome",
        }),
      )
    let records: ReturnType<typeof f.store.architectSourceJournalPage>["records"] = []
    let cursor: string | undefined
    do {
      const page = f.store.architectSourceJournalPage(anchor.planID, 100, cursor)
      records = records.concat(page.records)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(records).toHaveLength(expectedRecords)
    expect(
      new Set(
        records.filter((record) => record.kind !== "source").map((record) => record.messageID),
      ).size,
    ).toBe(expectedRecords - 1)
    return {
      handoffTextBytes: Buffer.byteLength(handoffText),
      pointerTextBytes: Buffer.byteLength(pointerText),
      combinedTextBytes: Buffer.byteLength(handoffText) + Buffer.byteLength(pointerText),
      handoffInboxEntryBytes: nativeInboxEntryBytes(handoff, handoffText),
      pointerInboxEntryBytes: nativeInboxEntryBytes(pointer, pointerText),
      combinedInboxEntryBytes:
        nativeInboxEntryBytes(handoff, handoffText) + nativeInboxEntryBytes(pointer, pointerText),
      handoffSyntheticRequestBytes: nativeSyntheticRequestBytes(handoff, handoffText),
      pointerSyntheticRequestBytes: nativeSyntheticRequestBytes(pointer, pointerText),
      combinedSyntheticRequestBytes:
        nativeSyntheticRequestBytes(handoff, handoffText) +
        nativeSyntheticRequestBytes(pointer, pointerText),
      nativeNoticeCount: 2,
      sourcePointerCount: activePointers.length,
      journalRecordCount: records.length,
      inputDispositionCounts: {
        pending: records.filter(
          (record) => record.kind === "input" && record.disposition === "pending",
        ).length,
        steering: records.filter(
          (record) => record.kind === "input" && record.disposition === "steering",
        ).length,
        unknown: records.filter(
          (record) => record.kind === "input" && record.disposition === "unknown",
        ).length,
      },
      text: pointerText,
    }
  }

  const initial = f.store.ensureArchitectSourceChangeNotices({
    planID: anchor.planID,
    sourceSessionID: source.sourceSessionID,
    expectedOwner: currentPlan.owner,
    expectedPlanVersion: currentPlan.version,
    projectID: "project",
  })
  expect(initial.notices).toHaveLength(1)
  const baseline = measure(4_644)
  expect(baseline).toMatchObject({
    handoffTextBytes: 880,
    pointerTextBytes: 572,
    combinedTextBytes: 1_452,
    handoffInboxEntryBytes: 1_388,
    pointerInboxEntryBytes: 1_164,
    combinedInboxEntryBytes: 2_552,
    handoffSyntheticRequestBytes: 1_450,
    pointerSyntheticRequestBytes: 1_226,
    combinedSyntheticRequestBytes: 2_676,
    nativeNoticeCount: 2,
    sourcePointerCount: 1,
    journalRecordCount: 4_644,
  })
  expect(baseline.inputDispositionCounts).toEqual({ pending: 201, steering: 201, unknown: 201 })
  expect(baseline.text).not.toContain("msg_input_")
  expect(baseline.text).not.toContain("msg_result_")

  f.store.atomic((db) => {
    const inputInsert = db.query(
      `INSERT INTO runner_architect_inputs(
         session_id,message_id,observed_at,renewal_id,native_type,delivery,disposition,
         metadata_json,last_seen_sweep,referenced_revision,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (let index = 0; index < 804; index++) {
      const id = `msg_double_input_${String(index).padStart(4, "0")}`
      const disposition = ["pending", "steering", "delivered", "unknown"][index % 4]!
      inputInsert.run(
        source.sourceSessionID,
        id,
        2_000 + index,
        source.renewalID,
        "user",
        disposition === "steering" ? "steer" : null,
        disposition,
        JSON.stringify({ privateBodyCanary: "SECOND_ORIGINAL_MESSAGE_BODY" }),
        10,
        1,
        2_000 + index,
      )
    }
    const resultInsert = db.query(
      `INSERT INTO runner_architect_source_results(
         session_id,renewal_id,message_id,state,finish,tool_running,tool_completed,tool_failed,
         tool_other,result_fingerprint,result_revision,referenced_revision,updated_at
       ) VALUES(?,?,?,'completed','stop',0,2,0,0,?,1,1,?)`,
    )
    for (let index = 0; index < 3_839; index++) {
      const id = `msg_double_result_${String(index).padStart(4, "0")}`
      resultInsert.run(
        source.sourceSessionID,
        source.renewalID,
        id,
        `double-fingerprint-${index}`,
        3_000 + index,
      )
    }
    db.query(
      `UPDATE runner_architect_source_results
       SET state='failed',finish='error',tool_completed=0,tool_failed=1,
           result_fingerprint=?,result_revision=2,referenced_revision=0,updated_at=?
       WHERE session_id=? AND message_id='msg_result_0000'`,
    ).run("changed-result-fingerprint", 9_000, source.sourceSessionID)
    db.query("UPDATE runner_architect_sources SET revision=13 WHERE session_id=?").run(
      source.sourceSessionID,
    )
  })
  f.store.ensureArchitectSourceChangeNotices({
    planID: anchor.planID,
    sourceSessionID: source.sourceSessionID,
    expectedOwner: currentPlan.owner,
    expectedPlanVersion: currentPlan.version,
    projectID: "project",
  })
  const doubled = measure(9_287)
  expect(doubled).toMatchObject({
    handoffTextBytes: 880,
    pointerTextBytes: 572,
    combinedTextBytes: 1_452,
    handoffInboxEntryBytes: 1_388,
    pointerInboxEntryBytes: 1_164,
    combinedInboxEntryBytes: 2_552,
    handoffSyntheticRequestBytes: 1_450,
    pointerSyntheticRequestBytes: 1_226,
    combinedSyntheticRequestBytes: 2_676,
    nativeNoticeCount: 2,
    sourcePointerCount: 1,
    journalRecordCount: 9_287,
  })
  expect(doubled.inputDispositionCounts).toEqual({ pending: 402, steering: 402, unknown: 402 })
  expect(doubled.nativeNoticeCount).toBe(baseline.nativeNoticeCount)
  expect(doubled.sourcePointerCount).toBe(baseline.sourcePointerCount)
  expect(doubled.handoffTextBytes).toBe(baseline.handoffTextBytes)
  expect(doubled.pointerTextBytes).toBe(baseline.pointerTextBytes)
  expect(doubled.combinedInboxEntryBytes).toBe(baseline.combinedInboxEntryBytes)
  expect(doubled.text).not.toContain("msg_result_0000")
  let cursor: string | undefined
  let changedResult:
    ReturnType<typeof f.store.architectSourceJournalPage>["records"][number] | undefined
  do {
    const journal = f.store.architectSourceJournalPage(anchor.planID, 100, cursor)
    changedResult = journal.records.find(
      (record) => record.kind === "result" && record.messageID === "msg_result_0000",
    )
    cursor = journal.nextCursor ?? undefined
  } while (!changedResult && cursor)
  expect(changedResult).toMatchObject({
    kind: "result",
    messageID: "msg_result_0000",
    state: "failed",
    resultRevision: 2,
  })
})

test("an in-progress source-notice reconciliation claim survives store reopen without replacing receipts", () => {
  const f = fixture("architect-source-notice-reopen")
  const anchor = f.store.submit(f.input, "owner")
  const source = seedSourceJournal(f.store, anchor.planID, 1, 1)
  f.store.atomic((db) =>
    db
      .query(
        `UPDATE runner_plans SET owner=?,version=version+1
         WHERE id IN (SELECT plan_id FROM runner_architect_renewal_plans WHERE renewal_id=?)`,
      )
      .run(source.successorSessionID, source.renewalID),
  )
  const current = f.store.plan(anchor.planID)!
  f.store.ensureArchitectSourceChangeNotices({
    planID: anchor.planID,
    sourceSessionID: source.sourceSessionID,
    expectedOwner: current.owner,
    expectedPlanVersion: current.version,
    projectID: "project",
  })
  const outboxID = "legacy-source-notice-reopen"
  const messageID = "msg_legacy_source_notice_reopen"
  const payload = {
    status: "architect-source-reference",
    version: 12,
    sourceSessionID: source.sourceSessionID,
    sourceRevision: 12,
    inputIDs: [{ id: "msg_disjoint_old_input", type: "user", disposition: "pending" }],
    results: [],
    planID: anchor.planID,
  }
  const metadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: "project",
    lazersProjectDirectory: f.projectDirectory,
    lazersPlanID: anchor.planID,
    lazersOutboxID: outboxID,
    lazersMessageID: messageID,
    lazersSessionID: current.owner,
    lazersStatus: payload.status,
    lazersVersion: payload.version,
  }
  const originalReceipt = JSON.stringify({
    history: [{ kind: "native-admission", messageID, sessionID: current.owner, retained: true }],
  })
  f.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_outbox(
           id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt
         ) VALUES(?,?,?,?,?,'admitted',0,?,?)`,
      )
      .run(
        outboxID,
        anchor.planID,
        current.owner,
        messageID,
        JSON.stringify(payload),
        JSON.stringify(metadata),
        originalReceipt,
      ),
  )
  const firstClaimID = "claim-before-reopen"
  const first = f.store.beginArchitectSourceNoticeReconciliation({
    planID: anchor.planID,
    sourceSessionID: source.sourceSessionID,
    expectedOwner: current.owner,
    expectedPlanVersion: current.version,
    projectID: "project",
    outboxID,
    requestID: "request-before-reopen",
    claimID: firstClaimID,
  })
  expect(first.status).toBe("claimed")
  expect(f.store.architectSourceNoticeClaimCurrent(outboxID, firstClaimID)).toBe(true)

  f.repository.close()
  const reopenedRepository = new TaskRepository(f.databasePath, f.projectDirectory)
  repositories.push(reopenedRepository)
  const reopened = new RunnerStore(reopenedRepository)
  const page = reopened.architectLegacySourceNoticePage(source.sourceSessionID)
  expect(page).toMatchObject({
    total: 1,
    rows: [{ id: outboxID, state: "reconciling", payload: JSON.stringify(payload) }],
  })
  const retryClaimID = "claim-after-reopen"
  const retry = reopened.beginArchitectSourceNoticeReconciliation({
    planID: anchor.planID,
    sourceSessionID: source.sourceSessionID,
    expectedOwner: current.owner,
    expectedPlanVersion: current.version,
    projectID: "project",
    outboxID,
    requestID: "request-after-reopen",
    claimID: retryClaimID,
  })
  expect(retry.status).toBe("claimed")
  expect(reopened.architectSourceNoticeClaimCurrent(outboxID, firstClaimID)).toBe(false)
  expect(reopened.architectSourceNoticeClaimCurrent(outboxID, retryClaimID)).toBe(true)
  expect(
    reopened.finishArchitectSourceNoticeReconciliation({
      outboxID,
      claimID: retryClaimID,
      state: "superseded",
      receipt: { kind: "source-notice-cancellation-confirmed-by-native-readback" },
      event: "ARCHITECT_SOURCE_NOTICE_CANCELLED",
    }),
  ).toBe(true)
  const final = reopened
    .architectSourceNoticeRows(source.sourceSessionID)
    .find((row) => row.id === outboxID)!
  expect(final).toMatchObject({
    state: "superseded",
    message_id: messageID,
    payload: JSON.stringify(payload),
  })
  const history = JSON.parse(final.receipt!).history as Array<Record<string, unknown>>
  expect(history[0]).toEqual(JSON.parse(originalReceipt).history[0])
  expect(history.map((entry) => entry.claimID)).toContain(firstClaimID)
  expect(history.map((entry) => entry.claimID)).toContain(retryClaimID)
  expect(history.map((entry) => entry.kind)).toContain(
    "source-notice-cancellation-confirmed-by-native-readback",
  )
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

test("delivery excludes terminal historical unknown rows but retains admitted recovery and the latest unknown", () => {
  const f = fixture("bounded-outbox")
  const plan = f.store.submit(f.input, "owner")
  f.store.atomic((db) => {
    for (const [id, version, state] of [
      ["old-unknown", 1, "unknown"],
      ["old-admitted", 2, "admitted"],
      ["latest-unknown", 3, "unknown"],
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
  expect(f.store.outboxForDelivery().map((row) => row.id)).toEqual([
    "old-admitted",
    "latest-unknown",
  ])
  expect(f.store.detail(plan.planID).delivery as unknown[]).toHaveLength(3)
})

test("delivery ranks numeric versions once while preserving latest terminal ties, active recovery and project order", () => {
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
      ["first-null", first.planID, null, "unknown"],
      ["first-tie-old", first.planID, "10", "unknown"],
      ["second-null-old", second.planID, null, "superseded"],
      ["first-pending", first.planID, 1, "pending"],
      ["second-null-latest", second.planID, null, "superseded"],
      ["first-tie-latest", first.planID, 10.9, "superseded"],
      ["first-sending", first.planID, 2, "sending"],
      ["first-uncertain", first.planID, 3, "uncertain"],
      ["first-admitted", first.planID, 4, "admitted"],
      ["first-delivered", first.planID, 5, "delivered"],
      ["first-low-newest", first.planID, 9, "unknown"],
      ["foreign-pending", foreign.planID, 100, "pending"],
      ["foreign-latest", foreign.planID, 101, "unknown"],
    ] as const
    for (const [id, planID, version, state] of rows)
      db.query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,?,?,?,?,1)",
      ).run(id, planID, "owner", `msg_${id}`, JSON.stringify({ version }), state)
  })
  // Foreign history must be scoped out before evaluating its JSON version.
  f.store.atomic((db) =>
    db.query("UPDATE runner_outbox SET payload='not json' WHERE id='foreign-latest'").run(),
  )
  const rows = f.store.outboxForDelivery()
  expect(rows.map((row) => [row.id, row.version as number | null])).toEqual([
    ["first-pending", 1],
    ["second-null-latest", null],
    ["first-tie-latest", 10],
    ["first-sending", 2],
    ["first-uncertain", 3],
    ["first-admitted", 4],
    ["first-delivered", 5],
  ])
  expect(rows.map((row) => row.sequence)).toEqual(
    rows.map((row) => row.sequence).toSorted((a, b) => a - b),
  )
  // Delivery does not erase historical terminal rows or their payloads.
  expect(f.store.detail(first.planID).delivery as unknown[]).toHaveLength(9)
  f.store.atomic((db) =>
    db.query("UPDATE runner_outbox SET payload='not json' WHERE id='first-null'").run(),
  )
  expect(() => f.store.outboxForDelivery()).toThrow("malformed JSON")
})

test("legacy delivered outbox schema migrates across an actual close and reopen with unknown consumption", () => {
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
  expect(row.state).toBe("admitted")
  expect(JSON.parse(row.receipt)).toEqual({ kind: "legacy-host-admitted", consumption: "unknown" })
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

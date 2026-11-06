import { afterEach, expect, test } from "bun:test"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { PlanInput } from "./schema.ts"
import { RunnerStore } from "./store.ts"

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

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
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

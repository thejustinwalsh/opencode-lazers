import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { schemaModules } from "../database-schema.ts"
import { TaskRepository } from "../storage.ts"
import {
  retireHumanEvidenceGate,
  retireSourceQuarantines,
  retireStaleHolds,
  retireRetainedVerificationGates,
} from "./retire-gates.ts"
import { RetainedVerificationSchema } from "./retained-verification/schema.ts"
import { RunnerStore } from "./store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-retire-gates-"))
  directories.push(directory)
  const projectDirectory = join(directory, "project")
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), projectDirectory)
  repositories.push(repository)
  const store = new RunnerStore(repository)
  const submit = (requestID: string) => {
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
    return store.submit(
      {
        requestID,
        objective: "Retire the human evidence gate",
        baseCommit: "b".repeat(40),
        draft: true,
        nodes: [{ taskID: task.id, revision: 1 as const }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: task.proposal.verification,
        acceptance: task.proposal.acceptance,
      },
      "owner",
    )
  }
  return { store, submit }
}

function block(store: RunnerStore, planID: string, reason: string) {
  store.atomic((db) =>
    db.query("UPDATE runner_plans SET state='blocked',reason=? WHERE id=?").run(reason, planID),
  )
}

test("a plan blocked solely on human evidence leaves blocked through the plan machine, once", () => {
  const f = fixture()
  const human = f.submit("human-only").planID
  const mixed = f.submit("mixed").planID
  const failing = f.submit("failing-check").planID
  block(f.store, human, "Combined artifact evidence missing: native-visual:human, review:human")
  block(
    f.store,
    mixed,
    "Combined artifact evidence missing: native-visual:human, other:evidence/x.md",
  )
  block(f.store, failing, "Combined artifact verification failed")

  const moves = f.store.atomic((db) => retireHumanEvidenceGate(db))
  expect(moves.map((move) => move.planID)).toEqual([human])
  expect(f.store.plan(human)).toMatchObject({ state: "running", reason: null })
  expect(f.store.plan(mixed)!.state).toBe("blocked")
  expect(f.store.plan(failing)!.state).toBe("blocked")
  expect(f.store.latestTransition(human, null, "PLAN_GATE_RETIRED")).toMatchObject({
    gate: "human-evidence",
  })

  // Idempotent: the second pass finds nothing to move.
  expect(f.store.atomic((db) => retireHumanEvidenceGate(db))).toEqual([])
})

test("retired waiting-human adoption states resume their check phase", () => {
  const f = fixture()
  const planID = f.submit("adoption").planID
  f.store.atomic((db) => {
    db.query(
      `INSERT INTO runner_adoptions(
         id,plan_id,task_id,request_id,owner,plan_version,task_revision,attempt_id,node_state,
         attempt_state,old_artifact,descendant_commit,target_branch,landing_head,candidate_tree,
         input_fingerprint,environment_identity,reason,combined_artifact,state,created_at,updated_at
       ) VALUES('a1',?,?,'r','owner',1,1,'attempt','verifying','verifying','o','d','main','l','t',
         'i','e','reason','c','waiting-human',0,0)`,
    ).run(planID, f.store.nodes(planID)[0]!.task_id)
  })
  f.store.atomic((db) => retireHumanEvidenceGate(db))
  expect(f.store.adoption("a1")?.state).toBe("task-checks")
})

test("a plan blocked by a source quarantine resumes through the plan machine and the table is dropped", () => {
  const f = fixture()
  const quarantined = f.submit("quarantined").planID
  const failing = f.submit("quarantine-unrelated").planID
  block(
    f.store,
    quarantined,
    "The verifying worker's checkout is quarantined. Run verify-retained on its candidate in an isolated checkout.",
  )
  block(f.store, failing, "Combined artifact verification failed")
  f.store.atomic((db) => {
    db.exec("CREATE TABLE runner_source_quarantines(attempt_id TEXT PRIMARY KEY, phase TEXT)")
    db.exec("CREATE INDEX runner_source_quarantines_pending ON runner_source_quarantines(phase)")
  })
  const tableExists = () =>
    f.store.atomic(
      (db) =>
        db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get("runner_source_quarantines") !== null,
    )
  expect(tableExists()).toBe(true)

  const moves = f.store.atomic((db) => retireSourceQuarantines(db))
  expect(moves.map((move) => move.planID)).toEqual([quarantined])
  expect(f.store.plan(quarantined)).toMatchObject({ state: "running", reason: null })
  expect(f.store.plan(failing)!.state).toBe("blocked")
  expect(f.store.latestTransition(quarantined, null, "PLAN_GATE_RETIRED")).toMatchObject({
    gate: "source-quarantine",
  })
  expect(tableExists()).toBe(false)

  expect(f.store.atomic((db) => retireSourceQuarantines(db))).toEqual([])
  expect(f.store.plan(quarantined)!.state).toBe("running")
  expect(tableExists()).toBe(false)
})

test("plans held by retired reasons move through the plan machine; real failures stay; idempotent", () => {
  const f = fixture()
  const reasons = {
    idle: "Native idle background observation is unknown: No experimental.idle background report was observed",
    lineage: "Native idle background observation does not match the current worker input lineage",
    interrupted:
      "Worker execution was interrupted; explicit reconciliation or cancellation is required",
    scope:
      "Mechanical candidate preparation is blocked by an active scope reservation; no files were changed",
    // Plan 9e1d18b1 (LZ-261..264) on 2026-11-22.
    preparationInputs:
      "Mechanical candidate preparation inputs changed; the original activity was not replayed",
    preparationUncertain: "Mechanical candidate preparation is uncertain and was not replayed",
    preparationReceipt:
      "Mechanical candidate changed after its authorized fix receipt; no stale artifact was accepted",
    taskCheck: "Verification content has an uncertain receipt and was not replayed",
    combinedCheck:
      "Combined verification combined completed with exit 0 and timedOut=false; subprocess cleanup remains uncertain: termination was not confirmed",
    recoveryFix: "Recovery uncertain for mechanical-fix 0123abcd: check runner unavailable",
    recovery:
      "Recovery uncertain for verify:content 0123abcd: No conclusive host/artifact receipt; effect was not repeated",
  }
  const stale = Object.entries(reasons).map(([name, reason]) => {
    const planID = f.submit(`stale-${name}`).planID
    block(f.store, planID, reason)
    return planID
  })
  const failing = f.submit("real-failure").planID
  block(f.store, failing, "Combined artifact verification failed")
  const conflict = f.submit("real-conflict").planID
  block(f.store, conflict, "Combined artifact conflict: Conflicting accepted artifacts a and b")
  const cleanup = f.submit("cleanup-idle").planID
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_plans SET state='cleanup-blocked',reason=? WHERE id=?")
      .run(
        "A current confirmed experimental.idle background report is unavailable; preserve the worktree",
        cleanup,
      ),
  )
  // A verification effect that never produced a receipt is superseded so the check re-runs.
  const recoveryPlan = stale[stale.length - 1]!
  f.store.atomic((db) =>
    db
      .query(
        "INSERT INTO runner_effects VALUES('e1',?,NULL,NULL,'verify:content','uncertain','{}',?,1)",
      )
      .run(
        recoveryPlan,
        JSON.stringify({ error: "No conclusive host/artifact receipt; effect was not repeated" }),
      ),
  )

  const moves = f.store.atomic((db) => retireStaleHolds(db))
  expect(moves.map((move) => move.planID).sort()).toEqual([...stale, cleanup].sort())
  for (const planID of stale)
    expect(f.store.plan(planID)).toMatchObject({ state: "running", reason: null })
  expect(f.store.plan(cleanup)!.state).toBe("cleaning")
  expect(f.store.plan(failing)!.state).toBe("blocked")
  expect(f.store.plan(conflict)!.state).toBe("blocked")
  const effect = f.store.effects(recoveryPlan).find((item) => item.id === "e1")!
  expect(effect.state).toBe("failed")
  expect(JSON.parse(effect.receipt!)).toMatchObject({ superseded: true })

  expect(f.store.atomic((db) => retireStaleHolds(db))).toEqual([])
})

const LEGACY_RETAINED_TABLES = `
  CREATE TABLE runner_retained_verifications (
    id TEXT PRIMARY KEY,
    project_directory TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    state TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE(project_directory,plan_id,task_id,generation)
  );
  CREATE INDEX runner_retained_verifications_active
    ON runner_retained_verifications(project_directory,plan_id,task_id,state,generation);
  CREATE TABLE runner_retained_verification_checks (
    operation_id TEXT NOT NULL REFERENCES runner_retained_verifications(id),
    phase TEXT NOT NULL, check_id TEXT NOT NULL, check_json TEXT NOT NULL, workspace TEXT NOT NULL,
    artifact TEXT NOT NULL, input_fingerprint TEXT NOT NULL, environment_identity TEXT NOT NULL,
    receipt_path TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, context_path TEXT NOT NULL,
    cleanup_state TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(operation_id,phase,check_id)
  );
  CREATE TABLE runner_retained_verification_evidence (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES runner_retained_verifications(id),
    generation INTEGER NOT NULL, phase TEXT NOT NULL, task_id TEXT, assertion_id TEXT NOT NULL,
    artifact TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX runner_retained_verification_evidence_lookup
    ON runner_retained_verification_evidence(operation_id,generation,phase,task_id,assertion_id,artifact);
  CREATE TABLE runner_retained_verification_resources (
    project_directory TEXT NOT NULL,
    operation_id TEXT NOT NULL REFERENCES runner_retained_verifications(id),
    generation INTEGER NOT NULL, phase TEXT NOT NULL, check_id TEXT NOT NULL,
    resource_name TEXT NOT NULL, canonical_path TEXT NOT NULL, device INTEGER NOT NULL,
    inode INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(operation_id,phase,check_id,resource_name)
  );
`

function legacyOperation(
  projectDirectory: string,
  planID: string,
  taskID: string,
  generation: number,
  state: string,
  holdReason: string | null,
) {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    generation,
    projectID: "project",
    projectDirectory,
    planID,
    planRevision: 1,
    planVersion: 43,
    owner: "owner",
    ownerEpoch: 0,
    taskID,
    taskRevision: 1,
    attemptID: crypto.randomUUID(),
    originalSessionID: "ses",
    originalMessageID: "msg",
    originalWorkspace: "/original",
    artifact: "a".repeat(40),
    sourceQuarantine: { phase: "sealed" },
    combinedArtifact: null,
    combinedInputFingerprint: null,
    taskWorkspace: null,
    taskWorkspaceState: null,
    combinedWorkspace: "/combined",
    combinedWorkspaceState: "owned",
    inputFingerprint: "opaque",
    environmentIdentity: "{}",
    reason: "Verify",
    state,
    holdReason,
    cleanupState: "pending",
    createdAt: 1,
    updatedAt: 1,
  }
}

test("retained verification collapses to one call: operations close, payloads lose their bindings, the generation column drops, stranded plans move, and a second pass changes nothing", () => {
  const f = fixture()
  const planID = f.submit("retained-held").planID
  const taskID = f.store.nodes(planID)[0]!.task_id
  const projectDirectory = f.store.repository.projectDirectory
  const stranded = f.submit("retained-binding").planID
  const real = f.submit("retained-real-failure").planID
  block(
    f.store,
    stranded,
    "Combined verification continuation inputs or unresolved effects changed; preserve the candidate",
  )
  block(f.store, real, "Combined artifact verification failed")

  const accepted = legacyOperation(projectDirectory, planID, taskID, 1, "held", "Interrupted")
  const stuck = legacyOperation(projectDirectory, planID, taskID, 2, "combined-checks", null)
  const failed = legacyOperation(projectDirectory, planID, taskID, 3, "failed", "Check failed")
  const finished = legacyOperation(projectDirectory, planID, taskID, 4, "cancelled", "Stopped")
  f.store.atomic((db) => {
    db.exec(LEGACY_RETAINED_TABLES)
    for (const operation of [accepted, stuck, failed, finished])
      db.query("INSERT INTO runner_retained_verifications VALUES(?,?,?,?,?,?,?)").run(
        operation.id,
        projectDirectory,
        planID,
        taskID,
        operation.generation,
        operation.state,
        JSON.stringify(operation),
      )
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,'RETAINED_TASK_CANDIDATE_ACCEPTED',?,1)",
    ).run(planID, taskID, JSON.stringify({ operationID: accepted.id }))
    db.query(
      "INSERT INTO runner_retained_verification_checks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      stuck.id,
      "task",
      "tests",
      "{}",
      "/w",
      stuck.artifact,
      "i",
      "e",
      "/r",
      "retry-authorized",
      "{}",
      "/c",
      "complete",
      1,
    )
    db.query(
      "INSERT INTO runner_retained_verification_evidence VALUES('ev',?,2,'task',?,'a1',?,'body',1)",
    ).run(stuck.id, taskID, stuck.artifact)
    db.query(
      "INSERT INTO runner_retained_verification_resources VALUES(?,?,2,'task','tests','tmp','/p',1,2,'removed',1,1)",
    ).run(projectDirectory, stuck.id)
    for (const [id, state] of [
      ["pending-notice", "pending"],
      ["delivered-notice", "delivered"],
    ] as const)
      db.query(
        "INSERT INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume) VALUES(?,?,'owner',?,?,?,0)",
      ).run(
        id,
        planID,
        `message-${id}`,
        JSON.stringify({ status: "retained-verification-held", operationID: stuck.id }),
        state,
      )
  })

  const first = f.store.atomic((db) => retireRetainedVerificationGates(db))
  expect(first.operations).toEqual([
    { operationID: accepted.id, planID, from: "held", to: "accepted" },
    { operationID: stuck.id, planID, from: "combined-checks", to: "cancelled" },
  ])
  expect(first.plans).toMatchObject([
    { planID: stranded, from: "blocked", to: "running", retired: "retained-verification" },
  ])
  expect(f.store.plan(stranded)).toMatchObject({ state: "running", reason: null })
  expect(f.store.plan(real)!.state).toBe("blocked")
  expect(f.store.latestTransition(stranded, null, "PLAN_GATE_RETIRED")).toMatchObject({
    gate: "retained-verification",
  })

  const read = () =>
    f.store.atomic((db) => ({
      operations: db
        .query<{ id: string; state: string; payload: string }, []>(
          "SELECT id,state,payload FROM runner_retained_verifications ORDER BY rowid",
        )
        .all(),
      checks: db.query("SELECT check_id,state FROM runner_retained_verification_checks").all(),
      outbox: db.query("SELECT id,state FROM runner_outbox ORDER BY id").all(),
      foreignKeyViolations: db.query("PRAGMA foreign_key_check").all(),
    }))
  const columns = (table: string) =>
    f.store.atomic((db) =>
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name),
    )
  const after = read()
  expect(after.operations.map((row) => row.state)).toEqual([
    "accepted",
    "cancelled",
    "failed",
    "cancelled",
  ])
  for (const row of after.operations) {
    const raw = JSON.parse(row.payload) as Record<string, unknown>
    expect(String(RetainedVerificationSchema.parse(raw).state)).toBe(row.state)
    for (const retired of [
      "generation",
      "planVersion",
      "ownerEpoch",
      "sourceQuarantine",
      "inputFingerprint",
      "combinedInputFingerprint",
      "holdReason",
    ])
      expect(raw).not.toHaveProperty(retired)
  }
  const reasons = after.operations.map(
    (row) => RetainedVerificationSchema.parse(JSON.parse(row.payload)).failureReason,
  )
  expect(reasons[0]).toBeNull()
  expect(reasons[1]).toContain("run verify-retained again")
  expect(reasons[2]).toBe("Check failed")
  expect(reasons[3]).toBe("Stopped")
  expect(columns("runner_retained_verifications")).not.toContain("generation")
  expect(columns("runner_retained_verification_evidence")).not.toContain("generation")
  expect(columns("runner_retained_verification_resources")).not.toContain("generation")
  expect(after.checks).toEqual([{ check_id: "tests", state: "completed" }])
  expect(after.outbox).toEqual([
    { id: "delivered-notice", state: "delivered" },
    { id: "pending-notice", state: "superseded" },
  ])
  expect(after.foreignKeyViolations).toEqual([])

  // Idempotent: a second pass finds nothing and changes nothing.
  expect(f.store.atomic((db) => retireRetainedVerificationGates(db))).toEqual({
    operations: [],
    plans: [],
  })
  expect(read()).toEqual(after)
})

test("a current-shape retained verification table keeps its live calls across the retirement pass", () => {
  const f = fixture()
  const planID = f.submit("retained-current-shape").planID
  const taskID = f.store.nodes(planID)[0]!.task_id
  f.store.atomic((db) => {
    db.exec(`
      CREATE TABLE runner_retained_verifications (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, plan_id TEXT NOT NULL,
        task_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL
      );`)
    db.query(
      "INSERT INTO runner_retained_verifications VALUES('live',?,?,?,'task-checks','{}')",
    ).run(f.store.repository.projectDirectory, planID, taskID)
  })
  expect(f.store.atomic((db) => retireRetainedVerificationGates(db)).operations).toEqual([])
  expect(
    f.store.atomic((db) =>
      db.query<{ state: string }, []>("SELECT state FROM runner_retained_verifications").get(),
    ),
  ).toEqual({ state: "task-checks" })
})

test("the runner schema generation runs the retained retirement when an old database opens", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-retire-retained-open-"))
  directories.push(directory)
  const path = join(directory, "tasks.sqlite")
  const projectDirectory = join(directory, "project")
  const first = new TaskRepository(path, projectDirectory)
  new RunnerStore(first)
  first.atomic((db) => {
    db.exec(LEGACY_RETAINED_TABLES)
    db.query("UPDATE schema_modules SET generation=11 WHERE module='runner'").run()
  })
  first.close()
  const reopened = new TaskRepository(path, projectDirectory)
  repositories.push(reopened)
  new RunnerStore(reopened)
  expect(
    reopened.read((db) =>
      db
        .query<{ name: string }, []>("PRAGMA table_info(runner_retained_verifications)")
        .all()
        .map((column) => column.name),
    ),
  ).toEqual(["id", "project_directory", "plan_id", "task_id", "state", "payload"])
  expect(
    reopened.read((db) =>
      db
        .query<{ generation: number }, []>(
          "SELECT generation FROM schema_modules WHERE module='runner'",
        )
        .get(),
    ),
  ).toEqual({ generation: schemaModules.runner.generation })
})

import type { Database } from "bun:sqlite"
import { fingerprint } from "../../identity.ts"
import { RetainedVerificationSchema } from "./schema.ts"
import type {
  RetainedVerification,
  RetainedVerificationCheck,
  RetainedVerificationEvidence,
} from "./schema.ts"

export function ensureRetainedVerificationTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runner_retained_verifications (
      id TEXT PRIMARY KEY,
      project_directory TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      state TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(project_directory,plan_id,task_id,generation)
    );
    CREATE INDEX IF NOT EXISTS runner_retained_verifications_active
      ON runner_retained_verifications(project_directory,plan_id,task_id,state,generation);
    CREATE TABLE IF NOT EXISTS runner_retained_verification_checks (
      operation_id TEXT NOT NULL REFERENCES runner_retained_verifications(id),
      phase TEXT NOT NULL,
      check_id TEXT NOT NULL,
      check_json TEXT NOT NULL,
      workspace TEXT NOT NULL,
      artifact TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      environment_identity TEXT NOT NULL,
      receipt_path TEXT NOT NULL,
      state TEXT NOT NULL,
      receipt TEXT,
      context_path TEXT NOT NULL,
      cleanup_state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(operation_id,phase,check_id)
    );
    CREATE TABLE IF NOT EXISTS runner_retained_verification_evidence (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES runner_retained_verifications(id),
      generation INTEGER NOT NULL,
      phase TEXT NOT NULL,
      task_id TEXT,
      assertion_id TEXT NOT NULL,
      artifact TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runner_retained_verification_evidence_lookup
      ON runner_retained_verification_evidence(operation_id,generation,phase,task_id,assertion_id,artifact);
    CREATE TABLE IF NOT EXISTS runner_retained_verification_resources (
      project_directory TEXT NOT NULL,
      operation_id TEXT NOT NULL REFERENCES runner_retained_verifications(id),
      generation INTEGER NOT NULL,
      phase TEXT NOT NULL,
      check_id TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      canonical_path TEXT NOT NULL,
      device INTEGER NOT NULL,
      inode INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(operation_id,phase,check_id,resource_name)
    );
    CREATE INDEX IF NOT EXISTS runner_retained_verification_resources_active
      ON runner_retained_verification_resources(project_directory,state,canonical_path);
  `)
}

export function retainedVerification(
  db: Database,
  operationID: string,
): RetainedVerification | undefined {
  ensureRetainedVerificationTables(db)
  const row = db
    .query<{ payload: string }, [string]>(
      "SELECT payload FROM runner_retained_verifications WHERE id=?",
    )
    .get(operationID)
  return row ? RetainedVerificationSchema.parse(JSON.parse(row.payload)) : undefined
}

export function retainedVerificationsForPlan(
  db: Database,
  projectDirectory: string,
  planID: string,
): RetainedVerification[] {
  ensureRetainedVerificationTables(db)
  return db
    .query<{ payload: string }, [string, string]>(
      "SELECT payload FROM runner_retained_verifications WHERE project_directory=? AND plan_id=? ORDER BY generation",
    )
    .all(projectDirectory, planID)
    .map((row) => RetainedVerificationSchema.parse(JSON.parse(row.payload)))
}

const liveStates = [
  "pending",
  "task-checks",
  "combined-checks",
  "waiting-human",
  "waiting-human-combined",
  "task-accepted",
  "held",
] as const

export function activeRetainedVerifications(
  db: Database,
  projectDirectory: string,
  planID?: string,
): RetainedVerification[] {
  ensureRetainedVerificationTables(db)
  const placeholders = liveStates.map(() => "?").join(",")
  const rows = planID
    ? db
        .query<{ payload: string }, [string, string, ...string[]]>(
          `SELECT payload FROM runner_retained_verifications
           WHERE project_directory=? AND plan_id=? AND state IN (${placeholders}) ORDER BY generation`,
        )
        .all(projectDirectory, planID, ...liveStates)
    : db
        .query<{ payload: string }, [string, ...string[]]>(
          `SELECT payload FROM runner_retained_verifications
           WHERE project_directory=? AND state IN (${placeholders}) ORDER BY plan_id,task_id,generation`,
        )
        .all(projectDirectory, ...liveStates)
  return rows.map((row) => RetainedVerificationSchema.parse(JSON.parse(row.payload)))
}

export function createRetainedVerification(
  db: Database,
  projectDirectory: string,
  input: RetainedVerification,
): RetainedVerification {
  ensureRetainedVerificationTables(db)
  const operation = RetainedVerificationSchema.parse(input)
  const active = db
    .query<{ id: string }, [string, string, string, ...string[]]>(
      `SELECT id FROM runner_retained_verifications
       WHERE project_directory=? AND plan_id=? AND task_id=? AND state IN (${liveStates.map(() => "?").join(",")})
       LIMIT 1`,
    )
    .get(projectDirectory, operation.planID, operation.taskID, ...liveStates)
  if (active) throw new Error("A conflicting retained verification operation is active")
  const latest = db
    .query<{ generation: number }, [string, string, string]>(
      `SELECT MAX(generation) AS generation FROM runner_retained_verifications
       WHERE project_directory=? AND plan_id=? AND task_id=?`,
    )
    .get(projectDirectory, operation.planID, operation.taskID)
  if (operation.generation !== (latest?.generation ?? 0) + 1)
    throw new Error("Retained verification generation changed before reservation")
  db.query(
    `INSERT INTO runner_retained_verifications
     (id,project_directory,plan_id,task_id,generation,state,payload) VALUES(?,?,?,?,?,?,?)`,
  ).run(
    operation.id,
    projectDirectory,
    operation.planID,
    operation.taskID,
    operation.generation,
    operation.state,
    JSON.stringify(operation),
  )
  return operation
}

export function updateRetainedVerification(
  db: Database,
  operation: RetainedVerification,
  expectedStates: readonly RetainedVerification["state"][],
): boolean {
  ensureRetainedVerificationTables(db)
  const current = retainedVerification(db, operation.id)
  if (!current || current.generation !== operation.generation) return false
  const states = expectedStates.map(() => "?").join(",")
  const changed = db
    .query(
      `UPDATE runner_retained_verifications SET state=?,payload=?
       WHERE id=? AND generation=? AND state IN (${states})`,
    )
    .run(
      operation.state,
      JSON.stringify(operation),
      operation.id,
      operation.generation,
      ...expectedStates,
    ).changes
  return changed === 1
}

export function setRetainedVerificationWorkspace(
  db: Database,
  operation: RetainedVerification,
  phase: "task" | "combined",
  workspace: string,
  state: "reserved" | "owned" | "uncertain" | "removed",
): RetainedVerification {
  const updated = RetainedVerificationSchema.parse({
    ...operation,
    ...(phase === "task"
      ? { taskWorkspace: workspace, taskWorkspaceState: state }
      : { combinedWorkspace: workspace, combinedWorkspaceState: state }),
    updatedAt: Date.now(),
  })
  saveRetainedVerification(db, updated)
  return updated
}

export function retainedVerificationChecks(
  db: Database,
  operationID: string,
  phase?: "task" | "combined",
): RetainedVerificationCheck[] {
  ensureRetainedVerificationTables(db)
  // The public row is decoded below from explicit SQL fields; no caller JSON is trusted.
  const records = phase
    ? db
        .query<RetainedVerificationCheck, [string, string]>(
          "SELECT operation_id AS operationID,phase,check_id AS checkID,check_json AS checkJSON,workspace,artifact,input_fingerprint AS inputFingerprint,environment_identity AS environmentIdentity,receipt_path AS receiptPath,state,receipt,context_path AS contextPath,cleanup_state AS cleanupState,created_at AS createdAt FROM runner_retained_verification_checks WHERE operation_id=? AND phase=? ORDER BY created_at,check_id",
        )
        .all(operationID, phase)
    : db
        .query<RetainedVerificationCheck, [string]>(
          "SELECT operation_id AS operationID,phase,check_id AS checkID,check_json AS checkJSON,workspace,artifact,input_fingerprint AS inputFingerprint,environment_identity AS environmentIdentity,receipt_path AS receiptPath,state,receipt,context_path AS contextPath,cleanup_state AS cleanupState,created_at AS createdAt FROM runner_retained_verification_checks WHERE operation_id=? ORDER BY created_at,phase,check_id",
        )
        .all(operationID)
  return records
}

export function beginRetainedVerificationCheck(
  db: Database,
  input: {
    operationID: string
    phase: "task" | "combined"
    checkID: string
    check: unknown
    workspace: string
    artifact: string
    inputFingerprint: string
    environmentIdentity: string
    receiptPath: string
    contextPath: string
    createdAt: number
  },
): RetainedVerificationCheck {
  ensureRetainedVerificationTables(db)
  const current = db
    .query<RetainedVerificationCheck, [string, string, string]>(
      `SELECT operation_id AS operationID,phase,check_id AS checkID,check_json AS checkJSON,workspace,artifact,
       input_fingerprint AS inputFingerprint,environment_identity AS environmentIdentity,receipt_path AS receiptPath,
       state,receipt,context_path AS contextPath,cleanup_state AS cleanupState,created_at AS createdAt
       FROM runner_retained_verification_checks WHERE operation_id=? AND phase=? AND check_id=?`,
    )
    .get(input.operationID, input.phase, input.checkID)
  if (current) {
    if (
      current.inputFingerprint !== input.inputFingerprint ||
      current.environmentIdentity !== input.environmentIdentity ||
      current.workspace !== input.workspace ||
      current.artifact !== input.artifact ||
      fingerprint(JSON.parse(current.checkJSON)) !== fingerprint(input.check) ||
      current.receiptPath !== input.receiptPath ||
      current.contextPath !== input.contextPath
    )
      throw new Error("Retained verification inputs changed for an existing check")
    return current
  }
  db.query(
    `INSERT INTO runner_retained_verification_checks
     (operation_id,phase,check_id,check_json,workspace,artifact,input_fingerprint,environment_identity,
      receipt_path,state,receipt,context_path,cleanup_state,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,'intended',NULL,?,'pending',?)`,
  ).run(
    input.operationID,
    input.phase,
    input.checkID,
    JSON.stringify(input.check),
    input.workspace,
    input.artifact,
    input.inputFingerprint,
    input.environmentIdentity,
    input.receiptPath,
    input.contextPath,
    input.createdAt,
  )
  return retainedVerificationChecks(db, input.operationID, input.phase).find(
    (check) => check.checkID === input.checkID,
  )!
}

export function completeRetainedVerificationCheck(
  db: Database,
  operationID: string,
  phase: string,
  checkID: string,
  receipt: unknown,
): boolean {
  ensureRetainedVerificationTables(db)
  return (
    db
      .query(
        `UPDATE runner_retained_verification_checks SET state='completed',receipt=?
         WHERE operation_id=? AND phase=? AND check_id=? AND state IN ('intended','uncertain')`,
      )
      .run(JSON.stringify(receipt), operationID, phase, checkID).changes === 1
  )
}

export function markRetainedVerificationCheckUncertain(
  db: Database,
  operationID: string,
  phase: string,
  checkID: string,
  reason: string,
): void {
  ensureRetainedVerificationTables(db)
  db.query(
    `UPDATE runner_retained_verification_checks SET state='uncertain',receipt=?
     WHERE operation_id=? AND phase=? AND check_id=? AND state='intended'`,
  ).run(JSON.stringify({ error: reason }), operationID, phase, checkID)
}

export function setRetainedVerificationCheckCleanup(
  db: Database,
  operationID: string,
  phase: string,
  checkID: string,
  state: "complete" | "failed",
): void {
  ensureRetainedVerificationTables(db)
  db.query(
    "UPDATE runner_retained_verification_checks SET cleanup_state=? WHERE operation_id=? AND phase=? AND check_id=?",
  ).run(state, operationID, phase, checkID)
}

export function registerRetainedVerificationResources(
  db: Database,
  projectDirectory: string,
  input: {
    operationID: string
    generation: number
    phase: "task" | "combined"
    checkID: string
    resources: Array<{ name: string; realPath: string; device: number; inode: number }>
    state?: "creating" | "active"
    now: number
  },
): void {
  ensureRetainedVerificationTables(db)
  const active = db
    .query<
      { canonical_path: string; device: number; inode: number; operation_id: string },
      [string]
    >(
      "SELECT canonical_path,device,inode,operation_id FROM runner_retained_verification_resources WHERE project_directory=? AND state IN ('creating','active','uncertain')",
    )
    .all(projectDirectory)
  for (const resource of input.resources) {
    const overlap = active.find(
      (other) =>
        other.operation_id !== input.operationID &&
        (other.canonical_path === resource.realPath ||
          resource.realPath.startsWith(`${other.canonical_path}/`) ||
          other.canonical_path.startsWith(`${resource.realPath}/`) ||
          (other.device >= 0 &&
            resource.device >= 0 &&
            other.device === resource.device &&
            other.inode === resource.inode)),
    )
    if (overlap)
      throw new Error(`Verification resource ${resource.name} has an active or unknown writer`)
  }
  for (const resource of input.resources)
    db.query(
      `INSERT INTO runner_retained_verification_resources
       (project_directory,operation_id,generation,phase,check_id,resource_name,canonical_path,device,inode,state,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      projectDirectory,
      input.operationID,
      input.generation,
      input.phase,
      input.checkID,
      resource.name,
      resource.realPath,
      resource.device,
      resource.inode,
      input.state ?? "active",
      input.now,
      input.now,
    )
}

export function updateRetainedVerificationResourceIdentity(
  db: Database,
  input: {
    operationID: string
    phase: "task" | "combined"
    checkID: string
    resourceName: string
    realPath: string
    device: number
    inode: number
    now: number
  },
): boolean {
  ensureRetainedVerificationTables(db)
  const changed = db
    .query(
      `UPDATE runner_retained_verification_resources
       SET device=?,inode=?,updated_at=?
       WHERE operation_id=? AND phase=? AND check_id=? AND resource_name=?
         AND canonical_path=? AND state='creating'`,
    )
    .run(
      input.device,
      input.inode,
      input.now,
      input.operationID,
      input.phase,
      input.checkID,
      input.resourceName,
      input.realPath,
    ).changes
  return changed === 1
}

export function activateRetainedVerificationResources(
  db: Database,
  operationID: string,
  phase: "task" | "combined",
  checkID: string,
  now: number,
): void {
  ensureRetainedVerificationTables(db)
  db.query(
    `UPDATE runner_retained_verification_resources SET state='active',updated_at=?
     WHERE operation_id=? AND phase=? AND check_id=? AND state='creating'`,
  ).run(now, operationID, phase, checkID)
}

export function settleRetainedVerificationResources(
  db: Database,
  operationID: string,
  phase: "task" | "combined",
  checkID: string,
  state: "removed" | "uncertain",
  now: number,
): void {
  ensureRetainedVerificationTables(db)
  db.query(
    `UPDATE runner_retained_verification_resources SET state=?,updated_at=?
     WHERE operation_id=? AND phase=? AND check_id=? AND state IN ('creating','active','uncertain')`,
  ).run(state, now, operationID, phase, checkID)
}

export function recordRetainedVerificationEvidence(
  db: Database,
  evidence: RetainedVerificationEvidence,
): void {
  ensureRetainedVerificationTables(db)
  db.query(
    `INSERT INTO runner_retained_verification_evidence
     (id,operation_id,generation,phase,task_id,assertion_id,artifact,body,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    evidence.id,
    evidence.operationID,
    evidence.generation,
    evidence.phase,
    evidence.taskID,
    evidence.assertionID,
    evidence.artifact,
    evidence.body,
    evidence.createdAt,
  )
}

export function hasRetainedVerificationEvidence(
  db: Database,
  input: {
    operationID: string
    generation: number
    phase: "task" | "combined"
    taskID: string | null
    assertionID: string
    artifact: string
  },
): boolean {
  ensureRetainedVerificationTables(db)
  return Boolean(
    db
      .query(
        `SELECT 1 FROM runner_retained_verification_evidence
         WHERE operation_id=? AND generation=? AND phase=? AND task_id IS ? AND assertion_id=? AND artifact=? LIMIT 1`,
      )
      .get(
        input.operationID,
        input.generation,
        input.phase,
        input.taskID,
        input.assertionID,
        input.artifact,
      ),
  )
}

export function saveRetainedVerification(db: Database, operation: RetainedVerification): void {
  ensureRetainedVerificationTables(db)
  const parsed = RetainedVerificationSchema.parse(operation)
  const changed = db
    .query(
      `UPDATE runner_retained_verifications SET state=?,payload=?
       WHERE id=? AND generation=?`,
    )
    .run(parsed.state, JSON.stringify(parsed), parsed.id, parsed.generation).changes
  if (changed !== 1) throw new Error("Retained verification generation is no longer current")
}

export function latestRetainedVerificationGeneration(
  db: Database,
  projectDirectory: string,
  planID: string,
  taskID: string,
): number {
  ensureRetainedVerificationTables(db)
  return (
    db
      .query<{ generation: number | null }, [string, string, string]>(
        `SELECT MAX(generation) AS generation FROM runner_retained_verifications
         WHERE project_directory=? AND plan_id=? AND task_id=?`,
      )
      .get(projectDirectory, planID, taskID)?.generation ?? 0
  )
}

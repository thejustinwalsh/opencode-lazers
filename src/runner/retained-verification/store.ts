import { lifecycleTransition, registerLifecycleTransitions } from "../lifecycle-machines.ts"
import type { Database } from "bun:sqlite"
import { fingerprint } from "../../identity.ts"
import { z } from "zod"
import { RetainedVerificationSchema } from "./schema.ts"
import type { RetainedVerification, RetainedVerificationCheck } from "./schema.ts"

type RetainedCheckProjection = {
  phase: "task" | null
  binding: "matched" | "mismatched" | "unknown"
  checkID: string
  state: "intended" | "completed" | "uncertain" | "unknown"
  candidateArtifact: string | null
  inputFingerprint: string | null
  environmentFingerprint: string | null
  reservedAt: number | null
  receipt: "recorded" | "not-recorded" | "unusable"
  receiptHistory: {
    available: boolean
    count: number
    truncated: boolean
    entries: Array<{
      receiptID: string
      current: boolean
      status: "passed" | "failed" | "unknown"
      exitCode: number | null
      timedOut: boolean | null
      aborted: boolean | null
      endedAt: number | null
    }>
  }
  evidenceReference: string
  result: {
    status: "passed" | "failed" | "unknown"
    exitCode: number | null
    timedOut: boolean | null
    aborted: boolean | null
    phasesComplete: boolean | null
    stopCause: "inactivity" | "hard-backstop" | "cancelled" | null
    startedAt: number | null
    endedAt: number | null
    durationMs: number | null
    output: "recorded" | "truncated" | "not-recorded"
  }
  verificationDeadline: {
    timingPolicyVersion: number | null
    authoredTimeoutMs: number | null
    authoredInactivityTimeoutMs: number | null
    authoredHardTimeoutMs: number | null
    defaultInactivityTimeoutMs: number | null
    defaultHardTimeoutMs: number | null
    effectiveInactivityTimeoutMs: number | null
    effectiveHardTimeoutMs: number
    effectiveTimeoutMs: number
    amendmentID: string | null
    policyRevision: number | null
    inactivityProvenance: "project-default" | "per-check" | "amendment" | "legacy" | "unknown"
    hardTimeoutProvenance: "project-default" | "per-check" | "amendment" | "legacy" | "unknown"
    historicalAmendmentIDs: string[]
  } | null
  cleanupState: "pending" | "complete" | "failed" | "unknown"
}

type RetainedTimingProvenance = "project-default" | "per-check" | "amendment" | "legacy" | "unknown"

export type RetainedVerificationProjection = {
  recordStatus: "recorded" | "unavailable"
  operationID: string | null
  planID: string
  taskID: string | null
  taskRevision: number | null
  planRevision: number | null
  attemptID: string | null
  candidateArtifact: string | null
  state: RetainedVerification["state"] | "unknown"
  reason: string
  environmentFingerprint: string | null
  timestamps: { createdAt: number | null; updatedAt: number | null }
  checksAvailable: boolean
  checks: RetainedCheckProjection[]
  checksTruncated: boolean
  cleanup: {
    state: RetainedVerification["cleanupState"] | "unknown"
    workspaceStates: {
      task: "reserved" | "owned" | "uncertain" | "removed" | "unknown" | null
    }
    resourcesAvailable: boolean
    resourcesByState: Record<"creating" | "active" | "uncertain" | "removed" | "unknown", number>
    completedAt: number | null
  }
}

export type RetainedVerificationInspection = {
  status: "available" | "partial" | "unavailable"
  planID: string
  taskIDs: string[]
  availability: {
    operations: boolean
    checks: boolean
    receipts: boolean
    resources: boolean
  }
  /** The latest verification call per selected task. */
  latest: RetainedVerificationProjection[]
}

/**
 * True while a terminal operation still has cleanup to do or to record: the tick reads these by
 * index instead of the project's whole history. Maintained wherever the payload is written.
 */
export function retainedCleanupPending(operation: RetainedVerification): boolean {
  const settled = (workspace: string | null, state: string | null) =>
    workspace === null ? state === null : state === "removed"
  return !(
    operation.cleanupState === "complete" &&
    settled(operation.taskWorkspace, operation.taskWorkspaceState) &&
    settled(operation.combinedWorkspace ?? null, operation.combinedWorkspaceState ?? null)
  )
}

const cleanupColumnPresent = new WeakSet<Database>()

function ensureCleanupColumn(db: Database) {
  if (cleanupColumnPresent.has(db)) return
  const has = db
    .query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('runner_retained_verifications') WHERE name='cleanup_pending'",
    )
    .get()
  if (!has) {
    db.exec(
      "ALTER TABLE runner_retained_verifications ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 1",
    )
    const settled = (workspace: string, state: string) =>
      `(CASE WHEN json_extract(payload,'$.${workspace}') IS NULL
         THEN json_extract(payload,'$.${state}') IS NULL
         ELSE json_extract(payload,'$.${state}')='removed' END)`
    db.exec(`
      UPDATE runner_retained_verifications SET cleanup_pending=CASE WHEN
        json_extract(payload,'$.cleanupState')='complete'
        AND ${settled("taskWorkspace", "taskWorkspaceState")}
        AND ${settled("combinedWorkspace", "combinedWorkspaceState")}
      THEN 0 ELSE 1 END
    `)
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS runner_retained_verifications_cleanup
      ON runner_retained_verifications(project_directory,state) WHERE cleanup_pending=1
  `)
  cleanupColumnPresent.add(db)
}

export function ensureRetainedVerificationTables(db: Database): void {
  registerLifecycleTransitions(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS runner_retained_verifications (
      id TEXT PRIMARY KEY,
      project_directory TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      state TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runner_retained_verifications_active
      ON runner_retained_verifications(project_directory,plan_id,task_id,state);
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
    CREATE TABLE IF NOT EXISTS runner_retained_verification_check_receipts (
      operation_id TEXT NOT NULL REFERENCES runner_retained_verifications(id),
      phase TEXT NOT NULL,
      check_id TEXT NOT NULL,
      receipt_path TEXT NOT NULL,
      check_json TEXT NOT NULL,
      workspace TEXT NOT NULL,
      artifact TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      environment_identity TEXT NOT NULL,
      state TEXT NOT NULL,
      receipt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(operation_id,phase,check_id,receipt_path)
    );
    CREATE TABLE IF NOT EXISTS runner_retained_verification_evidence (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES runner_retained_verifications(id),
      phase TEXT NOT NULL,
      task_id TEXT,
      assertion_id TEXT NOT NULL,
      artifact TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runner_retained_verification_evidence_lookup
      ON runner_retained_verification_evidence(operation_id,phase,task_id,assertion_id,artifact);
    CREATE TABLE IF NOT EXISTS runner_retained_verification_resources (
      project_directory TEXT NOT NULL,
      operation_id TEXT NOT NULL REFERENCES runner_retained_verifications(id),
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
  ensureCleanupColumn(db)
  db.exec(`
    INSERT OR IGNORE INTO runner_retained_verification_check_receipts(
      operation_id,phase,check_id,receipt_path,check_json,workspace,artifact,input_fingerprint,
      environment_identity,state,receipt,created_at
    )
    SELECT operation_id,phase,check_id,receipt_path,check_json,workspace,artifact,input_fingerprint,
      environment_identity,state,receipt,created_at
    FROM runner_retained_verification_checks WHERE state='completed' AND receipt IS NOT NULL
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
      "SELECT payload FROM runner_retained_verifications WHERE project_directory=? AND plan_id=? ORDER BY rowid",
    )
    .all(projectDirectory, planID)
    .map((row) => RetainedVerificationSchema.parse(JSON.parse(row.payload)))
}

/** Terminal operations whose cleanup is not recorded complete: the only ones a tick reads. */
export function terminalPendingRetainedVerifications(
  db: Database,
  projectDirectory: string,
): RetainedVerification[] {
  ensureRetainedVerificationTables(db)
  return db
    .query<{ payload: string }, [string]>(
      `SELECT payload FROM runner_retained_verifications
       WHERE project_directory=? AND state IN ('accepted','failed','cancelled') AND cleanup_pending=1
       ORDER BY plan_id,task_id,rowid`,
    )
    .all(projectDirectory)
    .map((row) => RetainedVerificationSchema.parse(JSON.parse(row.payload)))
}

const liveStates = ["pending", "task-checks"] as const

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
           WHERE project_directory=? AND plan_id=? AND state IN (${placeholders}) ORDER BY rowid`,
        )
        .all(projectDirectory, planID, ...liveStates)
    : db
        .query<{ payload: string }, [string, ...string[]]>(
          `SELECT payload FROM runner_retained_verifications
           WHERE project_directory=? AND state IN (${placeholders}) ORDER BY plan_id,task_id,rowid`,
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
  db.query(
    `INSERT INTO runner_retained_verifications
     (id,project_directory,plan_id,task_id,state,payload,cleanup_pending) VALUES(?,?,?,?,?,?,?)`,
  ).run(
    operation.id,
    projectDirectory,
    operation.planID,
    operation.taskID,
    operation.state,
    JSON.stringify(operation),
    retainedCleanupPending(operation) ? 1 : 0,
  )
  return operation
}

function validateRetainedLifecycles(previous: RetainedVerification, next: RetainedVerification) {
  lifecycleTransition("cleanup", previous.cleanupState, next.cleanupState)
  for (const field of ["taskWorkspaceState", "combinedWorkspaceState"] as const)
    lifecycleTransition("workspace", previous[field] ?? "unallocated", next[field] ?? "unallocated")
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

function retainedVerificationCheckReceipts(
  db: Database,
  operationID: string,
  phase: "task" | "combined",
  checkID: string,
) {
  ensureRetainedVerificationTables(db)
  return db
    .query<
      {
        receiptPath: string
        checkJSON: string
        workspace: string
        artifact: string
        inputFingerprint: string
        environmentIdentity: string
        state: string
        receipt: string
        createdAt: number
      },
      [string, string, string]
    >(
      `SELECT receipt_path AS receiptPath,check_json AS checkJSON,workspace,artifact,
       input_fingerprint AS inputFingerprint,environment_identity AS environmentIdentity,
       state,receipt,created_at AS createdAt
       FROM runner_retained_verification_check_receipts
       WHERE operation_id=? AND phase=? AND check_id=? ORDER BY created_at,receipt_path LIMIT 101`,
    )
    .all(operationID, phase, checkID)
}

function retainedVerificationCheckReceiptCount(
  db: Database,
  operationID: string,
  phase: "task" | "combined",
  checkID: string,
): number {
  ensureRetainedVerificationTables(db)
  return (
    db
      .query<{ count: number }, [string, string, string]>(
        `SELECT COUNT(*) AS count FROM runner_retained_verification_check_receipts
         WHERE operation_id=? AND phase=? AND check_id=?`,
      )
      .get(operationID, phase, checkID)?.count ?? 0
  )
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
  const changed = db
    .query(
      `UPDATE runner_retained_verification_checks SET state=lz_runner_transition('check',state,'completed'),receipt=?
       WHERE operation_id=? AND phase=? AND check_id=? AND state IN ('intended','uncertain')`,
    )
    .run(JSON.stringify(receipt), operationID, phase, checkID).changes
  if (changed !== 1) return false
  db.query(
    `
    INSERT OR IGNORE INTO runner_retained_verification_check_receipts(
      operation_id,phase,check_id,receipt_path,check_json,workspace,artifact,input_fingerprint,
      environment_identity,state,receipt,created_at
    )
    SELECT operation_id,phase,check_id,receipt_path,check_json,workspace,artifact,input_fingerprint,
      environment_identity,state,receipt,created_at
    FROM runner_retained_verification_checks
    WHERE operation_id=? AND phase=? AND check_id=? AND state='completed' AND receipt IS NOT NULL
  `,
  ).run(operationID, phase, checkID)
  return true
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
    `UPDATE runner_retained_verification_checks SET state=lz_runner_transition('check',state,'uncertain'),receipt=?
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
    "UPDATE runner_retained_verification_checks SET cleanup_state=lz_runner_transition('cleanup',COALESCE(cleanup_state,'pending'),?) WHERE operation_id=? AND phase=? AND check_id=?",
  ).run(state, operationID, phase, checkID)
}

/**
 * Whether an operation phase (or one check of it) still holds a resource that is not removed.
 * A settlement test asks this on every cleanup pass; it needs one row, not the resource list.
 */
export function hasUnremovedResource(
  db: Database,
  operationID: string,
  phase: string,
  checkID?: string,
): boolean {
  return Boolean(
    db
      .query<{ present: number }, string[]>(
        `SELECT 1 AS present FROM runner_retained_verification_resources
         WHERE operation_id=? AND phase=? ${checkID === undefined ? "" : "AND check_id=?"}
           AND state IS NOT 'removed' LIMIT 1`,
      )
      .get(operationID, phase, ...(checkID === undefined ? [] : [checkID])),
  )
}

export function registerRetainedVerificationResources(
  db: Database,
  projectDirectory: string,
  input: {
    operationID: string
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
  for (const resource of input.resources) {
    const existing = db
      .query<{ state: string }, [string, string, string, string]>(
        `SELECT state FROM runner_retained_verification_resources
         WHERE operation_id=? AND phase=? AND check_id=? AND resource_name=?`,
      )
      .get(input.operationID, input.phase, input.checkID, resource.name)
    if (existing) {
      if (existing.state !== "removed")
        throw new Error(`Retained verification resource ${resource.name} is already reserved`)
      db.query(
        `UPDATE runner_retained_verification_resources
         SET canonical_path=?,device=?,inode=?,state=lz_runner_transition('resource',state,'creating'),
             created_at=?,updated_at=?
         WHERE operation_id=? AND phase=? AND check_id=? AND resource_name=? AND state='removed'`,
      ).run(
        resource.realPath,
        resource.device,
        resource.inode,
        input.now,
        input.now,
        input.operationID,
        input.phase,
        input.checkID,
        resource.name,
      )
      continue
    }
    db.query(
      `INSERT INTO runner_retained_verification_resources
       (project_directory,operation_id,phase,check_id,resource_name,canonical_path,device,inode,state,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      projectDirectory,
      input.operationID,
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
    `UPDATE runner_retained_verification_resources SET state=lz_runner_transition('resource',state,'active'),updated_at=?
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
    `UPDATE runner_retained_verification_resources SET state=lz_runner_transition('resource',state,?),updated_at=?
     WHERE operation_id=? AND phase=? AND check_id=? AND state IN ('creating','active','uncertain')`,
  ).run(state, now, operationID, phase, checkID)
}

export function saveRetainedVerification(db: Database, operation: RetainedVerification): void {
  ensureRetainedVerificationTables(db)
  const parsed = RetainedVerificationSchema.parse(operation)
  const previous = retainedVerification(db, parsed.id)
  if (!previous) throw new Error("Retained verification no longer exists")
  validateRetainedLifecycles(previous, parsed)
  const changed = db
    .query(
      `UPDATE runner_retained_verifications SET state=lz_runner_transition('retained',state,?),payload=?,cleanup_pending=?
       WHERE id=?`,
    )
    .run(
      parsed.state,
      JSON.stringify(parsed),
      retainedCleanupPending(parsed) ? 1 : 0,
      parsed.id,
    ).changes
  if (changed !== 1) throw new Error("Retained verification no longer exists")
}

type InspectionOperationRow = {
  id: string
  task_id: string
  payload: string | null
  payload_too_large: number
}
type InspectionCheckRow = {
  phase: string
  check_id: string
  receipt_path: string
  artifact: string
  input_fingerprint: string
  environment_identity: string
  state: string
  receipt: string | null
  receipt_too_large: number
  cleanup_state: string
  created_at: number
}
type InspectionResourceRow = {
  state: string
  count: number
  last_updated_at: number | null
}

const retainedStates = ["pending", "task-checks", "accepted", "failed", "cancelled"] as const
const retainedCleanupStates = ["pending", "complete", "failed"] as const
const retainedWorkspaceStates = ["reserved", "owned", "uncertain", "removed"] as const
const resourceStates = ["creating", "active", "uncertain", "removed"] as const
const retainedHash = /^[a-f0-9]{64}$/

function tablePresent(db: Database, name: string): boolean {
  return Boolean(
    db
      .query<{ present: number }, [string]>(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
      )
      .get(name),
  )
}

function safeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function safePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function safeNullablePositiveInteger(value: unknown): number | null {
  return value === null ? null : safePositiveInteger(value)
}

function safeHash(value: unknown): string | null {
  return typeof value === "string" && retainedHash.test(value) ? value : null
}

function jsonValue(value: string | null): unknown {
  if (value === null) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stateReason(state: RetainedVerificationProjection["state"]): string {
  switch (state) {
    case "pending":
      return "Retained verification is reserved; runtime setup and progress are pending."
    case "task-checks":
      return "Task verification checks are in progress under runtime control."
    case "accepted":
      return "Retained verification was accepted; resource cleanup is reported separately."
    case "failed":
      return "Retained verification did not pass."
    case "cancelled":
      return "Retained verification was cancelled; resource cleanup is reported separately."
    default:
      return "Retained verification state is unavailable or unrecognized."
  }
}

function knownState<T extends string>(value: string, values: readonly T[]): T | "unknown" {
  return values.includes(value as T) ? (value as T) : "unknown"
}

function emptyResourceCounts(): RetainedVerificationProjection["cleanup"]["resourcesByState"] {
  return { creating: 0, active: 0, uncertain: 0, removed: 0, unknown: 0 }
}

function operationPayload(row: InspectionOperationRow, planID: string, projectDirectory: string) {
  if (!row.payload || row.payload_too_large) return undefined
  const parsed = RetainedVerificationSchema.safeParse(jsonValue(row.payload))
  if (!parsed.success) return undefined
  const operation = parsed.data
  return operation.id === row.id &&
    operation.planID === planID &&
    operation.projectDirectory === projectDirectory &&
    operation.taskID === row.task_id
    ? operation
    : undefined
}

function emptyProjection(
  row: InspectionOperationRow,
  planID: string,
  checksAvailable: boolean,
  resourcesAvailable: boolean,
): RetainedVerificationProjection {
  const safeID = z.uuid().safeParse(row.id)
  const safeTask = z.uuid().safeParse(row.task_id)
  return {
    recordStatus: "unavailable",
    operationID: safeID.success ? safeID.data : null,
    planID,
    taskID: safeTask.success ? safeTask.data : null,
    taskRevision: null,
    planRevision: null,
    attemptID: null,
    candidateArtifact: null,
    state: "unknown",
    reason: stateReason("unknown"),
    environmentFingerprint: null,
    timestamps: { createdAt: null, updatedAt: null },
    checksAvailable,
    checks: [],
    checksTruncated: false,
    cleanup: {
      state: "unknown",
      workspaceStates: { task: "unknown" },
      resourcesAvailable,
      resourcesByState: emptyResourceCounts(),
      completedAt: null,
    },
  }
}

function operationProjection(
  db: Database,
  row: InspectionOperationRow,
  planID: string,
  projectDirectory: string,
  tables: { checks: boolean; receipts: boolean; resources: boolean },
): RetainedVerificationProjection {
  const operation = operationPayload(row, planID, projectDirectory)
  if (!operation) return emptyProjection(row, planID, tables.checks, tables.resources)

  const checkRows = tables.checks
    ? db
        .query<InspectionCheckRow, [string]>(
          `SELECT
             CASE WHEN length(phase)<=16 THEN phase ELSE '' END AS phase,
             CASE WHEN length(check_id)<=64 THEN check_id ELSE '' END AS check_id,
             CASE WHEN length(artifact)<=64 THEN artifact ELSE '' END AS artifact,
             CASE WHEN length(input_fingerprint)<=128 THEN input_fingerprint ELSE '' END AS input_fingerprint,
             CASE WHEN length(environment_identity)<=4096 THEN environment_identity ELSE '' END AS environment_identity,
             CASE WHEN length(receipt_path)<=4096 THEN receipt_path ELSE '' END AS receipt_path,
             CASE WHEN length(state)<=32 THEN state ELSE '' END AS state,
             CASE WHEN receipt IS NULL OR length(receipt)<=100000 THEN receipt ELSE NULL END AS receipt,
             (receipt IS NOT NULL AND length(receipt)>100000) AS receipt_too_large,
             CASE WHEN length(cleanup_state)<=32 THEN cleanup_state ELSE '' END AS cleanup_state,
             created_at
           FROM runner_retained_verification_checks
           WHERE operation_id=?
           ORDER BY created_at DESC,phase,check_id LIMIT 201`,
        )
        .all(operation.id)
    : []
  const checksTruncated = checkRows.length > 200
  const resourceRows = tables.resources
    ? db
        .query<InspectionResourceRow, [string, string]>(
          `SELECT CASE WHEN state IN ('creating','active','uncertain','removed') THEN state ELSE 'unknown' END AS state,
             COUNT(*) AS count,MAX(updated_at) AS last_updated_at
           FROM runner_retained_verification_resources
           WHERE project_directory=? AND operation_id=?
           GROUP BY CASE WHEN state IN ('creating','active','uncertain','removed') THEN state ELSE 'unknown' END`,
        )
        .all(projectDirectory, operation.id)
    : []
  const resourcesByState = emptyResourceCounts()
  let removedUpdatedAt: number | null = null
  for (const resource of resourceRows) {
    const state = knownState(resource.state, resourceStates)
    resourcesByState[state] += resource.count
    if (state === "removed") removedUpdatedAt = safeTimestamp(resource.last_updated_at)
  }
  const resourceCount = Object.values(resourcesByState).reduce((sum, count) => sum + count, 0)
  const operationCleanupState = knownState(operation.cleanupState, retainedCleanupStates)
  const cleanupCompletedAt =
    tables.resources &&
    operationCleanupState === "complete" &&
    resourceCount > 0 &&
    resourcesByState.removed === resourceCount
      ? removedUpdatedAt
      : null

  const checks = checkRows.slice(0, 200).map((check): RetainedCheckProjection => {
    const phase = check.phase === "task" ? check.phase : null
    const expectedArtifact = phase === "task" ? operation.artifact : null
    const binding =
      phase === null
        ? "unknown"
        : expectedArtifact !== null && check.artifact === expectedArtifact
          ? "matched"
          : "mismatched"
    const rowState = knownState(check.state, ["intended", "completed", "uncertain"] as const)
    const receiptValue = check.receipt_too_large ? undefined : jsonValue(check.receipt)
    const receipt =
      receiptValue && typeof receiptValue === "object" && !Array.isArray(receiptValue)
        ? (receiptValue as Record<string, unknown>)
        : undefined
    const receiptMatches =
      binding === "matched" &&
      receipt !== undefined &&
      receipt.id === check.check_id &&
      receipt.artifact === expectedArtifact &&
      receipt.inputIdentity === expectedArtifact &&
      receipt.environmentIdentity === check.environment_identity
    const checkID = /^[a-z][a-z0-9-]{0,63}$/.test(check.check_id) ? check.check_id : "unknown"
    const receiptStatus =
      check.receipt === null && !check.receipt_too_large
        ? "not-recorded"
        : receiptMatches
          ? "recorded"
          : "unusable"
    const receiptStartedAt = receiptMatches ? safeTimestamp(receipt.startedAt) : null
    const receiptEndedAt = receiptMatches ? safeTimestamp(receipt.endedAt) : null
    const validTiming =
      receiptStartedAt !== null && receiptEndedAt !== null && receiptEndedAt >= receiptStartedAt
    const exitCode =
      receiptMatches &&
      (receipt.exitCode === null ||
        (typeof receipt.exitCode === "number" && Number.isSafeInteger(receipt.exitCode)))
        ? (receipt.exitCode as number | null)
        : null
    const timedOut =
      receiptMatches && typeof receipt.timedOut === "boolean" ? receipt.timedOut : null
    const aborted = receiptMatches && typeof receipt.aborted === "boolean" ? receipt.aborted : null
    const phasesComplete =
      receiptMatches && typeof receipt.phasesComplete === "boolean" ? receipt.phasesComplete : null
    const stopCause =
      receiptMatches &&
      (receipt.stopCause === "inactivity" ||
        receipt.stopCause === "hard-backstop" ||
        receipt.stopCause === "cancelled")
        ? receipt.stopCause
        : null
    const deadlineValue =
      receiptMatches && isRecord(receipt.verificationDeadline)
        ? receipt.verificationDeadline
        : undefined
    const effectiveHardTimeoutMs =
      safePositiveInteger(deadlineValue?.effectiveHardTimeoutMs) ??
      safePositiveInteger(deadlineValue?.effectiveTimeoutMs)
    const provenance = (value: unknown): RetainedTimingProvenance =>
      value === "project-default" || value === "per-check" || value === "amendment"
        ? value
        : deadlineValue?.timingPolicyVersion === undefined
          ? "legacy"
          : "unknown"
    const verificationDeadline =
      deadlineValue && effectiveHardTimeoutMs !== null
        ? {
            timingPolicyVersion: safePositiveInteger(deadlineValue.timingPolicyVersion),
            authoredTimeoutMs: safeNullablePositiveInteger(deadlineValue.authoredTimeoutMs),
            authoredInactivityTimeoutMs: safeNullablePositiveInteger(
              deadlineValue.authoredInactivityTimeoutMs,
            ),
            authoredHardTimeoutMs: safeNullablePositiveInteger(deadlineValue.authoredHardTimeoutMs),
            defaultInactivityTimeoutMs: safePositiveInteger(
              deadlineValue.defaultInactivityTimeoutMs,
            ),
            defaultHardTimeoutMs: safePositiveInteger(deadlineValue.defaultHardTimeoutMs),
            effectiveInactivityTimeoutMs: safePositiveInteger(
              deadlineValue.effectiveInactivityTimeoutMs,
            ),
            effectiveHardTimeoutMs,
            effectiveTimeoutMs: effectiveHardTimeoutMs,
            amendmentID:
              deadlineValue.amendmentID === null || typeof deadlineValue.amendmentID === "string"
                ? deadlineValue.amendmentID
                : null,
            policyRevision: safeTimestamp(deadlineValue.policyRevision),
            inactivityProvenance: provenance(deadlineValue.inactivityProvenance),
            hardTimeoutProvenance: provenance(deadlineValue.hardTimeoutProvenance),
            historicalAmendmentIDs: Array.isArray(deadlineValue.historicalAmendmentIDs)
              ? deadlineValue.historicalAmendmentIDs.filter(
                  (id): id is string => typeof id === "string" && id.length <= 64,
                )
              : [],
          }
        : null
    const resultStatus =
      rowState !== "completed" || !receiptMatches
        ? "unknown"
        : timedOut === true ||
            aborted === true ||
            phasesComplete === false ||
            (exitCode !== null && exitCode !== 0)
          ? "failed"
          : timedOut === false && exitCode === 0
            ? "passed"
            : "unknown"
    const recordedRuns =
      phase !== null && tables.receipts
        ? retainedVerificationCheckReceipts(db, operation.id, phase, check.check_id)
        : []
    const receiptHistoryCount =
      phase !== null && tables.receipts
        ? retainedVerificationCheckReceiptCount(db, operation.id, phase, check.check_id)
        : 0
    const receiptHistoryEntries = recordedRuns.slice(0, 100).map((run) => {
      const historicalCheck = jsonValue(run.checkJSON)
      const historicalValue = jsonValue(run.receipt)
      const historicalReceipt = isRecord(historicalValue) ? historicalValue : undefined
      const receiptBound =
        run.state === "completed" &&
        isRecord(historicalCheck) &&
        historicalCheck.id === check.check_id &&
        typeof historicalCheck.command === "string" &&
        historicalReceipt?.id === check.check_id &&
        historicalReceipt.command === historicalCheck.command &&
        historicalReceipt.cwd === run.workspace &&
        historicalReceipt.artifact === expectedArtifact &&
        run.artifact === expectedArtifact &&
        historicalReceipt.inputIdentity === expectedArtifact &&
        historicalReceipt.environmentIdentity === run.environmentIdentity
      const historicalExitCode =
        receiptBound &&
        (historicalReceipt.exitCode === null ||
          (typeof historicalReceipt.exitCode === "number" &&
            Number.isSafeInteger(historicalReceipt.exitCode)))
          ? (historicalReceipt.exitCode as number | null)
          : null
      const historicalTimedOut =
        receiptBound && typeof historicalReceipt.timedOut === "boolean"
          ? historicalReceipt.timedOut
          : null
      const historicalAborted =
        receiptBound && typeof historicalReceipt.aborted === "boolean"
          ? historicalReceipt.aborted
          : null
      const historicalPhasesComplete =
        receiptBound && typeof historicalReceipt.phasesComplete === "boolean"
          ? historicalReceipt.phasesComplete
          : null
      const historicalStatus = !receiptBound
        ? "unknown"
        : historicalTimedOut === true ||
            historicalAborted === true ||
            historicalPhasesComplete === false ||
            (historicalExitCode !== null && historicalExitCode !== 0)
          ? "failed"
          : historicalTimedOut === false && historicalExitCode === 0
            ? "passed"
            : "unknown"
      return {
        receiptID: fingerprint(run.receiptPath),
        current: run.receiptPath === check.receipt_path,
        status: historicalStatus,
        exitCode: historicalExitCode,
        timedOut: historicalTimedOut,
        aborted: historicalAborted,
        endedAt: receiptBound ? safeTimestamp(historicalReceipt.endedAt) : null,
      } satisfies RetainedCheckProjection["receiptHistory"]["entries"][number]
    })
    const outputTruncated =
      receiptMatches &&
      [receipt.stdout, receipt.stderr].some(
        (value) =>
          typeof value === "string" &&
          (value.includes("[output truncated]") ||
            /\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/.test(value)),
      )
    return {
      phase,
      binding,
      checkID,
      state: rowState,
      candidateArtifact: binding === "matched" ? expectedArtifact : null,
      inputFingerprint: safeHash(check.input_fingerprint),
      environmentFingerprint:
        typeof check.environment_identity === "string" && check.environment_identity.length <= 4096
          ? fingerprint(check.environment_identity)
          : null,
      reservedAt: safeTimestamp(check.created_at),
      receipt: receiptStatus,
      receiptHistory: {
        available: tables.receipts,
        count: receiptHistoryCount,
        truncated: receiptHistoryCount > 100,
        entries: receiptHistoryEntries,
      },
      evidenceReference: `retained-verification:${operation.id}:${phase ?? "unknown"}:${checkID}`,
      result: {
        status: resultStatus,
        exitCode,
        timedOut,
        aborted,
        phasesComplete,
        stopCause,
        startedAt: validTiming ? receiptStartedAt : null,
        endedAt: validTiming ? receiptEndedAt : null,
        durationMs: validTiming ? receiptEndedAt! - receiptStartedAt! : null,
        output: !receiptMatches ? "not-recorded" : outputTruncated ? "truncated" : "recorded",
      },
      verificationDeadline,
      cleanupState: knownState(check.cleanup_state, retainedCleanupStates),
    }
  })

  const state = knownState(operation.state, retainedStates)
  return {
    recordStatus: "recorded",
    operationID: operation.id,
    planID: operation.planID,
    taskID: operation.taskID,
    taskRevision: operation.taskRevision,
    planRevision: operation.planRevision,
    attemptID: operation.attemptID,
    candidateArtifact: operation.artifact,
    state,
    reason: stateReason(state),
    environmentFingerprint:
      typeof operation.environmentIdentity === "string" &&
      operation.environmentIdentity.length <= 4096
        ? fingerprint(operation.environmentIdentity)
        : null,
    timestamps: {
      createdAt: safeTimestamp(operation.createdAt),
      updatedAt: safeTimestamp(operation.updatedAt),
    },
    checksAvailable: tables.checks,
    checks,
    checksTruncated,
    cleanup: {
      state: operationCleanupState,
      workspaceStates: {
        task:
          operation.taskWorkspaceState === null
            ? null
            : knownState(operation.taskWorkspaceState, retainedWorkspaceStates),
      },
      resourcesAvailable: tables.resources,
      resourcesByState,
      completedAt: cleanupCompletedAt,
    },
  }
}

/**
 * Read the latest retained-verification call per selected task. This path never
 * creates optional tables or reads receipt, command, workspace, resource-path,
 * or environment contents into its output.
 */
export function retainedVerificationsForInspection(
  db: Database,
  projectDirectory: string,
  planID: string,
  requestedTaskIDs?: string[],
): RetainedVerificationInspection {
  const plan = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM runner_plans WHERE id=? AND project_directory=?",
    )
    .get(planID, projectDirectory)
  if (!plan) throw new Error("Plan not found")
  const planTaskIDs = db
    .query<{ task_id: string }, [string]>(
      "SELECT task_id FROM runner_nodes WHERE plan_id=? ORDER BY task_id",
    )
    .all(planID)
    .map((row) => row.task_id)
  const selected = requestedTaskIDs ?? planTaskIDs
  if (
    selected.length < 1 ||
    selected.length > 100 ||
    new Set(selected).size !== selected.length ||
    selected.some((taskID) => !planTaskIDs.includes(taskID))
  )
    throw new Error("Retained-verification task selection must belong to this plan")
  const taskIDs = [...selected].sort()
  const operationsAvailable = tablePresent(db, "runner_retained_verifications")
  const tables = {
    checks: tablePresent(db, "runner_retained_verification_checks"),
    receipts: tablePresent(db, "runner_retained_verification_check_receipts"),
    resources: tablePresent(db, "runner_retained_verification_resources"),
  }
  const availability = {
    operations: operationsAvailable,
    checks: tables.checks,
    receipts: tables.receipts,
    resources: tables.resources,
  }
  if (!operationsAvailable)
    return { status: "unavailable", planID, taskIDs, availability, latest: [] }
  const latest = taskIDs.flatMap((taskID) => {
    const row = db
      .query<InspectionOperationRow, [string, string, string]>(
        `SELECT id,task_id,
           CASE WHEN length(payload)<=65536 THEN payload ELSE NULL END AS payload,
           (length(payload)>65536) AS payload_too_large
         FROM runner_retained_verifications
         WHERE project_directory=? AND plan_id=? AND task_id=? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(projectDirectory, planID, taskID)
    return row ? [operationProjection(db, row, planID, projectDirectory, tables)] : []
  })
  return {
    status: tables.checks && tables.receipts && tables.resources ? "available" : "partial",
    planID,
    taskIDs,
    availability,
    latest,
  }
}

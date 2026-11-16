import { lifecycleTransition, registerLifecycleTransitions } from "../lifecycle-machines.ts"
import type { Database } from "bun:sqlite"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { fingerprint } from "../../identity.ts"
import { z } from "zod"
import { RetainedVerificationSchema } from "./schema.ts"
import type {
  RetainedVerification,
  RetainedVerificationCheck,
  RetainedVerificationEvidence,
} from "./schema.ts"

const RetainedVerificationCursorPosition = z.strictObject({
  taskID: z.uuid(),
  generation: z.int().positive().max(Number.MAX_SAFE_INTEGER),
})
const RetainedVerificationCursor = z.strictObject({
  version: z.literal(2),
  planID: z.uuid(),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  taskIDs: z.array(z.uuid()).min(1).max(100),
  watermark: z.array(z.int().min(0).max(Number.MAX_SAFE_INTEGER)).min(1).max(100),
  after: RetainedVerificationCursorPosition,
  capture: z.string().regex(/^[a-f0-9]{64}$/),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
})

export type RetainedHumanEvidenceRequirements = ReadonlyMap<
  string,
  {
    planRevision: number
    planVersion: number
    taskRevision: number
    taskAssertionIDs: string[] | null
    combinedAssertionIDs: string[] | null
  }
>

type RetainedCheckProjection = {
  phase: "task" | "combined" | null
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
  generation: number | null
  taskID: string | null
  taskRevision: number | null
  planRevision: number | null
  planVersion: number | null
  attemptID: string | null
  candidateArtifact: string | null
  combinedArtifact: string | null
  state: RetainedVerification["state"] | "unknown"
  reason: string
  inputFingerprint: string | null
  combinedInputFingerprint: string | null
  environmentFingerprint: string | null
  timestamps: { createdAt: number | null; updatedAt: number | null }
  checksAvailable: boolean
  checks: RetainedCheckProjection[]
  checksTruncated: boolean
  humanEvidence: {
    status: "not-applicable" | "known" | "unavailable" | "not-inspected"
    phase: "task" | "combined" | null
    missingAssertionIDs: string[]
  }
  cleanup: {
    state: RetainedVerification["cleanupState"] | "unknown"
    workspaceStates: {
      task: "reserved" | "owned" | "uncertain" | "removed" | "unknown" | null
      combined: "reserved" | "owned" | "uncertain" | "removed" | "unknown" | null
    }
    resourcesAvailable: boolean
    resourcesByState: Record<"creating" | "active" | "uncertain" | "removed" | "unknown", number>
    completedAt: number | null
  }
}

export type RetainedVerificationInspection = {
  mode: "retained-verifications"
  status: "available" | "partial" | "unavailable"
  planID: string
  taskIDs: string[]
  capturedGenerationWatermark: Array<{ taskID: string; generation: number }> | null
  availability: {
    operations: boolean
    checks: boolean
    receipts: boolean
    resources: boolean
    humanEvidence: boolean
  }
  latest: RetainedVerificationProjection[]
  history: {
    limit: number
    returned: number
    hasMore: boolean
    nextCursor: string | null
    concurrentChanges: "selected-retained-history-changes-invalidate-cursor"
    records: RetainedVerificationProjection[]
  }
}

export function ensureRetainedVerificationTables(db: Database): void {
  registerLifecycleTransitions(db)
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
      "SELECT payload FROM runner_retained_verifications WHERE project_directory=? AND plan_id=? ORDER BY generation",
    )
    .all(projectDirectory, planID)
    .map((row) => RetainedVerificationSchema.parse(JSON.parse(row.payload)))
}

export function retainedVerificationsForProject(
  db: Database,
  projectDirectory: string,
): RetainedVerification[] {
  ensureRetainedVerificationTables(db)
  return db
    .query<{ payload: string }, [string]>(
      "SELECT payload FROM runner_retained_verifications WHERE project_directory=? ORDER BY plan_id,task_id,generation",
    )
    .all(projectDirectory)
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

function validateRetainedLifecycles(previous: RetainedVerification, next: RetainedVerification) {
  lifecycleTransition("cleanup", previous.cleanupState, next.cleanupState)
  for (const field of ["taskWorkspaceState", "combinedWorkspaceState"] as const)
    lifecycleTransition("workspace", previous[field] ?? "unallocated", next[field] ?? "unallocated")
}

export function updateRetainedVerification(
  db: Database,
  operation: RetainedVerification,
  expectedStates: readonly RetainedVerification["state"][],
): boolean {
  ensureRetainedVerificationTables(db)
  const current = retainedVerification(db, operation.id)
  if (!current || current.generation !== operation.generation) return false
  if (!expectedStates.includes(current.state)) return false
  validateRetainedLifecycles(current, operation)
  const states = expectedStates.map(() => "?").join(",")
  const changed = db
    .query(
      `UPDATE runner_retained_verifications SET state=lz_runner_transition('retained',state,?),payload=?
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

export function retainedVerificationCheckReceipts(
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

export function retainedVerificationCheckReceiptCount(
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
    generation: number
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
    allowUnchangedCheck?: boolean
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
    if (current.state === "retry-authorized") {
      const operation = retainedVerification(db, input.operationID)
      const eligibleOperationState = input.phase === "task" ? "task-checks" : "combined-checks"
      if (
        !operation ||
        operation.generation !== input.generation ||
        operation.state !== eligibleOperationState
      )
        throw new Error("Retained retry authorization operation is no longer eligible")
      let priorCheck: unknown
      try {
        priorCheck = JSON.parse(current.checkJSON) as unknown
      } catch {
        throw new Error("Retained retry authorization has an unreadable prior check binding")
      }
      if (
        current.cleanupState !== "complete" ||
        current.workspace !== input.workspace ||
        current.artifact !== input.artifact ||
        current.receipt === null ||
        (fingerprint(priorCheck) === fingerprint(input.check) && !input.allowUnchangedCheck) ||
        !isRecord(priorCheck) ||
        !isRecord(input.check) ||
        priorCheck.id !== input.check.id ||
        priorCheck.command !== input.check.command ||
        current.receiptPath === input.receiptPath
      )
        throw new Error("Retained retry no longer matches its explicitly authorized check")
      const changed = db
        .query(
          `UPDATE runner_retained_verification_checks
           SET state=lz_runner_transition('check',state,'intended'),check_json=?,input_fingerprint=?,
                environment_identity=?,receipt_path=?,receipt=NULL,context_path=?,
                cleanup_state=lz_runner_transition('cleanup',cleanup_state,'pending'),created_at=?
            WHERE operation_id=? AND phase=? AND check_id=? AND state='retry-authorized'
              AND EXISTS (
                SELECT 1 FROM runner_retained_verifications
                WHERE id=? AND generation=? AND state=?
              )`,
        )
        .run(
          JSON.stringify(input.check),
          input.inputFingerprint,
          input.environmentIdentity,
          input.receiptPath,
          input.contextPath,
          input.createdAt,
          input.operationID,
          input.phase,
          input.checkID,
          input.operationID,
          input.generation,
          eligibleOperationState,
        ).changes
      if (changed !== 1) throw new Error("Retained retry authorization changed before check setup")
      return retainedVerificationChecks(db, input.operationID, input.phase).find(
        (check) => check.checkID === input.checkID,
      )!
    }
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

export function authorizeRetainedVerificationCheckRetry(
  db: Database,
  input: {
    operationID: string
    phase: "task" | "combined"
    checkID: string
    receiptFingerprint: string
  },
): RetainedVerificationCheck {
  const current = retainedVerificationChecks(db, input.operationID, input.phase).find(
    (check) => check.checkID === input.checkID,
  )
  if (
    !current ||
    current.state !== "completed" ||
    current.receipt === null ||
    fingerprint(current.receipt) !== input.receiptFingerprint ||
    current.cleanupState !== "complete"
  )
    throw new Error("Retained check changed before retry authorization")
  const changed = db
    .query(
      `UPDATE runner_retained_verification_checks
       SET state=lz_runner_transition('check',state,'retry-authorized')
       WHERE operation_id=? AND phase=? AND check_id=? AND state='completed' AND receipt=?`,
    )
    .run(input.operationID, input.phase, input.checkID, current.receipt).changes
  if (changed !== 1) throw new Error("Retained check retry authorization lost its receipt fence")
  return retainedVerificationChecks(db, input.operationID, input.phase).find(
    (check) => check.checkID === input.checkID,
  )!
}

/** Revoke a check retry authorization only while its original completed receipt is still current. */
export function cancelRetainedVerificationCheckRetry(
  db: Database,
  operationID: string,
  phase: "task" | "combined",
  checkID: string,
  receiptFingerprint: string,
): boolean {
  ensureRetainedVerificationTables(db)
  const current = retainedVerificationChecks(db, operationID, phase).find(
    (check) => check.checkID === checkID,
  )
  if (
    !current ||
    current.state !== "retry-authorized" ||
    !current.receipt ||
    current.cleanupState !== "complete" ||
    fingerprint(current.receipt) !== receiptFingerprint
  )
    return false
  const unresolvedResources =
    db
      .query<{ count: number }, [string, string, string]>(
        `SELECT COUNT(*) AS count FROM runner_retained_verification_resources
         WHERE operation_id=? AND phase=? AND check_id=? AND state<>'removed'`,
      )
      .get(operationID, phase, checkID)?.count ?? 0
  if (unresolvedResources !== 0) return false
  return (
    db
      .query(
        `UPDATE runner_retained_verification_checks
         SET state=lz_runner_transition('check',state,'completed')
         WHERE operation_id=? AND phase=? AND check_id=? AND state='retry-authorized'
           AND receipt=? AND cleanup_state='complete'`,
      )
      .run(operationID, phase, checkID, current.receipt).changes === 1
  )
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
  const previous = retainedVerification(db, parsed.id)
  if (!previous || previous.generation !== parsed.generation)
    throw new Error("Retained verification generation is no longer current")
  validateRetainedLifecycles(previous, parsed)
  const changed = db
    .query(
      `UPDATE runner_retained_verifications SET state=lz_runner_transition('retained',state,?),payload=?
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

type InspectionOperationRow = {
  id: string
  task_id: string
  generation: number
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

const retainedStates = [
  "pending",
  "task-checks",
  "combined-checks",
  "waiting-human",
  "waiting-human-combined",
  "task-accepted",
  "accepted",
  "failed",
  "held",
  "cancelled",
] as const
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

function retainedCursorScope(projectDirectory: string, planID: string, taskIDs: string[]) {
  return fingerprint({ projectDirectory, planID, taskIDs })
}

const maxRetainedCaptureRows = 20_000

function appendRetainedCaptureRows(
  hash: ReturnType<typeof createHash>,
  label: string,
  rows: Iterable<unknown>,
  count: { value: number },
  validate?: (row: unknown) => void,
): void {
  hash.update(`${label}\n`)
  let rowsRead = 0
  for (const row of rows) {
    rowsRead++
    count.value++
    if (count.value > maxRetainedCaptureRows)
      throw new Error(
        "Selected retained-verification history is too large to capture; narrow the task selection and restart without the cursor",
      )
    validate?.(row)
    hash.update(JSON.stringify(row) ?? "undefined").update("\n")
  }
  hash.update(`rows:${rowsRead}\n`)
}

function retainedRequirementsCapture(
  taskIDs: string[],
  requirements: RetainedHumanEvidenceRequirements,
) {
  return taskIDs.map((taskID) => {
    const requirement = requirements.get(taskID)
    const assertionIDs = (ids: string[] | null | undefined) =>
      ids === null || ids === undefined
        ? null
        : [...new Set(ids.filter((id) => /^[a-z][a-z0-9-]{0,63}$/.test(id)))].sort()
    return [
      taskID,
      requirement?.planRevision ?? null,
      requirement?.planVersion ?? null,
      requirement?.taskRevision ?? null,
      assertionIDs(requirement?.taskAssertionIDs),
      assertionIDs(requirement?.combinedAssertionIDs),
    ]
  })
}

/** Hash only selected retained facts; unrelated runner telemetry is not a page fence. */
function retainedHistoryCapture(
  db: Database,
  projectDirectory: string,
  planID: string,
  taskIDs: string[],
  watermark: number[],
  tables: { checks: boolean; receipts: boolean; resources: boolean; evidence: boolean },
  requirements: RetainedHumanEvidenceRequirements,
): string {
  const hash = createHash("sha256")
  const count = { value: 0 }
  const currentWatermark = taskIDs.map((taskID) => {
    const current = db
      .query<{ generation: number | null }, [string, string, string]>(
        `SELECT MAX(generation) AS generation FROM runner_retained_verifications
         WHERE project_directory=? AND plan_id=? AND task_id=?`,
      )
      .get(projectDirectory, planID, taskID)
    return current?.generation ?? 0
  })
  hash
    .update(
      JSON.stringify({
        planID,
        taskIDs,
        watermark,
        currentWatermark,
        tables,
        requirements: retainedRequirementsCapture(taskIDs, requirements),
      }),
    )
    .update("\n")

  for (let index = 0; index < taskIDs.length; index++) {
    const taskID = taskIDs[index]!
    const generation = watermark[index]!
    appendRetainedCaptureRows(
      hash,
      `operation:${taskID}`,
      db
        .query<Record<string, unknown>, [string, string, string, number]>(
          `SELECT id,task_id,generation,
             CASE WHEN length(state)<=32 THEN state ELSE NULL END AS state,
             (length(state)>32) AS state_too_large,
             CASE WHEN length(payload)<=65536 THEN payload ELSE NULL END AS payload,
             (length(payload)>65536) AS payload_too_large
           FROM runner_retained_verifications
           WHERE project_directory=? AND plan_id=? AND task_id=? AND generation<=?
           ORDER BY generation`,
        )
        .iterate(projectDirectory, planID, taskID, generation),
      count,
      (row) => {
        if (
          typeof row === "object" &&
          row !== null &&
          "state_too_large" in row &&
          row.state_too_large === 1
        )
          throw new Error(
            "Selected retained-verification history contains an oversized operation state and cannot be captured safely",
          )
      },
    )
    if (tables.checks)
      appendRetainedCaptureRows(
        hash,
        `checks:${taskID}`,
        db
          .query<Record<string, unknown>, [string, string, string, number]>(
            `SELECT operations.generation,
               CASE WHEN length(checks.phase)<=16 THEN checks.phase ELSE '' END AS phase,
               CASE WHEN length(checks.check_id)<=64 THEN checks.check_id ELSE '' END AS check_id,
               CASE WHEN length(checks.artifact)<=64 THEN checks.artifact ELSE '' END AS artifact,
               CASE WHEN length(checks.input_fingerprint)<=128 THEN checks.input_fingerprint ELSE '' END AS input_fingerprint,
               CASE WHEN length(checks.environment_identity)<=4096 THEN checks.environment_identity ELSE '' END AS environment_identity,
               CASE WHEN length(checks.state)<=32 THEN checks.state ELSE '' END AS state,
               CASE WHEN checks.receipt IS NULL OR length(checks.receipt)<=100000 THEN checks.receipt ELSE NULL END AS receipt,
               (checks.receipt IS NOT NULL AND length(checks.receipt)>100000) AS receipt_too_large,
               CASE WHEN length(checks.cleanup_state)<=32 THEN checks.cleanup_state ELSE '' END AS cleanup_state,
               checks.created_at
             FROM runner_retained_verification_checks AS checks
             JOIN runner_retained_verifications AS operations ON operations.id=checks.operation_id
             WHERE operations.project_directory=? AND operations.plan_id=?
               AND operations.task_id=? AND operations.generation<=?
             ORDER BY operations.generation,checks.created_at DESC,checks.phase,checks.check_id`,
          )
          .iterate(projectDirectory, planID, taskID, generation),
        count,
      )
    if (tables.receipts)
      appendRetainedCaptureRows(
        hash,
        `receipts:${taskID}`,
        db
          .query<Record<string, unknown>, [string, string, string, number]>(
            `SELECT operations.generation,
               CASE WHEN length(receipts.phase)<=16 THEN receipts.phase ELSE '' END AS phase,
               CASE WHEN length(receipts.check_id)<=64 THEN receipts.check_id ELSE '' END AS check_id,
               CASE WHEN length(receipts.receipt_path)<=4096 THEN receipts.receipt_path ELSE '' END AS receipt_path,
               CASE WHEN length(receipts.state)<=32 THEN receipts.state ELSE '' END AS state,
               CASE WHEN receipts.receipt IS NULL OR length(receipts.receipt)<=100000
                 THEN receipts.receipt ELSE NULL END AS receipt,
               (receipts.receipt IS NOT NULL AND length(receipts.receipt)>100000) AS receipt_too_large
             FROM runner_retained_verification_check_receipts AS receipts
             JOIN runner_retained_verifications AS operations ON operations.id=receipts.operation_id
             WHERE operations.project_directory=? AND operations.plan_id=?
               AND operations.task_id=? AND operations.generation<=?
             ORDER BY operations.generation,receipts.phase,receipts.check_id,receipts.created_at,receipts.receipt_path`,
          )
          .iterate(projectDirectory, planID, taskID, generation),
        count,
      )
    if (tables.resources)
      appendRetainedCaptureRows(
        hash,
        `resources:${taskID}`,
        db
          .query<Record<string, unknown>, [string, string, string, number]>(
            `SELECT operations.generation,
               CASE WHEN resources.state IN ('creating','active','uncertain','removed')
                 THEN resources.state ELSE 'unknown' END AS state,
               resources.updated_at
             FROM runner_retained_verification_resources AS resources
             JOIN runner_retained_verifications AS operations
               ON operations.id=resources.operation_id
              AND operations.project_directory=resources.project_directory
             WHERE resources.project_directory=? AND operations.plan_id=?
               AND operations.task_id=? AND operations.generation<=?
             ORDER BY operations.generation,state,resources.updated_at`,
          )
          .iterate(projectDirectory, planID, taskID, generation),
        count,
      )
    if (tables.evidence)
      appendRetainedCaptureRows(
        hash,
        `evidence:${taskID}`,
        db
          .query<Record<string, unknown>, [string, string, string, number]>(
            `SELECT DISTINCT operations.generation AS operation_generation,
               evidence.generation AS evidence_generation,
               CASE WHEN length(evidence.phase)<=16 THEN evidence.phase ELSE '' END AS phase,
               CASE WHEN evidence.task_id IS NULL OR length(evidence.task_id)<=64
                 THEN evidence.task_id ELSE NULL END AS task_id,
               CASE WHEN length(evidence.assertion_id)<=64 THEN evidence.assertion_id ELSE '' END AS assertion_id,
               CASE WHEN length(evidence.artifact)<=64 THEN evidence.artifact ELSE '' END AS artifact
             FROM runner_retained_verification_evidence AS evidence
             JOIN runner_retained_verifications AS operations ON operations.id=evidence.operation_id
             WHERE operations.project_directory=? AND operations.plan_id=?
               AND operations.task_id=? AND operations.generation<=?
             ORDER BY operations.generation,evidence.generation,evidence.phase,evidence.task_id,
               evidence.assertion_id,evidence.artifact`,
          )
          .iterate(projectDirectory, planID, taskID, generation),
        count,
      )
  }
  return hash.digest("hex")
}

function decodeRetainedCursor(cursor: string) {
  if (cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new Error("Invalid retained-verification cursor")
  let parsed: unknown
  try {
    const decoded = Buffer.from(cursor, "base64url")
    if (decoded.toString("base64url") !== cursor) throw new Error("non-canonical cursor")
    parsed = JSON.parse(decoded.toString("utf8"))
  } catch {
    throw new Error("Invalid retained-verification cursor")
  }
  const result = RetainedVerificationCursor.safeParse(parsed)
  if (!result.success) throw new Error("Invalid retained-verification cursor")
  const { checksum, ...body } = result.data
  if (fingerprint(body) !== checksum) throw new Error("Invalid retained-verification cursor")
  if (
    new Set(result.data.taskIDs).size !== result.data.taskIDs.length ||
    result.data.taskIDs.some(
      (taskID, index) => index > 0 && taskID <= result.data.taskIDs[index - 1]!,
    ) ||
    result.data.watermark.length !== result.data.taskIDs.length ||
    !result.data.taskIDs.includes(result.data.after.taskID)
  )
    throw new Error("Invalid retained-verification cursor")
  return result.data
}

function encodeRetainedCursor(input: {
  planID: string
  projectDirectory: string
  taskIDs: string[]
  watermark: number[]
  after: { taskID: string; generation: number }
  capture: string
}) {
  const body = {
    version: 2 as const,
    planID: input.planID,
    scope: retainedCursorScope(input.projectDirectory, input.planID, input.taskIDs),
    taskIDs: input.taskIDs,
    watermark: input.watermark,
    after: input.after,
    capture: input.capture,
  }
  const cursor = Buffer.from(JSON.stringify({ ...body, checksum: fingerprint(body) })).toString(
    "base64url",
  )
  if (cursor.length > 8192) throw new Error("Retained-verification selection is too large to page")
  return cursor
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
    case "combined-checks":
      return "Combined verification checks are in progress under runtime control."
    case "waiting-human":
      return "Task acceptance is waiting for required human evidence."
    case "waiting-human-combined":
      return "Combined acceptance is waiting for required human evidence."
    case "task-accepted":
      return "Task checks and task acceptance passed; combined verification may remain."
    case "accepted":
      return "Retained verification was accepted; resource cleanup is reported separately."
    case "failed":
      return "Retained verification did not pass."
    case "held":
      return "Runtime retained a hold; the private hold reason is not included."
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
    operation.taskID === row.task_id &&
    operation.generation === row.generation
    ? operation
    : undefined
}

function emptyProjection(
  row: InspectionOperationRow,
  planID: string,
  checksAvailable: boolean,
  resourcesAvailable: boolean,
  isLatest: boolean,
): RetainedVerificationProjection {
  const safeID = z.uuid().safeParse(row.id)
  const safeTask = z.uuid().safeParse(row.task_id)
  return {
    recordStatus: "unavailable",
    operationID: safeID.success ? safeID.data : null,
    planID,
    generation: Number.isSafeInteger(row.generation) && row.generation > 0 ? row.generation : null,
    taskID: safeTask.success ? safeTask.data : null,
    taskRevision: null,
    planRevision: null,
    planVersion: null,
    attemptID: null,
    candidateArtifact: null,
    combinedArtifact: null,
    state: "unknown",
    reason: stateReason("unknown"),
    inputFingerprint: null,
    combinedInputFingerprint: null,
    environmentFingerprint: null,
    timestamps: { createdAt: null, updatedAt: null },
    checksAvailable,
    checks: [],
    checksTruncated: false,
    humanEvidence: {
      status: isLatest ? "unavailable" : "not-inspected",
      phase: null,
      missingAssertionIDs: [],
    },
    cleanup: {
      state: "unknown",
      workspaceStates: { task: "unknown", combined: "unknown" },
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
  tables: { checks: boolean; receipts: boolean; resources: boolean; evidence: boolean },
  isLatest: boolean,
  requirements: RetainedHumanEvidenceRequirements,
): RetainedVerificationProjection {
  const operation = operationPayload(row, planID, projectDirectory)
  if (!operation) return emptyProjection(row, planID, tables.checks, tables.resources, isLatest)

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
    const phase = check.phase === "task" || check.phase === "combined" ? check.phase : null
    const expectedArtifact =
      phase === "task"
        ? operation.artifact
        : phase === "combined"
          ? operation.combinedArtifact
          : null
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
        (value) => typeof value === "string" && value.includes("[output truncated]"),
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
      evidenceReference: `retained-verification:${operation.id}:${operation.generation}:${phase ?? "unknown"}:${checkID}`,
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
  let humanEvidence: RetainedVerificationProjection["humanEvidence"] = {
    status: "not-applicable",
    phase: null,
    missingAssertionIDs: [],
  }
  const humanPhase =
    state === "waiting-human" ? "task" : state === "waiting-human-combined" ? "combined" : null
  if (isLatest && humanPhase) {
    const requirement = requirements.get(operation.taskID)
    const assertionIDs =
      requirement &&
      requirement.planRevision === operation.planRevision &&
      requirement.planVersion === operation.planVersion &&
      requirement.taskRevision === operation.taskRevision
        ? humanPhase === "task"
          ? requirement.taskAssertionIDs
          : requirement.combinedAssertionIDs
        : null
    const candidateArtifact =
      humanPhase === "task" ? operation.artifact : operation.combinedArtifact
    if (!tables.evidence || assertionIDs === null || candidateArtifact === null) {
      humanEvidence = { status: "unavailable", phase: humanPhase, missingAssertionIDs: [] }
    } else {
      const uniqueIDs = [
        ...new Set(assertionIDs.filter((id) => /^[a-z][a-z0-9-]{0,63}$/.test(id))),
      ].sort()
      const taskID = humanPhase === "task" ? operation.taskID : null
      const existing = uniqueIDs.length
        ? db
            .query<
              { assertion_id: string },
              [string, number, string, string | null, string, ...string[]]
            >(
              `SELECT DISTINCT assertion_id FROM runner_retained_verification_evidence
               WHERE operation_id=? AND generation=? AND phase=? AND task_id IS ? AND artifact=?
                 AND assertion_id IN (${uniqueIDs.map(() => "?").join(",")})`,
            )
            .all(
              operation.id,
              operation.generation,
              humanPhase,
              taskID,
              candidateArtifact,
              ...uniqueIDs,
            )
            .map((row) => row.assertion_id)
        : []
      humanEvidence = {
        status: "known",
        phase: humanPhase,
        missingAssertionIDs: uniqueIDs.filter((id) => !existing.includes(id)),
      }
    }
  }

  return {
    recordStatus: "recorded",
    operationID: operation.id,
    planID: operation.planID,
    generation: operation.generation,
    taskID: operation.taskID,
    taskRevision: operation.taskRevision,
    planRevision: operation.planRevision,
    planVersion: operation.planVersion,
    attemptID: operation.attemptID,
    candidateArtifact: operation.artifact,
    combinedArtifact: operation.combinedArtifact,
    state,
    reason: stateReason(state),
    inputFingerprint: safeHash(operation.inputFingerprint),
    combinedInputFingerprint: safeHash(operation.combinedInputFingerprint),
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
    humanEvidence,
    cleanup: {
      state: operationCleanupState,
      workspaceStates: {
        task:
          operation.taskWorkspaceState === null
            ? null
            : knownState(operation.taskWorkspaceState, retainedWorkspaceStates),
        combined:
          operation.combinedWorkspaceState === null
            ? null
            : knownState(operation.combinedWorkspaceState, retainedWorkspaceStates),
      },
      resourcesAvailable: tables.resources,
      resourcesByState,
      completedAt: cleanupCompletedAt,
    },
  }
}

/**
 * Read the latest retained-verification generation per selected task and page
 * older generations. This path never creates optional tables or reads receipt,
 * command, workspace, resource-path, or environment contents into its output.
 */
export function retainedVerificationsForInspection(
  db: Database,
  projectDirectory: string,
  planID: string,
  requestedTaskIDs: string[] | undefined,
  limit: number,
  cursor?: string,
  humanRequirements: RetainedHumanEvidenceRequirements = new Map(),
): RetainedVerificationInspection {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("Use a retained-verification page limit from 1 to 20")
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
  const decodedCursor = cursor === undefined ? undefined : decodeRetainedCursor(cursor)
  if (decodedCursor && decodedCursor.planID !== planID)
    throw new Error("Retained-verification cursor does not match this plan")
  const selected = requestedTaskIDs ?? decodedCursor?.taskIDs ?? planTaskIDs
  if (
    selected.length < 1 ||
    selected.length > 100 ||
    new Set(selected).size !== selected.length ||
    selected.some((taskID) => !planTaskIDs.includes(taskID))
  )
    throw new Error("Retained-verification task selection must belong to this plan")
  const taskIDs = [...selected].sort()
  if (decodedCursor) {
    if (
      decodedCursor.scope !==
        retainedCursorScope(projectDirectory, planID, decodedCursor.taskIDs) ||
      (requestedTaskIDs !== undefined &&
        (taskIDs.length !== decodedCursor.taskIDs.length ||
          taskIDs.some((taskID, index) => taskID !== decodedCursor.taskIDs[index])))
    )
      throw new Error("Retained-verification cursor does not match this project and task selection")
    const afterIndex = decodedCursor.taskIDs.indexOf(decodedCursor.after.taskID)
    if (afterIndex < 0 || decodedCursor.after.generation >= decodedCursor.watermark[afterIndex]!)
      throw new Error("Invalid retained-verification cursor position")
  }

  const operationsAvailable = tablePresent(db, "runner_retained_verifications")
  const tables = {
    checks: tablePresent(db, "runner_retained_verification_checks"),
    receipts: tablePresent(db, "runner_retained_verification_check_receipts"),
    resources: tablePresent(db, "runner_retained_verification_resources"),
    evidence: tablePresent(db, "runner_retained_verification_evidence"),
  }
  const availability = {
    operations: operationsAvailable,
    checks: tables.checks,
    receipts: tables.receipts,
    resources: tables.resources,
    humanEvidence: tables.evidence,
  }
  if (!operationsAvailable)
    return {
      mode: "retained-verifications",
      status: "unavailable",
      planID,
      taskIDs,
      capturedGenerationWatermark: null,
      availability,
      latest: [],
      history: {
        limit,
        returned: 0,
        hasMore: false,
        nextCursor: null,
        concurrentChanges: "selected-retained-history-changes-invalidate-cursor",
        records: [],
      },
    }

  const watermark = decodedCursor
    ? decodedCursor.watermark
    : taskIDs.map((taskID) => {
        const latest = db
          .query<{ generation: number | null }, [string, string, string]>(
            `SELECT MAX(generation) AS generation FROM runner_retained_verifications
             WHERE project_directory=? AND plan_id=? AND task_id=?`,
          )
          .get(projectDirectory, planID, taskID)
        return latest?.generation ?? 0
      })
  const latestRows = taskIDs.flatMap((taskID, index) => {
    const generation = watermark[index]!
    if (!generation) return []
    const row = db
      .query<InspectionOperationRow, [string, string, string, number]>(
        `SELECT id,task_id,generation,
           CASE WHEN length(payload)<=65536 THEN payload ELSE NULL END AS payload,
           (length(payload)>65536) AS payload_too_large
         FROM runner_retained_verifications
         WHERE project_directory=? AND plan_id=? AND task_id=? AND generation=? LIMIT 1`,
      )
      .get(projectDirectory, planID, taskID, generation)
    return row ? [row] : []
  })

  const after = decodedCursor?.after
  const historyCandidates = taskIDs.flatMap((taskID, index) => {
    const generationWatermark = watermark[index]!
    if (!generationWatermark || (after && taskID < after.taskID)) return []
    const upperBound =
      after?.taskID === taskID
        ? Math.min(generationWatermark, after.generation)
        : generationWatermark
    if (upperBound <= 1) return []
    return db
      .query<InspectionOperationRow, [string, string, string, number, number]>(
        `SELECT id,task_id,generation,
           CASE WHEN length(payload)<=65536 THEN payload ELSE NULL END AS payload,
           (length(payload)>65536) AS payload_too_large
         FROM runner_retained_verifications
         WHERE project_directory=? AND plan_id=? AND task_id=? AND generation<?
         ORDER BY generation DESC LIMIT ?`,
      )
      .all(projectDirectory, planID, taskID, upperBound, limit + 1)
  })
  historyCandidates.sort(
    (left, right) =>
      (left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0) ||
      right.generation - left.generation,
  )
  const historyHasMore = historyCandidates.length > limit
  const historyRows = historyCandidates.slice(0, limit)
  const capture =
    decodedCursor || historyHasMore
      ? retainedHistoryCapture(
          db,
          projectDirectory,
          planID,
          taskIDs,
          watermark,
          tables,
          humanRequirements,
        )
      : null
  if (decodedCursor && capture !== decodedCursor.capture)
    throw new Error(
      "Selected retained-verification history changed since this capture; restart without the cursor",
    )
  const project = (row: InspectionOperationRow, isLatest: boolean) =>
    operationProjection(db, row, planID, projectDirectory, tables, isLatest, humanRequirements)
  const records = historyRows.map((row) => project(row, false))
  const last = historyRows.at(-1)
  const nextCursor =
    historyHasMore && last
      ? encodeRetainedCursor({
          planID,
          projectDirectory,
          taskIDs,
          watermark,
          after: { taskID: last.task_id, generation: last.generation },
          capture: capture!,
        })
      : null
  return {
    mode: "retained-verifications",
    status:
      tables.checks && tables.receipts && tables.resources && tables.evidence
        ? "available"
        : "partial",
    planID,
    taskIDs,
    capturedGenerationWatermark: taskIDs.map((taskID, index) => ({
      taskID,
      generation: watermark[index]!,
    })),
    availability,
    latest: latestRows.map((row) => project(row, true)),
    history: {
      limit,
      returned: records.length,
      hasMore: historyHasMore,
      nextCursor,
      concurrentChanges: "selected-retained-history-changes-invalidate-cursor",
      records,
    },
  }
}

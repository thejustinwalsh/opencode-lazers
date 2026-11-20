import type { Database } from "bun:sqlite"
import { canonical, fingerprint } from "../identity.ts"
import {
  ManagedUsageAssociationSchema,
  type ManagedUsageAssociation,
  type ManagedUsageEnrollmentInput,
} from "./contract.ts"
import type { ManagedUsageLocation } from "./native-location.ts"

export type ManagedUsageEnrollmentReceipt = {
  status: "enrolled"
  sessionID: string
  revision: number
  boundarySequence: number | null
  association: ManagedUsageAssociation
}

export type ManagedUsageEnrollmentResult =
  | ManagedUsageEnrollmentReceipt
  | {
      status: "conflict"
      reason: "request-id-reused" | "stale-revision" | "stale-boundary"
      expectedRevision: number
      currentRevision: number
    }

type EnrollmentInput = {
  db: Database
  projectDirectory: string
  request: ManagedUsageEnrollmentInput
  agent: string
  boundarySequence: number
  nativeLocation?: ManagedUsageLocation | null
  excludedAssistantMessageID?: string | null
  currentSessionRevision: (db: Database, sessionID: string) => number
  validateAssociation: (db: Database, association: ManagedUsageAssociation) => void
  incrementRevision: (db: Database, projectDirectory: string) => void
}

function associationColumns(association: ManagedUsageAssociation) {
  return association.kind === "task"
    ? { kind: association.kind, planID: association.planID, taskID: association.taskID }
    : association.kind === "plan"
      ? { kind: association.kind, planID: association.planID, taskID: null }
      : { kind: association.kind, planID: null, taskID: null }
}

function reusedRequest(
  db: Database,
  projectDirectory: string,
  request: ManagedUsageEnrollmentInput,
  requestFingerprint: string,
  currentSessionRevision: EnrollmentInput["currentSessionRevision"],
): ManagedUsageEnrollmentResult | null {
  const existing = db
    .query<{ request_fingerprint: string; receipt_json: string }, [string, string]>(
      `SELECT request_fingerprint,receipt_json FROM managed_usage_boundaries
       WHERE project_directory=? AND request_id=?`,
    )
    .get(projectDirectory, request.requestID)
  if (!existing) return null
  if (existing.request_fingerprint !== requestFingerprint)
    return {
      status: "conflict",
      reason: "request-id-reused",
      expectedRevision: request.expectedRevision,
      currentRevision: currentSessionRevision(db, request.sessionID),
    }
  return JSON.parse(existing.receipt_json) as ManagedUsageEnrollmentReceipt
}

function currentRevisionConflict(
  db: Database,
  projectDirectory: string,
  request: ManagedUsageEnrollmentInput,
  boundarySequence: number,
  currentRevision: number,
): ManagedUsageEnrollmentResult | null {
  if (request.expectedRevision !== currentRevision)
    return {
      status: "conflict",
      reason: "stale-revision",
      expectedRevision: request.expectedRevision,
      currentRevision,
    }

  const previousBoundary = db
    .query<{ boundary_sequence: number }, [string, string]>(
      `SELECT boundary_sequence FROM managed_usage_boundaries
       WHERE project_directory=? AND session_id=? ORDER BY revision DESC LIMIT 1`,
    )
    .get(projectDirectory, request.sessionID)
  if (previousBoundary && boundarySequence < previousBoundary.boundary_sequence)
    return {
      status: "conflict",
      reason: "stale-boundary",
      expectedRevision: request.expectedRevision,
      currentRevision,
    }
  return null
}

export function enrollManagedUsageBoundary(input: EnrollmentInput): ManagedUsageEnrollmentResult {
  const association = ManagedUsageAssociationSchema.parse(input.request.association)
  const requestFingerprint = fingerprint(input.request)
  const existing = reusedRequest(
    input.db,
    input.projectDirectory,
    input.request,
    requestFingerprint,
    input.currentSessionRevision,
  )
  if (existing) return existing

  const currentRevision = input.currentSessionRevision(input.db, input.request.sessionID)
  const conflict = currentRevisionConflict(
    input.db,
    input.projectDirectory,
    input.request,
    input.boundarySequence,
    currentRevision,
  )
  if (conflict) return conflict

  input.validateAssociation(input.db, association)
  if (currentRevision === Number.MAX_SAFE_INTEGER)
    throw new Error("Managed usage association revision is exhausted")
  const revision = currentRevision + 1
  const receipt: ManagedUsageEnrollmentReceipt = {
    status: "enrolled",
    sessionID: input.request.sessionID,
    revision,
    boundarySequence: input.boundarySequence < 0 ? null : input.boundarySequence,
    association,
  }
  const columns = associationColumns(association)
  input.db
    .query(
      `INSERT INTO managed_usage_boundaries(
        project_directory,session_id,revision,request_id,request_fingerprint,receipt_json,
        boundary_sequence,excluded_assistant_message_id,managed_agent,native_directory,workspace_id,
        association_kind,plan_id,task_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.projectDirectory,
      input.request.sessionID,
      revision,
      input.request.requestID,
      requestFingerprint,
      canonical(receipt),
      input.boundarySequence,
      input.excludedAssistantMessageID ?? null,
      input.agent,
      input.nativeLocation?.directory ?? null,
      input.nativeLocation?.workspaceID ?? null,
      columns.kind,
      columns.planID,
      columns.taskID,
      Date.now(),
    )
  input.incrementRevision(input.db, input.projectDirectory)
  return receipt
}

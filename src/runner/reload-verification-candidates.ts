import type { Database } from "bun:sqlite"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { checkRunProfile, type ProfileCommands } from "../projects/profile-runtime.ts"
import { profileRevisionByID } from "../projects/profile-store.ts"
import type { TaskRepository } from "../storage.ts"
import { withTestHangGuard } from "./test-hang-guard.ts"
import { recognizedVerificationPhases } from "./quality-failure.ts"
import { inspectCheckReceipt, type CheckReceiptIdentity } from "./reload-check-receipt.ts"
import { DEFAULT_VERIFICATION_HARD_TIMEOUT_MS } from "./verification-timeout.ts"

export const MAX_OPEN_VERIFICATION_CANDIDATES = 1_000
export const MAX_RECENT_TRANSITION_ROWS = 4_096
export const RECENT_EFFECT_INTENTS_SQL = `SELECT id,event,payload,created_at FROM runner_transitions
ORDER BY id DESC LIMIT ${MAX_RECENT_TRANSITION_ROWS}`

const SYNTHETIC_FALLOW_COMMAND = "lazers:fallow-audit"

export type VerificationProcessCandidate = {
  key: string
  command: string
  processCommands: readonly string[]
  workspace: string
  startedAt: number
  hardTimeoutMs: number
  rootPIDs: readonly number[]
  settled: boolean
  receiptReason?: string
}

type CheckMetadata = {
  id?: unknown
  command?: unknown
  hardTimeoutMs?: unknown
}

type CandidateReceipt = {
  databaseReceipt: string | null
  receiptPath?: string
}

type ProfileReader = Pick<TaskRepository, "read">

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function canonicalPath(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function tableExists(db: Database, name: string) {
  return Boolean(
    db
      .query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(name),
  )
}

function decodeJSON(value: string, description: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${description} contains invalid JSON`)
  }
}

function intentTimeMap(db: Database): Map<string, number> {
  const rows = db
    .query<{ id: number; event: string; payload: string; created_at: number }, []>(
      RECENT_EFFECT_INTENTS_SQL,
    )
    .all()
  const result = new Map<string, number>()
  for (const row of rows) {
    if (row.event !== "EFFECT_INTENDED") continue
    const payload = decodeJSON(row.payload, `Transition ${row.id}`)
    if (!isRecord(payload) || typeof payload.effectID !== "string") continue
    if (!Number.isSafeInteger(row.created_at) || row.created_at < 0) continue
    if (!result.has(payload.effectID)) result.set(payload.effectID, row.created_at)
  }
  return result
}

function parseCheck(value: unknown, key: string): CheckMetadata & Record<string, unknown> {
  const check = typeof value === "string" ? decodeJSON(value, `Verification ${key}`) : value
  if (
    !isRecord(check) ||
    typeof check.id !== "string" ||
    check.id.length === 0 ||
    typeof check.command !== "string" ||
    check.command.trim().length === 0
  )
    throw new Error(`Verification ${key} is missing check identity metadata`)
  return check
}

function hardTimeoutMs(check: CheckMetadata, deadline: unknown): number {
  const value = isRecord(deadline) ? deadline.effectiveHardTimeoutMs : undefined
  const authored = check.hardTimeoutMs
  const result =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : typeof authored === "number" && Number.isSafeInteger(authored) && authored > 0
        ? authored
        : DEFAULT_VERIFICATION_HARD_TIMEOUT_MS
  return result
}

function profileReader(db: Database): ProfileReader {
  return {
    read: <T>(run: (connection: Database) => T) => db.transaction(() => run(db)).deferred(),
  }
}

function pinnedProfileCommands(
  db: Database,
  revisionID: unknown,
  cache: Map<number, ProfileCommands>,
): ProfileCommands | undefined {
  if (revisionID === undefined) return undefined
  if (typeof revisionID !== "number" || !Number.isSafeInteger(revisionID) || revisionID < 1)
    throw new Error("Verification has an invalid pinned profile revision")
  const cached = cache.get(revisionID)
  if (cached) return cached
  const profile = profileRevisionByID(profileReader(db), revisionID)
  if (!profile) throw new Error(`Pinned verification profile revision ${revisionID} is unavailable`)
  const commands = checkRunProfile(profile).commands
  cache.set(revisionID, commands)
  return commands
}

function makeCandidate(input: {
  key: string
  checkValue: unknown
  workspace: unknown
  startTime: unknown
  deadline?: unknown
  profileCommands?: ProfileCommands
  receipt: CandidateReceipt
}): VerificationProcessCandidate {
  const check = parseCheck(input.checkValue, input.key)
  if (typeof input.workspace !== "string" || input.workspace.length === 0)
    throw new Error(`Verification ${input.key} is missing workspace evidence`)
  const workspace = canonicalPath(input.workspace)
  const command = check.command as string
  const phases = recognizedVerificationPhases(command, input.profileCommands)
  const synthetic = command === SYNTHETIC_FALLOW_COMMAND
  const processCommands = synthetic
    ? []
    : (phases ?? [command]).map((phase) => withTestHangGuard(phase))
  const receipt: CheckReceiptIdentity = inspectCheckReceipt({
    databaseReceipt: input.receipt.databaseReceipt,
    receiptPath: input.receipt.receiptPath,
    expected: {
      id: check.id as string,
      command,
      workspace,
      phaseCommands: phases ?? [command],
    },
  })
  const startedAt = receipt.startedAt ?? input.startTime
  if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0)
    throw new Error(`Verification ${input.key} is missing bounded start-time evidence`)
  if (receipt.state === "invalid" && receipt.reason)
    return {
      key: input.key,
      command,
      processCommands,
      workspace,
      startedAt,
      hardTimeoutMs: hardTimeoutMs(check, input.deadline),
      rootPIDs: [],
      settled: false,
      receiptReason: receipt.reason,
    }
  return {
    key: input.key,
    command,
    processCommands,
    workspace,
    startedAt,
    hardTimeoutMs: hardTimeoutMs(check, input.deadline),
    rootPIDs: receipt.rootPIDs,
    settled: receipt.settled,
    ...(receipt.reason ? { receiptReason: receipt.reason } : {}),
  }
}

function parseEffectPayload(payloadJSON: string, effectID: string) {
  const payload = decodeJSON(payloadJSON, `Verification effect ${effectID}`)
  if (!isRecord(payload)) throw new Error(`Verification effect ${effectID} has invalid payload`)
  return payload
}

function effectCandidates(db: Database): VerificationProcessCandidate[] {
  if (!tableExists(db, "runner_effects")) return []
  const rows = db
    .query<
      {
        id: string
        plan_id: string
        kind: string
        payload: string
        receipt: string | null
      },
      []
    >(
      `SELECT id,plan_id,kind,payload,receipt FROM runner_effects
       WHERE (kind LIKE 'verify:%' OR kind LIKE 'graph-verify:%' OR kind='mechanical-fix')
         AND state IN ('intended','uncertain','held')
       ORDER BY id LIMIT ${MAX_OPEN_VERIFICATION_CANDIDATES + 1}`,
    )
    .all()
  if (rows.length > MAX_OPEN_VERIFICATION_CANDIDATES)
    throw new Error("Too many open verification effects to inspect")
  if (rows.length === 0) return []
  if (!tableExists(db, "runner_transitions"))
    throw new Error("Verification effect start-time evidence is unavailable")

  const starts = intentTimeMap(db)
  const profiles = new Map<number, ProfileCommands>()
  return rows.map((row) => {
    const payload = parseEffectPayload(row.payload, row.id)
    const receiptPath = typeof payload.receiptPath === "string" ? payload.receiptPath : undefined
    return makeCandidate({
      key: row.id,
      checkValue: payload.check,
      workspace: payload.workspace,
      startTime: starts.get(row.id),
      deadline: payload.verificationDeadline,
      profileCommands: pinnedProfileCommands(db, payload.profileRevisionID, profiles),
      receipt: { databaseReceipt: row.receipt, receiptPath },
    })
  })
}

function retainedCandidates(db: Database): VerificationProcessCandidate[] {
  if (
    !tableExists(db, "runner_retained_verifications") ||
    !tableExists(db, "runner_retained_verification_checks")
  )
    return []
  const rows = db
    .query<
      {
        operation_id: string
        phase: string
        check_id: string
        check_json: string
        workspace: string
        created_at: number
        receipt_path: string
        receipt: string | null
      },
      []
    >(
      `SELECT c.operation_id,c.phase,c.check_id,c.check_json,c.workspace,c.created_at,
              c.receipt_path,c.receipt
       FROM runner_retained_verification_checks c
       JOIN runner_retained_verifications r ON r.id=c.operation_id
       WHERE r.state IN ('pending','task-checks') AND c.state IN ('intended','uncertain')
       ORDER BY c.created_at,c.operation_id,c.phase,c.check_id
       LIMIT ${MAX_OPEN_VERIFICATION_CANDIDATES + 1}`,
    )
    .all()
  if (rows.length > MAX_OPEN_VERIFICATION_CANDIDATES)
    throw new Error("Too many retained verification checks to inspect")
  return rows.map((row) =>
    makeCandidate({
      key: `retained:${row.operation_id}/${row.phase}/${row.check_id}`,
      checkValue: row.check_json,
      workspace: row.workspace,
      startTime: row.created_at,
      receipt: { databaseReceipt: row.receipt, receiptPath: row.receipt_path },
    }),
  )
}

function adoptionCandidates(db: Database): VerificationProcessCandidate[] {
  if (!tableExists(db, "runner_adoption_checks")) return []
  const rows = db
    .query<
      {
        adoption_id: string
        phase: string
        check_id: string
        check_json: string
        workspace: string
        created_at: number
        receipt_path: string
        receipt: string | null
      },
      []
    >(
      `SELECT adoption_id,phase,check_id,check_json,workspace,created_at,receipt_path,receipt
       FROM runner_adoption_checks WHERE state IN ('intended','uncertain')
       ORDER BY created_at,adoption_id,phase,check_id
       LIMIT ${MAX_OPEN_VERIFICATION_CANDIDATES + 1}`,
    )
    .all()
  if (rows.length > MAX_OPEN_VERIFICATION_CANDIDATES)
    throw new Error("Too many adoption checks to inspect")
  return rows.map((row) =>
    makeCandidate({
      key: `adoption:${row.adoption_id}/${row.phase}/${row.check_id}`,
      checkValue: row.check_json,
      workspace: row.workspace,
      startTime: row.created_at,
      receipt: { databaseReceipt: row.receipt, receiptPath: row.receipt_path },
    }),
  )
}

export function verificationProcessCandidates(db: Database): VerificationProcessCandidate[] {
  return [...effectCandidates(db), ...retainedCandidates(db), ...adoptionCandidates(db)]
}

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
import { unsettledProcessCleanupSQL } from "./reload-unsettled-cleanup.ts"
import { readKeysetPages, RELOAD_READ_PAGE_SIZE } from "./reload-pages.ts"

const SYNTHETIC_FALLOW_COMMAND = "lazers:fallow-audit"
const TERMINAL_VERIFICATION_OPERATIONS = new Set(["accepted", "failed", "cancelled"])

export type VerificationProcessCandidate = {
  key: string
  command: string
  processCommands: readonly string[]
  workspace: string
  startedAt: number
  hardTimeoutMs: number
  rootPIDs: readonly number[]
  settled: boolean
  terminal: boolean
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
type RetainedCheckCursor = readonly [string, string, string]
type IntentRow = { id: number; payload: string; created_at: number }

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

function intentTimeMap(db: Database, effectIDs: ReadonlySet<string>): Map<string, number> {
  const remaining = new Set(effectIDs)
  const result = new Map<string, number>()
  let cursor: number | undefined
  while (remaining.size > 0) {
    const page =
      cursor === undefined
        ? db
            .query<IntentRow, [number]>(
              `SELECT id,payload,created_at FROM runner_transitions
               WHERE event='EFFECT_INTENDED' ORDER BY id DESC LIMIT ?`,
            )
            .all(RELOAD_READ_PAGE_SIZE)
        : db
            .query<IntentRow, [number, number]>(
              `SELECT id,payload,created_at FROM runner_transitions
               WHERE event='EFFECT_INTENDED' AND id < ? ORDER BY id DESC LIMIT ?`,
            )
            .all(cursor, RELOAD_READ_PAGE_SIZE)
    if (page.length === 0) break
    cursor = page[page.length - 1]!.id
    for (const row of page) {
      let payload: unknown
      try {
        payload = JSON.parse(row.payload) as unknown
      } catch {
        // A malformed unrelated intent cannot identify one of the current candidates.
        continue
      }
      if (!isRecord(payload) || typeof payload.effectID !== "string") continue
      if (!remaining.has(payload.effectID)) continue
      if (!Number.isSafeInteger(row.created_at) || row.created_at < 0) continue
      result.set(payload.effectID, row.created_at)
      remaining.delete(payload.effectID)
    }
    if (page.length < RELOAD_READ_PAGE_SIZE) break
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
  terminal?: boolean
}): VerificationProcessCandidate {
  const terminal = input.terminal ?? false
  let check: CheckMetadata & Record<string, unknown>
  try {
    check = parseCheck(input.checkValue, input.key)
  } catch (error) {
    if (!terminal) throw error
    return unknownTerminalCandidate(input.key, input.startTime)
  }
  if (typeof input.workspace !== "string" || input.workspace.length === 0) {
    if (!terminal) throw new Error(`Verification ${input.key} is missing workspace evidence`)
    return unknownTerminalCandidate(input.key, input.startTime)
  }
  const workspace = canonicalPath(input.workspace)
  const command = check.command as string
  const phases = recognizedVerificationPhases(command, input.profileCommands)
  const synthetic = command === SYNTHETIC_FALLOW_COMMAND
  const processCommands = synthetic
    ? []
    : (phases ?? [command]).map((phase) => withTestHangGuard(phase))
  let receipt: CheckReceiptIdentity
  try {
    receipt = inspectCheckReceipt({
      databaseReceipt: input.receipt.databaseReceipt,
      receiptPath: input.receipt.receiptPath,
      expected: {
        id: check.id as string,
        command,
        workspace,
        phaseCommands: phases ?? [command],
      },
      fallbackToDatabaseOnFileFailure: terminal,
    })
  } catch (error) {
    if (!terminal) throw error
    receipt = inspectCheckReceipt({
      databaseReceipt: input.receipt.databaseReceipt,
      receiptPath: undefined,
      expected: {
        id: check.id as string,
        command,
        workspace,
        phaseCommands: phases ?? [command],
      },
    })
  }
  const startedAt = receipt.startedAt ?? input.startTime
  if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0) {
    if (terminal) return unknownTerminalCandidate(input.key, input.startTime)
    throw new Error(`Verification ${input.key} is missing bounded start-time evidence`)
  }
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
      terminal,
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
    terminal,
    ...(receipt.reason ? { receiptReason: receipt.reason } : {}),
  }
}

function unknownTerminalCandidate(key: string, startTime: unknown): VerificationProcessCandidate {
  return {
    key,
    command: "",
    processCommands: [],
    workspace: "",
    startedAt:
      typeof startTime === "number" && Number.isSafeInteger(startTime) && startTime >= 0
        ? startTime
        : 0,
    hardTimeoutMs: DEFAULT_VERIFICATION_HARD_TIMEOUT_MS,
    rootPIDs: [],
    settled: false,
    terminal: true,
  }
}

function parseEffectPayload(payloadJSON: string, effectID: string) {
  const payload = decodeJSON(payloadJSON, `Verification effect ${effectID}`)
  if (!isRecord(payload)) throw new Error(`Verification effect ${effectID} has invalid payload`)
  return payload
}

function effectCandidates(db: Database): VerificationProcessCandidate[] {
  if (!tableExists(db, "runner_effects")) return []
  type EffectRow = {
    id: string
    plan_id: string
    kind: string
    payload: string
    receipt: string | null
  }
  const rows = readKeysetPages<EffectRow, string>(
    (cursor, limit) => {
      const after = cursor === undefined ? "" : "AND id > ?"
      const params: (string | number)[] = cursor === undefined ? [limit] : [cursor, limit]
      return db
        .query<EffectRow, (string | number)[]>(
          `SELECT id,plan_id,kind,payload,receipt FROM runner_effects
           WHERE (kind LIKE 'verify:%' OR kind LIKE 'graph-verify:%' OR kind='mechanical-fix')
             AND state IN ('intended','uncertain','held') ${after}
           ORDER BY id LIMIT ?`,
        )
        .all(...params)
    },
    (row) => row.id,
  )
  if (rows.length === 0) return []
  if (!tableExists(db, "runner_transitions"))
    throw new Error("Verification effect start-time evidence is unavailable")

  const starts = intentTimeMap(db, new Set(rows.map((row) => row.id)))
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
  type RetainedRow = {
    operation_id: string
    operation_state: string | null
    phase: string
    check_id: string
    check_json: string
    workspace: string
    created_at: number
    receipt_path: string
    receipt: string | null
  }
  const rows = readKeysetPages<RetainedRow, RetainedCheckCursor>(
    (cursor, limit) => {
      const after = cursor === undefined ? "" : "AND (c.operation_id,c.phase,c.check_id) > (?,?,?)"
      const params: (string | number)[] =
        cursor === undefined ? [limit] : [cursor[0], cursor[1], cursor[2], limit]
      return db
        .query<RetainedRow, (string | number)[]>(
          `SELECT c.operation_id,r.state AS operation_state,c.phase,c.check_id,c.check_json,
                  c.workspace,c.created_at,c.receipt_path,c.receipt
           FROM runner_retained_verification_checks c
           LEFT JOIN runner_retained_verifications r ON r.id=c.operation_id
           WHERE (c.state IN ('intended','uncertain')
              OR (c.state='completed' AND ${unsettledProcessCleanupSQL("c.receipt", "c.check_json")}))
             ${after}
           ORDER BY c.operation_id,c.phase,c.check_id LIMIT ?`,
        )
        .all(...params)
    },
    (row) => [row.operation_id, row.phase, row.check_id],
  )
  return rows.map((row) => {
    const key = `retained:${row.operation_id}/${row.phase}/${row.check_id}`
    const terminal = TERMINAL_VERIFICATION_OPERATIONS.has(row.operation_state ?? "")
    return makeCandidate({
      key,
      checkValue: row.check_json,
      workspace: row.workspace,
      startTime: row.created_at,
      receipt: { databaseReceipt: row.receipt, receiptPath: row.receipt_path },
      terminal,
    })
  })
}

function adoptionCandidates(db: Database): VerificationProcessCandidate[] {
  if (!tableExists(db, "runner_adoption_checks")) return []
  const hasAdoptionOperations = tableExists(db, "runner_adoptions")
  type AdoptionRow = {
    adoption_id: string
    operation_state: string | null
    phase: string
    check_id: string
    check_json: string
    workspace: string
    created_at: number
    receipt_path: string
    receipt: string | null
  }
  const rows = readKeysetPages<AdoptionRow, RetainedCheckCursor>(
    (cursor, limit) => {
      const after = cursor === undefined ? "" : "AND (c.adoption_id,c.phase,c.check_id) > (?,?,?)"
      const params: (string | number)[] =
        cursor === undefined ? [limit] : [cursor[0], cursor[1], cursor[2], limit]
      return db
        .query<AdoptionRow, (string | number)[]>(
          `SELECT c.adoption_id,${hasAdoptionOperations ? "a.state" : "NULL"} AS operation_state,
                  c.phase,c.check_id,c.check_json,c.workspace,c.created_at,c.receipt_path,c.receipt
           FROM runner_adoption_checks c
           ${hasAdoptionOperations ? "LEFT JOIN runner_adoptions a ON a.id=c.adoption_id" : ""}
           WHERE (c.state IN ('intended','uncertain')
              OR (c.state='completed' AND ${unsettledProcessCleanupSQL("c.receipt", "c.check_json")}))
             ${after}
           ORDER BY c.adoption_id,c.phase,c.check_id LIMIT ?`,
        )
        .all(...params)
    },
    (row) => [row.adoption_id, row.phase, row.check_id],
  )
  return rows.map((row) => {
    const terminal = TERMINAL_VERIFICATION_OPERATIONS.has(row.operation_state ?? "")
    return makeCandidate({
      key: `adoption:${row.adoption_id}/${row.phase}/${row.check_id}`,
      checkValue: row.check_json,
      workspace: row.workspace,
      startTime: row.created_at,
      receipt: { databaseReceipt: row.receipt, receiptPath: row.receipt_path },
      terminal,
    })
  })
}

export function verificationProcessCandidates(db: Database): VerificationProcessCandidate[] {
  return [...effectCandidates(db), ...retainedCandidates(db), ...adoptionCandidates(db)]
}

import type { Database } from "bun:sqlite"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { withTestHangGuard } from "./test-hang-guard.ts"

const MAX_CANDIDATES = 1_000

export type VerificationProcessCandidate = {
  key: string
  command: string
  workspace: string
  startedAt: number
  pid?: number
}

function canonicalPath(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

function processReceipt(receipt: string | null) {
  if (!receipt) return undefined
  try {
    const envelope: unknown = JSON.parse(receipt)
    if (!isRecord(envelope)) return undefined
    const check = isRecord(envelope.check)
      ? envelope.check
      : isRecord(envelope.result) && isRecord(envelope.result.check)
        ? envelope.result.check
        : typeof envelope.startedAt === "number" && isRecord(envelope.processCleanup)
          ? envelope
          : undefined
    if (!check) return undefined
    const processCleanup = isRecord(check.processCleanup) ? check.processCleanup : undefined
    return {
      ...(typeof check.startedAt === "number" &&
      Number.isSafeInteger(check.startedAt) &&
      check.startedAt >= 0
        ? { startedAt: check.startedAt }
        : {}),
      ...(typeof processCleanup?.rootPID === "number" &&
      Number.isSafeInteger(processCleanup.rootPID) &&
      processCleanup.rootPID > 0
        ? { pid: processCleanup.rootPID }
        : {}),
    }
  } catch {
    return undefined
  }
}

function candidate(
  key: string,
  checkJSON: unknown,
  workspace: unknown,
  startedAt: unknown,
  receipt?: string | null,
): VerificationProcessCandidate {
  let check: unknown = checkJSON
  if (typeof checkJSON === "string") {
    try {
      check = JSON.parse(checkJSON) as unknown
    } catch {
      throw new Error(`Verification ${key} has invalid check metadata`)
    }
  }
  if (
    !isRecord(check) ||
    typeof check.command !== "string" ||
    check.command.trim().length === 0 ||
    typeof workspace !== "string" ||
    workspace.length === 0 ||
    typeof startedAt !== "number" ||
    !Number.isSafeInteger(startedAt) ||
    startedAt < 0
  )
    throw new Error(`Verification ${key} is missing process identity metadata`)
  const priorProcess = processReceipt(receipt ?? null)
  return {
    key,
    command: withTestHangGuard(check.command),
    workspace: canonicalPath(workspace),
    startedAt: priorProcess?.startedAt ?? startedAt,
    ...(priorProcess?.pid === undefined ? {} : { pid: priorProcess.pid }),
  }
}

function effectCandidates(db: Database): VerificationProcessCandidate[] {
  if (!tableExists(db, "runner_effects")) return []
  if (!tableExists(db, "runner_transitions"))
    throw new Error("Verification effect start times are unavailable")
  const rows = db
    .query<
      {
        id: string
        payload: string
        receipt: string | null
        intended_at: number | null
      },
      []
    >(
      `SELECT e.id,e.payload,e.receipt,
         (SELECT MIN(t.created_at) FROM runner_transitions t
           WHERE t.event='EFFECT_INTENDED' AND json_valid(t.payload)
             AND json_extract(t.payload,'$.effectID')=e.id) AS intended_at
       FROM runner_effects e
       WHERE (e.kind LIKE 'verify:%' OR e.kind LIKE 'graph-verify:%' OR e.kind='mechanical-fix')
         AND e.state IN ('intended','uncertain','held')
       ORDER BY e.id LIMIT ${MAX_CANDIDATES + 1}`,
    )
    .all()
  if (rows.length > MAX_CANDIDATES) throw new Error("Too many open verification effects to inspect")
  return rows.map((row) => {
    if (row.intended_at === null)
      throw new Error(`Verification effect ${row.id} has no recorded start time`)
    let payload: unknown
    try {
      payload = JSON.parse(row.payload) as unknown
    } catch {
      throw new Error(`Verification effect ${row.id} has invalid payload`)
    }
    if (!isRecord(payload)) throw new Error(`Verification effect ${row.id} has invalid payload`)
    return candidate(row.id, payload.check, payload.workspace, row.intended_at, row.receipt)
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
        receipt: string | null
      },
      []
    >(
      `SELECT c.operation_id,c.phase,c.check_id,c.check_json,c.workspace,c.created_at,c.receipt
       FROM runner_retained_verification_checks c
       JOIN runner_retained_verifications r ON r.id=c.operation_id
       WHERE r.state IN ('pending','task-checks') AND c.state IN ('intended','uncertain')
       ORDER BY c.created_at,c.operation_id,c.phase,c.check_id LIMIT ${MAX_CANDIDATES + 1}`,
    )
    .all()
  if (rows.length > MAX_CANDIDATES)
    throw new Error("Too many retained verification checks to inspect")
  return rows.map((row) =>
    candidate(
      `retained:${row.operation_id}/${row.phase}/${row.check_id}`,
      row.check_json,
      row.workspace,
      row.created_at,
      row.receipt,
    ),
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
        receipt: string | null
      },
      []
    >(
      `SELECT adoption_id,phase,check_id,check_json,workspace,created_at,receipt
       FROM runner_adoption_checks WHERE state IN ('intended','uncertain')
       ORDER BY created_at,adoption_id,phase,check_id LIMIT ${MAX_CANDIDATES + 1}`,
    )
    .all()
  if (rows.length > MAX_CANDIDATES) throw new Error("Too many adoption checks to inspect")
  return rows.map((row) =>
    candidate(
      `adoption:${row.adoption_id}/${row.phase}/${row.check_id}`,
      row.check_json,
      row.workspace,
      row.created_at,
      row.receipt,
    ),
  )
}

export function verificationProcessCandidates(db: Database): VerificationProcessCandidate[] {
  return [...effectCandidates(db), ...retainedCandidates(db), ...adoptionCandidates(db)]
}

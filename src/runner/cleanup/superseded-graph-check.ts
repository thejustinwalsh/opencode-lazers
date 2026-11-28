import type { EffectRow } from "../store.ts"
import { sameVerificationCheckIdentity } from "../runtime-helpers.ts"

type JsonRecord = Record<string, unknown>

type GraphCheckPayload = JsonRecord & {
  workspace: string
  artifact: string
  check: GraphCheckIdentity
}

type GraphCheckIdentity = { id: string; command: string }

/** The journal's versionless supersession envelope for rerunnable effects. */
type ReceiptlessSupersessionReceipt = {
  superseded: true
  reason: string
  previous: null
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRecord(value: string | null): JsonRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value ?? "null")
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function ownsWorkspace(payload: JsonRecord, workspace: string, artifact: string): boolean {
  return (
    payload.workspace === workspace &&
    payload.artifact === artifact &&
    (payload.identity === undefined || payload.identity === artifact)
  )
}

function graphCheckIdentity(value: unknown): GraphCheckIdentity | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.command !== "string" ||
    !value.command
  )
    return undefined
  return { id: value.id, command: value.command }
}

function isReceiptlessSupersessionReceipt(value: unknown): value is ReceiptlessSupersessionReceipt {
  return (
    isRecord(value) &&
    value.superseded === true &&
    typeof value.reason === "string" &&
    Object.hasOwn(value, "previous") &&
    value.previous === null
  )
}

function graphCheckPayload(
  effect: EffectRow,
  workspace: string,
  artifact: string,
): GraphCheckPayload | undefined {
  const payload = parseRecord(effect.payload)
  if (!payload || !ownsWorkspace(payload, workspace, artifact)) return undefined
  const check = graphCheckIdentity(payload.check)
  if (!check || effect.kind !== `graph-verify:${check.id}`) return undefined
  return { ...payload, workspace, artifact, check }
}

/** A no-receipt supersession is eligible only with a later matching settled check. */
export function isReceiptlessSupersededGraphCheck(effect: EffectRow): boolean {
  if (effect.state !== "failed" || !effect.kind.startsWith("graph-verify:")) return false
  return isReceiptlessSupersessionReceipt(parseRecord(effect.receipt))
}

/** The durable effect order establishes that this is a replacement, not an earlier run. */
export function laterMatchingGraphCheck(
  effects: EffectRow[],
  reservationIndex: number,
  workspace: string,
  artifact: string,
): EffectRow | undefined {
  const reservation = effects[reservationIndex]
  if (!reservation || !isReceiptlessSupersededGraphCheck(reservation)) return undefined
  const previous = graphCheckPayload(reservation, workspace, artifact)
  if (!previous) return undefined

  for (let index = reservationIndex + 1; index < effects.length; index++) {
    const candidate = effects[index]!
    if (candidate.state !== "completed" || candidate.kind !== reservation.kind) continue
    const replacement = graphCheckPayload(candidate, workspace, artifact)
    if (replacement && sameVerificationCheckIdentity(replacement.check, previous.check))
      return candidate
  }
  return undefined
}

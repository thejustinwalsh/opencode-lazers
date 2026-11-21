import type { AttemptRow, EffectRow } from "../runner/store.ts"
import { safeText, type PrivacyStats } from "./privacy.ts"

/** The attempt columns an event reads. */
export type EventAttempt = Pick<AttemptRow, "id" | "session_id" | "started_at">

/**
 * How the trajectory shows a runner transition, effect or verification check, as pure functions of
 * the stored rows. The trajectory read uses them at read time; the `task_events` projection
 * (`src/events/task-events-refresh.ts`) uses them at write time, so a stored row is what the read
 * shows.
 */
function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    return object(JSON.parse(text))
  } catch {
    return null
  }
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export type TransitionRow = {
  id: number
  plan_id: string
  task_id: string | null
  version: number
  event: string
  payload: string
  created_at: number
}

export type CheckView = {
  id: string
  scope: "attempt" | "plan"
  attemptID: string | null
  state: string
  result: "passed" | "failed" | "unknown"
  command: string | null
  startedAt: number | null
  endedAt: number | null
  timingBasis: string
  exitCode: number | null
  timedOut: boolean | null
  unchanged: boolean | null
  stdout: string | null
  stderr: string | null
  error: string | null
}

function checkView(
  effect: EffectRow,
  planScope: boolean,
  attemptID: string | null,
  stats: PrivacyStats,
): CheckView {
  const receipt = parseObject(effect.receipt)
  const check = object(receipt?.check)
  const error = typeof receipt?.error === "string" ? safeText(receipt.error, stats, 1000) : null
  const exitCode = asNumber(check?.exitCode)
  const timedOut = typeof check?.timedOut === "boolean" ? check.timedOut : null
  const unchanged = typeof check?.unchanged === "boolean" ? check.unchanged : null
  const result =
    effect.state !== "completed"
      ? "unknown"
      : exitCode === 0 && timedOut === false
        ? "passed"
        : exitCode !== null || timedOut === true
          ? "failed"
          : "unknown"
  return {
    id: safeText(effect.kind.replace(/^(?:graph-)?verify:/, ""), stats, 160),
    scope: planScope ? "plan" : "attempt",
    attemptID: attemptID === null ? null : safeText(attemptID, stats, 128),
    state: safeText(effect.state, stats, 80),
    result,
    command: typeof check?.command === "string" ? safeText(check.command, stats) : null,
    startedAt: asNumber(check?.startedAt),
    endedAt: asNumber(check?.endedAt),
    timingBasis:
      "Verification receipt check.startedAt/check.endedAt; absent endpoints remain unknown",
    exitCode,
    timedOut,
    unchanged,
    stdout: typeof check?.stdout === "string" ? safeText(check.stdout, stats) : null,
    stderr: typeof check?.stderr === "string" ? safeText(check.stderr, stats) : null,
    error,
  }
}

export function transitionEvent(
  row: TransitionRow,
  attempts: ReadonlyMap<string, EventAttempt>,
  stats: PrivacyStats,
) {
  const payload = parseObject(row.payload)
  const requestedAttempt = typeof payload?.attemptID === "string" ? payload.attemptID : null
  const attemptID = requestedAttempt && attempts.has(requestedAttempt) ? requestedAttempt : null
  const eventName = safeText(row.event, stats, 120)
  return {
    id: safeText(`runner-transition:${row.plan_id}:${row.id}`, stats, 256),
    at: row.created_at,
    attemptID: attemptID ? safeText(attemptID, stats, 128) : null,
    sessionID: attemptID ? safeText(attempts.get(attemptID)!.session_id, stats, 128) : null,
    kind: "runner-transition",
    event: eventName,
    version: row.version,
    ...(typeof payload?.from === "string" ? { from: safeText(payload.from, stats, 80) } : {}),
    ...(typeof payload?.to === "string" ? { to: safeText(payload.to, stats, 80) } : {}),
    ...(typeof payload?.reason === "string" ? { reason: safeText(payload.reason, stats) } : {}),
  }
}

export function effectEvents(
  effects: EffectRow[],
  attempts: ReadonlyMap<string, EventAttempt>,
  checks: CheckView[],
  stats: PrivacyStats,
) {
  const events: Record<string, unknown>[] = []
  for (const effect of effects) {
    const attempt = effect.attempt_id ? attempts.get(effect.attempt_id) : undefined
    if (effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:")) {
      const planScope = effect.kind.startsWith("graph-verify:")
      const check = checkView(effect, planScope, attempt?.id ?? null, stats)
      checks.push(check)
      events.push({
        id: safeText(`runner-check:${effect.id}`, stats, 256),
        at: check.endedAt ?? check.startedAt ?? attempt?.started_at ?? null,
        attemptID: attempt ? safeText(attempt.id, stats, 128) : null,
        sessionID: attempt ? safeText(attempt.session_id, stats, 128) : null,
        kind: "verification",
        checkID: check.id,
        status: check.result,
        state: check.state,
        ...(check.error ? { error: check.error } : {}),
      })
      continue
    }
    const receipt = parseObject(effect.receipt)
    const message = typeof receipt?.error === "string" ? safeText(receipt.error, stats, 1000) : null
    events.push({
      id: safeText(`runner-effect:${effect.id}`, stats, 256),
      at: attempt?.started_at ?? null,
      attemptID: attempt ? safeText(attempt.id, stats, 128) : null,
      sessionID: attempt ? safeText(attempt.session_id, stats, 128) : null,
      kind: "runner-effect",
      effect: safeText(effect.kind, stats, 100),
      state: safeText(effect.state, stats, 80),
      ...(message ? { error: message } : {}),
    })
  }
  return events
}

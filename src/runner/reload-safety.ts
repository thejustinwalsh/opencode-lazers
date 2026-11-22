import type { Database } from "bun:sqlite"
import { readKeysetPages } from "./reload-pages.ts"

/**
 * Whether a plugin or service reload can run without cutting work off. A location reload
 * reboots the plugin, and the native turn a worker or Architect is in the middle of ends
 * unfinished: the runtime sees `interrupted`, holds the plan and re-prompts, so the in-flight
 * step and the prompt cache are lost, and a running check is abandoned as uncertain. Reload
 * when nothing runs.
 */
export type ReloadSafety = {
  safe: boolean
  workers: number
  verifications: number
  /** Architect sessions whose newest assistant message is unfinished or active at the host. */
  architectTurns: number
  /** Takeovers still telling, waiting on or stopping their worker: a reload cuts the handoff. */
  takeovers: number
  /**
   * Tasks an Architect has taken over and is finishing (attempts on a `lazers-takeover:` session).
   * Informational: no worker runs there; the Architect's own turn is counted in `architectTurns`.
   */
  architectTakeovers: number
  /**
   * Check steps in `uncertain` or `held` (no live process: the effect machine only leaves them on
   * a decision or a retry), typically a `graph-verify:*` step of a blocked plan. Reported apart
   * from `verifications` and never makes a reload unsafe.
   */
  uncertainSteps: number
  /** "1 uncertain step on a blocked plan", or undefined when none. */
  uncertainLine: string | undefined
  /** Host-active session IDs without a matching worker attempt or active Architect turn. */
  otherHostSessions: number
  /** Running/preparing attempts whose sessions were positively observed idle or absent. */
  staleAttempts: Array<{ id: string; sessionID: string; state: string }>
  /** "Stale attempts: <attempt-id> (session <session-id>)", or undefined when none. */
  staleLine: string | undefined
  /** Terminal retained checks whose historical process identity could not be settled. */
  staleVerificationChecks: string[]
  /** "Stale verification checks: <check-key>", or undefined when none. */
  staleVerificationLine: string | undefined
  /** Explicit reasons why live activity could not be observed. */
  observationErrors: string[]
  /** "2 workers running, 1 verification running, 0 Architect turns in flight, safe to reload: no" */
  line: string
}

export type ReloadObservation =
  { kind: "observed"; sessionIDs: readonly string[] } | { kind: "unavailable"; reason: string }

export type ReloadProcessObservation =
  | { kind: "observed"; processIDs: readonly number[]; staleChecks?: readonly string[] }
  | {
      kind: "unavailable"
      reason: string
      processIDs?: readonly number[]
      staleChecks?: readonly string[]
    }

export type ReloadObservations = {
  sessions: ReloadObservation
  verifications: ReloadProcessObservation
}

/** An unfinished assistant message untouched for this long is a dead turn, not a live one. */
export const ARCHITECT_TURN_STALE_MS = 10 * 60_000

const OPEN_TAKEOVER_STATES = ["notifying", "awaiting-handoff", "stopping"]

function isMissingTable(error: unknown) {
  return error instanceof Error && /no such table:/i.test(error.message)
}

/** A missing table (an older schema, or a feature not yet installed) counts as zero. */
function count(db: Database, sql: string, ...params: (string | number)[]): number {
  try {
    return db.query<{ n: number }, (string | number)[]>(sql).get(...params)?.n ?? 0
  } catch (error) {
    if (isMissingTable(error)) return 0
    throw error
  }
}

function ids(db: Database, sql: string): string[] {
  try {
    return db
      .query<{ id: string }, []>(sql)
      .all()
      .map((row) => row.id)
  } catch (error) {
    if (isMissingTable(error)) return []
    throw error
  }
}

function workerAttempts(db: Database) {
  try {
    type AttemptRow = { id: string; session_id: string; state: string }
    return readKeysetPages<AttemptRow, string>(
      (cursor, limit) => {
        const after = cursor === undefined ? "" : "AND a.id > ?"
        const params: (string | number)[] = cursor === undefined ? [limit] : [cursor, limit]
        return db
          .query<AttemptRow, (string | number)[]>(
            `SELECT a.id,a.session_id,a.state FROM runner_attempts a
             JOIN runner_plans p ON p.id=a.plan_id
             WHERE a.state IN ('preparing','running') AND p.state NOT IN ('cancelled','integrated')
               AND a.session_id NOT LIKE 'lazers-takeover:%' ${after}
             ORDER BY a.id LIMIT ?`,
          )
          .all(...params)
      },
      (attempt) => attempt.id,
    )
  } catch (error) {
    if (isMissingTable(error)) return []
    throw error
  }
}

/**
 * Architect sessions with an unfinished assistant turn. The plugin database names the Architect
 * sessions (owners of live plans); OpenCode's own database holds the messages. The newest
 * assistant message of a session is in flight when it has no `time.completed` and was updated
 * recently.
 */
function architectTurnsInFlight(
  db: Database,
  opencode: Database | undefined,
  activeSessions: ReadonlySet<string>,
  now: number,
) {
  const owners = ids(
    db,
    `SELECT DISTINCT owner AS id FROM runner_plans
     WHERE owner IS NOT NULL AND state NOT IN ('cancelled','integrated')`,
  )
  const turns = new Set(owners.filter((owner) => activeSessions.has(owner)))
  if (owners.length > 0 && !opencode)
    return { turns, unavailable: "OpenCode message database was not available" }
  if (!opencode) return { turns }
  for (const id of owners) {
    try {
      const inFlight =
        opencode
          .query<{ n: number }, [string, number]>(
            `SELECT count(*) AS n FROM (
               SELECT data, time_updated FROM session_message
               WHERE session_id=? AND type='assistant' ORDER BY seq DESC LIMIT 1
             ) WHERE json_extract(data,'$.time.completed') IS NULL AND time_updated > ?`,
          )
          .get(id, now - ARCHITECT_TURN_STALE_MS)?.n ?? 0
      if (inFlight > 0) turns.add(id)
    } catch (error) {
      return {
        turns,
        unavailable: `OpenCode message observation failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  return { turns }
}

const unavailable = (reason: string) => `live activity observation unavailable: ${reason}`

export function reloadSafety(
  db: Database,
  opencode?: Database,
  now: number = Date.now(),
  observations?: ReloadObservations,
): ReloadSafety {
  const observed = observations ?? {
    sessions: { kind: "unavailable", reason: "host session activity was not observed" },
    verifications: {
      kind: "unavailable",
      reason: "verification process activity was not observed",
    },
  }
  const observationErrors = [
    ...(observed.sessions.kind === "unavailable" ? [unavailable(observed.sessions.reason)] : []),
    ...(observed.verifications.kind === "unavailable"
      ? [unavailable(observed.verifications.reason)]
      : []),
  ]
  const activeSessions =
    observed.sessions.kind === "observed"
      ? new Set(observed.sessions.sessionIDs)
      : new Set<string>()
  const attempts = db.transaction(() => workerAttempts(db)).deferred()
  const workers =
    observed.sessions.kind === "observed"
      ? attempts.filter((attempt) => activeSessions.has(attempt.session_id)).length
      : 0
  const staleAttempts =
    observed.sessions.kind === "observed"
      ? attempts
          .filter((attempt) => !activeSessions.has(attempt.session_id))
          .map((attempt) => ({
            id: attempt.id,
            sessionID: attempt.session_id,
            state: attempt.state,
          }))
      : []
  const staleVerificationChecks = [...new Set(observed.verifications.staleChecks ?? [])]
  const verifications = new Set(observed.verifications.processIDs ?? []).size
  const architectTakeovers = count(
    db,
    `SELECT count(*) AS n FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
     WHERE a.state IN ('preparing','running','verifying') AND p.state NOT IN ('cancelled','integrated')
       AND a.session_id LIKE 'lazers-takeover:%'`,
  )
  const uncertainSteps =
    count(
      db,
      `SELECT count(*) AS n FROM runner_effects
       WHERE (kind LIKE 'verify:%' OR kind LIKE 'graph-verify:%' OR kind='mechanical-fix')
         AND state IN ('uncertain','held')`,
    ) + count(db, `SELECT count(*) AS n FROM runner_adoption_checks WHERE state = 'uncertain'`)
  const architectObservation = architectTurnsInFlight(db, opencode, activeSessions, now)
  if (architectObservation.unavailable) observationErrors.push(architectObservation.unavailable)
  const architectTurns = architectObservation.turns.size
  const workerSessions = new Set(
    attempts
      .filter((attempt) => activeSessions.has(attempt.session_id))
      .map((attempt) => attempt.session_id),
  )
  const otherHostSessions =
    observed.sessions.kind === "observed"
      ? [...activeSessions].filter(
          (sessionID) =>
            !workerSessions.has(sessionID) && !architectObservation.turns.has(sessionID),
        ).length
      : 0
  const takeovers = count(
    db,
    `SELECT count(*) AS n FROM runner_takeovers WHERE state IN (${OPEN_TAKEOVER_STATES.map(() => "?").join(",")})`,
    ...OPEN_TAKEOVER_STATES,
  )
  const safe =
    activeSessions.size === 0 &&
    workers === 0 &&
    verifications === 0 &&
    architectTurns === 0 &&
    takeovers === 0 &&
    observationErrors.length === 0
  const noun = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const open = takeovers > 0 ? `, ${noun(takeovers, "takeover handoff")} open` : ""
  const finishing =
    architectTakeovers > 0 ? `, ${noun(architectTakeovers, "task")} taken over by an Architect` : ""
  const staleLine =
    staleAttempts.length > 0
      ? `Stale attempts: ${staleAttempts.map((attempt) => `${attempt.id} (session ${attempt.sessionID})`).join(", ")}`
      : undefined
  const staleVerificationLine =
    staleVerificationChecks.length > 0
      ? `Stale verification checks: ${staleVerificationChecks.join(", ")}`
      : undefined
  const observationLine = observationErrors.length > 0 ? `, ${observationErrors.join(", ")}` : ""
  const otherSessionsLine =
    otherHostSessions > 0 ? `, ${noun(otherHostSessions, "other host session")} active` : ""
  return {
    safe,
    workers,
    verifications,
    uncertainSteps,
    uncertainLine:
      uncertainSteps > 0
        ? `${noun(uncertainSteps, "uncertain step")} on a blocked plan`
        : undefined,
    architectTurns,
    otherHostSessions,
    takeovers,
    architectTakeovers,
    staleAttempts,
    staleLine,
    staleVerificationChecks,
    staleVerificationLine,
    observationErrors,
    line: `${noun(workers, "worker")} running, ${noun(verifications, "verification")} running, ${noun(architectTurns, "Architect turn")} in flight${open}${finishing}${otherSessionsLine}${observationLine}, safe to reload: ${safe ? "yes" : "no"}`,
  }
}

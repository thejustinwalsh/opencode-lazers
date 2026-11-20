import type { Database } from "bun:sqlite"

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
  /** Architect sessions whose newest assistant message is unfinished. */
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
  /** "2 workers running, 1 verification running, 0 Architect turns in flight, safe to reload: no" */
  line: string
}

/** An unfinished assistant message untouched for this long is a dead turn, not a live one. */
export const ARCHITECT_TURN_STALE_MS = 10 * 60_000

const OPEN_TAKEOVER_STATES = ["notifying", "awaiting-handoff", "stopping"]

/** A missing table (an older schema, or a feature not yet installed) counts as zero. */
function count(db: Database, sql: string, ...params: (string | number)[]): number {
  try {
    return db.query<{ n: number }, (string | number)[]>(sql).get(...params)?.n ?? 0
  } catch {
    return 0
  }
}

function ids(db: Database, sql: string): string[] {
  try {
    return db
      .query<{ id: string }, []>(sql)
      .all()
      .map((row) => row.id)
  } catch {
    return []
  }
}

/**
 * Architect sessions with an unfinished assistant turn. The plugin database names the Architect
 * sessions (owners of live plans); OpenCode's own database holds the messages. The newest
 * assistant message of a session is in flight when it has no `time.completed` and was updated
 * recently.
 */
function architectTurnsInFlight(db: Database, opencode: Database | undefined, now: number) {
  if (!opencode) return 0
  const owners = ids(
    db,
    `SELECT DISTINCT owner AS id FROM runner_plans
     WHERE owner IS NOT NULL AND state NOT IN ('cancelled','integrated')`,
  )
  let turns = 0
  for (const id of owners) {
    turns += count(
      opencode,
      `SELECT count(*) AS n FROM (
         SELECT data, time_updated FROM session_message
         WHERE session_id=? AND type='assistant' ORDER BY seq DESC LIMIT 1
       ) WHERE json_extract(data,'$.time.completed') IS NULL AND time_updated > ?`,
      id,
      now - ARCHITECT_TURN_STALE_MS,
    )
  }
  return turns
}

export function reloadSafety(
  db: Database,
  opencode?: Database,
  now: number = Date.now(),
): ReloadSafety {
  const workers = count(
    db,
    `SELECT count(*) AS n FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
     WHERE a.state IN ('preparing','running') AND p.state NOT IN ('cancelled','integrated')
       AND a.session_id NOT LIKE 'lazers-takeover:%'`,
  )
  const architectTakeovers = count(
    db,
    `SELECT count(*) AS n FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
     WHERE a.state IN ('preparing','running','verifying') AND p.state NOT IN ('cancelled','integrated')
       AND a.session_id LIKE 'lazers-takeover:%'`,
  )
  const verifications =
    // Task, graph, mechanical-fix and Fallow checks are all effects of these kinds.
    count(
      db,
      `SELECT count(*) AS n FROM runner_effects
       WHERE (kind LIKE 'verify:%' OR kind LIKE 'graph-verify:%' OR kind='mechanical-fix')
         AND state = 'intended'`,
    ) +
    count(
      db,
      `SELECT count(*) AS n FROM runner_retained_verifications
       WHERE state IN ('pending','task-checks')`,
    ) +
    count(db, `SELECT count(*) AS n FROM runner_adoption_checks WHERE state = 'intended'`)
  const uncertainSteps =
    count(
      db,
      `SELECT count(*) AS n FROM runner_effects
       WHERE (kind LIKE 'verify:%' OR kind LIKE 'graph-verify:%' OR kind='mechanical-fix')
         AND state IN ('uncertain','held')`,
    ) + count(db, `SELECT count(*) AS n FROM runner_adoption_checks WHERE state = 'uncertain'`)
  const architectTurns = architectTurnsInFlight(db, opencode, now)
  const takeovers = count(
    db,
    `SELECT count(*) AS n FROM runner_takeovers WHERE state IN (${OPEN_TAKEOVER_STATES.map(() => "?").join(",")})`,
    ...OPEN_TAKEOVER_STATES,
  )
  const safe = workers === 0 && verifications === 0 && architectTurns === 0 && takeovers === 0
  const noun = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const open = takeovers > 0 ? `, ${noun(takeovers, "takeover handoff")} open` : ""
  const finishing =
    architectTakeovers > 0 ? `, ${noun(architectTakeovers, "task")} taken over by an Architect` : ""
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
    takeovers,
    architectTakeovers,
    line: `${noun(workers, "worker")} running, ${noun(verifications, "verification")} running, ${noun(architectTurns, "Architect turn")} in flight${open}${finishing}, safe to reload: ${safe ? "yes" : "no"}`,
  }
}

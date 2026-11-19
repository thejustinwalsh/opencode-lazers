import type { Database } from "bun:sqlite"
import { holdFamily } from "./hold-actions.ts"

/**
 * The "struggling task" signal: a task that keeps consuming effort without landing. It is a
 * reading of recorded facts, never a workflow state; nothing is stored beyond the one
 * `TASK_STRUGGLING` journal event the scheduler writes the first time the reading turns true.
 *
 * Thresholds come from the 175 tasks that were accepted in the production database
 * (Nov 2026). Each constant sits at or just past the 90th percentile of that distribution, so
 * roughly one task in ten trips any single rule and a task that trips several is an outlier. Run
 * against those 175 tasks the seven rules together flag 32; the live database flags one task:
 *
 *   fact                          median   p90    p95    max     threshold
 *   verification rounds              1      2      3      7        3
 *   repairs + resumes                0      2      2      7        3
 *   worker running time           0.5 h  3.8 h  11.7 h  24 h        4 h
 *   tokens (cumulative, sum)        11 M   53 M   76 M  215 M      75 M
 *   interrupted workers              0      1      1      2        2
 *
 * Accepted-then-reopened and the same hold family three times have no healthy baseline: a task
 * the Architect accepted and later sent back has by definition not landed, and a task held for
 * the same reason repeatedly is looping.
 */
export const STRUGGLING_THRESHOLDS = {
  verifyRounds: 3,
  repairsAndResumes: 3,
  attemptMs: 4 * 3_600_000,
  tokens: 75_000_000,
  interruptions: 2,
  reopenedAfterAccept: 2,
  sameHoldFamily: 3,
} as const

export type StrugglingFacts = {
  attempts: number
  verifyRounds: number
  repairsAndResumes: number
  interruptions: number
  reopenedAfterAccept: number
  /** The most-repeated hold family across this task's BLOCKED records. */
  repeatedHold: { family: string; count: number } | null
  /** Time a worker ran: each start or resume up to the next stop, or to now while one runs. */
  attemptMs: number
  tokens: number
  toolCalls: number
  /** Sum of attempt costs; null when no attempt priced its usage. */
  costUSD: number | null
}

export type StrugglingReason =
  | "verify-rounds"
  | "repairs-and-resumes"
  | "attempt-time"
  | "tokens"
  | "interruptions"
  | "reopened-after-accept"
  | "repeated-hold"

export type StrugglingAssessment = {
  struggling: boolean
  reasons: StrugglingReason[]
  /** "3 verification rounds, 4h 10m in attempts, 92M tokens"; empty when not struggling. */
  line: string
}

export function durationLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

export function tokenLabel(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`
  if (count >= 1_000_000) return `${Math.round(count / 1_000_000)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** Pure: the facts of one task in, whether and why it is struggling out. */
export function assessStruggling(facts: StrugglingFacts): StrugglingAssessment {
  const t = STRUGGLING_THRESHOLDS
  const found: Array<[StrugglingReason, string]> = []
  if (facts.verifyRounds >= t.verifyRounds)
    found.push(["verify-rounds", plural(facts.verifyRounds, "verification round")])
  if (facts.repairsAndResumes >= t.repairsAndResumes)
    found.push([
      "repairs-and-resumes",
      plural(facts.repairsAndResumes, "repair or resume", "repairs and resumes"),
    ])
  if (facts.attemptMs >= t.attemptMs)
    found.push(["attempt-time", `${durationLabel(facts.attemptMs)} in attempts`])
  if (facts.tokens >= t.tokens) found.push(["tokens", `${tokenLabel(facts.tokens)} tokens`])
  if (facts.interruptions >= t.interruptions)
    found.push(["interruptions", plural(facts.interruptions, "interruption")])
  if (facts.reopenedAfterAccept >= t.reopenedAfterAccept)
    found.push(["reopened-after-accept", "reopened after acceptance"])
  if (facts.repeatedHold && facts.repeatedHold.count >= t.sameHoldFamily)
    found.push([
      "repeated-hold",
      `held ${facts.repeatedHold.count} times for ${facts.repeatedHold.family}`,
    ])
  return {
    struggling: found.length > 0,
    reasons: found.map(([reason]) => reason),
    line: found.map(([, text]) => text).join(", "),
  }
}

const REPAIR_EVENTS = ["REPAIR", "RESUME", "RETAINED_REPAIR", "RETRY_REQUESTED"]

/** The recorded facts of one task. Read-only. */
export function readStrugglingFacts(
  db: Database,
  planID: string,
  taskID: string,
  now: number,
): StrugglingFacts {
  const transitions = db
    .query<{ event: string; payload: string; created_at: number }, [string, string]>(
      `SELECT event,payload,created_at FROM runner_transitions
       WHERE plan_id=? AND task_id=? AND event IN
         ('VERIFY','REPAIR','RESUME','RETAINED_REPAIR','RETRY_REQUESTED','WORKER_STARTED','ATTEMPT_RESUMED','WORKER_STOPPED','BLOCKED')
       ORDER BY id`,
    )
    .all(planID, taskID)
  const parse = (payload: string) => {
    try {
      return JSON.parse(payload) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  let verifyRounds = 0
  let repairsAndResumes = 0
  let interruptions = 0
  let reopenedAfterAccept = 0
  const holds = new Map<string, number>()
  // Worker time: from a start or resume to the next stop; time on hold in between is not work.
  let attemptMs = 0
  let runningSince: number | null = null
  for (const row of transitions) {
    const body = parse(row.payload)
    if (row.event === "VERIFY") verifyRounds += 1
    else if (REPAIR_EVENTS.includes(row.event)) {
      repairsAndResumes += 1
      if (row.event === "RETAINED_REPAIR" && body.from === "accepted") reopenedAfterAccept += 1
    } else if (row.event === "WORKER_STARTED" || row.event === "ATTEMPT_RESUMED") {
      runningSince ??= row.created_at
    } else if (row.event === "WORKER_STOPPED") {
      if (body.outcome === "interrupted") interruptions += 1
      if (runningSince !== null) attemptMs += Math.max(0, row.created_at - runningSince)
      runningSince = null
    } else if (row.event === "BLOCKED" && typeof body.reason === "string") {
      const family = holdFamily(body.reason)?.name ?? "unclassified"
      holds.set(family, (holds.get(family) ?? 0) + 1)
    }
  }
  const attempts = db
    .query<
      {
        id: string
        state: string
        started_at: number
        token_count: number | null
        tool_count: number
        cost: number | null
      },
      [string, string]
    >(
      "SELECT id,state,started_at,token_count,tool_count,cost FROM runner_attempts WHERE plan_id=? AND task_id=?",
    )
    .all(planID, taskID)
  // A worker that never stopped is still working when its attempt is live.
  if (runningSince !== null && attempts.some((a) => ["preparing", "running"].includes(a.state)))
    attemptMs += Math.max(0, now - runningSince)
  const priced = attempts.filter((attempt) => attempt.cost !== null)
  const [family, count] = [...holds.entries()].toSorted((a, b) => b[1] - a[1])[0] ?? []
  return {
    attempts: attempts.length,
    verifyRounds,
    repairsAndResumes,
    interruptions,
    reopenedAfterAccept,
    repeatedHold: family === undefined ? null : { family, count: count! },
    attemptMs,
    tokens: attempts.reduce((sum, attempt) => sum + (attempt.token_count ?? 0), 0),
    toolCalls: attempts.reduce((sum, attempt) => sum + attempt.tool_count, 0),
    costUSD: priced.length ? priced.reduce((sum, attempt) => sum + attempt.cost!, 0) : null,
  }
}

/** Landed, cancelled and failed work is history; failed work already goes to recovery. */
const SETTLED_NODE_STATES: ReadonlySet<string> = new Set([
  "accepted",
  "incorporated",
  "cancelled",
  "failed",
  "exhausted",
])

export function canStruggle(nodeState: string): boolean {
  return !SETTLED_NODE_STATES.has(nodeState)
}

import type { Database } from "bun:sqlite"
import { holdFamily } from "../runner/hold-actions.ts"
import { scopeViolations } from "../runner/artifacts.ts"

/**
 * The recorded trajectory of one task, read-only. Two readers, both parameterized by "as of" so
 * the live detector and `scripts/replay-concerns.ts` run the same code:
 *
 * - `readTrajectoryFacts`: task-wide totals from the runner journal and attempts.
 * - `readTrajectoryTail`: the newest tool calls of one attempt from its progress journal.
 */

export type TrajectoryFacts = {
  attempts: number
  verifyRounds: number
  /** Verification rounds that sent the task back to its worker (`REPAIR` out of verifying). */
  verifyFailures: number
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

export type TrajectoryTail = {
  /** Newest sequence of the attempt's progress journal; 0 when it has none. */
  throughSequence: number
  trailingToolFailures: number
  /** Tool calls since the attempt's last edit or patch (all of them when it made none). */
  callsWithoutFileChange: number
  /** Tokens the attempt's steps used since its last edit or patch. */
  tokensWithoutFileChange: number
  /** Files edited or patched outside the write scope. */
  outOfScope: string[]
}

export function durationLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

export { tokenLabel } from "./token-label.ts"

const REPAIR_EVENTS = ["REPAIR", "RESUME", "RETAINED_REPAIR", "RETRY_REQUESTED"]

/**
 * The recorded facts of one task. Read-only. `now` ends any open worker interval; with
 * `replay`, everything after `now` is ignored and tokens are summed from the attempts' step
 * measurements up to `now` (the attempt row only holds the latest total).
 */
export function readTrajectoryFacts(
  db: Database,
  planID: string,
  taskID: string,
  now: number,
  options: { replay?: boolean; projectDirectory?: string } = {},
): TrajectoryFacts {
  const replay = options.replay === true
  const transitions = db
    .query<{ event: string; payload: string; created_at: number }, [string, string, number]>(
      `SELECT event,payload,created_at FROM runner_transitions
       WHERE plan_id=? AND task_id=? AND created_at<=? AND event IN
         ('VERIFY','REPAIR','RESUME','RETAINED_REPAIR','RETRY_REQUESTED','WORKER_STARTED','ATTEMPT_RESUMED','WORKER_STOPPED','BLOCKED')
       ORDER BY id`,
    )
    .all(planID, taskID, replay ? now : Number.MAX_SAFE_INTEGER)
  const parse = (payload: string) => {
    try {
      return JSON.parse(payload) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  let verifyRounds = 0
  let verifyFailures = 0
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
      if (row.event === "REPAIR" && body.from === "verifying") verifyFailures += 1
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
      [string, string, number]
    >(
      "SELECT id,state,started_at,token_count,tool_count,cost FROM runner_attempts WHERE plan_id=? AND task_id=? AND started_at<=?",
    )
    .all(planID, taskID, replay ? now : Number.MAX_SAFE_INTEGER)
  // A worker that never stopped is still working when its attempt is live (or, replaying, at `now`).
  if (
    runningSince !== null &&
    (replay || attempts.some((a) => ["preparing", "running"].includes(a.state)))
  )
    attemptMs += Math.max(0, now - runningSince)
  const priced = attempts.filter((attempt) => attempt.cost !== null)
  const [family, count] = [...holds.entries()].toSorted((a, b) => b[1] - a[1])[0] ?? []
  let tokens = attempts.reduce((sum, attempt) => sum + (attempt.token_count ?? 0), 0)
  let toolCalls = attempts.reduce((sum, attempt) => sum + attempt.tool_count, 0)
  if (replay && options.projectDirectory) {
    tokens = 0
    toolCalls = 0
    for (const attempt of attempts) {
      const used = db
        .query<{ tokens: number | null }, [string, string, number]>(
          `SELECT sum(${STEP_TOKENS}) AS tokens FROM runner_progress
            WHERE project_directory=? AND attempt_id=? AND kind='step' AND at<=?`,
        )
        .get(options.projectDirectory, attempt.id, now)
      tokens += used?.tokens ?? 0
      const calls = db
        .query<{ n: number }, [string, string, number]>(
          `SELECT count(*) AS n FROM runner_progress
            WHERE project_directory=? AND attempt_id=? AND kind='tool' AND call_id IS NOT NULL AND at<=?`,
        )
        .get(options.projectDirectory, attempt.id, now)
      toolCalls += calls?.n ?? 0
    }
  }
  return {
    attempts: attempts.length,
    verifyRounds,
    verifyFailures,
    repairsAndResumes,
    interruptions,
    reopenedAfterAccept,
    repeatedHold: family === undefined ? null : { family, count: count! },
    attemptMs,
    tokens,
    toolCalls,
    costUSD: priced.length ? priced.reduce((sum, attempt) => sum + attempt.cost!, 0) : null,
  }
}

/** One step's measured tokens: the journal records each step's usage additively. */
const STEP_TOKENS = `coalesce(json_extract(payload,'$.usage.input'),0)
  +coalesce(json_extract(payload,'$.usage.output'),0)
  +coalesce(json_extract(payload,'$.usage.reasoning'),0)
  +coalesce(json_extract(payload,'$.usage.cacheRead'),0)
  +coalesce(json_extract(payload,'$.usage.cacheWrite'),0)`

/** Failed calls are counted back from the newest call, never further than this. */
export const FAILURE_WINDOW = 100

/**
 * The newest tool calls of an attempt. Bounded: the failure run reads at most `FAILURE_WINDOW`
 * rows, the edit scan reads only edit and patch calls, and the rest are counts and a sum over
 * indexed ranges of the attempt. `throughSequence` replays the attempt as of that sequence.
 */
export function readTrajectoryTail(
  db: Database,
  projectDirectory: string,
  attemptID: string,
  scope: string[],
  throughSequence = Number.MAX_SAFE_INTEGER,
): TrajectoryTail {
  const last = db
    .query<{ seq: number | null }, [string, string, number]>(
      "SELECT max(seq) AS seq FROM runner_progress WHERE project_directory=? AND attempt_id=? AND seq<=?",
    )
    .get(projectDirectory, attemptID, throughSequence)
  const recent = db
    .query<{ status: string | null }, [string, string, number, number]>(
      `SELECT json_extract(payload,'$.status') AS status
         FROM runner_progress
        WHERE project_directory=? AND attempt_id=? AND seq<=? AND kind='tool' AND call_id IS NOT NULL
        ORDER BY seq DESC LIMIT ?`,
    )
    .all(projectDirectory, attemptID, throughSequence, FAILURE_WINDOW)
  let trailingToolFailures = 0
  for (const row of recent) {
    if (row.status !== "failed") break
    trailingToolFailures += 1
  }
  // Edits are read over the whole attempt: their last position and the paths outside the scope.
  // Older journal rows carry no `fileTargets`; their patch result lists the files instead.
  const edits = db
    .query<
      { seq: number; paths: string | null; content: string | null; status: string | null },
      [string, string, number]
    >(
      `SELECT seq,json_extract(payload,'$.fileTargets.paths') AS paths,
              substr(json_extract(payload,'$.content'),1,4000) AS content,
              json_extract(payload,'$.status') AS status
         FROM runner_progress
        WHERE project_directory=? AND attempt_id=? AND kind='tool' AND seq<=?
          AND (json_extract(payload,'$.tool') IN ('edit','write','patch','multiedit')
               OR json_extract(payload,'$.fileTargets.operation') IN ('edit','patch'))
        ORDER BY seq`,
    )
    .all(projectDirectory, attemptID, throughSequence)
  const edited = new Set<string>()
  let lastEditSeq = 0
  for (const row of edits) {
    if (row.status === "failed" || row.status === "not-executed") continue
    lastEditSeq = row.seq
    try {
      const paths = JSON.parse(row.paths ?? "null") as unknown
      if (Array.isArray(paths)) {
        for (const path of paths) if (typeof path === "string" && path) edited.add(path)
        continue
      }
    } catch {
      /* an unreadable target list names no file */
    }
    for (const line of (row.content ?? "").split("\n")) {
      const listed = /^[AMD] (\S.*)$/.exec(line)
      if (listed) edited.add(listed[1]!)
    }
  }
  const since = db
    .query<{ calls: number; tokens: number | null }, [string, string, number, number]>(
      `SELECT sum(kind='tool' AND call_id IS NOT NULL) AS calls,
              sum(CASE WHEN kind='step' THEN ${STEP_TOKENS} ELSE 0 END) AS tokens
         FROM runner_progress
        WHERE project_directory=? AND attempt_id=? AND seq>? AND seq<=? AND kind IN ('tool','step')`,
    )
    .get(projectDirectory, attemptID, lastEditSeq, throughSequence)
  return {
    throughSequence: last?.seq ?? 0,
    trailingToolFailures,
    callsWithoutFileChange: since?.calls ?? 0,
    tokensWithoutFileChange: since?.tokens ?? 0,
    outOfScope: scopeViolations([...edited], scope).toSorted(),
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

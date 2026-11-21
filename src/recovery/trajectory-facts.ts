import type { Database } from "bun:sqlite"
import { holdFamily } from "../runner/hold-actions.ts"
import { classifyChange, type ScopeModel } from "../runner/scope.ts"
import { attemptIn, attemptIs, planIs } from "../runner/identity-read.ts"

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
  /**
   * Files written where the scope model puts no edit, no planned new file and no sibling of one
   * (`divergence` whether the file was new or existing). The journal does not say which.
   */
  outOfScope: string[]
  /** Files written on a protected path: the one hard scope boundary. */
  protectedWrites: string[]
}

/** A bare edit list is the scope of a task with no planned new files and nothing protected. */
function scopeModel(scope: ScopeModel | readonly string[]): ScopeModel {
  return Array.isArray(scope)
    ? { edit: scope as readonly string[], create: [], protected: [] }
    : (scope as ScopeModel)
}

function classifyWrites(paths: Iterable<string>, scope: ScopeModel | readonly string[]) {
  const model = scopeModel(scope)
  const outOfScope: string[] = []
  const protectedWrites: string[] = []
  for (const path of paths) {
    const asNew = classifyChange({ path, status: "added" }, model).class
    const asEdit = classifyChange({ path, status: "modified" }, model).class
    if (asNew === "protected" || asEdit === "protected") protectedWrites.push(path)
    else if (asNew === "divergence" && asEdit === "divergence") outOfScope.push(path)
  }
  return { outOfScope: outOfScope.toSorted(), protectedWrites: protectedWrites.toSorted() }
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
  const until = replay ? now : Number.MAX_SAFE_INTEGER
  // The caller counts events and walks worker start/stop pairs, so the database does both:
  // counting events are grouped by what they are counted on (`from` of a repair, the reason of a
  // block) and ordered by first appearance, so ties between hold families resolve as a scan of
  // the journal would; only the worker start/stop events come back one row each, without payload.
  const counted = db
    .query<
      { event: string; from_state: string | null; reason: string | null; n: number },
      [string, string, number]
    >(
      `SELECT event,
              CASE WHEN event IN ('REPAIR','RETAINED_REPAIR') THEN json_extract(payload,'$.from') END AS from_state,
              CASE WHEN event='BLOCKED' THEN json_extract(payload,'$.reason') END AS reason,
              count(*) AS n
         FROM runner_transitions
        WHERE ${planIs(db, "runner_transitions")} AND task_id=? AND created_at<=? AND event IN
          ('VERIFY','REPAIR','RESUME','RETAINED_REPAIR','RETRY_REQUESTED','BLOCKED')
        GROUP BY event,from_state,reason ORDER BY min(id)`,
    )
    .all(planID, taskID, until)
  const worker = db
    .query<{ event: string; outcome: string | null; created_at: number }, [string, string, number]>(
      `SELECT event,
              CASE WHEN event='WORKER_STOPPED' THEN json_extract(payload,'$.outcome') END AS outcome,
              created_at
         FROM runner_transitions
        WHERE ${planIs(db, "runner_transitions")} AND task_id=? AND created_at<=? AND event IN
          ('WORKER_STARTED','ATTEMPT_RESUMED','WORKER_STOPPED')
        ORDER BY id`,
    )
    .all(planID, taskID, until)
  let verifyRounds = 0
  let verifyFailures = 0
  let repairsAndResumes = 0
  let interruptions = 0
  let reopenedAfterAccept = 0
  const holds = new Map<string, number>()
  for (const row of counted) {
    if (row.event === "VERIFY") verifyRounds += row.n
    else if (REPAIR_EVENTS.includes(row.event)) {
      repairsAndResumes += row.n
      if (row.event === "REPAIR" && row.from_state === "verifying") verifyFailures += row.n
      if (row.event === "RETAINED_REPAIR" && row.from_state === "accepted")
        reopenedAfterAccept += row.n
    } else if (row.event === "BLOCKED" && typeof row.reason === "string") {
      const family = holdFamily(row.reason)?.name ?? "unclassified"
      holds.set(family, (holds.get(family) ?? 0) + row.n)
    }
  }
  // Worker time: from a start or resume to the next stop; time on hold in between is not work.
  let attemptMs = 0
  let runningSince: number | null = null
  for (const row of worker) {
    if (row.event === "WORKER_STOPPED") {
      if (row.outcome === "interrupted") interruptions += 1
      if (runningSince !== null) attemptMs += Math.max(0, row.created_at - runningSince)
      runningSince = null
    } else runningSince ??= row.created_at
  }
  // One row of sums for the task's attempts; no attempt row is read.
  const totals = db
    .query<
      {
        attempts: number
        live: number | null
        tokens: number | null
        tools: number | null
        priced: number
        cost: number | null
      },
      [string, string, number]
    >(
      `SELECT count(*) AS attempts,
              sum(state IN ('preparing','running')) AS live,
              sum(token_count) AS tokens, sum(tool_count) AS tools,
              count(cost) AS priced, sum(cost) AS cost
         FROM runner_attempts WHERE plan_id=? AND task_id=? AND started_at<=?`,
    )
    .get(planID, taskID, until)!
  // A worker that never stopped is still working when its attempt is live (or, replaying, at `now`).
  if (runningSince !== null && (replay || (totals.live ?? 0) > 0))
    attemptMs += Math.max(0, now - runningSince)
  const [family, count] = [...holds.entries()].toSorted((a, b) => b[1] - a[1])[0] ?? []
  let tokens = totals.tokens ?? 0
  let toolCalls = totals.tools ?? 0
  if (replay && options.projectDirectory) {
    // Replaying measures from the journal's steps: the attempt row only holds the latest total.
    const attemptIDs =
      "SELECT id FROM runner_attempts WHERE plan_id=? AND task_id=? AND started_at<=?"
    const used = db
      .query<{ tokens: number | null }, [string, string, string, number, number]>(
        `SELECT sum(${STEP_TOKENS}) AS tokens FROM runner_progress
          WHERE project_directory=? AND ${attemptIn(db, attemptIDs)} AND kind='step' AND at<=?`,
      )
      .get(options.projectDirectory, planID, taskID, until, now)
    tokens = used?.tokens ?? 0
    const calls = db
      .query<{ n: number }, [string, string, string, number, number]>(
        `SELECT count(*) AS n FROM runner_progress
          WHERE project_directory=? AND ${attemptIn(db, attemptIDs)}
            AND kind='tool' AND call_id IS NOT NULL AND at<=?`,
      )
      .get(options.projectDirectory, planID, taskID, until, now)
    toolCalls = calls?.n ?? 0
  }
  return {
    attempts: totals.attempts,
    verifyRounds,
    verifyFailures,
    repairsAndResumes,
    interruptions,
    reopenedAfterAccept,
    repeatedHold: family === undefined ? null : { family, count: count! },
    attemptMs,
    tokens,
    toolCalls,
    costUSD: totals.priced > 0 ? (totals.cost ?? 0) : null,
  }
}

/** One step's measured tokens: the journal records each step's usage additively. */
const STEP_TOKENS = `coalesce(json_extract(payload,'$.usage.input'),0)
  +coalesce(json_extract(payload,'$.usage.output'),0)
  +coalesce(json_extract(payload,'$.usage.reasoning'),0)
  +coalesce(json_extract(payload,'$.usage.cacheRead'),0)
  +coalesce(json_extract(payload,'$.usage.cacheWrite'),0)`

/** Failed calls are counted back from the newest call, never further than this. */
const FAILURE_WINDOW = 100

/**
 * The newest tool calls of an attempt. Bounded: the failure run reads at most `FAILURE_WINDOW`
 * rows, the edit scan reads only edit and patch calls, and the rest are counts and a sum over
 * indexed ranges of the attempt. `throughSequence` replays the attempt as of that sequence.
 */
export function readTrajectoryTail(
  db: Database,
  projectDirectory: string,
  attemptID: string,
  scope: ScopeModel | readonly string[],
  throughSequence = Number.MAX_SAFE_INTEGER,
): TrajectoryTail {
  const last = db
    .query<{ seq: number | null }, [string, string, number]>(
      `SELECT max(seq) AS seq FROM runner_progress WHERE project_directory=? AND ${attemptIs(db)} AND seq<=?`,
    )
    .get(projectDirectory, attemptID, throughSequence)
  const recent = db
    .query<{ status: string | null }, [string, string, number, number]>(
      `SELECT json_extract(payload,'$.status') AS status
         FROM runner_progress
        WHERE project_directory=? AND ${attemptIs(db)} AND seq<=? AND kind='tool' AND call_id IS NOT NULL
        ORDER BY seq DESC LIMIT ?`,
    )
    .all(projectDirectory, attemptID, throughSequence, FAILURE_WINDOW)
  let trailingToolFailures = 0
  for (const row of recent) {
    if (row.status !== "failed") break
    trailingToolFailures += 1
  }
  // Edits are read over the whole attempt: their last position and the paths outside the scope.
  // The database drops failed edits and groups identical target lists, so a row is one distinct
  // list of files with the newest sequence that wrote it. Older journal rows carry no
  // `fileTargets`; only those return their patch result, which lists the files instead.
  const edits = db
    .query<{ seq: number; paths: string | null; content: string | null }, [string, string, number]>(
      `SELECT max(seq) AS seq,
              json_extract(payload,'$.fileTargets.paths') AS paths,
              CASE WHEN json_type(payload,'$.fileTargets.paths')='array' THEN NULL
                   ELSE substr(json_extract(payload,'$.content'),1,4000) END AS content
         FROM runner_progress
        WHERE project_directory=? AND ${attemptIs(db)} AND kind='tool' AND seq<=?
          AND (json_extract(payload,'$.tool') IN ('edit','write','patch','multiedit')
               OR json_extract(payload,'$.fileTargets.operation') IN ('edit','patch'))
          AND coalesce(json_extract(payload,'$.status'),'') NOT IN ('failed','not-executed')
        GROUP BY paths,content ORDER BY seq`,
    )
    .all(projectDirectory, attemptID, throughSequence)
  const edited = new Set<string>()
  let lastEditSeq = 0
  for (const row of edits) {
    lastEditSeq = Math.max(lastEditSeq, row.seq)
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
        WHERE project_directory=? AND ${attemptIs(db)} AND seq>? AND seq<=? AND kind IN ('tool','step')`,
    )
    .get(projectDirectory, attemptID, lastEditSeq, throughSequence)
  return {
    throughSequence: last?.seq ?? 0,
    trailingToolFailures,
    callsWithoutFileChange: since?.calls ?? 0,
    tokensWithoutFileChange: since?.tokens ?? 0,
    ...classifyWrites(edited, scope),
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

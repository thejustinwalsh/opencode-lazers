/**
 * Read-only replay of the recovery detector's rules over recorded task history.
 *
 *   bun scripts/replay-concerns.ts [--db <tasks.sqlite>] [--project <dir>] [--task LZ-200]
 *                                  [--every 10] [--ceiling <tokens>] [--json]
 *
 * The database opens read-only (`mode=ro`); nothing is written or copied. For each task the
 * script walks its history at successive moments (every verification, repair, resume, stop and
 * hold, plus every `--every`th tool call of each attempt, while the task is running or
 * verifying) and runs the shipped rule code at each one: `readTrajectoryFacts` and
 * `readTrajectoryTail` read the journal as of that moment and `evaluateRules` judges them.
 * Tokens as of a moment are the sum of the attempts' recorded step measurements up to it.
 *
 * Definitions, stated in the report:
 * - healthy: the task ended `accepted`. Not all of it is clean; the report also counts the
 *   accepted tasks that never needed churn (at most 2 verification rounds, at most 2 repairs
 *   and resumes, never reopened after acceptance) as "clean".
 * - troubled: the task ended `failed`, `exhausted` or `cancelled` after a worker started.
 * - long-running: still unsettled with at least 4h of worker time.
 * Out-of-scope writes are replayed with the task's proposal scope plus its latest amendment.
 */
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  evaluateRules,
  type ConcernAction,
  type RuleID,
  type RuleOptions,
} from "../src/recovery/detector.ts"
import {
  canStruggle,
  durationLabel,
  readTrajectoryFacts,
  readTrajectoryTail,
  tokenLabel,
  type TrajectoryFacts,
  type TrajectoryTail,
} from "../src/recovery/trajectory-facts.ts"

const KEY_EVENTS = [
  "VERIFY",
  "REPAIR",
  "RESUME",
  "RETAINED_REPAIR",
  "ATTEMPT_RESUMED",
  "WORKER_STARTED",
  "WORKER_STOPPED",
  "BLOCKED",
]

export type FirstFire = {
  ruleID: RuleID
  action: ConcernAction
  at: number
  elapsedMs: number
  tokens: number
  verifyRounds: number
  reason: string
}

export type TaskReplay = {
  taskID: string
  reference: string | null
  state: string
  attempts: number
  moments: number
  peak: { tokens: number; verifyRounds: number; repairs: number; reopened: number }
  first: FirstFire[]
  firstTakeover: FirstFire | null
}

type NodeRow = { plan_id: string; task_id: string; state: string }

export function replayTask(
  db: Database,
  projectDirectory: string,
  node: NodeRow,
  options: { every: number; rules: RuleOptions },
): TaskReplay {
  const reference =
    db
      .query<{ reference: string }, [string, string]>(
        "SELECT reference FROM task_references WHERE project_directory=? AND task_id=?",
      )
      .get(projectDirectory, node.task_id)?.reference ?? null
  const attempts = db
    .query<{ id: string; started_at: number; number: number }, [string, string]>(
      "SELECT id,started_at,number FROM runner_attempts WHERE plan_id=? AND task_id=? ORDER BY started_at",
    )
    .all(node.plan_id, node.task_id)
  const result: TaskReplay = {
    taskID: node.task_id,
    reference,
    state: node.state,
    attempts: attempts.length,
    moments: 0,
    peak: { tokens: 0, verifyRounds: 0, repairs: 0, reopened: 0 },
    first: [],
    firstTakeover: null,
  }
  if (!attempts.length) return result
  const transitions = db
    .query<{ event: string; created_at: number; payload: string }, [string, string]>(
      "SELECT event,created_at,payload FROM runner_transitions WHERE plan_id=? AND task_id=? ORDER BY id",
    )
    .all(node.plan_id, node.task_id)
  const proposal = db
    .query<{ scope: string | null }, [string]>(
      "SELECT json_extract(body,'$.proposal.writeScope') AS scope FROM tasks WHERE id=?",
    )
    .get(node.task_id)
  const baseScope = JSON.parse(proposal?.scope ?? "[]") as string[]
  const moments = new Set<number>()
  const stateAt: [number, string][] = []
  for (const row of transitions) {
    try {
      const to = (JSON.parse(row.payload) as { to?: string }).to
      if (to) stateAt.push([row.created_at, to])
    } catch {
      /* a transition without a readable payload moves no state */
    }
    if (KEY_EVENTS.includes(row.event)) moments.add(row.created_at)
    if (row.event === "ACCEPT") moments.add(row.created_at - 1)
  }
  for (const attempt of attempts) {
    const calls = db
      .query<{ at: number }, [string, string]>(
        `SELECT at FROM runner_progress
          WHERE project_directory=? AND attempt_id=? AND kind='tool' AND call_id IS NOT NULL ORDER BY seq`,
      )
      .all(projectDirectory, attempt.id)
    calls.forEach((call, index) => {
      if (index % options.every === options.every - 1 || index === calls.length - 1)
        moments.add(call.at)
    })
  }
  const seen = new Set<RuleID>()
  for (const at of [...moments].toSorted((a, b) => a - b)) {
    let state = ""
    for (const [when, to] of stateAt) if (when <= at) state = to
    // The detector looks at tasks whose worker is running or being verified.
    if (state !== "running" && state !== "verifying") continue
    const attempt = attempts.filter((a) => a.started_at <= at).at(-1)
    if (!attempt) continue
    const through =
      db
        .query<{ seq: number | null }, [string, string, number]>(
          "SELECT max(seq) AS seq FROM runner_progress WHERE project_directory=? AND attempt_id=? AND at<=?",
        )
        .get(projectDirectory, attempt.id, at)?.seq ?? 0
    const amended = transitions
      .filter((t) => t.event === "SCOPE_AMENDED" && t.created_at <= at)
      .at(-1)
    const scope = [
      ...new Set([
        ...baseScope,
        ...(amended
          ? ((JSON.parse(amended.payload) as { writeScope?: string[] }).writeScope ?? [])
          : []),
      ]),
    ]
    const facts: TrajectoryFacts = readTrajectoryFacts(db, node.plan_id, node.task_id, at, {
      replay: true,
      projectDirectory,
    })
    const tail: TrajectoryTail = readTrajectoryTail(
      db,
      projectDirectory,
      attempt.id,
      scope,
      through,
    )
    result.moments += 1
    result.peak.tokens = Math.max(result.peak.tokens, facts.tokens)
    result.peak.verifyRounds = Math.max(result.peak.verifyRounds, facts.verifyRounds)
    result.peak.repairs = Math.max(result.peak.repairs, facts.repairsAndResumes)
    result.peak.reopened = Math.max(result.peak.reopened, facts.reopenedAfterAccept)
    for (const finding of evaluateRules(facts, tail, "replay", options.rules)) {
      const fire: FirstFire = {
        ruleID: finding.ruleID,
        action: finding.action,
        at,
        elapsedMs: at - attempts[0]!.started_at,
        tokens: facts.tokens,
        verifyRounds: facts.verifyRounds,
        reason: finding.reason,
      }
      if (!seen.has(finding.ruleID)) {
        seen.add(finding.ruleID)
        result.first.push(fire)
      }
      if (finding.action === "takeover" && !result.firstTakeover) result.firstTakeover = fire
    }
  }
  return result
}

const RULES = Object.keys({
  "verify-rounds-repeated": 0,
  "repair-cycles-repeated": 0,
  "reopened-after-accept": 0,
  "spend-without-file-change": 0,
  "token-spend-high": 0,
  "worker-time-long": 0,
  "interruptions-repeated": 0,
  "hold-family-repeated": 0,
  "out-of-scope-write": 0,
  "tool-failures-repeated": 0,
  "no-file-changes": 0,
  "spend-ceiling": 0,
} satisfies Record<RuleID, 0>) as RuleID[]

const percent = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : "n/a")

export function replayProject(
  db: Database,
  projectDirectory: string,
  options: { every: number; rules: RuleOptions; task?: string },
) {
  const nodes = db
    .query<NodeRow, [string]>(
      `SELECT n.plan_id,n.task_id,n.state FROM runner_nodes n
         JOIN runner_plans p ON p.id=n.plan_id WHERE p.project_directory=?`,
    )
    .all(projectDirectory)
  const all = nodes.map((node) => replayTask(db, projectDirectory, node, options))
  const ran = all.filter((task) => task.attempts > 0)
  const accepted = ran.filter((task) => task.state === "accepted")
  const troubled = ran.filter((task) => ["failed", "exhausted", "cancelled"].includes(task.state))
  const open = ran.filter((task) => canStruggle(task.state))
  const clean = accepted.filter(
    (task) => task.peak.verifyRounds <= 2 && task.peak.repairs <= 2 && task.peak.reopened === 0,
  )
  const flagged = (task: TaskReplay) => task.first.length > 0
  const perRule = RULES.map((ruleID) => {
    const count = (tasks: TaskReplay[]) =>
      tasks.filter((task) => task.first.some((fire) => fire.ruleID === ruleID)).length
    return {
      ruleID,
      accepted: count(accepted),
      clean: count(clean),
      troubled: count(troubled),
      open: count(open),
    }
  })
  const chosen = options.task
    ? all.find(
        (task) =>
          task.reference === options.task ||
          task.taskID === options.task ||
          task.taskID.startsWith(options.task!),
      )
    : undefined
  return { all, ran, accepted, troubled, open, clean, flagged, perRule, chosen }
}

/**
 * The per-task cost of one detector pass over a task's recorded trajectory: the same reads
 * `RecoveryDetector.evaluate` makes, timed on the database as it stands.
 */
export function measureTick(db: Database, projectDirectory: string, taskIDs: string[]) {
  const rows: { taskID: string; ms: number; progressRows: number }[] = []
  for (const taskID of taskIDs) {
    const node = db
      .query<NodeRow, [string, string]>(
        `SELECT n.plan_id,n.task_id,n.state FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
          WHERE p.project_directory=? AND n.task_id=?`,
      )
      .get(projectDirectory, taskID)
    if (!node) continue
    const attempt = db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM runner_attempts WHERE plan_id=? AND task_id=? ORDER BY started_at DESC LIMIT 1",
      )
      .get(node.plan_id, node.task_id)
    if (!attempt) continue
    const progressRows =
      db
        .query<{ n: number }, [string, string]>(
          "SELECT count(*) AS n FROM runner_progress WHERE project_directory=? AND attempt_id=?",
        )
        .get(projectDirectory, attempt.id)?.n ?? 0
    const runs = 5
    const started = performance.now()
    for (let run = 0; run < runs; run += 1) {
      const facts = readTrajectoryFacts(db, node.plan_id, node.task_id, Date.now())
      const tail = readTrajectoryTail(db, projectDirectory, attempt.id, [])
      evaluateRules(facts, tail, "tick")
    }
    rows.push({ taskID, ms: (performance.now() - started) / runs, progressRows })
  }
  return rows
}

function main() {
  const args = process.argv.slice(2)
  const value = (name: string) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const path = value("--db") ?? join(homedir(), ".local/share/opencode/plugins/lazers/tasks.sqlite")
  const project = value("--project") ?? process.cwd()
  const every = Number(value("--every") ?? 10)
  const ceiling = value("--ceiling")
  // `mode=ro` through the uri keeps a live database untouched.
  const db = new Database(`file:${path}?mode=ro`, { readonly: true })
  const rules: RuleOptions = ceiling ? { spendCeilingTokens: Number(ceiling) } : {}
  const started = performance.now()
  const report = replayProject(db, project, { every, rules, task: value("--task") })
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  if (args.includes("--json")) {
    console.log(JSON.stringify(report.all))
    return
  }
  const { accepted, troubled, open, clean, flagged, perRule, chosen } = report
  console.log(
    `replay of ${report.ran.length} tasks that ran a worker, every ${every}th call, ${seconds}s`,
  )
  console.log(
    `healthy = ended accepted (${accepted.length}); clean = accepted with <=2 verification rounds, <=2 repairs, never reopened (${clean.length});`,
  )
  console.log(
    `troubled = ended failed, exhausted or cancelled after a worker started (${troubled.length}); open = still unsettled (${open.length})`,
  )
  console.log("")
  console.log(
    "rule".padEnd(28) + "accepted".padEnd(14) + "clean".padEnd(14) + "troubled".padEnd(14) + "open",
  )
  for (const row of perRule)
    console.log(
      row.ruleID.padEnd(28) +
        `${row.accepted} (${percent(row.accepted, accepted.length)})`.padEnd(14) +
        `${row.clean} (${percent(row.clean, clean.length)})`.padEnd(14) +
        `${row.troubled}/${troubled.length}`.padEnd(14) +
        `${row.open}/${open.length}`,
    )
  const any = (tasks: TaskReplay[]) => tasks.filter(flagged).length
  const takeover = (tasks: TaskReplay[]) => tasks.filter((task) => task.firstTakeover).length
  console.log(
    "ANY RULE".padEnd(28) +
      `${any(accepted)} (${percent(any(accepted), accepted.length)})`.padEnd(14) +
      `${any(clean)} (${percent(any(clean), clean.length)})`.padEnd(14) +
      `${any(troubled)}/${troubled.length}`.padEnd(14) +
      `${any(open)}/${open.length}`,
  )
  console.log(
    "ANY takeover advice".padEnd(28) +
      `${takeover(accepted)} (${percent(takeover(accepted), accepted.length)})`.padEnd(14) +
      `${takeover(clean)} (${percent(takeover(clean), clean.length)})`.padEnd(14) +
      `${takeover(troubled)}/${troubled.length}`.padEnd(14) +
      `${takeover(open)}/${open.length}`,
  )
  if (chosen) {
    console.log(
      `\n${chosen.reference ?? chosen.taskID}: ${chosen.state}, ${chosen.attempts} attempt(s), ${chosen.moments} moments`,
    )
    for (const fire of chosen.first.toSorted((a, b) => a.at - b.at))
      console.log(
        `  ${fire.ruleID.padEnd(26)} ${fire.action.padEnd(11)} ${new Date(fire.at).toISOString()} +${durationLabel(fire.elapsedMs)} ${tokenLabel(fire.tokens)} tokens, ${fire.verifyRounds} verify round(s): ${fire.reason}`,
      )
    if (chosen.firstTakeover)
      console.log(
        `  first takeover advice: ${chosen.firstTakeover.ruleID} at ${new Date(chosen.firstTakeover.at).toISOString()} +${durationLabel(chosen.firstTakeover.elapsedMs)}, ${tokenLabel(chosen.firstTakeover.tokens)} tokens`,
      )
  }
  const live = open.filter((task) => task.attempts > 0).map((task) => task.taskID)
  const costs = measureTick(db, project, live)
  console.log("\nper-task detector reads on the current database (mean of 5 runs):")
  for (const cost of costs)
    console.log(
      `  ${cost.taskID.slice(0, 8)}  ${cost.ms.toFixed(1)} ms  ${cost.progressRows} progress rows in the attempt`,
    )
}

if (import.meta.main) main()

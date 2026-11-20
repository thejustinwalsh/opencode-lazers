/**
 * Read-only report and replay of recorded planning decisions.
 *
 *   bun scripts/planning-report.ts [--db <tasks.sqlite>] [--project <key>] [--since <iso>] [--json]
 *                                  [--replay --strategy windows|whole|pre-slice|uncertainty]
 *
 * The database opens read-only (`mode=ro`); nothing is written. `--replay` re-runs the decision
 * procedure on the recorded ask texts through the live local model and prints how its answers
 * agree with the recorded ones; it writes nothing either.
 *
 * Definitions: a decision is `complex` when its size is not `one task` and its status is
 * `decided` or `none`. `belowThresholdRate` is the share of non-`unavailable` decisions that
 * ended `none` for `below-threshold`. An agent is flagged when it was picked for 90% or more of
 * the complex decisions: such an agent is not discriminating.
 */
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { AGENT_ORDER } from "../src/planning/decision/tree.ts"
import { localDecider } from "../src/planning/decision/deciders.ts"
import { decide } from "../src/planning/decision/procedure.ts"
import type { SlicerStrategy } from "../src/planning/decision/slicers.ts"
import { PLANNING_AGENT_INACTIVITY_MS, runsCost, type RunPrice } from "../src/planning/reviews.ts"
import { LocalInference } from "../src/webgpu/rpc.ts"
import { SystemOneRequest } from "../src/webgpu/system-one.ts"

type Row = {
  id: string
  ask_text: string
  strategy: string | null
  status: string
  reason: string | null
  size: string | null
  scores_json: string | null
  selected_json: string | null
}

export type Filter = { project?: string; since?: number }

const NEARLY_EVERY = 0.9
/** Input-size buckets (characters of state) for node latency. */
export const BUCKETS = [256, 512, 1024, 2048, Infinity] as const

const bucketLabel = (chars: number) => {
  const upper = BUCKETS.find((limit) => chars <= limit)!
  const index = BUCKETS.indexOf(upper)
  const lower = index === 0 ? 0 : BUCKETS[index - 1]! + 1
  return upper === Infinity ? `${lower}+` : `${lower}-${upper}`
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
}

function where(filter: Filter) {
  const clauses: string[] = []
  const args: (string | number)[] = []
  if (filter.project) (clauses.push("project_key=?"), args.push(filter.project))
  if (filter.since !== undefined) (clauses.push("created_at>=?"), args.push(filter.since))
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", args }
}

export type DecisionReport = {
  decisions: { total: number }
  byStatus: Record<string, number>
  belowThresholdRate: number
  pickRate: Record<string, number>
  flags: { agent: string; flag: "picked-for-nearly-every-ask" }[]
  nodeLatency: Record<string, { calls: number; p50Ms: number; p95Ms: number }>
  strategies: Record<string, number>
  architectAgreement?: { compared: number; sizeAgree: number }
}

/** `undefined` when there is nothing to report; the caller prints the counts it found. */
export function decisionReport(
  db: Database,
  filter: Filter = {},
): DecisionReport | { empty: { rows: number; withText: number } } {
  const { sql, args } = where(filter)
  const rows = db
    .query<Row, (string | number)[]>(
      `SELECT id, ask_text, strategy, status, reason, size, scores_json, selected_json FROM planning_decisions${sql}`,
    )
    .all(...args)
  if (!rows.length) return { empty: { rows: 0, withText: 0 } }
  const byStatus: Record<string, number> = {}
  const strategies: Record<string, number> = {}
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    if (row.strategy) strategies[row.strategy] = (strategies[row.strategy] ?? 0) + 1
  }
  const answered = rows.filter((row) => row.status !== "unavailable")
  const below = rows.filter((row) => row.status === "none" && row.reason === "below-threshold")
  const complex = rows.filter(
    (row) => (row.status === "decided" || row.status === "none") && row.size !== "one task",
  )
  const picks: Record<string, number> = Object.fromEntries(AGENT_ORDER.map((id) => [id, 0]))
  for (const row of complex)
    for (const id of row.selected_json ? (JSON.parse(row.selected_json) as string[]) : [])
      if (id in picks) picks[id]!++
  const pickRate = Object.fromEntries(
    AGENT_ORDER.map((id) => [id, complex.length ? picks[id]! / complex.length : 0]),
  )
  const flags = complex.length
    ? AGENT_ORDER.filter((id) => pickRate[id]! >= NEARLY_EVERY).map((agent) => ({
        agent,
        flag: "picked-for-nearly-every-ask" as const,
      }))
    : []
  const latency = new Map<string, number[]>()
  const nodeRows = db
    .query<{ span_start: number | null; span_end: number | null; calls_json: string | null }, []>(
      `SELECT n.span_start, n.span_end, n.calls_json FROM planning_decision_nodes n
       JOIN planning_decisions d ON d.id = n.decision_id${sql.replace("project_key", "d.project_key").replace("created_at", "d.created_at")}`,
    )
    .all(...(args as []))
  for (const node of nodeRows) {
    const chars = (node.span_end ?? 0) - (node.span_start ?? 0)
    for (const call of node.calls_json
      ? (JSON.parse(node.calls_json) as { elapsedMs: number }[])
      : []) {
      const label = bucketLabel(chars)
      latency.set(label, [...(latency.get(label) ?? []), call.elapsedMs])
    }
  }
  const nodeLatency = Object.fromEntries(
    [...latency.entries()].map(([label, values]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return [
        label,
        { calls: sorted.length, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95) },
      ]
    }),
  )
  return {
    decisions: { total: rows.length },
    byStatus: {
      ...byStatus,
    },
    belowThresholdRate: answered.length ? below.length / answered.length : 0,
    pickRate,
    flags,
    nodeLatency,
    strategies,
  }
}

export type ReplayResult = {
  strategy: string
  compared: number
  skipped: number
  sizeAgree: number
  simpleOrComplexAgree: number
  meanAbsScoreDelta: number
}

/** Re-run `decide` on recorded asks; compare with what was recorded. Writes nothing. */
export async function replayDecisions(
  db: Database,
  strategy: SlicerStrategy,
  decider: Parameters<typeof decide>[1]["decider"],
  filter: Filter = {},
): Promise<ReplayResult> {
  const { sql, args } = where(filter)
  const rows = db
    .query<Row, (string | number)[]>(
      `SELECT id, ask_text, strategy, status, reason, size, scores_json, selected_json FROM planning_decisions${sql}`,
    )
    .all(...args)
    .filter((row) => row.status !== "unavailable" && row.ask_text)
  let compared = 0
  let skipped = 0
  let sizeAgree = 0
  let simpleOrComplexAgree = 0
  let deltaSum = 0
  let deltaCount = 0
  for (const row of rows) {
    const outcome = await decide(row.ask_text, {
      decider,
      clock: () => performance.now(),
      constants: { strategy },
      signal: new AbortController().signal,
    })
    if (outcome.status !== "decided") {
      skipped++
      continue
    }
    compared++
    if (outcome.size === row.size) sizeAgree++
    if ((outcome.size === "one task") === (row.size === "one task")) simpleOrComplexAgree++
    const recorded = row.scores_json
      ? (JSON.parse(row.scores_json) as Record<string, { score: number }>)
      : {}
    for (const id of AGENT_ORDER)
      if (recorded[id]) {
        deltaSum += Math.abs(outcome.scores[id].score - recorded[id]!.score)
        deltaCount++
      }
  }
  return {
    strategy,
    compared,
    skipped,
    sizeAgree,
    simpleOrComplexAgree,
    meanAbsScoreDelta: deltaCount ? deltaSum / deltaCount : 0,
  }
}

function text(report: DecisionReport): string {
  const percent = (n: number) => `${(n * 100).toFixed(0)}%`
  return [
    `decisions: ${report.decisions.total} (${Object.entries(report.byStatus)
      .map(([status, n]) => `${status} ${n}`)
      .join(", ")})`,
    `below-threshold rate: ${percent(report.belowThresholdRate)}`,
    `pick rate: ${Object.entries(report.pickRate)
      .map(([id, rate]) => `${id} ${percent(rate)}`)
      .join(", ")}`,
    ...report.flags.map((f) => `flag: ${f.agent} ${f.flag}`),
    "node latency by input chars:",
    ...Object.entries(report.nodeLatency).map(
      ([label, v]) => `  ${label}: ${v.calls} calls, p50 ${v.p50Ms} ms, p95 ${v.p95Ms} ms`,
    ),
    `strategies: ${Object.entries(report.strategies)
      .map(([name, n]) => `${name} ${n}`)
      .join(", ")}`,
  ].join("\n")
}

/** Reviewed runs needed before the inactivity span is suggested from them. */
const MIN_RUNS_FOR_SPAN = 50
const SPAN_FLOOR_MS = 120_000

const planningScope = (filter: Filter, alias = "p") => {
  const clauses: string[] = []
  const args: (string | number)[] = []
  if (filter.project) (clauses.push(`${alias}.project_key=?`), args.push(filter.project))
  if (filter.since !== undefined) (clauses.push(`${alias}.created_at>=?`), args.push(filter.since))
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", args }
}

const camelRun = (row: Record<string, unknown>): StoredRun =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      value,
    ]),
  ) as unknown as StoredRun

type StoredRun = Parameters<typeof runsCost>[0][number]

type RunRow = {
  review_id: string
  agent: string
  attempt: number
  state: string
  reason: string | null
  max_gap_ms: number | null
  duration_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
}

export type ReviewsReport = {
  agents: Record<
    string,
    {
      reviews: number
      notRun: number
      notRunRate: number
      reasons: Record<string, number>
      tokens: { p50: number; p95: number }
      durationMs: { p50: number; p95: number }
      /** Absent when any of the agent's runs has no price. */
      costUSD?: number
    }
  >
  reviewedRuns: number
  inactivity:
    | { enough: false; runs: number; message: string }
    | {
        enough: true
        runs: number
        maxGapP99Ms: number
        suggestedMs: number
        currentMs: number
      }
}

/** Per agent: the share of reviews it did not complete and why, tokens and time, and the gap evidence. */
export function reviewsReport(
  db: Database,
  filter: Filter = {},
  price?: (model: { providerID: string; id: string }) => RunPrice | undefined,
): ReviewsReport {
  const { sql, args } = planningScope(filter)
  const runs = db
    .query<RunRow, (string | number)[]>(
      `SELECT r.review_id, r.agent, r.attempt, r.state, r.reason, r.max_gap_ms, r.duration_ms,
              r.input_tokens, r.output_tokens
         FROM planning_runs r
         JOIN planning_reviews v ON v.id=r.review_id
         JOIN planning_plannings p ON p.id=v.planning_id
        WHERE 1=1${sql}
        ORDER BY r.review_id, r.agent, r.attempt`,
    )
    .all(...args)
  const byUnit = new Map<string, RunRow[]>()
  for (const run of runs) {
    const key = `${run.review_id}\u0000${run.agent}`
    byUnit.set(key, [...(byUnit.get(key) ?? []), run])
  }
  const agents: ReviewsReport["agents"] = {}
  const perAgent = new Map<string, { tokens: number[]; durations: number[] }>()
  for (const attempts of byUnit.values()) {
    const last = attempts.at(-1)!
    const entry = (agents[last.agent] ??= {
      reviews: 0,
      notRun: 0,
      notRunRate: 0,
      reasons: {},
      tokens: { p50: 0, p95: 0 },
      durationMs: { p50: 0, p95: 0 },
    })
    entry.reviews++
    // An agent that answered `not-run` itself is also recorded as reviewed with a reason.
    const reviewed = last.state === "reviewed" && !last.reason
    if (!reviewed) {
      entry.notRun++
      const reason = (last.reason ?? last.state).split(":")[0]!.trim()
      entry.reasons[reason] = (entry.reasons[reason] ?? 0) + 1
    }
    const samples = perAgent.get(last.agent) ?? { tokens: [], durations: [] }
    for (const run of attempts)
      if (run.state === "reviewed") {
        samples.tokens.push((run.input_tokens ?? 0) + (run.output_tokens ?? 0))
        samples.durations.push(run.duration_ms ?? 0)
      }
    perAgent.set(last.agent, samples)
  }
  for (const [agent, entry] of Object.entries(agents)) {
    entry.notRunRate = entry.notRun / entry.reviews
    const samples = perAgent.get(agent)!
    const tokens = [...samples.tokens].sort((a, b) => a - b)
    const durations = [...samples.durations].sort((a, b) => a - b)
    entry.tokens = { p50: percentile(tokens, 0.5), p95: percentile(tokens, 0.95) }
    entry.durationMs = { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95) }
  }
  if (price)
    for (const [agent, entry] of Object.entries(agents)) {
      const own = db
        .query<Record<string, unknown>, (string | number)[]>(
          `SELECT r.* FROM planning_runs r JOIN planning_reviews v ON v.id=r.review_id
             JOIN planning_plannings p ON p.id=v.planning_id WHERE r.agent=?${sql}`,
        )
        .all(agent, ...args)
      const cost = runsCost(own.map(camelRun), price)
      if (cost !== undefined) entry.costUSD = cost
    }
  const gaps = runs
    .filter((run) => run.state === "reviewed" && run.max_gap_ms !== null)
    .map((run) => run.max_gap_ms!)
    .sort((a, b) => a - b)
  const reviewedRuns = runs.filter((run) => run.state === "reviewed").length
  const p99 = percentile(gaps, 0.99)
  return {
    agents,
    reviewedRuns,
    inactivity:
      reviewedRuns < MIN_RUNS_FOR_SPAN
        ? {
            enough: false,
            runs: reviewedRuns,
            message: `inactivity span: not enough runs (n=${reviewedRuns})`,
          }
        : {
            enough: true,
            runs: reviewedRuns,
            maxGapP99Ms: p99,
            suggestedMs: Math.max(SPAN_FLOOR_MS, Math.ceil((3 * p99) / 60_000) * 60_000),
            currentMs: PLANNING_AGENT_INACTIVITY_MS,
          },
  }
}

export type QuestionsReport = {
  raised: number
  conversation: number
  owner: number
  merged: number
  /** Still unrouted; absent when none. */
  open?: number
}

/** Where the agents' questions went: the Architect from the conversation, the owner, or merged. */
export function questionsReport(db: Database, filter: Filter = {}): QuestionsReport {
  const { sql, args } = planningScope(filter)
  const rows = db
    .query<{ route: string; n: number }, (string | number)[]>(
      `SELECT q.route, COUNT(*) AS n FROM planning_questions q
         JOIN planning_plannings p ON p.id=q.planning_id WHERE 1=1${sql} GROUP BY q.route`,
    )
    .all(...args)
  const n = (...routes: string[]) =>
    rows.filter((row) => routes.includes(row.route)).reduce((sum, row) => sum + row.n, 0)
  const open = n("open")
  return {
    raised: rows.reduce((sum, row) => sum + row.n, 0),
    conversation: n("conversation"),
    owner: n("owner", "owner-answered"),
    merged: n("merged"),
    ...(open ? { open } : {}),
  }
}

const SCOPE_EVENTS = ["SCOPE_AMENDED", "SCOPE_SENT_BACK", "SCOPE_DECISION_REQUIRED"]
const COMBINED_FAILURE = "Combined verification%"

type Counts = {
  plans: number
  repairs: number
  scopeAmended: number
  scopeStops: number
  takeovers: number
  failedCombinedChecks: number
}

export type OutcomesReport = {
  planned: Counts
  /** The same counts over plans the planning flow did not create. */
  baseline: Counts
  findings: {
    scored: number
    predicted: number
    byField: Record<string, { scored: number; predicted: number }>
    list: { findingID: string; draftID: string; field: string; predicted: boolean }[]
  }
}

function counts(db: Database, planIDs: string[]): Counts {
  const count = (sql: string) =>
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM runner_transitions WHERE plan_id IN (SELECT value FROM json_each(?)) AND ${sql}`,
      )
      .get(JSON.stringify(planIDs))!.n
  return {
    plans: planIDs.length,
    repairs: count("event='REPAIR'"),
    scopeAmended: count("event='SCOPE_AMENDED'"),
    scopeStops: count("event IN ('SCOPE_SENT_BACK','SCOPE_DECISION_REQUIRED')"),
    takeovers: count("event='TAKEOVER_STARTED'"),
    failedCombinedChecks: count(
      `event='BLOCKED' AND task_id IS NULL AND json_extract(payload,'$.reason') LIKE '${COMBINED_FAILURE}'`,
    ),
  }
}

/**
 * What happened to the plans the flow created, against plans it did not, and whether each
 * finding's prediction came true: a write-scope finding against the task's scope events, an
 * acceptance or verification finding against its repairs. Other fields are not scored.
 */
export function outcomesReport(db: Database, filter: Filter = {}): OutcomesReport {
  const { sql, args } = planningScope(filter)
  const tasked = db
    .query<
      { planning_id: string; draft_id: string; task_id: string; plan_id: string },
      (string | number)[]
    >(
      `SELECT t.planning_id, t.draft_id, t.task_id, p.tasked_plan_id AS plan_id
         FROM planning_tasked t JOIN planning_plannings p ON p.id=t.planning_id
        WHERE p.tasked_plan_id IS NOT NULL${sql}`,
    )
    .all(...args)
  const plannedPlans = [...new Set(tasked.map((row) => row.plan_id))]
  const all = db
    .query<{ id: string }, []>("SELECT id FROM runner_plans")
    .all()
    .map((row) => row.id)
  const baseline = all.filter((id) => !plannedPlans.includes(id))
  const event = db.query<{ n: number }, [string, string, string]>(
    `SELECT COUNT(*) AS n FROM runner_transitions WHERE plan_id=? AND task_id=? AND event IN (SELECT value FROM json_each(?))`,
  )
  const taskEvents = (row: { plan_id: string; task_id: string }, events: string[]) =>
    event.get(row.plan_id, row.task_id, JSON.stringify(events))!.n
  const list: OutcomesReport["findings"]["list"] = []
  const byField: OutcomesReport["findings"]["byField"] = {}
  for (const row of tasked) {
    const found = db
      .query<{ id: string; field: string | null }, [string, string]>(
        "SELECT id, field FROM planning_findings WHERE planning_id=? AND draft_id=?",
      )
      .all(row.planning_id, row.draft_id)
    for (const finding of found) {
      const field = finding.field ?? "other"
      const predicted =
        field === "write-scope"
          ? taskEvents(row, SCOPE_EVENTS) > 0
          : field === "acceptance" || field === "verification"
            ? taskEvents(row, ["REPAIR"]) > 0
            : undefined
      if (predicted === undefined) continue
      list.push({ findingID: finding.id, draftID: row.draft_id, field, predicted })
      const entry = (byField[field] ??= { scored: 0, predicted: 0 })
      entry.scored++
      if (predicted) entry.predicted++
    }
  }
  return {
    planned: counts(db, plannedPlans),
    baseline: counts(db, baseline),
    findings: {
      scored: list.length,
      predicted: list.filter((item) => item.predicted).length,
      byField,
      list,
    },
  }
}

function sectionsText(db: Database, filter: Filter): string {
  const reviews = reviewsReport(db, filter)
  const questions = questionsReport(db, filter)
  const outcomes = outcomesReport(db, filter)
  const percent = (n: number) => `${(n * 100).toFixed(0)}%`
  const row = (c: Counts) =>
    `${c.plans} plans · repairs ${c.repairs} · scope amended ${c.scopeAmended} · scope stops ${c.scopeStops} · takeovers ${c.takeovers} · failed combined checks ${c.failedCombinedChecks}`
  return [
    "reviews:",
    ...Object.entries(reviews.agents).map(
      ([agent, v]) =>
        `  ${agent}: ${v.reviews} reviews, not run ${percent(v.notRunRate)} (${
          Object.entries(v.reasons)
            .map(([reason, n]) => `${reason} ${n}`)
            .join(", ") || "none"
        }) · tokens p50 ${v.tokens.p50} p95 ${v.tokens.p95} · ${v.durationMs.p50} ms p50, ${v.durationMs.p95} ms p95`,
    ),
    reviews.inactivity.enough
      ? `  inactivity span: p99 gap ${reviews.inactivity.maxGapP99Ms} ms, suggested ${reviews.inactivity.suggestedMs} ms (current ${reviews.inactivity.currentMs} ms)`
      : `  ${reviews.inactivity.message}`,
    `questions: ${questions.raised} raised · conversation ${questions.conversation} · owner ${questions.owner} · merged ${questions.merged}`,
    "outcomes:",
    `  planned: ${row(outcomes.planned)}`,
    `  baseline: ${row(outcomes.baseline)}`,
    `  findings predicted: ${outcomes.findings.predicted} of ${outcomes.findings.scored} scored`,
  ].join("\n")
}

async function main() {
  const args = process.argv.slice(2)
  const value = (name: string) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const path = value("--db") ?? join(homedir(), ".local/share/opencode/plugins/lazers/tasks.sqlite")
  const since = value("--since")
  const filter: Filter = {
    project: value("--project"),
    since: since ? Date.parse(since) : undefined,
  }
  const db = new Database(`file:${path}?mode=ro`, { readonly: true })
  const report = decisionReport(db, filter)
  if ("empty" in report && !reviewsReport(db, filter).reviewedRuns) {
    const withText =
      db
        .query<{ n: number }, []>("SELECT COUNT(*) n FROM planning_decisions WHERE ask_text<>''")
        .get()?.n ?? 0
    console.error(`no recorded decisions (0 rows; asks with text: ${withText})`)
    process.exit(2)
  }
  if (args.includes("--replay")) {
    const endpoint = await Service.discover()
    if (!endpoint) throw new Error("The local OpenCode Desktop service is unavailable")
    const rpc = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }).rpc(
      LocalInference,
    )
    const decider = localDecider(
      { attached: () => true },
      () => true,
      (input) => rpc.systemOne(SystemOneRequest.parse(input)) as never,
    )
    const strategy = (value("--strategy") ?? "windows") as SlicerStrategy
    const result = await replayDecisions(db, strategy, decider, filter)
    console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : JSON.stringify(result))
    return
  }
  const all = {
    decisions: "empty" in report ? null : report,
    reviews: reviewsReport(db, filter),
    questions: questionsReport(db, filter),
    outcomes: outcomesReport(db, filter),
  }
  console.log(
    args.includes("--json")
      ? JSON.stringify(all, null, 2)
      : ["empty" in report ? "no recorded decisions" : text(report), sectionsText(db, filter)].join(
          "\n",
        ),
  )
}

if (import.meta.main) await main()

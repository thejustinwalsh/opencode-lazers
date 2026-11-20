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
  if ("empty" in report) {
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
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : text(report))
}

if (import.meta.main) await main()

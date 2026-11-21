import { translateRuntimeWords } from "./event-names.ts"
import { compactCount } from "./projection.ts"
import type { TrajectoryAttempt, TrajectoryEvent, TrajectoryReport } from "./projection.ts"

/**
 * Pure derivations for the attempt details pane: the Summary rows, the reason an attempt ended,
 * the cost figure and its `partial` rule, the coverage bar and the rates table. Each omits what is
 * not recorded instead of labelling it unknown.
 */

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`

const WORK_KINDS = new Set(["tool", "worker-tool", "shell", "worker-shell"])
const MODEL_KINDS = new Set(["assistant-step", "worker-step"])
const SETUP_EFFECTS = ["prompt", "session", "worktree"] as const
const TERMINAL_VERBS: Record<string, string> = {
  accepted: "accepted",
  completed: "completed",
  succeeded: "completed",
  failed: "marked failed",
  cancelled: "cancelled",
}

const timeOf = (event: TrajectoryEvent) =>
  typeof event.at === "number" && Number.isFinite(event.at) ? event.at : null

/**
 * The loaded events that belong to one attempt, in time order: those recorded against it, plus
 * plan-level events (no attempt) from its start until the next attempt starts. The first attempt
 * also takes plan events recorded before it.
 */
export function eventsForAttempt(
  events: readonly TrajectoryEvent[],
  attempt: Pick<TrajectoryAttempt, "id" | "number" | "startedAt" | "intervals">,
  attempts: ReadonlyArray<Pick<TrajectoryAttempt, "id" | "number" | "startedAt" | "intervals">>,
) {
  const start = attempt.intervals.attempt.startedAt ?? attempt.startedAt
  const next = attempts
    .filter((other) => other.number > attempt.number)
    .map((other) => other.intervals.attempt.startedAt ?? other.startedAt)
    .sort((a, b) => a - b)[0]
  const first = !attempts.some((other) => other.number < attempt.number)
  const seen = new Set<string>()
  return events
    .filter((event) => {
      if (seen.has(event.id)) return false
      seen.add(event.id)
      if (event.attemptID) return event.attemptID === attempt.id
      const at = timeOf(event)
      if (at === null) return false
      return (first || at >= start) && (next === undefined || at < next)
    })
    .sort((a, b) => (timeOf(a) ?? 0) - (timeOf(b) ?? 0) || a.id.localeCompare(b.id))
}

export type SummaryRow = {
  label: "Setup" | "Work" | "Errors" | "End"
  text: string
  /** Elapsed time of the phase, in ms. */
  durationMs?: number
  /** Clock time the phase ended. */
  at?: number
  /** Errors links to the events filtered to them. */
  action?: "errors"
}

/** Recording-gap events plus the report's data notes: one count for Summary and Gaps. */
export const recordGapCount = (events: readonly TrajectoryEvent[], notes: readonly string[]) =>
  events.filter((event) => event.kind === "worker-gap").length + notes.length

const workerDone = (events: readonly TrajectoryEvent[]) =>
  events.some(
    (event) =>
      event.kind === "worker-execution-outcome" ||
      (event.kind === "runner-transition" && event.event === "WORKER_STOPPED"),
  )

function andList(items: readonly string[]) {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

/**
 * Setup, Work, Errors and End from the attempt's recorded events. A row whose facts are not
 * recorded is not returned; Errors appears only when there are errors.
 */
export function attemptSummary(input: {
  events: readonly TrajectoryEvent[]
  state: string
  calls: number
  files: number
  /** Gaps in the record: `recordGapCount(events, notes)`, the number the Gaps disclosure shows. */
  gaps: number
  /** Tool names of failed calls, one per call. */
  failedCalls: readonly string[]
  attemptStart: number | null
  attemptEnd: number | null
}): SummaryRow[] {
  const rows: SummaryRow[] = []
  const { events } = input
  const work = events.flatMap((event) => (WORK_KINDS.has(event.kind) ? [timeOf(event)] : []))
  const times = work.filter((time): time is number => time !== null)
  const firstWork =
    times.length > 0
      ? Math.min(...times)
      : (events
          .filter((event) => MODEL_KINDS.has(event.kind))
          .map(timeOf)
          .find((time): time is number => time !== null) ?? null)

  const ready = SETUP_EFFECTS.filter((name) =>
    events.some(
      (event) =>
        event.kind === "runner-effect" && event.effect === name && event.state === "completed",
    ),
  )
  if (ready.length > 0) {
    const capital = `${ready[0]![0]!.toUpperCase()}${ready[0]!.slice(1)}`
    const text = `${andList([capital, ...ready.slice(1)])} ready`
    rows.push({
      label: "Setup",
      text,
      ...(input.attemptStart !== null && firstWork !== null && firstWork >= input.attemptStart
        ? { durationMs: firstWork - input.attemptStart }
        : {}),
    })
  }

  // Work is a count, not a second duration: Duration in the stat row is the one time measure.
  if (input.calls > 0)
    rows.push({
      label: "Work",
      text: `${plural(input.calls, "tool call")}${
        input.files > 0 ? ` across ${plural(input.files, "file")}` : ""
      }`,
    })

  const failedByTool = new Map<string, number>()
  for (const tool of input.failedCalls) failedByTool.set(tool, (failedByTool.get(tool) ?? 0) + 1)
  const count = (kinds: readonly string[]) =>
    events.filter((event) => kinds.includes(event.kind)).length
  const retries = Math.max(count(["provider-retry"]), count(["worker-provider-retry"]))
  const gaps = input.gaps
  const modelErrors = count(["assistant-error"])
  const failedChecks = events.filter(
    (event) =>
      (event.kind === "verification" || event.kind === "worker-verification") &&
      event.status === "failed",
  ).length
  const errors = [
    ...[...failedByTool].map(
      ([tool, n]) => `${n.toLocaleString()} ${tool} ${n === 1 ? "failure" : "failures"}`,
    ),
    ...(failedChecks ? [plural(failedChecks, "failed check")] : []),
    ...(modelErrors ? [plural(modelErrors, "model error")] : []),
    ...(retries ? [plural(retries, "provider retry", "provider retries")] : []),
    ...(gaps ? [plural(gaps, "gap")] : []),
  ]
  if (errors.length > 0) rows.push({ label: "Errors", text: errors.join(" · "), action: "errors" })

  const verb = TERMINAL_VERBS[input.state]
  if (verb) {
    const endEvent = [...events]
      .reverse()
      .find(
        (event) =>
          event.kind === "worker-execution-outcome" ||
          (event.kind === "runner-transition" &&
            (event.event === "WORKER_STOPPED" || event.event === "CANCEL_REQUESTED")),
      )
    const at = input.attemptEnd ?? (endEvent ? timeOf(endEvent) : null)
    rows.push({
      label: "End",
      text: workerDone(events)
        ? `Worker finished, then the attempt was ${verb}`
        : `The attempt was ${verb}`,
      ...(at !== null ? { at } : {}),
    })
  }
  return rows
}

const sentence = (text: string, max = 220) => {
  const flat = text.replace(/\s+/g, " ").trim()
  const first = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat
  const clipped = first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped}.`
}

const errorMessage = (error: unknown) => {
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message
    return typeof message === "string" ? message : ""
  }
  return ""
}

export type EndReason = { text: string; raw?: string; tone: string }

/**
 * Why an attempt that did not succeed ended, from what was recorded: the last reason on a runner
 * transition (cancel or block reason), then a worker outcome reason or error, then the last
 * failed check or model error. Runtime wording is translated. Nothing recorded means no callout.
 */
export function endReason(input: {
  state: string
  events: readonly TrajectoryEvent[]
}): EndReason | null {
  if (input.state !== "failed" && input.state !== "cancelled") return null
  const lead =
    input.state === "cancelled"
      ? workerDone(input.events)
        ? "Cancelled after the worker finished."
        : "Cancelled."
      : "Failed."
  const reversed = [...input.events].reverse()
  const candidates: string[] = []
  for (const event of reversed)
    if (event.kind === "runner-transition" && event.reason) candidates.push(event.reason)
  for (const event of reversed)
    if (event.kind === "worker-execution-outcome") {
      if (event.reason) candidates.push(event.reason)
      const message = errorMessage(event.error)
      if (message) candidates.push(message)
    }
  for (const event of reversed) {
    if (event.kind === "verification" && event.status === "failed") {
      const message = errorMessage(event.error)
      candidates.push(
        message ? `Check ${event.checkID ?? ""} failed: ${message}`.replace("  ", " ") : "",
      )
    }
    if (event.kind === "assistant-error") {
      const message = errorMessage(event.error)
      if (message) candidates.push(message)
    }
  }
  const raw = candidates.find((candidate) => candidate.trim().length > 0)
  if (!raw) return null
  const shown = sentence(translateRuntimeWords(raw))
  return {
    text: `${lead} ${shown}`,
    ...(raw.trim() !== shown && raw.trim().length > shown.length ? { raw: raw.trim() } : {}),
    tone: input.state === "failed" ? "failed" : "cancelled",
  }
}

type MarketCost = NonNullable<TrajectoryReport["effort"]["marketEquivalentCost"]>

/** `$0.03`; a positive amount under half a cent is `<$0.01`. */
export function usd(value: number) {
  if (value > 0 && value < 0.005) return "<$0.01"
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const sourceLabel = (source: string) => (source === "openrouter-models" ? "OpenRouter" : "OpenCode")
const shortDate = (value: string | number) =>
  new Date(value).toLocaleDateString("en-US", { day: "numeric", month: "short" })

const CATEGORY_WORDS = {
  uncachedInput: "input",
  output: "output",
  reasoning: "reasoning",
  cacheRead: "cache reads",
  cacheWrite: "cache writes",
} as const

/** Categories with recorded tokens that no price covers, across the priced sessions. */
function unpricedCategories(cost: MarketCost | undefined) {
  const names = new Set<string>()
  for (const session of cost?.sessions ?? [])
    for (const [key, category] of Object.entries(session.categories))
      if (
        (category.status === "unknown" || category.status === "unavailable") &&
        (category.tokens ?? 0) > 0 &&
        key in CATEGORY_WORDS
      )
        names.add(CATEGORY_WORDS[key as keyof typeof CATEGORY_WORDS])
  return [...names]
}

export type CostView = {
  /** Two decimals; a range reads `$0.02–$0.04`. */
  value: string
  /** Some recorded usage has no price: the figure is a floor, not the whole. */
  partial: boolean
  /** `OpenRouter`, `OpenCode`. */
  source: string
  /** `Nov 19`. */
  date: string
}

/**
 * The one cost figure. The observed-usage estimate is the figure when it has one; otherwise the
 * strict price-index total. No price from any source means no cost at all. `partial` is set when
 * the estimate says so, only a priced portion exists, or any session or usage category is
 * unpriced; the figure is never shown beside a second, conflicting label.
 */
export function costView(report: Pick<TrajectoryReport, "effort">): CostView | null {
  const cost = report.effort.marketEquivalentCost
  const estimate = cost?.observedUsageEstimate
  const apiCost = report.effort.recordedCost.apiEquivalentTotalUsd
  let value = ""
  let partial = false
  if (estimate?.valueUSD !== null && estimate?.valueUSD !== undefined)
    value = usd(estimate.valueUSD)
  else if (estimate?.rangeUSD)
    value = `${usd(estimate.rangeUSD.minimum)}–${usd(estimate.rangeUSD.maximum)}`
  else if (estimate?.pricedPortionUSD) {
    const { minimum, maximum } = estimate.pricedPortionUSD
    value = minimum === maximum ? usd(minimum) : `${usd(minimum)}–${usd(maximum)}`
    partial = true
  } else if (apiCost !== null) value = usd(apiCost)
  else if (cost?.subtotalUSD && cost.subtotalUSD > 0) {
    value = usd(cost.subtotalUSD)
    partial = true
  }
  if (!value) return null
  const priceSource = estimate?.sources[0]
    ? { source: estimate.sources[0].source, at: estimate.sources[0].retrievedAt }
    : cost?.currentIndex?.sources[0]
      ? { source: cost.currentIndex.sources[0].source, at: cost.currentIndex.retrievedAt }
      : null
  if (!priceSource) return null
  // The figure and its label read the same basis: the estimate's own token coverage when the
  // estimate is the figure, the index sessions only when the index total is.
  if (estimate && estimate.sources.length > 0) {
    if (estimateShare(report).unpriced > 0 && estimate.status === "partial") partial = true
  } else if (
    (cost?.coverage.partialSessions ?? 0) > 0 ||
    (cost?.coverage.unpricedSessionIDs.length ?? 0) > 0 ||
    unpricedCategories(cost).length > 0
  )
    partial = true
  return {
    value,
    partial,
    source: sourceLabel(priceSource.source),
    date: shortDate(priceSource.at),
  }
}

/** Tokens in (uncached plus cache reads and writes) and out, as `1.2M in · 3.9k out`. */
export function tokensText(usage: TrajectoryReport["effort"]["tokenUsage"]) {
  const count = (key: keyof TrajectoryReport["effort"]["tokenUsage"]["measuredSubtotal"]) =>
    usage.total?.[key] ?? usage.measuredSubtotal[key]
  const inputs = (["uncachedInput", "cacheRead", "cacheWrite"] as const).map(count)
  const input = inputs.every((value) => value === null)
    ? null
    : inputs.reduce<number>((sum, value) => sum + (value ?? 0), 0)
  const output = count("output")
  return [
    input === null ? "" : `${compactCount(input)} in`,
    output === null ? "" : `${compactCount(output)} out`,
  ]
    .filter(Boolean)
    .join(" · ")
}

export type CoverageView = {
  priced: number
  unpriced: number
  caption: string
  note?: string
  /** `OpenRouter prices · Nov 19`. */
  aside: string
}

/**
 * The priced and unpriced share of recorded tokens, with what has no price named. Falls back to
 * session counts when token weights are not recorded. Nothing is returned when no source prices
 * the usage.
 */
export function coverageView(report: Pick<TrajectoryReport, "effort">): CoverageView | null {
  const cost = report.effort.marketEquivalentCost
  const view = costView(report)
  if (!cost || !view) return null
  const estimate = cost.observedUsageEstimate
  let priced = 0
  let unpriced = 0
  let names: string[]
  if (estimate && estimate.sources.length > 0) {
    const share = estimateShare(report)
    priced = share.priced
    unpriced = estimate.status === "partial" ? share.unpriced : 0
    names = unpriced > 0 ? share.names : []
  } else {
    for (const session of cost.sessions)
      for (const category of Object.values(session.categories)) {
        const tokens = category.tokens ?? 0
        if (category.status === "valued") priced += tokens
        else if (category.status === "unknown" || category.status === "unavailable")
          unpriced += tokens
      }
    names = unpricedCategories(cost)
    if (priced + unpriced === 0) {
      priced = cost.coverage.pricedSessions
      unpriced = Math.max(0, cost.coverage.totalUniqueSessions - cost.coverage.pricedSessions)
    }
  }
  if (priced + unpriced === 0) priced = 1
  const caption = estimate
    ? `${plural(estimate.retainedCallCount, "call")} priced`
    : `${cost.coverage.pricedSessions} of ${plural(cost.coverage.totalUniqueSessions, "session")} priced`
  return {
    priced,
    unpriced,
    caption,
    ...(names.length > 0 ? { note: `${andList(names)} have no published price` } : {}),
    aside: `${view.source} prices · ${view.date}`,
  }
}

/**
 * Tokens the estimate priced against the tokens the report measured, per category. The estimate
 * prices retained call measurements; any measured token beyond them has no price.
 */
function estimateShare(report: Pick<TrajectoryReport, "effort">) {
  const usage = report.effort.tokenUsage
  const categories = report.effort.marketEquivalentCost?.observedUsageEstimate?.categories
  let priced = 0
  let unpriced = 0
  const names: string[] = []
  for (const key of Object.keys(CATEGORY_WORDS) as Array<keyof typeof CATEGORY_WORDS>) {
    const total = usage.total?.[key] ?? usage.measuredSubtotal[key]
    const known = categories?.[key].tokens ?? 0
    if (total === null) {
      priced += known
      continue
    }
    priced += Math.min(known, total)
    const missing = Math.max(0, total - known)
    unpriced += missing
    if (missing > 0) names.push(CATEGORY_WORDS[key])
  }
  return { priced, unpriced, names }
}

export type RateRow = { tier: string; cells: [string, string, string, string] }

/** USD per token as a per-million figure with at most three significant digits. */
export function perMillion(perToken: string | null) {
  if (perToken === null) return ""
  const value = Number(perToken) * 1e6
  if (!Number.isFinite(value)) return ""
  return `$${Number(value.toPrecision(3)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
}

/** Selected rates as table rows: tier, input, output, cache read, cache write per million tokens. */
export function ratesRows(report: Pick<TrajectoryReport, "effort">): RateRow[] {
  const sets = report.effort.marketEquivalentCost?.observedUsageEstimate?.rateSets ?? []
  return sets.map((set) => ({
    tier:
      set.minPromptTokens !== null
        ? `Over ${compactCount(set.minPromptTokens)} prompt`
        : set.contextTierTokens !== null
          ? `${compactCount(set.contextTierTokens)} context`
          : "Base",
    cells: [
      perMillion(set.prompt),
      perMillion(set.completion),
      perMillion(set.cacheRead),
      perMillion(set.cacheWrite),
    ],
  }))
}

/** At most three short lines that qualify the cost; each only when it applies. */
export function caveats(report: Pick<TrajectoryReport, "effort">): string[] {
  const estimate = report.effort.marketEquivalentCost?.observedUsageEstimate
  if (!estimate) return []
  const lines = ["Market value of recorded usage at current published rates, not a bill."]
  if (estimate.recoveryGapCount > 0)
    lines.push(`${plural(estimate.recoveryGapCount, "recording gap")}: usage may be incomplete.`)
  if (estimate.freshness === "stale") lines.push("Prices are stale.")
  else if (
    estimate.tierAttribution.status === "unresolved" ||
    estimate.tierAttribution.status === "unsupported"
  )
    lines.push("Rate tier is not resolved per call.")
  return lines.slice(0, 3)
}

/** Price source ids for the Identifiers disclosure: index hash, snapshots and the source URL. */
export function priceIdentifiers(report: Pick<TrajectoryReport, "effort">) {
  const cost = report.effort.marketEquivalentCost
  const items: Array<{ label: string; value: string }> = []
  if (cost?.currentIndex) items.push({ label: "Price index", value: cost.currentIndex.indexID })
  for (const source of cost?.observedUsageEstimate?.sources ?? []) {
    items.push({ label: `${sourceLabel(source.source)} snapshot`, value: source.snapshotID })
    items.push({ label: `${sourceLabel(source.source)} URL`, value: source.sourceURL })
  }
  return items
}

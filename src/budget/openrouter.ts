import { Schema } from "effect"
import { unavailable } from "./contract.ts"
import type { Usage } from "./contract.ts"
import type { UsageFetch } from "./usage.ts"

const counter = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
export const Baseline = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  timezone: Schema.String,
  observedAt: Schema.Finite,
  credit: counter,
  byok: counter,
  lastCredit: counter,
  lastByok: counter,
})
export type Baseline = typeof Baseline.Type
export type Week = { start: number; end: number; timezone: string }
export type Counters = { credit: number; byok: number }

export function parseCounters(body: unknown): Counters {
  if (
    !body ||
    typeof body !== "object" ||
    !("data" in body) ||
    !body.data ||
    typeof body.data !== "object"
  )
    throw new Error("Invalid counters")
  const d = body.data as Record<string, unknown>
  if (![d.usage, d.byok_usage].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0))
    throw new Error("Invalid counters")
  if (!Number.isFinite((d.usage as number) + (d.byok_usage as number)))
    throw new Error("Invalid counters")
  return { credit: d.usage as number, byok: d.byok_usage as number }
}

export async function fetchCounters(key: string, signal: AbortSignal, fetcher: UsageFetch = fetch) {
  const response = await fetcher("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    redirect: "error",
    signal,
  })
  if (!response.ok) throw new Error("Usage unavailable")
  return parseCounters(await response.json())
}

/** No interpolation across a Sunday, timezone change, rotation, rollback or missing history. */
export function observe(
  previous: Baseline | undefined,
  counters: Counters,
  week: Week,
  now = Date.now(),
): { baseline: Baseline; usage: Usage } {
  if (
    !Number.isFinite(week.start) ||
    !Number.isFinite(week.end) ||
    week.start > now ||
    week.end <= now ||
    week.end - week.start < 6 * 86400000 ||
    week.end - week.start > 8 * 86400000 ||
    !week.timezone
  )
    throw new Error("Invalid local week")
  const reset =
    !previous ||
    previous.start !== week.start ||
    previous.end !== week.end ||
    previous.timezone !== week.timezone ||
    previous.observedAt > now ||
    counters.credit < previous.lastCredit ||
    counters.byok < previous.lastByok
  if (reset)
    return {
      baseline: {
        ...week,
        observedAt: now,
        credit: counters.credit,
        byok: counters.byok,
        lastCredit: counters.credit,
        lastByok: counters.byok,
      },
      usage: {
        ...unavailable("Tracking started; earlier weekly usage unknown."),
        observedAt: now,
        coverageStart: now,
      },
    }
  return {
    baseline: { ...previous, lastCredit: counters.credit, lastByok: counters.byok },
    usage: {
      ...unavailable(),
      status: "available",
      reason: "Configured key only · since observed baseline; earlier weekly usage unknown.",
      creditUSD: counters.credit - previous.credit,
      byokUSD: counters.byok - previous.byok,
      coverageStart: previous.observedAt,
      observedAt: now,
    },
  }
}

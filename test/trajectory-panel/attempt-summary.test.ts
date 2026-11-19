import { expect, test } from "bun:test"
import {
  attemptSummary,
  caveats,
  costView,
  coverageView,
  endReason,
  eventsForAttempt,
  perMillion,
  ratesRows,
  tokensText,
  usd,
} from "../../src/trajectory-panel/attempt-summary.ts"
import type { TrajectoryEvent, TrajectoryReport } from "../../src/trajectory-panel/projection.ts"

const event = (fields: Partial<TrajectoryEvent> & { kind: string }): TrajectoryEvent =>
  ({ id: `${fields.kind}-${fields.at ?? 0}-${Math.random()}`, ...fields }) as TrajectoryEvent

const setup = ["prompt", "session", "worktree"].map((effect, index) =>
  event({
    kind: "runner-effect",
    effect,
    state: "completed",
    at: 1_000 + index,
    attemptID: "a1",
  }),
)

test("summary rows come from the recorded events and omit what is not recorded", () => {
  const events = [
    ...setup,
    event({ kind: "worker-tool", tool: "shell", status: "completed", at: 3_000, attemptID: "a1" }),
    event({ kind: "worker-tool", tool: "shell", status: "failed", at: 9_000, attemptID: "a1" }),
    event({ kind: "worker-provider-retry", at: 4_000, attemptID: "a1" }),
    event({ kind: "worker-gap", at: 5_000, attemptID: "a1", reason: "gap" }),
    event({ kind: "worker-gap", at: 6_000, attemptID: "a1", reason: "gap" }),
    event({ kind: "worker-execution-outcome", at: 10_000, attemptID: "a1" }),
  ]
  const rows = attemptSummary({
    events,
    state: "cancelled",
    calls: 37,
    files: 13,
    gaps: 3,
    failedCalls: ["shell", "shell"],
    attemptStart: 1_000,
    attemptEnd: 12_000,
  })
  expect(rows.map((row) => row.label)).toEqual(["Setup", "Work", "Errors", "End"])
  expect(rows[0]).toMatchObject({ text: "Prompt, session and worktree ready", durationMs: 2_000 })
  expect(rows[1]).toMatchObject({ text: "37 tool calls across 13 files" })
  expect(rows[1]!.durationMs).toBeUndefined()
  expect(rows[2]).toMatchObject({
    text: "2 shell failures · 1 provider retry · 3 gaps",
    action: "errors",
  })
  expect(rows[3]).toMatchObject({
    text: "Worker finished, then the attempt was cancelled",
    at: 12_000,
  })
})

test("Errors appears only when there are errors; a missing phase is left out", () => {
  const clean = attemptSummary({
    events: [event({ kind: "worker-tool", tool: "read", status: "completed", at: 2_000 })],
    state: "running",
    calls: 1,
    files: 0,
    gaps: 0,
    failedCalls: [],
    attemptStart: 1_000,
    attemptEnd: null,
  })
  // No setup effects, no errors, and a running attempt has no End.
  expect(clean.map((row) => row.label)).toEqual(["Work"])
  expect(clean[0]!.text).toBe("1 tool call")
  expect(
    attemptSummary({
      events: [],
      state: "accepted",
      calls: 0,
      files: 0,
      gaps: 0,
      failedCalls: [],
      attemptStart: null,
      attemptEnd: null,
    }),
  ).toEqual([{ label: "End", text: "The attempt was accepted" }])
})

test("the reason an attempt ended is the recorded one, in words", () => {
  const events = [
    event({ kind: "worker-execution-outcome", at: 5 }),
    event({
      kind: "runner-transition",
      event: "CANCEL_REQUESTED",
      at: 6,
      reason: "Driver check: changes were not integrated. More detail follows here.",
    }),
  ]
  const reason = endReason({ state: "cancelled", events })
  expect(reason?.text).toBe(
    "Cancelled after the worker finished. Driver check: changes were not integrated.",
  )
  expect(reason?.tone).toBe("cancelled")
  expect(reason?.raw).toContain("More detail follows here.")
  // Runtime tokens in the reason are translated.
  expect(
    endReason({
      state: "failed",
      events: [event({ kind: "runner-transition", at: 1, reason: "Stopped by WORKER_STOPPED" })],
    })?.text,
  ).toBe("Failed. Stopped by worker stopped.")
  // No recorded reason, no callout; a successful attempt never has one.
  expect(endReason({ state: "cancelled", events: [] })).toBeNull()
  expect(endReason({ state: "accepted", events })).toBeNull()
  expect(
    endReason({
      state: "failed",
      events: [event({ kind: "assistant-error", at: 1, error: { message: "Rate limited" } })],
    })?.text,
  ).toBe("Failed. Rate limited.")
})

test("events belong to an attempt by id or by time between attempt starts", () => {
  const attempts = [
    { id: "a1", number: 1, startedAt: 100, intervals: { attempt: { startedAt: 100 } } },
    { id: "a2", number: 2, startedAt: 500, intervals: { attempt: { startedAt: 500 } } },
  ] as never
  const events = [
    event({ kind: "runner-transition", id: "early", at: 50 }),
    event({ kind: "runner-transition", id: "mid", at: 300 }),
    event({ kind: "runner-transition", id: "late", at: 700 }),
    event({ kind: "worker-tool", id: "mine", at: 650, attemptID: "a1" }),
    event({ kind: "worker-tool", id: "undated" }),
  ]
  const ids = (n: number) =>
    eventsForAttempt(events, (attempts as Array<{ number: number }>)[n - 1] as never, attempts).map(
      (item) => item.id,
    )
  expect(ids(1)).toEqual(["early", "mid", "mine"])
  expect(ids(2)).toEqual(["late"])
})

function report(
  cost: Record<string, unknown> | undefined,
  recorded: number | null = null,
): Pick<TrajectoryReport, "effort"> {
  return {
    effort: {
      tokenUsage: {
        measuredSubtotal: {
          uncachedInput: 1_000,
          cacheRead: 1_200_000,
          cacheWrite: 0,
          output: 3_900,
          reasoning: 9_600,
        },
        total: null,
        knownSessions: 1,
        totalSessions: 1,
        unknownAttempts: [],
      },
      recordedCost: { apiEquivalentTotalUsd: recorded },
      marketEquivalentCost: cost,
    },
  } as never
}

const source = {
  source: "openrouter-models",
  snapshotID: "f99000f5-7142-4651-8aca-eca04d35461a",
  generation: 5,
  currentGeneration: 5,
  retrievedAt: "2026-11-19T12:57:51.000Z",
  freshness: "current",
  priceBasis: "average",
  sourceURL: "https://openrouter.ai/api/v1/models",
}
const category = (status: string, tokens: number | null) => ({
  tokens,
  rateUSDPerToken: null,
  valueUSD: null,
  status,
  reason: null,
})
const priced = (over: Record<string, unknown> = {}) => ({
  valueUSD: null,
  subtotalUSD: null,
  currentIndex: null,
  coverage: {
    totalUniqueSessions: 1,
    pricedSessions: 1,
    partialSessions: 0,
    unpricedSessionIDs: [],
  },
  sessions: [
    {
      categories: {
        uncachedInput: category("valued", 1_000),
        output: category("valued", 3_900),
        reasoning: category("valued", 9_600),
        cacheRead: category("valued", 1_200_000),
        cacheWrite: category("zero-usage", 0),
      },
    },
  ],
  observedUsageEstimate: {
    status: "estimate",
    valueUSD: 0.0159,
    rangeUSD: null,
    pricedPortionUSD: null,
    sources: [source],
    rateSets: [
      {
        tierID: "base",
        minPromptTokens: null,
        contextTierTokens: null,
        prompt: "0.0000001",
        completion: "0.0000005",
        cacheRead: "0.00000001",
        cacheWrite: "0.000000125",
      },
      {
        tierID: "prompt-272000",
        minPromptTokens: 272_000,
        contextTierTokens: null,
        prompt: "0.0000002",
        completion: null,
        cacheRead: null,
        cacheWrite: null,
      },
    ],
    retainedCallCount: 24,
    recoveryGapCount: 2,
    freshness: "current",
    tierAttribution: { status: "resolved-per-call" },
  },
  ...over,
})

test("the cost is one figure at two decimals, partial when anything is unpriced", () => {
  expect(usd(0.0159)).toBe("$0.02")
  expect(usd(0.001)).toBe("<$0.01")
  expect(usd(1234.5)).toBe("$1,234.50")
  expect(costView(report(priced()))).toEqual({
    value: "$0.02",
    partial: false,
    source: "OpenRouter",
    date: "Nov 19",
  })
  // The audit case: a figure beside "price missing". One figure, one label.
  const unpriced = priced({
    coverage: {
      totalUniqueSessions: 1,
      pricedSessions: 0,
      partialSessions: 1,
      unpricedSessionIDs: ["s1"],
    },
    observedUsageEstimate: {
      ...priced().observedUsageEstimate,
      valueUSD: null,
      status: "partial",
      pricedPortionUSD: { minimum: 0.031, maximum: 0.031 },
    },
  })
  expect(costView(report(unpriced))).toMatchObject({ value: "$0.03", partial: true })
  // A range reads as a range.
  expect(
    costView(
      report(
        priced({
          observedUsageEstimate: {
            ...priced().observedUsageEstimate,
            valueUSD: null,
            rangeUSD: { minimum: 0.02, maximum: 0.04 },
          },
        }),
      ),
    )?.value,
  ).toBe("$0.02–$0.04")
  // The strict-index total stands in when there is no estimate.
  expect(
    costView(
      report(
        priced({
          observedUsageEstimate: undefined,
          currentIndex: {
            retrievedAt: "2026-11-19T00:00:00.000Z",
            indexID: "x",
            sources: [{ source: "native-catalog" }],
          },
        }),
        0.0319,
      ),
    ),
  ).toMatchObject({ value: "$0.03", source: "OpenCode" })
})

test("no price source means no cost at all", () => {
  expect(costView(report(undefined))).toBeNull()
  expect(costView(report(undefined, 0.5))).toBeNull()
  expect(
    costView(report(priced({ observedUsageEstimate: undefined, currentIndex: null }))),
  ).toBeNull()
  expect(coverageView(report(undefined))).toBeNull()
  expect(caveats(report(undefined))).toEqual([])
  expect(ratesRows(report(undefined))).toEqual([])
})

test("a partially priced estimate: the bar, caption and cost agree", () => {
  // The estimate priced 8,000 of 10,000 recorded tokens; the strict-index sessions are all
  // unpriced. The figure came from the estimate, so the bar reads the estimate, not the sessions.
  const unpricedSession = {
    categories: {
      uncachedInput: category("unknown", 1_000),
      output: category("unknown", 3_900),
      reasoning: category("unknown", 9_600),
      cacheRead: category("unknown", 1_200_000),
      cacheWrite: category("zero-usage", 0),
    },
  }
  const estimate = priced().observedUsageEstimate
  const cost = priced({
    sessions: [unpricedSession],
    coverage: {
      totalUniqueSessions: 1,
      pricedSessions: 0,
      partialSessions: 1,
      unpricedSessionIDs: ["s1"],
    },
    observedUsageEstimate: {
      ...estimate,
      status: "partial",
      valueUSD: null,
      pricedPortionUSD: { minimum: 0.12, maximum: 0.12 },
      retainedCallCount: 57,
      categories: {
        uncachedInput: { tokens: 1_000, status: "observed" },
        output: { tokens: 3_900, status: "observed" },
        reasoning: { tokens: 9_600, status: "observed" },
        cacheRead: { tokens: 600_000, status: "partial" },
        cacheWrite: { tokens: null, status: "missing" },
      },
    },
  })
  const view = coverageView(report(cost))!
  // Some tokens are priced, so the bar is not all warning colour, and the cost is partial.
  expect(view.priced).toBeGreaterThan(0)
  expect(view.priced).toBe(1_000 + 3_900 + 9_600 + 600_000)
  expect(view.unpriced).toBe(600_000)
  expect(view.note).toBe("cache reads have no published price")
  expect(view.caption).toBe("57 calls priced")
  expect(costView(report(cost))).toMatchObject({ value: "$0.12", partial: true })
})

test("an exact estimate is fully priced even when the index sessions are not", () => {
  const cost = priced({
    coverage: {
      totalUniqueSessions: 1,
      pricedSessions: 0,
      partialSessions: 1,
      unpricedSessionIDs: ["s1"],
    },
    sessions: [{ categories: { output: category("unknown", 5) } }],
  })
  expect(costView(report(cost))?.partial).toBe(false)
  expect(coverageView(report(cost))).toMatchObject({ unpriced: 0 })
})

test("index-priced usage with an unpriced category is partial", () => {
  const cost = priced({
    observedUsageEstimate: undefined,
    currentIndex: {
      retrievedAt: "2026-11-19T00:00:00.000Z",
      indexID: "x",
      sources: [{ source: "native-catalog" }],
    },
    sessions: [
      {
        categories: {
          uncachedInput: category("valued", 1_000),
          output: category("valued", 3_000),
          reasoning: category("valued", 0),
          cacheRead: category("valued", 4_000),
          cacheWrite: category("unknown", 2_000),
        },
      },
    ],
  })
  expect(costView(report(cost, 0.5))?.partial).toBe(true)
  expect(coverageView(report(cost, 0.5))).toMatchObject({
    priced: 8_000,
    unpriced: 2_000,
    note: "cache writes have no published price",
  })
})

test("rates are a per-million table and the caveats stay at three lines or fewer", () => {
  expect(perMillion("0.0000001")).toBe("$0.10")
  expect(perMillion("0.000000125")).toBe("$0.125")
  expect(perMillion(null)).toBe("")
  expect(ratesRows(report(priced()))).toEqual([
    { tier: "Base", cells: ["$0.10", "$0.50", "$0.01", "$0.125"] },
    { tier: "Over 272k prompt", cells: ["$0.20", "", "", ""] },
  ])
  const lines = caveats(report(priced()))
  expect(lines).toEqual([
    "Market value of recorded usage at current published rates, not a bill.",
    "2 recording gaps: usage may be incomplete.",
  ])
  const stale = priced({
    observedUsageEstimate: {
      ...priced().observedUsageEstimate,
      freshness: "stale",
      tierAttribution: { status: "unresolved" },
    },
  })
  expect(caveats(report(stale)).length).toBeLessThanOrEqual(3)
})

test("tokens read as in and out", () => {
  expect(tokensText(report(priced()).effort.tokenUsage)).toBe("1.2M in · 3.9k out")
})

test("an attempt with no recorded usage or cost shows no tokens, no cost and no coverage", () => {
  const none = {
    uncachedInput: null,
    cacheRead: null,
    cacheWrite: null,
    output: null,
    reasoning: null,
  }
  const report = {
    effort: {
      tokenUsage: { measuredSubtotal: none, total: null },
      recordedCost: { apiEquivalentTotalUsd: null },
    },
  } as unknown as TrajectoryReport
  expect(tokensText(report.effort.tokenUsage)).toBe("")
  expect(costView(report)).toBeNull()
  expect(coverageView(report)).toBeNull()
  expect(caveats(report)).toEqual([])
})

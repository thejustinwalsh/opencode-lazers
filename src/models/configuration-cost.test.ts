import { expect, test } from "bun:test"
import { comparisonChartMarks, referenceAmount } from "./chart-data.ts"
import type { ComparisonChartPoint, ComparisonChartReference } from "./chart-data.ts"
import { configurationCost, costLine, costPosition, costText } from "./configuration-cost.ts"
import type { ModelDecisionReferenceEstimate } from "./reference-estimate.ts"

const route = (modelID: string) => ({ providerID: "openai", modelID, variant: "max" })

const point = (id: string, usd: number): ComparisonChartPoint => ({
  configurationID: id,
  groupID: id,
  label: id,
  tokensPerAcceptedTask: 1e6,
  currentMarketUSDPerAcceptedTask: usd,
  observationCount: 3,
  acceptedTaskCount: 3,
  terminalTaskCount: 4,
  partial: false,
  route: route(id),
})

const reference = (
  id: string,
  estimate: Partial<ModelDecisionReferenceEstimate>,
): ComparisonChartReference => ({
  configurationID: id,
  label: id,
  tokensPerAcceptedTask: 1e6,
  estimate: {
    status: "exact",
    route: route(id),
    acceptedTaskCount: 3,
    valueUSDPerAcceptedTask: null,
    rangeUSDPerAcceptedTask: null,
    knownSubtotalUSDPerAcceptedTask: null,
    knownSubtotalRangeUSDPerAcceptedTask: null,
    provenance: {
      source: "openrouter-models",
      retrievedAt: "2026-11-21T02:34:44.000Z",
      freshness: "current",
    },
    coverage: { categories: {} },
    ...estimate,
  } as ModelDecisionReferenceEstimate,
})

/** A full estimate, the live GPT-6 Luna partial range, a conditional range and an unpriced one. */
const points = [point("full", 0.44), point("luna", 0.57)]
const references = [
  reference("full", { status: "exact", valueUSDPerAcceptedTask: 0.44 }),
  reference("luna", {
    status: "partial",
    knownSubtotalRangeUSDPerAcceptedTask: { minimum: 0.57, maximum: 1.09 },
  }),
  reference("conditional", {
    status: "conditional",
    rangeUSDPerAcceptedTask: { minimum: 0.2, maximum: 0.3 },
  }),
  reference("unpriced", { status: "unavailable" }),
]
const costOf = (id: string) =>
  configurationCost({
    basis: "observed",
    route: route(id),
    point: points.find((item) => item.configurationID === id) ?? null,
    reference: references.find((item) => item.configurationID === id)?.estimate ?? null,
    tokensPerAcceptedTask: 1e6,
    market: { source: "openrouter", retrievedAt: "2026-11-21T02:34:44.000Z" },
  })

test("the stored cost equals the chart's and the table's former values and range ends", () => {
  // The former chart path: one mark per configuration (amount, and the range when one).
  const marks = new Map(
    comparisonChartMarks({ points, references, frontierConfigurationIDs: [] }).map((mark) => [
      mark.configurationID,
      mark,
    ]),
  )
  for (const id of ["full", "luna", "conditional"]) {
    const mark = marks.get(id)!
    const cost = costOf(id)
    if (mark.range) {
      expect(cost).toMatchObject({
        kind: "range",
        low: mark.range.minimum,
        high: mark.range.maximum,
      })
    } else expect(cost).toMatchObject({ kind: "value", low: mark.amount, high: mark.amount })
    // The former table path: the reference's own amount.
    const amount = referenceAmount(
      references.find((item) => item.configurationID === id)!.estimate,
    )!
    if ("minimum" in amount) expect([cost.low, cost.high]).toEqual([amount.minimum, amount.maximum])
    else expect(cost.low).toBe(amount.value)
  }
  // Unpriced: neither path drew or listed it; the stored cost is `none`, with no price at all.
  expect(marks.has("unpriced")).toBe(false)
  expect(costOf("unpriced")).toMatchObject({ kind: "none", low: null, high: null })
  expect(costText(costOf("unpriced"))).toBe("")
  expect(costLine(costOf("unpriced"))).toBe("")
})

test("a range is written as a range and positioned at its midpoint, never at its low end", () => {
  const luna = costOf("luna")
  expect(costText(luna)).toBe("$0.57–$1.09")
  expect(costLine(luna)).toBe("Observed in your runs: $0.57–$1.09")
  expect(costPosition(luna)).toBeCloseTo(0.83)
  expect(luna).toMatchObject({
    basis: "observed",
    status: "partial",
    provenance: {
      source: "openrouter",
      retrievedAt: "2026-11-21T02:34:44.000Z",
      route: { providerID: "openai", modelID: "luna", variant: "max" },
    },
  })
  expect(costText(costOf("full"))).toBe("$0.44")
})

test("a projected cost is list price × median tokens, labelled projected, `none` without a price", () => {
  const profile = {
    uncachedInput: 1_000_000,
    cacheRead: 0,
    cacheWrite: 0,
    output: 200_000,
    reasoning: 100_000,
    acceptedTasks: 4,
  }
  const price = {
    source: "openrouter" as const,
    input: 2,
    output: 10,
    cacheRead: null,
    cacheWrite: null,
    blended: 4,
    appliesBelowTokens: null,
    retrievedAt: "2026-11-21T02:34:44.000Z",
  }
  const projected = configurationCost({
    basis: "projected",
    route: { providerID: "openai", modelID: "luna", variant: null },
    price,
    profile,
  })
  expect(projected).toMatchObject({ kind: "value", low: 5, high: 5, status: "projected" })
  expect(costLine(projected)).toBe("Projected from list prices × your median tokens: $5")
  expect(
    configurationCost({
      basis: "projected",
      route: projected.provenance.route,
      price: null,
      profile,
    }),
  ).toMatchObject({ kind: "none", low: null, status: "unpriced" })
})

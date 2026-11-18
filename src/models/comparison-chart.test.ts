import { afterAll, expect, test } from "bun:test"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type {
  ComparisonChartPoint,
  ComparisonChartReference,
  ComparisonChartTheme,
} from "./comparison-chart.tsx"
import { ModelDecisionReferenceEstimateSchema } from "./reference-estimate.ts"
import type { ModelDecisionReferenceEstimate } from "./reference-estimate.ts"

const vite = await createServer({
  configFile: false,
  plugins: [solid()],
  server: { middlewareMode: true, ws: false },
  appType: "custom",
})
afterAll(() => vite.close())
const {
  comparisonChartEmptyText,
  comparisonChartHasPlottablePoints,
  comparisonChartKeyboardOrder,
  comparisonChartOptions,
  comparisonChartPointText,
  comparisonChartReferenceText,
  comparisonChartResponsiveLayout,
  comparisonChartReferenceTooltip,
  compactTokenAxisValue,
} = (await vite.ssrLoadModule(
  "/src/models/comparison-chart.tsx",
)) as typeof import("./comparison-chart.tsx")

const theme: ComparisonChartTheme = {
  surface: "native-surface",
  text: "native-text",
  mutedText: "native-muted",
  grid: "native-grid",
  accent: "native-accent",
  fontFamily: "Native Sans",
  monoFontFamily: "Native Mono",
}
const points: ComparisonChartPoint[] = [
  {
    configurationID: "opaque/config::one/with:separators",
    groupID: "opaque-group/one",
    label: "One · high",
    tokensPerAcceptedTask: 12_345.5,
    currentMarketUSDPerAcceptedTask: 0.123456,
    observationCount: 1,
    acceptedTaskCount: 1,
    partial: false,
  },
  {
    configurationID: "opaque/config::two",
    groupID: "opaque-group/two",
    label: "Two",
    tokensPerAcceptedTask: 30_000,
    currentMarketUSDPerAcceptedTask: 0.2,
    observationCount: 4,
    acceptedTaskCount: 3,
    partial: false,
  },
]

function referenceEstimate(
  status: "exact" | "conditional" | "partial",
): ModelDecisionReferenceEstimate {
  const common = {
    basis: "openrouter-published-model-reference-cost-per-accepted-task" as const,
    route: { providerID: "openai", modelID: "gpt-6", variant: "high" },
    acceptedTaskCount: 4,
    identityStatus: "exact" as const,
    provenance: {
      source: "openrouter-models" as const,
      policyRevision: 2,
      availability: "available" as const,
      access: "configured" as const,
      snapshotID: "11111111-1111-4111-8111-111111111111",
      generation: 7,
      retrievedAt: "2026-11-06T12:00:00.000Z",
      sourceURL: "https://openrouter.ai/api/v1/models",
      recordID: "openai/gpt-6",
      recordIndex: 0,
      freshness: "current" as const,
    },
    coverage: {
      categories: {
        uncachedInput: {
          tokens: 10,
          status: "observed" as const,
          rateCoverage: "complete" as const,
        },
        output: { tokens: 4, status: "observed" as const, rateCoverage: "complete" as const },
        reasoning: { tokens: 2, status: "observed" as const, rateCoverage: "complete" as const },
        cacheRead: {
          tokens: 0,
          status: "observed" as const,
          rateCoverage: "not-required" as const,
        },
        cacheWrite: {
          tokens: 0,
          status: "observed" as const,
          rateCoverage: "not-required" as const,
        },
      },
      retries: {
        status: "complete" as const,
        attemptCount: 5,
        failedAttemptCount: 1,
        retryAttemptCount: 1,
        attemptsWithCompleteUsage: 5,
        failedAttemptsWithCompleteUsage: 1,
        retryAttemptsWithCompleteUsage: 1,
      },
      attribution: {
        status: "complete" as const,
        relatedTaskCount: 4,
        unknownRouteTaskCount: 0,
        relatedSessionCount: 5,
        matchedRouteSessionCount: 5,
        includedSessionCount: 5,
        otherRouteSessionCount: 0,
        mixedRouteSessionCount: 0,
        unknownRouteSessionCount: 0,
        sharedSessionCount: 0,
        unattributedSessionCount: 0,
      },
    },
    reasons: [] as Array<never>,
  }
  if (status === "exact")
    return ModelDecisionReferenceEstimateSchema.parse({
      ...common,
      status,
      numeratorUSD: 0.0000000000123,
      numeratorRangeUSD: null,
      valueUSDPerAcceptedTask: 0.000000000003075,
      rangeUSDPerAcceptedTask: null,
      knownSubtotalUSD: null,
      knownSubtotalRangeUSD: null,
      knownSubtotalUSDPerAcceptedTask: null,
      knownSubtotalRangeUSDPerAcceptedTask: null,
    })
  if (status === "conditional")
    return ModelDecisionReferenceEstimateSchema.parse({
      ...common,
      status,
      numeratorUSD: null,
      numeratorRangeUSD: { minimum: 0.00000004, maximum: 0.00000012 },
      valueUSDPerAcceptedTask: null,
      rangeUSDPerAcceptedTask: { minimum: 0.00000001, maximum: 0.00000003 },
      knownSubtotalUSD: null,
      knownSubtotalRangeUSD: null,
      knownSubtotalUSDPerAcceptedTask: null,
      knownSubtotalRangeUSDPerAcceptedTask: null,
    })
  return ModelDecisionReferenceEstimateSchema.parse({
    ...common,
    status,
    numeratorUSD: null,
    numeratorRangeUSD: null,
    valueUSDPerAcceptedTask: null,
    rangeUSDPerAcceptedTask: null,
    knownSubtotalUSD: 0.00000002,
    knownSubtotalRangeUSD: null,
    knownSubtotalUSDPerAcceptedTask: 0.000000005,
    knownSubtotalRangeUSDPerAcceptedTask: null,
  })
}

function chartReference(
  configurationID: string,
  status: "exact" | "conditional" | "partial",
  tokensPerAcceptedTask: number | null,
): ComparisonChartReference {
  return {
    configurationID,
    label: `Reference ${configurationID}`,
    tokensPerAcceptedTask,
    estimate: referenceEstimate(status),
  }
}

test("options preserve literal coordinates and only authoritative frontier members", () => {
  const option = comparisonChartOptions(
    {
      points,
      frontierConfigurationIDs: [
        points[1]!.configurationID,
        points[0]!.configurationID,
        "not-an-observation",
      ],
      selectedConfigurationID: points[0]!.configurationID,
    },
    theme,
  )
  const scatterData = option.series[0]!.data.filter((datum) => !Array.isArray(datum)) as Array<{
    value: number[]
    configurationID: string
    symbolSize?: number
  }>
  expect(scatterData.map((datum) => datum.value)).toEqual([
    [12_345.5, 0.123456],
    [30_000, 0.2],
  ])
  expect(scatterData.map((datum) => datum.configurationID)).toEqual(
    points.map((point) => point.configurationID),
  )
  expect(scatterData[0]?.symbolSize).toBe(14)
  expect(option.series[1]!.data).toEqual([
    [12_345.5, 0.123456],
    [30_000, 0.2],
  ])
  expect(option.series[1]!.smooth).toBe(false)
  expect(option.series[1]!.connectNulls).toBe(false)
  expect(option.xAxis.name).toBe("Tokens / accepted task")
  expect(option.yAxis.name).toBe("USD / accepted task")
  expect(option.textStyle.fontFamily).toBe("Native Sans")
  expect(option.xAxis.axisLabel.fontFamily).toBe("Native Mono")
  expect(option.xAxis.axisLabel.formatter).toBe(compactTokenAxisValue)
  expect(compactTokenAxisValue(12_345.5)).toBe("12.3K")
  expect(compactTokenAxisValue(3_000_000)).toBe("3M")
  expect(comparisonChartPointText(points[0]!)).toContain("$0.123456")
  expect(comparisonChartPointText(points[0]!)).toContain("1 observation")
  expect(comparisonChartHasPlottablePoints(points)).toBe(true)
})

test("synthetic crowded labels are bounded, shifted and moved away from the right plot edge", () => {
  const synthetic: ComparisonChartPoint[] = [
    {
      ...points[1]!,
      label: "Synthetic extremely long provider and model identity alpha",
      tokensPerAcceptedTask: 30_000,
      currentMarketUSDPerAcceptedTask: 0.2,
    },
    {
      ...points[1]!,
      configurationID: "synthetic-neighbor",
      groupID: "synthetic-group-neighbor",
      label: "Synthetic extremely long provider and model identity beta",
      tokensPerAcceptedTask: 30_001,
      currentMarketUSDPerAcceptedTask: 0.20001,
    },
  ]
  const option = comparisonChartOptions({ points: synthetic, frontierConfigurationIDs: [] }, theme)
  const series = option.series[0]!
  const labels = (series.data as Array<{ label: { formatter: string } } | number[]>).map(
    (datum) => {
      if (Array.isArray(datum)) throw new Error("Expected scatter point data")
      return datum.label.formatter
    },
  )
  expect(labels.every((label) => typeof label === "string" && Array.from(label).length <= 18)).toBe(
    true,
  )
  expect(labels[0]).toBe("Synthetic extreme…")
  expect(series.data.map((datum) => (Array.isArray(datum) ? datum : datum.value))).toEqual([
    [30_000, 0.2],
    [30_001, 0.20001],
  ])
  expect(
    (series.data as Array<{ label: { position: string } } | number[]>).map((datum) =>
      Array.isArray(datum) ? "" : datum.label.position,
    ),
  ).toEqual(["left", "left"])
  expect(series.labelLayout).toEqual({ hideOverlap: true, moveOverlap: "shiftY" })
  expect(option.aria.description).toContain(synthetic[0]!.label)
  expect(option.aria.description).toContain("30,001 actual tokens per accepted task")
})

test("missing measurements are not converted to zero and a singleton emits no frontier line", () => {
  const singleton = comparisonChartOptions(
    { points: [points[0]!], frontierConfigurationIDs: [points[0]!.configurationID] },
    theme,
  )
  expect(singleton.series[0]!.data).toHaveLength(1)
  expect(singleton.series[1]!.data).toEqual([])

  const invalidPoints = [
    { ...points[0]!, tokensPerAcceptedTask: null },
    { ...points[1]!, currentMarketUSDPerAcceptedTask: Number.NaN },
  ] as unknown as ComparisonChartPoint[]
  const invalid = comparisonChartOptions(
    {
      points: invalidPoints,
      frontierConfigurationIDs: points.map((point) => point.configurationID),
    },
    theme,
  )
  expect(invalid.series[0]!.data).toEqual([])
  expect(invalid.series[1]!.data).toEqual([])
  expect(comparisonChartHasPlottablePoints(invalidPoints)).toBe(false)
  expect(invalid.aria.description).toContain("Unknown prices")
  expect(invalid.aria.description).toContain("zero-accepted")
  expect(invalid.aria.description).not.toContain("0 tokens per accepted task")
})

test("reference scalars, conditional envelopes and priced subtotals remain distinct non-frontier marks", () => {
  const scalar = chartReference("reference:scalar", "exact", 12_000)
  const conditional = chartReference("reference:range", "conditional", 18_000)
  const subtotal = chartReference("reference:subtotal", "partial", 24_000)
  const missingCoordinate = chartReference("reference:missing-coordinate", "partial", null)
  const references = [scalar, conditional, subtotal, missingCoordinate]
  const option = comparisonChartOptions(
    {
      points: [],
      references,
      frontierConfigurationIDs: [scalar.configurationID, conditional.configurationID],
    },
    theme,
  )
  expect(comparisonChartHasPlottablePoints([], references)).toBe(true)
  expect(option.series[0]!.data).toEqual([])
  expect(option.series[1]!.data).toEqual([])
  expect(
    option.series.find((series) => series.id === "openrouter-reference-scalars")?.data,
  ).toEqual([
    expect.objectContaining({
      value: [12_000, 0.000000000003075],
      configurationID: scalar.configurationID,
      symbol: "triangle",
      markKind: "reference",
    }),
  ])
  expect(
    option.series.find((series) => series.id === "openrouter-conditional-ranges")?.data,
  ).toEqual([
    expect.objectContaining({
      value: [18_000, 0.00000001, 0.00000003],
      configurationID: conditional.configurationID,
    }),
  ])
  expect(
    option.series.find((series) => series.id === "openrouter-reference-subtotals")?.data,
  ).toEqual([
    expect.objectContaining({
      value: [24_000, 0.000000005],
      configurationID: subtotal.configurationID,
      markKind: "reference",
    }),
  ])
  const allSeriesData = option.series.flatMap((series) => series.data as unknown[])
  expect(
    allSeriesData.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "configurationID" in item &&
        item.configurationID === missingCoordinate.configurationID,
    ),
  ).toBe(false)
  expect(option.series[1]!.data).not.toContainEqual(
    expect.arrayContaining([12_000, 0.000000000003075]),
  )
  const scalarTooltip = option.tooltip.formatter({
    data: { configurationID: scalar.configurationID, markKind: "reference" },
  })
  const rangeTooltip = option.tooltip.formatter({
    data: { configurationID: conditional.configurationID, markKind: "reference" },
  })
  const subtotalTooltip = option.tooltip.formatter({
    data: { configurationID: subtotal.configurationID, markKind: "reference" },
  })
  // Tooltips are terse: model and cost only; provenance stays in Chart data and details.
  expect(scalarTooltip).toBe("Reference reference:scalar · high · ≈$3.08e-12 / task")
  expect(rangeTooltip).toContain("≈$1e-8–$3e-8 / task")
  expect(rangeTooltip).not.toContain("conditional")
  // A known subtotal is shown as a lower bound, never as a total.
  expect(subtotalTooltip).toMatch(/ · ≥\$[^ ]+ \/ task$/)
  for (const tooltip of [scalarTooltip, rangeTooltip, subtotalTooltip]) {
    expect(tooltip).not.toContain("exact route")
    expect(tooltip).not.toContain("accepted task")
    expect(tooltip).not.toContain("OpenRouter")
  }
  expect(comparisonChartReferenceText(scalar)).toContain("exact route openai / gpt-6 · high")
  expect(comparisonChartReferenceText(scalar)).toContain(
    "basis OpenRouter model catalog reference cost per accepted task",
  )
  expect(option.aria.description).toContain("denominator 4 accepted tasks")
  expect(option.aria.description).toContain("not plotted because a numeric actual cohort token")
  expect(comparisonChartReferenceText(missingCoordinate)).toContain("token coordinate unknown")
})

test("responsive layout budgets axis ticks and margins for width, height, and inherited font", () => {
  const narrow = comparisonChartResponsiveLayout(330, 190, 20)
  const medium = comparisonChartResponsiveLayout(450, 230, 20)
  const wide = comparisonChartResponsiveLayout(960, 320, 20)

  expect(narrow.fontSize).toBe(20)
  expect(narrow.xSplitNumber).toBe(2)
  expect(narrow.ySplitNumber).toBe(2)
  expect(medium.xSplitNumber).toBeGreaterThan(narrow.xSplitNumber)
  expect(wide.xSplitNumber).toBeGreaterThan(medium.xSplitNumber)
  expect(wide.ySplitNumber).toBeGreaterThan(narrow.ySplitNumber)
  expect(narrow.grid.left).toBeGreaterThan(comparisonChartResponsiveLayout(330, 190, 12).grid.left)
  expect(narrow.grid.bottom).toBeGreaterThan(
    comparisonChartResponsiveLayout(330, 190, 12).grid.bottom,
  )
  const compactAxisOptions = comparisonChartOptions(
    { points, frontierConfigurationIDs: [] },
    theme,
    narrow,
  )
  expect(compactAxisOptions.yAxis.name).toBe("USD / task")
  expect(compactAxisOptions.yAxis.axisLabel.formatter(0.0000000000123)).toBe("$1.23e-11")
  expect(
    comparisonChartOptions(
      { points, frontierConfigurationIDs: [] },
      theme,
      comparisonChartResponsiveLayout(330, 190, 12),
    ).yAxis.name,
  ).toBe("USD / task")
  const wideAxisOptions = comparisonChartOptions(
    { points, frontierConfigurationIDs: [] },
    theme,
    wide,
  )
  expect(wideAxisOptions.yAxis.name).toBe("USD / accepted task")
})

test("narrow plots keep at most three y ticks and wide plots keep more", () => {
  const narrow = comparisonChartResponsiveLayout(360, 420, 12)
  const wide = comparisonChartResponsiveLayout(800, 420, 12)
  expect(narrow.ySplitNumber).toBeLessThanOrEqual(3)
  expect(wide.ySplitNumber).toBeGreaterThan(3)
})

test("the selected point gets a halo and the others do not", () => {
  const option = comparisonChartOptions(
    {
      points,
      frontierConfigurationIDs: [],
      selectedConfigurationID: points[0]!.configurationID,
    },
    theme,
  )
  const data = option.series[0]!.data.filter((datum) => !Array.isArray(datum)) as Array<{
    itemStyle: { shadowBlur?: number }
  }>
  expect(data[0]?.itemStyle.shadowBlur).toBeGreaterThan(0)
  expect(data[1]?.itemStyle.shadowBlur).toBeUndefined()
})

test("selected point and every reference amount kind receive readable identity labels", () => {
  const selectedPoint = {
    ...points[0]!,
    configurationID: "selected:point",
    label: "GPT-6 Luna · openai / gpt-6-luna · high",
    route: { providerID: "openai", modelID: "gpt-6-luna", variant: "high" },
    tokensPerAcceptedTask: 12_000,
    currentMarketUSDPerAcceptedTask: 0.1,
  }
  const nearbyPoint = {
    ...selectedPoint,
    configurationID: "nearby:point",
    label: "Nearby model",
    tokensPerAcceptedTask: 12_001,
    currentMarketUSDPerAcceptedTask: 0.10001,
  }
  const references = [
    chartReference("selected:scalar", "exact", 12_000),
    chartReference("selected:range", "conditional", 12_000),
    chartReference("selected:subtotal", "partial", 12_000),
  ]
  const selectedRange = chartReference("selected:subtotal-range", "partial", 12_000)
  selectedRange.estimate = ModelDecisionReferenceEstimateSchema.parse({
    ...selectedRange.estimate,
    knownSubtotalUSD: null,
    knownSubtotalRangeUSD: { minimum: 0.00002, maximum: 0.00005 },
    knownSubtotalUSDPerAcceptedTask: null,
    knownSubtotalRangeUSDPerAcceptedTask: { minimum: 0.000005, maximum: 0.0000125 },
  })
  references.push(selectedRange)

  for (const configurationID of [
    selectedPoint.configurationID,
    ...references.map((reference) => reference.configurationID),
  ]) {
    const option = comparisonChartOptions(
      {
        points: [selectedPoint, nearbyPoint],
        references,
        frontierConfigurationIDs: [],
        selectedConfigurationID: configurationID,
      },
      theme,
    )
    const identities = option.series.find((series) => series.id === "selected-identities")
    expect(identities?.data).toContainEqual(
      expect.objectContaining({ configurationID, markKind: "selected-identity" }),
    )
    if (configurationID === selectedPoint.configurationID) {
      const observations = option.series.find((series) => series.id === "observations")!
      expect(observations.data[0]).toMatchObject({
        configurationID,
        symbolSize: 14,
        label: { show: false },
      })
      expect(identities?.data).toContainEqual(
        expect.objectContaining({
          configurationID,
          name: "GPT-6 Luna · high",
          value: [12_000, 0.1],
        }),
      )
      const tooltip = option.tooltip.formatter({
        data: { configurationID, markKind: "canonical" },
      })
      expect(tooltip).toBe("GPT-6 Luna · high · ≈$0.1 / task")
      expect(observations.data[1]).toMatchObject({
        configurationID: nearbyPoint.configurationID,
        label: { show: true },
      })
    }
    expect(identities?.label).toMatchObject({ show: true })
    expect(typeof identities?.labelLayout).toBe("function")
  }

  const unplottable = chartReference("missing:selected", "partial", null)
  const absent = comparisonChartOptions(
    {
      points: [],
      references: [unplottable],
      frontierConfigurationIDs: [],
      selectedConfigurationID: unplottable.configurationID,
    },
    theme,
  )
  expect(absent.series.find((series) => series.id === "selected-identities")?.data).toEqual([])
  expect(comparisonChartReferenceTooltip(references[1]!)).toMatch(/ · ≈\$[^ ]+–\$[^ ]+ \/ task$/)
})

test("empty chart copy names the missing data and never offers a zero cost", () => {
  expect(comparisonChartEmptyText([], [])).toBe(
    "No accepted tasks match these filters yet. Models appear here once a task is accepted and a price source covers the model.",
  )
  const unmeasured = chartReference("empty:unmeasured", "exact", null)
  const text = comparisonChartEmptyText([], [unmeasured])
  expect(text).toContain("1 model has no token measurements")
  expect(text).toContain("Chart data lists each model")
  expect(text).not.toContain("$0")
})

test("keyboard order visits each plotted model once from fewest to most tokens", () => {
  const references = [
    chartReference("keyboard:scalar", "exact", 18_000),
    chartReference("keyboard:range", "conditional", 6_000),
    chartReference("keyboard:subtotal", "partial", 30_000),
    chartReference("keyboard:unplotted", "exact", null),
  ]
  const order = comparisonChartKeyboardOrder(points, references)
  expect(order.some((choice) => choice.configurationID === "keyboard:unplotted")).toBe(false)
  expect(order.map((choice) => choice.tokens)).toEqual(
    order.map((choice) => choice.tokens).toSorted((left, right) => left - right),
  )
  expect(new Set(order.map((choice) => choice.configurationID)).size).toBe(order.length)
  for (const choice of order) expect(choice.label).toMatch(/ · [≈≥]\$[^ ]+ \/ task$/)
})

type FrontierLine = {
  id: string
  name: string
  type: string
  data: unknown[]
  z?: number
  silent: boolean
  smooth: boolean
  connectNulls: boolean
  showSymbol: boolean
  lineStyle: unknown
  emphasis: unknown
  blur: { lineStyle: { opacity: number } }
  endLabel: { show: boolean } & Record<string, unknown>
}

test("observed frontier is a visible dashed accent line with an end label and deterministic ties", () => {
  const tied = (id: string, tokens: number, cost: number): ComparisonChartPoint => ({
    ...points[0]!,
    configurationID: id,
    tokensPerAcceptedTask: tokens,
    currentMarketUSDPerAcceptedTask: cost,
  })
  const members = [
    tied("b", 100, 0.5),
    tied("a", 100, 0.5),
    tied("c", 100, 0.4),
    tied("d", 50, 0.9),
  ]
  const options = (ids: ComparisonChartPoint[]) =>
    comparisonChartOptions(
      { points: ids, frontierConfigurationIDs: ["a", "b", "c", "d", "ghost"] },
      theme,
    )
  const forward = options(members).series[1] as unknown as FrontierLine
  expect(forward.id).toBe("authoritative-frontier")
  expect(forward.data).toEqual([
    [50, 0.9],
    [100, 0.4],
    [100, 0.5],
    [100, 0.5],
  ])
  expect((options(members.toReversed()).series[1] as unknown as FrontierLine).data).toEqual(
    forward.data,
  )
  expect(forward.lineStyle).toEqual({ color: "native-accent", width: 2, type: "dashed" })
  expect(forward.z).toBe(1)
  expect(forward.silent).toBe(true)
  expect(forward.emphasis).toEqual({ disabled: true })
  expect(forward.blur.lineStyle.opacity).toBe(1)
  expect(forward.endLabel).toMatchObject({
    show: true,
    formatter: "Observed frontier",
    color: "native-muted",
    fontFamily: "Native Sans",
  })
  const single = options([members[0]!]).series[1] as unknown as FrontierLine
  expect(single.data).toEqual([])
  expect(single.endLabel.show).toBe(false)
})

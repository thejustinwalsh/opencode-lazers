import { afterAll, expect, test } from "bun:test"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { ComparisonChartPoint, ComparisonChartTheme } from "./comparison-chart.tsx"

const vite = await createServer({
  configFile: false,
  plugins: [solid()],
  server: { middlewareMode: true, ws: false },
  appType: "custom",
})
afterAll(() => vite.close())
const { comparisonChartOptions, comparisonChartPointText } = (await vite.ssrLoadModule(
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
  const scatterData = option.series[0]!.data.filter(
    (
      datum,
    ): datum is Extract<(typeof option.series)[0]["data"][number], { configurationID: string }> =>
      !Array.isArray(datum),
  )
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
  expect(option.yAxis.name).toBe("Current market USD / accepted task")
  expect(option.textStyle.fontFamily).toBe("Native Sans")
  expect(option.xAxis.axisLabel.fontFamily).toBe("Native Mono")
  expect(comparisonChartPointText(points[0]!)).toContain("$0.123456")
  expect(comparisonChartPointText(points[0]!)).toContain("1 observation")
})

test("missing measurements are not converted to zero and a singleton emits no frontier line", () => {
  const singleton = comparisonChartOptions(
    { points: [points[0]!], frontierConfigurationIDs: [points[0]!.configurationID] },
    theme,
  )
  expect(singleton.series[0]!.data).toHaveLength(1)
  expect(singleton.series[1]!.data).toEqual([])

  const invalid = comparisonChartOptions(
    {
      points: [
        { ...points[0]!, tokensPerAcceptedTask: null },
        { ...points[1]!, currentMarketUSDPerAcceptedTask: Number.NaN },
      ] as unknown as ComparisonChartPoint[],
      frontierConfigurationIDs: points.map((point) => point.configurationID),
    },
    theme,
  )
  expect(invalid.series[0]!.data).toEqual([])
  expect(invalid.series[1]!.data).toEqual([])
  expect(invalid.aria.description).toContain("Unknown and zero-accepted")
  expect(invalid.aria.description).not.toContain("0 tokens per accepted task")
})

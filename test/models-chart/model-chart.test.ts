import { afterAll, expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { ModelChartPoint } from "../../src/models/model-chart.tsx"

const vite = await createServer({
  configFile: false,
  plugins: [solid()],
  server: { middlewareMode: true, ws: false },
  appType: "custom",
})
afterAll(() => vite.close())
const { ModelChart } = (await vite.ssrLoadModule(
  "/src/models/model-chart.tsx",
)) as typeof import("../../src/models/model-chart.tsx")
const { formatAxisMoney, formatAxisTokens } = (await vite.ssrLoadModule(
  "/src/models/chart-layout.ts",
)) as typeof import("../../src/models/chart-layout.ts")

const point = (
  id: string,
  x: number,
  y: number,
  extra: Partial<ModelChartPoint> = {},
): ModelChartPoint => ({
  id,
  x,
  y,
  label: `Model ${id}`,
  frontier: false,
  tooltip: [`Model ${id}`, "$1 per accepted task"],
  description: `Model ${id}, exact route p / ${id}`,
  ...extra,
})

function render(points: ModelChartPoint[], selectedID: string | null, extra = {}) {
  return renderToString(() =>
    createComponent(ModelChart, {
      points,
      selectedID,
      onSelect: () => {},
      xTitle: "Tokens per accepted task",
      yTitle: "Cost per accepted task",
      formatX: formatAxisTokens,
      formatY: formatAxisMoney,
      xScale: "auto-log",
      label: "Model cost chart",
      caption: "14 accepted tasks · OpenRouter prices",
      ...extra,
    }),
  )
}

test("the plot is an SVG: a group of focusable points, a frame, ticks, titles and a legend row", () => {
  const html = render(
    [
      point("a", 2_300_000, 0.3, { frontier: true }),
      point("b", 6_200_000, 0.5, { frontier: true }),
      point("c", 17_000_000, 1.9),
    ],
    "b",
  )
  expect(html).toContain('role="group"')
  expect(html).toContain('aria-roledescription="chart"')
  expect(html.match(/role="button"/g)).toHaveLength(3)
  // One stop in the tab order (the selection); the rest are reached with the arrow keys.
  expect(html.match(/tabindex="0"/g)).toHaveLength(1)
  expect(html.match(/tabindex="-1"/g)).toHaveLength(2)
  expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('aria-label="Model b, exact route p / b"')
  // Frame, grid, mono ticks and both titles.
  expect(html).toContain("lazers-chart-frame")
  expect(html).toContain("lazers-chart-grid")
  expect(html).toContain(">0<")
  expect(html).toContain("Tokens per accepted task")
  expect(html).toContain("Cost per accepted task")
  // The frontier is joined by a polyline; the selection has a halo and a leader tick.
  expect(html).toContain("lazers-chart-frontier")
  expect(html).toContain("lazers-chart-halo")
  expect(html).toContain("lazers-chart-leader")
  // Every point is labelled; the legend row carries the caption directly under the plot.
  for (const id of ["a", "b", "c"]) expect(html).toContain(`Model ${id}</text>`)
  expect(html).toContain("Best trade-off")
  expect(html).toContain("14 accepted tasks · OpenRouter prices")
  expect(html.indexOf("lazers-chart-svg")).toBeLessThan(html.indexOf("lazers-chart-foot"))
})

test("a frontier of one point draws no line", () => {
  const html = render([point("a", 1e6, 1, { frontier: true }), point("b", 2e6, 2)], null)
  expect(html).not.toContain("lazers-chart-frontier")
  expect(html).not.toContain("lazers-chart-halo")
})

test("a wide spread of token counts switches x to a log scale and says so in the title", () => {
  const html = render([point("a", 50, 0.1), point("b", 32_000, 0.2), point("c", 3_000, 0.15)], null)
  expect(html).toContain("Tokens per accepted task")
  expect(html).toContain(" · log")
  const linear = render([point("a", 5e6, 0.1), point("b", 20e6, 0.2)], null)
  expect(linear).not.toContain(" · log")
})

test("catalog projections show a ring for models backed by the user's own runs", () => {
  const html = render([point("a", 61, 0.8, { backed: true }), point("b", 50, 0.5)], null, {
    xScale: "linear",
    backedLegend: "From your runs",
  })
  expect(html).toContain("lazers-chart-ring")
  expect(html).toContain("From your runs")
  expect(html.match(/lazers-chart-ring/g)).toHaveLength(1)
})

test("an empty plot says what is missing and offers the next step", () => {
  const html = render([], null, {
    emptyText: "No accepted tasks match these filters yet.",
    emptyAction: "Show projected cost",
  })
  expect(html).toContain('role="status"')
  expect(html).toContain("No accepted tasks match these filters yet.")
  expect(html).toContain("Show projected cost")
  expect(html).not.toContain("<svg")
})

test("the ranking draws one focusable row per model, with rings, a halo and a score column", async () => {
  const { RankingChart } = (await vite.ssrLoadModule(
    "/src/models/model-chart.tsx",
  )) as typeof import("../../src/models/model-chart.tsx")
  const rows = [
    { id: "a", label: "Cheap", value: 0.4, score: 42, backed: false },
    { id: "b", label: "Backed", value: 2, score: 61, backed: true },
    { id: "c", label: "Dear", value: 14.4, score: null, backed: false },
  ].map((row) => ({
    ...row,
    tooltip: [row.label],
    description: `${row.label}, exact route p / ${row.id}`,
  }))
  const html = renderToString(() =>
    createComponent(RankingChart, {
      rows,
      selectedID: "b",
      onSelect: () => {},
      formatValue: (value: number) => `$${value}`,
      label: "Projected cost ranking",
      title: "Projected cost per accepted task",
      backedLegend: "From your runs",
      showScore: true,
      caption: "List prices × your median tokens",
    }),
  )
  expect(html.match(/role="button"/g)).toHaveLength(3)
  expect(html.match(/tabindex="0"/g)).toHaveLength(1)
  expect(html).toContain('aria-pressed="true"')
  expect(html.match(/lazers-chart-ring/g)).toHaveLength(1)
  expect(html.match(/lazers-chart-halo/g)).toHaveLength(1)
  // Value labels at the bar ends; the score column only where a score exists.
  for (const value of ["$0.4", "$2", "$14.4"]) expect(html).toContain(`>${value}</text>`)
  expect(html.match(/score \d+/g)).toEqual(["score 42", "score 61"])
  // A fixed `$` axis, rows that scroll, and the legend naming the ring.
  expect(html).toContain("lazers-rank-axis")
  expect(html).toContain("max-height:264px")
  expect(html).toContain("From your runs")
  expect(html).toContain("Projected cost per accepted task")
})

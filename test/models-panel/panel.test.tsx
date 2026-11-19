import { afterAll, expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { createServer } from "vite"

const vite = await createServer({
  configFile: "./vite.config.ts",
  server: { middlewareMode: true, ws: false },
  appType: "custom",
})
afterAll(() => vite.close())
const { BenchmarkEmptyState } = (await vite.ssrLoadModule(
  "/src/models/compare-view.tsx",
)) as typeof import("../../src/models/compare-view.tsx")

const { ObservedModelPane, BenchmarkModelPane } = (await vite.ssrLoadModule(
  "/src/models/model-pane.tsx",
)) as typeof import("../../src/models/model-pane.tsx")

const renderedText = (html: string) => html.replace(/<[^>]*>/g, "")

test("the benchmark empty state says no source is reachable and offers settings and retry", () => {
  const ui = {
    Button: (props: { children: unknown }) => `[${String(props.children)}]`,
  }
  const markup = renderToString(() =>
    createComponent(BenchmarkEmptyState, {
      ui: ui as never,
      onOpenSettings: () => {},
      onRetry: () => {},
    }),
  )
  const text = renderedText(markup)
  // Epoch AI needs no key, so the empty state is about reachability, not OpenRouter.
  expect(text).toContain("No benchmark source reachable")
  expect(text).toContain("Epoch AI, which needs no key")
  expect(text).not.toContain("Benchmarks need OpenRouter")
  expect(text).toContain("[Open provider settings]")
  expect(text).toContain("[Retry]")
  expect(text).not.toMatch(/unknown|unavailable/i)
})

const ui = {
  Button: (props: { children: unknown; "aria-label"?: string }) =>
    `[${props["aria-label"] ?? String(props.children)}]`,
}

const observedModel = {
  headline: { value: "$2.93", unit: "per accepted task", smallSample: true },
  stats: [
    { label: "Accepted", value: "1 of 2" },
    { label: "Tokens / task", value: "10.8M" },
    { label: "Time / task", value: undefined },
    { label: "Attempts / task", value: "2" },
  ],
  coverage: {
    priced: 200,
    unpriced: 50,
    caption: "80% of tokens priced · OpenRouter catalog",
    note: "cache write has no published price",
  },
  runs: [
    {
      task: "LZ-103",
      outcome: "Accepted",
      tokens: "10.8M",
      cost: "$2.93",
      contributor: { taskReference: "LZ-103" } as never,
    },
    {
      task: "LZ-104",
      outcome: "Retry",
      tokens: "37.7k",
      cost: undefined,
      contributor: {} as never,
    },
  ],
  runTotal: 2,
  hasMoreRuns: false,
  tokens: [{ kind: "Input", tokens: "100", coverage: "Priced" }],
  sources: [{ name: "OpenCode prices", detail: "OpenCode model quotes", time: "Nov 19, 8:59 AM" }],
  sourceWarnings: [],
  caveats: [],
  identifiers: [{ label: "Route", value: "opencode-go/kimi-k3.1-pro" }],
}

test("your runs: the first screen is one figure, the stats, coverage, flat runs and closed disclosures", () => {
  const text = renderedText(
    renderToString(() =>
      createComponent(ObservedModelPane, {
        Ui: ui as never,
        model: observedModel,
        onTrajectory: () => {},
        onMore: () => {},
      }),
    ),
  )
  expect(text).toContain("$2.93per accepted tasksmall sample")
  expect(text.match(/\$\d/g)?.length).toBe(2) // the headline and the one run row that has a cost
  expect(text).toContain("Accepted1 of 2")
  expect(text).not.toContain("Time / task")
  expect(text).toContain("80% of tokens priced · OpenRouter catalog")
  expect(text).toContain("cache write has no published price")
  expect(text).toContain("[Open trajectory for LZ-103]")
  expect(text).toContain("Tokens· 1")
  expect(text).toContain("Sources· 1")
  expect(text).toContain("Identifiers")
  // An empty disclosure is not rendered, and nothing says "unknown".
  expect(text).not.toContain("Caveats")
  expect(text).not.toMatch(/unknown|unavailable|not recorded|exact-|n=1/i)
  // Raw ids stay behind Identifiers, which is closed.
  expect(text).not.toContain("kimi-k3.1-pro")
})

test("your runs: no price means no headline, no label and no coverage bar", () => {
  const text = renderedText(
    renderToString(() =>
      createComponent(ObservedModelPane, {
        Ui: ui as never,
        model: { ...observedModel, headline: undefined, coverage: undefined, runs: [] },
        onTrajectory: () => {},
        onMore: () => {},
      }),
    ),
  )
  expect(text).not.toContain("per accepted task")
  expect(text).not.toContain("small sample")
  expect(text).not.toContain("tokens priced")
  expect(text).not.toContain("Runs")
})

test("benchmark: the score leads, prices follow, empty pieces are omitted", () => {
  const text = renderedText(
    renderToString(() =>
      createComponent(BenchmarkModelPane, {
        model: {
          headline: { value: "84.7", unit: "Terminal-Bench 2.0 (%)", smallSample: false },
          stats: [
            { label: "Input / 1M", value: "$5" },
            { label: "Output / 1M", value: "$30" },
            { label: "Cached / 1M", value: undefined },
          ],
          scores: [],
          sources: [{ name: "Artificial Analysis", detail: "score" }],
          sourceWarnings: [],
          caveats: ["A list price is not a task cost."],
          identifiers: [{ label: "Route", value: "openai/gpt-5.5" }],
        },
      }),
    ),
  )
  expect(text).toContain("84.7Terminal-Bench 2.0 (%)")
  expect(text).toContain("Input / 1M$5")
  expect(text).not.toContain("Cached")
  expect(text).not.toContain("Scores")
  expect(text).toContain("Caveats")
  expect(text).not.toMatch(/unknown|_unknown|blend/i)
})

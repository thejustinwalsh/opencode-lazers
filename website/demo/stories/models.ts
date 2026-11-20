import { defineStory } from "../src/story.ts"
import type { DemoModel, ModelsData } from "../src/panels/models-answers.ts"

type Run = NonNullable<DemoModel["observed"]>["runs"][number]
const runs = (...entries: [number, Run["kind"], number][]): Run[] =>
  entries.map(([n, kind, tokens]) => ({ n, kind, tokens }))

const pro: DemoModel = {
  providerID: "acme",
  id: "demo-pro",
  name: "Demo Pro",
  priceIn: 3,
  priceOut: 15,
  priceCache: 0.3,
  context: 200_000,
  variants: ["low", "medium", "high"],
  observed: {
    variant: "high",
    terminal: 6,
    tokens: 920_000,
    runs: runs(
      [214, "accepted", 840_000],
      [217, "accepted", 910_000],
      [219, "retry", 380_000],
      [219, "accepted", 1_020_000],
      [223, "accepted", 890_000],
      [226, "failed", 450_000],
    ),
  },
}
const lite: DemoModel = {
  providerID: "acme",
  id: "demo-lite",
  name: "Demo Lite",
  priceIn: 0.25,
  priceOut: 1.25,
  priceCache: 0.03,
  context: 128_000,
  variants: [],
  observed: {
    terminal: 4,
    tokens: 1_650_000,
    runs: runs(
      [215, "accepted", 1_400_000],
      [218, "failed", 900_000],
      [218, "accepted", 1_900_000],
      [224, "accepted", 1_650_000],
    ),
  },
}
const fast: DemoModel = {
  providerID: "northwind",
  id: "demo-fast",
  name: "Demo Fast",
  priceIn: 0.6,
  priceOut: 2.4,
  priceCache: 0.06,
  context: 128_000,
  variants: ["fast"],
  observed: {
    terminal: 4,
    tokens: 1_100_000,
    runs: runs(
      [216, "accepted", 980_000],
      [220, "accepted", 1_190_000],
      [225, "accepted", 1_130_000],
      [227, "failed", 600_000],
    ),
  },
}
const max: DemoModel = {
  providerID: "lumen",
  id: "demo-max",
  name: "Demo Max",
  priceIn: 10,
  priceOut: 40,
  priceCache: 1,
  context: 200_000,
  variants: [],
  observed: {
    terminal: 2,
    tokens: 640_000,
    runs: runs([221, "accepted", 610_000], [222, "accepted", 670_000]),
  },
}
const mini: DemoModel = {
  providerID: "lumen",
  id: "demo-mini",
  name: "Demo Mini",
  priceIn: 0.1,
  priceOut: 0.4,
  priceCache: 0.01,
  context: 64_000,
  variants: [],
}

const tasks = [
  { n: 227, title: "Add retry budget to the sync worker" },
  { n: 226, title: "Fix stale cursor after offline resume" },
  { n: 225, title: "Show upload progress in the status bar" },
  { n: 224, title: "Batch small writes before flushing" },
]

const initial: ModelsData = {
  pricesAgeMin: 38,
  models: [pro, lite, fast, max, mini],
  tasks,
  assignments: [
    {
      subject: "lazers-implementor",
      scope: "project",
      route: { providerID: "acme", id: "demo-pro", variant: "high" },
    },
    { subject: "architect", scope: "shared", route: { providerID: "lumen", id: "demo-max" } },
  ],
}

// One more finished task on Demo Lite changes what its runs measured.
const liteAfter: DemoModel = {
  ...lite,
  observed: {
    terminal: 5,
    tokens: 1_480_000,
    runs: [...lite.observed!.runs, { n: 228, kind: "accepted", tokens: 1_110_000 }],
  },
}

const point = (id: string) => `.lazers-chart-point[data-point-id="configuration:${id}"]`
const pick = (key: string) => `.oc-dialog [role="option"][data-value='${key}']`
/** What the chapters before "refresh" left on screen: Demo Lite selected, details open. */
const liteOpen = [{ do: "click", sel: point("acme/demo-lite::none") }] as const

export default defineStory<ModelsData>({
  id: "models",
  panel: "models",
  title: "Models",
  size: { width: 420, height: 560 },
  initial,
  chapters: [
    {
      name: "compare",
      caption:
        "Compare plots each model by what its accepted tasks cost, measured from your own runs.",
    },
    {
      name: "inspect",
      caption: "Selecting a model opens its measured cost, accepted share and the runs behind it.",
    },
    {
      name: "refresh",
      caption: "A newly accepted task changes a model's cost; Refresh re-reads and re-plots it.",
      setup: [...liteOpen],
    },
    {
      name: "assign",
      caption: "Assignments sets which model each agent and persona runs on, saved per project.",
      setup: [...liteOpen],
    },
  ],
  steps: [
    {
      at: 0,
      chapter: "compare",
      actions: [
        { do: "wait", ms: 900 },
        { do: "scroll", sel: ".lazers-models-top", to: 240 },
        { do: "wait", ms: 700 },
        { do: "scroll", sel: ".lazers-models-top", to: 0 },
      ],
    },
    {
      at: 5000,
      chapter: "inspect",
      actions: [
        { do: "click", sel: point("acme/demo-pro::high") },
        { do: "wait", ms: 2000 },
        { do: "click", sel: point("acme/demo-lite::none") },
        { do: "wait", ms: 1800 },
      ],
    },
    {
      at: 14000,
      chapter: "refresh",
      data: {
        models: [pro, liteAfter, fast, max, mini],
        tasks: [{ n: 228, title: "Retry transient upload errors" }, ...tasks],
        pricesAgeMin: 0,
      },
      actions: [
        { do: "click", sel: 'button[aria-label="Refresh"]' },
        { do: "wait", ms: 2500 },
      ],
    },
    {
      at: 19000,
      chapter: "assign",
      actions: [
        { do: "click", sel: "#lazers-models-assignments-tab" },
        { do: "click", sel: '[data-agent="lazers-implementor"]' },
        { do: "wait", ms: 800 },
        { do: "click", sel: ".lazers-models-assignment-choice button" },
        { do: "click", sel: pick('["northwind","demo-fast"]') },
        { do: "wait", ms: 600 },
        { do: "click", sel: ".lazers-details-actions button" },
        { do: "wait", ms: 2000 },
      ],
    },
  ],
  end: 31000,
})

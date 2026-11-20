import { defineStory } from "../src/story.ts"
import type { DemoModel, ModelsData } from "../src/panels/models-answers.ts"

type Run = NonNullable<DemoModel["observed"]>["runs"][number]
const runs = (...entries: [number, Run["kind"], number][]): Run[] =>
  entries.map(([n, kind, tokens]) => ({ n, kind, tokens }))

/**
 * Provenance of every price and context size below: the OpenRouter model catalog
 * (GET https://openrouter.ai/api/v1/models) as this product recorded it, snapshot generation 337
 * retrieved 2026-11-19T17:21:30Z and generation 338 retrieved 2026-11-19T18:39:46Z. The catalog
 * published these USD-per-token figures, shown here per million tokens (input, output, cache read):
 *   anthropic/claude-opus-5.5       4      / 20    / 0.2     context 1,000,000
 *   openai/gpt-6.2-sol              2      / 10    / 0.1     context 1,050,000 (first tier)
 *   meta/muse-spark-1.3             1.25   / 4.25  / 0.15    context 1,048,576
 *   meta/muse-ember                 0.1    / 0.5   / 0.004   context 1,048,576
 *   deepseek/deepseek-v4-pro-0813   0.13   / 5.5   / 0.11    in generation 337
 *                                   0.15   / 6.5   / 0.12    in generation 338
 * The native OpenCode route ids below are the product's own spellings. Only DeepSeek's price moved
 * between the two snapshots, which is what the "refresh" chapter replays. Runs, token counts and
 * acceptance are illustrative project data. Dollars per accepted task are those tokens times a fixed
 * coding-task mix of 15% fresh input, 5% output and 80% cache reads at the prices above.
 */
export const provenance = {
  source: "OpenRouter model catalog",
  before: { generation: 337, retrievedAt: "2026-11-19T17:21:30.333Z" },
  after: { generation: 338, retrievedAt: "2026-11-19T18:39:46.306Z" },
} as const

const opus: DemoModel = {
  providerID: "anthropic",
  id: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  openrouterID: "anthropic/claude-opus-5.5",
  priceIn: 4,
  priceOut: 20,
  priceCache: 0.2,
  context: 1_000_000,
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
const sol: DemoModel = {
  providerID: "openai",
  id: "gpt-6.2-sol",
  name: "GPT-6.2 Sol",
  openrouterID: "openai/gpt-6.2-sol",
  priceIn: 2,
  priceOut: 10,
  priceCache: 0.1,
  context: 1_050_000,
  variants: [],
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
const spark: DemoModel = {
  providerID: "opencode-go",
  id: "muse-spark-1.3",
  name: "Muse Spark 1.3",
  openrouterID: "meta/muse-spark-1.3",
  priceIn: 1.25,
  priceOut: 4.25,
  priceCache: 0.15,
  context: 1_048_576,
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
const deepseekBefore: DemoModel = {
  providerID: "opencode-go",
  id: "deepseek-v4-pro",
  name: "DeepSeek V4 Pro",
  openrouterID: "deepseek/deepseek-v4-pro-0813",
  priceIn: 0.13,
  priceOut: 5.5,
  priceCache: 0.11,
  context: 1_048_576,
  variants: [],
  observed: {
    terminal: 3,
    tokens: 1_350_000,
    runs: runs(
      [221, "accepted", 1_250_000],
      [222, "accepted", 1_450_000],
      [228, "failed", 700_000],
    ),
  },
}
const deepseekAfter: DemoModel = {
  ...deepseekBefore,
  priceIn: 0.15,
  priceOut: 6.5,
  priceCache: 0.12,
}
// A recorded native model of the openrouter provider: opencode-go lists no Muse Ember.
const ember: DemoModel = {
  providerID: "openrouter",
  id: "meta/muse-ember",
  name: "Muse Ember",
  openrouterID: "meta/muse-ember",
  priceIn: 0.1,
  priceOut: 0.5,
  priceCache: 0.004,
  context: 1_048_576,
  variants: [],
}

const tasks = [
  { n: 228, title: "Retry transient upload errors" },
  { n: 227, title: "Add retry budget to the sync worker" },
  { n: 226, title: "Fix stale cursor after offline resume" },
  { n: 225, title: "Show upload progress in the status bar" },
  { n: 224, title: "Batch small writes before flushing" },
]

const initial: ModelsData = {
  pricesRetrievedAt: provenance.before.retrievedAt,
  pricesGeneration: provenance.before.generation,
  models: [opus, sol, spark, deepseekBefore, ember],
  tasks,
  assignments: [
    {
      subject: "lazers-implementor",
      scope: "project",
      route: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
    },
    {
      subject: "architect",
      scope: "shared",
      route: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
    },
  ],
}

const point = (id: string) => `.lazers-chart-point[data-point-id="configuration:${id}"]`
const pick = (key: string) => `.oc-dialog [role="option"][data-value='${key}']`
/** What the chapters before "refresh" left on screen: DeepSeek V4 Pro selected, details open. */
const deepseekOpen = [{ do: "click", sel: point("opencode-go/deepseek-v4-pro::none") }] as const

export default defineStory<ModelsData>({
  id: "models",
  panel: "models",
  title: "Models",
  size: { width: 440, height: 740 },
  initial,
  chapters: [
    {
      name: "compare",
      caption:
        "Compare plots each model by what its accepted tasks cost at the price source's rates, measured from your own runs.",
    },
    {
      name: "inspect",
      caption: "Selecting a model opens its cost per accepted task and the runs behind it.",
    },
    {
      name: "refresh",
      caption:
        "A fresh price snapshot re-prices the same recorded usage: DeepSeek V4 Pro's tokens stay and its cost changes.",
      setup: [...deepseekOpen],
    },
    {
      name: "assign",
      caption:
        "Assignments routes each agent to a model. Moving Implementor off Claude Opus 5.5 changes what its accepted tasks cost.",
      setup: [...deepseekOpen],
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
        { do: "click", sel: point("anthropic/claude-opus-5-5::high") },
        { do: "wait", ms: 2000 },
        { do: "click", sel: point("opencode-go/deepseek-v4-pro::none") },
        { do: "wait", ms: 1800 },
      ],
    },
    {
      at: 14000,
      chapter: "refresh",
      data: {
        models: [opus, sol, spark, deepseekAfter, ember],
        pricesRetrievedAt: provenance.after.retrievedAt,
        pricesGeneration: provenance.after.generation,
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
        { do: "click", sel: pick('["opencode-go","deepseek-v4-pro"]') },
        { do: "wait", ms: 600 },
        { do: "click", sel: ".lazers-details-actions button" },
        { do: "wait", ms: 2000 },
      ],
    },
  ],
  end: 31000,
})

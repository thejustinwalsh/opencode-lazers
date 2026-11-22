import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

/**
 * The Models panel mounted in a DOM over real stream frames: the demo's mock project is turned
 * into stored views by the real view builder (`buildDecisionView`) and served through the real
 * frame codec. The test steers only what the service decides: when a view is built.
 */
const entry = fileURLToPath(new URL("./streams/dom-entry.tsx", import.meta.url))
const outDir = fileURLToPath(
  new URL("../../node_modules/.cache/models-streams-dom", import.meta.url),
)
type Bundle = typeof import("./streams/dom-entry.tsx")
let bundle: Bundle

const globals = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLDivElement",
  "HTMLDetailsElement",
  "Document",
  "DocumentFragment",
  "Text",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "MutationObserver",
  "customElements",
  "navigator",
  "location",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const dom = new Window({ url: "https://models-streams.localhost" })

beforeAll(async () => {
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (dom as unknown as Record<string, unknown>)[name],
    })
  }
  // Happy DOM has no layout: report a size on observe, as a browser would.
  class SizedResizeObserver {
    constructor(private readonly callback: (entries: ResizeObserverEntry[]) => void) {}
    observe(target: HTMLElement) {
      queueMicrotask(() => {
        if (!target.isConnected) return
        this.callback([
          {
            target,
            contentRect: { width: 440, height: 300 },
            borderBoxSize: [{ inlineSize: 440, blockSize: 300 }],
          } as unknown as ResizeObserverEntry,
        ])
      })
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: SizedResizeObserver,
  })
  await rm(outDir, { recursive: true, force: true })
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { conditions: ["browser", "development", "module"] },
    plugins: [solid()],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      lib: { entry, formats: ["es"], fileName: "models-streams" },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  bundle = (await import(pathToFileURL(`${outDir}/models-streams.js`).href)) as Bundle
})
afterAll(async () => {
  for (const [name, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  await rm(outDir, { recursive: true, force: true })
})

type Mounted = ReturnType<Bundle["harness"]>
let live: { host: Mounted; root: HTMLElement } | undefined
afterEach(() => {
  live?.host.dispose()
  live?.root.remove()
  live = undefined
})

function mount(options: Parameters<Bundle["harness"]>[1] = {}) {
  const root = dom.document.createElement("div")
  dom.document.body.append(root)
  const host = bundle.harness(root as never, options)
  live = { host, root: root as never }
  return { host, root: root as unknown as HTMLElement }
}

async function until(predicate: () => boolean, what: string) {
  for (let attempt = 0; attempt < 300 && !predicate(); attempt++)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  expect(predicate(), what).toBe(true)
}
const initial = () => bundle.story.initial
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 150))
const click = (element: Element) =>
  void element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
const selectionOf = (open: { filter: Record<string, unknown> }) =>
  open.filter.view as import("./streams/dom-entry.tsx").ViewSelection
/** Opens the menu behind `trigger` and picks the item whose text contains `item`. */
function menuPick(root: ParentNode, trigger: string, item: string) {
  click(root.querySelector(`button[aria-label="${trigger}"][aria-haspopup=menu]`)!)
  const entry = [...root.querySelectorAll('[role="menuitem"]')].find((el) =>
    el.textContent?.includes(item),
  )
  if (!entry) throw new Error(`No menu item ${item} under ${trigger}`)
  click(entry)
}
/** The "All models" rows: the model's name and the text of each cell after it. */
const rowsOf = (root: ParentNode) =>
  [...root.querySelectorAll("table tbody tr")].map((row) => ({
    label: row.querySelector("th")?.textContent ?? "",
    cells: [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? ""),
  }))
type Candidates = import("../../src/models/comparison-schema.ts").ModelComparisonOutput
/** Models no source prices: the native catalog and OpenRouter list none for them. */
const unpriced = (modelIDs: string[]) => (output: Candidates) => ({
  ...output,
  candidates: output.candidates.map((candidate) =>
    modelIDs.includes(candidate.identity.modelID)
      ? { ...candidate, native: { ...candidate.native, prices: null }, externalModel: null }
      : candidate,
  ),
})
type ModelSettings = import("../../src/models/contract.ts").ModelSettingsOutput
/** Claude Opus offers three efforts: each is a candidate row after the model's own. */
const withEfforts = (output: Candidates): Candidates => ({
  ...output,
  candidates: output.candidates.flatMap((candidate) =>
    candidate.identity.modelID === "claude-opus-5-5"
      ? [
          candidate,
          ...["low", "medium", "high"].map((variant) => ({
            ...candidate,
            candidateID: `${candidate.candidateID}:${variant}`,
            identity: { ...candidate.identity, variant },
          })),
        ]
      : [candidate],
  ),
})
const text = (root: ParentNode) => (root as HTMLElement).textContent ?? ""
const pointIDs = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>(".lazers-chart-point")].map((point) =>
    String(point.dataset.pointId),
  )

test("first open: a view being built shows the building line, then the chart and table", async () => {
  const { host, root } = mount({ hold: () => true })
  await until(() => text(root).includes("building it from your runs"), "the building line")
  // Never empty or unknown while it builds.
  expect(pointIDs(root)).toEqual([])
  expect(text(root)).not.toMatch(/unknown|no models/i)
  expect(host.lastOpen("models.view")).toBeDefined()

  host.release()
  await until(() => pointIDs(root).length === 4, "the four plotted models")
  expect(text(root)).not.toContain("building it from your runs")
  const rows = [...root.querySelectorAll("table tbody tr")].map((row) => row.textContent)
  expect(rows).toHaveLength(5)
})

test("switching the persona or the task keeps the last ready view until the new one lands", async () => {
  const { host, root } = mount({ preferences: { taskFilter: true } })
  await until(() => pointIDs(root).length === 4, "the first view")
  const shown = () => ({
    points: pointIDs(root).length,
    rows: root.querySelectorAll("table tbody tr").length,
  })
  const without = {
    ...initial(),
    models: initial().models.filter((m) => m.id !== "muse-spark-1.3"),
  }

  // Persona: the new view is answered as backfilling first.
  host.hold((view) => view.filters.persona === "ui")
  menuPick(root, "All personas", "UI")
  await until(
    () =>
      host.lastOpen("models.view", (o) => selectionOf(o).filters.persona === "ui") !== undefined,
    "the persona's view opens",
  )
  await until(() => host.heldFrames() > 0, "the new view answers as backfilling")
  await settle()
  expect(shown()).toEqual({ points: 4, rows: 5 })
  expect(text(root)).not.toContain("building it from your runs")
  host.release(without)
  await until(() => pointIDs(root).length === 3, "the ready persona view replaces it")
  expect(shown()).toEqual({ points: 3, rows: 4 })

  // Task: the same, for the selected task's view.
  const held = host.heldFrames()
  host.hold((view) => view.taskID?.endsWith("e2") === true)
  menuPick(root, "LZ-228", "LZ-226")
  await until(
    () =>
      host.lastOpen("models.view", (o) => selectionOf(o).taskID?.endsWith("e2") === true) !==
      undefined,
    "the task's view opens",
  )
  await until(() => host.heldFrames() > held, "the task's view answers as backfilling")
  await settle()
  expect(shown()).toEqual({ points: 3, rows: 4 })
  expect(text(root)).not.toContain("building it from your runs")
  host.release(initial())
  await until(() => pointIDs(root).length === 4, "the ready task view replaces it")
})

/** Sixty runs of Claude Opus: more than one window of contributors. */
const manyRuns = () => ({
  ...initial(),
  models: initial().models.map((model) =>
    model.id === "claude-opus-5-5"
      ? {
          ...model,
          observed: {
            ...model.observed!,
            terminal: 20,
            runs: Array.from({ length: 60 }, (_, i) => ({
              n: 214 + (i % 15),
              kind: i % 7 === 6 ? ("failed" as const) : ("accepted" as const),
              tokens: 800_000 + i * 1_000,
            })),
          },
        }
      : model,
  ),
})
const runRows = (root: ParentNode) =>
  [...root.querySelectorAll(".lazers-kit-rows[aria-label='Runs with this model'] [role=row]")]
    .filter((row) => !row.classList.contains("lazers-kit-rows-head"))
    .map((row) => row.querySelector(".lazers-models-row-mono")?.textContent)

test("contributors: the selected task's lead and Load more runs grows the window", async () => {
  const { host, root } = mount({ data: manyRuns(), preferences: { taskFilter: true, open: true } })
  await until(() => runRows(root).length > 0, "the runs")
  // The task picker shows once the selected task's detail and effort windows have read.
  await until(
    () => root.querySelector('button[aria-label="LZ-228"][aria-haspopup=menu]') !== null,
    "the task picker",
  )
  menuPick(root, "LZ-228", "LZ-226")
  const rest = (window: number) =>
    host.lastOpen(
      "models.contributors",
      (o) => typeof o.filter.exceptTaskID === "string" && o.window === window,
    )
  await until(() => runRows(root)[0] === "LZ-226", "the task's runs lead")
  // The lead stream reads only the task, the rest stream everything else, 40 at a time.
  const top = host.lastOpen("models.contributors", (o) => typeof o.filter.taskID === "string")!
  expect(top.window).toBe(10)
  expect(String(top.filter.taskID).endsWith("e2")).toBe(true)
  expect(rest(40)).toBeDefined()
  await until(() => runRows(root).length === 43, "three of the task and forty others")
  expect(runRows(root).slice(0, 3)).toEqual(["LZ-226", "LZ-226", "LZ-226"])
  expect(runRows(root).slice(3)).not.toContain("LZ-226")
  expect(text(root)).toContain("Runs50")

  const more = [...root.querySelectorAll("button")].find((b) => b.textContent === "Load more runs")!
  more.click()
  await until(() => rest(60) !== undefined, "the window grows by 20")
  await until(() => runRows(root).length === 50, "every contributor is listed")
  expect([...root.querySelectorAll("button")].some((b) => b.textContent === "Load more runs")).toBe(
    false,
  )
})

test("prices: an unpriced model shows no price, a priced one its source and date", async () => {
  // Claude Opus is routed (an assignment names it) but no source lists a price for it.
  const { root } = mount({ comparison: unpriced(["claude-opus-5-5"]), preferences: { open: true } })
  await until(() => rowsOf(root).length === 5, "the table")
  const retrieved = new Date("2026-11-19T17:21:30.333Z").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })
  const rows = rowsOf(root)
  const opus = rows.find((row) => row.label.startsWith("Claude Opus 5.5"))!
  // The price cell and the projected cost are empty: never "unknown", never a zero. Its
  // observed cost still shows.
  expect(opus.cells.at(-1)).toBe("")
  expect(opus.cells[1]).toMatch(/^\$1\.\d+$/)
  expect(opus.cells[2]).toBe("")
  for (const row of rows.filter((entry) => entry !== opus))
    expect(row.cells.at(-1)).toBe(`OpenRouter \u00b7 ${retrieved}`)
  expect(text(root.querySelector("table")!)).not.toMatch(/unknown|\$0(?![.\d])/i)

  // The unpriced model has no projection, so the projected ranking omits it.
  click(root.querySelector("[data-segment=projected]")!)
  await until(() => root.querySelector(".lazers-rank") !== null, "the projected ranking")
  const ranking = text(root.querySelector(".lazers-rank")!)
  expect(ranking).toContain("Muse Ember")
  expect(ranking).not.toContain("Claude Opus")
  expect(text(root.querySelector(".lazers-rank")!)).not.toMatch(/unknown/i)

  // A priced model's pane carries the provenance: source, retrieval date, route and snapshot.
  click(root.querySelector("[data-segment=observed]")!)
  await until(() => pointIDs(root).length === 4, "the observed plot")
  click(root.querySelector('[data-point-id="configuration:openai/gpt-6.2-sol::none"]')!)
  await until(() => root.querySelector("h2[title*='gpt-6.2-sol']") !== null, "the pane")
  await settle()
  for (const toggle of root.querySelectorAll<HTMLElement>(".lazers-kit-disclosure-toggle"))
    if (toggle.getAttribute("aria-expanded") !== "true") toggle.click()
  await settle()
  const pane = text(root.querySelector(".lazers-models-pane-disclosures")!)
  expect(pane).toContain("OpenRouter prices")
  expect(pane).toContain("Exact route quotes")
  expect(pane).toContain(`${retrieved} at `)
  expect(pane).toContain("Routeopenai/gpt-6.2-sol")
  expect(pane).toContain("OpenRouter price snapshotopenrouter-models:337")
  expect(text(root.querySelector(".lazers-models-pane-body")!)).toContain("Tokens / task1.1M")
})

test("one cost per configuration: table, Your runs, Projected and the pane say the same", async () => {
  // DeepSeek's reference is partial: a priced subtotal range, shown as a range everywhere.
  const { root } = mount({
    comparison: unpriced(["claude-opus-5-5"]),
    partial: ["deepseek-v4-pro"],
    preferences: { open: true },
  })
  await until(() => rowsOf(root).length === 5, "the table")
  const row = (name: string) =>
    [...root.querySelectorAll("table tbody tr")].find((tr) =>
      tr.querySelector("th")?.textContent?.startsWith(name),
    )!
  const cost = (tr: Element, basis: string) =>
    tr.querySelector<HTMLElement>(`.lazers-models-cost[data-basis=${basis}]`)
  const deepseek = cost(row("DeepSeek V4 Pro"), "observed")!
  const range = deepseek.textContent!
  expect(range).toMatch(/^\$0\.\d+–\$0\.\d+$/)
  expect(deepseek.dataset.kind).toBe("range")
  const projected = cost(row("DeepSeek V4 Pro"), "projected")!.textContent!
  expect(projected).toMatch(/^\$0\.\d+$/)
  // The row label names the exact effort its observed facts came from.
  expect(row("Claude Opus 5.5").querySelector("th")!.textContent).toBe("Claude Opus 5.5 · high")
  expect(row("Claude Opus 5.5").querySelector("button")!.getAttribute("title")).toBe(
    "Claude Opus 5.5 · high",
  )
  // An unpriced model has no projected price element at all.
  expect(cost(row("Claude Opus 5.5"), "projected")).toBeNull()

  // Your runs: the point is a whisker from low to high, its accessible text the same range.
  await until(() => pointIDs(root).length === 4, "the observed plot")
  const point = root.querySelector('[data-point-id*="deepseek-v4-pro"]')!
  expect(point.querySelector("[data-range]")).not.toBeNull()
  expect(point.getAttribute("aria-label")).toContain(`Observed in your runs: ${range}`)

  // The pane's headline is the same stored cost, labelled by its basis.
  click(point)
  await until(() => root.querySelector("h2[title*='deepseek-v4-pro']") !== null, "the pane")
  await settle()
  const body = text(root.querySelector(".lazers-models-pane-body")!)
  expect(body).toContain(range)
  expect(body).toContain("Observed in your runs")

  // Projected: the bar is the projection; the observed range sits beside it with its own label.
  click(root.querySelector("[data-segment=projected]")!)
  await until(() => root.querySelector(".lazers-rank") !== null, "the projected ranking")
  const rank = [...root.querySelectorAll(".lazers-rank-row")].find((g) =>
    g.getAttribute("aria-label")?.startsWith("DeepSeek V4 Pro"),
  )!
  const label = rank.getAttribute("aria-label")!
  expect(label).toContain(`Projected from list prices × your median tokens: ${projected}`)
  expect(label).toContain(`Observed in your runs: ${range}`)
  expect(rank.querySelector(".lazers-chart-ring[data-observed]")).not.toBeNull()
  expect(rank.querySelector(".lazers-chart-whisker[data-observed]")).not.toBeNull()
  expect(text(root.querySelector(".lazers-rank")!)).not.toContain("From your runs")
})

/** What each demo model scores: the Coding Index, and SWE-bench Verified (a fraction) for some. */
const scores: Record<string, { coding: number; swe?: number }> = {
  "claude-opus-5-5": { coding: 70, swe: 0.82 },
  "gpt-6.2-sol": { coding: 66, swe: 0.78 },
  "muse-spark-1.3": { coding: 52 },
  "deepseek-v4-pro": { coding: 61, swe: 0.6 },
  "meta/muse-ember": { coding: 40 },
}
/** The comparison's candidates matched to the public benchmarks of `scores`. */
const scored = (output: Candidates): Candidates => ({
  ...output,
  candidates: output.candidates.map((candidate) => {
    const score = scores[candidate.identity.modelID]
    if (!score) return candidate
    const evidence = { records: [], recordCount: 0, truncated: false }
    return {
      ...candidate,
      benchmarkCorrespondence: {
        status: "exact",
        basis: "exact-published-catalog-id",
        evidence,
      } as never,
      externalBenchmark: {
        kind: "openrouter-benchmark",
        source: "artificial-analysis",
        taskType: "coding",
        modelPermaslug: candidate.identity.modelID,
        displayName: candidate.native.name,
        effort: null,
        codingIndex: score.coding,
        agenticIndex: null,
        intelligenceIndex: null,
        prices: null,
      },
      publicBenchmarks:
        score.swe === undefined
          ? []
          : [
              {
                kind: "epoch-benchmark",
                benchmarkID: "swe-bench-verified",
                benchmark: "SWE-bench Verified",
                origin: "Epoch AI",
                modelVersion: candidate.identity.modelID,
                modelKey: candidate.identity.modelID,
                effort: null,
                score: score.swe,
                stderr: null,
                agent: null,
                releaseDate: null,
              },
            ],
    }
  }),
})

test("benchmark: points come from models.benchmark, left-off models are named", async () => {
  const both = (output: Candidates) => unpriced(["meta/muse-ember"])(scored(output))
  const { host, root } = mount({ comparison: both, preferences: { compareMode: "benchmark" } })
  await until(() => pointIDs(root).length === 4, "the benchmark points")
  // The rows are read from their own stream, sized by the view's stored count.
  const stream = host.lastOpen("models.benchmark")!
  expect(stream.window).toBe(5)
  expect(text(root)).toContain("4 plotted")
  expect(text(root)).toContain("1 scored model has no price in any source")
  expect(text(root)).toContain("Muse Ember \u00b7 no price in any configured source")
  expect(text(root)).toContain("Artificial Analysis Coding Index")
  expect(text(root)).not.toMatch(/unknown/i)

  // Back on Your runs the plot is the task outcomes again.
  click(root.querySelector("[data-segment=observed]")!)
  await until(
    () =>
      root.querySelector(".lazers-chart-caption")?.textContent?.includes("accepted tasks") === true,
    "your runs",
  )
})

test("score basis: the picker lists the view's options and a pick reopens the views with it", async () => {
  const { host, root } = mount({ comparison: scored, preferences: { compareMode: "projected" } })
  await until(() => root.querySelector('select[aria-label="Score basis"]') !== null, "the picker")
  const picker = () => root.querySelector<HTMLSelectElement>('select[aria-label="Score basis"]')!
  expect([...picker().options].map((option) => [option.value, option.textContent])).toEqual([
    ["aa", "Coding index \u00b7 5"],
    ["swe-bench-verified", "SWE-bench Verified (%) \u00b7 3"],
  ])
  expect(picker().value).toBe("aa")
  expect(host.lastOpen("models.view")!.filter.view).toMatchObject({ basis: null })

  picker().value = "swe-bench-verified"
  picker().dispatchEvent(new Event("change", { bubbles: true }))
  for (const source of ["models.view", "models.points", "models.catalog"])
    await until(
      () =>
        host.lastOpen(source, (o) => selectionOf(o).basis === "swe-bench-verified") !== undefined,
      `${source} reopens with the basis`,
    )
  await until(() => picker().value === "swe-bench-verified", "the picker shows the new basis")
  // The ranking's score column now reads the SWE-bench scores (a percent).
  await until(() => rowsOf(root).some((row) => row.cells[5] === "82"), "scores on the new basis")
})

test("assignments: sources read from the stream, a saved route is confirmed by the readback", async () => {
  // Without the host's help: this project's and the shared route, and none for the rest.
  const plain = mount({ preferences: { tab: "assignments" } })
  await until(() => plain.root.querySelector("[data-agent=architect]") !== null, "the agent rows")
  const agent = (root: ParentNode, id: string) =>
    text(
      root.querySelector(`[data-agent=${id}]`) ?? root.ownerDocument!.createElement("i"),
    ).replace(/\s+/g, " ")
  expect(agent(plain.root, "architect")).toContain("claude-opus-5-5 \u00b7 high")
  expect(agent(plain.root, "architect")).toContain("shared")
  expect(agent(plain.root, "lazers-implementor")).toContain("project")
  expect(agent(plain.root, "auditor")).toContain("Uses the session model")
  expect(agent(plain.root, "lazers-planning")).toContain("Uses the session model")
  live!.host.dispose()
  live!.root.remove()

  // The host names the Auditor's plugin default and a native model for the planning agents.
  const hosted = (output: ModelSettings): ModelSettings => ({
    ...output,
    agents: [
      ...(output.agents ?? []).map((entry) =>
        entry.agentID === "auditor"
          ? {
              ...entry,
              model: { providerID: "openai", id: "gpt-6.2-sol" },
              source: "plugin-default" as const,
            }
          : entry,
      ),
      {
        agentID: "lazers-planning" as const,
        label: "Planning agents",
        model: { providerID: "opencode-go", id: "muse-spark-1.3" },
        source: "native" as const,
      },
    ],
  })
  const { host, root } = mount({
    comparison: withEfforts,
    settings: hosted,
    preferences: { tab: "assignments", open: true },
  })
  await until(() => agent(root, "lazers-planning").includes("OpenCode"), "the host's models")
  expect(agent(root, "auditor")).toContain("gpt-6.2-sol")
  expect(agent(root, "auditor")).toContain("default")
  expect(agent(root, "lazers-planning")).toContain("muse-spark-1.3")
  const persona = () => text(root.querySelector("[data-persona-row]")!).replace(/\s+/g, " ")
  expect(persona()).toContain("Uses Implementor default")

  // The picker lists the enabled candidates, one option per model.
  const choose = () =>
    root.querySelector<HTMLButtonElement>(".lazers-models-assignment-choice button")!
  await until(() => !choose().disabled, "the catalog is ready")
  // The first task is selected by default: wait for it, as a pick across the change is dropped.
  await until(
    () =>
      host.lastOpen("models.assignments", (o) => typeof o.filter.taskID === "string") !== undefined,
    "the default task",
  )
  await settle()
  click(choose())
  await until(() => root.querySelector(".oc-dialog [role=option]") !== null, "the picker")
  expect([...root.querySelectorAll(".oc-dialog [role=option]")].map((o) => o.textContent)).toEqual([
    "Claude Opus 5.5",
    "GPT-6.2 Sol",
    "Muse Spark 1.3",
    "DeepSeek V4 Pro",
    "Muse Ember",
  ])
  click(
    root.querySelector(`.oc-dialog [role=option][data-value='["anthropic","claude-opus-5-5"]']`)!,
  )
  // The efforts are the candidate rows of the chosen model.
  await until(
    () =>
      root.querySelector('button[aria-label="Default"][aria-haspopup=menu]:not([disabled])') !==
      null,
    "the efforts load",
  )
  click(root.querySelector('button[aria-label="Default"][aria-haspopup=menu]')!)
  expect([...root.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
    "Default",
    "low",
    "medium",
    "high",
  ])
  click(
    [...root.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === "high")!,
  )

  const before = host.opens.length
  click([...root.querySelectorAll("button")].find((b) => b.textContent === "Save")!)
  await until(() => host.calls.length === 1, "the write")
  expect(host.calls[0]).toMatchObject({
    method: "configure",
    input: {
      persona: "ui",
      sessionID: "ses-demo",
      target: { scope: "project" },
      expectedRevision: 0,
      route: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
    },
  })
  // The readback is a window of the assignments stream; the row and the editor show what it holds.
  await until(() => persona().includes("claude-opus-5-5 \u00b7 high"), "the saved route")
  expect(persona()).toContain("project")
  expect(
    host.opens.slice(before).some((o) => o.source === "models.assignments" && o.window === 21),
  ).toBe(true)
  await until(() => text(root).includes("Saved"), "the confirmation")
})

/** The Sources disclosure of the pane over the selected model, opened. */
async function sourcesDisclosure(root: HTMLElement) {
  await until(() => pointIDs(root).length === 4, "the plotted models")
  click(root.querySelector('[data-point-id="configuration:openai/gpt-6.2-sol::none"]')!)
  await until(() => root.querySelector("h2[title*='gpt-6.2-sol']") !== null, "the pane")
  await until(
    () =>
      root.querySelector(".lazers-models-pane-disclosures .lazers-kit-disclosure-toggle") !== null,
    "the disclosures",
  )
  return openDisclosures(root)
}
function openDisclosures(root: HTMLElement) {
  for (const toggle of root.querySelectorAll<HTMLElement>(".lazers-kit-disclosure-toggle"))
    if (toggle.getAttribute("aria-expanded") !== "true") toggle.click()
  return () => text(root.querySelector(".lazers-models-pane-disclosures")!)
}
const refreshButton = (root: ParentNode) =>
  root.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!

test("source refresh: asked on open, forced by the Refresh button, the disclosure shows each source's state", async () => {
  // models.dev has no snapshot and its latest refresh failed, as the comparison stream reports it.
  const failing = (output: Candidates): Candidates => ({
    ...output,
    sources: output.sources.map((source) =>
      source.source === "models-dev"
        ? ({
            ...source,
            snapshotState: "none",
            snapshot: null,
            selectedSnapshotID: null,
            refresh: {
              state: "failed",
              generation: 1,
              startedAt: "2026-11-19T17:00:00.000Z",
              completedAt: "2026-11-19T17:00:05.000Z",
              latestSnapshotID: null,
              errorCode: "fetch_failed",
              httpStatus: 503,
            },
          } as never)
        : source,
    ),
  })
  let failForced = false
  const { host, root } = mount({
    comparison: failing,
    preferences: { open: true },
    refreshSources: (input) => {
      if (failForced && input.force === true) throw new Error("source fetch denied")
    },
  })
  const refreshes = () => host.sourceCalls.filter((call) => call.method === "refreshSources")
  // Opening the panel asks once, without the force flag: the service answers from stored snapshots.
  await until(() => refreshes().length === 1, "the open-time refresh")
  expect(refreshes()[0]!.input).toEqual({ sessionID: "ses-demo" })

  const sources = await sourcesDisclosure(root)
  await until(() => sources().includes("refresh failed"), "the failed source's state")
  expect(sources()).toContain("models.dev prices and model inforefresh failed")
  expect(sources()).toContain("A price source couldn't refresh; showing saved data.")
  expect(sources()).toContain("Native OpenCode catalog")
  expect(sources()).toContain("5 records")
  await until(() => !refreshButton(root).disabled, "the open-time refresh settles")
  expect(text(root)).not.toContain("Source refresh error")

  // The button forces every source to be fetched now.
  click(refreshButton(root))
  await until(() => refreshes().length === 2, "the forced refresh")
  expect(refreshes()[1]!.input).toEqual({ sessionID: "ses-demo", force: true })
  await until(() => !refreshButton(root).disabled, "the forced refresh settles")
  expect(text(root)).not.toContain("Source refresh error")

  // A failed request is shown as the panel's own error, and the button offers another try.
  failForced = true
  // The panel's other reads of the first refresh may still be settling: a click then is dropped.
  await until(() => {
    if (refreshes().length < 3 && !refreshButton(root).disabled) click(refreshButton(root))
    return refreshes().length === 3
  }, "the failing refresh")
  expect(refreshes()[2]!.input).toEqual({ sessionID: "ses-demo", force: true })
  await until(() => text(root).includes("source fetch denied"), "the error")
  expect(text(root)).toMatch(/source refresh error/i)
})

test("price sources: the configured order is read and shown, and a Refresh reads it again", async () => {
  let order = ["openrouter", "opencode"]
  let revision = 0
  const policy = () => ({
    policy: { schemaVersion: 1, revision, sources: order, fallback: "whole-model" },
    access: { openrouter: "configured", opencode: "configured" },
  })
  const { host, root } = mount({
    comparison: scored,
    priceSources: policy,
    preferences: { compareMode: "benchmark", open: true },
  })
  const reads = () => host.sourceCalls.filter((call) => call.method === "priceSources")
  await until(() => reads().length >= 1, "the open-time read")
  expect(reads()[0]!.input).toEqual({ sessionID: "ses-demo" })
  await until(() => pointIDs(root).length > 0, "the benchmark points")
  click(root.querySelector(".lazers-chart-point")!)
  await until(
    () => root.querySelector(".lazers-models-pane-disclosures") !== null,
    "the benchmark pane",
  )
  const pane = openDisclosures(root)
  await until(() => pane().includes("Price orderOpenRouter, then OpenCode"), "the read order")

  // The service reorders its sources: the Refresh button reads the order again.
  order = ["opencode", "openrouter"]
  revision = 1
  const before = reads().length
  click(refreshButton(root))
  await until(() => reads().length > before, "the order is read again")
  await until(() => pane().includes("Price orderOpenCode, then OpenRouter"), "the new order")
})

test("contributors: a run's Trajectory button hands the opener its task, project and directory", async () => {
  const { host, root } = mount({ preferences: { open: true } })
  await sourcesDisclosure(root)
  const open = () =>
    root.querySelector<HTMLButtonElement>('[aria-label="Open trajectory for LZ-216"]')
  await until(() => open() !== null, "the contributor's button")
  expect(host.trajectories).toEqual([])
  click(open()!)
  expect(host.trajectories).toHaveLength(1)
  const [request] = host.trajectories
  expect(request!.target).toMatchObject({
    reference: "LZ-216",
    projectDirectory: bundle.PROJECT.canonical,
  })
  expect(request!.target.taskID).toEqual(expect.any(String))
  expect(request!.target.projectID).toEqual(expect.any(String))
  expect(request!.session).toMatchObject({ id: "ses-demo" })
})

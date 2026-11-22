import { afterAll, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { fileURLToPath, pathToFileURL } from "node:url"

const dom = new Window({ url: "https://planning-panel.localhost" })
const globals = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "Document",
  "DocumentFragment",
  "Text",
  "Event",
  "navigator",
] as const
const previous = new Map<string, PropertyDescriptor | undefined>()
let mount!: typeof import("./dom-entry.tsx").harness

beforeAll(async () => {
  for (const name of globals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom[name] })
  }
  const outDir = fileURLToPath(
    new URL("../../node_modules/.cache/planning-panel-dom", import.meta.url),
  )
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { conditions: ["browser", "development", "module"] },
    plugins: [solid()],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("./dom-entry.tsx", import.meta.url)),
        formats: ["es"],
        fileName: "planning-dom",
      },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  mount = (
    (await import(
      pathToFileURL(`${outDir}/planning-dom.js`).href
    )) as typeof import("./dom-entry.tsx")
  ).harness
})
afterAll(() => {
  for (const [name, descriptor] of previous)
    descriptor
      ? Object.defineProperty(globalThis, name, descriptor)
      : delete (globalThis as never as Record<string, unknown>)[name]
})

const settle = async () => {
  for (let i = 0; i < 5; i++) await Bun.sleep(5)
}
const body = (objective: string) => ({
  title: "Plan",
  ask: "ask",
  assumptions: [],
  openDecisions: [],
  plan: { objective: "o", verification: [], acceptance: [] },
  tasks: [{ draftID: "plan-link", dependsOn: [], proposal: { objective } }],
})
const detail = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  title,
  state: "questions-open",
  revision: 2,
  body: body("Open a stored plan from a chat link."),
  validation: { plan: [], drafts: {}, graph: [] },
  hashes: { 1: { "plan-link": { writeScope: "a" } }, 2: { "plan-link": { writeScope: "b" } } },
  findings: [
    {
      id: "f1",
      source: "critic",
      revision: 1,
      draft_id: "plan-link",
      field: "write-scope",
      severity: "major",
      confidence: null,
      body: JSON.stringify({ what: "scope too wide" }),
      resolution: "open",
    },
  ],
  questions: [],
  reviews: [
    {
      id: "r1",
      stage: "review",
      revision: 1,
      runs: [
        {
          agent: "critic",
          state: "reviewed",
          reason: null,
          input_tokens: 100,
          output_tokens: 20,
          duration_ms: 2000,
        },
      ],
    },
  ],
  tasked: [],
  ...over,
})
const plan = (id: string, created: number) => ({
  id,
  title: `Plan ${id}`,
  state: "questions-open",
  revision: 2,
  created_at: created,
  updated_at: created,
  session_id: "s",
})

test("the panel shows the session's newest plan from the streams, and a stored change without polling", async () => {
  const root = dom.document.createElement("main")
  dom.document.body.append(root)
  const api = mount(root as never, {
    plans: [plan("p2", 2), plan("p1", 1)],
    details: [detail("p2", "Newest plan"), detail("p1", "Older plan")],
  })
  try {
    await settle()
    const text = () => root.textContent ?? ""
    expect(text()).toContain("Newest plan")
    expect(text()).toContain("r2")
    expect(text()).toContain("scope too wide — stale (r1)")
    expect(text()).toContain("critic: reviewed · 1 attempt · 120 tokens · 2 s")
    expect(api.open().map((stream) => [stream.source, stream.window, stream.filter])).toEqual([
      ["planning.list", 1, { sessionID: "s" }],
      ["planning.detail", 1, { planningID: "p2" }],
    ])
    // No Planning RPC, no poll: only stream opens.
    expect(api.calls.map((call) => call.method)).toEqual(["open", "open"])
    await Bun.sleep(3_200)
    expect(api.calls.map((call) => call.method)).toEqual(["open", "open"])
    // A stored change arrives as a stream change.
    api.set({ details: [detail("p2", "Renamed plan"), detail("p1", "Older plan")] })
    await settle()
    expect(text()).toContain("Renamed plan")
  } finally {
    api.dispose()
    root.remove()
  }
})

test("a session with no plan, or a plan with no revision yet, shows the empty state", async () => {
  for (const plans of [[], [plan("p3", 3)]]) {
    const root = dom.document.createElement("main")
    dom.document.body.append(root)
    const api = mount(root as never, { plans, details: [] })
    try {
      await settle()
      expect(root.textContent).toContain("No plan in this session yet.")
    } finally {
      api.dispose()
      root.remove()
    }
  }
})

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { renderToString } from "solid-js/web"
import * as gui from "@opencode/plugin/gui"
import { PluginContext } from "../../node_modules/@opencode/plugin/dist/gui/internal.js"
import { createServer } from "vite"
import { gui as guiPlugin } from "@opencode/plugin/gui/vite"

// Compile with the shipped Solid/Vite boundary rather than a mirrored JSX fake.
// Middleware-only with websockets disabled has no listening socket.
const vite = await createServer({
  configFile: false,
  plugins: [guiPlugin()],
  server: { middlewareMode: true, ws: false },
  appType: "custom",
})
afterAll(() => vite.close())
const { setupTaskPanel, verificationTimingSummary } = (await vite.ssrLoadModule(
  "/src/tasks/panel.tsx",
)) as typeof import("../../src/tasks/panel.tsx")
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})
const virtualRows = (await vite.ssrLoadModule(
  "/src/tasks/virtual-rows.ts",
)) as typeof import("../../src/tasks/virtual-rows.ts")
const { taskSequencing, taskRowPresentation } = (await vite.ssrLoadModule(
  "/src/tasks/row-presentation.ts",
)) as typeof import("../../src/tasks/row-presentation.ts")
const Icon = (props: { name: string; size?: string }) => `icon:${props.name}:${props.size}`

type Contribution = { registry: unknown; value: Record<string, unknown> }
type FakeSession = { id: string; location?: { directory: string } }

function install(session: FakeSession | undefined) {
  const added: Contribution[] = []
  const opened: string[] = []
  const ctx = {
    id: "lazers",
    ui: { Icon },
    add: (registry: unknown, value: Record<string, unknown>) => {
      added.push({ registry, value })
    },
    sessions: { current: () => session },
    layout: {
      open: (key: string) => {
        opened.push(key)
      },
    },
  }
  disposers.push(
    createRoot((dispose) => {
      createComponent(PluginContext.Provider, {
        value: ctx as never,
        get children() {
          return createComponent(() => {
            setupTaskPanel(ctx as unknown as Parameters<typeof setupTaskPanel>[0], () => {})
            return null
          }, {})
        },
      })
      return dispose
    }),
  )
  const find = (registry: unknown) => added.find((entry) => entry.registry === registry)?.value
  return { added, find, opened }
}

const panelTab = () => {
  const installed = install({ id: "ses_1", location: { directory: "/repo" } })
  const panel = installed.find(gui.Panel)
  if (!panel) throw new Error("missing Panel contribution")
  const list = panel.list as (input: { open: string[] }) => readonly Record<string, unknown>[]
  const tabs = list({ open: ["tasks"] })
  const tab = tabs[0]
  if (!tab) throw new Error("missing tasks tab")
  return { installed, list, panel, tab }
}

describe("tasks native affordances", () => {
  test("verification detail separates no deadline, authored overrides, and legacy timing", () => {
    const omitted = verificationTimingSummary({ id: "check", command: "bun test" })
    expect(omitted).toBe(
      "Inactivity allowance: none unless the project sets one · Hard backstop: none unless the project sets one",
    )
    expect(omitted).not.toMatch(/NaN|undefined/)

    const legacyOnly = verificationTimingSummary({
      id: "legacy",
      command: "bun test",
      timeoutMs: 5_000,
    })
    expect(legacyOnly).toContain("Inactivity allowance: none unless the project sets one")
    expect(legacyOnly).toContain("Hard backstop: none unless the project sets one")
    expect(legacyOnly).toContain("Legacy timeout (historical): 5s (not used for execution)")

    const dualTiming = verificationTimingSummary({
      id: "current",
      command: "bun test",
      inactivityTimeoutMs: 15_000,
      hardTimeoutMs: 60_000,
    })
    expect(dualTiming).toContain("Inactivity allowance: 15s (authored)")
    expect(dualTiming).toContain("Hard backstop: 60s (authored)")
    expect(dualTiming).not.toContain("Legacy timeout")

    const partial = verificationTimingSummary({
      id: "partial",
      command: "bun test",
      inactivityTimeoutMs: 30_000,
    })
    expect(partial).toContain("Inactivity allowance: 30s (authored)")
    expect(partial).toContain("Hard backstop: none unless the project sets one")

    const mixed = verificationTimingSummary({
      id: "mixed",
      command: "bun test",
      timeoutMs: 4_000,
      inactivityTimeoutMs: 7_000,
      hardTimeoutMs: 9_000,
    })
    expect(mixed).toContain("Inactivity allowance: 7s (authored)")
    expect(mixed).toContain("Hard backstop: 9s (authored)")
    expect(mixed).toContain("Legacy timeout (historical): 4s (not used for execution)")
  })

  test("the task list has no plan headings; sequencing and state are icon-only signals", () => {
    const base = {
      taskID: "t",
      title: "Task",
      status: "queued",
      reason: null,
      waiting: false,
      holdReason: null,
      ordinal: 0,
      contextOnly: false,
      prerequisites: [],
      successors: [],
    }
    expect("planHeaded" in virtualRows).toBe(false)
    expect(taskSequencing(base)).toMatchObject({ kind: "parallel", label: "Parallel-eligible" })
    expect(taskSequencing({ ...base, prerequisites: ["a", "b"] })).toMatchObject({
      kind: "sequenced",
      label: "Sequenced",
      detail: "Runs after 2 dependencies",
    })
    // The state icon keeps its accessible name; plan lifecycle never decorates a row.
    expect(taskRowPresentation({ ...base, status: "running" }).label).toBe("Running")
    expect(taskRowPresentation({ ...base, status: "failed" }).label).toBe("Failed")
  })

  test("session.panel menu places Tasks after the native extra-panel entries", () => {
    const installed = install({ id: "ses_1", location: { directory: "/repo" } })
    const tasks = installed.find(gui.MenuItem)
    expect(tasks).toBeDefined()
    expect(tasks!.menu).toBe("session.panel")
    expect(tasks!.title).toBe("Tasks")
    // Pinned OpenCode 2.2.5 native session.panel orders (gui-plugins review/browser/
    // terminal/file renderer registrations). The host sorts items ascending by `order ?? 0`.
    const native = [
      { key: "review", order: 10 },
      { key: "browser", order: 15 },
      { key: "terminal", order: 20 },
      { key: "file", order: 30 },
    ]
    const tasksOrder = (tasks!.order as number | undefined) ?? 0
    const entries = [...native, { key: "lazers:tasks", order: tasksOrder }].toSorted(
      (a, b) => a.order - b.order,
    )
    expect(entries[entries.length - 1]!.key).toBe("lazers:tasks")
    expect(tasksOrder).toBeGreaterThan(30)
  })

  test("closable tab renders a themed task icon with the Tasks title", () => {
    const { tab } = panelTab()
    expect(tab.title).toBe("Tasks")
    expect(tab.closable).toBe("hover")
    const label = tab.label
    expect(typeof label).toBe("function")
    const rendered = renderToString(() => (label as () => string)())
    expect(rendered).toContain("icon:task:small")
    expect(rendered).toContain("<span>Tasks</span>")
    expect(rendered).toStartWith("<div ")
  })

  test("tab object stays stable while listed", () => {
    const { list } = panelTab()
    expect(list({ open: ["tasks"] })[0]).toBe(list({ open: ["tasks"] })[0])
  })

  test("open, closed, and reopened sessions drive the native strip", () => {
    const installed = install({ id: "ses_1", location: { directory: "/repo" } })
    const panel = installed.find(gui.Panel)
    const list = panel!.list as (input: { open: string[] }) => readonly Record<string, unknown>[]
    expect(list({ open: ["tasks"] })[0]!.id).toBe("tasks")
    expect(list({ open: [] })).toEqual([])
    expect(list({ open: ["tasks"] })[0]!.id).toBe("tasks")
    const menu = installed.find(gui.MenuItem)
    ;(menu!.run as () => void)()
    expect(installed.opened).toEqual(["lazers:tasks"])
    const command = installed.find(gui.Command)
    expect(command!.id).toBe("tasks.open")
    expect(command!.slash).toEqual({ name: "lz-tasks" })
    ;(command!.run as () => void)()
    expect(installed.opened).toEqual(["lazers:tasks", "lazers:tasks"])
  })

  test("opening without a located session does nothing", () => {
    const installed = install(undefined)
    const menu = installed.find(gui.MenuItem)
    ;(menu!.run as () => void)()
    expect(installed.opened).toEqual([])
  })
})

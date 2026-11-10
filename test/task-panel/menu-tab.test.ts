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
const { setupTaskPanel } = (await vite.ssrLoadModule(
  "/src/tasks/panel.tsx",
)) as typeof import("../../src/tasks/panel.tsx")
const { ExecutionPlanGroupView } = (await vite.ssrLoadModule(
  "/src/tasks/execution-list-view.tsx",
)) as typeof import("../../src/tasks/execution-list-view.tsx")
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})
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
  test("plan nonterminal counts stay distinct from native activity", () => {
    const group = (title: string, nonterminalCount: number, totalCount: number) => ({
      planID: title,
      planVersion: 1,
      planRevision: 1,
      title,
      hasRecordedTitle: true,
      nonterminalCount,
      totalCount,
      rows: [],
    })
    const renderGroup = (
      title: string,
      nonterminalCount: number,
      totalCount: number,
      stateFilter: "open" | "completed" | "cancelled",
    ) =>
      renderToString(() =>
        createComponent(ExecutionPlanGroupView, {
          group: group(title, nonterminalCount, totalCount),
          stateFilter,
          children: "Visible task",
        }),
      )

    const open = renderGroup("Open plan", 1, 2, "open")
    expect(open).toContain('aria-label="Open plan, 1 remaining of 2 tasks in this plan"')
    expect(open).toContain(">1/2 remaining</span>")
    expect(open).toContain("Visible task")
    expect(open).toContain("<details open>")

    const unnamed = renderToString(() =>
      createComponent(ExecutionPlanGroupView, {
        group: { ...group("Placeholder plan", 1, 1), hasRecordedTitle: false },
        stateFilter: "open",
        children: "Standalone task",
      }),
    )
    expect(unnamed).not.toContain("Placeholder plan")
    expect(unnamed).not.toContain("<summary")
    expect(unnamed).toContain("Standalone task")

    const completed = renderGroup("Completed plan", 0, 1, "completed")
    expect(completed).toContain('aria-label="Completed plan"')
    expect(completed).not.toContain(">0/1</span>")
    expect(completed).toContain("Visible task")

    const cancelled = renderGroup("Cancelled plan", 1, 1, "cancelled")
    expect(cancelled).toContain('aria-label="Cancelled plan"')
    expect(cancelled).not.toContain(">1/1</span>")
    expect(cancelled).toContain("Visible task")
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

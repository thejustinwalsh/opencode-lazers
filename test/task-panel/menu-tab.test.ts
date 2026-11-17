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
const { ExecutionPlanHeading } = (await vite.ssrLoadModule(
  "/src/tasks/execution-list-view.tsx",
)) as typeof import("../../src/tasks/execution-list-view.tsx")
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})
const { planHeaded } = (await vite.ssrLoadModule(
  "/src/tasks/virtual-rows.ts",
)) as typeof import("../../src/tasks/virtual-rows.ts")
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
  test("verification detail separates project defaults, authored overrides, and legacy timing", () => {
    const omitted = verificationTimingSummary({ id: "check", command: "bun test" })
    expect(omitted).toBe(
      "Inactivity allowance: project default (not resolved here) · Hard backstop: project default (not resolved here)",
    )
    expect(omitted).not.toMatch(/NaN|undefined/)

    const legacyOnly = verificationTimingSummary({
      id: "legacy",
      command: "bun test",
      timeoutMs: 5_000,
    })
    expect(legacyOnly).toContain("Inactivity allowance: project default")
    expect(legacyOnly).toContain("Hard backstop: project default")
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
    expect(partial).toContain("Hard backstop: project default (not resolved here)")

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

  test("plan nonterminal counts stay distinct from native activity", () => {
    const group = (title: string, nonterminalCount: number, totalCount: number) => ({
      planID: title,
      planVersion: 1,
      planRevision: 1,
      title,
      hasRecordedTitle: true,
      state: "running",
      nonterminalCount,
      totalCount,
      rows: [],
    })
    const renderGroup = (
      title: string,
      nonterminalCount: number,
      totalCount: number,
      stateFilter: "open" | "completed" | "cancelled",
    ) => {
      const value = group(title, nonterminalCount, totalCount)
      return planHeaded(value)
        ? renderToString(() =>
            createComponent(ExecutionPlanHeading, {
              group: value,
              stateFilter,
              collapsed: false,
              onToggle: () => {},
            }),
          )
        : ""
    }

    const open = renderGroup("Open plan", 1, 2, "open")
    expect(open).toContain('aria-label="Open plan, 1 remaining of 2 tasks in this plan"')
    expect(open).toContain(">1/2 remaining</span>")
    expect(open).toContain('aria-expanded="true"')

    // An untitled plan gets no heading item in the flat list.
    expect(
      planHeaded({ ...group("Placeholder plan", 1, 1), hasRecordedTitle: false } as never),
    ).toBe(false)

    const completed = renderGroup("Completed plan", 0, 2, "completed")
    expect(completed).toContain('aria-label="Completed plan"')
    expect(completed).not.toContain(">0/2 remaining</span>")

    const cancelled = renderGroup("Cancelled plan", 1, 2, "cancelled")
    expect(cancelled).toContain('aria-label="Cancelled plan"')
    expect(cancelled).not.toContain(">1/2 remaining</span>")

    // A one-task plan is its task: no heading competes with the row's own title.
    const single = renderGroup("Single task plan", 1, 1, "open")
    expect(single).toBe("")
  })

  test("plan headings show recorded priority and integration or cleanup state", () => {
    const rendered = renderToString(() =>
      createComponent(ExecutionPlanHeading, {
        collapsed: false,
        onToggle: () => {},
        group: {
          planID: "cleanup",
          planVersion: 1,
          planRevision: 1,
          title: "Retry-safe submission",
          hasRecordedTitle: true,
          state: "cleanup-blocked",
          priority: 2,
          nonterminalCount: 0,
          totalCount: 3,
          rows: [],
        },
        stateFilter: "all",
      }),
    )
    expect(rendered).toContain('class="lazers-tasks-plan"')
    expect(rendered).toContain(
      'aria-label="Retry-safe submission, priority 2, plan cleanup blocked"',
    )
    expect(rendered).toContain(">Cleanup blocked</span>")
    expect(rendered).toMatch(/Scheduler priority for this plan"[^>]*>Priority (?:<!--[^>]*-->)*2/)
    // A one-task plan keeps its heading when the scheduler records plan prerequisites.
    const gatedGroup = {
      planID: "gated",
      planVersion: 1,
      planRevision: 1,
      title: "Gated single task",
      hasRecordedTitle: true,
      nonterminalCount: 1,
      totalCount: 1,
      rows: [],
      priority: 0,
      planOrder: 2,
      afterPlans: ["11111111-1111-4111-8111-111111111111"],
      schedulingReason: "Waiting for prerequisite plans to integrate.",
    }
    expect(planHeaded(gatedGroup)).toBe(true)
    const gated = renderToString(() =>
      createComponent(ExecutionPlanHeading, {
        group: gatedGroup,
        stateFilter: "open",
        collapsed: false,
        onToggle: () => {},
        planTitle: () => "Parent implementation",
      }),
    )
    expect(gated).toContain("Gated single task")
    expect(gated).toMatch(/>Order (?:<!--[^>]*-->)*3/)
    expect(gated).toContain(">Parent implementation</button>")
    expect(gated).toContain('title="Waiting for prerequisite plans to integrate."')
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

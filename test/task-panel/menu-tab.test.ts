import { describe, expect, mock, test } from "bun:test"

// Bun has no Solid DOM host, so the JSX runtime is mocked into inspectable records and the
// gui barrel is mocked to stable registry tokens with an identity `bindPlugin` (the real
// `bindPlugin` reads a host context that only exists inside a plugin contribution).
type VNode = {
  tag?: unknown
  component?: unknown
  props: Record<string, unknown>
}

const jsxRecord = (type: unknown, props: Record<string, unknown>): VNode =>
  typeof type === "function" ? { component: type, props } : { tag: type, props }

const Icon = (props: { name: string; size?: string }) => ({ icon: props.name })
const gui = {
  Command: { name: "Command" },
  LinkHandler: { name: "LinkHandler" },
  MenuItem: { name: "MenuItem" },
  Panel: { name: "Panel" },
  Style: { name: "Style" },
  Store: { session: () => ({}) },
  bindPlugin: (component: unknown) => component,
  createLatest: () => ({}),
  createKeyed: () => undefined,
  usePanel: () => ({ visible: () => true }),
}

// `solid-js/jsx-runtime` and `solid-js/jsx-dev-runtime` resolve to the same file and
// `mock.module` replaces the whole mock per resolved file, so both carry the full export
// set and the dev entry (which Bun's test transform imports) is registered last.
mock.module("@opencode/plugin/gui", () => gui)
mock.module("solid-js/jsx-runtime", () => ({
  jsx: jsxRecord,
  jsxs: jsxRecord,
  Fragment: "Fragment",
}))
mock.module("solid-js/jsx-dev-runtime", () => ({
  jsxDEV: jsxRecord,
  jsx: jsxRecord,
  jsxs: jsxRecord,
  Fragment: "Fragment",
}))

const { setupTaskPanel } = await import("../../src/tasks/panel.tsx")

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
  setupTaskPanel(ctx as unknown as Parameters<typeof setupTaskPanel>[0])
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
    const node = (label as (state: unknown) => VNode)({
      active: true,
      preview: false,
      session: { key: "ses_1" },
    })
    expect(node.tag).toBe("div")
    const children = node.props.children as VNode[]
    expect(children).toBeArrayOfSize(2)
    const icon = children[0]!
    expect(icon.component).toBe(Icon)
    expect(icon.props.name).toBe("task")
    expect(icon.props.size).toBe("small")
    const title = children[1]!
    expect(title.tag).toBe("span")
    expect(title.props.children).toBe("Tasks")
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
    ;(command!.run as () => void)()
    expect(installed.opened.length).toBe(2)
  })

  test("opening without a located session does nothing", () => {
    const installed = install(undefined)
    const menu = installed.find(gui.MenuItem)
    ;(menu!.run as () => void)()
    expect(installed.opened).toEqual([])
  })
})

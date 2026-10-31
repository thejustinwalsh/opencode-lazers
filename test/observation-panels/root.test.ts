import { expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { Panel, Command, MenuItem } from "@opencode/plugin/gui"
import { PluginContext } from "../../node_modules/@opencode/plugin/dist/gui/internal.js"
import { createServer } from "vite"

test("shipped GUI setup registers both observation panels exactly once", async () => {
  const vite = await createServer({
    configFile: "./vite.config.ts",
    server: { middlewareMode: true },
    appType: "custom",
  })
  try {
    const { default: gui } = await vite.ssrLoadModule("/src/gui.tsx")
    const session = { id: "ses-observation", location: {} }
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const opened: unknown[][] = []
    const ctx = {
      id: "lazers",
      app: { platform: "web" },
      add: (token: unknown, value: unknown) => registrations.push({ token, value }),
      sessions: { current: () => session },
      layout: { open: (...args: unknown[]) => opened.push(args) },
    }

    const dispose = createRoot((dispose) => {
      createComponent(PluginContext.Provider, {
        value: ctx as never,
        get children() {
          return createComponent(() => {
            gui.setup?.(ctx as never)
            return null
          }, {})
        },
      })
      return dispose
    })
    try {
      expect(Object.keys(gui.stores)).toContain("radarView")
      expect(Object.keys(gui.stores)).toContain("trajectoryView")

      const panels = registrations
        .filter((entry) => entry.token === Panel)
        .map(
          (entry) =>
            entry.value as {
              id: string
              list: (input: { open: string[] }) => unknown[]
              render: unknown
            },
        )
      expect(panels.map((panel) => panel.id)).toEqual(["tasks", "radar", "trajectory"])
      for (const [id, title] of [
        ["radar", "Radar"],
        ["trajectory", "Trajectory"],
      ] as const) {
        const panel = panels.find((item) => item.id === id)!
        expect(panel.list({ open: [] })).toEqual([])
        expect(panel.list({ open: [id] })).toEqual([{ id, title, closable: "hover" }])
        expect(typeof panel.render).toBe("function")
      }

      for (const id of ["radar", "trajectory"]) {
        registrations
          .filter(
            (entry) =>
              (entry.token === Command || entry.token === MenuItem) &&
              (entry.value as { id?: string }).id === `${id}.open`,
          )
          .forEach((entry) => (entry.value as { run: () => void }).run())
      }
      expect(opened).toEqual([
        [`lazers:radar`, session, { tab: "select" }],
        [`lazers:radar`, session, { tab: "select" }],
        [`lazers:trajectory`, session, { tab: "select" }],
        [`lazers:trajectory`, session, { tab: "select" }],
      ])
    } finally {
      dispose()
    }
  } finally {
    await vite.close()
  }
})

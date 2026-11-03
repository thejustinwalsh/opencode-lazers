import { expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { Panel, Command, MenuItem } from "@opencode/plugin/gui"
import { PluginContext } from "../../node_modules/@opencode/plugin/dist/gui/internal.js"
import { createServer } from "vite"
import { fileURLToPath } from "node:url"

test("shipped GUI setup registers the observation and comparison panels exactly once", async () => {
  const guiRoot = fileURLToPath(new URL("../../src/gui.tsx", import.meta.url))
  const inferenceRuntimeModule = "\0lazers-test-unused-inference-runtime"
  let replacedInferenceRuntime = false
  const vite = await createServer({
    configFile: "./vite.config.ts",
    plugins: [
      {
        name: "test-unused-inference-runtime",
        enforce: "pre",
        resolveId(source, importer) {
          if (source !== "./webgpu/runtime.ts" || importer !== guiRoot) return
          replacedInferenceRuntime = true
          return inferenceRuntimeModule
        },
        load(id) {
          if (id !== inferenceRuntimeModule) return
          return `export function createInferenceRuntime() {
            throw new Error("The inference runtime is not used by this GUI registration test")
          }`
        },
      },
    ],
    server: { middlewareMode: true, ws: false },
    appType: "custom",
  })
  try {
    const { default: gui } = await vite.ssrLoadModule("/src/gui.tsx")
    expect(replacedInferenceRuntime).toBe(true)
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
      expect(Object.keys(gui.stores)).toContain("modelsView")

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
      expect(panels.map((panel) => panel.id).toSorted()).toEqual([
        "models",
        "radar",
        "tasks",
        "trajectory",
      ])
      for (const [id, title] of [
        ["radar", "Radar"],
        ["models", "Models"],
        ["trajectory", "Trajectory"],
      ] as const) {
        const panel = panels.find((item) => item.id === id)!
        expect(panel.list({ open: [] })).toEqual([])
        expect(panel.list({ open: [id] })).toMatchObject([{ id, title, closable: "hover" }])
        expect(typeof panel.render).toBe("function")
      }

      for (const id of ["radar", "models", "trajectory"]) {
        registrations
          .filter(
            (entry) =>
              (entry.token === Command || entry.token === MenuItem) &&
              ((entry.value as { id?: string }).id === `${id}.open` ||
                (id === "models" && (entry.value as { id?: string }).id === "lz-models")),
          )
          .forEach((entry) => (entry.value as { run: () => void }).run())
      }
      expect(opened).toEqual([
        [`lazers:radar`, session, { tab: "select" }],
        [`lazers:radar`, session, { tab: "select" }],
        [`lazers:models`, session, { tab: "select" }],
        [`lazers:models`, session, { tab: "select" }],
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

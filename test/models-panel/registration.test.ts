import { expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { Command, MenuItem, Panel, Style } from "@opencode/plugin/gui"
import { PluginContext } from "../../node_modules/@opencode/plugin/dist/gui/internal.js"
import { registerModelsPanel } from "../../src/models/registration.ts"

test("Models registration opens a closable optional panel from /lz-models and the native menu", () => {
  const session = { id: "ses-models", location: { directory: "/repo" } }
  const additions: Array<{ token: unknown; value: Record<string, unknown> }> = []
  const opened: unknown[][] = []
  const ctx = {
    id: "lazers",
    ui: { Icon: (props: { name: string; size?: string }) => `icon:${props.name}:${props.size}` },
    add: (token: unknown, value: Record<string, unknown>) => additions.push({ token, value }),
    sessions: { current: () => session },
    layout: { open: (...args: unknown[]) => opened.push(args) },
  }
  const dispose = createRoot((rootDispose) => {
    createComponent(PluginContext.Provider, {
      value: ctx as never,
      get children() {
        return createComponent(() => {
          registerModelsPanel(
            ctx as never,
            ".lazers-models { color: inherit; }",
            (() => null) as never,
            (() => null) as never,
          )
          return null
        }, {})
      },
    })
    return rootDispose
  })
  try {
    const find = (token: unknown) => additions.find((item) => item.token === token)?.value
    const panel = find(Panel) as {
      id: string
      list(input: { open: string[] }): Array<{
        id: string
        title: string
        closable: string
      }>
      render: unknown
    }
    expect(find(Style)).toBeDefined()
    expect(panel.id).toBe("models")
    expect(panel.list({ open: [] })).toEqual([])
    expect(panel.list({ open: ["models"] })).toMatchObject([
      { id: "models", title: "Models", closable: "hover" },
    ])
    expect(panel.list({ open: [] })).toEqual([])
    expect(typeof panel.render).toBe("function")

    const command = find(Command)!
    expect(command.id).toBe("lz-models")
    expect(command.slash).toEqual({ name: "lz-models" })
    ;(command.run as () => void)()
    ;(find(MenuItem)!.run as () => void)()
    expect(opened).toEqual([
      ["lazers:models", session, { tab: "select" }],
      ["lazers:models", session, { tab: "select" }],
    ])
  } finally {
    dispose()
  }
})

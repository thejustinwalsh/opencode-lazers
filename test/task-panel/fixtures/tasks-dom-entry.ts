import { createComponent, createEffect, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { LinkHandler, Panel } from "@opencode/plugin/gui"
import type { Panel as PanelContribution } from "@opencode/plugin/gui"
import { createTestUI as createBaseTestUI } from "../../models-panel/fixtures/dom-host.ts"
import {
  PanelContext,
  PluginContext,
} from "../../../node_modules/@opencode/plugin/dist/gui/internal.js"

export { default as gui } from "../../../src/gui.tsx"
export {
  createReactiveStore,
  registryTokens,
  setupGui,
} from "../../models-panel/fixtures/dom-host.ts"
export { LinkHandler }
/** The bundle's own Solid signal, for reactive host fixtures (a session whose fields update). */
export { createSignal }

export function createTestUI() {
  const ui = createBaseTestUI()
  ui.Menu = (props: Parameters<typeof ui.Menu>[0]) => {
    const root = document.createElement("div")
    root.className = "test-menu"
    const trigger = document.createElement("button")
    trigger.type = "button"
    trigger.setAttribute("aria-haspopup", "menu")
    createEffect(() => {
      trigger.textContent = String(props.label ?? "")
      trigger.setAttribute("aria-label", String(props.label ?? ""))
      trigger.disabled = Boolean(props.disabled)
    })
    trigger.addEventListener("click", () => {
      const existing = root.querySelector('[role="menu"]')
      if (existing) {
        existing.remove()
        return
      }
      const menu = document.createElement("div")
      menu.setAttribute("role", "menu")
      const items = props.items as
        Array<{ label: string; icon?: string; onSelect: () => void }> | undefined
      for (const item of items ?? []) {
        const option = document.createElement("button")
        option.type = "button"
        option.setAttribute("role", "menuitem")
        option.textContent = item.label
        if (item.icon) option.dataset.icon = item.icon
        option.addEventListener("click", () => {
          item.onSelect()
          menu.remove()
        })
        menu.append(option)
      }
      root.append(menu)
    })
    root.append(trigger)
    return root
  }
  return ui
}

export function taskPanelRegistration(registrations: Array<{ token: unknown; value: unknown }>) {
  return registrations.find(
    (entry) => entry.token === Panel && (entry.value as { id?: string }).id === "tasks",
  )?.value as PanelContribution | undefined
}

export function mountTaskPanel(
  panel: PanelContribution,
  context: unknown,
  session: unknown,
  container: HTMLElement,
  screen: unknown = {},
) {
  const [visible, setVisible] = createSignal(true)
  const frame = {
    visible,
    present: visible,
    placement: () => "side" as const,
    reserve: () => false,
    animate: () => false,
    sidebar: {
      opened: () => false,
      width: () => 0,
      transition: () => false,
      resize: () => {},
      toggle: () => {},
    },
    open: () => ["tasks"],
  }
  const dispose = render(
    () =>
      createComponent(PluginContext.Provider, {
        value: context as never,
        get children() {
          return createComponent(PanelContext.Provider, {
            value: frame as never,
            get children() {
              return panel.render({
                tab: { id: "tasks", title: "Tasks", closable: "hover", label: () => null },
                session,
                screen,
              } as never)
            },
          })
        },
      }),
    container,
  )
  return { dispose, visible, setVisible }
}

import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { LinkHandler, Panel } from "@opencode/plugin/gui"
import type { Panel as PanelContribution } from "@opencode/plugin/gui"
import {
  PanelContext,
  PluginContext,
} from "../../../node_modules/@opencode/plugin/dist/gui/internal.js"

export { default as gui } from "../../../src/gui.tsx"
export {
  createReactiveStore,
  createTestUI,
  registryTokens,
  setupGui,
} from "../../models-panel/fixtures/dom-host.ts"
export { LinkHandler }

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
                screen: {},
              } as never)
            },
          })
        },
      }),
    container,
  )
  return { dispose, visible, setVisible }
}

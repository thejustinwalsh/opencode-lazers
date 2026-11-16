import { createComponent, createRoot, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Panel } from "@opencode/plugin/gui"
import type { Panel as PanelContribution } from "@opencode/plugin/gui"
import {
  PanelContext,
  PluginContext,
} from "../../../node_modules/@opencode/plugin/dist/gui/internal.js"
import { setupRadarPanel } from "../../../src/radar/panel.tsx"
import {
  createReactiveStore,
  createTestUI,
  registryTokens,
} from "../../models-panel/fixtures/dom-host.ts"

export { createReactiveStore, createTestUI, registryTokens }

export function setupRadar(context: unknown, navigation?: unknown) {
  return createRoot((dispose) => {
    createComponent(PluginContext.Provider, {
      value: context as never,
      get children() {
        return createComponent(() => {
          setupRadarPanel(context as never, navigation as never)
          return null
        }, {})
      },
    })
    return dispose
  })
}

export function radarPanelRegistration(registrations: Array<{ token: unknown; value: unknown }>) {
  return registrations.find(
    (entry) => entry.token === Panel && (entry.value as { id?: string }).id === "radar",
  )?.value as PanelContribution | undefined
}

export function mountRadarPanel(
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
    open: () => ["radar"],
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
                tab: { id: "radar", title: "Radar", closable: "hover", label: () => null },
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

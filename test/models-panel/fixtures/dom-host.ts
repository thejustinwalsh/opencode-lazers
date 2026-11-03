import { createComponent, createEffect, createRoot, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Command, MenuItem, Panel, Style } from "@opencode/plugin/gui"
import type { Panel as PanelContribution } from "@opencode/plugin/gui"
import {
  PanelContext,
  PluginContext,
} from "../../../node_modules/@opencode/plugin/dist/gui/internal.js"

export const registryTokens = { Command, MenuItem, Panel, Style }

export function createReactiveStore<T>(initial: T) {
  const [read, write] = createSignal(initial, { equals: false })
  return {
    get value() {
      return read()
    },
    ready: () => true,
    update(change: (draft: T) => void) {
      const draft = structuredClone(read())
      change(draft)
      write(() => draft)
    },
    snapshot: read,
  }
}

type ButtonProps = {
  label?: string
  children?: unknown
  disabled?: boolean
  busy?: boolean
  icon?: string
  "aria-label"?: string
  title?: string
  onClick?: (event: MouseEvent) => void
}

function button(props: ButtonProps, menuTrigger = false) {
  const element = document.createElement("button")
  element.type = "button"
  element.addEventListener("click", (event) => props.onClick?.(event))
  createEffect(() => {
    element.disabled = Boolean(props.disabled)
    if (props.busy) element.setAttribute("aria-busy", "true")
    else element.removeAttribute("aria-busy")
    const label = props["aria-label"] ?? (menuTrigger ? props.label : undefined)
    if (label) element.setAttribute("aria-label", label)
    else element.removeAttribute("aria-label")
    if (props.title) element.title = props.title
    else element.removeAttribute("title")
    if (menuTrigger) element.setAttribute("aria-haspopup", "menu")
    else element.removeAttribute("aria-haspopup")
    element.textContent = String(props.label ?? props.children ?? "")
  })
  return element
}

export function createTestUI() {
  return {
    Button: button,
    Menu: (props: ButtonProps) => button(props, true),
    Icon: (props: { name: string }) => {
      const element = document.createElement("span")
      element.textContent = props.name
      return element
    },
    Loader: () => {
      const element = document.createElement("span")
      element.textContent = "Loading"
      return element
    },
  }
}

export function setupGui(gui: { setup?: (context: unknown) => void }, context: unknown) {
  return createRoot((dispose) => {
    createComponent(PluginContext.Provider, {
      value: context as never,
      get children() {
        return createComponent(() => {
          gui.setup?.(context)
          return null
        }, {})
      },
    })
    return dispose
  })
}

export function modelPanelRegistration(registrations: Array<{ token: unknown; value: unknown }>) {
  return registrations.find(
    (entry) => entry.token === Panel && (entry.value as { id?: string }).id === "models",
  )?.value as PanelContribution | undefined
}

export function mountModelPanel(
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
    open: () => ["models"],
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
                tab: { id: "models", title: "Models", closable: "hover", label: () => null },
                session,
                screen: {},
              } as never)
            },
          })
        },
      }),
    container,
  )
  return { visible, setVisible, dispose }
}

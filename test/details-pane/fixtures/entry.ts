import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { DetailsPane } from "../../../src/details-pane.tsx"

const ui = { Icon: (props: { name: string }) => `icon:${props.name}` }

/** Mounts a pane whose persisted state lives in signals, as a panel's stored view would. */
export function mountPane(container: HTMLElement, initial: { open?: boolean; size?: number } = {}) {
  const [open, setOpen] = createSignal(initial.open ?? false)
  const [size, setSize] = createSignal(initial.size ?? 0.45)
  const [selected, setSelected] = createSignal<string | undefined>(undefined)
  const events: string[] = []
  const dispose = render(
    () =>
      createComponent(DetailsPane, {
        ui: ui as never,
        get open() {
          return open()
        },
        onOpen: (next: boolean) => {
          events.push(`open:${next}`)
          setOpen(next)
        },
        get size() {
          return size()
        },
        onSize: (next: number) => {
          events.push(`size`)
          setSize(next)
        },
        get header() {
          const value = selected()
          return value ? `Selected ${value}` : undefined
        },
        get actions() {
          return selected() ? "ACTION" : undefined
        },
        empty: "Nothing selected",
        top: "TOP",
        children: "BODY",
        bodyClass: "test-body",
      }),
    container,
  )
  return { dispose, open, size, setSelected, events }
}

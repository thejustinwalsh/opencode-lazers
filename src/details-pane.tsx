import type { Ui as HostUi } from "@opencode/plugin/gui"
import { Show, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { dragState, keyboardState, storedState } from "./details-pane.ts"
import type { DetailsState } from "./details-pane.ts"

/**
 * The bottom "details" region every inspector panel shares, VS Code panel style. It is always
 * present: collapsed it is one 32 px header bar, open the bar stays pinned and only `children`
 * scrolls. Selecting an item never opens it; callers persist `open` and `size`.
 */
export function DetailsPane(props: {
  ui: HostUi
  open: boolean
  onOpen: (open: boolean) => void
  /** Body height as a fraction (0..1) of the pane's container when open. */
  size: number
  onSize: (fraction: number) => void
  /** One line: what is selected. Also the collapsed state. */
  header?: JSX.Element
  /** Right side of the header line; stays visible collapsed. */
  actions?: JSX.Element
  /** Header text when nothing is selected. */
  empty: string
  /** The body: the only scrolling region of the pane. */
  children?: JSX.Element
  /** The list or chart above the pane. */
  top: JSX.Element
  class?: string
  bodyClass?: string
  /** Called with the body element while it is mounted and with undefined when it unmounts. */
  bodyRef?: (element: HTMLDivElement | undefined) => void
  onBodyScroll?: JSX.EventHandler<HTMLDivElement, Event>
  /** Accessible name of the resize handle. */
  label?: string
}): JSX.Element {
  const Ui = props.ui
  const bodyID = createUniqueId()
  const [drag, setDrag] = createSignal<DetailsState | undefined>()
  let root: HTMLDivElement | undefined
  let bar: HTMLDivElement | undefined
  // Evaluated once each: JSX props are lazy and would otherwise build their DOM per read.
  const header = createMemo(() => props.header)
  const actions = createMemo(() => (header() ? props.actions : undefined))
  const stored = () => storedState({ open: props.open, size: props.size })
  const state = () => drag() ?? stored()
  const containerHeight = () => root?.getBoundingClientRect().height ?? 0
  const commit = (next: DetailsState) => {
    const before = stored()
    if (next.open !== before.open) props.onOpen(next.open)
    if (next.open && Math.abs(next.size - before.size) > 0.0005) props.onSize(next.size)
  }
  const toggle = () => props.onOpen(!stored().open)
  const startDrag: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    if (event.button !== undefined && event.button > 0) return
    const handle = event.currentTarget
    const top = bar?.getBoundingClientRect().top ?? event.clientY
    const grab = event.clientY - top
    const origin = event.clientY
    let moved = false
    handle.setPointerCapture?.(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      if (!moved && Math.abs(moveEvent.clientY - origin) < 3) return
      moved = true
      const rect = root?.getBoundingClientRect()
      if (!rect) return
      setDrag(
        dragState(drag() ?? stored(), {
          pointerY: moveEvent.clientY - grab,
          containerTop: rect.top,
          containerHeight: rect.height,
        }),
      )
    }
    const end = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", end)
      handle.removeEventListener("pointercancel", end)
      const final = drag()
      setDrag(undefined)
      if (final) commit(final)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", end)
    handle.addEventListener("pointercancel", end)
  }
  const onKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    const next = keyboardState(stored(), event.key, containerHeight())
    if (!next) return
    event.preventDefault()
    commit(next)
  }
  return (
    <div
      class={`lazers-details${props.class ? ` ${props.class}` : ""}`}
      data-open={state().open ? "true" : "false"}
      data-dragging={drag() ? "true" : undefined}
      style={{ "--details-size": String(state().size) }}
      ref={(element) => {
        root = element
      }}
    >
      <div class="lazers-details-top">{props.top}</div>
      <div class="lazers-details-pane">
        <div
          class="lazers-details-bar"
          ref={(element) => {
            bar = element
          }}
          onDblClick={(event) => {
            if ((event.target as Element).closest("button, a, input, [role='menuitem']")) return
            toggle()
          }}
        >
          <div
            class="lazers-details-resize"
            role="separator"
            aria-orientation="horizontal"
            aria-label={props.label ?? "Resize details"}
            aria-controls={bodyID}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state().open ? Math.round(state().size * 100) : 0}
            tabIndex={0}
            onPointerDown={startDrag}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            class="lazers-details-chevron"
            aria-expanded={state().open}
            aria-controls={bodyID}
            aria-label={state().open ? "Collapse details" : "Expand details"}
            onClick={toggle}
          >
            <Ui.Icon name="chevron-down" size="small" />
          </button>
          <div class="lazers-details-header" data-empty={header() ? undefined : "true"}>
            <Show when={header()} fallback={props.empty}>
              {header()}
            </Show>
          </div>
          <Show when={actions()}>
            <div class="lazers-details-actions">{actions()}</div>
          </Show>
        </div>
        <Show when={state().open}>
          <div
            class={`lazers-details-body${props.bodyClass ? ` ${props.bodyClass}` : ""}`}
            id={bodyID}
            role="region"
            aria-label="Details"
            ref={(element) => {
              props.bodyRef?.(element)
              onCleanup(() => props.bodyRef?.(undefined))
            }}
            onScroll={props.onBodyScroll}
          >
            {props.children}
          </div>
        </Show>
      </div>
    </div>
  )
}

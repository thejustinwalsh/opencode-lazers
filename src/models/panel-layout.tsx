import { For, Show, createEffect } from "solid-js"
import type { JSX } from "solid-js"
import type { ModelsController } from "./models-controller.ts"
import { DetailsPane } from "../details-pane.tsx"
import { sizeFromLegacySplit, storedState } from "../details-pane.ts"

/**
 * The scrolling top pane above the shared details pane. While loading or empty there is nothing
 * to inspect, so the pane stays one disabled, collapsed bar.
 */
export function SplitPane(props: {
  ctl: ModelsController
  header: JSX.Element
  top: JSX.Element
  /** The pane body: the only scrolling region of the inspector. */
  bottom: JSX.Element
  /** The pane's one-line header; undefined shows `empty`. */
  detailsHeader?: JSX.Element
  detailsActions?: JSX.Element
  empty: string
  solo?: boolean
}) {
  const { refs, save, current, visible, prefs } = props.ctl
  const details = () => {
    const view = prefs()
    return storedState({
      open: view.open,
      size: view.size ?? (view.split !== 64 ? sizeFromLegacySplit(view.split) : undefined),
    })
  }
  createEffect(() => {
    const value = current()
    if (!value || !visible()) return
    const { topPane, inspector } = refs
    if (topPane && topPane.scrollTop !== prefs().topScroll) topPane.scrollTop = prefs().topScroll
    if (inspector && inspector.scrollTop !== prefs().inspectorScroll)
      inspector.scrollTop = prefs().inspectorScroll
  })
  return (
    <DetailsPane
      ui={props.ctl.Ui}
      class="lazers-models-pane"
      bodyClass="lazers-models-inspector"
      label="Resize model details"
      disabled={props.solo}
      open={!props.solo && details().open}
      size={details().size}
      onOpen={(open) => save({ open })}
      onSize={(size) => save({ size })}
      empty={props.empty}
      header={props.detailsHeader}
      actions={props.detailsActions}
      bodyRef={(element) => {
        refs.inspector = element
        // The body mounts when the pane opens; restore its scroll once it has content.
        if (element)
          queueMicrotask(() => {
            const saved = prefs().inspectorScroll
            if (saved && element.scrollTop !== saved) element.scrollTop = saved
          })
      }}
      onBodyScroll={(event) => save({ inspectorScroll: event.currentTarget.scrollTop })}
      top={
        <div
          class="lazers-models-top"
          data-solo={props.solo ? "" : undefined}
          ref={(element) => {
            refs.topPane = element
          }}
          onScroll={(event) => save({ topScroll: event.currentTarget.scrollTop })}
        >
          {props.header}
          {props.top}
        </div>
      }
    >
      {props.bottom}
    </DetailsPane>
  )
}

/** A radio-style choice between a few options, as in the Tasks filters. */
export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  const key: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return
    event.preventDefault()
    const index = props.options.findIndex((option) => option.value === props.value)
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1
    const next = props.options[(index + step + props.options.length) % props.options.length]
    if (!next) return
    props.onChange(next.value)
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-segment="${next.value}"]`)
      ?.focus()
  }
  return (
    <div class="lazers-models-segmented" role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            role="radio"
            data-segment={option.value}
            aria-checked={props.value === option.value}
            tabIndex={props.value === option.value ? 0 : -1}
            disabled={props.disabled}
            onClick={() => props.onChange(option.value)}
            onKeyDown={key}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  )
}

/** A collapsed section: title on the left, an optional hint on the right. */
export function Disclosure(props: { title: string; hint?: string; children: JSX.Element }) {
  return (
    <details class="lazers-models-disclosure">
      <summary>
        <span>{props.title}</span>
        <Show when={props.hint}>
          {(hint) => <span class="lazers-models-disclosure-hint">{hint()}</span>}
        </Show>
      </summary>
      <div class="lazers-models-evidence-content">{props.children}</div>
    </details>
  )
}

import { For, Show, createEffect } from "solid-js"
import type { JSX } from "solid-js"
import type { ModelsController } from "./models-controller.ts"
import { clampSplit } from "./panel-shared.ts"

/** The scrolling top pane, the resize separator and the scrolling inspector. */
export function SplitPane(props: {
  ctl: ModelsController
  header: JSX.Element
  top: JSX.Element
  bottom: JSX.Element
  /** Header and top pane only: while loading or empty there is nothing to inspect, so no split. */
  solo?: boolean
}) {
  const { refs, save, split, setSplit, drag, current, visible, prefs } = props.ctl
  createEffect(() => {
    const value = current()
    if (!value || !visible()) return
    const { topPane, inspector } = refs
    if (topPane && topPane.scrollTop !== prefs().topScroll) topPane.scrollTop = prefs().topScroll
    if (inspector && inspector.scrollTop !== prefs().inspectorScroll)
      inspector.scrollTop = prefs().inspectorScroll
  })
  return (
    <>
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
      <Show when={!props.solo}>
        <div
          class="lazers-models-separator"
          role="separator"
          aria-label="Resize model comparison and inspector"
          aria-orientation="horizontal"
          aria-valuemin={24}
          aria-valuemax={76}
          aria-valuenow={split()}
          tabIndex={0}
          onPointerDown={drag}
          onKeyDown={(event) => {
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
            event.preventDefault()
            setSplit(
              clampSplit(
                event.key === "Home"
                  ? 24
                  : event.key === "End"
                    ? 76
                    : split() + (event.key === "ArrowDown" ? 5 : -5),
              ),
            )
            save({ split: split() })
          }}
        />
        <div
          class="lazers-models-inspector"
          ref={(element) => {
            refs.inspector = element
          }}
          onScroll={(event) => save({ inspectorScroll: event.currentTarget.scrollTop })}
        >
          {props.bottom}
        </div>
      </Show>
    </>
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

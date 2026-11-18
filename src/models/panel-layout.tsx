import { createEffect } from "solid-js"
import type { JSX } from "solid-js"
import type { ModelsController } from "./models-controller.ts"
import { clampSplit } from "./panel-shared.ts"

/** The scrolling top pane, the resize separator and the scrolling inspector. */
export function SplitPane(props: {
  ctl: ModelsController
  header: JSX.Element
  top: JSX.Element
  bottom: JSX.Element
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
        ref={(element) => {
          refs.topPane = element
        }}
        onScroll={(event) => save({ topScroll: event.currentTarget.scrollTop })}
      >
        {props.header}
        {props.top}
      </div>
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
    </>
  )
}

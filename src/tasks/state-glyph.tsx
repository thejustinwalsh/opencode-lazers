import { Match, Show, Switch } from "solid-js"
import type { TaskRingGlyph } from "./row-presentation.ts"

/**
 * Ring state marks drawn on the host's 20-unit icon grid with its stroke weight, so they sit beside
 * host `circle-*` glyphs as one family. Color comes from `currentColor` (the row's tone).
 */
export function TaskRing(props: { glyph: TaskRingGlyph }) {
  return (
    <svg
      class="lazers-tasks-ring"
      data-glyph={props.glyph}
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <Show
        when={props.glyph === "disc-check"}
        fallback={
          <circle
            cx="10"
            cy="10"
            r="7.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-dasharray={props.glyph === "ring-dashed" ? "2.6 2.3" : undefined}
          />
        }
      >
        <circle cx="10" cy="10" r="8.25" fill="currentColor" />
      </Show>
      <Switch>
        <Match when={props.glyph === "ring-progress"}>
          <path d="M10 5.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />
        </Match>
        <Match when={props.glyph === "ring-dot"}>
          <circle cx="10" cy="10" r="2.5" fill="currentColor" />
        </Match>
        <Match when={props.glyph === "ring-pause"}>
          <path d="M8.25 7v6M11.75 7v6" stroke="currentColor" stroke-width="1.5" />
        </Match>
        <Match when={props.glyph === "ring-minus"}>
          <path d="M6.75 10h6.5" stroke="currentColor" stroke-width="1.5" />
        </Match>
        <Match when={props.glyph === "ring-check" || props.glyph === "disc-check"}>
          <path
            d="M6.5 10.25l2.5 2.5 4.5-5"
            stroke={props.glyph === "disc-check" ? "var(--background-base)" : "currentColor"}
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </Match>
        <Match when={props.glyph === "ring-clock"}>
          <path
            d="M10 6v4l2.75 1.75"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </Match>
      </Switch>
    </svg>
  )
}

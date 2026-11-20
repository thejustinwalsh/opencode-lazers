import type { JSX } from "solid-js"

/**
 * The few control glyphs the panel draws itself, on the host's 20-unit grid at its stroke weight,
 * so they match the Tasks ring glyphs. Color is `currentColor`.
 */
const paths = {
  "chevron-left": <path d="M12 6l-4 4 4 4" />,
  "chevron-right": <path d="M8 6l4 4-4 4" />,
  "chevron-down": <path d="M6 8l4 4 4-4" />,
  "zoom-in": (
    <>
      <circle cx="9" cy="9" r="4.75" />
      <path d="M12.6 12.6L16 16M7 9h4M9 7v4" />
    </>
  ),
  "zoom-out": (
    <>
      <circle cx="9" cy="9" r="4.75" />
      <path d="M12.6 12.6L16 16M7 9h4" />
    </>
  ),
  // Two end bars with arrows pointing at them: the timeline's whole span, stretched to the panel.
  fit: <path d="M3.5 4v12M16.5 4v12M6.5 10h7M9 7.5L6.5 10 9 12.5M11 7.5l2.5 2.5-2.5 2.5" />,
  // The conventional expand glyph: two opposing corner arrows.
  expand: <path d="M11.5 4.5h4v4M15.5 4.5l-4.5 4.5M8.5 15.5h-4v-4M4.5 15.5L9 11" />,
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
} satisfies Record<string, JSX.Element>

export type PanelIconName = keyof typeof paths

export function PanelIcon(props: { name: PanelIconName; size?: number }) {
  return (
    <svg
      class="lazers-trajectory-icon"
      data-icon={props.name}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {paths[props.name]}
    </svg>
  )
}

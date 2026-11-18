import type { JSX } from "solid-js"

/**
 * The few control glyphs the panel draws itself, on the host's 20-unit grid at its stroke weight,
 * so they match the Tasks ring glyphs. Color is `currentColor`.
 */
const paths = {
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
  fit: <path d="M4 8V4.5h3.5M16 8V4.5h-3.5M4 12v3.5h3.5M16 12v3.5h-3.5" />,
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

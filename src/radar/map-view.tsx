import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { fitText, layoutMap } from "./map-layout.ts"
import { relatedNodes } from "./map-model.ts"
import type { RadarMap } from "./map-model.ts"

const TONE_ORDER = { weak: 0, attention: 1, active: 2, failed: 3 } as const

/**
 * The compact org tree as one SVG that fills the panel width. Clicking a node selects it; the
 * rest dims to a third so the path through the selection reads at a glance.
 */
export function RadarMapView(props: {
  map: RadarMap
  selectedID: string | null
  onSelect: (id: string) => void
}) {
  const [width, setWidth] = createSignal(480)
  let host: HTMLDivElement | undefined
  onMount(() => {
    if (!host) return
    setWidth(Math.max(240, Math.floor(host.clientWidth)) || 480)
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0)
      if (next > 0) setWidth(next)
    })
    observer.observe(host)
    onCleanup(() => observer.disconnect())
  })
  const layout = createMemo(() => layoutMap(props.map, width()))
  const related = createMemo(() => relatedNodes(props.map, props.selectedID))
  const dim = (id: string) => {
    const set = related()
    return set !== undefined && !set.has(id)
  }
  const edges = createMemo(() =>
    layout().edges.toSorted((left, right) => TONE_ORDER[left.tone] - TONE_ORDER[right.tone]),
  )
  return (
    <div class="lazers-radar-orgmap" ref={(element) => (host = element)}>
      <svg
        width={layout().width}
        height={layout().height}
        viewBox={`0 0 ${layout().width} ${layout().height}`}
        role="group"
        aria-label="Radar map"
      >
        <For each={edges()}>
          {(edge) => (
            <path
              class="lazers-radar-edge"
              data-tone={edge.tone}
              data-dim={dim(edge.to) || dim(edge.from)}
              d={edge.d}
              fill="none"
            />
          )}
        </For>
        <For each={layout().nodes}>
          {(node) => (
            <g
              class="lazers-radar-node"
              data-tone={node.tone}
              data-kind={node.kind}
              data-selected={props.selectedID === node.id}
              data-dim={dim(node.id)}
              role="button"
              tabIndex={0}
              aria-pressed={props.selectedID === node.id}
              aria-label={[node.title, node.sub].filter(Boolean).join(", ")}
              onClick={() => props.onSelect(node.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  props.onSelect(node.id)
                }
              }}
            >
              <Show when={node.running}>
                <rect
                  class="lazers-radar-node-pulse"
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={node.height}
                  rx={9}
                />
              </Show>
              <rect
                class="lazers-radar-node-box"
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                rx={9}
              />
              <text
                class="lazers-radar-node-title"
                x={node.x + node.width / 2}
                y={node.y + (node.sub ? 23 : 32)}
                text-anchor="middle"
              >
                {fitText(node.title, node.width)}
              </text>
              <Show when={node.sub}>
                <text
                  class="lazers-radar-node-sub"
                  x={node.x + node.width / 2}
                  y={node.y + 40}
                  text-anchor="middle"
                >
                  {fitText(node.sub!, node.width, 11.5)}
                </text>
              </Show>
            </g>
          )}
        </For>
      </svg>
    </div>
  )
}

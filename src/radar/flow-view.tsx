import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { layoutFlow } from "./flow-layout.ts"
import {
  abbreviateRole,
  compactCount,
  feedWhen,
  filterFeed,
  flowRelated,
  modelWhen,
} from "./flow-model.ts"
import type { DestKind, FlowModel, FlowSelection, ModelCard } from "./flow-model.ts"

const HUE: Record<DestKind, string> = {
  model: "var(--lazers-hue-tools, var(--text-interactive-base))",
  local: "var(--icon-warning-base)",
  service: "var(--text-strong)",
  you: "var(--icon-warning-base)",
}
export const destHue = (kind: DestKind) => HUE[kind]

function truncate(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text
}

function reducedMotion() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  } catch {
    return false
  }
}

/** The canvas: sessions on the left, destinations on the right, flow edges between. */
export function RadarFlowCanvas(props: {
  model: FlowModel
  selection: FlowSelection
  onSelect: (selection: FlowSelection) => void
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
  const layout = createMemo(() => layoutFlow(props.model, width()))
  const related = createMemo(() => flowRelated(props.model, props.selection))
  const sessionDim = (id: string) => {
    const set = related()
    if (!set) return false
    const session = layout().sessions.find((item) => item.sessionID === id)
    return !set.sessions.has(id) && !(session?.depth === 0 && props.selection?.kind === "session")
  }
  const destDim = (id: string) => {
    const set = related()
    return set !== undefined && !set.destinations.has(id)
  }
  const edgeDim = (key: string) => {
    const set = related()
    return set !== undefined && !set.edgeKeys.has(key)
  }
  const still = reducedMotion()
  const toggle = (next: FlowSelection) => {
    const current = props.selection
    props.onSelect(
      current && next && current.kind === next.kind && current.id === next.id ? null : next,
    )
  }
  const press = (event: KeyboardEvent, run: () => void) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    run()
  }
  return (
    <div class="lazers-radar-flowcanvas" ref={(element) => (host = element)}>
      <svg
        width={layout().width}
        height={layout().height}
        viewBox={`0 0 ${layout().width} ${layout().height}`}
        role="group"
        aria-label="Radar flow"
        data-narrow={layout().narrow}
      >
        <rect
          class="lazers-radar-flow-frame"
          x={layout().frame.x}
          y={layout().frame.y}
          width={layout().frame.width}
          height={layout().frame.height}
          rx={8}
        />
        <For each={layout().links}>
          {(link) => (
            <path class="lazers-radar-flow-link" data-dim={sessionDim(link.sessionID)} d={link.d} />
          )}
        </For>
        <For each={layout().headings}>
          {(heading) => (
            <text class="lazers-radar-flow-group" x={heading.x} y={heading.y} text-anchor="end">
              {heading.label}
            </text>
          )}
        </For>
        <For each={layout().destinations}>
          {(dest) => (
            <g
              class="lazers-radar-flow-dest"
              data-dim={destDim(dest.id)}
              data-selected={
                props.selection?.kind === "destination" && props.selection.id === dest.id
              }
              role="button"
              tabIndex={0}
              aria-pressed={
                props.selection?.kind === "destination" && props.selection.id === dest.id
              }
              aria-label={`${dest.name}, ${dest.count} ${dest.count === 1 ? "flow" : "flows"}`}
              onClick={() => toggle({ kind: "destination", id: dest.id })}
              onKeyDown={(event) =>
                press(event, () => toggle({ kind: "destination", id: dest.id }))
              }
            >
              <rect
                x={dest.x - 4}
                y={dest.y - 5}
                width={9}
                height={9}
                rx={2}
                fill={HUE[dest.kind]}
                fill-opacity={0.22}
                stroke={HUE[dest.kind]}
              />
              <text class="lazers-radar-flow-sink" x={dest.x - 12} y={dest.y + 4} text-anchor="end">
                {truncate(dest.name, layout().sinkChars)}
                <Show when={!layout().narrow}>
                  <tspan class="lazers-radar-flow-count"> {dest.count}</tspan>
                </Show>
              </text>
            </g>
          )}
        </For>
        <For each={layout().edges}>
          {(edge) => {
            const kind = () =>
              props.model.destinations.find((dest) => dest.id === edge.destID)!.kind
            return (
              <g data-dim={edgeDim(`${edge.sessionID}>${edge.destID}`)}>
                <path
                  class="lazers-radar-flow-edge"
                  d={edge.d}
                  fill="none"
                  stroke={HUE[kind()]}
                  stroke-width={edge.width.toFixed(2)}
                  stroke-opacity={edge.opacity.toFixed(2)}
                />
                <Show when={edge.running}>
                  <For each={edge.dots}>
                    {(dot, index) =>
                      still ? (
                        <circle class="lazers-radar-flow-dot" cx={dot.x} cy={dot.y} r={1.8} />
                      ) : (
                        <circle class="lazers-radar-flow-dot" cx={0} cy={0} r={1.8}>
                          <animateMotion
                            dur={`${2.4 + index() * 0.7}s`}
                            begin={`${-index() * 1.1}s`}
                            repeatCount="indefinite"
                            path={edge.d}
                          />
                        </circle>
                      )
                    }
                  </For>
                </Show>
              </g>
            )
          }}
        </For>
        <For each={layout().sessions}>
          {(session) => {
            const color = () =>
              session.doingFailed
                ? "var(--icon-critical-base)"
                : session.waiting
                  ? "var(--icon-warning-base)"
                  : session.tone === "run"
                    ? "var(--text-interactive-base)"
                    : "var(--icon-base)"
            const selected = () =>
              props.selection?.kind === "session" && props.selection.id === session.sessionID
            const label = () => (layout().narrow ? abbreviateRole(session.role) : session.role)
            return (
              <g
                class="lazers-radar-flow-session"
                data-dim={sessionDim(session.sessionID)}
                data-selected={selected()}
                role="button"
                tabIndex={0}
                aria-pressed={selected()}
                aria-label={[session.role, session.ref, session.doing].filter(Boolean).join(", ")}
                onClick={() => toggle({ kind: "session", id: session.sessionID })}
                onKeyDown={(event) =>
                  press(event, () => toggle({ kind: "session", id: session.sessionID }))
                }
              >
                <rect
                  class="lazers-radar-flow-hit"
                  x={session.x - 14}
                  y={session.y - 16}
                  width={layout().frame.width - session.x + 6}
                  height={34}
                  fill="transparent"
                />
                <Show when={session.tone === "run" && !session.waiting && !session.doingFailed}>
                  <circle
                    class="lazers-radar-flow-halo"
                    cx={session.x}
                    cy={session.y}
                    r={11}
                    fill="none"
                    stroke={color()}
                    stroke-opacity={0.28}
                  />
                </Show>
                <Show when={session.waiting}>
                  <circle
                    cx={session.x}
                    cy={session.y}
                    r={11}
                    fill="none"
                    stroke={color()}
                    stroke-opacity={0.4}
                    stroke-dasharray="2 3"
                  />
                </Show>
                <Show when={selected()}>
                  <circle
                    cx={session.x}
                    cy={session.y}
                    r={12.5}
                    fill="none"
                    stroke="var(--text-strong)"
                    stroke-width={1.25}
                  />
                </Show>
                <circle
                  cx={session.x}
                  cy={session.y}
                  r={6.5}
                  fill="var(--background-base)"
                  stroke={color()}
                  stroke-width={1.5}
                />
                <Show when={session.tone === "run" && !session.waiting && !session.doingFailed}>
                  <path d={`M${session.x} ${session.y - 4}a4 4 0 010 8z`} fill={color()} />
                </Show>
                <Show when={session.doingFailed}>
                  <path
                    d={`M${session.x - 2.4} ${session.y - 2.4}l4.8 4.8M${session.x + 2.4} ${session.y - 2.4}l-4.8 4.8`}
                    stroke={color()}
                    stroke-width={1.4}
                    stroke-linecap="round"
                    fill="none"
                  />
                </Show>
                <Show when={session.waiting}>
                  <path
                    d={`M${session.x} ${session.y - 3.4}v3.6M${session.x} ${session.y + 2.8}h.01`}
                    stroke={color()}
                    stroke-width={1.5}
                    stroke-linecap="round"
                    fill="none"
                  />
                </Show>
                <text x={session.x + 14} y={session.y - 2}>
                  <tspan class="lazers-radar-flow-name">{label()}</tspan>
                  <Show when={session.ref}>
                    <tspan class="lazers-radar-flow-ref"> {session.ref}</tspan>
                  </Show>
                </text>
                <Show when={session.doing}>
                  <text
                    class="lazers-radar-flow-doing"
                    data-tone={
                      session.doingFailed ? "failed" : session.waiting ? "waiting" : undefined
                    }
                    x={session.x + 14}
                    y={session.y + 12}
                  >
                    {truncate(session.doing!, layout().doingChars)}
                  </text>
                </Show>
              </g>
            )
          }}
        </For>
      </svg>
    </div>
  )
}

function ModelCardView(props: { card: ModelCard; now: number; monoFont: string }) {
  const card = () => props.card
  const total = () => card().shares.reduce((sum, share) => sum + share.calls, 0)
  return (
    <div class="lazers-radar-model" data-idle={!card().active}>
      <div class="lazers-radar-model-title">
        <b>{card().name}</b>
        <Show when={card().effort}>
          <span class="lazers-radar-model-weak">{card().effort}</span>
        </Show>
        <span class="lazers-radar-model-spacer" />
        <Show
          when={card().active}
          fallback={<span class="lazers-radar-model-when">{modelWhen(card(), props.now)}</span>}
        >
          <span class="lazers-radar-model-active">active</span>
          <Show when={card().rate !== null}>
            <span class="lazers-radar-model-when" style={{ "font-family": props.monoFont }}>
              {compactCount(card().rate!)}/min
            </span>
          </Show>
        </Show>
      </div>
      <div class="lazers-radar-model-grid" style={{ "font-family": props.monoFont }}>
        <Show when={card().inputTokens !== null}>
          <span>
            {compactCount(card().inputTokens!)}
            <small>in · 2 min</small>
          </span>
        </Show>
        <Show when={card().outputTokens !== null}>
          <span>
            {compactCount(card().outputTokens!)}
            <small>out</small>
          </span>
        </Show>
        <span>
          {card().calls}
          <small>calls</small>
        </span>
      </div>
      <Show when={total() > 0}>
        <div class="lazers-radar-model-bar" aria-hidden="true">
          <For each={card().shares}>
            {(share) => <span style={{ width: `${(share.calls / total()) * 100}%` }} />}
          </For>
        </div>
      </Show>
    </div>
  )
}

/** Below the split: Feed and Models, filtered by the selection. */
export function RadarFlowPanes(props: {
  model: FlowModel
  selection: FlowSelection
  selectionLabel: string
  now: number
  monoFont: string
  tab: "feed" | "models"
  onTab: (tab: "feed" | "models") => void
  onClear: () => void
  narrow: boolean
}) {
  const feed = createMemo(() => filterFeed(props.model, props.selection))
  return (
    <>
      <div class="lazers-radar-flow-tabs" role="tablist" aria-label="Flow detail">
        <button
          type="button"
          role="tab"
          aria-selected={props.tab === "feed"}
          onClick={() => props.onTab("feed")}
        >
          Feed <span>{feed().length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={props.tab === "models"}
          onClick={() => props.onTab("models")}
        >
          Models <span>{props.model.models.length}</span>
        </button>
        <span class="lazers-radar-flow-spacer" />
        <Show when={props.selection} fallback={<span>last 2 min</span>}>
          <span class="lazers-radar-flow-selected">{props.selectionLabel}</span>
          <button type="button" class="lazers-radar-text-button" onClick={props.onClear}>
            Clear
          </button>
        </Show>
      </div>
      <Show when={props.tab === "feed"}>
        <ol class="lazers-radar-feed" aria-label="Flow feed">
          <For each={feed()}>
            {(row) => (
              <li
                class="lazers-radar-feed-row"
                data-live={row.live}
                data-failed={row.failed}
                data-narrow={props.narrow}
              >
                <span class="lazers-radar-feed-when" style={{ "font-family": props.monoFont }}>
                  {feedWhen(row, props.now)}
                </span>
                <span class="lazers-radar-feed-agent">
                  <Show when={row.ref}>
                    <code style={{ "font-family": props.monoFont }}>{row.ref}</code>
                  </Show>
                  <Show when={!props.narrow}> {row.ref ? abbreviateRole(row.role) : row.role}</Show>
                </span>
                <span class="lazers-radar-feed-dest">
                  <i style={{ background: destHue(row.kind) }} />
                  {row.destName}
                </span>
                <span
                  class="lazers-radar-feed-detail"
                  style={{ "font-family": props.monoFont }}
                  title={row.detail}
                >
                  {row.detail}
                </span>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={props.tab === "models"}>
        <div class="lazers-radar-models">
          <For each={props.model.models}>
            {(card) => <ModelCardView card={card} now={props.now} monoFont={props.monoFont} />}
          </For>
          <p class="lazers-radar-flow-note">
            Bar: share of the last two minutes by session. Active models sort first.
          </p>
        </div>
      </Show>
    </>
  )
}

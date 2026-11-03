import { Plugin, Slot, bindPlugin } from "@opencode/plugin/gui"
import { createMemo, Show } from "solid-js"
import type { Component, JSX } from "solid-js"
import type { InferenceRuntime } from "./runtime.ts"

type IndicatorRuntime = Pick<InferenceRuntime, "modelName" | "phase">
type Tooltip = Component<{ value: JSX.Element; children: JSX.Element }>

function phaseLabel(phase: string) {
  switch (phase) {
    case "loading":
    case "downloading":
      return "Loading"
    case "ready":
      return "Available"
    case "busy":
      return "Working"
    case "error":
      return "Error"
    case "disabled":
      return "Off"
    default:
      return "Unloaded"
  }
}

export function InferenceIndicator(props: {
  runtime: IndicatorRuntime
  Tooltip: Tooltip
  onSettings: () => void
}) {
  const name = () => props.runtime.modelName()
  const phase = () => props.runtime.phase()
  const label = createMemo(() => {
    const status = phaseLabel(phase())
    return `${name() ? `${name()}: ` : "Local inference: "}${status}. Open LAZERS settings.`
  })
  const loading = () => phase() === "loading" || phase() === "downloading"
  const available = () => phase() === "ready" || phase() === "busy"

  return (
    <props.Tooltip value={label()}>
      <button
        type="button"
        aria-label={label()}
        class="lazers-local-icon"
        data-phase={phase()}
        onClick={props.onSettings}
      >
        <Show when={name()}>
          {(shortName) => <span class="lazers-local-model">{shortName()}</span>}
        </Show>
        <svg
          class="lazers-local-status-icon"
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          aria-hidden="true"
        >
          <circle class="lazers-gpu-track" cx="12" cy="12" r="9" />
          <Show when={loading()}>
            <g class="lazers-gpu-orbit">
              <path d="M12 3a9 9 0 0 1 9 9" />
              <circle cx="3" cy="12" r="1.5" fill="currentColor" />
            </g>
          </Show>
          <Show when={!loading()}>
            <Show
              when={phase() === "error"}
              fallback={
                <Show
                  when={available()}
                  fallback={<path class="lazers-gpu-core" d="m12 7 4.3 5-4.3 5-4.3-5Z" />}
                >
                  <path class="lazers-gpu-available" d="m8.5 12.2 2.2 2.2 4.8-5" />
                </Show>
              }
            >
              <path class="lazers-gpu-error" d="M12 7.5v5m0 3h.01" />
            </Show>
          </Show>
        </svg>
      </button>
    </props.Tooltip>
  )
}

export function registerInferenceIndicator(
  ctx: Parameters<Plugin.Setup>[0],
  runtime: IndicatorRuntime,
  visible: () => boolean,
  onSettings: () => void,
) {
  const Icon = bindPlugin(() => (
    <InferenceIndicator runtime={runtime} Tooltip={ctx.ui.Tooltip} onSettings={onSettings} />
  ))
  ctx.add(Slot, {
    at: "session.header",
    render: () => (
      <Show when={visible()}>
        <Icon />
      </Show>
    ),
  })
}

export const inferenceIndicatorStyles = `
  .lazers-local-icon { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 40px; max-width: 100%; height: 40px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--text-weak); font: inherit; white-space: nowrap; cursor: pointer; }
  .lazers-local-icon:hover { background: var(--surface-base-hover); }
  .lazers-local-icon:focus-visible { outline: 2px solid var(--text-base); outline-offset: -2px; }
  .lazers-local-icon:active .lazers-local-status-icon { transform: scale(.94); }
  .lazers-local-model { flex: 0 0 auto; font-size: 12px; font-weight: 500; }
  .lazers-local-status-icon { flex: 0 0 22px; color: var(--icon-base); }
  .lazers-local-status-icon .lazers-gpu-track { stroke: currentColor; stroke-width: 1.3; opacity: .2; }
  .lazers-local-status-icon .lazers-gpu-orbit path { stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; }
  .lazers-local-status-icon .lazers-gpu-available { stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .lazers-local-status-icon .lazers-gpu-core { stroke: currentColor; stroke-width: 1.4; stroke-linejoin: round; }
  .lazers-local-status-icon .lazers-gpu-error { stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
  .lazers-local-icon[data-phase="error"] .lazers-local-status-icon { color: var(--text-critical-base); }
  .lazers-local-icon[data-phase="loading"] .lazers-gpu-orbit, .lazers-local-icon[data-phase="downloading"] .lazers-gpu-orbit { transform-origin: 12px 12px; animation: lazers-gpu-spin 2s linear infinite; }
  .lazers-local-icon[data-phase="busy"] .lazers-local-status-icon { animation: lazers-gpu-breathe 1.6s ease-in-out infinite; }
  @keyframes lazers-gpu-spin { to { transform: rotate(360deg); } }
  @keyframes lazers-gpu-breathe { 50% { opacity: .45; } }
  @media (prefers-reduced-motion: reduce) { .lazers-local-icon * { animation: none !important; } .lazers-local-icon:active .lazers-local-status-icon { transform: none; } }
`

import type { Ui as HostUi } from "@opencode/plugin/gui"
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js"
import type { Accessor, JSX } from "solid-js"
import { panelStatus } from "./panel-status.ts"
import type { PanelStatusInput, PanelStatusView } from "./panel-status.ts"

export interface PanelStatusHandle {
  view: Accessor<PanelStatusView>
  /** What the panel loads; keys the open state of the failure Details. */
  subject: Accessor<string>
  /** The panel has content to render (ready, or kept under the reconnect banner). */
  showContent: Accessor<boolean>
  /** Put on the content container as `data-panel-dimmed`. */
  dimmed: Accessor<"true" | undefined>
}

/**
 * Tracks one panel's status and runs the slow-load clock only while a first load is in flight.
 * Call inside a component.
 */
export function createPanelStatus(input: Accessor<PanelStatusInput>): PanelStatusHandle {
  const [elapsed, setElapsed] = createSignal(0)
  const waiting = createMemo(() => input().loading && !input().hasContent)
  createEffect(() => {
    if (!waiting()) return
    const started = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Date.now() - started), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const view = createMemo(() => panelStatus(input(), elapsed()))
  return {
    view,
    subject: () => input().subject,
    showContent: () => view().kind === "ready" || view().kind === "reconnecting",
    dimmed: () => (view().kind === "reconnecting" ? "true" : undefined),
  }
}

/**
 * Whether a panel's failure Details is open, kept per subject outside the component. A refresh
 * flips the status through loading and back, which re-creates the failure view; a native
 * `<details>` created again starts closed, so the owner saw it open and shut at once.
 */
const detailsOpen = new Map<string, Accessor<boolean>>()
const detailsSetters = new Map<string, (open: boolean) => void>()
function detailsState(subject: string) {
  let read = detailsOpen.get(subject)
  if (!read) {
    const [value, set] = createSignal(false)
    read = value
    detailsOpen.set(subject, read)
    detailsSetters.set(subject, set)
  }
  return [read, detailsSetters.get(subject)!] as const
}

export type PanelSkeletonShape = "rows" | "chart" | "timeline"

const ROW_WIDTHS = [72, 64, 81, 58, 76, 49, 68]

/** Placeholder in the shape of the panel's real layout. Decorative; the status line speaks. */
export function PanelSkeleton(props: { shape?: PanelSkeletonShape }): JSX.Element {
  return (
    <div class="lazers-panel-skeleton" data-shape={props.shape ?? "rows"} aria-hidden="true">
      <Switch>
        <Match when={props.shape === "chart"}>
          <div class="lazers-panel-skeleton-chart">
            <i style={{ left: "14%", top: "74%" }} />
            <i style={{ left: "35%", top: "63%" }} />
            <i style={{ left: "57%", top: "42%" }} />
            <i style={{ left: "79%", top: "26%" }} />
          </div>
          <span style={{ width: "60%" }} />
          <span style={{ width: "38%" }} />
        </Match>
        <Match when={props.shape === "timeline"}>
          <span style={{ width: "70%" }} />
          <span style={{ width: "42%" }} />
          <div class="lazers-panel-skeleton-tracks">
            <i />
            <i />
            <i />
            <i />
          </div>
        </Match>
        <Match when={true}>
          <For each={ROW_WIDTHS}>{(width) => <span style={{ width: `${width}%` }} />}</For>
        </Match>
      </Switch>
    </div>
  )
}

/**
 * Everything a panel shows instead of, or above, its content: skeleton and status line on a
 * first load, the reconnect banner over kept content, or the failure sentence. Render it where
 * the content starts, then render the content when `status.showContent()`.
 */
export function PanelStatus(props: {
  ui: HostUi
  status: PanelStatusHandle
  onRetry?: () => void
  skeleton?: PanelSkeletonShape
}): JSX.Element {
  const Ui = props.ui
  const retry = () => (
    <Show when={props.onRetry}>
      {(run) => (
        <button type="button" class="lazers-panel-retry" onClick={() => run()()}>
          Retry
        </button>
      )}
    </Show>
  )
  const details = (detail: string | undefined) => {
    const [open, setOpen] = detailsState(props.status.subject())
    return (
      <Show when={detail}>
        {(text) => (
          <details
            class="lazers-panel-details"
            open={open()}
            onToggle={(event) => setOpen(event.currentTarget.open)}
          >
            <summary>Details</summary>
            <pre>{text()}</pre>
          </details>
        )}
      </Show>
    )
  }
  const loading = createMemo(() => {
    const view = props.status.view()
    return view.kind === "loading" ? view : undefined
  })
  const reconnecting = createMemo(() => {
    const view = props.status.view()
    return view.kind === "reconnecting" ? view : undefined
  })
  const failed = createMemo(() => {
    const view = props.status.view()
    return view.kind === "failed" ? view : undefined
  })
  return (
    <Switch>
      <Match when={loading()}>
        {(view) => (
          <div class="lazers-panel-loading" aria-busy="true">
            <PanelSkeleton {...(props.skeleton ? { shape: props.skeleton } : {})} />
            <p class="lazers-panel-status-line" role="status">
              <span>{view().line}</span>
              <Show when={view().slow}>{retry()}</Show>
            </p>
          </div>
        )}
      </Match>
      <Match when={reconnecting()}>
        {(view) => (
          <div class="lazers-panel-banner" role="status" title={view().detail}>
            <Ui.Icon name="status" size="small" class="lazers-panel-banner-icon" />
            <span class="lazers-panel-banner-text">{view().line}</span>
            {retry()}
          </div>
        )}
      </Match>
      <Match when={failed()}>
        {(view) => (
          <div class="lazers-panel-failed" role="alert">
            <p>{view().line}</p>
            <Show when={props.onRetry}>
              {(run) => (
                <Ui.Button size="small" onClick={() => run()()}>
                  Retry
                </Ui.Button>
              )}
            </Show>
            {details(view().detail)}
          </div>
        )}
      </Match>
    </Switch>
  )
}

/** Added once by the plugin root; every panel shares it. */
export const panelStatusStyles = `
  .lazers-panel-banner {
    display: flex; align-items: center; gap: 8px; margin: 0 12px 6px; padding: 6px 10px;
    border: 1px solid var(--border-weak-base); border-radius: 7px; background: var(--surface-base);
    color: var(--text-base); font-size: 12px; line-height: 1.4;
  }
  .lazers-panel-banner-icon { flex: none; color: var(--icon-warning-base, var(--text-weak)); }
  .lazers-panel-banner-text { flex: 1; min-width: 0; }
  .lazers-panel-retry {
    flex: none; padding: 0; border: 0; background: none; color: var(--text-strong); font: inherit;
    cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
    text-decoration-color: var(--border-base, currentColor);
  }
  .lazers-panel-retry:focus-visible { outline: 1px solid var(--border-selected); outline-offset: 2px; border-radius: 3px; }
  [data-panel-dimmed="true"] { opacity: 0.62; transition: opacity 120ms ease; }
  .lazers-panel-loading { display: grid; gap: 12px; padding: 12px 16px; }
  .lazers-panel-status-line {
    display: flex; align-items: center; gap: 12px; margin: 0; color: var(--text-weak); font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .lazers-panel-skeleton { display: grid; gap: 14px; padding: 6px 0; }
  .lazers-panel-skeleton > span, .lazers-panel-skeleton-tracks > i {
    display: block; height: 8px; border-radius: 4px; background: var(--surface-base-hover, var(--surface-base));
  }
  .lazers-panel-skeleton-chart {
    position: relative; height: 180px; border: 1px solid var(--border-weak-base); border-radius: 8px;
  }
  .lazers-panel-skeleton-chart > i {
    position: absolute; width: 10px; height: 10px; border-radius: 50%;
    background: var(--surface-base-hover, var(--surface-base));
  }
  .lazers-panel-skeleton-tracks { display: grid; gap: 18px; padding: 12px 0; border-top: 1px solid var(--border-weak-base); }
  .lazers-panel-skeleton-tracks > i { height: 4px; }
  .lazers-panel-failed {
    display: grid; justify-items: start; gap: 10px; padding: 16px; color: var(--text-base); font-size: 13px;
  }
  .lazers-panel-failed > p { margin: 0; }
  .lazers-panel-details { color: var(--text-weak); font-size: 12px; }
  .lazers-panel-details > summary { cursor: pointer; }
  .lazers-panel-details > pre {
    margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere;
    font: 11.5px/1.5 var(--font-family-mono, monospace);
  }
  @media (prefers-reduced-motion: reduce) { [data-panel-dimmed="true"] { transition: none; } }
`

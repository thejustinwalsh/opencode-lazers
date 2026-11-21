import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { RadarMonitorView } from "../../../src/radar/monitor-view.tsx"
import type { RadarMonitorData } from "../../../src/radar/monitor-streams.ts"
import { createTestUI } from "../../models-panel/fixtures/dom-host.ts"
export { mountStream } from "./radar-flow-stream-entry.tsx"
import { mockupFlowLive } from "../../radar/flow-fixture.ts"

/**
 * Mounts the real Radar monitor view on a live read. `refresh()` publishes a new live object with
 * identical content (what a no-change live update delivers); `change()` moves a call forward.
 */
export function mountRadar(view: "monitor" | "map" | "flow", container: HTMLElement) {
  const base = Date.now()
  const live = () =>
    ({
      ...mockupFlowLive(base),
      scope: { kind: "project", sessionID: "arch" },
      observedAt: base,
    }) as never
  const [data, setData] = createSignal<RadarMonitorData>(
    {
      key: "k",
      live: live(),
      loading: false,
      stale: false,
      error: "",
      connection: "connected",
      selectedSessionID: null,
      historyLoading: false,
      historyError: "",
      asOf: base,
    },
    { equals: false },
  )
  const dispose = render(
    () =>
      createComponent(RadarMonitorView, {
        ui: createTestUI() as never,
        data,
        view,
        scope: { kind: "project", sessionID: "arch" },
        anchorSessionID: "arch",
        includeUnmanagedSessions: false,
        monoFont: "monospace",
        details: { open: false, size: 0.5 },
        onDetailsChange: () => {},
        onScopeChange: () => {},
        onSelectSession: () => {},
        onLoadMoreHistory: () => {},
        onView: () => {},
        showIdle: true,
        onShowIdleChange: () => {},
      }),
    container,
  )
  return {
    dispose,
    refresh: () => setData((previous) => ({ ...previous, live: live() })),
  }
}

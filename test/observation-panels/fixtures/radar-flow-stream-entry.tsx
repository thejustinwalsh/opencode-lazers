import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { RadarMonitorView } from "../../../src/radar/monitor-view.tsx"
import type { RadarMonitorData } from "../../../src/radar/monitor-streams.ts"
import { createTestUI } from "../../models-panel/fixtures/dom-host.ts"
import { mockupFlowLive } from "../../radar/flow-fixture.ts"

/**
 * Browser benchmark entry: the real Flow view on a live stream. Every `intervalMs` one new call
 * and one model request arrive (counts and heat move, a Feed row is added), as a streaming worker
 * delivers. Built and measured by a real-Chrome trace; not part of `bun test`.
 */
export function mountStream(container: HTMLElement, intervalMs = 400) {
  const base = Date.now()
  const snapshot = mockupFlowLive(base) as unknown as {
    calls: Record<string, unknown>[]
    flow: Record<string, unknown>[]
  }
  let n = 0
  const sinks = ["s99", "s146", "s135", "s134"]
  const next = (at: number) => {
    n++
    const session = sinks[n % sinks.length]!
    const call = {
      id: `n${n}`,
      sessionID: session,
      attemptID: "5f0c2a1e-7b3d-4c8e-9a1f-0d2b3c4e5f60",
      messageID: "m",
      callID: `n${n}`,
      tool: n % 2 ? "edit" : "bash",
      status: "succeeded",
      execution: "executed",
      inputAt: at,
      calledAt: at,
      completedAt: at + 200,
      observedAt: at,
      sourceProgressSequence: 1,
      sourceEventID: null,
      sourceEventType: null,
      result: null,
      error: null,
      payloadAvailable: false,
    }
    snapshot.calls = [call, ...snapshot.calls]
  }
  const live = (at: number) =>
    ({
      ...snapshot,
      scope: { kind: "project", sessionID: "arch" },
      observedAt: at,
    }) as never
  const state = (at: number): RadarMonitorData => ({
    key: "k",
    live: live(at),
    loading: false,
    stale: false,
    error: "",
    connection: "connected",
    selectedSessionID: null,
    historyLoading: false,
    historyError: "",
    asOf: at,
  })
  const [data, setData] = createSignal<RadarMonitorData>(state(base), { equals: false })
  const dispose = render(
    () =>
      createComponent(RadarMonitorView, {
        ui: createTestUI() as never,
        data,
        view: "flow",
        scope: { kind: "project", sessionID: "arch" },
        anchorSessionID: "arch",
        includeUnmanagedSessions: false,
        monoFont: "monospace",
        details: { open: true, size: 0.5 },
        onDetailsChange: () => {},
        onScopeChange: () => {},
        onSelectSession: () => {},
        onRefresh: () => {},
        onLoadMoreHistory: () => {},
        onView: () => {},
        showIdle: true,
        onShowIdleChange: () => {},
      }),
    container,
  )
  const tick = () => {
    const at = Date.now()
    next(at)
    setData(state(at))
  }
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    dispose,
    /** One live update: a new call arrives. */
    tick,
    start() {
      if (intervalMs <= 0 || timer) return
      timer = setInterval(tick, intervalMs)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}

import { setupRadarPanel } from "../../../../src/radar/panel.tsx"
import { mountPanel } from "../host.tsx"
import type { PanelAdapter } from "../adapter.ts"
import { PROJECT, radarChanged, reads, rpc } from "./radar-answers.ts"
import type { RadarData } from "./radar-answers.ts"

const adapter: PanelAdapter<RadarData> = {
  panelID: "radar",
  tabTitle: "Radar",
  project: PROJECT,
  setup: (ctx, host) =>
    setupRadarPanel(ctx as never, {
      openTrajectory: () => host.openPanel("trajectory"),
      openTask: () => host.openPanel("tasks"),
    }),
  rpc,
  changed: (data, emit) => radarChanged(emit, data),
  reads,
  // Monitor view, session scope, details pane closed: the panel's own defaults.
  stores: { radarView: { projects: {}, diagnostics: false } },
}

export const mount = (container: HTMLElement, data: () => RadarData) =>
  mountPanel(adapter, container, data)

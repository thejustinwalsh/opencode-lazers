import { setupTrajectoryPanel } from "../../../../src/trajectory-panel/panel.tsx"
import { mountPanel } from "../host.tsx"
import type { PanelAdapter } from "../adapter.ts"
import { PROJECT } from "./trajectory-answers.ts"
import type { TrajectoryData } from "./trajectory-answers.ts"
import { reads, rpc, trajectoryChanged } from "./trajectory-streams.ts"

const adapter: PanelAdapter<TrajectoryData> = {
  panelID: "trajectory",
  tabTitle: "Trajectory",
  project: PROJECT,
  setup: (ctx, host) =>
    setupTrajectoryPanel(ctx as never, { openTask: () => host.openPanel("tasks") }),
  rpc,
  changed: (data, emit) => trajectoryChanged(data, emit),
  reads,
  stores: {
    trajectoryView: {
      projects: {
        [PROJECT.canonical]: {
          scope: "session",
          selectedTaskID: null,
          selectedReference: null,
          target: null,
          selectedKind: "",
          selectedRecordID: "",
          open: false,
        },
      },
    },
  },
}

export const mount = (container: HTMLElement, data: () => TrajectoryData) =>
  mountPanel(adapter, container, data)

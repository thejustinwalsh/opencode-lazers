import { setupTaskPanel } from "../../../../src/tasks/panel.tsx"
import { mountPanel } from "../host.tsx"
import type { PanelAdapter } from "../adapter.ts"
import { PROJECT, reads, rpc, tasksChanged } from "./tasks-answers.ts"
import type { TasksData } from "./tasks-answers.ts"

const adapter: PanelAdapter<TasksData> = {
  panelID: "tasks",
  tabTitle: "Tasks",
  project: PROJECT,
  setup: (ctx, host) =>
    setupTaskPanel(
      ctx as never,
      () => host.openPanel("trajectory"),
      () => host.openPanel("radar"),
    ),
  rpc,
  changed: (_data, emit) => tasksChanged(emit),
  reads,
  stores: {
    taskView: {
      projects: {
        [PROJECT.canonical]: {
          scope: "project",
          selectedID: null,
          search: "",
          listScroll: 0,
          detailScroll: 0,
          history: false,
          revealTaskID: "",
          open: false,
        },
      },
    },
  },
}

export const mount = (container: HTMLElement, data: () => TasksData) =>
  mountPanel(adapter, container, data)

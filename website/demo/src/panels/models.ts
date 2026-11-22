import { setupModelsPanel } from "../../../../src/models/comparison-panel.tsx"
import { modelsInitialPreference } from "../../../../src/models/panel-shared.ts"
import { mountPanel } from "../host.tsx"
import type { PanelAdapter } from "../adapter.ts"
import { PROJECT, modelsChanged, reads, rpc } from "./models-answers.ts"
import { withReferences } from "./models-references.ts"
import type { ModelsData } from "./models-answers.ts"

const adapter: PanelAdapter<ModelsData> = {
  panelID: "models",
  tabTitle: "Models",
  project: PROJECT,
  setup: (ctx, host) => setupModelsPanel(ctx as never, () => host.openPanel("trajectory")),
  // The service stores an OpenRouter reference per plotted model; Projected and Benchmark read them.
  rpc: (data) => rpc(data, { overview: withReferences }),
  changed: (_data, emit) => modelsChanged(emit),
  reads,
  stores: {
    modelsView: { projects: { [PROJECT.canonical]: { ...modelsInitialPreference } } },
  },
}

export const mount = (container: HTMLElement, data: () => ModelsData) =>
  mountPanel(adapter, container, data)

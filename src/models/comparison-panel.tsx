import { bindPlugin } from "@opencode/plugin/gui"
import type { PanelProps } from "@opencode/plugin/gui"
import { Show } from "solid-js"
import type { TaskTrajectoryOpener } from "../tasks/panel.tsx"
import { registerModelsPanel } from "./registration.ts"
import { createModelsController } from "./models-controller.ts"
import type { ModelsController } from "./models-controller.ts"
import { CompareView } from "./compare-view.tsx"
import { AssignmentsView } from "./assignments-view.tsx"
import { Segmented } from "./panel-layout.tsx"
import {
  modelPersonaLabels,
  modelTaskKindLabels,
  modelTaskKinds,
  showTaskChip,
} from "./panel-shared.ts"
import type { ModelsContext, ModelsPreference } from "./panel-shared.ts"
import css from "./comparison-panel.css?inline"

export { modelsStores } from "./panel-shared.ts"

function personaFilterLabel(persona: ModelsPreference["persona"]) {
  if (!persona) return "All personas"
  return persona === "small-refactoring" ? "Refactor" : modelPersonaLabels[persona]
}

function PanelHeader(props: { ctl: ModelsController }) {
  const ctl = props.ctl
  const {
    Ui,
    changeDecisionFilters,
    clearTaskFilter,
    compareMode,
    prefs,
    pricesAsOf,
    projectLabel,
    selectCompareMode,
    selectTab,
    selectTask,
    selectedTask,
    refreshAll,
    tabKey,
    taskDescription,
    visible,
  } = ctl
  const compare = () => prefs().tab === "compare"
  const tab = (id: "compare" | "assignments", label: string) => (
    <button
      type="button"
      role="tab"
      id={`lazers-models-${id}-tab`}
      aria-selected={prefs().tab === id}
      aria-controls={`lazers-models-${id}-panel`}
      tabIndex={prefs().tab === id ? 0 : -1}
      onClick={() => selectTab(id)}
      onKeyDown={tabKey}
    >
      {label}
    </button>
  )

  return (
    <header
      class="lazers-models-header"
      ref={(element) => {
        ctl.refs.header = element
      }}
    >
      <div class="lazers-models-title-row">
        <h2>Models</h2>
        <div class="lazers-models-tabs" role="tablist" aria-label="Models views">
          {tab("compare", "Compare")}
          {tab("assignments", "Assignments")}
        </div>
        <Show
          when={compare()}
          fallback={
            <span class="lazers-models-prices" title={ctl.current()?.project}>
              {projectLabel()}
            </span>
          }
        >
          <Show when={pricesAsOf()}>
            {(time) => <span class="lazers-models-prices">Prices {time()}</span>}
          </Show>
        </Show>
        <Ui.IconButton
          icon="refresh"
          label="Refresh"
          size="small"
          disabled={!visible() || visible()?.sourceRefresh === "refreshing"}
          busy={visible()?.sourceRefresh === "refreshing"}
          onClick={refreshAll}
        />
      </div>
      <Show when={compare()}>
        <div class="lazers-models-controls">
          <div class="lazers-models-filters" role="group" aria-label="Comparison filters">
            <span class="lazers-models-chip">
              <Ui.Menu
                label={personaFilterLabel(visible()?.decisionFilters.persona ?? null)}
                trigger="button"
                icon="chevron-down"
                items={[
                  {
                    label: "All personas",
                    onSelect: () => changeDecisionFilters({ persona: null }),
                  },
                  ...(["ui", "systems", "small-refactoring"] as const).map((persona) => ({
                    label: modelPersonaLabels[persona],
                    onSelect: () => changeDecisionFilters({ persona }),
                  })),
                ]}
              />
            </span>
            <span class="lazers-models-chip">
              <Ui.Menu
                label={
                  visible()?.decisionFilters.taskKind
                    ? modelTaskKindLabels[visible()!.decisionFilters.taskKind!]
                    : "All kinds"
                }
                trigger="button"
                icon="chevron-down"
                items={[
                  {
                    label: "All task kinds",
                    onSelect: () => changeDecisionFilters({ taskKind: null }),
                  },
                  ...modelTaskKinds.map((taskKind) => ({
                    label: modelTaskKindLabels[taskKind],
                    onSelect: () => changeDecisionFilters({ taskKind }),
                  })),
                ]}
              />
            </span>
            <Show when={showTaskChip(prefs(), selectedTask()?.reference) && selectedTask()}>
              {(task) => (
                <span
                  class="lazers-models-chip lazers-models-task-select"
                  role="group"
                  aria-label={taskDescription()}
                  title={taskDescription()}
                >
                  <Ui.Menu
                    label={task().reference}
                    trigger="button"
                    icon="chevron-down"
                    items={(visible()?.tasks ?? []).map((entry) => ({
                      label: `${entry.reference} · ${entry.title || entry.objective} · ${entry.status}`,
                      onSelect: () => selectTask(entry.taskID),
                    }))}
                  />
                  <Ui.IconButton
                    icon="close"
                    label={`Clear task filter ${task().reference}`}
                    size="small"
                    onClick={clearTaskFilter}
                  />
                </span>
              )}
            </Show>
          </div>
          <Segmented
            label="Comparison basis"
            value={compareMode()}
            onChange={selectCompareMode}
            options={[
              { value: "observed", label: "Your runs" },
              { value: "projected", label: "Projected" },
              { value: "benchmark", label: "Benchmark" },
            ]}
          />
        </div>
      </Show>
    </header>
  )
}

function ModelPanel(
  props: PanelProps & { ctx: ModelsContext; openTrajectory: TaskTrajectoryOpener },
) {
  const ctl = createModelsController(props)
  const { refs, prefs } = ctl
  const header = <PanelHeader ctl={ctl} />
  return (
    <div
      class="lazers-models"
      ref={(element) => {
        refs.root = element
      }}
      style={{}}
    >
      <Show
        when={prefs().tab === "assignments"}
        fallback={<CompareView ctl={ctl} header={header} />}
      >
        <AssignmentsView ctl={ctl} header={header} />
      </Show>
    </div>
  )
}

export function setupModelsPanel(ctx: ModelsContext, openTrajectory: TaskTrajectoryOpener) {
  const Ui = ctx.ui
  registerModelsPanel(
    ctx,
    css,
    bindPlugin((props: PanelProps) => (
      <ModelPanel {...props} ctx={ctx} openTrajectory={openTrajectory} />
    )),
    () => (
      <div class="flex min-w-0 items-center gap-1.5">
        <Ui.Icon name="models" size="small" class="shrink-0" />
        <span>Models</span>
      </div>
    ),
  )
}

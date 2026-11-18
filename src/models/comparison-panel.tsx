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
import { modelPersonaLabels, modelTaskKindLabels, modelTaskKinds } from "./panel-shared.ts"
import type { ModelsContext, ModelsPreference } from "./panel-shared.ts"
import type { ModelComparisonPanelData } from "./comparison-state.ts"
import css from "./comparison-panel.css?inline"

export { modelsStores } from "./panel-shared.ts"

function personaFilterLabel(persona: ModelsPreference["persona"]) {
  if (!persona) return "All"
  return persona === "small-refactoring" ? "Refactor" : modelPersonaLabels[persona]
}
function sourceRefreshLabel(data: ModelComparisonPanelData) {
  if (data.sourceRefresh === "refreshing") return "Refreshing sources…"
  if (data.sourceRefresh === "failed") return "Source refresh failed; showing saved data."
  if (data.sourceRefresh === "succeeded") return "Sources refreshed."
  return "Showing saved data."
}

function PanelHeader(props: { ctl: ModelsController }) {
  const ctl = props.ctl
  const {
    Ui,
    changeDecisionFilters,
    compareMode,
    prefs,
    pricesAsOf,
    projectLabel,
    selectCompareMode,
    selectTab,
    selectTask,
    selectedTask,
    setPriceSourceRevision,
    sourceWarning,
    state,
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
          onClick={() => {
            setPriceSourceRevision((revision) => revision + 1)
            void state.refresh()
          }}
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
            <Show when={selectedTask()}>
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
              { value: "benchmark", label: "Benchmark" },
            ]}
          />
        </div>
        <Show when={visible()?.sourceRefresh === "refreshing"}>
          <p class="lazers-models-refresh-note" role="status">
            Refreshing sources…
          </p>
        </Show>
        <Show when={visible()?.sourceRefresh === "failed"}>
          <p class="lazers-models-error" role="alert">
            {sourceRefreshLabel(visible()!)}
          </p>
        </Show>
        <Show when={sourceWarning()}>
          {(warning) => (
            <p
              class={
                warning().role === "alert" ? "lazers-models-error" : "lazers-models-refresh-note"
              }
              role={warning().role}
            >
              {warning().message}
            </p>
          )}
        </Show>
        <Show when={visible()?.comparisonStale}>
          <p class="lazers-models-refresh-note" role="status">
            Comparison is out of date; showing the last saved data.
          </p>
        </Show>
        <Show
          when={
            visible()?.stale && !visible()?.comparisonStale && visible()?.sourceRefresh !== "failed"
          }
        >
          <p class="lazers-models-refresh-note" role="status">
            Showing saved data; the latest couldn't be confirmed.
          </p>
        </Show>
        <Show when={!visible()?.comparison && visible()?.comparisonError}>
          <p class="lazers-models-error" role="alert">
            Comparison unavailable; refresh to retry.
          </p>
        </Show>
        <Show when={visible()?.tasksError}>
          <>
            <p class="lazers-models-error" role="alert">
              Task list unavailable.
            </p>
            <details class="lazers-models-warning-details">
              <summary>Task-list error details</summary>
              <p>{visible()?.tasksError}</p>
            </details>
          </>
        </Show>
      </Show>
    </header>
  )
}

function ModelPanel(
  props: PanelProps & { ctx: ModelsContext; openTrajectory: TaskTrajectoryOpener },
) {
  const ctl = createModelsController(props)
  const { refs, split, chartHeight, prefs } = ctl
  const header = <PanelHeader ctl={ctl} />
  return (
    <div
      class="lazers-models"
      ref={(element) => {
        refs.root = element
      }}
      style={{
        "--models-top-size": `${split()}%`,
        ...(chartHeight() ? { "--models-chart-height": `${chartHeight()}px` } : {}),
      }}
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
        <Ui.Icon name="settings-gear" size="small" class="shrink-0" />
        <span>Models</span>
      </div>
    ),
  )
}

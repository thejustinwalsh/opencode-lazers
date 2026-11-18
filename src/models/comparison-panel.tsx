import { bindPlugin } from "@opencode/plugin/gui"
import type { PanelProps } from "@opencode/plugin/gui"
import { Show } from "solid-js"
import type { TaskTrajectoryOpener } from "../tasks/panel.tsx"
import { registerModelsPanel } from "./registration.ts"
import { createModelsController } from "./models-controller.ts"
import type { ModelsController } from "./models-controller.ts"
import { CompareView } from "./compare-view.tsx"
import { AssignmentsView } from "./assignments-view.tsx"
import { modelPersonaLabels, modelTaskKindLabels, modelTaskKinds } from "./panel-shared.ts"
import type { ModelsContext, ModelsPreference } from "./panel-shared.ts"
import type { ModelComparisonPanelData } from "./comparison-state.ts"
import { routeLabel } from "./comparison-presentation.ts"
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
    configurationsForGroup,
    current,
    decisionModelChoiceLabel,
    decisionModelLabel,
    prefs,
    projectLabel,
    providerChoices,
    selectDecisionGroup,
    selectTab,
    selectTask,
    selectedDecisionConfiguration,
    setPriceSourceRevision,
    sourceWarning,
    state,
    tabKey,
    taskDescription,
    taskLabel,
    visible,
  } = ctl

  return (
    <header
      class="lazers-models-header"
      ref={(element) => {
        ctl.refs.header = element
      }}
    >
      <div class="lazers-models-title-row">
        <h2>Models</h2>
        <span
          class="lazers-models-project"
          role="note"
          aria-label={`Project · ${current()?.project ?? "unavailable"}`}
          title={current()?.project}
        >
          Project · {projectLabel()}
        </span>
        <Ui.Button
          size="small"
          variant="ghost-muted"
          disabled={!visible() || visible()?.sourceRefresh === "refreshing"}
          busy={visible()?.sourceRefresh === "refreshing"}
          onClick={() => {
            setPriceSourceRevision((revision) => revision + 1)
            void state.refresh()
          }}
        >
          Refresh
        </Ui.Button>
      </div>
      <div class="lazers-models-tabs" role="tablist" aria-label="Models views">
        <button
          type="button"
          role="tab"
          id="lazers-models-compare-tab"
          aria-selected={prefs().tab === "compare"}
          aria-controls="lazers-models-compare-panel"
          tabIndex={prefs().tab === "compare" ? 0 : -1}
          onClick={() => selectTab("compare")}
          onKeyDown={tabKey}
        >
          Compare
        </button>
        <button
          type="button"
          role="tab"
          id="lazers-models-assignments-tab"
          aria-selected={prefs().tab === "assignments"}
          aria-controls="lazers-models-assignments-panel"
          tabIndex={prefs().tab === "assignments" ? 0 : -1}
          onClick={() => selectTab("assignments")}
          onKeyDown={tabKey}
        >
          Assignments
        </button>
      </div>
      <div class="lazers-models-controls">
        <div class="lazers-models-filters" role="group" aria-label="Comparison filters">
          <Ui.Menu
            label={`Persona · ${personaFilterLabel(visible()?.decisionFilters.persona ?? null)}`}
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
          <Ui.Menu
            label={`Kind · ${visible()?.decisionFilters.taskKind ? modelTaskKindLabels[visible()!.decisionFilters.taskKind!] : "All"}`}
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
          <span
            class="lazers-models-task-select"
            role="group"
            aria-label={taskDescription()}
            title={taskDescription()}
          >
            <Ui.Menu
              label={taskLabel()}
              trigger="button"
              icon="chevron-down"
              disabled={!visible()?.tasks.length}
              items={(visible()?.tasks ?? []).map((task) => ({
                label: `${task.reference} · ${task.title || task.objective} · ${task.status}`,
                onSelect: () => selectTask(task.taskID),
              }))}
            />
          </span>
        </div>
        <Show when={compareMode() === "observed" ? selectedDecisionConfiguration() : undefined}>
          {(configuration) => (
            <div
              class="lazers-models-selection-tools"
              role="group"
              aria-label="Model and effort selection"
              title={`Exact route ${routeLabel(configuration().route)}`}
            >
              <Ui.Menu
                label={`Model · ${decisionModelLabel(configuration())}`}
                trigger="button"
                icon="chevron-down"
                disabled={!providerChoices().length}
                items={providerChoices().map((choice) => ({
                  label: decisionModelChoiceLabel(choice),
                  onSelect: () => selectDecisionGroup(choice.groupID),
                }))}
              />
              <Ui.Menu
                label={`Effort · ${configuration().route.variant ?? "Not specified"}`}
                trigger="button"
                icon="chevron-down"
                disabled={!configurationsForGroup(configuration().groupID).length}
                items={configurationsForGroup(configuration().groupID).map((choice) => ({
                  label: choice.route.variant ?? "Not specified",
                  onSelect: () => state.selectConfiguration(choice.configurationID),
                }))}
              />
            </div>
          )}
        </Show>
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

import { Show, For } from "solid-js"
import type { JSX } from "solid-js"
import type { ModelsController } from "./models-controller.ts"
import { routeLabel } from "./comparison-presentation.ts"
import { modelPersonaLabels } from "./panel-shared.ts"
import { SplitPane } from "./panel-layout.tsx"

import { CompareTop } from "./compare-view.tsx"

export function AssignmentsView(props: { ctl: ModelsController; header: JSX.Element }) {
  const ctl = props.ctl
  const {
    Ui,
    assignmentBlocked,
    assignmentBusy,
    assignmentCanSave,
    assignmentEditorTitleID,
    assignmentLayer,
    assignmentLayerLabel,
    assignmentPersona,
    assignmentRoute,
    assignmentScope,
    assignmentScopeLabel,
    assignmentSettings,
    assignmentVariantChoices,
    assignmentVariantLabel,
    assignmentWrite,
    catalogOptions,
    modelPickerButtonLabel,
    modelSelectionCaption,
    openAssignmentModelPicker,
    personas,
    removeAssignmentRoute,
    saveAssignmentRoute,
    selectAssignmentPersona,
    selectAssignmentScope,
    selectedCatalogModel,
    state,
    updateAssignmentRoute,
    visible,
  } = ctl

  const AssignmentEditor = () => (
    <Show when={assignmentSettings()}>
      {(persona) => (
        <section
          class="lazers-models-assignment-editor"
          aria-labelledby={assignmentEditorTitleID()}
        >
          <header class="lazers-models-assignment-editor-heading">
            <div>
              <h3 id={assignmentEditorTitleID()}>Edit {persona().personaLabel}</h3>
              <p>Exact native route</p>
            </div>
            <Ui.Menu
              label={`Target · ${assignmentScopeLabel(assignmentScope())}`}
              trigger="button"
              icon="chevron-down"
              disabled={assignmentBlocked()}
              items={[
                { label: "Shared default", onSelect: () => selectAssignmentScope("shared") },
                { label: "Project override", onSelect: () => selectAssignmentScope("project") },
                { label: "Task override", onSelect: () => selectAssignmentScope("task") },
              ]}
            />
          </header>
          <Show when={assignmentScope() === "task" && !visible()?.selectedTaskID}>
            <p class="lazers-models-note" role="status">
              Choose a task from the toolbar before editing a task override.
            </p>
          </Show>
          <Show when={visible()?.catalogStatus === "loading"}>
            <p class="lazers-models-catalog-status" role="status">
              <Ui.Loader size="small" /> Loading native models…
            </p>
          </Show>
          <Show when={visible()?.catalogStatus === "unavailable"}>
            <div class="lazers-models-catalog-status" role="status">
              <span>Model catalog unavailable. Custom routes remain available.</span>
              <Ui.Button
                size="small"
                variant="ghost-muted"
                onClick={() => void state.refreshCatalog()}
              >
                Retry catalog
              </Ui.Button>
              <details class="lazers-models-catalog-error">
                <summary>Catalog details</summary>
                <p>{visible()?.catalogError}</p>
              </details>
            </div>
          </Show>
          <Show when={visible()?.catalogStatus === "ready" && !catalogOptions().length}>
            <p class="lazers-models-catalog-status" role="status">
              No models are listed. Custom routes remain available.
            </p>
          </Show>
          <div class="lazers-models-assignment-fields">
            <div class="lazers-models-assignment-choice">
              <span>Model</span>
              <Ui.Button
                size="small"
                disabled={
                  assignmentBlocked() ||
                  visible()?.catalogStatus !== "ready" ||
                  !catalogOptions().length
                }
                onClick={() => void openAssignmentModelPicker()}
              >
                {modelPickerButtonLabel()}
              </Ui.Button>
              <small>{modelSelectionCaption()}</small>
            </div>
            <div class="lazers-models-assignment-choice">
              <span>Effort / variant</span>
              <Ui.Menu
                label={`Effort · ${assignmentVariantLabel()}`}
                trigger="button"
                icon="chevron-down"
                disabled={assignmentBlocked() || !selectedCatalogModel()}
                items={[
                  { label: "No variant", onSelect: () => updateAssignmentRoute({ variant: "" }) },
                  ...assignmentVariantChoices().map((variant) => ({
                    label: variant,
                    onSelect: () => updateAssignmentRoute({ variant }),
                  })),
                ]}
              />
              <small>
                {selectedCatalogModel()
                  ? `For ${selectedCatalogModel()!.name || selectedCatalogModel()!.id}`
                  : "Custom variants can be entered below"}
              </small>
            </div>
          </div>
          <details class="lazers-models-assignment-manual-route">
            <summary>Custom route (manual IDs)</summary>
            <p>Use exact IDs when a route is missing from the native catalog.</p>
            <div class="lazers-models-assignment-manual-fields">
              <div class="lazers-models-assignment-field">
                <span>Provider ID</span>
                <Ui.TextInput
                  label="Provider ID"
                  value={assignmentRoute().providerID}
                  onInput={(providerID) => updateAssignmentRoute({ providerID })}
                  disabled={assignmentBlocked()}
                />
              </div>
              <div class="lazers-models-assignment-field">
                <span>Model ID</span>
                <Ui.TextInput
                  label="Model ID"
                  value={assignmentRoute().id}
                  onInput={(id) => updateAssignmentRoute({ id })}
                  disabled={assignmentBlocked()}
                />
              </div>
              <div class="lazers-models-assignment-field">
                <span>Variant / effort (optional)</span>
                <Ui.TextInput
                  label="Variant / effort (optional)"
                  value={assignmentRoute().variant}
                  onInput={(variant) => updateAssignmentRoute({ variant })}
                  disabled={assignmentBlocked()}
                />
              </div>
            </div>
          </details>
          <p class="lazers-models-assignment-current">
            <strong>Current override:</strong>{" "}
            {assignmentLayer()?.route
              ? routeLabel({
                  providerID: assignmentLayer()!.route!.providerID,
                  modelID: assignmentLayer()!.route!.id,
                  variant: assignmentLayer()!.route!.variant ?? null,
                })
              : assignmentLayer()
                ? "Removed"
                : "Not set"}
          </p>
          <div class="lazers-models-assignment-actions">
            <Ui.Button
              size="small"
              disabled={!assignmentCanSave()}
              busy={assignmentBusy()}
              onClick={saveAssignmentRoute}
            >
              Save route
            </Ui.Button>
            <Ui.Button
              size="small"
              variant="ghost-muted"
              disabled={!assignmentLayer()?.route || assignmentBlocked()}
              onClick={removeAssignmentRoute}
            >
              Remove override
            </Ui.Button>
          </div>
          <Show when={assignmentWrite()}>
            {(write) => {
              const alert = () => ["uncertain", "conflict", "failed"].includes(write().status)
              const statusLabel = () => {
                switch (write().status) {
                  case "saving":
                  case "verifying":
                    return "Saving…"
                  case "confirmed":
                    return "Saved"
                  case "uncertain":
                    return "Write unconfirmed"
                  case "conflict":
                    return "Updated elsewhere"
                  case "failed":
                    return "Could not save"
                }
              }
              const targetLabel = () => {
                const target = write().target
                if (!target) return "No target"
                return target.scope === "task"
                  ? `Task override · ${visible()?.settings?.projectDirectory ?? "current project"} · ${target.taskID}`
                  : target.scope === "project"
                    ? `Project override · ${visible()?.settings?.projectDirectory ?? "current project"}`
                    : assignmentScopeLabel(target.scope)
              }
              const requestRouteLabel = () => {
                const route = write().route
                return route
                  ? `${route.providerID} / ${route.id}${route.variant ? ` · ${route.variant}` : ""}`
                  : "remove override"
              }
              return (
                <div
                  class="lazers-models-assignment-feedback"
                  data-status={write().status}
                  role={alert() ? "alert" : "status"}
                  aria-live={alert() ? "assertive" : "polite"}
                >
                  <p>{statusLabel()}</p>
                  <Show when={write().status === "uncertain"}>
                    <Ui.Button
                      size="small"
                      variant="ghost-muted"
                      busy={assignmentBusy()}
                      onClick={() => void state.recheckAssignmentWrite()}
                    >
                      Check saved settings
                    </Ui.Button>
                  </Show>
                  <Show when={write().status === "conflict" || write().status === "failed"}>
                    <Ui.Button
                      size="small"
                      variant="ghost-muted"
                      busy={visible()?.settingsLoading}
                      onClick={() => void state.refreshSettings()}
                    >
                      Reload current settings
                    </Ui.Button>
                  </Show>
                  <details class="lazers-models-assignment-write-details">
                    <summary>Write details</summary>
                    <p>{write().message}</p>
                    <p>
                      {modelPersonaLabels[write().persona]} · {targetLabel()} · expected revision{" "}
                      {write().expectedRevision} · observed revision {write().revision ?? "unknown"}
                    </p>
                    <p>Requested route: {requestRouteLabel()}</p>
                  </details>
                </div>
              )
            }}
          </Show>
          <details class="lazers-models-assignment-layers">
            <summary>Mapping layers and revisions</summary>
            <p>{assignmentLayerLabel("Task override", persona().layers.task)}</p>
            <p>{assignmentLayerLabel("Project override", persona().layers.project)}</p>
            <p>{assignmentLayerLabel("Shared default", persona().layers.shared)}</p>
          </details>
        </section>
      )}
    </Show>
  )

  return (
    <SplitPane
      ctl={ctl}
      header={props.header}
      top={<CompareTop ctl={ctl} />}
      bottom={
        <section
          class="lazers-models-assignments"
          role="tabpanel"
          id="lazers-models-assignments-panel"
          aria-labelledby="lazers-models-assignments-tab"
        >
          <Show when={visible()?.settingsLoading}>
            <p class="lazers-models-note">
              <Ui.Loader size="small" /> Loading saved assignments…
            </p>
          </Show>
          <Show when={visible()?.settingsError}>
            <p class="lazers-models-error" role="alert">
              Saved assignments unavailable: {visible()?.settingsError}
            </p>
          </Show>
          <Show when={!visible()?.settingsLoading && !visible()?.settingsError}>
            <div class="lazers-models-assignment-rows" role="group" aria-label="Persona routes">
              <For each={personas()}>
                {(persona) => (
                  <button
                    type="button"
                    class="lazers-models-assignment-row"
                    aria-pressed={assignmentPersona() === persona.persona}
                    disabled={assignmentBlocked()}
                    onClick={() => selectAssignmentPersona(persona.persona)}
                  >
                    <span class="lazers-models-assignment-identity">
                      <strong>{persona.personaLabel}</strong>
                      <span>
                        {persona.resolution.status === "assigned"
                          ? routeLabel({
                              providerID: persona.resolution.route.providerID,
                              modelID: persona.resolution.route.id,
                              variant: persona.resolution.route.variant ?? null,
                            })
                          : "No saved route"}
                      </span>
                    </span>
                    <small>
                      {persona.resolution.status === "assigned"
                        ? `From ${persona.resolution.provenance.target.scope}`
                        : "Unassigned"}
                    </small>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <AssignmentEditor />
        </section>
      }
    />
  )
}

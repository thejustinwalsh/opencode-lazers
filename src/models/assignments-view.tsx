import { Show, For } from "solid-js"
import type { JSX } from "solid-js"
import type { ModelsController } from "./models-controller.ts"
import { routeLabel } from "./comparison-presentation.ts"
import { modelPersonaLabels } from "./panel-shared.ts"
import { PanelStatus, createPanelStatus } from "../panel-status.tsx"
import { Segmented, SplitPane } from "./panel-layout.tsx"

const personaIcons = {
  ui: "window-cursor",
  systems: "server",
  "small-refactoring": "edit-small-2",
} as const

/** Writes recorded across the task, project and shared layers of one persona. */
function historyChanges(persona: {
  layers: Record<"task" | "project" | "shared", { revision: number } | null | undefined>
}) {
  return (["task", "project", "shared"] as const).reduce(
    (total, scope) => total + (persona.layers[scope]?.revision ?? 0),
    0,
  )
}

export function AssignmentsView(props: { ctl: ModelsController; header: JSX.Element }) {
  const ctl = props.ctl
  const {
    Ui,
    assignmentBlocked,
    assignmentBusy,
    assignmentCanSave,
    assignmentDirty,
    assignmentEditorTitleID,
    assignmentLayer,
    assignmentLayerLabel,
    assignmentPersona,
    assignmentPrefill,
    assignmentRoute,
    assignmentScope,
    assignmentScopeLabel,
    assignmentSettings,
    assignmentVariantChoices,
    assignmentVariantLabel,
    assignmentWrite,
    catalogOptions,
    disconnected,
    modelSelectionCaption,
    openAssignmentModelPicker,
    personas,
    removeAssignmentRoute,
    revertAssignmentRoute,
    saveAssignmentRoute,
    selectAssignmentPersona,
    selectAssignmentScope,
    selectedCatalogModel,
    state,
    updateAssignmentRoute,
    visible,
  } = ctl

  const assignStatus = createPanelStatus(() => ({
    subject: "assignments",
    hasContent: Boolean(visible()?.settings),
    loading: !visible() || Boolean(visible()?.settingsLoading && !visible()?.settings),
    disconnected: disconnected(),
    error: visible()?.settingsError ?? "",
  }))

  const PersonaRows = () => (
    <section
      class="lazers-models-assignments"
      role="tabpanel"
      id="lazers-models-assignments-panel"
      aria-labelledby="lazers-models-assignments-tab"
    >
      <PanelStatus
        ui={Ui}
        status={assignStatus}
        onRetry={() => void state.refreshSettings()}
        skeleton="rows"
      />
      <Show when={assignStatus.showContent()}>
        <div
          class="lazers-models-assignment-rows"
          role="group"
          aria-label="Persona routes"
          data-panel-dimmed={assignStatus.dimmed()}
        >
          <For each={personas()}>
            {(persona) => (
              <button
                type="button"
                class="lazers-models-assignment-row"
                aria-pressed={assignmentPersona() === persona.persona}
                disabled={assignmentBlocked()}
                onClick={() => selectAssignmentPersona(persona.persona)}
              >
                <Ui.Icon name={personaIcons[persona.persona]} size="small" />
                <strong>{persona.personaLabel}</strong>
                <Show
                  when={persona.resolution.status === "assigned" ? persona.resolution : undefined}
                  fallback={
                    <span class="lazers-models-assignment-route">Uses the session model</span>
                  }
                >
                  {(resolution) => (
                    <>
                      <code class="lazers-models-assignment-route">
                        {resolution().route.id}
                        {resolution().route.variant ? ` · ${resolution().route.variant}` : ""}
                      </code>
                      <small>{resolution().provenance.target.scope}</small>
                    </>
                  )}
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  )

  /** The pane's one line: persona, then its model and effort. Also the collapsed pane. */
  const detailsHeader = () => {
    const persona = assignmentSettings()
    if (!persona) return undefined
    return (
      <span class="lazers-models-selected-identity">
        <h2 id={assignmentEditorTitleID()}>{persona.personaLabel}</h2>
        <code>
          {modelSelectionCaption()}
          {assignmentRoute().variant ? ` · ${assignmentRoute().variant}` : ""}
        </code>
        <Show when={assignmentDirty()}>
          <span class="lazers-models-selected-price">Edited · not saved</span>
        </Show>
      </span>
    )
  }
  const detailsActions = () =>
    assignmentSettings() && (assignmentDirty() || assignmentCanSave() || assignmentBusy()) ? (
      <>
        <Ui.Button
          size="small"
          variant="contrast"
          disabled={!assignmentCanSave()}
          busy={assignmentBusy()}
          onClick={saveAssignmentRoute}
        >
          Save
        </Ui.Button>
        <Ui.Button
          size="small"
          variant="ghost-muted"
          disabled={!assignmentDirty() || assignmentBlocked()}
          onClick={revertAssignmentRoute}
        >
          Revert
        </Ui.Button>
      </>
    ) : undefined
  const AssignmentEditor = () => (
    <Show when={assignmentSettings()}>
      {(persona) => (
        <section
          class="lazers-models-assignment-editor"
          aria-labelledby={assignmentEditorTitleID()}
        >
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
            <div class="lazers-models-form-row lazers-models-assignment-choice">
              <span>Model</span>
              <Ui.Button
                size="small"
                icon="chevron-down"
                class="lazers-models-form-control"
                disabled={
                  assignmentBlocked() ||
                  visible()?.catalogStatus !== "ready" ||
                  !catalogOptions().length
                }
                onClick={() => void openAssignmentModelPicker()}
              >
                {modelSelectionCaption()}
              </Ui.Button>
            </div>
            <div class="lazers-models-form-row lazers-models-assignment-choice">
              <span>Effort</span>
              <Ui.Menu
                label={assignmentVariantLabel()}
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
            </div>
            <div class="lazers-models-form-row">
              <span>Applies to</span>
              <Segmented
                label="Applies to"
                value={assignmentScope()}
                disabled={assignmentBlocked()}
                onChange={selectAssignmentScope}
                options={[
                  { value: "shared", label: "All projects" },
                  { value: "project", label: "This project" },
                  ...(visible()?.selectedTaskID
                    ? [{ value: "task" as const, label: "This task" }]
                    : []),
                ]}
              />
            </div>
          </div>
          <Show when={assignmentPrefill()?.persona === persona().persona && assignmentPrefill()}>
            {(prefill) => (
              <Show when={prefill().summary}>
                {(summary) => (
                  <p class="lazers-models-from-compare">
                    <Ui.Icon name="arrow-right" size="small" /> From Compare: {summary()}
                  </p>
                )}
              </Show>
            )}
          </Show>
          <p class="lazers-models-note">New workers use this route. Running workers keep theirs.</p>
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
          <details class="lazers-models-disclosure lazers-models-assignment-manual-route">
            <summary>
              <span>Other model ID</span>
            </summary>
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
          <details class="lazers-models-disclosure lazers-models-assignment-layers">
            <summary>
              <span>History</span>
              <Show when={historyChanges(persona()) > 0}>
                <span class="lazers-models-disclosure-hint">
                  {historyChanges(persona())}{" "}
                  {historyChanges(persona()) === 1 ? "change" : "changes"}
                </span>
              </Show>
            </summary>
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
            <p>{assignmentLayerLabel("Task override", persona().layers.task)}</p>
            <p>{assignmentLayerLabel("Project override", persona().layers.project)}</p>
            <p>{assignmentLayerLabel("Shared default", persona().layers.shared)}</p>
            <Ui.Button
              size="small"
              variant="ghost-muted"
              disabled={!assignmentLayer()?.route || assignmentBlocked()}
              onClick={removeAssignmentRoute}
            >
              Remove override
            </Ui.Button>
          </details>
        </section>
      )}
    </Show>
  )

  return (
    <SplitPane
      ctl={ctl}
      empty="No persona selected"
      detailsHeader={detailsHeader()}
      detailsActions={detailsActions()}
      header={props.header}
      top={<PersonaRows />}
      bottom={<AssignmentEditor />}
    />
  )
}

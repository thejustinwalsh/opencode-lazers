import { Store, bindPlugin, createKeyed, createLatest, usePanel } from "@opencode/plugin/gui"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { Models } from "./contract.ts"
import { Tasks } from "../tasks/contract.ts"
import { Observability } from "../observability/contract.ts"
import type { TaskTrajectoryOpener } from "../tasks/panel.tsx"
import type { TaskTrajectoryRequest } from "../tasks/panel.tsx"
import { registerModelsPanel } from "./registration.ts"
import type { ModelComparisonPanelData, ModelComparisonTransport } from "./comparison-state.ts"
import { ModelComparisonPanelState } from "./comparison-state.ts"
import type { ModelCandidate } from "./comparison-state.ts"
import {
  candidateLabel,
  candidateFocusIndex,
  exactRouteMatch,
  formatDate,
  numericValue,
  recordReferenceLabel,
  routeLabel,
  sourceState,
  sourceTitle,
} from "./comparison-presentation.ts"
import css from "./comparison-panel.css?inline"

const Preference = Schema.Struct({
  tab: Schema.Literals(["compare", "assignments"]),
  persona: Schema.Literals(["ui", "systems", "small-refactoring"]),
  selectedTaskID: Schema.NullOr(Schema.String),
  selectedCandidateID: Schema.NullOr(Schema.String),
  split: Schema.Number,
  topScroll: Schema.Number,
  inspectorScroll: Schema.Number,
})
const initial: typeof Preference.Type = {
  tab: "compare",
  persona: "ui",
  selectedTaskID: null,
  selectedCandidateID: null,
  split: 56,
  topScroll: 0,
  inspectorScroll: 0,
}

export const modelsStores = {
  modelsView: Store.session(Schema.Struct({ projects: Schema.Record(Schema.String, Preference) }), {
    projects: {},
  }),
}

type ModelsContext = SetupContext<{ stores: typeof modelsStores }>
type Tab = "compare" | "assignments"
const modelPersonaLabels = {
  ui: "UI",
  systems: "Systems",
  "small-refactoring": "Small task / refactoring",
} as const

const clampSplit = (value: number) => Math.min(76, Math.max(24, value))

function formatNumber(value: number | null | undefined) {
  return value === null || value === undefined ? "Unknown" : value.toLocaleString()
}

function modelRoute(candidate: ModelCandidate) {
  return candidateLabel(candidate)
}

function benchmarkLabel(candidate: ModelCandidate) {
  const benchmark = candidate.externalBenchmark
  if (!benchmark) {
    return candidate.benchmarkCorrespondence.status === "ambiguous"
      ? "Ambiguous benchmark match"
      : "No matched benchmark"
  }
  return benchmark.codingIndex === null
    ? "Coding index not reported"
    : `Coding index ${benchmark.codingIndex}`
}

function candidateEffortLabel(candidate: ModelCandidate) {
  return candidate.identity.variant ?? "Not specified"
}

function candidateAvailabilityLabel(candidate: ModelCandidate) {
  if (candidate.native.enabled === null) return "Availability unknown"
  return candidate.native.enabled ? "Available" : "Disabled"
}

function variantCoverageLabel(candidate: ModelCandidate) {
  const variants = candidate.native.availableVariants
  const coverage = candidate.native.variantCoverage
  const labels = variants?.length ? variants.join(", ") : "None reported"

  if (coverage.status === "truncated")
    return `Variants (${formatNumber(variants?.length)} shown of ${formatNumber(coverage.totalVariants)} total; ${formatNumber(coverage.omittedVariants)} omitted): ${labels}`
  if (coverage.status === "complete")
    return `Variants (${formatNumber(coverage.totalVariants)} total): ${labels}`
  return `Variants (coverage unknown): ${variants?.join(", ") || "Not reported"}`
}

export function ModelCandidateRow(props: {
  candidate: ModelCandidate
  selected: boolean
  tabIndex: number
  onKeyDown: JSX.EventHandler<HTMLButtonElement, KeyboardEvent>
  onSelect: () => void
}) {
  const candidate = () => props.candidate
  return (
    <button
      type="button"
      class="lazers-models-candidate"
      data-selected={props.selected}
      data-candidate-id={candidate().candidateID}
      aria-pressed={props.selected}
      aria-label={`${candidateLabel(candidate())}. Effort ${candidateEffortLabel(candidate())}. ${candidateAvailabilityLabel(candidate())} in the native catalog.`}
      tabIndex={props.tabIndex}
      onKeyDown={props.onKeyDown}
      onClick={props.onSelect}
    >
      <span class="lazers-models-candidate-main">
        <span class="lazers-models-selection-mark" aria-hidden="true">
          {props.selected ? "●" : "○"}
        </span>
        <span class="lazers-models-candidate-identity">
          <strong>{candidate().native.name ?? candidate().identity.modelID}</strong>
          <small class="lazers-models-candidate-route">{candidateLabel(candidate())}</small>
        </span>
      </span>
      <span class="lazers-models-candidate-meta">
        <small>Effort {candidateEffortLabel(candidate())}</small>
        <small>{candidateAvailabilityLabel(candidate())}</small>
      </span>
    </button>
  )
}

export function HistoricalChartPlaceholder() {
  return (
    <div class="lazers-models-chart-empty" role="status">
      <strong>Comparable coordinates unavailable</strong>
      <p>
        No comparable completed-task cohort is projected. No sample points or frontier are shown.
      </p>
    </div>
  )
}

export function RoutingNotActiveNotice() {
  return (
    <p class="lazers-models-routing-notice" role="note">
      Saved assignments are read-only here. Routing is not active; these saved routes do not change
      worker dispatch.
    </p>
  )
}

function sourceRefreshLabel(data: ModelComparisonPanelData) {
  if (data.sourceRefresh === "refreshing") return "Refreshing external and native sources…"
  if (data.sourceRefresh === "failed") return "Source refresh failed; cached evidence is retained."
  if (data.sourceRefresh === "succeeded") return "Sources refreshed."
  return "Using the latest saved source snapshots."
}

function statusText(status: string) {
  switch (status) {
    case "observed":
      return "Observed"
    case "partial":
      return "Partial"
    case "missing":
      return "Missing"
    case "unavailable":
      return "Unavailable"
    default:
      return status
  }
}

function ModelPanel(
  props: PanelProps & {
    ctx: ModelsContext
    openTrajectory: TaskTrajectoryOpener
  },
) {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()
  const [data, setData] = createSignal<ModelComparisonPanelData>(
    new ModelComparisonPanelState(() => {}).data,
  )
  const [split, setSplit] = createSignal(initial.split)
  let root: HTMLDivElement | undefined
  let topPane: HTMLDivElement | undefined
  let inspector: HTMLDivElement | undefined
  let endDrag: (() => void) | undefined

  const locationRequest = createMemo(() => {
    if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
    return {
      lookup: Symbol("models-location"),
      client: props.session.server.client,
      server: props.session.server.id,
      session: props.session.id,
      directory: props.session.directory,
    }
  })
  const source = createLatest(locationRequest, async (value, signal) => {
    const location = await value.client.location.get(
      { location: { directory: value.directory } },
      { signal },
    )
    return {
      ...value,
      project: location.project.canonical,
      projectID: location.project.id,
    }
  })
  const current = () => {
    const request = locationRequest()
    if (!request) return undefined
    const value = source.latest
    return value &&
      value.lookup === request.lookup &&
      value.server === props.session.server.id &&
      value.session === props.session.id &&
      value.directory === props.session.directory
      ? value
      : undefined
  }
  const prefs = () => {
    const value = current()
    return value
      ? (ctx.stores.modelsView(props.session).value?.projects[value.project] ?? initial)
      : initial
  }
  const save = (change: Partial<typeof initial>) => {
    const value = current()
    if (!value) return
    ctx.stores.modelsView(props.session).update((draft) => {
      draft.projects[value.project] = {
        ...(draft.projects[value.project] ?? initial),
        ...change,
      }
    })
  }
  const state = new ModelComparisonPanelState(setData, (selection) =>
    save({
      selectedTaskID: selection.selectedTaskID,
      selectedCandidateID: selection.selectedCandidateID,
    }),
  )
  const expectedKey = () => {
    const value = current()
    return value
      ? JSON.stringify([
          value.server,
          value.projectID,
          value.project,
          value.session,
          value.directory,
        ])
      : ""
  }
  const visible = () => (data().key === expectedKey() ? data() : undefined)

  onCleanup(() => {
    state.close()
    endDrag?.()
  })

  createKeyed(
    () => {
      const value = current()
      if (!value || !ctx.stores.modelsView(props.session).ready()) return undefined
      return { value, key: expectedKey() }
    },
    ({ value, key }) => {
      const view = prefs()
      setSplit(clampSplit(view.split))
      const models = value.client.rpc(Models)
      const tasks = value.client.rpc(Tasks)
      const observations = value.client.rpc(Observability)
      const location = { location: { directory: value.directory } }
      const timed = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(8_000)])
      const transport: ModelComparisonTransport = {
        comparison: (cursor, signal) =>
          models.comparison(
            {
              sessionID: value.session,
              limit: 100,
              ...(cursor ? { cursor } : {}),
            },
            { ...location, signal: timed(signal) },
          ),
        refreshSources: (signal) =>
          models.refreshSources(
            { sessionID: value.session },
            { ...location, signal: timed(signal) },
          ),
        settings: (taskID, signal) =>
          models.settings(
            { sessionID: value.session, ...(taskID ? { taskID } : {}) },
            { ...location, signal: timed(signal) },
          ),
        queryTasks: (signal) =>
          tasks.query(
            { state: "all", includeCompleted: true, includeRetired: true, limit: 100 },
            { ...location, signal: timed(signal) },
          ),
        getTask: (taskID, signal) => tasks.get({ taskID }, { ...location, signal: timed(signal) }),
        trajectoryStatus: (taskID, signal) =>
          observations.trajectoryStatus(
            { scope: { kind: "project", sessionID: value.session }, taskID },
            { ...location, signal: timed(signal) },
          ),
        online: () => props.session.server.connected,
      }
      state.connect(key, value.projectID, value.project, transport, {
        selectedTaskID: view.selectedTaskID,
        selectedCandidateID: view.selectedCandidateID,
      })
      onCleanup(() => state.close())
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => state.close(),
    },
  )

  createEffect(() => {
    const value = current()
    if (!value || !visible()) return
    if (topPane && topPane.scrollTop !== prefs().topScroll) topPane.scrollTop = prefs().topScroll
    if (inspector && inspector.scrollTop !== prefs().inspectorScroll)
      inspector.scrollTop = prefs().inspectorScroll
  })

  const selectedCandidate = () =>
    visible()?.candidates.find(
      (candidate) => candidate.candidateID === visible()?.selectedCandidateID,
    )
  const candidateFocusID = () => {
    const current = visible()
    if (!current?.candidates.length) return undefined
    if (
      current.candidates.some((candidate) => candidate.candidateID === current.selectedCandidateID)
    )
      return current.selectedCandidateID
    return current.candidates[0]?.candidateID
  }
  const selectedTask = () => visible()?.task
  const taskLabel = () => {
    const task = selectedTask()
    return task
      ? `Task · ${task.reference}`
      : visible()?.selectedTaskID
        ? "Task unavailable"
        : "Choose task"
  }
  const taskDescription = () => {
    const task = selectedTask()
    return task
      ? `${task.reference} · ${task.task.id} · ${task.task.proposal.objective}`
      : (visible()?.selectedTaskID ?? "Choose a task for comparison")
  }
  const projectLabel = () => current()?.project.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project"
  const personas = () => visible()?.settings?.personas ?? []
  const sourceWarning = () => {
    const sources = visible()?.comparison?.sources ?? []
    if (sources.some((source) => source.refresh?.state === "failed"))
      return {
        message: "One or more source refreshes failed; cached evidence may be stale.",
        role: "alert" as const,
      }
    if (sources.some((source) => source.refresh?.state === "cancelled"))
      return {
        message: "A source refresh was cancelled; cached evidence is retained.",
        role: "status" as const,
      }
    if (sources.some((source) => source.storage !== "ready"))
      return {
        message: "Source metadata is unavailable; model matching may be incomplete.",
        role: "status" as const,
      }
    if (sources.length && sources.some((source) => !source.snapshot))
      return { message: "One or more source snapshots are unavailable.", role: "status" as const }
    return undefined
  }
  const sourceSnapshotSummary = () => {
    const sources = visible()?.comparison?.sources
    if (!sources) return "Loading source coverage"
    return `${sources.filter((source) => source.snapshot).length} of ${sources.length} snapshots available`
  }
  const effortDetailsSummary = () => {
    const basis = visible()?.effortBasis
    if (!basis) return "Recorded task effort"
    const partial =
      basis.usage.coverage.missingSessions.length > 0 ||
      basis.usage.coverage.unavailableSessions.length > 0 ||
      basis.usage.coverage.progressTruncated
    return `${basis.attempts.count} recorded attempts · ${basis.usage.coverage.totalUniqueSessions} sessions · ${partial ? "partial coverage" : "coverage available"}`
  }

  const selectTab = (tab: Tab) => save({ tab })
  const selectTask = (taskID: string) => state.selectTask(taskID)
  const tabKey: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const next: Tab =
      event.key === "Home"
        ? "compare"
        : event.key === "End"
          ? "assignments"
          : prefs().tab === "compare"
            ? "assignments"
            : "compare"
    selectTab(next)
    const targetID =
      next === "compare" ? "lazers-models-compare-tab" : "lazers-models-assignments-tab"
    topPane?.querySelector<HTMLButtonElement>(`#${targetID}`)?.focus()
  }

  const openSelectedTrajectory = () => {
    const task = selectedTask()
    const value = current()
    if (!task || !value) return
    const target: TaskTrajectoryRequest = {
      taskID: task.task.id,
      reference: task.reference,
      projectID: task.task.provenance.projectID,
      projectDirectory: value.project,
    }
    props.openTrajectory(props.session, target)
  }

  const candidateKey: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
    const rows = [...(topPane?.querySelectorAll<HTMLButtonElement>("[data-candidate-id]") ?? [])]
    const index = rows.indexOf(event.currentTarget)
    const next = candidateFocusIndex(index, rows.length, event.key)
    if (next === undefined) return
    event.preventDefault()
    const row = rows[next]
    row?.focus()
    const candidateID = row?.dataset.candidateId
    if (candidateID) state.selectCandidate(candidateID)
  }

  const drag: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    endDrag?.()
    const key = expectedKey()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      const bounds = root?.getBoundingClientRect()
      if (!bounds) return
      setSplit(clampSplit(((moveEvent.clientY - bounds.top) / bounds.height) * 100))
    }
    const end = () => {
      element.removeEventListener("pointermove", move)
      element.removeEventListener("pointerup", end)
      element.removeEventListener("pointercancel", end)
      if (expectedKey() === key) save({ split: split() })
      endDrag = undefined
    }
    element.addEventListener("pointermove", move)
    element.addEventListener("pointerup", end, { once: true })
    element.addEventListener("pointercancel", end, { once: true })
    endDrag = end
  }

  const routeAssignments = () => visible()?.effortBasis?.routes.assignments ?? []
  const assessmentsFor = (attemptID: string) =>
    (visible()?.effortBasis?.routes.assessments ?? []).filter(
      (assessment) => assessment.attemptID === attemptID,
    )

  const categoryRows = [
    ["Uncached input", "uncachedInput"],
    ["Output", "output"],
    ["Reasoning", "reasoning"],
    ["Cache read", "cacheRead"],
    ["Cache write", "cacheWrite"],
  ] as const

  return (
    <div
      class="lazers-models"
      ref={(element) => {
        root = element
      }}
      style={{
        "--models-top-size": `${split()}%`,
      }}
    >
      <div
        class="lazers-models-top"
        ref={(element) => {
          topPane = element
        }}
        onScroll={(event) => save({ topScroll: event.currentTarget.scrollTop })}
      >
        <header class="lazers-models-header">
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
              onClick={() => void state.refresh()}
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
          <div class="lazers-models-filters">
            <Ui.Menu
              label={`Persona · ${modelPersonaLabels[prefs().persona]}`}
              trigger="button"
              icon="chevron-down"
              items={(["ui", "systems", "small-refactoring"] as const).map((persona) => ({
                label: modelPersonaLabels[persona],
                onSelect: () => save({ persona }),
              }))}
            />
            <span class="lazers-models-filter-status">Context only</span>
            <details class="lazers-models-filter-details">
              <summary>Filters unavailable</summary>
              <div>
                Persona supplies context only and does not filter candidates. Task class is not
                recorded; comparable cohorts and a period filter are unavailable.
              </div>
            </details>
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
          <Show when={visible()?.sourceRefresh === "refreshing"}>
            <p class="lazers-models-refresh-note" role="status">
              Refreshing sources; saved comparison rows remain available.
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
              Comparison is stale; showing the last successful data.
            </p>
          </Show>
          <Show
            when={
              visible()?.stale &&
              !visible()?.comparisonStale &&
              visible()?.sourceRefresh !== "failed"
            }
          >
            <p class="lazers-models-refresh-note" role="status">
              Latest evidence could not be confirmed; showing saved data.
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

        <Show
          when={prefs().tab === "compare"}
          fallback={
            <section
              class="lazers-models-assignments"
              role="tabpanel"
              id="lazers-models-assignments-panel"
              aria-labelledby="lazers-models-assignments-tab"
            >
              <RoutingNotActiveNotice />
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
                <For each={personas()}>
                  {(persona) => (
                    <article class="lazers-models-assignment">
                      <h3>{persona.personaLabel}</h3>
                      <p>
                        Effective saved route:{" "}
                        {persona.resolution.status === "assigned"
                          ? routeLabel({
                              providerID: persona.resolution.route.providerID,
                              modelID: persona.resolution.route.id,
                              variant: persona.resolution.route.variant ?? null,
                            })
                          : "No saved route"}
                      </p>
                      <p class="lazers-models-source-meta">
                        {persona.resolution.status === "assigned"
                          ? `Resolved from ${persona.resolution.provenance.target.scope} assignment · revision ${persona.resolution.provenance.revision}`
                          : "No applicable task, project, or shared assignment."}
                      </p>
                      <div class="lazers-models-assignment-layers">
                        <For
                          each={
                            [
                              ["Task override", persona.layers.task],
                              ["Project default", persona.layers.project],
                              ["Shared default", persona.layers.shared],
                            ] as const
                          }
                        >
                          {([label, layer]) => (
                            <p>
                              <strong>{label}:</strong>{" "}
                              {layer?.route
                                ? `${routeLabel({
                                    providerID: layer.route.providerID,
                                    modelID: layer.route.id,
                                    variant: layer.route.variant ?? null,
                                  })} · revision ${layer.revision} · updated ${new Date(layer.updatedAt).toLocaleString()}`
                                : "Not set"}
                            </p>
                          )}
                        </For>
                      </div>
                    </article>
                  )}
                </For>
              </Show>
            </section>
          }
        >
          <section
            class="lazers-models-compare"
            role="tabpanel"
            id="lazers-models-compare-panel"
            aria-labelledby="lazers-models-compare-tab"
          >
            <details class="lazers-models-sources-details">
              <summary>Source snapshots · {sourceSnapshotSummary()}</summary>
              <div class="lazers-models-sources" aria-label="Source snapshot coverage">
                <For each={visible()?.comparison?.sources ?? []}>
                  {(source) => (
                    <div
                      class="lazers-models-source"
                      title={source.snapshot?.sourceURL ?? sourceTitle(source.source)}
                    >
                      <strong>{sourceTitle(source.source)}</strong>
                      <span>{sourceState(source)}</span>
                      <Show when={source.refresh?.state === "failed"}>
                        <span class="lazers-models-source-warning">
                          Latest refresh failed
                          {source.refresh?.errorCode ? ` · ${source.refresh.errorCode}` : ""}
                          {source.refresh?.httpStatus ? ` · HTTP ${source.refresh.httpStatus}` : ""}
                        </span>
                      </Show>
                      <Show when={source.refresh?.state === "refreshing"}>
                        <span class="lazers-models-source-warning">Refresh in progress</span>
                      </Show>
                      <Show when={source.refresh?.state === "cancelled"}>
                        <span class="lazers-models-source-warning">Latest refresh cancelled</span>
                      </Show>
                    </div>
                  )}
                </For>
                <Show when={visible()?.sourceRefreshError}>
                  <p class="lazers-models-source-meta">
                    Source refresh error: {visible()?.sourceRefreshError}
                  </p>
                </Show>
                <Show when={visible()?.comparisonError}>
                  <p class="lazers-models-source-meta">
                    Comparison read error: {visible()?.comparisonError}
                  </p>
                </Show>
              </div>
            </details>

            <div class="lazers-models-overview">
              <section class="lazers-models-chart" aria-labelledby="lazers-models-chart-title">
                <div class="lazers-models-section-heading">
                  <h3 id="lazers-models-chart-title">Historical task outcomes</h3>
                  <span>Observed LAZERS evidence</span>
                </div>
                <HistoricalChartPlaceholder />
              </section>

              <section
                class="lazers-models-candidates"
                aria-labelledby="lazers-models-candidates-title"
              >
                <div class="lazers-models-section-heading">
                  <h3 id="lazers-models-candidates-title">Native candidates</h3>
                  <span>
                    {visible()?.comparison
                      ? `${visible()!.candidates.length} of ${visible()!.comparison!.totalCandidates}`
                      : "Waiting for catalog evidence"}
                  </span>
                </div>
                <div class="lazers-models-candidate-list" aria-label="Model candidates">
                  <Show
                    when={visible()?.candidates.length}
                    fallback={
                      <div class="lazers-models-note">
                        {visible()?.comparisonLoading
                          ? "Loading candidate evidence…"
                          : visible()?.comparison
                            ? "No candidates in the saved catalog."
                            : "Candidate evidence is unavailable."}
                      </div>
                    }
                  >
                    <For each={visible()?.candidates ?? []}>
                      {(candidate) => (
                        <ModelCandidateRow
                          candidate={candidate}
                          selected={candidate.candidateID === visible()?.selectedCandidateID}
                          tabIndex={candidate.candidateID === candidateFocusID() ? 0 : -1}
                          onKeyDown={candidateKey}
                          onSelect={() => state.selectCandidate(candidate.candidateID)}
                        />
                      )}
                    </For>
                  </Show>
                </div>
                <Show when={visible()?.comparison?.nextCursor && !visible()?.comparisonStale}>
                  <Ui.Button
                    size="small"
                    variant="ghost"
                    busy={visible()?.comparisonLoading}
                    onClick={() => void state.moreCandidates()}
                  >
                    Load more candidates
                  </Ui.Button>
                </Show>
              </section>
            </div>
          </section>
        </Show>
      </div>

      <div
        class="lazers-models-separator"
        role="separator"
        aria-label="Resize model comparison and inspector"
        aria-orientation="horizontal"
        aria-valuemin={24}
        aria-valuemax={76}
        aria-valuenow={split()}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
          event.preventDefault()
          setSplit(
            clampSplit(
              event.key === "Home"
                ? 24
                : event.key === "End"
                  ? 76
                  : split() + (event.key === "ArrowDown" ? 5 : -5),
            ),
          )
          save({ split: split() })
        }}
      />

      <div
        class="lazers-models-inspector"
        ref={(element) => {
          inspector = element
        }}
        onScroll={(event) => save({ inspectorScroll: event.currentTarget.scrollTop })}
      >
        <Show
          when={selectedCandidate()}
          fallback={
            <div class="lazers-models-note">
              {visible()?.selectedCandidateID
                ? "The selected candidate is not in the available evidence page."
                : "Select a native candidate to inspect its evidence and task effort."}
            </div>
          }
        >
          {(candidate) => (
            <>
              <div class="lazers-models-inspector-heading">
                <div>
                  <h2>{candidate().native.name ?? candidate().identity.modelID}</h2>
                  <p>{modelRoute(candidate())}</p>
                  <p class="lazers-models-inspector-effort">
                    Effort · {candidateEffortLabel(candidate())}
                  </p>
                </div>
              </div>
              <p class="lazers-models-estimate" role="status">
                <strong>Task estimate unavailable</strong>
                <span>No comparable cohort or estimate projection is available.</span>
              </p>
              <div class="lazers-models-inspector-columns">
                <section class="lazers-models-inspector-block">
                  <h3>Selected task</h3>
                  <Show
                    when={visible()?.selectedTaskID}
                    fallback={
                      <p class="lazers-models-note">
                        Choose an existing project task to inspect recorded effort.
                      </p>
                    }
                  >
                    <Show when={visible()?.taskLoading || visible()?.effortLoading}>
                      <p class="lazers-models-note">
                        <Ui.Loader size="small" /> Loading selected task evidence…
                      </p>
                    </Show>
                    <Show when={visible()?.taskError}>
                      <p class="lazers-models-error" role="alert">
                        Task detail unavailable: {visible()?.taskError}
                      </p>
                    </Show>
                    <Show when={visible()?.effortError}>
                      <p class="lazers-models-note" role="status">
                        Categorized effort unavailable: {visible()?.effortError}
                      </p>
                    </Show>
                    <Show when={selectedTask()}>
                      <div class="lazers-models-task-summary">
                        <p class="lazers-models-task-reference">
                          {selectedTask()?.reference} · {selectedTask()?.task.status}
                        </p>
                        <Ui.Button
                          size="small"
                          variant="ghost-muted"
                          aria-label={`Open trajectory for ${selectedTask()?.reference ?? "selected task"}`}
                          onClick={openSelectedTrajectory}
                        >
                          Open trajectory
                        </Ui.Button>
                      </div>
                      <p class="lazers-models-task-objective">
                        {selectedTask()?.task.proposal.objective}
                      </p>
                    </Show>
                    <Show when={visible()?.effortBasis}>
                      {(basis) => (
                        <details class="lazers-models-task-effort-details">
                          <summary>{effortDetailsSummary()}</summary>
                          <div class="lazers-models-evidence-content">
                            <p class="lazers-models-coverage">
                              {basis().attempts.count} recorded attempts ·{" "}
                              {basis().usage.coverage.totalUniqueSessions} unique worker sessions
                            </p>
                            <div
                              class="lazers-models-category-list"
                              aria-label="Categorized task token usage"
                            >
                              <For each={categoryRows}>
                                {([label, key]) => {
                                  const measure = () => basis().usage.categories[key]
                                  const provenance = () =>
                                    [
                                      measure().sources?.join(", "),
                                      measure().sourceTypes?.join(", "),
                                      measure().observationTimeBases?.join(", "),
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")
                                  const observedDates = () => {
                                    const range = measure().observedAtRange
                                    if (!range || range.earliest === null) return ""
                                    return range.earliest === range.latest
                                      ? ` · observed ${new Date(range.earliest).toLocaleString()}`
                                      : ` · observed ${new Date(range.earliest).toLocaleString()}–${new Date(range.latest ?? range.earliest).toLocaleString()}`
                                  }
                                  return (
                                    <>
                                      <div class="lazers-models-category-row">
                                        <span>{label}</span>
                                        <span data-status={measure().status}>
                                          {measure().value === null
                                            ? statusText(measure().status)
                                            : `${formatNumber(measure().value)} tokens${measure().status === "partial" ? " · observed subtotal" : ""}`}
                                        </span>
                                      </div>
                                      <Show when={provenance()}>
                                        <p class="lazers-models-source-meta">
                                          {provenance()}
                                          {observedDates()}
                                        </p>
                                      </Show>
                                    </>
                                  )
                                }}
                              </For>
                            </div>
                            <p class="lazers-models-source-meta">
                              Usage follows the session-deduplicated accounting basis. Legacy
                              per-attempt scalar token counts are not included.
                            </p>
                            <p class="lazers-models-coverage">
                              {basis().usage.coverage.nativeCumulativeSnapshots} native snapshots ·{" "}
                              {basis().usage.coverage.retainedCumulativeSnapshots} retained
                              snapshots · {basis().usage.coverage.additiveStepSubtotals} additive
                              subtotals · {basis().usage.coverage.missingSessions.length} missing
                              sessions · {basis().usage.coverage.unavailableSessions.length}{" "}
                              unavailable sessions
                              {basis().usage.coverage.progressTruncated
                                ? " · progress evidence truncated"
                                : ""}
                            </p>
                            <p class="lazers-models-unknown-cost">
                              Full task cost: Unknown · market-equivalent cost: Unknown · quality:
                              Not recorded · task class: Not recorded
                            </p>
                            <section
                              class="lazers-models-task-routes"
                              aria-label="Selected task route evidence"
                            >
                              <h4>Route evidence for this candidate</h4>
                              <p>{basis().routes.usageAttribution}</p>
                              <p>
                                {basis().routes.coverage.observedSessionRouteCount} of{" "}
                                {basis().routes.coverage.totalUniqueSessions} worker sessions have
                                an observed current route ·{" "}
                                {basis().routes.coverage.sessionsWithoutCurrentRoute.length} missing
                                current routes ·{" "}
                                {basis().routes.coverage.stepContextsByStatus.available} step
                                contexts available,{" "}
                                {basis().routes.coverage.stepContextsByStatus.notRead} not read,{" "}
                                {basis().routes.coverage.stepContextsByStatus.unavailable}{" "}
                                unavailable
                                {basis().routes.coverage.progressTruncated
                                  ? " · progress context truncated"
                                  : ""}
                              </p>
                              <Show
                                when={routeAssignments().length}
                                fallback={
                                  <p>
                                    No task route assignment records are available;
                                    candidate-specific route attribution is unavailable.
                                  </p>
                                }
                              >
                                <For each={routeAssignments().slice(0, 20)}>
                                  {(assignment) => (
                                    <article class="lazers-models-route-evidence">
                                      <code style={{ "font-family": ctx.appearance.font("mono") }}>
                                        {assignment.attemptID}
                                      </code>
                                      <span>
                                        Plan route · {assignment.planSelection.status} ·{" "}
                                        {assignment.planSelection.route
                                          ? `${routeLabel(assignment.planSelection.route)}${exactRouteMatch(assignment.planSelection.route, candidate()) ? " · selected candidate" : " · different from selected candidate"}`
                                          : "Unknown"}
                                        {assignment.planSelection.source
                                          ? ` · ${assignment.planSelection.source}`
                                          : ""}
                                      </span>
                                      <span>
                                        Frozen attempt route ·{" "}
                                        {assignment.frozenAttemptRoute.status} ·{" "}
                                        {assignment.frozenAttemptRoute.route
                                          ? `${routeLabel(assignment.frozenAttemptRoute.route)}${exactRouteMatch(assignment.frozenAttemptRoute.route, candidate()) ? " · selected candidate" : " · different from selected candidate"}`
                                          : "Unknown"}
                                        {assignment.frozenAttemptRoute.source
                                          ? ` · ${assignment.frozenAttemptRoute.source}`
                                          : ""}
                                      </span>
                                      <For each={assessmentsFor(assignment.attemptID)}>
                                        {(assessment) => (
                                          <span>
                                            Observed {assessment.scope} route · {assessment.status}{" "}
                                            ·{" "}
                                            {assessment.observedRoute
                                              ? `${routeLabel(assessment.observedRoute)}${exactRouteMatch(assessment.observedRoute, candidate()) ? " · selected candidate observed" : " · different from selected candidate"}`
                                              : "Unknown"}{" "}
                                            · {assessment.source} / {assessment.sourceType}
                                          </span>
                                        )}
                                      </For>
                                      <Show when={!assessmentsFor(assignment.attemptID).length}>
                                        <span>Observed route unavailable for this attempt.</span>
                                      </Show>
                                    </article>
                                  )}
                                </For>
                                <Show when={routeAssignments().length > 20}>
                                  <p>
                                    {routeAssignments().length - 20} additional route records are
                                    not shown.
                                  </p>
                                </Show>
                              </Show>
                            </section>
                          </div>
                        </details>
                      )}
                    </Show>
                  </Show>
                </section>

                <details class="lazers-models-evidence-details">
                  <summary>Model evidence, dates and assumptions</summary>
                  <div class="lazers-models-evidence-content">
                    <h3>Candidate evidence</h3>
                    <dl class="lazers-models-evidence-summary">
                      <dt>Native catalog</dt>
                      <dd>
                        {candidate().native.enabled === null
                          ? "Availability unknown"
                          : candidate().native.enabled
                            ? "Available"
                            : "Disabled"}{" "}
                        · {candidate().native.evidence.recordCount} record(s)
                      </dd>
                      <dt>OpenRouter model</dt>
                      <dd>
                        {candidate().correspondence.status} ·{" "}
                        {candidate().externalModel?.name ??
                          candidate().externalModel?.id ??
                          "No exact record"}
                      </dd>
                      <dt>External benchmark</dt>
                      <dd>
                        {candidate().externalBenchmark
                          ? `Artificial Analysis coding · ${benchmarkLabel(candidate())}`
                          : `${candidate().benchmarkCorrespondence.status} · unavailable`}
                      </dd>
                      <dt>Effort applicability</dt>
                      <dd>
                        {candidate().effortApplicability.status === "exact"
                          ? "Exact source effort match"
                          : "Unknown"}
                      </dd>
                    </dl>
                    <Show when={candidate().externalBenchmark}>
                      {(benchmark) => (
                        <div class="lazers-models-benchmark-details">
                          <h4>External benchmark · Artificial Analysis</h4>
                          <p>Coding index: {numericValue(benchmark().codingIndex)}</p>
                          <p>Agentic index: {numericValue(benchmark().agenticIndex)}</p>
                          <p>Intelligence index: {numericValue(benchmark().intelligenceIndex)}</p>
                          <p>Effort: {benchmark().effort ?? "Not reported"}</p>
                          <p class="lazers-models-source-meta">
                            External benchmark evidence is shown separately from LAZERS outcomes; it
                            is not a task-fit score or rank.
                          </p>
                        </div>
                      )}
                    </Show>
                    <p>Selected route variant: {candidate().identity.variant ?? "Not specified"}</p>
                    <p>
                      Native catalog metadata · type {candidate().native.type ?? "Not reported"} ·
                      context {numericValue(candidate().native.contextTokens)} tokens · tools{" "}
                      {candidate().native.capabilities.tools === null
                        ? "Unknown"
                        : candidate().native.capabilities.tools
                          ? "supported"
                          : "not supported"}{" "}
                      · input {candidate().native.capabilities.input?.join(", ") ?? "Not reported"}{" "}
                      · output{" "}
                      {candidate().native.capabilities.output?.join(", ") ?? "Not reported"} ·
                      {variantCoverageLabel(candidate())}
                    </p>
                    <Show when={candidate().externalModel}>
                      {(model) => (
                        <p>
                          OpenRouter metadata · context {numericValue(model().contextLength)} tokens
                          · modality {model().architecture.modality ?? "Not reported"} · input{" "}
                          {model().architecture.inputModalities?.join(", ") ?? "Not reported"} ·
                          output{" "}
                          {model().architecture.outputModalities?.join(", ") ?? "Not reported"} ·
                          tokenizer {model().architecture.tokenizer ?? "Not reported"} · supported
                          parameters {model().supportedParameters?.join(", ") ?? "Not reported"}
                        </p>
                      )}
                    </Show>
                    <p>Native record references ({candidate().native.evidence.recordCount})</p>
                    <For each={candidate().native.evidence.records}>
                      {(reference) => <code>{recordReferenceLabel(reference)}</code>}
                    </For>
                    <p>
                      OpenRouter model references ({candidate().externalModelEvidence.recordCount})
                    </p>
                    <For each={candidate().externalModelEvidence.records}>
                      {(reference) => <code>{recordReferenceLabel(reference)}</code>}
                    </For>
                    <p>
                      External benchmark references (
                      {candidate().externalBenchmarkEvidence.recordCount})
                    </p>
                    <For each={candidate().externalBenchmarkEvidence.records}>
                      {(reference) => <code>{recordReferenceLabel(reference)}</code>}
                    </For>
                    <Show when={candidate().native.ambiguousIdentity}>
                      <p>
                        Native candidate metadata differs across source records; identity details
                        may be ambiguous.
                      </p>
                    </Show>
                    <Show when={candidate().externalModel?.prices}>
                      {(prices) => (
                        <p>
                          OpenRouter published price ({prices().unit}):{" "}
                          {prices()
                            .tiers.map(
                              (tier) =>
                                `prompt ${tier.prompt ?? "not reported"}, completion ${tier.completion ?? "not reported"}, cache read ${tier.inputCacheRead ?? "not reported"}, cache write ${tier.inputCacheWrite ?? "not reported"}`,
                            )
                            .join("; ") || "no price tiers"}
                        </p>
                      )}
                    </Show>
                    <Show when={candidate().externalBenchmark?.prices}>
                      {(prices) => (
                        <p>
                          External benchmark published price ({prices().unit}): prompt{" "}
                          {prices().prompt ?? "not reported"}, completion{" "}
                          {prices().completion ?? "not reported"}
                        </p>
                      )}
                    </Show>
                    <Show when={candidate().native.prices}>
                      {(prices) => (
                        <p>
                          Native catalog price ({prices().unit}):{" "}
                          {prices()
                            .tiers.map(
                              (tier) =>
                                `input ${numericValue(tier.input)}, output ${numericValue(tier.output)}, cache read ${numericValue(tier.cacheRead)}, cache write ${numericValue(tier.cacheWrite)}`,
                            )
                            .join("; ") || "no price tiers"}
                        </p>
                      )}
                    </Show>
                    <p>
                      External model correspondence: {candidate().correspondence.status} ·{" "}
                      {candidate().correspondence.basis ?? "no exact mapping basis"}
                    </p>
                    <p>
                      Benchmark correspondence: {candidate().benchmarkCorrespondence.status} ·{" "}
                      {candidate().benchmarkCorrespondence.basis ?? "no exact mapping basis"}
                    </p>
                    <Show when={visible()?.comparison?.sources}>
                      <For each={visible()?.comparison?.sources ?? []}>
                        {(source) => (
                          <p>
                            {sourceTitle(source.source)} ·{" "}
                            {source.snapshot
                              ? `as of ${formatDate(source.snapshot.asOf)} · retrieved ${formatDate(source.snapshot.retrievedAt)} · ${source.snapshot.sourceURL}`
                              : "No snapshot date"}{" "}
                            · {sourceState(source)}
                          </p>
                        )}
                      </For>
                    </Show>
                    <p>
                      Missing source correspondence and pricing remain unknown; external benchmarks
                      are not task-fit estimates.
                    </p>
                  </div>
                </details>
              </div>
            </>
          )}
        </Show>
      </div>
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

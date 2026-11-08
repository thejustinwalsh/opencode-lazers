import { Store, bindPlugin, createLatest, createKeyed, usePanel } from "@opencode/plugin/gui"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { Observability } from "../observability/contract.ts"
import type { SnapshotResponse } from "../observability/contract.ts"
import {
  activeState,
  checkKey,
  machineSupported,
  observedTransition,
  planTransitions,
  selectedNode,
  selectedPlan,
  timelineAttempts,
  timelineChecks,
  transitionForSequence,
} from "./projection.ts"
import type { TimelineAttempt, TimelineCheck } from "./projection.ts"
import { clampSplit, splitFromPointer } from "./layout.ts"
import { flowStateInspector, ScrollRestoration } from "./presentation.ts"
import { RadarPanelState } from "./state.ts"
import type { RadarPanelData } from "./state.ts"
import { createRadarTransport } from "./transport.ts"
import { statechartLayout } from "./statechart.ts"
import { timePercent, timelineProjection } from "./timeline.ts"
import type { TimelineMark } from "./timeline.ts"
import type { ObservationScope } from "../observability/contract.ts"
import { registerRadarPanel } from "./registration.ts"
import { radarProjectIdentity } from "./project.ts"
import { taskTitle } from "../tasks/presentation.ts"
import { RadarLayout } from "./layout-ipc.ts"
import { RadarMapInspector, RadarMapView } from "./map-view.tsx"
import { createRadarMapModel } from "./map-model.ts"
import { RadarMonitorState } from "./monitor-state.ts"
import type { RadarMonitorData } from "./monitor-state.ts"
import { createRadarMonitorTransport } from "./monitor-transport.ts"
import { RadarMonitorView } from "./monitor-view.tsx"
import { radarErrorMessage } from "./monitor-state.ts"

const View = Schema.Struct({
  scope: Schema.Literals(["session", "project"]),
  view: Schema.Literals(["map", "flow", "timeline"]),
  includeUnmanagedSessions: Schema.Boolean,
  planID: Schema.NullOr(Schema.String),
  taskID: Schema.NullOr(Schema.String),
  selectedMapID: Schema.NullOr(Schema.String),
  selectedTransition: Schema.NullOr(Schema.Number),
  selectedState: Schema.NullOr(Schema.String),
  selectedAttemptID: Schema.NullOr(Schema.String),
  selectedCheckID: Schema.NullOr(Schema.String),
  split: Schema.Number,
  visualScroll: Schema.Number,
  visualScrollLeft: Schema.optionalKey(Schema.Number),
  detailScroll: Schema.Number,
  detailScrollLeft: Schema.optionalKey(Schema.Number),
})
const initial: typeof View.Type = {
  scope: "session",
  view: "map",
  includeUnmanagedSessions: false,
  planID: null,
  taskID: null,
  selectedMapID: null,
  selectedTransition: null,
  selectedState: null,
  selectedAttemptID: null,
  selectedCheckID: null,
  split: 55,
  visualScroll: 0,
  visualScrollLeft: 0,
  detailScroll: 0,
  detailScrollLeft: 0,
}
const ProjectView = Schema.Struct({
  scope: Schema.Literals(["session", "project"]),
  session: View,
  project: View,
})
const initialProject: typeof ProjectView.Type = {
  scope: "session",
  session: initial,
  project: { ...initial, scope: "project" },
}

export const radarStores = {
  radarView: Store.session(Schema.Struct({ projects: Schema.Record(Schema.String, ProjectView) }), {
    projects: {},
  }),
}
export type RadarContext = SetupContext<{ stores: typeof radarStores }>

function timeLabel(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unavailable"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString()
}

function timeValue(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function selectedAttempt(
  snapshot: SnapshotResponse | undefined,
  planID: string | undefined,
  id: string | null,
) {
  if (!snapshot || !planID || !id) return undefined
  return timelineAttempts(snapshot, planID).find((attempt) => attempt.id === id)
}

function selectedCheck(
  snapshot: SnapshotResponse | undefined,
  planID: string | undefined,
  id: string | null,
) {
  if (!snapshot || !planID || !id) return undefined
  return timelineChecks(snapshot, planID).find((check) => checkKey(check) === id)
}

function RadarDiagnosticsPanel(props: PanelProps & { ctx: RadarContext; onBack: () => void }) {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()
  const radarLayout = ctx.main(RadarLayout)
  const [data, setData] = createSignal<RadarPanelData>({
    key: "",
    loading: true,
    stale: true,
    resynchronizing: true,
    error: "",
  })
  const [split, setSplit] = createSignal(initial.split)
  const [layoutReadyKey, setLayoutReadyKey] = createSignal("")
  const state = new RadarPanelState(setData)
  const visualRestore = new ScrollRestoration()
  const detailRestore = new ScrollRestoration()
  let root: HTMLDivElement | undefined
  let header: HTMLElement | undefined
  let visual: HTMLDivElement | undefined
  let separator: HTMLDivElement | undefined
  let detail: HTMLDivElement | undefined
  let endDrag: (() => void) | undefined

  const location = createLatest(
    () => {
      if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
      return {
        client: props.session.server.client,
        session: props.session.id,
        server: props.session.server.id,
        directory: props.session.directory,
      }
    },
    async (source, signal) => {
      const result = await source.client.location.get(
        { location: { directory: source.directory } },
        { signal },
      )
      return { ...source, ...radarProjectIdentity(result.project) }
    },
  )
  const current = () => {
    if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
    const value = location.latest
    return value &&
      value.session === props.session.id &&
      value.server === props.session.server.id &&
      value.directory === props.session.directory &&
      !location.loading
      ? value
      : undefined
  }
  const projectKey = () => {
    const value = current()
    return value ? JSON.stringify([value.server, value.project]) : ""
  }
  const prefs = () => {
    const key = projectKey()
    if (!key) return initial
    const value = ctx.stores.radarView(props.session).value?.projects[key] ?? initialProject
    const view = value[value.scope]
    return {
      ...initial,
      ...view,
      visualScrollLeft: view.visualScrollLeft ?? 0,
      detailScrollLeft: view.detailScrollLeft ?? 0,
    }
  }
  const save = (change: Partial<typeof initial>) => {
    const key = projectKey()
    if (!key) return
    const store = ctx.stores.radarView(props.session)
    store.update((draft) => {
      const value = draft.projects[key] ?? initialProject
      const scope = change.scope ?? value.scope
      const nextView = { ...value[scope], ...change, scope }
      draft.projects[key] =
        scope === "session"
          ? { ...value, scope, session: nextView }
          : { ...value, scope, project: nextView }
    })
  }
  onCleanup(() => {
    state.close()
    endDrag?.()
    visualRestore.restore("", false, undefined, { top: 0, left: 0 })
    detailRestore.restore("", false, undefined, { top: 0, left: 0 })
  })

  createKeyed(
    () => {
      const value = current()
      if (!value || !frame.visible() || !ctx.stores.radarView(props.session).ready())
        return undefined
      const view = prefs()
      const key = JSON.stringify([
        value.server,
        value.project,
        value.session,
        view.scope,
        view.includeUnmanagedSessions,
      ])
      return { value, key, view }
    },
    ({ value, key, view }) => {
      setSplit(clampSplit(view.split))
      const observationScope: ObservationScope = {
        kind: view.scope,
        sessionID: value.session,
      }
      const transport = createRadarTransport(
        () => props.session.server.client.rpc(Observability),
        value.directory,
        () => props.session.server.connected,
      )
      state.connect(
        key,
        value.projectID,
        observationScope,
        transport,
        view.includeUnmanagedSessions,
      )
      onCleanup(() => state.close())
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => state.close(),
    },
  )

  const expectedKey = () => {
    const value = current()
    return value
      ? JSON.stringify([
          value.server,
          value.project,
          value.session,
          prefs().scope,
          prefs().includeUnmanagedSessions,
        ])
      : ""
  }
  const visible = () => (data().key === expectedKey() ? data() : undefined)
  const snapshot = () => visible()?.snapshot
  const radar = () => visible()?.radar
  const mapModel = createMemo(() =>
    radar() ? createRadarMapModel(radar()!, snapshot()) : undefined,
  )
  const plan = () => {
    const currentSnapshot = snapshot()
    return currentSnapshot ? selectedPlan(currentSnapshot, prefs().planID) : undefined
  }
  const node = () => {
    const currentPlan = plan()
    return currentPlan ? selectedNode(currentPlan, prefs().taskID) : undefined
  }
  const transitions = () => {
    const currentSnapshot = snapshot()
    const currentPlan = plan()
    return currentSnapshot && currentPlan ? planTransitions(currentSnapshot, currentPlan) : []
  }
  const chart = () => {
    const currentSnapshot = snapshot()
    const currentPlan = plan()
    return currentSnapshot && currentPlan
      ? timelineProjection(currentSnapshot, currentPlan, !stale())
      : { lanes: [], startAt: null, endAt: null }
  }
  const chosenTransition = () => {
    const currentSnapshot = snapshot()
    const currentPlan = plan()
    const stored = prefs().selectedTransition
    if (!currentSnapshot || !currentPlan || prefs().selectedCheckID || prefs().selectedAttemptID)
      return undefined
    if (stored !== null) {
      const found = transitionForSequence(currentSnapshot, stored)
      return found?.planID === currentPlan.id ? found : undefined
    }
    if (prefs().selectedState) return undefined
    return undefined
  }
  const chosenAttempt = () => selectedAttempt(snapshot(), plan()?.id, prefs().selectedAttemptID)
  const chosenCheck = () => selectedCheck(snapshot(), plan()?.id, prefs().selectedCheckID)
  const chosenState = () => {
    const currentSnapshot = snapshot()
    const currentNode = node()
    if (
      !currentSnapshot ||
      !currentNode ||
      prefs().selectedTransition !== null ||
      prefs().selectedAttemptID !== null ||
      prefs().selectedCheckID !== null
    )
      return undefined
    const stateID = prefs().selectedState ?? activeState(currentNode, currentSnapshot)
    return stateID
      ? currentSnapshot.machine.states.find((state) => state.id === stateID)
      : undefined
  }
  const missingSelection = () =>
    (prefs().selectedTransition !== null && !chosenTransition()) ||
    (prefs().selectedAttemptID !== null && !chosenAttempt()) ||
    (prefs().selectedCheckID !== null && !chosenCheck()) ||
    (prefs().selectedState !== null && !chosenState())
  const selectionKey = () =>
    JSON.stringify([
      expectedKey(),
      plan()?.id,
      node()?.taskID,
      chosenTransition()?.sequence,
      chosenAttempt()?.id,
      chosenCheck() ? checkKey(chosenCheck()!) : undefined,
      chosenState()?.id,
      prefs().view,
      prefs().selectedMapID,
    ])
  const selectedAttemptID = (attempt: TimelineAttempt) =>
    save({
      taskID: attempt.taskID,
      selectedTransition: null,
      selectedState: null,
      selectedAttemptID: attempt.id,
      selectedCheckID: null,
      detailScroll: 0,
    })
  const selectedCheckID = (check: TimelineCheck) =>
    save({
      selectedTransition: null,
      selectedState: null,
      selectedAttemptID: null,
      selectedCheckID: check.id,
      detailScroll: 0,
    })
  const selectedStateID = (stateID: string) =>
    save({
      selectedTransition: null,
      selectedState: stateID,
      selectedAttemptID: null,
      selectedCheckID: null,
      detailScroll: 0,
    })
  const chooseTransition = (transition: NonNullable<ReturnType<typeof chosenTransition>>) => {
    const currentPlan = plan()
    const taskID =
      transition.taskID && currentPlan?.nodes.some((item) => item.taskID === transition.taskID)
        ? transition.taskID
        : prefs().taskID
    save({
      ...(taskID ? { taskID } : {}),
      selectedTransition: transition.sequence,
      selectedState: null,
      selectedAttemptID: null,
      selectedCheckID: null,
      detailScroll: 0,
    })
  }
  const chooseMark = (mark: TimelineMark) => {
    if (mark.transition) chooseTransition(mark.transition)
    else if (mark.check) selectedCheckID(mark.check)
    else if (mark.attempt) selectedAttemptID(mark.attempt)
  }
  const markPressed = (mark: TimelineMark) =>
    (mark.transition && chosenTransition()?.sequence === mark.transition.sequence) ||
    (mark.check && chosenCheck() && checkKey(chosenCheck()!) === checkKey(mark.check)) ||
    (mark.attempt && chosenAttempt()?.id === mark.attempt.id)
  const timelineLabel = (mark: TimelineMark) => {
    const source = mark.transition
      ? `sequence ${mark.transition.sequence}, ${mark.transition.event}`
      : mark.check
        ? `${mark.check.checkID}, ${mark.check.state}`
        : mark.attempt
          ? `attempt ${mark.attempt.number}, ${mark.attempt.state}`
          : mark.label
    const start = mark.startAt === null ? "start unavailable" : `start ${timeLabel(mark.startAt)}`
    const end =
      mark.displayEndAt === null ? "end unavailable" : `end ${timeLabel(mark.displayEndAt)}`
    return `${source}; ${start}; ${end}${mark.openThroughObservation ? "; open through observed time" : ""}`
  }
  const markStart = (mark: TimelineMark) => mark.startAt ?? mark.endAt ?? mark.displayEndAt
  const markEnd = (mark: TimelineMark) => mark.displayEndAt ?? mark.endAt
  const laneLabel = (lane: { label: string; taskID: string | null; attemptID: string | null }) => {
    if (!lane.taskID) return plan()?.title ?? plan()?.id.slice(0, 8) ?? lane.label
    const attempt = timelineAttempts(snapshot()!, plan()!.id).find(
      (item) => item.id === lane.attemptID,
    )
    const objective = plan()?.nodes.find((item) => item.taskID === lane.taskID)?.objective
    const label = objective ? taskTitle(objective) : lane.taskID.slice(0, 8)
    return attempt ? `${label} · ${attempt.number}` : label
  }

  createEffect(() => {
    if (prefs().view !== "map") setLayoutReadyKey("")
  })

  createEffect(() => {
    const value = visible()
    const view = prefs()
    const mapReady = view.view !== "map" || layoutReadyKey() === expectedKey()
    visualRestore.restore(
      `${expectedKey()}:${view.view}`,
      Boolean(value && (value.snapshot || value.radar) && mapReady),
      visual,
      { top: view.visualScroll, left: view.visualScrollLeft ?? 0 },
    )
    detailRestore.restore(
      selectionKey(),
      Boolean(value && (value.snapshot || value.radar)),
      detail,
      { top: view.detailScroll, left: view.detailScrollLeft ?? 0 },
    )
  })
  const planMissing = () =>
    Boolean(
      prefs().planID && snapshot() && !snapshot()!.plans.some((item) => item.id === prefs().planID),
    )
  const taskMissing = () =>
    Boolean(
      prefs().taskID && plan() && !plan()!.nodes.some((item) => item.taskID === prefs().taskID),
    )
  const stale = () => Boolean(visible()?.stale || !props.session.server.connected)
  const staleLabel = () =>
    !props.session.server.connected
      ? "Server disconnected; observation is not live"
      : visible()?.stale
        ? `Observation is stale; last observation ${snapshot()?.observedAt ?? "unavailable"}`
        : "Observation is current"
  const currentPlanTransitions = () => transitions()
  const flowNode = () => node()
  const flowActiveState = () => {
    const currentSnapshot = snapshot()
    const currentNode = flowNode()
    return currentSnapshot && currentNode ? activeState(currentNode, currentSnapshot) : undefined
  }
  const flowGraph = createMemo(() => {
    const currentSnapshot = snapshot()
    const currentPlan = plan()
    const currentNode = flowNode()
    return currentSnapshot &&
      currentPlan &&
      currentNode &&
      machineSupported(currentNode, currentSnapshot)
      ? statechartLayout(currentSnapshot, currentPlan, currentNode)
      : undefined
  })
  const resize = (next: number) => setSplit(clampSplit(next))
  const drag: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    endDrag?.()
    const key = expectedKey()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      const rect = root?.getBoundingClientRect()
      if (rect)
        resize(
          splitFromPointer(
            split(),
            rect.top,
            rect.height,
            header?.getBoundingClientRect().height ?? 0,
            separator?.getBoundingClientRect().height ?? 0,
            moveEvent.clientY,
          ),
        )
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

  return (
    <div
      class="lazers-radar"
      ref={(element) => {
        root = element
      }}
      style={{
        "--radar-visual-fr": `${split()}fr`,
        "--radar-detail-fr": `${100 - split()}fr`,
      }}
    >
      <header
        class="lazers-radar-header"
        ref={(element) => {
          header = element
        }}
      >
        <div class="lazers-radar-heading">
          <h2>Radar</h2>
          <span
            class="lazers-radar-status-dot"
            data-stale={stale()}
            role="img"
            aria-label={staleLabel()}
            title={staleLabel()}
          />
          <span class="lazers-radar-scope">
            <Ui.Menu
              label={prefs().scope === "session" ? "Session" : "Project"}
              trigger="button"
              icon="chevron-down"
              items={[
                { label: "This session", onSelect: () => save({ scope: "session" }) },
                { label: "Project", onSelect: () => save({ scope: "project" }) },
              ]}
            />
          </span>
        </div>
        <div class="lazers-radar-controls">
          <Ui.Button variant="ghost" onClick={props.onBack}>
            Live monitor
          </Ui.Button>
          <Show when={prefs().view !== "map" ? snapshot() : undefined}>
            {(value) => (
              <div class="lazers-radar-pickers">
                <Show when={value().plans.length > 0}>
                  <span class="lazers-radar-picker">
                    <Ui.Menu
                      label={
                        plan()?.title ??
                        plan()?.id.slice(0, 8) ??
                        (planMissing() ? "Unavailable plan" : "Select plan")
                      }
                      trigger="button"
                      items={value().plans.map((item) => ({
                        label: item.title ?? item.id,
                        onSelect: () =>
                          save({
                            planID: item.id,
                            taskID: null,
                            selectedTransition: null,
                            selectedState: null,
                            selectedAttemptID: null,
                            selectedCheckID: null,
                            visualScroll: 0,
                            detailScroll: 0,
                          }),
                      }))}
                    />
                  </span>
                </Show>
                <Show when={(plan()?.nodes.length ?? 0) > 1}>
                  <span class="lazers-radar-picker">
                    <Ui.Menu
                      label={
                        node()
                          ? `${node()!.state} · ${node()!.taskID.slice(0, 8)}`
                          : "Unavailable task"
                      }
                      trigger="button"
                      items={(plan()?.nodes ?? []).map((item) => ({
                        label: `${item.state} · ${item.taskID.slice(0, 8)}`,
                        onSelect: () =>
                          save({
                            taskID: item.taskID,
                            selectedTransition: null,
                            selectedState: null,
                            selectedAttemptID: null,
                            selectedCheckID: null,
                            visualScroll: 0,
                            detailScroll: 0,
                          }),
                      }))}
                    />
                  </span>
                </Show>
              </div>
            )}
          </Show>
          <Show when={prefs().view === "map"}>
            <button
              type="button"
              class="lazers-radar-other-sessions"
              aria-pressed={prefs().includeUnmanagedSessions}
              onClick={() => save({ includeUnmanagedSessions: !prefs().includeUnmanagedSessions })}
            >
              {prefs().includeUnmanagedSessions ? "Other sessions shown" : "Managed sessions"}
            </button>
          </Show>
          <div class="lazers-radar-tabs" role="tablist" aria-label="Radar view">
            <button
              type="button"
              role="tab"
              aria-selected={prefs().view === "map"}
              onClick={() => save({ view: "map" })}
            >
              Map
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={prefs().view === "flow"}
              onClick={() => save({ view: "flow" })}
            >
              Flow
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={prefs().view === "timeline"}
              onClick={() => save({ view: "timeline" })}
            >
              Timeline
            </button>
          </div>
        </div>
      </header>
      <div
        class="lazers-radar-visual"
        ref={(element) => {
          visual = element
        }}
        onScroll={(event) => {
          const key = `${expectedKey()}:${prefs().view}`
          if (visualRestore.restored(key))
            save({
              visualScroll: event.currentTarget.scrollTop,
              visualScrollLeft: event.currentTarget.scrollLeft,
            })
        }}
      >
        <Show when={location.error}>
          <div class="lazers-radar-note" data-error="true" role="alert">
            {String(location.error)}
          </div>
        </Show>
        <Show when={visible()?.error}>
          <div class="lazers-radar-note" role="status">
            {visible()?.error}
            <Show when={props.session.server.connected}>
              <Ui.Button variant="ghost" onClick={() => state.refreshNow()}>
                Refresh
              </Ui.Button>
            </Show>
          </div>
        </Show>
        <Show when={prefs().view === "map"}>
          <Show
            when={radar()}
            fallback={
              <div class="lazers-radar-note">
                {visible()?.loading
                  ? "Loading operational Radar data…"
                  : "No operational Radar data is available."}
              </div>
            }
          >
            {(operational) => (
              <>
                <details class="lazers-radar-map-freshness">
                  <summary>
                    {stale() ? "Last observed" : "Live"} ·{" "}
                    {new Date(operational().observedAt).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                      second: "2-digit",
                    })}{" "}
                    · {operational().coverage.managedSessionCount} sessions
                  </summary>
                  <dl>
                    <dt>Observed</dt>
                    <dd>{operational().observedAt}</dd>
                    <dt>Sources</dt>
                    <dd>
                      Runner {operational().freshness.runner} · inventory{" "}
                      {operational().freshness.nativeInventory} · events{" "}
                      {operational().freshness.nativeEvents}
                    </dd>
                    <dt>Sessions</dt>
                    <dd>
                      {operational().coverage.managedSessionCount} managed of{" "}
                      {operational().coverage.sessionCount} scoped · unmanaged included{" "}
                      {operational().coverage.includeUnmanagedSessions ? "yes" : "no"}
                    </dd>
                    <dt>Truncation</dt>
                    <dd>
                      {[
                        operational().coverage.inventoryTruncated ? "sessions" : "",
                        operational().coverage.workTruncated ? "work" : "",
                        operational().coverage.progressTruncated ? "progress" : "",
                        operational().coverage.routeTruncated ? "routes" : "",
                        operational().coverage.toolTruncated ? "tools" : "",
                        operational().coverage.edgeTruncated ? "relationships" : "",
                      ]
                        .filter(Boolean)
                        .join(", ") || "No projection truncation reported"}
                    </dd>
                    <dt>Boundary</dt>
                    <dd>
                      {operational().boundary.repositoryVersion} repository ·{" "}
                      {operational().boundary.sourceRevision} source ·{" "}
                      {operational().boundary.nativeRevision} native
                    </dd>
                  </dl>
                </details>
                <Show when={visible()?.snapshotError}>
                  <div class="lazers-radar-note" role="status">
                    Timeline and Flow lifecycle detail is unavailable: {visible()?.snapshotError}
                  </div>
                </Show>
                <Show
                  when={mapModel()}
                  fallback={<div class="lazers-radar-note">No map records are available.</div>}
                >
                  {(model) => (
                    <RadarMapView
                      model={model()}
                      scopeKey={expectedKey()}
                      resynchronizing={Boolean(
                        visible()?.resynchronizing || !props.session.server.connected,
                      )}
                      selectedID={prefs().selectedMapID}
                      currentSessionID={props.session.id}
                      onLayoutReady={setLayoutReadyKey}
                      onSelect={(id) => save({ selectedMapID: id, detailScroll: 0 })}
                      layout={radarLayout}
                      monoFont={ctx.appearance.font("mono")}
                    />
                  )}
                </Show>
                <div class="lazers-radar-map-key" aria-label="Relationship type key">
                  <span data-kind="architecture">Architecture</span>
                  <span data-kind="dependency">Dependency</span>
                  <span data-kind="assignment">Dispatch</span>
                  <span data-kind="prompt">Prompt / delivery</span>
                  <span data-kind="outcome">Outcome</span>
                  <span data-kind="model-request">Model request</span>
                  <span data-kind="model-response">Model response</span>
                  <span data-kind="tool-call">Tool call</span>
                  <span data-kind="tool-result">Tool result</span>
                  <span data-kind="observation">Read</span>
                </div>
              </>
            )}
          </Show>
        </Show>
        <Show when={prefs().view !== "map"}>
          <Show
            when={snapshot()}
            fallback={
              <div class="lazers-radar-note">
                {visible()?.loading ? "Loading observation…" : "No observation is available."}
              </div>
            }
          >
            {(value) => (
              <>
                <Show when={stale() && (visible()?.error || !props.session.server.connected)}>
                  <div class="lazers-radar-note" role="status">
                    {!props.session.server.connected
                      ? "The server is disconnected. Displayed records are not live."
                      : `Last observation ${timeLabel(Date.parse(value().observedAt))}.`}
                  </div>
                </Show>
                <Show
                  when={value().plans.length > 0}
                  fallback={
                    <div class="lazers-radar-note">
                      {value().unplannedTasks.length
                        ? "No runner plan is recorded for the submitted tasks in this scope."
                        : "No recorded runner activity in this scope."}
                    </div>
                  }
                >
                  <Show
                    when={!planMissing()}
                    fallback={
                      <div class="lazers-radar-note">
                        The previously selected plan is no longer available in this scope.
                      </div>
                    }
                  >
                    <Show
                      when={plan()}
                      fallback={<div class="lazers-radar-note">Select a recorded plan.</div>}
                    >
                      <Show
                        when={!taskMissing()}
                        fallback={
                          <div class="lazers-radar-note">
                            The previously selected task is no longer part of this plan.
                          </div>
                        }
                      >
                        <Show
                          when={prefs().view === "flow"}
                          fallback={
                            <>
                              <Show
                                when={chart().lanes.length > 0}
                                fallback={
                                  <div class="lazers-radar-note">
                                    No recorded timeline intervals or transitions in this plan.
                                  </div>
                                }
                              >
                                <div class="lazers-radar-chart" aria-label="Recorded timeline">
                                  <div class="lazers-radar-axis" aria-label="Observed time axis">
                                    <span />
                                    <div class="lazers-radar-axis-plot">
                                      <time dateTime={timeValue(chart().startAt)}>
                                        {timeLabel(chart().startAt)}
                                      </time>
                                      <Show when={chart().startAt !== chart().endAt}>
                                        <time dateTime={timeValue(chart().endAt)}>
                                          {timeLabel(chart().endAt)}
                                        </time>
                                      </Show>
                                    </div>
                                  </div>
                                  <For each={chart().lanes}>
                                    {(lane) => {
                                      const markTop = (index: number) => {
                                        const mark = lane.marks[index]!
                                        return mark.kind === "execution"
                                          ? 6
                                          : mark.kind === "check"
                                            ? 24
                                            : 42
                                      }
                                      return (
                                        <div class="lazers-radar-lane" title={lane.label}>
                                          <div class="lazers-radar-lane-label">
                                            <span>{laneLabel(lane)}</span>
                                          </div>
                                          <div class="lazers-radar-lane-plot">
                                            <For each={lane.marks}>
                                              {(mark, index) => {
                                                const start = () => markStart(mark)
                                                const end = () => markEnd(mark)
                                                const startPosition = () =>
                                                  start() === null
                                                    ? undefined
                                                    : timePercent(start()!, chart())
                                                const endPosition = () =>
                                                  end() === null
                                                    ? undefined
                                                    : timePercent(end()!, chart())
                                                const interval = () =>
                                                  startPosition() !== undefined &&
                                                  endPosition() !== undefined &&
                                                  start() !== end()
                                                const reversed = () =>
                                                  start() !== null &&
                                                  end() !== null &&
                                                  end()! < start()!
                                                const ariaLabel = () =>
                                                  `${timelineLabel(mark)}${reversed() ? "; recorded end precedes start" : ""}`
                                                return (
                                                  <>
                                                    <Show when={interval()}>
                                                      <button
                                                        type="button"
                                                        class="lazers-radar-mark"
                                                        data-kind={mark.kind}
                                                        data-open={mark.openThroughObservation}
                                                        data-reversed={reversed()}
                                                        aria-label={ariaLabel()}
                                                        aria-pressed={Boolean(markPressed(mark))}
                                                        title={ariaLabel()}
                                                        style={{
                                                          left: `${Math.min(startPosition()!, endPosition()!)}%`,
                                                          width: `${Math.max(1, Math.abs(endPosition()! - startPosition()!))}%`,
                                                          top: `${markTop(index())}px`,
                                                        }}
                                                        onClick={() => chooseMark(mark)}
                                                      />
                                                    </Show>
                                                    <Show
                                                      when={
                                                        !interval() && startPosition() !== undefined
                                                      }
                                                    >
                                                      <button
                                                        type="button"
                                                        class="lazers-radar-mark-point"
                                                        data-kind={mark.kind}
                                                        aria-label={ariaLabel()}
                                                        aria-pressed={Boolean(markPressed(mark))}
                                                        title={ariaLabel()}
                                                        style={{
                                                          left: `${startPosition()}%`,
                                                          top: `${markTop(index())}px`,
                                                          transform: "translateX(-6px)",
                                                        }}
                                                        onClick={() => chooseMark(mark)}
                                                      >
                                                        <span class="lazers-radar-mark-point-dot" />
                                                        <span class="lazers-radar-mark-point-label">
                                                          {mark.label}
                                                        </span>
                                                      </button>
                                                    </Show>
                                                    <Show
                                                      when={
                                                        startPosition() === undefined &&
                                                        endPosition() === undefined
                                                      }
                                                    >
                                                      <button
                                                        type="button"
                                                        class="lazers-radar-mark-unknown"
                                                        data-kind={mark.kind}
                                                        aria-label={`${mark.label}; time unavailable`}
                                                        aria-pressed={Boolean(markPressed(mark))}
                                                        style={{ top: `${markTop(index())}px` }}
                                                        onClick={() => chooseMark(mark)}
                                                      >
                                                        {mark.label} · time unavailable
                                                      </button>
                                                    </Show>
                                                  </>
                                                )
                                              }}
                                            </For>
                                          </div>
                                        </div>
                                      )
                                    }}
                                  </For>
                                  <div
                                    class="lazers-radar-timeline-key"
                                    aria-label="Timeline record kinds"
                                  >
                                    <span data-kind="execution">
                                      <i />
                                      Execution
                                    </span>
                                    <span data-kind="check">
                                      <i />
                                      Check
                                    </span>
                                    <span data-kind="transition">
                                      <i />
                                      Transition
                                    </span>
                                  </div>
                                </div>
                              </Show>
                            </>
                          }
                        >
                          <Show
                            when={flowNode() && machineSupported(flowNode()!, value())}
                            fallback={
                              <div class="lazers-radar-note">
                                {flowNode()
                                  ? `Machine version ${flowNode()!.machineVersion} is unsupported; Flow topology is unavailable.`
                                  : "No task instance is recorded in this plan."}
                              </div>
                            }
                          >
                            <Show when={flowNode()!.snapshotMatchesState}>
                              <Show when={flowNode()!.snapshot === null}>
                                <div class="lazers-radar-note">
                                  The persisted machine snapshot is unavailable.
                                </div>
                              </Show>
                            </Show>
                            <Show when={!flowNode()!.snapshotMatchesState}>
                              <div class="lazers-radar-note">
                                The persisted snapshot disagrees with the recorded task state; no
                                current state is highlighted.
                              </div>
                            </Show>
                            <Show when={flowGraph()}>
                              {(graph) => (
                                <>
                                  <svg
                                    class="lazers-radar-statechart"
                                    viewBox={`0 0 ${graph().width} ${graph().height}`}
                                    role="group"
                                    aria-label={`${value().machine.id} ${value().machine.version} state topology`}
                                    preserveAspectRatio="xMidYMin meet"
                                  >
                                    <For each={graph().edges}>
                                      {(edge) => (
                                        <g data-recorded={Boolean(edge.recorded)}>
                                          <path
                                            class="lazers-radar-statechart-edge"
                                            data-recorded={Boolean(edge.recorded)}
                                            d={edge.path}
                                          />
                                          <path
                                            class="lazers-radar-statechart-edge-arrow"
                                            data-recorded={Boolean(edge.recorded)}
                                            d={edge.arrow}
                                          />
                                          <Show
                                            when={
                                              edge.recorded &&
                                              chosenTransition()?.sequence ===
                                                edge.recorded.sequence
                                            }
                                          >
                                            <text
                                              class="lazers-radar-statechart-edge-label"
                                              data-recorded={Boolean(edge.recorded)}
                                              x={edge.labelX}
                                              y={edge.labelY}
                                              text-anchor={edge.labelAnchor}
                                            >
                                              {edge.event}
                                            </text>
                                          </Show>
                                          <Show when={edge.recorded}>
                                            {(recorded) => (
                                              <path
                                                class="lazers-radar-statechart-edge-hit"
                                                d={edge.path}
                                                role="button"
                                                tabIndex={0}
                                                aria-label={`Observed ${recorded().event} from ${recorded().from} to ${recorded().to} at ${timeLabel(recorded().recordedAt)}`}
                                                aria-pressed={
                                                  chosenTransition()?.sequence ===
                                                  recorded().sequence
                                                }
                                                onClick={() => chooseTransition(recorded())}
                                                onKeyDown={(event) => {
                                                  if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault()
                                                    chooseTransition(recorded())
                                                  }
                                                }}
                                              />
                                            )}
                                          </Show>
                                        </g>
                                      )}
                                    </For>
                                    <For each={graph().nodes}>
                                      {(stateNode) => (
                                        <g
                                          class="lazers-radar-statechart-node"
                                          data-active={stateNode.active}
                                          data-selected={chosenState()?.id === stateNode.id}
                                          role="button"
                                          tabIndex={0}
                                          aria-label={`${stateNode.id}${stateNode.active ? ", current state" : ""}${stateNode.initial ? ", initial state" : ""}${stateNode.final ? ", final state" : ""}`}
                                          aria-pressed={chosenState()?.id === stateNode.id}
                                          onClick={() => selectedStateID(stateNode.id)}
                                          onKeyDown={(event) => {
                                            if (event.key === "Enter" || event.key === " ") {
                                              event.preventDefault()
                                              selectedStateID(stateNode.id)
                                            }
                                          }}
                                        >
                                          <rect
                                            x={stateNode.x}
                                            y={stateNode.y - stateNode.height / 2}
                                            width={stateNode.width}
                                            height={stateNode.height}
                                            rx={4}
                                          />
                                          <text
                                            class="lazers-radar-statechart-name"
                                            x={stateNode.x + 10}
                                            y={stateNode.y + 4}
                                          >
                                            {stateNode.id}
                                          </text>
                                          <text
                                            class="lazers-radar-statechart-flag"
                                            x={stateNode.x + stateNode.width - 8}
                                            y={stateNode.y + 3}
                                            text-anchor="end"
                                          >
                                            {[
                                              stateNode.initial ? "Initial" : "",
                                              stateNode.final ? "Final" : "",
                                              stateNode.active ? "Current" : "",
                                            ]
                                              .filter(Boolean)
                                              .join(" · ")}
                                          </text>
                                        </g>
                                      )}
                                    </For>
                                  </svg>
                                  <details class="lazers-radar-statechart-accessible">
                                    <summary>State and transition list</summary>
                                    <ol>
                                      <For each={value().machine.states}>
                                        {(machineState) => (
                                          <li>
                                            <button
                                              type="button"
                                              aria-pressed={chosenState()?.id === machineState.id}
                                              onClick={() => selectedStateID(machineState.id)}
                                            >
                                              {machineState.id}
                                              {value().machine.initialState === machineState.id
                                                ? " · Initial"
                                                : ""}
                                              {machineState.type === "final" ? " · Final" : ""}
                                              {flowActiveState() === machineState.id
                                                ? " · Current"
                                                : ""}
                                            </button>
                                            <ul>
                                              <For each={machineState.transitions}>
                                                {(transition) => {
                                                  const recorded = observedTransition(
                                                    currentPlanTransitions(),
                                                    flowNode()!,
                                                    transition,
                                                    machineState.id,
                                                  )
                                                  return (
                                                    <li>
                                                      {transition.event} → {transition.target}
                                                      {recorded
                                                        ? " · Observed"
                                                        : " · Defined, not observed"}
                                                    </li>
                                                  )
                                                }}
                                              </For>
                                            </ul>
                                          </li>
                                        )}
                                      </For>
                                    </ol>
                                  </details>
                                </>
                              )}
                            </Show>
                          </Show>
                        </Show>
                      </Show>
                    </Show>
                  </Show>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </div>
      <div
        class="lazers-radar-separator"
        ref={(element) => {
          separator = element
        }}
        role="separator"
        aria-label="Resize visualization and details"
        aria-orientation="horizontal"
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(split())}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
          event.preventDefault()
          resize(
            event.key === "Home"
              ? 20
              : event.key === "End"
                ? 80
                : split() + (event.key === "ArrowDown" ? 2 : -2),
          )
          save({ split: split() })
        }}
      />
      <div
        class="lazers-radar-detail"
        ref={(element) => {
          detail = element
        }}
        onScroll={(event) => {
          if (detailRestore.restored(selectionKey()))
            save({
              detailScroll: event.currentTarget.scrollTop,
              detailScrollLeft: event.currentTarget.scrollLeft,
            })
        }}
      >
        <Show when={prefs().view === "map"}>
          <Show
            when={mapModel()}
            fallback={<div class="lazers-radar-note">Operational details are unavailable.</div>}
          >
            {(model) => (
              <RadarMapInspector
                model={model()}
                selectedID={prefs().selectedMapID}
                onSelect={(id) => save({ selectedMapID: id, detailScroll: 0 })}
                monoFont={ctx.appearance.font("mono")}
              />
            )}
          </Show>
        </Show>
        <Show when={prefs().view !== "map"}>
          <Show
            when={chosenTransition() || chosenAttempt() || chosenCheck() || chosenState()}
            fallback={
              <div class="lazers-radar-note">
                {missingSelection()
                  ? "The selected record is no longer available in this observation."
                  : "Select a recorded state, transition, attempt, or check."}
              </div>
            }
          >
            <Show when={chosenTransition()}>
              {(transition) => (
                <>
                  <h3>{transition().event}</h3>
                  <dl>
                    <dt>Sequence</dt>
                    <dd>{transition().sequence}</dd>
                    <dt>Recorded</dt>
                    <dd>
                      <time dateTime={timeValue(transition().recordedAt)}>
                        {timeLabel(transition().recordedAt)}
                      </time>
                    </dd>
                    <Show when={transition().from}>
                      <dt>From</dt>
                      <dd>{transition().from}</dd>
                    </Show>
                    <Show when={transition().to}>
                      <dt>To</dt>
                      <dd>{transition().to}</dd>
                    </Show>
                    <dt>Record</dt>
                    <dd>{transition().kind}</dd>
                    <Show when={transition().taskID}>
                      <dt>Task</dt>
                      <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                        {transition().taskID}
                      </dd>
                    </Show>
                    <Show when={transition().attemptID}>
                      <dt>Attempt</dt>
                      <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                        {transition().attemptID}
                      </dd>
                    </Show>
                    <Show when={transition().reason}>
                      <dt>Reason</dt>
                      <dd>{transition().reason}</dd>
                    </Show>
                  </dl>
                </>
              )}
            </Show>
            <Show when={chosenAttempt()}>
              {(attempt) => (
                <>
                  <h3>Attempt {attempt().number}</h3>
                  <dl>
                    <dt>State</dt>
                    <dd>{attempt().state}</dd>
                    <dt>Started</dt>
                    <dd>
                      <time dateTime={timeValue(attempt().startedAt)}>
                        {timeLabel(attempt().startedAt)}
                      </time>
                    </dd>
                    <dt>Ended</dt>
                    <dd>Unavailable</dd>
                    <dt>Task</dt>
                    <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                      {attempt().taskID}
                    </dd>
                  </dl>
                  <p>{attempt().timingBasis}</p>
                  <For each={attempt().executions}>
                    {(execution, index) => (
                      <details class="lazers-radar-disclosure">
                        <summary>Execution {index() + 1}</summary>
                        <dl>
                          <dt>Started</dt>
                          <dd>{timeLabel(execution.startedAt)}</dd>
                          <dt>Ended</dt>
                          <dd>{timeLabel(execution.endedAt)}</dd>
                          <dt>Start sequence</dt>
                          <dd>{execution.startSequence ?? "Unavailable"}</dd>
                          <dt>End sequence</dt>
                          <dd>{execution.endSequence ?? "Unavailable"}</dd>
                        </dl>
                        <p>{execution.timingBasis}</p>
                      </details>
                    )}
                  </For>
                </>
              )}
            </Show>
            <Show when={chosenCheck()}>
              {(check) => (
                <>
                  <h3>{check().checkID}</h3>
                  <dl>
                    <dt>State</dt>
                    <dd>{check().state}</dd>
                    <dt>Scope</dt>
                    <dd>{check().scope}</dd>
                    <dt>Started</dt>
                    <dd>
                      <time dateTime={timeValue(check().startedAt)}>
                        {timeLabel(check().startedAt)}
                      </time>
                    </dd>
                    <dt>Ended</dt>
                    <dd>
                      <time dateTime={timeValue(check().endedAt)}>
                        {timeLabel(check().endedAt)}
                      </time>
                    </dd>
                    <dt>Exit code</dt>
                    <dd>{check().exitCode ?? "Unavailable"}</dd>
                    <Show when={check().taskID}>
                      <dt>Task</dt>
                      <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                        {check().taskID}
                      </dd>
                    </Show>
                    <Show when={check().attemptID}>
                      <dt>Attempt</dt>
                      <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                        {check().attemptID}
                      </dd>
                    </Show>
                  </dl>
                  <p>{check().timingBasis}</p>
                </>
              )}
            </Show>
            <Show when={chosenState()}>
              {(machineState) => {
                const inspector = flowStateInspector(flowNode, snapshot, () => machineState().id)
                return (
                  <>
                    <h3>{machineState().id}</h3>
                    <dl>
                      <dt>Type</dt>
                      <dd>{machineState().type}</dd>
                      <dt>Initial</dt>
                      <dd>{inspector().initial}</dd>
                      <dt>Current</dt>
                      <dd>{inspector().current}</dd>
                      <Show when={inspector().matchesRecordedState}>
                        <dt>Recorded reason</dt>
                        <dd>{inspector().reason}</dd>
                      </Show>
                      <dt>Machine</dt>
                      <dd>{inspector().machine}</dd>
                      <dt>Task</dt>
                      <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                        {inspector().taskID}
                      </dd>
                    </dl>
                  </>
                )
              }}
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function emptyRadarMonitorData(key = ""): RadarMonitorData {
  return {
    key,
    loading: true,
    stale: true,
    resynchronizing: true,
    error: "",
    connection: "connecting",
    selectedSessionID: null,
    historyLoading: false,
    historyError: "",
  }
}

function RadarLiveMonitorPanel(
  props: PanelProps & { ctx: RadarContext; onOpenDiagnostics: () => void },
) {
  const ctx = props.ctx
  const frame = usePanel()
  const [stateData, setStateData] = createSignal<RadarMonitorData>(emptyRadarMonitorData())
  const state = new RadarMonitorState(setStateData)
  const location = createLatest(
    () => {
      if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
      return {
        client: props.session.server.client,
        session: props.session.id,
        server: props.session.server.id,
        directory: props.session.directory,
      }
    },
    async (source, signal) => {
      const result = await source.client.location.get(
        { location: { directory: source.directory } },
        { signal },
      )
      return { ...source, ...radarProjectIdentity(result.project) }
    },
  )
  const current = () => {
    if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
    const value = location.latest
    return value &&
      value.session === props.session.id &&
      value.server === props.session.server.id &&
      value.directory === props.session.directory &&
      !location.loading
      ? value
      : undefined
  }
  const projectKey = () => {
    const value = current()
    return value ? JSON.stringify([value.server, value.project]) : ""
  }
  const prefs = () => {
    const key = projectKey()
    if (!key) return initial
    const value = ctx.stores.radarView(props.session).value?.projects[key] ?? initialProject
    return { ...initial, ...value[value.scope], scope: value.scope }
  }
  const save = (change: Partial<typeof initial>) => {
    const key = projectKey()
    if (!key) return
    const store = ctx.stores.radarView(props.session)
    store.update((draft) => {
      const value = draft.projects[key] ?? initialProject
      const scope = change.scope ?? value.scope
      const nextView = { ...value[scope], ...change, scope }
      draft.projects[key] =
        scope === "session"
          ? { ...value, scope, session: nextView }
          : { ...value, scope, project: nextView }
    })
  }
  onCleanup(() => state.close())

  createKeyed(
    () => {
      const value = current()
      if (!value || !frame.visible() || !ctx.stores.radarView(props.session).ready())
        return undefined
      const view = prefs()
      const key = JSON.stringify([
        value.server,
        value.project,
        value.session,
        view.scope,
        view.includeUnmanagedSessions,
      ])
      return { value, key, view }
    },
    ({ value, key, view }) => {
      const observationScope: ObservationScope = { kind: view.scope, sessionID: value.session }
      const transport = createRadarMonitorTransport(
        () => props.session.server.client.rpc(Observability),
        value.directory,
        () => props.session.server.connected,
        value.projectID,
      )
      state.connect(
        key,
        value.projectID,
        observationScope,
        transport,
        view.includeUnmanagedSessions,
      )
      onCleanup(() => state.close())
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => state.close(),
    },
  )

  const expectedKey = () => {
    const value = current()
    return value
      ? JSON.stringify([
          value.server,
          value.project,
          value.session,
          prefs().scope,
          prefs().includeUnmanagedSessions,
        ])
      : ""
  }
  const visibleData = () => {
    const data = stateData()
    return data.key === expectedKey() ? data : emptyRadarMonitorData(expectedKey())
  }
  const scope = (): ObservationScope => ({ kind: prefs().scope, sessionID: props.session.id })

  return (
    <Show
      when={current()}
      fallback={
        <div class="lazers-radar lazers-radar-monitor">
          <div class="lazers-radar-note" role={location.error ? "alert" : "status"}>
            {location.error
              ? `Project identity is unavailable. ${radarErrorMessage(location.error)}`
              : "Resolving the authorized project location…"}
          </div>
        </div>
      }
    >
      <RadarMonitorView
        data={visibleData}
        scope={scope()}
        anchorSessionID={props.session.id}
        includeUnmanagedSessions={prefs().includeUnmanagedSessions}
        monoFont={ctx.appearance.font("mono")}
        onScopeChange={(next) => save({ scope: next })}
        onIncludeUnmanagedSessionsChange={(include) => save({ includeUnmanagedSessions: include })}
        onSelectSession={(sessionID) => state.selectSession(sessionID)}
        onRefresh={() => state.refreshNow()}
        onLoadMoreHistory={() => state.loadMoreHistory()}
        onOpenDiagnostics={props.onOpenDiagnostics}
      />
    </Show>
  )
}

function RadarPanel(props: PanelProps & { ctx: RadarContext }) {
  const [diagnosticsOpen, setDiagnosticsOpen] = createSignal(false)
  return (
    <Show
      when={diagnosticsOpen()}
      fallback={
        <RadarLiveMonitorPanel {...props} onOpenDiagnostics={() => setDiagnosticsOpen(true)} />
      }
    >
      <RadarDiagnosticsPanel {...props} onBack={() => setDiagnosticsOpen(false)} />
    </Show>
  )
}

export function setupRadarPanel(ctx: RadarContext) {
  const Ui = ctx.ui
  registerRadarPanel(
    ctx,
    bindPlugin((props: PanelProps) => <RadarPanel {...props} ctx={ctx} />),
    () => (
      <div class="flex min-w-0 items-center gap-1.5">
        <Ui.Icon name="eye" size="small" class="shrink-0" />
        <span class="truncate">Radar</span>
      </div>
    ),
  )
}

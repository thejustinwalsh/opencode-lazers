import { Store, bindPlugin, createLatest, createKeyed, usePanel } from "@opencode/plugin/gui"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { Observability } from "../observability/contract.ts"
import {
  activeState,
  machineSupported,
  observedTransition,
  planTransitions,
  selectedNode,
  selectedPlan,
  transitionForSequence,
} from "./projection.ts"
import { clampSplit, splitFromPointer } from "./layout.ts"
import { flowStateInspector, ScrollRestoration } from "./presentation.ts"
import { RadarPanelState } from "./state.ts"
import type { RadarPanelData } from "./state.ts"
import { createRadarTransport } from "./transport.ts"
import { statechartLayout } from "./statechart.ts"
import type { ObservationScope } from "../observability/contract.ts"
import { registerRadarPanel } from "./registration.ts"
import { radarLocationGuard, resolveRadarProject } from "./project.ts"
import { RadarMonitorState } from "./monitor-state.ts"
import type { RadarMonitorData } from "./monitor-state.ts"
import { createRadarMonitorTransport } from "./monitor-transport.ts"
import { RadarMonitorView, clampMonitorSplit, MONITOR_SPLIT } from "./monitor-view.tsx"
import type { MonitorScopeChoice } from "./monitor-view.tsx"
import { panelErrorMessage } from "../panel-error.ts"
import { createPanelStatus, PanelStatus } from "../panel-status.tsx"
import { RadarHeader } from "./radar-header.tsx"
import type { RadarScopeChoice, RadarViewChoice } from "./radar-header.tsx"
import { connectionChip } from "./monitor-model.ts"

const View = Schema.Struct({
  scope: Schema.Literals(["session", "project"]),
  // "timeline" is a retired diagnostics view; stored values still decode and read as "map".
  view: Schema.Literals(["map", "flow", "timeline", "lifecycle"]),
  includeUnmanagedSessions: Schema.Boolean,
  planID: Schema.NullOr(Schema.String),
  taskID: Schema.NullOr(Schema.String),
  selectedMapID: Schema.NullOr(Schema.String),
  selectedTransition: Schema.NullOr(Schema.Number),
  selectedState: Schema.NullOr(Schema.String),
  split: Schema.Number,
  visualScroll: Schema.Number,
  visualScrollLeft: Schema.optionalKey(Schema.Number),
  detailScroll: Schema.Number,
  detailScrollLeft: Schema.optionalKey(Schema.Number),
  monitorSplit: Schema.optionalKey(Schema.Number),
  monitorSessionID: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
  split: 55,
  visualScroll: 0,
  visualScrollLeft: 0,
  detailScroll: 0,
  detailScrollLeft: 0,
  monitorSplit: MONITOR_SPLIT.initial,
  monitorSessionID: null,
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
  radarView: Store.session(
    Schema.Struct({
      projects: Schema.Record(Schema.String, ProjectView),
      diagnostics: Schema.Boolean,
    }),
    { projects: {}, diagnostics: false },
  ),
}
export type RadarContext = SetupContext<{ stores: typeof radarStores }>

function timeLabel(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString()
}

function timeValue(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

type RadarLocation = ReturnType<typeof createRadarLocation>

/** Resolved once for the whole panel, so switching views does not re-resolve the project. */
function createRadarLocation(props: PanelProps) {
  const frame = usePanel()
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
      // Path identity from the global project list: location.get boots an unloaded location.
      return { ...source, ...(await resolveRadarProject(source.client, source.directory, signal)) }
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
  return { location, current }
}

function RadarDiagnosticsPanel(
  props: PanelProps & {
    ctx: RadarContext
    radarLocation: RadarLocation
    /** Back to the Flow overview; this panel is the task lifecycle diagram. */
    onBack: () => void
    onView: (view: RadarViewChoice) => void
  },
) {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()
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

  const { location, current } = props.radarLocation
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
      view: "flow" as const,
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
        undefined,
        radarLocationGuard(value.client, value.directory, () => props.session.directory),
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
  const chosenTransition = () => {
    const currentSnapshot = snapshot()
    const currentPlan = plan()
    const stored = prefs().selectedTransition
    if (!currentSnapshot || !currentPlan) return undefined
    if (stored !== null) {
      const found = transitionForSequence(currentSnapshot, stored)
      return found?.planID === currentPlan.id ? found : undefined
    }
    if (prefs().selectedState) return undefined
    return undefined
  }
  const chosenState = () => {
    const currentSnapshot = snapshot()
    const currentNode = node()
    if (!currentSnapshot || !currentNode || prefs().selectedTransition !== null) return undefined
    const stateID = prefs().selectedState ?? activeState(currentNode, currentSnapshot)
    return stateID
      ? currentSnapshot.machine.states.find((state) => state.id === stateID)
      : undefined
  }
  const missingSelection = () =>
    (prefs().selectedTransition !== null && !chosenTransition()) ||
    (prefs().selectedState !== null && !chosenState())
  const selectionKey = () =>
    JSON.stringify([
      expectedKey(),
      plan()?.id,
      node()?.taskID,
      chosenTransition()?.sequence,
      chosenState()?.id,
      prefs().view,
      prefs().selectedMapID,
    ])
  const selectedStateID = (stateID: string) =>
    save({
      selectedTransition: null,
      selectedState: stateID,
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
      detailScroll: 0,
    })
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
  const scopeChoice = (): RadarScopeChoice =>
    prefs().scope === "session"
      ? "session"
      : prefs().includeUnmanagedSessions
        ? "project-all"
        : "project"
  const changeScope = (choice: RadarScopeChoice) =>
    save(
      choice === "session"
        ? { scope: "session" }
        : { scope: "project", includeUnmanagedSessions: choice === "project-all" },
    )
  const asOf = () => {
    const observed = snapshot()?.observedAt ?? radar()?.observedAt
    const time = observed === undefined ? Number.NaN : Date.parse(observed)
    return Number.isFinite(time) ? time : undefined
  }
  const failure = () =>
    visible()?.error || (location.error ? panelErrorMessage(location.error) : "")
  const status = createPanelStatus(() => ({
    subject: "Radar",
    hasContent: Boolean(radar() || snapshot()),
    loading: !location.error && (visible()?.loading ?? true),
    disconnected: !props.session.server.connected,
    ...(failure() ? { error: failure() } : {}),
    ...(asOf() !== undefined ? { asOf: asOf()! } : {}),
  }))
  const connection = () =>
    connectionChip(
      !props.session.server.connected || (failure() && !radar() && !snapshot())
        ? "offline"
        : stale()
          ? "reconnecting"
          : "live",
      asOf(),
    )
  /** The inspector and its separator exist only while something is selected. */
  const hasDetail = () => Boolean(chosenTransition() || chosenState() || missingSelection())
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
      data-inspector={hasDetail()}
      ref={(element) => {
        root = element
      }}
      style={{
        "--radar-visual-fr": `${split()}fr`,
        "--radar-detail-fr": `${100 - split()}fr`,
      }}
    >
      <RadarHeader
        ui={Ui}
        view="flow"
        onView={props.onView}
        scope={scopeChoice()}
        onScope={changeScope}
        connection={connection()}
        onRefresh={() => state.refreshNow()}
        ref={(element) => {
          header = element
        }}
      />
      <div
        class="lazers-radar-visual"
        data-panel-dimmed={status.dimmed()}
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
        <button type="button" class="lazers-radar-text-button" onClick={props.onBack}>
          Back to Flow
        </button>
        <PanelStatus ui={Ui} status={status} onRetry={() => state.refreshNow()} skeleton="chart" />
        <Show when={prefs().view !== "map" && snapshot()}>
          {(value) => (
            <Show when={value().plans.length > 0}>
              <div class="lazers-radar-pickers">
                <span class="lazers-radar-picker">
                  <Ui.Menu
                    label={plan()?.title ?? plan()?.id.slice(0, 8) ?? "Select plan"}
                    trigger="button"
                    items={value().plans.map((item) => ({
                      label: item.title ?? item.id,
                      onSelect: () =>
                        save({
                          planID: item.id,
                          taskID: null,
                          selectedTransition: null,
                          selectedState: null,
                          visualScroll: 0,
                          detailScroll: 0,
                        }),
                    }))}
                  />
                </span>
                <Show when={(plan()?.nodes.length ?? 0) > 1}>
                  <span class="lazers-radar-picker">
                    <Ui.Menu
                      label={
                        node() ? `${node()!.state} · ${node()!.taskID.slice(0, 8)}` : "Select task"
                      }
                      trigger="button"
                      items={(plan()?.nodes ?? []).map((item) => ({
                        label: `${item.state} · ${item.taskID.slice(0, 8)}`,
                        onSelect: () =>
                          save({
                            taskID: item.taskID,
                            selectedTransition: null,
                            selectedState: null,
                            visualScroll: 0,
                            detailScroll: 0,
                          }),
                      }))}
                    />
                  </span>
                </Show>
              </div>
            </Show>
          )}
        </Show>
        <Show when={prefs().view !== "map"}>
          <Show
            when={snapshot()}
            fallback={
              <Show when={status.view().kind === "ready"}>
                <div class="lazers-radar-note">No observation is available.</div>
              </Show>
            }
          >
            {(value) => (
              <>
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
                                            chosenTransition()?.sequence === edge.recorded.sequence
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
                                                chosenTransition()?.sequence === recorded().sequence
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
              </>
            )}
          </Show>
        </Show>
      </div>
      <Show when={hasDetail()}>
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
          <Show when={prefs().view !== "map"}>
            <Show
              when={chosenTransition() || chosenState()}
              fallback={
                <div class="lazers-radar-note">
                  The selected record is no longer available in this observation.
                </div>
              }
            >
              <Show when={chosenTransition()}>
                {(transition) => (
                  <>
                    <h3>{transition().event}</h3>
                    <p class="lazers-radar-facts-line">
                      <Show when={transition().from || transition().to}>
                        <span>
                          {transition().from ?? ""} → {transition().to ?? ""}
                        </span>
                      </Show>
                      <Show when={timeLabel(transition().recordedAt)}>
                        <span>
                          <em>recorded</em>{" "}
                          <time dateTime={timeValue(transition().recordedAt)}>
                            {timeLabel(transition().recordedAt)}
                          </time>
                        </span>
                      </Show>
                      <span>{transition().kind}</span>
                    </p>
                    <Show when={transition().reason}>
                      <p>{transition().reason}</p>
                    </Show>
                    <details class="lazers-radar-disclosure lazers-radar-identifiers">
                      <summary>Identifiers</summary>
                      <dl>
                        <dt>Sequence</dt>
                        <dd>{transition().sequence}</dd>
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
                      </dl>
                    </details>
                  </>
                )}
              </Show>
              <Show when={chosenState()}>
                {(machineState) => {
                  const inspector = flowStateInspector(flowNode, snapshot, () => machineState().id)
                  return (
                    <>
                      <h3>{machineState().id}</h3>
                      <p class="lazers-radar-facts-line">
                        <span>{machineState().type}</span>
                        <Show when={inspector().initial === "Yes"}>
                          <span>initial</span>
                        </Show>
                        <Show when={inspector().current === "Yes"}>
                          <span>current</span>
                        </Show>
                        <Show
                          when={
                            inspector().current &&
                            inspector().current !== "Yes" &&
                            inspector().current !== "No"
                          }
                        >
                          <span>{inspector().current}</span>
                        </Show>
                        <Show when={inspector().machine}>
                          <span>{inspector().machine}</span>
                        </Show>
                      </p>
                      <Show when={inspector().matchesRecordedState && inspector().reason}>
                        <p>{inspector().reason}</p>
                      </Show>
                      <Show when={inspector().taskID}>
                        <details class="lazers-radar-disclosure lazers-radar-identifiers">
                          <summary>Identifiers</summary>
                          <dl>
                            <dt>Task</dt>
                            <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                              {inspector().taskID}
                            </dd>
                          </dl>
                        </details>
                      </Show>
                    </>
                  )
                }}
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
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

/** Host navigation the Radar inspector can offer; each target is optional. */
export type RadarNavigation = {
  openTask?: (
    session: PanelProps["session"],
    target: { taskID: string; projectID: string; projectDirectory: string },
  ) => void
  openTrajectory?: (
    session: PanelProps["session"],
    target: { taskID: string; reference: string; projectID: string; projectDirectory: string },
  ) => void
}

function RadarLiveMonitorPanel(
  props: PanelProps & {
    ctx: RadarContext
    radarLocation: RadarLocation
    navigation: RadarNavigation
    view: "monitor" | "map" | "flow"
    onView: (view: RadarViewChoice | "lifecycle") => void
  },
) {
  const ctx = props.ctx
  const frame = usePanel()
  const [stateData, setStateData] = createSignal<RadarMonitorData>(emptyRadarMonitorData())
  const [dragSplit, setDragSplit] = createSignal<number | null>(null)
  const state = new RadarMonitorState(setStateData)
  const { location, current } = props.radarLocation
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
        radarLocationGuard(value.client, value.directory, () => props.session.directory),
      )
      state.connect(
        key,
        value.projectID,
        observationScope,
        transport,
        view.includeUnmanagedSessions,
        view.monitorSessionID ?? null,
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
  const split = () =>
    dragSplit() ?? clampMonitorSplit(prefs().monitorSplit ?? MONITOR_SPLIT.initial)
  const changeScope = (choice: MonitorScopeChoice) =>
    save(
      choice === "session"
        ? { scope: "session" }
        : { scope: "project", includeUnmanagedSessions: choice === "project-all" },
    )
  const locationStatus = createPanelStatus(() => ({
    subject: "live activity",
    hasContent: false,
    loading: !location.error,
    ...(location.error ? { error: panelErrorMessage(location.error) } : {}),
  }))
  const openTasks = () => ctx.layout.open(`${ctx.id}:tasks`, props.session, { tab: "select" })
  const taskTarget = (taskID: string) => {
    const value = current()
    return value
      ? { taskID, projectID: value.projectID, projectDirectory: value.project }
      : undefined
  }

  return (
    <Show
      when={current()}
      fallback={
        <div class="lazers-radar lazers-radar-monitor" data-inspector="false">
          <RadarHeader
            ui={ctx.ui}
            view={props.view}
            onView={props.onView}
            scope={prefs().scope === "session" ? "session" : "project"}
            onScope={changeScope}
            connection={connectionChip(location.error ? "offline" : "reconnecting")}
            onRefresh={() => {}}
          />
          <div class="lazers-radar-top">
            <PanelStatus ui={ctx.ui} status={locationStatus} skeleton="rows" />
          </div>
        </div>
      }
    >
      <RadarMonitorView
        ui={ctx.ui}
        data={visibleData}
        view={props.view}
        scope={scope()}
        anchorSessionID={props.session.id}
        includeUnmanagedSessions={prefs().includeUnmanagedSessions}
        monoFont={ctx.appearance.font("mono")}
        split={split()}
        onSplitChange={(value, commit) => {
          setDragSplit(commit ? null : value)
          if (commit) save({ monitorSplit: value })
        }}
        onScopeChange={changeScope}
        onSelectSession={(sessionID) => {
          state.selectSession(sessionID)
          save({ monitorSessionID: sessionID })
        }}
        onRefresh={() => state.refreshNow()}
        onLoadMoreHistory={() => state.loadMoreHistory()}
        onView={props.onView}
        onOpenLifecycle={() => props.onView("lifecycle")}
        onOpenTasks={openTasks}
        onOpenWorker={(sessionID) =>
          ctx.tabs.open({ server: props.session.server.id, id: sessionID }, { focus: true })
        }
        onOpenTask={
          props.navigation.openTask
            ? (taskID) => {
                const target = taskTarget(taskID)
                if (target) props.navigation.openTask!(props.session, target)
              }
            : undefined
        }
        onOpenTrajectory={
          props.navigation.openTrajectory
            ? (taskID, reference) => {
                const target = taskTarget(taskID)
                if (target)
                  props.navigation.openTrajectory!(props.session, {
                    ...target,
                    reference: reference ?? `Task ${taskID.slice(0, 8)}`,
                  })
              }
            : undefined
        }
      />
    </Show>
  )
}

function RadarPanel(props: PanelProps & { ctx: RadarContext; navigation: RadarNavigation }) {
  const store = () => props.ctx.stores.radarView(props.session)
  const radarLocation = createRadarLocation(props)
  const projectKey = () => {
    const value = radarLocation.current()
    return value ? JSON.stringify([value.server, value.project]) : ""
  }
  const savedView = () => {
    const key = projectKey()
    const value = (key ? store().value?.projects[key] : undefined) ?? initialProject
    return value[value.scope].view
  }
  /** Monitor, Map and Flow: one switch. Monitor and Map share the live panel; Flow keeps its own. */
  const view = (): RadarViewChoice | "lifecycle" =>
    store().value?.diagnostics !== true
      ? "monitor"
      : savedView() === "lifecycle"
        ? "lifecycle"
        : savedView() === "flow"
          ? "flow"
          : "map"
  const changeView = (next: RadarViewChoice | "lifecycle") => {
    const key = projectKey()
    store().update((draft) => {
      draft.diagnostics = next !== "monitor"
      if (next === "monitor" || !key) return
      const value = draft.projects[key] ?? initialProject
      const scope = value.scope
      const changed = { ...value[scope], view: next }
      draft.projects[key] =
        scope === "session" ? { ...value, session: changed } : { ...value, project: changed }
    })
  }
  return (
    <Show
      when={view() === "lifecycle"}
      fallback={
        <RadarLiveMonitorPanel
          {...props}
          radarLocation={radarLocation}
          navigation={props.navigation}
          view={view() as "monitor" | "map" | "flow"}
          onView={changeView}
        />
      }
    >
      <RadarDiagnosticsPanel
        {...props}
        radarLocation={radarLocation}
        onBack={() => changeView("flow")}
        onView={changeView}
      />
    </Show>
  )
}

export function setupRadarPanel(ctx: RadarContext, navigation: RadarNavigation = {}) {
  const Ui = ctx.ui
  registerRadarPanel(
    ctx,
    bindPlugin((props: PanelProps) => <RadarPanel {...props} ctx={ctx} navigation={navigation} />),
    () => (
      <div class="flex min-w-0 items-center gap-1.5">
        <Ui.Icon name="eye" size="small" class="shrink-0" />
        <span class="truncate">Radar</span>
      </div>
    ),
  )
}

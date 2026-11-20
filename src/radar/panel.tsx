import { Store, bindPlugin, createLatest, createKeyed, usePanel } from "@opencode/plugin/gui"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { Observability } from "../observability/contract.ts"
import { Streams } from "../streams/contract.ts"
import { rpcStreamsTransport, type StreamsRpc } from "../streams/gui.ts"
import type { HistorySource } from "./history-list.tsx"
import {
  activeState,
  machineSupported,
  observedTransition,
  planTransitions,
  selectedNode,
  selectedPlan,
  transitionForSequence,
} from "./projection.ts"
import { DetailsPane } from "../details-pane.tsx"
import { detailsChange, storedDetails } from "./details-state.ts"
import { flowStateInspector } from "./presentation.ts"
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
import { RadarMonitorView } from "./monitor-view.tsx"
import type { MonitorScopeChoice } from "./monitor-view.tsx"
import { panelErrorMessage } from "../panel-error.ts"
import { createPanelStatus, PanelStatus } from "../panel-status.tsx"
import { RadarHeader } from "./radar-header.tsx"
import type { RadarScopeChoice, RadarViewChoice } from "./radar-header.tsx"
import { connectionChip } from "./monitor-model.ts"
import { Callout, Disclosure, Identifiers, StatRow } from "../details/index.ts"
import { humanize, transitionName, translateRuntimeWords } from "../trajectory-panel/event-names.ts"

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
  /** Legacy: the old divider position, converted to a details size when first read. */
  split: Schema.optionalKey(Schema.Number),
  visualScroll: Schema.Number,
  visualScrollLeft: Schema.optionalKey(Schema.Number),
  detailScroll: Schema.Number,
  detailScrollLeft: Schema.optionalKey(Schema.Number),
  monitorSplit: Schema.optionalKey(Schema.Number),
  /** The details pane per view: closed by default; size is the body's share of the pane. */
  details: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        open: Schema.optionalKey(Schema.Boolean),
        size: Schema.optionalKey(Schema.Number),
      }),
    ),
  ),
  /** Idle sessions are hidden unless this is true. */
  showIdle: Schema.optionalKey(Schema.Boolean),
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
  visualScroll: 0,
  visualScrollLeft: 0,
  detailScroll: 0,
  detailScrollLeft: 0,
  showIdle: false,
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

type RadarLocation = ReturnType<typeof createRadarLocation>

type RadarLocationCurrent = RadarLocation["current"]

function radarProjectKey(current: RadarLocationCurrent) {
  return () => {
    const value = current()
    return value ? JSON.stringify([value.server, value.project]) : ""
  }
}

function saveRadarView(
  ctx: RadarContext,
  session: PanelProps["session"],
  key: string,
  change: Partial<typeof initial>,
) {
  if (!key) return
  const store = ctx.stores.radarView(session)
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

function radarKeyedSource<View extends { scope: string; includeUnmanagedSessions: boolean }>(
  current: RadarLocationCurrent,
  isActive: () => boolean,
  prefs: () => View,
) {
  return () => {
    const value = current()
    if (!value || !isActive()) return undefined
    const view = prefs()
    const key = JSON.stringify([
      value.server,
      value.project,
      value.session,
      view.scope,
      view.includeUnmanagedSessions,
    ])
    return { value, key, view }
  }
}

function radarExpectedKey(
  current: RadarLocationCurrent,
  prefs: () => { scope: string; includeUnmanagedSessions: boolean },
) {
  return () => {
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
}

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
  const state = new RadarPanelState(setData)

  const { location, current } = props.radarLocation
  const projectKey = radarProjectKey(current)
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
  const save = (change: Partial<typeof initial>) =>
    saveRadarView(ctx, props.session, projectKey(), change)
  onCleanup(() => {
    state.close()
  })

  createKeyed(
    radarKeyedSource(
      current,
      () => frame.visible() && ctx.stores.radarView(props.session).ready(),
      prefs,
    ),
    ({ value, key, view }) => {
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

  const expectedKey = radarExpectedKey(current, prefs)
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
  const selectedStateID = (stateID: string) =>
    save({
      ...detailsChange(prefs(), "lifecycle", { open: true }),
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
      ...detailsChange(prefs(), "lifecycle", { open: true }),
      ...(taskID ? { taskID } : {}),
      selectedTransition: transition.sequence,
      selectedState: null,
      detailScroll: 0,
    })
  }
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
  const details = () => storedDetails(prefs(), "lifecycle")
  const saveDetails = (change: { open?: boolean; size?: number }) =>
    save(detailsChange(prefs(), "lifecycle", change))
  /** The selected state or transition, on one line; also the collapsed pane. */
  const detailsHeader = () => {
    const transition = chosenTransition()
    if (transition) return <strong>{transitionName(transition.event)}</strong>
    const machineState = chosenState()
    return machineState ? <strong>{humanize(machineState.id)}</strong> : undefined
  }
  const currentPlanTransitions = () => transitions()
  const flowNode = () => node()
  /** The one note about the persisted snapshot: missing, or disagreeing with the task's state. */
  const snapshotNote = () => {
    const value = flowNode()
    if (!value) return undefined
    if (!value.snapshotMatchesState)
      return "The saved machine snapshot disagrees with the task's recorded state, so no current state is highlighted."
    if (value.snapshot === null) return "The saved machine snapshot is unavailable."
    return undefined
  }
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
  return (
    <div
      class="lazers-radar lazers-radar-flowpanel"
      data-view="flow"
      data-connection={connection().state}
    >
      <RadarHeader
        ui={Ui}
        view="flow"
        onView={props.onView}
        scope={scopeChoice()}
        onScope={changeScope}
        connection={connection()}
        onRefresh={() => state.refreshNow()}
      />
      <DetailsPane
        ui={Ui}
        class="lazers-radar-pane"
        bodyClass="lazers-radar-detail"
        open={details().open}
        size={details().size}
        onOpen={(open) => saveDetails({ open })}
        onSize={(size) => saveDetails({ size })}
        header={detailsHeader()}
        empty="No state selected"
        dimmed={status.dimmed()}
        label="Resize Radar details"
        top={
          <div class="lazers-radar-visual" data-panel-dimmed={status.dimmed()}>
            <button type="button" class="lazers-radar-text-button" onClick={props.onBack}>
              Back to Flow
            </button>
            <PanelStatus
              ui={Ui}
              status={status}
              onRetry={() => state.refreshNow()}
              skeleton="chart"
            />
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
                            node()
                              ? `${node()!.state} · ${node()!.taskID.slice(0, 8)}`
                              : "Select task"
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
                              <Show when={snapshotNote()}>
                                {(note) => (
                                  <Callout
                                    class="lazers-radar-callout"
                                    iconTone="warning"
                                    icon={<Ui.Icon name="circle-exclamation" size="small" />}
                                    text={note()}
                                  />
                                )}
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
                                                    if (
                                                      event.key === "Enter" ||
                                                      event.key === " "
                                                    ) {
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
        }
      >
        <Show
          when={chosenTransition() || chosenState() || missingSelection()}
          fallback={
            <p class="lazers-radar-note">Select a state or a recorded transition in the diagram.</p>
          }
        >
          <>
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
                      <StatRow
                        stats={[
                          {
                            label: "From",
                            value: transition().from ? humanize(transition().from!) : undefined,
                          },
                          {
                            label: "To",
                            value: transition().to ? humanize(transition().to!) : undefined,
                          },
                          {
                            label: "Recorded",
                            value: timeLabel(transition().recordedAt) || undefined,
                          },
                          {
                            label: "Kind",
                            value: transition().kind ? humanize(transition().kind) : undefined,
                          },
                        ]}
                      />
                      <Show when={transition().reason}>
                        {(reason) => <p>{translateRuntimeWords(reason())}</p>}
                      </Show>
                      <Disclosure label="Identifiers">
                        <Identifiers
                          items={[
                            { label: "Event", value: transition().event },
                            { label: "Sequence", value: String(transition().sequence) },
                            { label: "Task", value: transition().taskID ?? undefined },
                            { label: "Attempt", value: transition().attemptID ?? undefined },
                          ]}
                        />
                      </Disclosure>
                    </>
                  )}
                </Show>
                <Show when={chosenState()}>
                  {(machineState) => {
                    const inspector = flowStateInspector(
                      flowNode,
                      snapshot,
                      () => machineState().id,
                    )
                    return (
                      <>
                        <StatRow
                          stats={[
                            { label: "Type", value: humanize(machineState().type) },
                            { label: "Machine", value: inspector().machine },
                            ...(inspector().current === "Yes"
                              ? [
                                  {
                                    label: "Status",
                                    note: { text: "current", tone: "interactive" as const },
                                  },
                                ]
                              : inspector().initial === "Yes"
                                ? [
                                    {
                                      label: "Status",
                                      note: { text: "initial", tone: "neutral" as const },
                                    },
                                  ]
                                : []),
                          ]}
                        />
                        <Show when={inspector().matchesRecordedState && inspector().reason}>
                          {(reason) => <p>{translateRuntimeWords(reason())}</p>}
                        </Show>
                        <Disclosure label="Identifiers">
                          <Identifiers
                            items={[
                              { label: "State", value: machineState().id },
                              { label: "Task", value: inspector().taskID },
                            ]}
                          />
                        </Disclosure>
                      </>
                    )
                  }}
                </Show>
              </Show>
            </Show>
          </>
        </Show>
      </DetailsPane>
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
  const state = new RadarMonitorState(setStateData)
  const { location, current } = props.radarLocation
  const projectKey = radarProjectKey(current)
  const prefs = () => {
    const key = projectKey()
    if (!key) return initial
    const value = ctx.stores.radarView(props.session).value?.projects[key] ?? initialProject
    return { ...initial, ...value[value.scope], scope: value.scope }
  }
  const save = (change: Partial<typeof initial>) =>
    saveRadarView(ctx, props.session, projectKey(), change)
  onCleanup(() => state.close())

  let transportRef: ReturnType<typeof createRadarMonitorTransport> | undefined
  // The selected worker's older calls are a stream of the project's service, one per viewed location.
  const [historySource, setHistorySource] = createSignal<HistorySource>()
  createKeyed(
    radarKeyedSource(
      current,
      () => frame.visible() && ctx.stores.radarView(props.session).ready(),
      prefs,
    ),
    ({ value, key, view }) => {
      const observationScope: ObservationScope = { kind: view.scope, sessionID: value.session }
      const transport = createRadarMonitorTransport(
        () => props.session.server.client.rpc(Observability),
        value.directory,
        () => props.session.server.connected,
        value.projectID,
        radarLocationGuard(value.client, value.directory, () => props.session.directory),
      )
      transportRef = transport
      const streams = new AbortController()
      setHistorySource({
        transport: rpcStreamsTransport(
          () => props.session.server.client.rpc(Streams) as unknown as StreamsRpc,
          streams.signal,
          {
            location: { directory: value.directory },
            ready: radarLocationGuard(value.client, value.directory, () => props.session.directory),
          },
        ),
        projectDirectory: value.directory,
      })
      onCleanup(() => {
        streams.abort()
        setHistorySource(undefined)
      })
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

  const expectedKey = radarExpectedKey(current, prefs)
  const visibleData = () => {
    const data = stateData()
    return data.key === expectedKey() ? data : emptyRadarMonitorData(expectedKey())
  }
  const scope = (): ObservationScope => ({ kind: prefs().scope, sessionID: props.session.id })
  const details = () => storedDetails(prefs(), props.view)
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
        details={details()}
        onDetailsChange={(change) => save(detailsChange(prefs(), props.view, change))}
        onScopeChange={changeScope}
        onSelectSession={(sessionID) => {
          state.selectSession(sessionID)
          save({ monitorSessionID: sessionID })
        }}
        onRefresh={() => state.refreshNow()}
        history={historySource()}
        readAttempt={(sessionID, signal) => transportRef!.liveAttempt!(scope(), sessionID, signal)}
        readGroup={(group, signal) => transportRef!.liveGroup!(scope(), group, signal)}
        showIdle={prefs().showIdle === true}
        onShowIdleChange={(showIdle) => save({ showIdle })}
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

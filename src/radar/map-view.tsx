import type { JSX } from "solid-js"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { RadarResponse } from "../observability/contract.ts"
import type { RadarLayoutResult } from "./layout-ipc.ts"
import { createStableRadarLayout } from "./layout-state.ts"
import type { RadarLayoutClient } from "./layout-state.ts"
import { edgeLabel, measureRadarMap } from "./map-layout.ts"
import type { RadarMapEdge, RadarMapModel, RadarMapNode, RadarMapNodeRecord } from "./map-model.ts"
import { defaultTextMeasure } from "./map-layout.ts"
import {
  createRadarOverview,
  radarOverviewConnectionForID,
  radarOverviewConnectionIDs,
  radarSessionModelContext,
} from "./map-overview.ts"
import type { RadarOverview } from "./map-overview.ts"
import { RadarPulseTracker } from "./pulse.ts"
import type { RadarPulse } from "./pulse.ts"

type RadarMapViewProps = {
  model: RadarMapModel
  scopeKey: string
  resynchronizing: boolean
  selectedID: string | null
  currentSessionID: string
  onSelect(id: string): void
  onLayoutReady?(scopeKey: string): void
  layout: RadarLayoutClient
  monoFont: string
}

type RadarMapInspectorProps = {
  model: RadarMapModel
  selectedID: string | null
  onSelect(id: string): void
  monoFont: string
}

type SvgBox = RadarLayoutResult["nodes"][number]
function mapBox<T extends { id: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.id, item]))
}

function recordKind<K extends RadarMapNodeRecord["kind"]>(
  node: RadarMapNode,
  kind: K,
): Extract<RadarMapNodeRecord, { kind: K }> | undefined {
  return node.record.kind === kind
    ? (node.record as Extract<RadarMapNodeRecord, { kind: K }>)
    : undefined
}

type RadarEvidence = RadarResponse["edges"][number]["evidence"][number]

function evidenceKind<K extends RadarEvidence["source"]>(
  evidence: RadarEvidence,
  kind: K,
): Extract<RadarEvidence, { source: K }> | undefined {
  return evidence.source === kind ? (evidence as Extract<RadarEvidence, { source: K }>) : undefined
}

function mapStatus(node: RadarMapNode) {
  const value = node.record.kind === "session" ? node.record.value.state : node.status.toLowerCase()
  if (value.includes("busy")) return "busy"
  if (value.includes("idle")) return "idle"
  if (value.includes("unknown") || value.includes("unavailable")) return "unknown"
  if (value.includes("failed") || value.includes("cancelled")) return "critical"
  if (value.includes("accepted") || value.includes("complete") || value.includes("consumed"))
    return "success"
  return "neutral"
}

function keyDown(event: KeyboardEvent, choose: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return
  event.preventDefault()
  choose()
}

function liveTime(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString()
}

function objectRelated(model: RadarMapModel, id: string) {
  return model.nodeByID.has(id) || model.edgeByID.has(id)
}

function RelatedLinks(props: {
  ids: readonly string[]
  model: RadarMapModel
  onSelect(id: string): void
}) {
  const targets = () => [...new Set(props.ids)].filter((id) => objectRelated(props.model, id))
  return (
    <Show when={targets().length > 0}>
      <h4 class="lazers-radar-map-related-heading">Related map records</h4>
      <ul class="lazers-radar-map-related">
        <For each={targets()}>
          {(id) => {
            const node = () => props.model.nodeByID.get(id)
            const edge = () => props.model.edgeByID.get(id)
            return (
              <li>
                <button type="button" onClick={() => props.onSelect(id)}>
                  {node()
                    ? `${node()!.kind}: ${node()!.label}`
                    : `${edgeLabel(edge()!.kind)} relationship`}
                </button>
              </li>
            )
          }}
        </For>
      </ul>
    </Show>
  )
}

const present = (value: unknown) => value !== null && value !== undefined && value !== ""

/** One label-value row; a missing fact removes the row. */
function Row(props: { label: string; value: unknown; mono?: string }) {
  return (
    <Show when={present(props.value)}>
      <dt>{props.label}</dt>
      <dd
        class={props.mono ? "lazers-radar-code" : undefined}
        style={props.mono ? { "font-family": props.mono } : undefined}
      >
        {String(props.value)}
      </dd>
    </Show>
  )
}

/** Raw identifiers stay available, one disclosure away. */
function Identifiers(props: { children: JSX.Element }) {
  return (
    <details class="lazers-radar-disclosure lazers-radar-identifiers">
      <summary>Identifiers</summary>
      <dl>{props.children}</dl>
    </details>
  )
}

const joined = (values: readonly string[]) => values.join("\n")

function NodeDetails(props: RadarMapInspectorProps & { node: RadarMapNode }) {
  const node = () => props.node
  const mono = () => props.monoFont
  const links = () => (
    <RelatedLinks ids={node().related} model={props.model} onSelect={props.onSelect} />
  )
  return (
    <>
      <h3>{node().label}</h3>
      <p>{node().status}</p>
      <dl>
        <Row label="Type" value={node().kind} />
        <Row label="State" value={node().status} />
      </dl>
      <Show when={recordKind(node(), "component")}>
        {(record) => (
          <dl>
            <Row label="Responsibility" value={record().value.responsibility} />
            <Row label="Source file" value={record().value.sourceFile} mono={mono()} />
          </dl>
        )}
      </Show>
      <Show when={recordKind(node(), "session")}>
        {(record) => (
          <>
            <dl>
              <Row label="Agent" value={record().value.agent} />
              <Row label="Native state" value={record().value.state} />
              <Row
                label="Availability / freshness"
                value={`${record().value.availability} · ${record().value.freshness}`}
              />
              <Row label="Model / effort" value={radarSessionModelContext(record()).model} />
              <Row
                label="Tasks"
                value={record()
                  .tasks.map((task) => `${task.label} · ${task.state}`)
                  .join("; ")}
              />
              <Row
                label="Classification"
                value={[record().value.classification, ...record().value.associations].join(" · ")}
              />
              <Row label="Updated" value={liveTime(record().value.updatedAt)} />
              <Row label="Observed" value={liveTime(record().value.observedAt)} />
            </dl>
            <Identifiers>
              <Row label="Session" value={record().value.sessionID} mono={mono()} />
              <Row label="Project" value={record().value.projectID} mono={mono()} />
              <Row label="Parent session" value={record().value.parentSessionID} mono={mono()} />
              <Row label="Current route" value={record().value.currentRouteID} mono={mono()} />
              <Row
                label="Configured routes"
                value={joined(record().value.configuredRouteIDs)}
                mono={mono()}
              />
              <Row label="Plans" value={joined(record().value.planIDs)} mono={mono()} />
              <Row label="Tasks" value={joined(record().value.taskIDs)} mono={mono()} />
              <Row label="Attempts" value={joined(record().value.attemptIDs)} mono={mono()} />
              <Row label="Identity" value={node().id} mono={mono()} />
            </Identifiers>
            <Show when={record().routes.length > 0}>
              <h4>Observed and configured routes</h4>
              <For each={record().routes}>
                {(route) => (
                  <details class="lazers-radar-disclosure">
                    <summary>
                      {route.providerID} / {route.modelID}
                    </summary>
                    <RouteDetails route={route} monoFont={props.monoFont} />
                  </details>
                )}
              </For>
            </Show>
            <Show when={record().attempts.length > 0}>
              <h4>Work attempts</h4>
              <For each={record().attempts}>
                {(attempt) => (
                  <>
                    <dl>
                      <Row label="Attempt" value={`${attempt.number} · ${attempt.state}`} />
                      <Row label="Started" value={liveTime(attempt.startedAt)} />
                    </dl>
                    <Identifiers>
                      <Row label="Attempt" value={attempt.id} mono={mono()} />
                      <Row
                        label="Task / plan"
                        value={`${attempt.taskID} / ${attempt.planID}`}
                        mono={mono()}
                      />
                      <Row
                        label="Configured route"
                        value={attempt.configuredRouteID}
                        mono={mono()}
                      />
                    </Identifiers>
                  </>
                )}
              </For>
            </Show>
          </>
        )}
      </Show>
      <Show when={recordKind(node(), "route")}>
        {(record) => (
          <>
            <h4>Route provenance</h4>
            <For each={record().value}>
              {(route) => (
                <details class="lazers-radar-disclosure" open={record().value.length === 1}>
                  <summary>
                    {route.providerID} / {route.modelID} · {route.source}
                  </summary>
                  <RouteDetails route={route} monoFont={props.monoFont} />
                </details>
              )}
            </For>
          </>
        )}
      </Show>
      <Show when={recordKind(node(), "plan")}>
        {(record) => (
          <>
            <dl>
              <Row label="Title" value={record().value.title} />
              <Row label="State" value={record().value.state} />
              <Row label="Related tasks" value={`${record().tasks.length} recorded`} />
            </dl>
            <Identifiers>
              <Row label="Plan" value={record().value.id} mono={mono()} />
              <Row label="Owner session" value={record().value.ownerSessionID} mono={mono()} />
              <Row label="Identity" value={node().id} mono={mono()} />
            </Identifiers>
          </>
        )}
      </Show>
      <Show when={recordKind(node(), "task")}>
        {(record) => (
          <>
            <dl>
              <Row label="State" value={record().value.state} />
              <Row label="Objective" value={record().objective} />
              <Row label="Reason" value={record().reason} />
            </dl>
            <Identifiers>
              <Row label="Plan" value={record().value.planID} mono={mono()} />
              <Row label="Task" value={record().value.id} mono={mono()} />
              <Row label="Identity" value={node().id} mono={mono()} />
            </Identifiers>
            <Show when={record().attempts.length > 0}>
              <h4>Attempts</h4>
              <For each={record().attempts}>
                {(attempt) => (
                  <>
                    <dl>
                      <Row label="Attempt" value={`${attempt.number} · ${attempt.state}`} />
                      <Row label="Started" value={liveTime(attempt.startedAt)} />
                    </dl>
                    <Identifiers>
                      <Row label="Attempt" value={attempt.id} mono={mono()} />
                      <Row label="Worker session" value={attempt.sessionID} mono={mono()} />
                    </Identifiers>
                  </>
                )}
              </For>
            </Show>
          </>
        )}
      </Show>
      <Show when={recordKind(node(), "tool")}>
        {(record) => (
          <>
            <dl>
              <Row label="Name" value={record().value.name} />
              <Row label="Associated sessions" value={`${record().sessions.length} recorded`} />
            </dl>
            <Identifiers>
              <Row label="Tool" value={record().value.id} mono={mono()} />
              <Row
                label="Sessions"
                value={joined(record().sessions.map((session) => session.sessionID))}
                mono={mono()}
              />
              <Row label="Identity" value={node().id} mono={mono()} />
            </Identifiers>
          </>
        )}
      </Show>
      <Show
        when={
          !recordKind(node(), "session") &&
          !recordKind(node(), "plan") &&
          !recordKind(node(), "task") &&
          !recordKind(node(), "tool")
        }
      >
        <Identifiers>
          <Row label="Identity" value={node().id} mono={mono()} />
        </Identifiers>
      </Show>
      {links()}
    </>
  )
}

function RouteDetails(props: { route: RadarResponse["routes"][number]; monoFont: string }) {
  return (
    <>
      <dl>
        <Row
          label="Provider / model"
          value={`${props.route.providerID} / ${props.route.modelID}`}
        />
        <Row label="Variant" value={props.route.variant} />
        <Row label="Source" value={props.route.source} />
        <Row label="Observed" value={liveTime(props.route.observedAt)} />
      </dl>
      <Identifiers>
        <Row label="Route" value={props.route.id} mono={props.monoFont} />
        <Row label="Session" value={props.route.sessionID} mono={props.monoFont} />
        <Row label="Attempt" value={props.route.attemptID} mono={props.monoFont} />
        <Row label="Message" value={props.route.messageID} mono={props.monoFont} />
        <Row label="Event" value={props.route.eventID} mono={props.monoFont} />
      </Identifiers>
    </>
  )
}

function EdgeDetails(props: RadarMapInspectorProps & { edge: RadarMapEdge }) {
  const edge = () => props.edge
  const mono = () => props.monoFont
  const from = () => props.model.nodeByID.get(edge().from)?.label ?? edge().from
  const to = () => props.model.nodeByID.get(edge().to)?.label ?? edge().to
  return (
    <>
      <h3>{edgeLabel(edge().kind)}</h3>
      <p>
        {from()} → {to()} · {edge().status}
      </p>
      <dl>
        <Row label="Kind" value={edge().kind} />
        <Row label="Latest status" value={edge().status} />
        <Row
          label="Records"
          value={edge().records.length || edge().routeRecords.length || "Code-backed structure"}
        />
      </dl>
      <Identifiers>
        <Row label="Relationship" value={edge().id} mono={mono()} />
        <Row label="From" value={edge().from} mono={mono()} />
        <Row label="To" value={edge().to} mono={mono()} />
      </Identifiers>
      <Show when={edge().routeRecords.length > 0}>
        <h4>Route evidence</h4>
        <For each={edge().routeRecords}>
          {(route) => <RouteDetails route={route} monoFont={props.monoFont} />}
        </For>
      </Show>
      <Show when={edge().records.length > 0}>
        <h4>Operational records</h4>
        <For each={edge().records}>
          {(record, index) => (
            <details class="lazers-radar-disclosure" open={edge().records.length === 1}>
              <summary>
                Record {index() + 1} · {record.status}
                {record.deliveryStage ? ` · ${record.deliveryStage}` : ""}
              </summary>
              <dl>
                <Row label="Agent" value={record.agentID} />
                <Row label="Started" value={liveTime(record.startedAt)} />
                <Row label="Observed" value={liveTime(record.observedAt)} />
                <Row
                  label="Live activity"
                  value={record.live ? "Identified live event" : "Historical or structural"}
                />
              </dl>
              <Identifiers>
                <Row label="Original edge" value={record.id} mono={mono()} />
                <Row label="Plan" value={record.planID} mono={mono()} />
                <Row label="Task" value={record.taskID} mono={mono()} />
                <Row label="Attempt" value={record.attemptID} mono={mono()} />
                <Row label="Message" value={record.messageID} mono={mono()} />
                <Row label="Call" value={record.callID} mono={mono()} />
                <Row label="Route" value={record.routeID} mono={mono()} />
              </Identifiers>
              <Show when={record.evidence.length > 0}>
                <h4>Evidence</h4>
                <ol class="lazers-radar-map-evidence">
                  <For each={record.evidence}>
                    {(item) => (
                      <li>
                        <strong>{item.source}</strong>
                        <dl>
                          <Show when={evidenceKind(item, "native-event")}>
                            {(event) => (
                              <>
                                <Row label="Event" value={event().eventType} />
                                <Row label="At" value={liveTime(event().at)} />
                                <Row label="Event ID" value={event().eventID} mono={mono()} />
                                <Row label="Session" value={event().sessionID} mono={mono()} />
                                <Row label="Message" value={event().messageID} mono={mono()} />
                                <Row label="Call" value={event().callID} mono={mono()} />
                              </>
                            )}
                          </Show>
                          <Show when={evidenceKind(item, "runner-transition")}>
                            {(transition) => (
                              <>
                                <Row
                                  label="Sequence / event"
                                  value={`${transition().sequence} · ${transition().event}`}
                                />
                                <Row label="At" value={liveTime(transition().at)} />
                                <Row label="Effect" value={transition().effectID} mono={mono()} />
                                <Row label="Outbox" value={transition().outboxID} mono={mono()} />
                                <Row label="Message" value={transition().messageID} mono={mono()} />
                              </>
                            )}
                          </Show>
                          <Show when={evidenceKind(item, "runner-record")}>
                            {(runner) => (
                              <>
                                <Row label="At" value={liveTime(runner().at)} />
                                <Row label="Record" value={runner().recordID} mono={mono()} />
                                <Row label="Message" value={runner().messageID} mono={mono()} />
                                <Row label="Call" value={runner().callID} mono={mono()} />
                              </>
                            )}
                          </Show>
                          <Show when={evidenceKind(item, "native-read")}>
                            {(read) => (
                              <>
                                <Row label="Read at" value={liveTime(read().at)} />
                                <Row label="Session" value={read().sessionID} mono={mono()} />
                              </>
                            )}
                          </Show>
                          <Show when={evidenceKind(item, "code")}>
                            {(code) => (
                              <Row label="Source file" value={code().reference} mono={mono()} />
                            )}
                          </Show>
                        </dl>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </details>
          )}
        </For>
      </Show>
      <RelatedLinks ids={edge().related} model={props.model} onSelect={props.onSelect} />
    </>
  )
}

export function RadarMapInspector(props: RadarMapInspectorProps) {
  const node = () => (props.selectedID ? props.model.nodeByID.get(props.selectedID) : undefined)
  const edge = () => (props.selectedID ? props.model.edgeByID.get(props.selectedID) : undefined)
  return (
    <Show
      when={node() || edge()}
      fallback={
        <div class="lazers-radar-note">
          {props.selectedID
            ? "The selected map record is no longer available in this observation."
            : "Select a runtime component, session, model route, work record, tool, or typed relationship."}
        </div>
      }
    >
      <Show when={node()}>{(value) => <NodeDetails {...props} node={value()} />}</Show>
      <Show when={edge()}>{(value) => <EdgeDetails {...props} edge={value()} />}</Show>
    </Show>
  )
}

function AccessibleMap(props: {
  overview: RadarOverview
  model: RadarMapModel
  selectedID: string | null
  onSelect(id: string): void
}) {
  const groupByID = createMemo(
    () => new Map(props.overview.groups.map((group) => [group.id, group])),
  )
  return (
    <section class="lazers-radar-map-accessible" aria-label="All supplied scoped records">
      <h3>All scoped records</h3>
      <For each={props.overview.groups.map((group) => group.id)}>
        {(groupID) => {
          const group = () => groupByID().get(groupID)!
          const entriesByID = createMemo(
            () => new Map(group().entries.map((entry) => [entry.id, entry])),
          )
          return (
            <details class="lazers-radar-disclosure" data-group={groupID}>
              <summary>
                {group().label} · {group().count}{" "}
                {groupID === "relationships" ? "mapped relationships" : "records"} ·{" "}
                {group().sourceCount} source records
              </summary>
              <ol>
                <For each={group().entries.map((entry) => entry.id)}>
                  {(entryID) => {
                    const entry = () => entriesByID().get(entryID)!
                    return (
                      <li>
                        <button
                          type="button"
                          aria-pressed={props.selectedID === entryID}
                          onClick={() => props.onSelect(entryID)}
                        >
                          <strong>
                            {entry().kind === "edge"
                              ? edgeLabel(props.model.edgeByID.get(entryID)!.kind)
                              : entry().title}
                          </strong>
                          <span>{entry().status}</span>
                          <span>{entry().context}</span>
                          <code>{entryID}</code>
                        </button>
                        <Show when={(entry().sourceIDs?.length ?? 0) > 1}>
                          <details class="lazers-radar-disclosure">
                            <summary>
                              {entry().sourceIDs!.length - 1} original source identities
                            </summary>
                            <ul>
                              <For each={entry().sourceIDs!.slice(1)}>
                                {(id) => (
                                  <li>
                                    <code>{id}</code>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </details>
                        </Show>
                      </li>
                    )
                  }}
                </For>
              </ol>
            </details>
          )
        }}
      </For>
    </section>
  )
}

export function RadarMapView(props: RadarMapViewProps) {
  let root: HTMLDivElement | undefined
  let canvas: CanvasRenderingContext2D | null = null
  const [rootReady, setRootReady] = createSignal(false)
  const [fontRevision, setFontRevision] = createSignal(0)
  const [reducedMotion, setReducedMotion] = createSignal(false)
  const [pulses, setPulses] = createSignal<RadarPulse[]>([])
  const pulseTracker = new RadarPulseTracker()
  const pulseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const model = () => props.model
  const overview = createMemo(() => createRadarOverview(model(), props.currentSessionID))
  const overviewConnectionIDs = createMemo(() => radarOverviewConnectionIDs(overview().edges))
  const overviewConnection = (id: string) => radarOverviewConnectionForID(overview().edges, id)
  const displayModel = createMemo<RadarMapModel>(() => {
    const summary = overview()
    return {
      ...model(),
      nodes: summary.nodes,
      edges: summary.graphEdges,
      nodeByID: new Map(summary.nodes.map((node) => [node.id, node])),
      edgeByID: new Map(summary.graphEdges.map((edge) => [edge.id, edge])),
    }
  })
  const measured = createMemo(() => {
    const revision = fontRevision()
    const ready = rootReady()
    const appearanceFont = props.monoFont
    const style = root && ready ? getComputedStyle(root) : undefined
    const font = style?.font || "12px sans-serif"
    const fontKey = JSON.stringify([
      font,
      style?.fontFamily,
      style?.fontSize,
      style?.fontWeight,
      style?.letterSpacing,
      appearanceFont,
      globalThis.devicePixelRatio || 1,
      revision,
    ])
    if (!canvas && typeof document !== "undefined")
      canvas = document.createElement("canvas").getContext("2d")
    if (canvas) canvas.font = font
    const letterSpacing = Number.parseFloat(style?.letterSpacing ?? "0") || 0
    const measure = canvas
      ? (value: string) => canvas!.measureText(value).width + [...value].length * letterSpacing
      : defaultTextMeasure
    return measureRadarMap(displayModel(), props.scopeKey, fontKey, measure, "DOWN")
  })
  const layoutInput = createMemo(() => measured().input, undefined, {
    equals: (left, right) => left.key === right.key,
  })
  const layout = createStableRadarLayout(
    () => (rootReady() ? layoutInput() : undefined),
    props.layout,
  )
  const layoutResult = layout.result
  const layoutError = layout.error
  const nodes = () => mapBox(layoutResult()?.nodes ?? [])
  const edges = () => mapBox(layoutResult()?.edges ?? [])
  const isSelected = (id: string) => props.selectedID === id
  const focusNode = (id: string) => props.onSelect(id)
  const focusEdge = (id: string) => props.onSelect(id)
  createEffect(() => {
    if (layoutResult()) props.onLayoutReady?.(props.scopeKey)
  })
  const groupLabels = new Map([
    ["overview", "Operational overview"],
    ["runtime", "LAZERS runtime"],
    ["work", "Plans and tasks"],
    ["sessions", "Native sessions"],
    ["routes", "Model routes"],
    ["tools", "Native tools"],
  ])
  const activePulses = (edgeID: string) => pulses().filter((pulse) => pulse.edgeID === edgeID)
  const schedulerSummary = () => {
    const node = overview().nodes.find((value) => value.id === "component:runner-runtime")
    return node?.record.kind === "component"
      ? `${node.label} · ${node.record.value.responsibility}`
      : undefined
  }
  const architectSummary = () => {
    const node = overview().nodes.find((value) => value.id === overview().currentArchitectID)
    if (node?.record.kind !== "session") return undefined
    const context = radarSessionModelContext(node.record)
    return `${node.record.value.state} · ${context.model} · ${context.task}`
  }
  const visibleActiveWorkers = () =>
    overview().activeWorkerSessions.filter((node) => node.id !== overview().currentArchitectID)

  createEffect(() => {
    const fresh = pulseTracker.update(model().edges, props.resynchronizing, !reducedMotion())
    for (const pulse of fresh) {
      const key = `${pulse.edgeID}\u0000${pulse.eventID}`
      setPulses((current) => [...current, pulse])
      const timer = setTimeout(() => {
        pulseTimers.delete(key)
        setPulses((current) =>
          current.filter((item) => item.edgeID !== pulse.edgeID || item.eventID !== pulse.eventID),
        )
      }, 900)
      pulseTimers.set(key, timer)
    }
  })

  createEffect(() => {
    if (!props.resynchronizing && !reducedMotion()) return
    for (const timer of pulseTimers.values()) clearTimeout(timer)
    pulseTimers.clear()
    setPulses([])
  })

  onMount(() => {
    if (typeof window !== "undefined") {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)")
      const updateMotion = () => setReducedMotion(query.matches)
      updateMotion()
      query.addEventListener("change", updateMotion)
      onCleanup(() => query.removeEventListener("change", updateMotion))
    }
    if (typeof document !== "undefined") {
      const refreshMetrics = () => setFontRevision((value) => value + 1)
      const observer = new MutationObserver(refreshMetrics)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      })
      observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] })
      document.fonts?.addEventListener("loadingdone", refreshMetrics)
      void document.fonts?.ready.then(refreshMetrics)
      onCleanup(() => {
        observer.disconnect()
        document.fonts?.removeEventListener("loadingdone", refreshMetrics)
      })
    }
  })

  onCleanup(() => {
    for (const timer of pulseTimers.values()) clearTimeout(timer)
    pulseTimers.clear()
  })

  return (
    <div
      class="lazers-radar-map-frame"
      ref={(element) => {
        root = element
        setRootReady(true)
      }}
    >
      <Show
        when={layoutResult()}
        fallback={
          <div class="lazers-radar-map-pending" role={layoutError() ? "alert" : "status"}>
            {layoutError()
              ? `ELK layout is unavailable; the ordered accessible map remains available. ${layoutError()}`
              : layout.loading()
                ? "Calculating the operational map with elkjs…"
                : "The operational map is not available."}
          </div>
        }
      >
        {(result) => (
          <svg
            class="lazers-radar-map"
            width={result().width}
            height={result().height}
            viewBox={`0 0 ${result().width} ${result().height}`}
            role="group"
            aria-label="Compact operational node overview with recorded relationships in details below"
            preserveAspectRatio="xMinYMin meet"
          >
            <For each={result().groups}>
              {(group) => (
                <g class="lazers-radar-map-group" aria-hidden="true">
                  <rect x={group.x} y={group.y} width={group.width} height={group.height} rx={8} />
                  <text x={group.x + 14} y={group.y + 24}>
                    {groupLabels.get(group.id) ?? group.id}
                  </text>
                </g>
              )}
            </For>
            <For each={displayModel().edges.map((edge) => edge.id)}>
              {(edgeID) => {
                const edge = () => displayModel().edgeByID.get(edgeID)!
                const layout = () => edges().get(edgeID)
                const from = () => displayModel().nodeByID.get(edge().from)
                const to = () => displayModel().nodeByID.get(edge().to)
                const edgeLabelText = () => edgeLabel(edge().kind)
                const accessibleLabel = () =>
                  `${edgeLabelText()} from ${from()?.label ?? edge().from} to ${to()?.label ?? edge().to}; ${edge().status}; ${edge().records.length} recorded operational records`
                return (
                  <Show when={layout()}>
                    {(placed) => (
                      <g class="lazers-radar-map-edge" data-kind={edge().kind}>
                        <path class="lazers-radar-map-edge-line" d={placed().path} />
                        <path class="lazers-radar-map-edge-arrow" d={placed().arrow} />
                        <text
                          class="lazers-radar-map-edge-label"
                          x={placed().labelX}
                          y={placed().labelY + 4}
                          text-anchor="middle"
                        >
                          {edgeLabelText()}
                        </text>
                        <path
                          class="lazers-radar-map-edge-hit"
                          d={placed().path}
                          role="button"
                          tabIndex={0}
                          aria-label={accessibleLabel()}
                          aria-pressed={isSelected(edgeID)}
                          onClick={() => focusEdge(edgeID)}
                          onKeyDown={(event) => keyDown(event, () => focusEdge(edgeID))}
                        />
                        <For each={activePulses(edgeID)}>
                          {(pulse) => (
                            <circle class="lazers-radar-map-pulse" r={4} aria-hidden="true">
                              <animateMotion
                                path={placed().path}
                                dur="800ms"
                                fill="freeze"
                                keyPoints="0;1"
                                keyTimes="0;1"
                                calcMode="linear"
                                rotate="auto"
                              />
                              <title>{`New native event ${pulse.eventID}`}</title>
                            </circle>
                          )}
                        </For>
                      </g>
                    )}
                  </Show>
                )
              }}
            </For>
            <For each={displayModel().nodes.map((node) => node.id)}>
              {(nodeID) => {
                const node = () => displayModel().nodeByID.get(nodeID)!
                const placed = () => nodes().get(nodeID) as SvgBox | undefined
                const lines = () => measured().text.get(nodeID)
                const status = () => mapStatus(node())
                const labelY = () => (placed()?.y ?? 0) + 20
                const subtitleY = () => labelY() + ((lines()?.label.length ?? 1) - 1) * 18 + 22
                const statusY = () =>
                  (placed()?.y ?? 0) +
                  (placed()?.height ?? 0) -
                  ((lines()?.status.length ?? 1) - 1) * 13 -
                  8
                const ariaLabel = () =>
                  `${node().kind}: ${node().label}; ${node().status}; identity ${nodeID}`
                return (
                  <Show when={placed()}>
                    {(box) => (
                      <g
                        class="lazers-radar-map-node"
                        data-kind={node().kind}
                        data-state={status()}
                        data-selected={isSelected(nodeID)}
                        role="button"
                        tabIndex={0}
                        aria-label={ariaLabel()}
                        aria-pressed={isSelected(nodeID)}
                        onClick={() => focusNode(nodeID)}
                        onKeyDown={(event) => keyDown(event, () => focusNode(nodeID))}
                      >
                        <title>{ariaLabel()}</title>
                        <rect
                          x={box().x}
                          y={box().y}
                          width={box().width}
                          height={box().height}
                          rx={7}
                        />
                        <text class="lazers-radar-map-node-label" x={box().x + 12} y={labelY()}>
                          <For each={lines()?.label ?? [node().label]}>
                            {(line, index) => (
                              <tspan x={box().x + 12} dy={index() === 0 ? 0 : 18}>
                                {line}
                              </tspan>
                            )}
                          </For>
                        </text>
                        <text
                          class="lazers-radar-map-node-subtitle"
                          x={box().x + 12}
                          y={subtitleY()}
                        >
                          <For each={lines()?.subtitle ?? [node().subtitle]}>
                            {(line, index) => (
                              <tspan x={box().x + 12} dy={index() === 0 ? 0 : 15}>
                                {line}
                              </tspan>
                            )}
                          </For>
                        </text>
                        <text class="lazers-radar-map-node-status" x={box().x + 12} y={statusY()}>
                          <For each={lines()?.status ?? [node().status]}>
                            {(line, index) => (
                              <tspan x={box().x + 12} dy={index() === 0 ? 0 : 13}>
                                {line}
                              </tspan>
                            )}
                          </For>
                        </text>
                      </g>
                    )}
                  </Show>
                )
              }}
            </For>
          </svg>
        )}
      </Show>
      <details class="lazers-radar-disclosure lazers-radar-map-details">
        <summary>
          Details · {overview().activeWorkerCount} active workers · {overview().edges.length}{" "}
          connections
        </summary>
        <div class="lazers-radar-map-overview-summary" aria-label="Current operational overview">
          <Show when={schedulerSummary()}>
            <div>
              <strong>Scheduler</strong>
              <span>{schedulerSummary()}</span>
            </div>
          </Show>
          <Show when={architectSummary()}>
            <div>
              <strong>Current Architect</strong>
              <span>{architectSummary()}</span>
            </div>
          </Show>
          <div>
            <strong>Active workers · {overview().activeWorkerCount}</strong>
            <Show when={overview().activeWorkerCount === 0}>
              <span>No currently available busy worker session is evidenced</span>
            </Show>
            <For each={visibleActiveWorkers()}>
              {(node) => {
                const context = () =>
                  node.record.kind === "session" ? radarSessionModelContext(node.record) : undefined
                return (
                  <span>
                    {node.record.kind === "session"
                      ? (node.record.value.agent ?? "Native worker")
                      : "Worker"}
                    · {node.status}
                    {context()?.model ? ` · ${context()!.model}` : ""}
                  </span>
                )
              }}
            </For>
            <Show when={overview().activeWorkerCount > visibleActiveWorkers().length}>
              <span>
                {overview().activeWorkerCount - visibleActiveWorkers().length} more active sessions
                in Native sessions
              </span>
            </Show>
          </div>
          <Show when={overview().edges.length > 0}>
            <div>
              <strong>Recorded connections · {overview().edges.length}</strong>
              <ol>
                <For each={overviewConnectionIDs()}>
                  {(edgeID) => {
                    const edge = () => overviewConnection(edgeID)!
                    return (
                      <li>
                        <button
                          type="button"
                          class="lazers-radar-map-connection"
                          aria-pressed={isSelected(edgeID)}
                          onClick={() => focusEdge(edgeID)}
                        >
                          {displayModel().nodeByID.get(edge().from)?.label ?? edge().from} ·{" "}
                          {edgeLabel(edge().kind)} →{" "}
                          {displayModel().nodeByID.get(edge().to)?.label ?? edge().to} ·{" "}
                          {edge().status}
                        </button>
                      </li>
                    )
                  }}
                </For>
              </ol>
            </div>
          </Show>
        </div>
        <AccessibleMap
          overview={overview()}
          model={model()}
          selectedID={props.selectedID}
          onSelect={props.onSelect}
        />
      </details>
    </div>
  )
}

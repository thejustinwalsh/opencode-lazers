import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { RadarResponse } from "../observability/contract.ts"
import type { RadarLayoutResult } from "./layout-ipc.ts"
import { createStableRadarLayout } from "./layout-state.ts"
import type { RadarLayoutClient } from "./layout-state.ts"
import { edgeLabel, measureRadarMap } from "./map-layout.ts"
import type { RadarMapEdge, RadarMapModel, RadarMapNode, RadarMapNodeRecord } from "./map-model.ts"
import { defaultTextMeasure } from "./map-layout.ts"
import { RadarPulseTracker } from "./pulse.ts"
import type { RadarPulse } from "./pulse.ts"

type RadarMapViewProps = {
  model: RadarMapModel
  scopeKey: string
  stale: boolean
  selectedID: string | null
  onSelect(id: string): void
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
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unavailable"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString()
}

function fullDateTime(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
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

function NodeDetails(props: RadarMapInspectorProps & { node: RadarMapNode }) {
  const node = () => props.node
  const links = () => (
    <RelatedLinks ids={node().related} model={props.model} onSelect={props.onSelect} />
  )
  return (
    <>
      <h3>{node().label}</h3>
      <p>{node().subtitle}</p>
      <dl>
        <dt>Type</dt>
        <dd>{node().kind}</dd>
        <dt>Identity</dt>
        <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
          {node().id}
        </dd>
        <dt>State</dt>
        <dd>{node().status}</dd>
      </dl>
      <Show when={recordKind(node(), "component")}>
        {(record) => (
          <dl>
            <dt>Responsibility</dt>
            <dd>{record().value.responsibility}</dd>
            <dt>Source file</dt>
            <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
              {record().value.sourceFile}
            </dd>
            <dt>Evidence</dt>
            <dd>Code-backed architecture record</dd>
          </dl>
        )}
      </Show>
      <Show when={recordKind(node(), "session")}>
        {(record) => (
          <>
            <dl>
              <dt>Session ID</dt>
              <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                {record().value.sessionID}
              </dd>
              <dt>Project ID</dt>
              <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                {record().value.projectID}
              </dd>
              <dt>Classification</dt>
              <dd>{record().value.classification}</dd>
              <dt>Associations</dt>
              <dd>{record().value.associations.join(", ") || "None recorded"}</dd>
              <dt>Availability</dt>
              <dd>{record().value.availability}</dd>
              <dt>Freshness</dt>
              <dd>{record().value.freshness}</dd>
              <dt>Agent</dt>
              <dd>{record().value.agent ?? "Unavailable"}</dd>
              <dt>Native state</dt>
              <dd>{record().value.state}</dd>
              <dt>Parent session</dt>
              <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                {record().value.parentSessionID ?? "Unavailable"}
              </dd>
              <dt>Updated</dt>
              <dd>{liveTime(record().value.updatedAt)}</dd>
              <dt>Observed</dt>
              <dd>{liveTime(record().value.observedAt)}</dd>
              <dt>Current route</dt>
              <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                {record().value.currentRouteID ?? "Unavailable"}
              </dd>
              <dt>Configured routes</dt>
              <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                {record().value.configuredRouteIDs.join("\n") || "None recorded"}
              </dd>
              <dt>Plans</dt>
              <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                {record().value.planIDs.join("\n") || "None recorded"}
              </dd>
              <dt>Tasks</dt>
              <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                {record().value.taskIDs.join("\n") || "None recorded"}
              </dd>
              <dt>Attempts</dt>
              <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                {record().value.attemptIDs.join("\n") || "None recorded"}
              </dd>
            </dl>
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
            <Show when={record().attempts.length > 0}>
              <h4>Work attempts</h4>
              <For each={record().attempts}>
                {(attempt) => (
                  <dl>
                    <dt>Attempt ID</dt>
                    <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                      {attempt.id}
                    </dd>
                    <dt>Task / plan</dt>
                    <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                      {attempt.taskID} / {attempt.planID}
                    </dd>
                    <dt>Attempt / state</dt>
                    <dd>
                      {attempt.number} · {attempt.state}
                    </dd>
                    <dt>Started</dt>
                    <dd>{liveTime(attempt.startedAt)}</dd>
                    <dt>Configured route</dt>
                    <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                      {attempt.configuredRouteID ?? "Unavailable"}
                    </dd>
                  </dl>
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
                    {route.source} · {route.id}
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
          <dl>
            <dt>Plan ID</dt>
            <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
              {record().value.id}
            </dd>
            <dt>State</dt>
            <dd>{record().value.state}</dd>
            <dt>Owner session</dt>
            <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
              {record().value.ownerSessionID}
            </dd>
            <dt>Title</dt>
            <dd>{record().value.title ?? "Unavailable"}</dd>
            <dt>Related tasks</dt>
            <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
              {record()
                .tasks.map((task) => task.id)
                .join("\n") || "None recorded"}
            </dd>
          </dl>
        )}
      </Show>
      <Show when={recordKind(node(), "task")}>
        {(record) => (
          <>
            <dl>
              <dt>Task ID</dt>
              <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                {record().value.id}
              </dd>
              <dt>State</dt>
              <dd>{record().value.state}</dd>
              <dt>Plan ID</dt>
              <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                {record().value.planID ?? "Unplanned"}
              </dd>
              <dt>Objective</dt>
              <dd>{record().objective ?? "Unavailable in the lifecycle projection"}</dd>
              <dt>Reason</dt>
              <dd>{record().reason ?? "None recorded"}</dd>
            </dl>
            <Show when={record().attempts.length > 0}>
              <h4>Attempts</h4>
              <For each={record().attempts}>
                {(attempt) => (
                  <dl>
                    <dt>Attempt ID</dt>
                    <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                      {attempt.id}
                    </dd>
                    <dt>Worker session</dt>
                    <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                      {attempt.sessionID}
                    </dd>
                    <dt>Attempt / state</dt>
                    <dd>
                      {attempt.number} · {attempt.state}
                    </dd>
                    <dt>Started</dt>
                    <dd>{liveTime(attempt.startedAt)}</dd>
                  </dl>
                )}
              </For>
            </Show>
          </>
        )}
      </Show>
      <Show when={recordKind(node(), "tool")}>
        {(record) => (
          <dl>
            <dt>Tool ID</dt>
            <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
              {record().value.id}
            </dd>
            <dt>Name</dt>
            <dd>{record().value.name}</dd>
            <dt>Sessions</dt>
            <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
              {record()
                .sessions.map((session) => session.sessionID)
                .join("\n") || "Unavailable"}
            </dd>
          </dl>
        )}
      </Show>
      {links()}
    </>
  )
}

function RouteDetails(props: { route: RadarResponse["routes"][number]; monoFont: string }) {
  return (
    <dl>
      <dt>Route ID</dt>
      <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
        {props.route.id}
      </dd>
      <dt>Provider / model</dt>
      <dd>
        {props.route.providerID} / {props.route.modelID}
      </dd>
      <dt>Variant</dt>
      <dd>{props.route.variant ?? "Unavailable"}</dd>
      <dt>Source</dt>
      <dd>{props.route.source}</dd>
      <dt>Session / attempt</dt>
      <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
        {props.route.sessionID ?? "Unavailable"} / {props.route.attemptID ?? "Unavailable"}
      </dd>
      <dt>Message / event</dt>
      <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
        {props.route.messageID ?? "Unavailable"} / {props.route.eventID ?? "Unavailable"}
      </dd>
      <dt>Observed</dt>
      <dd>{liveTime(props.route.observedAt)}</dd>
    </dl>
  )
}

function EdgeDetails(props: RadarMapInspectorProps & { edge: RadarMapEdge }) {
  const edge = () => props.edge
  return (
    <>
      <h3>{edgeLabel(edge().kind)}</h3>
      <dl>
        <dt>Relationship ID</dt>
        <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
          {edge().id}
        </dd>
        <dt>Kind</dt>
        <dd>{edge().kind}</dd>
        <dt>From</dt>
        <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
          {edge().from}
        </dd>
        <dt>To</dt>
        <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
          {edge().to}
        </dd>
        <dt>Latest status</dt>
        <dd>{edge().status}</dd>
        <dt>Records</dt>
        <dd>{edge().records.length || edge().routeRecords.length || "Code-backed structure"}</dd>
      </dl>
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
                <dt>Original edge ID</dt>
                <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                  {record.id}
                </dd>
                <dt>Plan / task</dt>
                <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                  {record.planID ?? "Unavailable"} / {record.taskID ?? "Unavailable"}
                </dd>
                <dt>Attempt</dt>
                <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                  {record.attemptID ?? "Unavailable"}
                </dd>
                <dt>Agent</dt>
                <dd>{record.agentID ?? "Unavailable"}</dd>
                <dt>Message / call</dt>
                <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                  {record.messageID ?? "Unavailable"} / {record.callID ?? "Unavailable"}
                </dd>
                <dt>Route ID</dt>
                <dd class="lazers-radar-code" style={{ "font-family": props.monoFont }}>
                  {record.routeID ?? "Unavailable"}
                </dd>
                <dt>Started</dt>
                <dd>
                  <time dateTime={fullDateTime(record.startedAt)}>
                    {liveTime(record.startedAt)}
                  </time>
                </dd>
                <dt>Observed</dt>
                <dd>
                  <time dateTime={fullDateTime(record.observedAt)}>
                    {liveTime(record.observedAt)}
                  </time>
                </dd>
                <dt>Live activity</dt>
                <dd>{record.live ? "Identified live event" : "Historical or structural"}</dd>
              </dl>
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
                                <dt>Event</dt>
                                <dd>
                                  {event().eventType} · {event().eventID}
                                </dd>
                                <dt>Session</dt>
                                <dd
                                  class="lazers-radar-code"
                                  style={{ "font-family": props.monoFont }}
                                >
                                  {event().sessionID}
                                </dd>
                                <dt>Message / call</dt>
                                <dd>
                                  {event().messageID ?? "Unavailable"} /{" "}
                                  {event().callID ?? "Unavailable"}
                                </dd>
                                <dt>At</dt>
                                <dd>{liveTime(event().at)}</dd>
                              </>
                            )}
                          </Show>
                          <Show when={evidenceKind(item, "runner-transition")}>
                            {(transition) => (
                              <>
                                <dt>Sequence / event</dt>
                                <dd>
                                  {transition().sequence} · {transition().event}
                                </dd>
                                <dt>Effect / outbox</dt>
                                <dd
                                  class="lazers-radar-code"
                                  style={{ "font-family": props.monoFont }}
                                >
                                  {transition().effectID ?? "Unavailable"} /{" "}
                                  {transition().outboxID ?? "Unavailable"}
                                </dd>
                                <dt>Message / time</dt>
                                <dd>
                                  {transition().messageID ?? "Unavailable"} /{" "}
                                  {liveTime(transition().at)}
                                </dd>
                              </>
                            )}
                          </Show>
                          <Show when={evidenceKind(item, "runner-record")}>
                            {(runner) => (
                              <>
                                <dt>Record ID</dt>
                                <dd
                                  class="lazers-radar-code"
                                  style={{ "font-family": props.monoFont }}
                                >
                                  {runner().recordID}
                                </dd>
                                <dt>Message / call</dt>
                                <dd>
                                  {runner().messageID ?? "Unavailable"} /{" "}
                                  {runner().callID ?? "Unavailable"}
                                </dd>
                                <dt>At</dt>
                                <dd>{liveTime(runner().at)}</dd>
                              </>
                            )}
                          </Show>
                          <Show when={evidenceKind(item, "native-read")}>
                            {(read) => (
                              <>
                                <dt>Session</dt>
                                <dd
                                  class="lazers-radar-code"
                                  style={{ "font-family": props.monoFont }}
                                >
                                  {read().sessionID}
                                </dd>
                                <dt>Read at</dt>
                                <dd>{liveTime(read().at)}</dd>
                              </>
                            )}
                          </Show>
                          <Show when={evidenceKind(item, "code")}>
                            {(code) => (
                              <>
                                <dt>Source file</dt>
                                <dd
                                  class="lazers-radar-code"
                                  style={{ "font-family": props.monoFont }}
                                >
                                  {code().reference}
                                </dd>
                                <dt>Timestamp</dt>
                                <dd>Structural evidence; no event time</dd>
                              </>
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
  model: RadarMapModel
  selectedID: string | null
  onSelect(id: string): void
}) {
  return (
    <details class="lazers-radar-map-accessible">
      <summary>Accessible ordered component and relationship list</summary>
      <section aria-label="Operational components and records">
        <h4>Nodes</h4>
        <ol>
          <For each={props.model.nodes.map((node) => node.id)}>
            {(id) => {
              const node = () => props.model.nodeByID.get(id)!
              return (
                <li>
                  <button
                    type="button"
                    aria-pressed={props.selectedID === id}
                    onClick={() => props.onSelect(id)}
                  >
                    {node().kind}: {node().label} · {node().status} · {id}
                  </button>
                </li>
              )
            }}
          </For>
        </ol>
      </section>
      <section aria-label="Typed operational relationships">
        <h4>Relationships</h4>
        <ol>
          <For each={props.model.edges.map((edge) => edge.id)}>
            {(id) => {
              const edge = () => props.model.edgeByID.get(id)!
              return (
                <li>
                  <button
                    type="button"
                    aria-pressed={props.selectedID === id}
                    onClick={() => props.onSelect(id)}
                  >
                    {edgeLabel(edge().kind)}: {edge().from} → {edge().to} · {edge().status} · {id}
                  </button>
                </li>
              )
            }}
          </For>
        </ol>
      </section>
    </details>
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
    return measureRadarMap(model(), props.scopeKey, fontKey, measure)
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
  const groupLabels = new Map([
    ["runtime", "LAZERS runtime"],
    ["work", "Plans and tasks"],
    ["sessions", "Native sessions"],
    ["routes", "Model routes"],
    ["tools", "Native tools"],
  ])
  const activePulses = (edgeID: string) => pulses().filter((pulse) => pulse.edgeID === edgeID)

  createEffect(() => {
    const fresh = pulseTracker.update(model().edges, props.stale, !reducedMotion())
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
    if (!props.stale && !reducedMotion()) return
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
            aria-label="C4-style operational architecture and activity map"
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
            <For each={model().edges.map((edge) => edge.id)}>
              {(edgeID) => {
                const edge = () => model().edgeByID.get(edgeID)!
                const layout = () => edges().get(edgeID)
                const from = () => model().nodeByID.get(edge().from)
                const to = () => model().nodeByID.get(edge().to)
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
                          y={placed().labelY - 4}
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
            <For each={model().nodes.map((node) => node.id)}>
              {(nodeID) => {
                const node = () => model().nodeByID.get(nodeID)!
                const placed = () => nodes().get(nodeID) as SvgBox | undefined
                const lines = () => measured().text.get(nodeID)
                const status = () => mapStatus(node())
                const labelY = () => (placed()?.y ?? 0) + 22
                const subtitleY = () => labelY() + (lines()?.label.length ?? 1) * 18 + 13
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
      <AccessibleMap model={model()} selectedID={props.selectedID} onSelect={props.onSelect} />
    </div>
  )
}

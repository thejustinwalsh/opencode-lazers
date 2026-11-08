import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import type { LiveRadarResponse, ObservationScope } from "../observability/contract.ts"
import type { RadarMonitorData } from "./monitor-state.ts"

type Props = {
  data: Accessor<RadarMonitorData>
  scope: ObservationScope
  anchorSessionID: string
  includeUnmanagedSessions: boolean
  monoFont: string
  onScopeChange: (scope: ObservationScope["kind"]) => void
  onIncludeUnmanagedSessionsChange: (include: boolean) => void
  onSelectSession: (sessionID: string) => void
  onRefresh: () => void
  onLoadMoreHistory: () => void
  onOpenDiagnostics: () => void
}

function shortID(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value
}

function timestamp(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Time unavailable"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleTimeString()
}

function elapsed(start: number | null, end: number | null) {
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end))
    return "Duration unavailable"
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function callStateLabel(status: string) {
  switch (status) {
    case "input-started":
      return "Input started"
    case "running":
      return "Running"
    case "not-executed":
      return "Not executed"
    case "succeeded":
      return "Succeeded"
    case "failed":
      return "Failed"
    default:
      return "Unknown"
  }
}

function sessionStateLabel(session: LiveRadarResponse["sessions"][number]) {
  return `${session.availability} · ${session.freshness} · ${session.state}`
}

function routeLabel(live: LiveRadarResponse, routeID: string | null) {
  if (!routeID) return "Not observed"
  const route = live.routes.find((candidate) => candidate.id === routeID)
  return route
    ? [route.providerID, route.modelID, route.variant].filter(Boolean).join(" · ")
    : "Unavailable"
}

function coverageLabel(live: LiveRadarResponse) {
  const coverage = live.coverage
  const omissions = [
    coverage.inventoryTruncated && "inventory",
    coverage.assignmentTruncated && "assignments",
    coverage.progressTruncated && "progress",
    coverage.payloadTruncated && "payload",
    coverage.callsTruncated && "calls",
    coverage.flowTruncated && "flow",
    coverage.routeTruncated && "routes",
    coverage.journalTruncated && "journal",
  ].filter(Boolean)
  return omissions.length
    ? `Bounded · omissions: ${omissions.join(", ")}`
    : "No truncation reported"
}

export function RadarMonitorView(props: Props) {
  const [split, setSplit] = createSignal(58)
  const [selectedCallID, setSelectedCallID] = createSignal<string | null>(null)
  const [selectedTarget, setSelectedTarget] = createSignal<string | null>(null)
  const [selectedEventID, setSelectedEventID] = createSignal<string | null>(null)
  let root: HTMLDivElement | undefined
  let activity: HTMLDivElement | undefined
  let lastSelectedSessionID = ""

  const live = () => props.data().live
  const sessions = () => live()?.sessions ?? []
  const sessionIDs = createMemo(() => sessions().map((session) => session.sessionID))
  const sessionByID = createMemo(
    () => new Map(sessions().map((session) => [session.sessionID, session])),
  )
  const selectedSessionID = () =>
    props.data().selectedSessionID ??
    sessions().find((session) => session.sessionID === props.anchorSessionID)?.sessionID ??
    sessionIDs()[0] ??
    null
  const selectedSession = () => {
    const id = selectedSessionID()
    return id ? sessionByID().get(id) : undefined
  }
  const calls = () => {
    const id = selectedSessionID()
    return live()?.calls.filter((call) => call.sessionID === id) ?? []
  }
  const callIDs = createMemo(() => calls().map((call) => call.id))
  const callByID = createMemo(() => new Map(calls().map((call) => [call.id, call])))
  const selectedCall = () => {
    const id = selectedCallID()
    return id ? callByID().get(id) : undefined
  }
  const flow = () => {
    const id = selectedSessionID()
    return live()?.flow.filter((item) => item.sessionID === id) ?? []
  }
  const flowIDs = createMemo(() => flow().map((item) => item.id))
  const flowByID = createMemo(() => new Map(flow().map((item) => [item.id, item])))
  const selectedFlow = () => {
    const id = selectedEventID()
    return id ? flowByID().get(id) : undefined
  }

  createEffect(() => {
    const id = selectedSessionID() ?? ""
    if (id && id !== lastSelectedSessionID) {
      lastSelectedSessionID = id
      setSelectedCallID(null)
      setSelectedTarget(null)
      setSelectedEventID(null)
    }
    if (!id && lastSelectedSessionID) lastSelectedSessionID = ""
  })
  createEffect(() => {
    const id = selectedSessionID()
    if (id && props.data().selectedSessionID !== id) props.onSelectSession(id)
  })
  createEffect(() => {
    if (selectedCallID() && !callByID().has(selectedCallID()!)) setSelectedCallID(null)
  })

  const refreshLabel = () => {
    const data = props.data()
    if (data.connection === "disconnected") return "Disconnected · stale snapshot"
    if (data.connection === "reconnecting") return "Reconnecting · stale snapshot"
    if (data.stale) return "Live coverage incomplete or resynchronizing"
    return "Live updates connected"
  }
  const requestTime = (call: NonNullable<ReturnType<typeof selectedCall>>) =>
    call.inputAt ?? call.calledAt ?? call.observedAt
  const duration = (call: NonNullable<ReturnType<typeof selectedCall>>) =>
    elapsed(requestTime(call), call.completedAt ?? live()?.observedAt ?? null)
  const resizeByKey: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.key === "ArrowUp") setSplit((value) => Math.min(78, value + 3))
    else if (event.key === "ArrowDown") setSplit((value) => Math.max(32, value - 3))
    else if (event.key === "Home") setSplit(32)
    else if (event.key === "End") setSplit(78)
    else return
    event.preventDefault()
  }
  const pointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    const separator = event.currentTarget
    const pointer = event.pointerId
    separator.setPointerCapture(pointer)
    const move = (next: PointerEvent) => {
      const rect = root?.getBoundingClientRect()
      if (!rect || rect.height <= 0) return
      const usable = rect.height - (activity?.offsetTop ?? 0)
      const ratio = ((next.clientY - rect.top - (activity?.offsetTop ?? 0)) / usable) * 100
      setSplit(Math.max(32, Math.min(78, ratio)))
    }
    const end = () => {
      separator.removeEventListener("pointermove", move)
      separator.removeEventListener("pointerup", end)
      separator.removeEventListener("pointercancel", end)
    }
    separator.addEventListener("pointermove", move)
    separator.addEventListener("pointerup", end, { once: true })
    separator.addEventListener("pointercancel", end, { once: true })
  }

  return (
    <div
      class="lazers-radar lazers-radar-monitor"
      ref={(element) => (root = element)}
      style={{ "--radar-visual-fr": `${split()}fr`, "--radar-detail-fr": `${100 - split()}fr` }}
    >
      <header class="lazers-radar-header lazers-radar-monitor-header">
        <div class="lazers-radar-heading">
          <h2>Radar · live monitor</h2>
          <span
            class="lazers-radar-status-dot"
            data-stale={props.data().stale}
            role="img"
            aria-label={refreshLabel()}
            title={refreshLabel()}
          />
          <span class="lazers-radar-monitor-status" role="status">
            {refreshLabel()}
          </span>
        </div>
        <div class="lazers-radar-controls">
          <div class="lazers-radar-scope" role="group" aria-label="Monitor scope">
            <button
              type="button"
              aria-pressed={props.scope.kind === "session"}
              onClick={() => props.onScopeChange("session")}
            >
              Session
            </button>
            <button
              type="button"
              aria-pressed={props.scope.kind === "project"}
              onClick={() => props.onScopeChange("project")}
            >
              Project
            </button>
          </div>
          <Show when={props.scope.kind === "project"}>
            <button
              type="button"
              class="lazers-radar-other-sessions"
              aria-pressed={props.includeUnmanagedSessions}
              onClick={() =>
                props.onIncludeUnmanagedSessionsChange(!props.includeUnmanagedSessions)
              }
            >
              {props.includeUnmanagedSessions ? "Broader sessions shown" : "Managed sessions"}
            </button>
          </Show>
          <button
            type="button"
            class="lazers-radar-refresh"
            onClick={props.onRefresh}
            disabled={props.data().loading}
          >
            Refresh
          </button>
          <button type="button" class="lazers-radar-refresh" onClick={props.onOpenDiagnostics}>
            Diagnostics
          </button>
        </div>
      </header>

      <div
        class="lazers-radar-visual lazers-radar-monitor-activity"
        ref={(element) => (activity = element)}
        aria-label="Live session activity"
      >
        <Show when={props.data().error}>
          <div class="lazers-radar-note" data-error="true" role="alert">
            <span>{props.data().error}</span>
            <button type="button" onClick={props.onRefresh}>
              Retry live read
            </button>
          </div>
        </Show>
        <Show
          when={live()}
          fallback={
            <div class="lazers-radar-note" role="status">
              {props.data().loading
                ? "Loading authorized live session activity…"
                : "Live session activity is unavailable; no idle or no-workers conclusion can be drawn."}
            </div>
          }
        >
          {(response) => (
            <>
              <div class="lazers-radar-monitor-coverage" role="status">
                <span>{response().coverage.sessionCount} returned</span>
                <span>{response().coverage.managedSessionCount} managed</span>
                <span>{response().freshness.nativeInventory} inventory</span>
                <span>{response().freshness.nativeEvents} events</span>
                <span>
                  Scheduler {response().scheduler.status}
                  {response().scheduler.participants === null
                    ? ""
                    : ` · ${response().scheduler.participants} project participants`}
                </span>
                <span>{coverageLabel(response())}</span>
              </div>
              <Show
                when={sessions().length > 0}
                fallback={
                  <div class="lazers-radar-note" role="status">
                    No authorized session records were returned. Inventory and event coverage are
                    shown above; this does not prove no workers exist.
                  </div>
                }
              >
                <section class="lazers-radar-monitor-sessions" aria-label="Sessions">
                  <For each={sessionIDs()}>
                    {(id) => {
                      const session = () => sessionByID().get(id)
                      return (
                        <button
                          type="button"
                          class="lazers-radar-monitor-session"
                          aria-pressed={selectedSessionID() === id}
                          aria-label={`${session()?.isCurrentArchitect === true ? "Current Architect" : session()?.isViewSession ? "Current view session" : (session()?.classification ?? "unknown")} session ${id}, ${session() ? sessionStateLabel(session()!) : "unavailable"}`}
                          onClick={() => props.onSelectSession(id)}
                        >
                          <span class="lazers-radar-monitor-session-title">
                            <strong>
                              {session()?.isCurrentArchitect === true
                                ? "Current Architect"
                                : session()?.isViewSession
                                  ? "Current session"
                                  : session()?.classification === "managed"
                                    ? "Managed"
                                    : "Session"}
                            </strong>
                            <code style={{ "font-family": props.monoFont }}>{id}</code>
                          </span>
                          <span class="lazers-radar-monitor-session-state">
                            {session() ? sessionStateLabel(session()!) : "Session unavailable"}
                          </span>
                          <span class="lazers-radar-monitor-session-task">
                            {session()?.assignment
                              ? `Task ${shortID(session()!.assignment!.taskID)} · Attempt ${shortID(session()!.assignment!.attemptID)} · ${session()!.assignment!.state}`
                              : "Task association unavailable"}
                          </span>
                          <span class="lazers-radar-monitor-session-route">
                            Observed {routeLabel(response(), session()?.observedRouteID ?? null)}
                          </span>
                          <span class="lazers-radar-monitor-session-configured">
                            Configured{" "}
                            {routeLabel(response(), session()?.configuredRouteID ?? null)}
                          </span>
                        </button>
                      )
                    }}
                  </For>
                </section>
              </Show>

              <section class="lazers-radar-monitor-calls" aria-label="Concurrent tool calls">
                <h3>Tool calls · {calls().length} returned</h3>
                <Show
                  when={calls().length > 0}
                  fallback={
                    <p class="lazers-radar-monitor-empty">
                      No tool calls in this observation. Missing or bounded telemetry is not
                      inactivity.
                    </p>
                  }
                >
                  <div class="lazers-radar-monitor-call-list">
                    <For each={callIDs()}>
                      {(id) => {
                        const call = () => callByID().get(id)
                        return (
                          <article
                            class="lazers-radar-monitor-call"
                            data-status={call()?.status ?? "unknown"}
                          >
                            <button
                              type="button"
                              class="lazers-radar-monitor-call-select"
                              aria-pressed={selectedCallID() === id}
                              onClick={() => {
                                setSelectedCallID(id)
                                setSelectedTarget(null)
                                setSelectedEventID(null)
                              }}
                            >
                              <strong>{call()?.tool ?? "Unknown tool"}</strong>
                              <span>{call() ? callStateLabel(call()!.status) : "Unknown"}</span>
                              <span>{call() ? duration(call()!) : "Duration unavailable"}</span>
                              <code style={{ "font-family": props.monoFont }}>
                                {shortID(call()?.callID ?? id)}
                              </code>
                            </button>
                            <div class="lazers-radar-monitor-targets">
                              <Show
                                when={call()?.fileTargets}
                                fallback={
                                  <span class="lazers-radar-monitor-target-unknown">
                                    File target unknown · not observed
                                  </span>
                                }
                              >
                                {(target) => (
                                  <>
                                    <span class="lazers-radar-monitor-target-coverage">
                                      {target().coverage === "observed"
                                        ? `${target().operation ?? "File"} requested`
                                        : `File target ${target().coverage}`}
                                    </span>
                                    <For each={target().paths}>
                                      {(path) => (
                                        <button
                                          type="button"
                                          class="lazers-radar-monitor-target"
                                          aria-pressed={
                                            selectedCallID() === id && selectedTarget() === path
                                          }
                                          onClick={() => {
                                            setSelectedCallID(id)
                                            setSelectedTarget(path)
                                            setSelectedEventID(null)
                                          }}
                                        >
                                          <code style={{ "font-family": props.monoFont }}>
                                            {path}
                                          </code>
                                        </button>
                                      )}
                                    </For>
                                  </>
                                )}
                              </Show>
                            </div>
                          </article>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </section>

              <section class="lazers-radar-monitor-stream" aria-label="Observed activity stream">
                <h3>Observed activity · {flow().length} returned</h3>
                <Show
                  when={flow().length > 0}
                  fallback={
                    <p class="lazers-radar-monitor-empty">
                      No supported native metadata signal is retained in this read. Prior unassigned
                      history is unavailable and is not reconstructed; this does not establish
                      inactivity.
                    </p>
                  }
                >
                  <div class="lazers-radar-monitor-flow">
                    <For each={flowIDs()}>
                      {(id) => {
                        const item = () => flowByID().get(id)
                        return (
                          <button
                            type="button"
                            class="lazers-radar-monitor-flow-row"
                            aria-pressed={selectedEventID() === id}
                            onClick={() => {
                              setSelectedEventID(id)
                              setSelectedCallID(null)
                              setSelectedTarget(null)
                            }}
                          >
                            <strong>{item()?.kind ?? "Observed event"}</strong>
                            <span>{item()?.status ?? "unknown"}</span>
                            <span>{item()?.tool ? `Tool ${item()!.tool}` : ""}</span>
                            <span>{item()?.agent ? `Agent ${item()!.agent}` : ""}</span>
                            <span>
                              {item()?.routeID
                                ? routeLabel(live()!, item()!.routeID)
                                : "Observed route unavailable"}
                            </span>
                            <span>{timestamp(item()?.observedAt)}</span>
                            <span>
                              {item()?.messageID
                                ? `Message ${shortID(item()!.messageID!)}`
                                : "Message identity unavailable"}
                            </span>
                            <span>{item()?.callID ? `Call ${shortID(item()!.callID!)}` : ""}</span>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </section>
            </>
          )}
        </Show>
      </div>

      <div
        class="lazers-radar-separator"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize live activity and session details"
        aria-valuemin={32}
        aria-valuemax={78}
        aria-valuenow={Math.round(split())}
        tabIndex={0}
        onKeyDown={resizeByKey}
        onPointerDown={pointerDown}
      />

      <section
        class="lazers-radar-detail lazers-radar-monitor-inspector"
        aria-label="Selected session details"
      >
        <Show
          when={selectedSession()}
          fallback={
            <p class="lazers-radar-monitor-empty">
              Select a returned session to inspect its observed activity.
            </p>
          }
        >
          {(session) => (
            <>
              <h3>Selected session</h3>
              <dl class="lazers-radar-monitor-detail-grid">
                <dt>Session</dt>
                <dd>
                  <code style={{ "font-family": props.monoFont }}>{session().sessionID}</code>
                </dd>
                <dt>View identity</dt>
                <dd>
                  {session().isCurrentArchitect === true
                    ? "Current Architect · exact view session and native architect agent"
                    : session().isViewSession
                      ? session().isCurrentArchitect === false
                        ? "Current view session · native agent is not Architect"
                        : "Current view session · Architect identity unknown"
                      : session().classification}
                </dd>
                <dt>Association</dt>
                <dd>
                  {session().classification} ·{" "}
                  {session().assignment ? `Task ${session().assignment!.taskID}` : "task unknown"}
                </dd>
                <dt>Health / wait</dt>
                <dd>
                  {sessionStateLabel(session())}; agent {session().agent ?? "unknown"}
                </dd>
                <dt>Configured route</dt>
                <dd>{routeLabel(live()!, session().configuredRouteID)}</dd>
                <dt>Observed route</dt>
                <dd>{routeLabel(live()!, session().observedRouteID)}</dd>
                <dt>Observed at</dt>
                <dd>{timestamp(live()?.observedAt)}</dd>
                <dt>Project scheduler</dt>
                <dd>
                  {live()?.scheduler.status ?? "unknown"}
                  {live()?.scheduler.participants === null ||
                  live()?.scheduler.participants === undefined
                    ? " · participant count unknown"
                    : ` · ${live()!.scheduler.participants} exact-key participants`}
                  {" · pause state is not represented"}
                </dd>
              </dl>

              <Show when={selectedCall()}>
                {(call) => (
                  <div class="lazers-radar-monitor-selected-detail">
                    <h3>Selected call</h3>
                    <dl class="lazers-radar-monitor-detail-grid">
                      <dt>Call / tool</dt>
                      <dd>
                        {call().callID} · {call().tool ?? "tool unknown"}
                      </dd>
                      <dt>Lifecycle</dt>
                      <dd>
                        {callStateLabel(call().status)} · execution {call().execution ?? "unknown"}
                      </dd>
                      <dt>Timing</dt>
                      <dd>
                        Started {timestamp(requestTime(call()))}; duration {duration(call())};
                        observed {timestamp(call().observedAt)}
                      </dd>
                      <dt>Target coverage</dt>
                      <dd>
                        {call().fileTargets?.coverage ?? "unknown"} · requested target is not proof
                        of permission or change
                      </dd>
                      <Show when={call().error}>
                        <dt>Failure</dt>
                        <dd>{call().error}</dd>
                      </Show>
                    </dl>
                    <Show when={selectedTarget()}>
                      <p class="lazers-radar-monitor-selected-target">
                        Selected requested target:{" "}
                        <code style={{ "font-family": props.monoFont }}>{selectedTarget()}</code>
                      </p>
                    </Show>
                  </div>
                )}
              </Show>

              <Show when={selectedFlow()}>
                {(item) => (
                  <div class="lazers-radar-monitor-selected-detail">
                    <h3>Selected observed event</h3>
                    <dl class="lazers-radar-monitor-detail-grid">
                      <dt>Kind / status</dt>
                      <dd>
                        {item().kind} · {item().status}
                      </dd>
                      <dt>Message / call</dt>
                      <dd>
                        {item().messageID ?? "message unknown"} · {item().callID ?? "call unknown"}
                      </dd>
                      <dt>Source</dt>
                      <dd>
                        {item().source} · {item().sourceEventType ?? "event type unavailable"} ·{" "}
                        {item().sourceEventID ?? "event ID unavailable"}
                      </dd>
                      <dt>Source sequence</dt>
                      <dd>
                        {item().sourceProgressSequence === null
                          ? `Native revision ${item().sourceNativeRevision ?? "unavailable"}`
                          : `Runner progress ${item().sourceProgressSequence}`}
                      </dd>
                      <dt>Observed</dt>
                      <dd>
                        {timestamp(item().observedAt)} · Unix ms {item().observedAt}
                      </dd>
                    </dl>
                  </div>
                )}
              </Show>

              <details class="lazers-radar-monitor-history">
                <summary>
                  Selected session history · {props.data().history?.items.length ?? 0} returned
                  {props.data().history?.coverage.hasMore ? " · more available" : ""}
                </summary>
                <Show when={props.data().historyLoading}>
                  <p role="status">Loading selected history…</p>
                </Show>
                <Show when={props.data().historyError}>
                  <p role="alert">{props.data().historyError}</p>
                </Show>
                <Show when={props.data().history}>
                  {(history) => (
                    <ol class="lazers-radar-monitor-history-list">
                      <For each={history().items}>
                        {(item) => (
                          <li>
                            <strong>{item.tool ?? item.kind}</strong>
                            <span>{item.status ?? "status unknown"}</span>
                            <time>{timestamp(item.at)}</time>
                            <Show when={item.fileTargets}>
                              {(targets) => (
                                <span>
                                  {targets().coverage} file target ·{" "}
                                  {targets().paths.join(", ") || "path omitted"}
                                </span>
                              )}
                            </Show>
                            <Show when={item.error}>
                              <span>{item.error}</span>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ol>
                  )}
                </Show>
                <Show when={props.data().history?.nextCursor}>
                  <button
                    type="button"
                    onClick={props.onLoadMoreHistory}
                    disabled={props.data().historyLoading}
                  >
                    Load older history
                  </button>
                </Show>
                <Show
                  when={props.data().history && props.data().history!.coverage.payloadTruncated}
                >
                  <p role="status">
                    History payload coverage is bounded; omitted data is not reconstructed.
                  </p>
                </Show>
              </details>

              <details class="lazers-radar-monitor-coverage-detail">
                <summary>Coverage and observation boundary</summary>
                <Show when={live()}>
                  {(response) => (
                    <dl class="lazers-radar-monitor-detail-grid">
                      <dt>Runner</dt>
                      <dd>{response().freshness.runner}</dd>
                      <dt>Native inventory</dt>
                      <dd>{response().freshness.nativeInventory}</dd>
                      <dt>Native events</dt>
                      <dd>{response().freshness.nativeEvents}</dd>
                      <dt>Journal</dt>
                      <dd>{response().coverage.journal}</dd>
                      <dt>Read limits</dt>
                      <dd>
                        {response().coverage.sourceRowsRead} returned source rows ·{" "}
                        {response().coverage.sourceQueries} queries ·{" "}
                        {response().coverage.sourceBytesRead} bytes
                      </dd>
                      <dt>Context loads</dt>
                      <dd>{response().coverage.nativeContextLoads}</dd>
                      <dt>Boundary</dt>
                      <dd>
                        Unix ms {response().observedAt} · event {response().boundary.eventSequence}{" "}
                        · runner revision {response().boundary.runnerRevision ?? "unavailable"}
                      </dd>
                    </dl>
                  )}
                </Show>
              </details>
            </>
          )}
        </Show>
      </section>
    </div>
  )
}

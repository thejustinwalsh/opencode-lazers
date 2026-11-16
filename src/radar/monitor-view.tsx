import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import type { Ui } from "@opencode/plugin/gui"
import type { ObservationScope } from "../observability/contract.ts"
import type { RadarMonitorData } from "./monitor-state.ts"
import {
  callStatusWord,
  clockTime,
  connectionStatus,
  coverageGaps,
  flowIcon,
  flowPhase,
  formatAge,
  formatDuration,
  lineView,
  monitorSummary,
  sessionGroups,
  recentFlow,
  routeDetail,
  sessionActivity,
  sessionModel,
  sessionRole,
  sessionState,
  sessionTask,
  shortID,
} from "./monitor-model.ts"
import type { ActivityLine, LiveFlow, LiveSession } from "./monitor-model.ts"

export const MONITOR_SPLIT = { min: 28, max: 80, initial: 60 } as const

export function clampMonitorSplit(value: number) {
  return Number.isFinite(value)
    ? Math.max(MONITOR_SPLIT.min, Math.min(MONITOR_SPLIT.max, value))
    : MONITOR_SPLIT.initial
}

export type MonitorScopeChoice = "session" | "project" | "project-all"

type Props = {
  ui: Ui
  data: Accessor<RadarMonitorData>
  scope: ObservationScope
  anchorSessionID: string
  includeUnmanagedSessions: boolean
  monoFont: string
  split: number
  onSplitChange: (value: number, commit: boolean) => void
  onScopeChange: (choice: MonitorScopeChoice) => void
  onSelectSession: (sessionID: string) => void
  onRefresh: () => void
  onLoadMoreHistory: () => void
  onOpenDiagnostics: () => void
  onOpenWorker?: (sessionID: string) => void
  onOpenTask?: (taskID: string) => void
  onOpenTrajectory?: (taskID: string) => void
}

type Selection = { kind: "call" | "flow"; id: string } | null

const SCOPE_LABEL: Record<MonitorScopeChoice, string> = {
  session: "This session",
  project: "Project",
  "project-all": "Project · all sessions",
}

export function RadarMonitorView(props: Props) {
  const Ui = props.ui
  const [selection, setSelection] = createSignal<Selection>(null)
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(clock))
  let root: HTMLDivElement | undefined
  let header: HTMLElement | undefined

  const live = () => props.data().live
  const sessions = () => live()?.sessions ?? []
  const sessionIDs = createMemo(() => sessions().map((session) => session.sessionID))
  const groups = createMemo(() =>
    live() ? sessionGroups(live()!) : { leading: [] as string[], unavailable: [] as string[] },
  )
  const [showUnavailable, setShowUnavailable] = createSignal(false)
  const sessionByID = createMemo(
    () => new Map(sessions().map((session) => [session.sessionID, session])),
  )
  const activity = createMemo(() => {
    const response = live()
    return new Map(
      response
        ? response.sessions.map((session) => [
            session.sessionID,
            sessionActivity(response, session),
          ])
        : [],
    )
  })
  const lineByID = createMemo(
    () =>
      new Map(
        [...activity().values()].flatMap((item) => item.lines.map((line) => [line.id, line])),
      ),
  )
  const flowItems = createMemo(() => (live() ? recentFlow(live()!) : []))
  const flowIDs = createMemo(() => flowItems().map((item) => item.id))
  const flowByID = createMemo(() => new Map((live()?.flow ?? []).map((item) => [item.id, item])))

  const selectedSessionID = () =>
    props.data().selectedSessionID ??
    sessions().find((session) => session.sessionID === props.anchorSessionID)?.sessionID ??
    sessionIDs()[0] ??
    null
  const selectedSession = () => {
    const id = selectedSessionID()
    return id ? sessionByID().get(id) : undefined
  }
  /** A selected call or event only counts while it belongs to the selected session. */
  const selectedLine = () => {
    const current = selection()
    if (current?.kind !== "call") return undefined
    const line = lineByID().get(current.id)
    return line?.kind === "call" && line.sessionID === selectedSessionID() ? line : undefined
  }
  const selectedFlow = () => {
    const current = selection()
    if (current?.kind !== "flow") return undefined
    const item = flowByID().get(current.id)
    return item && item.sessionID === selectedSessionID() ? item : undefined
  }

  const chooseSession = (sessionID: string) => {
    if (props.data().selectedSessionID !== sessionID) props.onSelectSession(sessionID)
  }
  const chooseLine = (line: ActivityLine) => {
    chooseSession(line.sessionID)
    if (line.kind === "call") setSelection({ kind: "call", id: line.id })
    else if (line.kind === "phase") setSelection({ kind: "flow", id: line.flow.id })
    else setSelection(null)
  }
  const chooseFlow = (item: LiveFlow) => {
    chooseSession(item.sessionID)
    setSelection({ kind: "flow", id: item.id })
  }

  const status = () => connectionStatus(props.data())
  const scopeChoice = (): MonitorScopeChoice =>
    props.scope.kind === "session"
      ? "session"
      : props.includeUnmanagedSessions
        ? "project-all"
        : "project"
  const runningEnd = () => (props.data().stale && live() ? live()!.observedAt : now())
  const lineDuration = (line: ActivityLine) => {
    if (line.kind === "note" || line.startedAt === null) return ""
    const end = line.endedAt ?? (line.current ? runningEnd() : null)
    if (end === null) return ""
    return `${line.current && props.data().stale ? "≥ " : ""}${formatDuration(end - line.startedAt)}`
  }
  const sessionTitle = (session: LiveSession) => {
    const task = sessionTask(session)
    return `${sessionRole(session).label}${task ? ` · ${task}` : ""}`
  }

  const resize = (value: number, commit: boolean) =>
    props.onSplitChange(clampMonitorSplit(value), commit)
  const resizeByKey: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    const steps: Record<string, number> = {
      ArrowUp: -2,
      ArrowDown: 2,
      PageUp: -10,
      PageDown: 10,
    }
    if (event.key === "Home") resize(MONITOR_SPLIT.min, true)
    else if (event.key === "End") resize(MONITOR_SPLIT.max, true)
    else if (event.key in steps) resize(props.split + steps[event.key]!, true)
    else return
    event.preventDefault()
  }
  const pointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    const separator = event.currentTarget
    separator.setPointerCapture(event.pointerId)
    let latest = props.split
    const move = (next: PointerEvent) => {
      const rect = root?.getBoundingClientRect()
      const top = (rect?.top ?? 0) + (header?.offsetHeight ?? 0)
      const usable = (rect?.height ?? 0) - (header?.offsetHeight ?? 0) - separator.offsetHeight
      if (!rect || usable <= 0) return
      latest = clampMonitorSplit(((next.clientY - top) / usable) * 100)
      resize(latest, false)
    }
    const end = () => {
      separator.removeEventListener("pointermove", move)
      separator.removeEventListener("pointerup", end)
      separator.removeEventListener("pointercancel", end)
      resize(latest, true)
    }
    separator.addEventListener("pointermove", move)
    separator.addEventListener("pointerup", end, { once: true })
    separator.addEventListener("pointercancel", end, { once: true })
  }

  const Mono = (local: { children: JSX.Element; title?: string }) => (
    <code style={{ "font-family": props.monoFont }} title={local.title}>
      {local.children}
    </code>
  )

  const ActivityLineButton = (local: { id: string }) => {
    const line = () => lineByID().get(local.id)
    const view = () => (line() ? lineView(line()!) : undefined)
    const pressed = () => {
      const value = line()
      return value?.kind === "call"
        ? selectedLine()?.id === value.id
        : value?.kind === "phase"
          ? selectedFlow()?.id === value.flow.id
          : false
    }
    return (
      <Show when={view()}>
        {(value) => (
          <Show
            when={value().selectable}
            fallback={
              <span class="lazers-radar-line lazers-radar-line-note">
                <span class="lazers-radar-line-icon" aria-hidden="true">
                  <Ui.Icon name={value().icon} size="small" />
                </span>
                <span class="lazers-radar-line-label">{value().label}</span>
              </span>
            }
          >
            <button
              type="button"
              class="lazers-radar-line"
              data-status={value().status}
              data-current={value().current}
              aria-pressed={pressed()}
              onClick={() => chooseLine(line()!)}
            >
              <span class="lazers-radar-line-icon" aria-hidden="true">
                <Ui.Icon name={value().icon} size="small" />
              </span>
              <span class="lazers-radar-line-label">{value().label}</span>
              <Show
                when={value().target}
                fallback={
                  <Show when={value().targetNote}>
                    <span class="lazers-radar-line-target-note">{value().targetNote}</span>
                  </Show>
                }
              >
                {(target) => (
                  <span class="lazers-radar-line-target" title={target()}>
                    <Mono>{target()}</Mono>
                    <Show when={value().extraTargets > 0}>
                      <span> +{value().extraTargets}</span>
                    </Show>
                  </span>
                )}
              </Show>
              <span class="lazers-radar-line-duration">{lineDuration(line()!)}</span>
              <Show when={value().error}>
                {(error) => <span class="lazers-radar-line-error">{error()}</span>}
              </Show>
            </button>
          </Show>
        )}
      </Show>
    )
  }

  const SessionRow = (local: { id: string }) => {
    const session = () => sessionByID().get(local.id)
    const lineIDs = createMemo(
      () =>
        activity()
          .get(local.id)
          ?.lines.map((line) => line.id) ?? [],
    )
    const lastActivity = () => activity().get(local.id)?.lastActivityAt ?? null
    const model = () => (session() && live() ? sessionModel(live()!, session()!) : undefined)
    const age = () => (lastActivity() === null ? "" : formatAge(now() - lastActivity()!))
    return (
      <Show when={session()}>
        {(value) => (
          <li
            class="lazers-radar-session"
            data-selected={selectedSessionID() === local.id}
            data-state={value().state}
            data-available={value().availability === "available"}
          >
            <button
              type="button"
              class="lazers-radar-session-main"
              aria-pressed={selectedSessionID() === local.id}
              aria-label={[
                sessionTitle(value()),
                sessionState(value()),
                model()?.label ? `model ${model()!.label}` : "model not observed",
                age() ? `last activity ${age()}` : "",
              ]
                .filter(Boolean)
                .join(", ")}
              title={`Session ${value().sessionID}`}
              onClick={() => {
                chooseSession(local.id)
                setSelection(null)
              }}
            >
              <span class="lazers-radar-session-icon" aria-hidden="true">
                <Ui.Icon name={sessionRole(value()).icon} size="small" />
              </span>
              <span class="lazers-radar-session-identity">
                <strong>{sessionRole(value()).label}</strong>
                <Show when={sessionTask(value())}>
                  {(task) => <span class="lazers-radar-session-task"> · {task()}</span>}
                </Show>
              </span>
              <span
                class="lazers-radar-session-model"
                data-basis={model()?.basis ?? "none"}
                title={model()?.detail}
              >
                {model()?.label ? model()!.label : "Model not observed"}
                <Show when={model()?.basis === "configured"}>
                  <span class="lazers-radar-session-basis"> · configured</span>
                </Show>
              </span>
              <span class="lazers-radar-session-state">{sessionState(value())}</span>
              <time
                class="lazers-radar-session-age"
                dateTime={
                  lastActivity() === null ? undefined : new Date(lastActivity()!).toISOString()
                }
                title={
                  lastActivity() === null ? undefined : `Last activity ${clockTime(lastActivity())}`
                }
              >
                {age()}
              </time>
            </button>
            <Show when={lineIDs().length > 0}>
              <ul
                class="lazers-radar-session-lines"
                aria-label={`${sessionTitle(value())} activity`}
              >
                <For each={lineIDs()}>
                  {(id) => (
                    <li>
                      <ActivityLineButton id={id} />
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </li>
        )}
      </Show>
    )
  }

  const FlowRow = (local: { id: string }) => {
    const item = () => flowByID().get(local.id)
    const owner = () => (item() ? sessionByID().get(item()!.sessionID) : undefined)
    return (
      <Show when={item()}>
        {(value) => (
          <li>
            <button
              type="button"
              class="lazers-radar-flow-row"
              aria-pressed={selectedFlow()?.id === local.id}
              onClick={() => chooseFlow(value())}
            >
              <span class="lazers-radar-line-icon" aria-hidden="true">
                <Ui.Icon name={flowIcon(value())} size="small" />
              </span>
              <time class="lazers-radar-flow-time" style={{ "font-family": props.monoFont }}>
                {clockTime(value().observedAt)}
              </time>
              <span class="lazers-radar-flow-label">
                <span class="lazers-radar-flow-subject">
                  {owner() ? sessionTitle(owner()!) : `Session ${shortID(value().sessionID)}`}
                </span>
                {" / "}
                {flowPhase(value(), live()).label}
                <Show when={value().kind !== "tool-phase" && live()}>
                  <Show when={routeDetail(live()!, value().routeID)}>
                    {(route) => <span class="lazers-radar-flow-route"> · {route()}</span>}
                  </Show>
                </Show>
              </span>
            </button>
          </li>
        )}
      </Show>
    )
  }

  const Links = (local: { session: LiveSession }) => (
    <div class="lazers-radar-links">
      <Show when={props.onOpenWorker}>
        <Ui.Button
          variant="ghost"
          size="small"
          icon="square-arrow-top-right"
          onClick={() => props.onOpenWorker!(local.session.sessionID)}
        >
          Open worker
        </Ui.Button>
      </Show>
      <Show when={local.session.assignment && props.onOpenTask}>
        <Ui.Button
          variant="ghost"
          size="small"
          icon="square-arrow-top-right"
          onClick={() => props.onOpenTask!(local.session.assignment!.taskID)}
        >
          Open task
        </Ui.Button>
      </Show>
      <Show when={local.session.assignment && props.onOpenTrajectory}>
        <Ui.Button
          variant="ghost"
          size="small"
          icon="square-arrow-top-right"
          onClick={() => props.onOpenTrajectory!(local.session.assignment!.taskID)}
        >
          Open trajectory
        </Ui.Button>
      </Show>
    </div>
  )

  return (
    <div
      class="lazers-radar lazers-radar-monitor"
      ref={(element) => (root = element)}
      style={{
        "--radar-visual-fr": `${props.split}fr`,
        "--radar-detail-fr": `${100 - props.split}fr`,
      }}
    >
      <header class="lazers-radar-monitor-header" ref={(element) => (header = element)}>
        <div class="lazers-radar-monitor-bar">
          <h2>Radar</h2>
          <span class="lazers-radar-scope">
            <Ui.Menu
              label={SCOPE_LABEL[scopeChoice()]}
              trigger="button"
              icon="chevron-down"
              placement="bottom-start"
              items={(["session", "project", "project-all"] as const).map((choice) => ({
                label: SCOPE_LABEL[choice],
                icon: choice === scopeChoice() ? ("check-small" as const) : undefined,
                onSelect: () => props.onScopeChange(choice),
              }))}
            />
          </span>
          <span class="lazers-radar-connection" data-state={status().state} title={status().detail}>
            <span class="lazers-radar-connection-dot" aria-hidden="true" />
            <span role="status">{status().word}</span>
          </span>
          <Ui.Menu
            label="Radar actions"
            icon="outline-dots"
            items={[
              { label: "Refresh", icon: "refresh", onSelect: props.onRefresh },
              { label: "Diagnostics", icon: "window-analytics", onSelect: props.onOpenDiagnostics },
            ]}
          />
        </div>
        <Show when={live()}>
          {(response) => (
            <details class="lazers-radar-monitor-status">
              <summary>
                <span class="lazers-radar-monitor-summary">
                  <Ui.Icon name="settings-gear" size="small" />
                  <span>{monitorSummary(response())}</span>
                </span>
              </summary>
              <dl class="lazers-radar-facts">
                <dt>Scheduler</dt>
                <dd>
                  {response().scheduler.status}
                  {response().scheduler.participants === null
                    ? ""
                    : ` · ${response().scheduler.participants} participants`}
                </dd>
                <dt>Sessions</dt>
                <dd>
                  {response().coverage.sessionCount} returned ·{" "}
                  {response().coverage.managedSessionCount} managed
                </dd>
                <dt>Runner</dt>
                <dd>{response().freshness.runner}</dd>
                <dt>Inventory</dt>
                <dd>{response().freshness.nativeInventory}</dd>
                <dt>Events</dt>
                <dd>{response().freshness.nativeEvents}</dd>
                <dt>Journal</dt>
                <dd>{response().coverage.journal}</dd>
                <dt>Omitted</dt>
                <dd>{coverageGaps(response()).join(", ") || "None reported"}</dd>
                <dt>Observed</dt>
                <dd>
                  {clockTime(response().observedAt)} · event {response().boundary.eventSequence}
                </dd>
              </dl>
            </details>
          )}
        </Show>
      </header>

      <div
        id="lazers-radar-monitor-activity"
        class="lazers-radar-visual lazers-radar-monitor-activity"
        role="region"
        aria-label="Live session activity"
      >
        <Show when={props.data().error}>
          <div class="lazers-radar-note" data-error="true" role="alert">
            <span>{props.data().error}</span>
            <Ui.Button variant="ghost" size="small" onClick={props.onRefresh}>
              Retry
            </Ui.Button>
          </div>
        </Show>
        <Show
          when={live()}
          fallback={
            <Show
              when={props.data().loading}
              fallback={
                <p class="lazers-radar-note">
                  Live session activity is unavailable. Nothing can be concluded about workers.
                </p>
              }
            >
              <p class="lazers-radar-note lazers-radar-loading">
                <Ui.Loader size="small" />
                <span>Loading live activity…</span>
              </p>
            </Show>
          }
        >
          {(response) => (
            <>
              <Show
                when={sessions().length > 0}
                fallback={
                  <p class="lazers-radar-note">
                    No sessions returned for this scope.
                    {response().freshness.nativeInventory === "complete"
                      ? ""
                      : ` Session inventory is ${response().freshness.nativeInventory}, so some sessions may be missing.`}
                  </p>
                }
              >
                <Show when={groups().leading.length > 0}>
                  <ul class="lazers-radar-sessions" aria-label="Sessions">
                    <For each={groups().leading}>{(id) => <SessionRow id={id} />}</For>
                  </ul>
                </Show>
                <Show when={groups().unavailable.length > 0}>
                  <details
                    class="lazers-radar-unavailable"
                    open={
                      showUnavailable() || groups().unavailable.includes(selectedSessionID() ?? "")
                    }
                    onToggle={(event) => setShowUnavailable(event.currentTarget.open)}
                  >
                    <summary>
                      {groups().unavailable.length} unavailable{" "}
                      {groups().unavailable.length === 1 ? "session" : "sessions"}
                    </summary>
                    <ul class="lazers-radar-sessions" aria-label="Unavailable sessions">
                      <For each={groups().unavailable}>{(id) => <SessionRow id={id} />}</For>
                    </ul>
                  </details>
                </Show>
              </Show>
              <section class="lazers-radar-recent" aria-labelledby="lazers-radar-recent-title">
                <h3 id="lazers-radar-recent-title">Recent activity</h3>
                <Show
                  when={flowIDs().length > 0}
                  fallback={
                    <p class="lazers-radar-note">
                      No model or tool events in this read. Missing telemetry is not inactivity.
                    </p>
                  }
                >
                  <ol class="lazers-radar-flow-list">
                    <For each={flowIDs()}>{(id) => <FlowRow id={id} />}</For>
                  </ol>
                </Show>
              </section>
            </>
          )}
        </Show>
      </div>

      <div
        class="lazers-radar-separator"
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label="Resize activity and details"
        aria-controls="lazers-radar-monitor-activity lazers-radar-monitor-inspector"
        aria-valuemin={MONITOR_SPLIT.min}
        aria-valuemax={MONITOR_SPLIT.max}
        aria-valuenow={Math.round(props.split)}
        aria-valuetext={`Activity ${Math.round(props.split)}% of the panel`}
        onKeyDown={resizeByKey}
        onPointerDown={pointerDown}
      />

      <section
        id="lazers-radar-monitor-inspector"
        class="lazers-radar-detail lazers-radar-monitor-inspector"
        aria-label="Selected session details"
      >
        <Show
          when={selectedSession()}
          fallback={
            <p class="lazers-radar-note">Select a session to see its details and history.</p>
          }
        >
          {(session) => (
            <>
              <header class="lazers-radar-inspector-head">
                <span class="lazers-radar-inspector-icon" aria-hidden="true">
                  <Ui.Icon name={sessionRole(session()).icon} size="small" />
                </span>
                <h3>
                  {sessionTitle(session())}
                  <Show when={selectedLine()}>
                    {(line) => <span class="lazers-radar-inspector-sub"> · {line().tool}</span>}
                  </Show>
                  <Show when={selectedFlow()}>
                    {(item) => (
                      <span class="lazers-radar-inspector-sub">
                        {" "}
                        · {flowPhase(item(), live()).label}
                      </span>
                    )}
                  </Show>
                </h3>
                <span class="lazers-radar-inspector-state">
                  <Show when={selectedLine()} fallback={sessionState(session())}>
                    {(line) => (
                      <>
                        {callStatusWord(line().status)}
                        <Show when={lineDuration(line())}> · {lineDuration(line())}</Show>
                      </>
                    )}
                  </Show>
                </span>
              </header>

              <Show when={selectedLine()}>
                {(line) => (
                  <div class="lazers-radar-inspector-block">
                    <Show
                      when={(line().record?.fileTargets?.paths.length ?? 0) > 0}
                      fallback={
                        <p class="lazers-radar-inspector-muted">
                          {line().targetNote ??
                            (line().record
                              ? "No file target recorded for this call."
                              : "File activity is unavailable for this session's calls.")}
                        </p>
                      }
                    >
                      <ul class="lazers-radar-inspector-paths" aria-label="Requested files">
                        <For each={line().record!.fileTargets!.paths}>
                          {(path) => (
                            <li>
                              <Ui.Icon name="file-document" size="small" />
                              <Mono>{path}</Mono>
                            </li>
                          )}
                        </For>
                      </ul>
                      <p class="lazers-radar-inspector-muted">
                        {line().record!.fileTargets!.coverage === "observed"
                          ? `Requested ${line().record!.fileTargets!.operation ?? "file"} target; not a confirmed change.`
                          : "Target list is partial; omitted paths are not reconstructed."}
                      </p>
                    </Show>
                    <Show when={line().error}>
                      <p class="lazers-radar-inspector-error">{line().error}</p>
                    </Show>
                    <Show when={line().record?.result}>
                      <p class="lazers-radar-inspector-muted">{line().record!.result}</p>
                    </Show>
                    <dl class="lazers-radar-facts">
                      <dt>Started</dt>
                      <dd>{clockTime(line().startedAt)}</dd>
                      <Show when={line().endedAt !== null}>
                        <dt>Ended</dt>
                        <dd>{clockTime(line().endedAt)}</dd>
                      </Show>
                      <dt>Call</dt>
                      <dd>
                        <Mono>{line().callID}</Mono>
                      </dd>
                    </dl>
                  </div>
                )}
              </Show>

              <Show when={selectedFlow()}>
                {(item) => (
                  <dl class="lazers-radar-facts lazers-radar-inspector-block">
                    <dt>Observed</dt>
                    <dd>{clockTime(item().observedAt)}</dd>
                    <Show when={item().startedAt !== null}>
                      <dt>Started</dt>
                      <dd>{clockTime(item().startedAt)}</dd>
                    </Show>
                    <Show when={live() && routeDetail(live()!, item().routeID)}>
                      <dt>Model</dt>
                      <dd>{routeDetail(live()!, item().routeID)}</dd>
                    </Show>
                    <Show when={item().tool}>
                      <dt>Tool</dt>
                      <dd>{item().tool}</dd>
                    </Show>
                    <Show when={item().messageID}>
                      <dt>Message</dt>
                      <dd>
                        <Mono>{item().messageID}</Mono>
                      </dd>
                    </Show>
                    <Show when={item().callID}>
                      <dt>Call</dt>
                      <dd>
                        <Mono>{item().callID}</Mono>
                      </dd>
                    </Show>
                  </dl>
                )}
              </Show>

              <Show when={!selectedLine() && !selectedFlow()}>
                <dl class="lazers-radar-facts lazers-radar-inspector-block">
                  <dt>Model</dt>
                  <dd>{live() ? sessionModel(live()!, session()).detail : "Unavailable"}</dd>
                  <dt>Agent</dt>
                  <dd>{session().agent ?? "Not reported"}</dd>
                  <Show when={session().assignment}>
                    {(assignment) => (
                      <>
                        <dt>Attempt</dt>
                        <dd>
                          {sessionState(session())} since {clockTime(assignment().startedAt)}
                        </dd>
                      </>
                    )}
                  </Show>
                  <dt>Session</dt>
                  <dd>
                    <Mono>{session().sessionID}</Mono>
                  </dd>
                </dl>
              </Show>

              <Links session={session()} />

              <details class="lazers-radar-disclosure lazers-radar-monitor-history">
                <summary>
                  History
                  <Show when={props.data().history}>
                    {(history) => (
                      <span class="lazers-radar-inspector-muted">
                        {" "}
                        · {history().items.length}
                        {history().coverage.hasMore ? "+" : ""}
                      </span>
                    )}
                  </Show>
                </summary>
                <Show when={props.data().historyLoading}>
                  <p class="lazers-radar-note lazers-radar-loading">
                    <Ui.Loader size="small" />
                    <span>Loading history…</span>
                  </p>
                </Show>
                <Show when={props.data().historyError}>
                  <p class="lazers-radar-note" data-error="true">
                    {props.data().historyError}
                  </p>
                </Show>
                <Show when={props.data().history}>
                  {(history) => (
                    <ol class="lazers-radar-history">
                      <For each={history().items}>
                        {(item) => (
                          <li>
                            <time style={{ "font-family": props.monoFont }}>
                              {clockTime(item.at)}
                            </time>
                            <span>
                              {item.tool ?? item.kind}
                              {item.status ? ` ${item.status}` : ""}
                            </span>
                            <Show
                              when={
                                item.fileTargets?.coverage === "observed" &&
                                item.fileTargets.paths.length > 0
                              }
                            >
                              <Mono>{item.fileTargets!.paths.join(", ")}</Mono>
                            </Show>
                            <Show when={item.error}>
                              <span class="lazers-radar-inspector-error">{item.error}</span>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ol>
                  )}
                </Show>
                <Show when={props.data().history?.nextCursor}>
                  <Ui.Button
                    variant="ghost"
                    size="small"
                    onClick={props.onLoadMoreHistory}
                    disabled={props.data().historyLoading}
                  >
                    Load older
                  </Ui.Button>
                </Show>
              </details>
            </>
          )}
        </Show>
      </section>
    </div>
  )
}

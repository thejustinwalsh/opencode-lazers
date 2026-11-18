import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import type { Ui } from "@opencode/plugin/gui"
import type { ObservationScope } from "../observability/contract.ts"
import type { RadarMonitorData } from "./monitor-state.ts"
import { createPanelStatus, PanelStatus } from "../panel-status.tsx"
import { RadarHeader } from "./radar-header.tsx"
import type { RadarScopeChoice, RadarViewChoice } from "./radar-header.tsx"
import {
  callStatusWord,
  clockTime,
  connectionStatus,
  flowIcon,
  flowPhase,
  formatAge,
  formatDuration,
  idleSentence,
  lineView,
  monitorSegments,
  nothingRunning,
  sessionGroups,
  recentFlow,
  routeDetail,
  sessionActivity,
  sessionCallLines,
  sessionModel,
  sessionRole,
  sessionState,
  sessionTask,
  sessionTone,
} from "./monitor-model.ts"
import type { ActivityLine, LiveFlow, LiveSession } from "./monitor-model.ts"

export const MONITOR_SPLIT = { min: 28, max: 80, initial: 60 } as const

export function clampMonitorSplit(value: number) {
  return Number.isFinite(value)
    ? Math.max(MONITOR_SPLIT.min, Math.min(MONITOR_SPLIT.max, value))
    : MONITOR_SPLIT.initial
}

export type MonitorScopeChoice = RadarScopeChoice

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
  onView: (view: RadarViewChoice) => void
  onOpenTasks?: () => void
  onOpenWorker?: (sessionID: string) => void
  onOpenTask?: (taskID: string) => void
  onOpenTrajectory?: (taskID: string) => void
}

type Selection = { kind: "call" | "flow"; id: string } | null
type InspectorTab = "calls" | "files" | "messages"

export function RadarMonitorView(props: Props) {
  const Ui = props.ui
  const [selection, setSelection] = createSignal<Selection>(null)
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(clock))
  let root: HTMLDivElement | undefined
  let header: HTMLElement | undefined
  let top: HTMLDivElement | undefined
  /** The inspector opens only once the user picks something; nothing is selected at first. */
  const [inspecting, setInspecting] = createSignal(false)
  const [tab, setTab] = createSignal<InspectorTab>("calls")

  const live = () => props.data().live
  const status = createPanelStatus(() => ({
    subject: "live activity",
    hasContent: live() !== undefined,
    loading: props.data().loading,
    disconnected: props.data().connection !== "connected",
    ...(props.data().readError ? { error: props.data().readError! } : {}),
    ...(props.data().asOf !== undefined ? { asOf: props.data().asOf! } : {}),
  }))
  const sessions = () => live()?.sessions ?? []
  const sessionIDs = createMemo(() => sessions().map((session) => session.sessionID))
  const groups = createMemo(() =>
    live()
      ? sessionGroups(live()!)
      : {
          leading: [] as string[],
          children: new Map<string, string[]>(),
          unavailable: [] as string[],
        },
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
  /** Every call of a session, for the inspector's Calls and Files tabs. */
  const callsBySession = createMemo(() => {
    const response = live()
    return new Map(
      response
        ? response.sessions.map((session) => [
            session.sessionID,
            sessionCallLines(response, session.sessionID),
          ])
        : [],
    )
  })
  const lineByID = createMemo(
    () =>
      new Map(
        [
          ...[...activity().values()].flatMap((item) => item.lines),
          ...[...callsBySession().values()].flat(),
        ].map((line) => [line.id, line] as const),
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
    setInspecting(true)
    chooseSession(line.sessionID)
    if (line.kind === "call") setSelection({ kind: "call", id: line.id })
    else if (line.kind === "phase") setSelection({ kind: "flow", id: line.flow.id })
    else setSelection(null)
  }
  const chooseFlow = (item: LiveFlow) => {
    setInspecting(true)
    chooseSession(item.sessionID)
    setSelection({ kind: "flow", id: item.id })
  }

  const connection = () => connectionStatus(props.data())
  const showInspector = () => inspecting() && selectedSession() !== undefined
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
      const chrome = (header?.offsetHeight ?? 0) + (top?.offsetHeight ?? 0)
      const start = (rect?.top ?? 0) + chrome
      const usable = (rect?.height ?? 0) - chrome - separator.offsetHeight
      if (!rect || usable <= 0) return
      latest = clampMonitorSplit(((next.clientY - start) / usable) * 100)
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
    const children = () => groups().children.get(local.id) ?? []
    const lastActivity = () => activity().get(local.id)?.lastActivityAt ?? null
    const model = () => (session() && live() ? sessionModel(live()!, session()!) : undefined)
    const age = () => (lastActivity() === null ? "" : formatAge(now() - lastActivity()!))
    const selected = () => inspecting() && selectedSessionID() === local.id
    return (
      <Show when={session()}>
        {(value) => (
          <li
            class="lazers-radar-session"
            data-selected={selected()}
            data-state={value().state}
            data-tone={sessionTone(value())}
            data-available={value().availability === "available"}
          >
            <button
              type="button"
              class="lazers-radar-session-main"
              aria-pressed={selected()}
              aria-label={[
                sessionTitle(value()),
                sessionState(value()),
                model()?.label ? `model ${model()!.label}` : "",
                age() ? `last activity ${age()}` : "",
              ]
                .filter(Boolean)
                .join(", ")}
              data-session-id={value().sessionID}
              onClick={() => {
                setInspecting(true)
                chooseSession(local.id)
                setSelection(null)
              }}
            >
              <span class="lazers-radar-session-icon" aria-hidden="true">
                <Ui.Icon name={sessionRole(value()).icon} size="small" />
              </span>
              <strong class="lazers-radar-session-role">{sessionRole(value()).label}</strong>
              <span class="lazers-radar-session-task">{sessionTask(value())}</span>
              <Show when={model()}>
                {(item) => (
                  <span class="lazers-radar-session-model" title={item().detail}>
                    {item().label}
                  </span>
                )}
              </Show>
              <Show when={sessionState(value())}>
                {(word) => (
                  <span class="lazers-radar-session-state" data-tone={sessionTone(value())}>
                    {word()}
                  </span>
                )}
              </Show>
              <Show when={age()}>
                <time
                  class="lazers-radar-session-age"
                  dateTime={
                    lastActivity() === null ? undefined : new Date(lastActivity()!).toISOString()
                  }
                  title={
                    lastActivity() === null
                      ? undefined
                      : `Last activity ${clockTime(lastActivity())}`
                  }
                >
                  {age()}
                </time>
              </Show>
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
            <Show when={children().length > 0}>
              <ul class="lazers-radar-session-children" aria-label="Workers">
                <For each={children()}>{(id) => <SessionRow id={id} />}</For>
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
                  {owner() ? sessionTitle(owner()!) : "Session"}
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

  const Actions = (local: { session: LiveSession }) => (
    <div class="lazers-radar-links">
      <Show when={local.session.assignment && props.onOpenTask}>
        <Ui.Button
          variant="ghost"
          size="small"
          onClick={() => props.onOpenTask!(local.session.assignment!.taskID)}
        >
          Open task
        </Ui.Button>
      </Show>
      <Show when={local.session.assignment && props.onOpenTrajectory}>
        <Ui.Button
          variant="ghost"
          size="small"
          onClick={() => props.onOpenTrajectory!(local.session.assignment!.taskID)}
        >
          Trajectory
        </Ui.Button>
      </Show>
      <Show when={props.onOpenWorker}>
        <Ui.Button
          variant="ghost"
          size="small"
          onClick={() => props.onOpenWorker!(local.session.sessionID)}
        >
          Open worker
        </Ui.Button>
      </Show>
    </div>
  )

  /** One facts line; each segment appears only when the read has it. */
  const Facts = (local: { session: LiveSession }) => {
    const model = () => (live() ? sessionModel(live()!, local.session) : undefined)
    const started = () =>
      local.session.assignment ? clockTime(local.session.assignment.startedAt) : ""
    const last = () => {
      const at = activity().get(local.session.sessionID)?.lastActivityAt ?? null
      return at === null ? "" : formatAge(now() - at)
    }
    return (
      <p class="lazers-radar-facts-line">
        <Show when={model()}>{(item) => <span>{item().label}</span>}</Show>
        <Show when={started()}>
          <span>
            <em>started</em> {started()}
          </span>
        </Show>
        <Show when={last()}>
          <span>
            <em>last activity</em> {last()}
          </span>
        </Show>
      </p>
    )
  }

  const sessionCalls = () => callsBySession().get(selectedSessionID() ?? "") ?? []
  const sessionFiles = createMemo(() => [
    ...new Set(
      sessionCalls().flatMap((line) =>
        line.kind === "call" && line.record?.fileTargets?.coverage === "observed"
          ? line.record.fileTargets.paths
          : [],
      ),
    ),
  ])
  const sessionMessages = createMemo(() =>
    (live()?.flow ?? [])
      .filter((item) => item.sessionID === selectedSessionID() && item.kind !== "tool-phase")
      .toSorted((left, right) => right.observedAt - left.observedAt),
  )
  const flowCount = () => sessionMessages().length

  return (
    <div
      class="lazers-radar lazers-radar-monitor"
      data-inspector={showInspector()}
      ref={(element) => (root = element)}
      style={{
        "--radar-visual-fr": `${props.split}fr`,
        "--radar-detail-fr": `${100 - props.split}fr`,
      }}
    >
      <RadarHeader
        ui={Ui}
        view="monitor"
        onView={props.onView}
        scope={scopeChoice()}
        onScope={props.onScopeChange}
        connection={connection()}
        onRefresh={props.onRefresh}
        ref={(element) => (header = element)}
      />
      <div class="lazers-radar-top" ref={(element) => (top = element)}>
        <PanelStatus ui={Ui} status={status} onRetry={props.onRefresh} skeleton="rows" />
        <Show when={live() && !nothingRunning(live()!) ? live() : undefined}>
          {(response) => (
            <p class="lazers-radar-summary">
              <For each={monitorSegments(response())}>
                {(segment) => (
                  <span>
                    <strong>{segment.count}</strong> {segment.word}
                  </span>
                )}
              </For>
            </p>
          )}
        </Show>
      </div>

      <div
        id="lazers-radar-monitor-activity"
        class="lazers-radar-visual lazers-radar-monitor-activity"
        role="region"
        aria-label="Live session activity"
        data-panel-dimmed={status.dimmed()}
      >
        <Show when={live()}>
          {(response) => (
            <>
              <Show when={nothingRunning(response())}>
                <div class="lazers-radar-idle">
                  <h3>Nothing is running</h3>
                  <p>{idleSentence(response())}</p>
                  <Show when={props.onOpenTasks}>
                    <Ui.Button size="small" onClick={() => props.onOpenTasks!()}>
                      Open Tasks
                    </Ui.Button>
                  </Show>
                </div>
              </Show>
              <Show when={sessions().length > 0}>
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
                      Data gaps · {groups().unavailable.length}{" "}
                      {groups().unavailable.length === 1 ? "session" : "sessions"} without live data
                    </summary>
                    <ul class="lazers-radar-sessions" aria-label="Sessions without live data">
                      <For each={groups().unavailable}>{(id) => <SessionRow id={id} />}</For>
                    </ul>
                  </details>
                </Show>
              </Show>
              <Show when={flowIDs().length > 0}>
                <section class="lazers-radar-recent" aria-labelledby="lazers-radar-recent-title">
                  <h3 id="lazers-radar-recent-title">Recent activity</h3>
                  <ol class="lazers-radar-flow-list">
                    <For each={flowIDs()}>{(id) => <FlowRow id={id} />}</For>
                  </ol>
                </section>
              </Show>
            </>
          )}
        </Show>
      </div>

      <Show when={showInspector()}>
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
          <Show when={selectedSession()}>
            {(session) => (
              <>
                <header class="lazers-radar-inspector-head">
                  <span class="lazers-radar-inspector-state" data-tone={sessionTone(session())}>
                    <span class="lazers-radar-state-dot" aria-hidden="true" />
                    <Show when={selectedLine()} fallback={sessionState(session())}>
                      {(line) => (
                        <>
                          {callStatusWord(line().status)}
                          <Show when={lineDuration(line())}> · {lineDuration(line())}</Show>
                        </>
                      )}
                    </Show>
                  </span>
                  <Actions session={session()} />
                </header>
                <h3 class="lazers-radar-inspector-title">
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
                <Facts session={session()} />

                <Show when={selectedLine()}>
                  {(line) => (
                    <div class="lazers-radar-inspector-block">
                      <Show
                        when={(line().record?.fileTargets?.paths.length ?? 0) > 0}
                        fallback={
                          <Show when={line().targetNote}>
                            <p class="lazers-radar-inspector-muted">{line().targetNote}</p>
                          </Show>
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
                      <p class="lazers-radar-facts-line">
                        <Show when={clockTime(line().startedAt)}>
                          <span>
                            <em>started</em> {clockTime(line().startedAt)}
                          </span>
                        </Show>
                        <Show when={line().endedAt !== null && clockTime(line().endedAt)}>
                          <span>
                            <em>ended</em> {clockTime(line().endedAt)}
                          </span>
                        </Show>
                      </p>
                    </div>
                  )}
                </Show>

                <Show when={selectedFlow()}>
                  {(item) => (
                    <p class="lazers-radar-facts-line lazers-radar-inspector-block">
                      <span>
                        <em>observed</em> {clockTime(item().observedAt)}
                      </span>
                      <Show when={item().startedAt !== null && clockTime(item().startedAt)}>
                        <span>
                          <em>started</em> {clockTime(item().startedAt)}
                        </span>
                      </Show>
                      <Show when={live() && routeDetail(live()!, item().routeID)}>
                        <span>
                          <em>model</em> {routeDetail(live()!, item().routeID)}
                        </span>
                      </Show>
                      <Show when={item().tool}>
                        <span>
                          <em>tool</em> {item().tool}
                        </span>
                      </Show>
                    </p>
                  )}
                </Show>

                <div class="lazers-radar-inspector-tabs" role="tablist" aria-label="Session detail">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab() === "calls"}
                    onClick={() => setTab("calls")}
                  >
                    Calls <span>{sessionCalls().length}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab() === "files"}
                    onClick={() => setTab("files")}
                  >
                    Files <span>{sessionFiles().length}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab() === "messages"}
                    onClick={() => setTab("messages")}
                  >
                    Messages <span>{flowCount()}</span>
                  </button>
                </div>

                <Show when={tab() === "calls"}>
                  <ul class="lazers-radar-inspector-list" aria-label="Calls">
                    <For each={sessionCalls()}>
                      {(line) => (
                        <li>
                          <ActivityLineButton id={line.id} />
                        </li>
                      )}
                    </For>
                  </ul>
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
                        Couldn't load history.
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
                </Show>
                <Show when={tab() === "files"}>
                  <ul class="lazers-radar-inspector-paths" aria-label="Files">
                    <For each={sessionFiles()}>
                      {(path) => (
                        <li>
                          <Ui.Icon name="file-document" size="small" />
                          <Mono>{path}</Mono>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={tab() === "messages"}>
                  <ol class="lazers-radar-flow-list" aria-label="Messages">
                    <For each={sessionMessages()}>{(item) => <FlowRow id={item.id} />}</For>
                  </ol>
                </Show>

                <details class="lazers-radar-disclosure lazers-radar-identifiers">
                  <summary>Identifiers</summary>
                  <dl class="lazers-radar-facts">
                    <dt>Session</dt>
                    <dd>
                      <Mono>{session().sessionID}</Mono>
                    </dd>
                    <Show when={session().assignment}>
                      {(assignment) => (
                        <>
                          <dt>Task</dt>
                          <dd>
                            <Mono>{assignment().taskID}</Mono>
                          </dd>
                          <dt>Attempt</dt>
                          <dd>
                            <Mono>{assignment().attemptID}</Mono>
                          </dd>
                        </>
                      )}
                    </Show>
                    <Show when={selectedLine()}>
                      {(line) => (
                        <>
                          <dt>Call</dt>
                          <dd>
                            <Mono>{line().callID}</Mono>
                          </dd>
                        </>
                      )}
                    </Show>
                  </dl>
                </details>
              </>
            )}
          </Show>
        </section>
      </Show>
    </div>
  )
}

import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import type { Ui } from "@opencode/plugin/gui"
import type { ObservationScope } from "../observability/contract.ts"
import type { RadarMonitorData } from "./monitor-state.ts"
import { createPanelStatus, PanelStatus } from "../panel-status.tsx"
import { TaskRing } from "../tasks/state-glyph.tsx"
import { RadarMapView } from "./map-view.tsx"
import { createRadarMap, mapFacts } from "./map-model.ts"
import { RadarHeader } from "./radar-header.tsx"
import type { RadarScopeChoice, RadarViewChoice } from "./radar-header.tsx"
import {
  callRow,
  clockMinutes,
  clockTime,
  connectionStatus,
  flowIcon,
  flowPhase,
  formatAge,
  formatDuration,
  formatTimer,
  idleSentence,
  monitorSegments,
  nothingRunning,
  sessionActivity,
  sessionCallLines,
  sessionGlyph,
  sessionGroups,
  sessionModel,
  sessionRole,
  sessionState,
  sessionTask,
  sessionTaskTitle,
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
  /** Monitor lists sessions; Map draws the org tree. Both share the header and the inspector. */
  view: "monitor" | "map"
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
  onOpenTrajectory?: (taskID: string, reference?: string) => void
}

type InspectorTab = "calls" | "files" | "messages"

export function RadarMonitorView(props: Props) {
  const Ui = props.ui
  /** The selected call is highlighted in the list; the inspector heading never changes for it. */
  const [selectedCallID, setSelectedCallID] = createSignal<string | null>(null)
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(clock))
  let root: HTMLDivElement | undefined
  let header: HTMLElement | undefined
  let top: HTMLDivElement | undefined
  /** The inspector opens only once the user picks something; nothing is selected at first. */
  const [inspecting, setInspecting] = createSignal(false)
  const [mapSelectedID, setMapSelectedID] = createSignal<string | null>(null)
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
  const groups = createMemo(() =>
    live()
      ? sessionGroups(live()!)
      : { leading: [] as string[], children: new Map<string, string[]>() },
  )
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
  const flowByID = createMemo(() => new Map((live()?.flow ?? []).map((item) => [item.id, item])))

  const map = createMemo(() => (live() ? createRadarMap(live()!, now()) : undefined))
  const mapSelection = () => {
    const id = mapSelectedID()
    return id ? map()?.nodeByID.get(id) : undefined
  }

  const selectedSessionID = () =>
    props.data().selectedSessionID ??
    sessions().find((session) => session.sessionID === props.anchorSessionID)?.sessionID ??
    sessions()[0]?.sessionID ??
    null
  const selectedSession = () => {
    const id = selectedSessionID()
    return id ? sessionByID().get(id) : undefined
  }
  /** A selected call only counts while it belongs to the selected session. */
  const selectedLine = () => {
    const id = selectedCallID()
    const line = id ? lineByID().get(id) : undefined
    return line && line.sessionID === selectedSessionID() ? line : undefined
  }

  const chooseSession = (sessionID: string) => {
    if (props.data().selectedSessionID !== sessionID) props.onSelectSession(sessionID)
  }
  const chooseLine = (line: ActivityLine) => {
    setInspecting(true)
    chooseSession(line.sessionID)
    setSelectedCallID(selectedCallID() === line.id ? null : line.id)
  }
  const chooseNode = (id: string) => {
    setMapSelectedID(id)
    const node = map()?.nodeByID.get(id)
    if (node?.sessionID) {
      setInspecting(true)
      setSelectedCallID(null)
      chooseSession(node.sessionID)
    }
  }

  const connection = () => connectionStatus(props.data())
  const showInspector = () =>
    props.view === "map"
      ? mapSelection() !== undefined &&
        (mapSelection()!.sessionID === undefined || selectedSession() !== undefined)
      : inspecting() && selectedSession() !== undefined
  /** Map system nodes (Runtime, Checks, Queue, You) get a facts inspector, not a session. */
  const inspectorSession = () =>
    props.view === "map" && mapSelection()?.sessionID === undefined ? undefined : selectedSession()
  const scopeChoice = (): MonitorScopeChoice =>
    props.scope.kind === "session"
      ? "session"
      : props.includeUnmanagedSessions
        ? "project-all"
        : "project"
  const runningEnd = () => (props.data().stale && live() ? live()!.observedAt : now())
  /** A running call counts up as `0:42`; a finished call shows how long it took. */
  const callElapsed = (line: ActivityLine) => {
    if (line.startedAt === null) return ""
    if (line.current) return formatTimer(runningEnd() - line.startedAt)
    return line.endedAt === null ? "" : formatDuration(line.endedAt - line.startedAt)
  }
  /** In a session row a finished call reads as how long ago it ended. */
  const callWhen = (line: ActivityLine) =>
    line.current || line.endedAt === null ? callElapsed(line) : formatAge(now() - line.endedAt)
  /** Inspector heading: the role and the task's title. */
  const sessionHeading = (session: LiveSession) => {
    const title = sessionTaskTitle(session)
    return `${sessionRole(session).label}${title ? ` · ${title}` : ""}`
  }
  const sessionShortLabel = (session: LiveSession) => {
    const reference = session.assignment?.taskReference
    return `${sessionRole(session).label}${reference ? ` · ${reference}` : ""}`
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

  /** `[icon] tool  argument  elapsed`: the one call row, in session rows and the Calls tab. */
  const CallRow = (local: { id: string; detailed?: boolean }) => {
    const line = () => lineByID().get(local.id)
    const view = () => (line() ? callRow(line()!) : undefined)
    return (
      <Show when={view()}>
        {(value) => (
          <button
            type="button"
            class="lazers-radar-call"
            data-status={line()!.status}
            data-current={value().current}
            data-failed={value().failed}
            data-detailed={local.detailed === true}
            aria-pressed={selectedCallID() === local.id}
            onClick={() => chooseLine(line()!)}
          >
            <span class="lazers-radar-call-icon" aria-hidden="true">
              <Ui.Icon name={value().icon} size="small" />
            </span>
            <code class="lazers-radar-call-tool" style={{ "font-family": props.monoFont }}>
              {value().tool}
            </code>
            <code
              class="lazers-radar-call-arg"
              style={{ "font-family": props.monoFont }}
              title={value().argument ?? undefined}
            >
              {value().argument}
            </code>
            <code class="lazers-radar-call-time" style={{ "font-family": props.monoFont }}>
              {local.detailed ? callElapsed(line()!) : callWhen(line()!)}
            </code>
            <Show when={local.detailed && clockTime(line()!.startedAt)}>
              <code class="lazers-radar-call-clock" style={{ "font-family": props.monoFont }}>
                {clockTime(line()!.startedAt)}
              </code>
            </Show>
          </button>
        )}
      </Show>
    )
  }

  /** The selected call's detail, inline under its row. */
  const CallDetail = (local: { line: ActivityLine }) => (
    <div class="lazers-radar-call-detail">
      <Show when={(local.line.record?.fileTargets?.paths.length ?? 0) > 0}>
        <ul class="lazers-radar-inspector-paths" aria-label="Requested files">
          <For each={local.line.record!.fileTargets!.paths}>
            {(path) => (
              <li>
                <Ui.Icon name="file-document" size="small" />
                <Mono>{path}</Mono>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={local.line.error}>
        <p class="lazers-radar-inspector-error">{local.line.error}</p>
      </Show>
      <Show when={local.line.record?.result}>
        <p>{local.line.record!.result}</p>
      </Show>
      <p class="lazers-radar-facts-line">
        <Show when={clockTime(local.line.startedAt)}>
          <span>
            <em>started</em> {clockTime(local.line.startedAt)}
          </span>
        </Show>
        <Show when={local.line.endedAt !== null && clockTime(local.line.endedAt)}>
          <span>
            <em>ended</em> {clockTime(local.line.endedAt)}
          </span>
        </Show>
      </p>
    </div>
  )

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
    const selected = () =>
      (props.view === "map" ? mapSelection()?.sessionID !== undefined : inspecting()) &&
      selectedSessionID() === local.id
    return (
      <Show when={session()}>
        {(value) => (
          <li
            class="lazers-radar-session"
            data-selected={selected()}
            data-tone={sessionTone(value())}
            data-architect={value().isCurrentArchitect === true}
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
                setSelectedCallID(null)
              }}
            >
              <span
                class="lazers-radar-session-icon"
                data-tone={sessionTone(value())}
                aria-hidden="true"
              >
                <Show
                  when={value().isCurrentArchitect === true}
                  fallback={<TaskRing glyph={sessionGlyph(value())} />}
                >
                  <Ui.Icon name={sessionRole(value()).icon} size="small" />
                </Show>
              </span>
              <strong class="lazers-radar-session-role">{sessionRole(value()).label}</strong>
              <span class="lazers-radar-session-task">
                <Show when={value().assignment?.taskReference}>
                  {(reference) => (
                    <code
                      class="lazers-radar-session-ref"
                      style={{ "font-family": props.monoFont }}
                    >
                      {reference()}
                    </code>
                  )}
                </Show>
                <Show when={sessionTaskTitle(value()) !== value().assignment?.taskReference}>
                  <span class="lazers-radar-session-title">{sessionTaskTitle(value())}</span>
                </Show>
              </span>
              <Show when={model()}>
                {(item) => (
                  <span class="lazers-radar-session-model" title={item().detail}>
                    <span>{item().model}</span>
                    <Show when={item().effort}>
                      <span class="lazers-radar-session-effort"> · {item().effort}</span>
                    </Show>
                  </span>
                )}
              </Show>
              <span class="lazers-radar-session-when">
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
                    style={{ "font-family": props.monoFont }}
                    title={`Last activity ${clockTime(lastActivity())}`}
                  >
                    {age().replace(" ago", "")}
                  </time>
                </Show>
              </span>
            </button>
            <Show when={lineIDs().length > 0}>
              <ul
                class="lazers-radar-session-lines"
                aria-label={`${sessionTitle(value())} activity`}
              >
                <For each={lineIDs()}>
                  {(id) => (
                    <li>
                      <CallRow id={id} />
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
          <li class="lazers-radar-message">
            <span class="lazers-radar-call-icon" aria-hidden="true">
              <Ui.Icon name={flowIcon(value())} size="small" />
            </span>
            <span class="lazers-radar-message-label">
              <span class="lazers-radar-message-subject">
                {owner() ? sessionShortLabel(owner()!) : "Session"}
              </span>{" "}
              {flowPhase(value() as LiveFlow, live()).label}
            </span>
            <code class="lazers-radar-call-clock" style={{ "font-family": props.monoFont }}>
              {clockTime(value().observedAt)}
            </code>
          </li>
        )}
      </Show>
    )
  }

  /** Open task and Trajectory are plain text buttons; Open worker lives in the ⋯ menu. */
  const Actions = (local: { session: LiveSession }) => (
    <div class="lazers-radar-links">
      <Show when={local.session.assignment && props.onOpenTask}>
        <button
          type="button"
          class="lazers-radar-text-button"
          onClick={() => props.onOpenTask!(local.session.assignment!.taskID)}
        >
          Open task
        </button>
      </Show>
      <Show when={local.session.assignment && props.onOpenTrajectory}>
        <button
          type="button"
          class="lazers-radar-text-button"
          onClick={() =>
            props.onOpenTrajectory!(
              local.session.assignment!.taskID,
              sessionTask(local.session) ?? undefined,
            )
          }
        >
          Trajectory
        </button>
      </Show>
    </div>
  )

  /** One facts line; each segment appears only when the read has it. */
  const Facts = (local: { session: LiveSession }) => {
    const model = () => (live() ? sessionModel(live()!, local.session) : undefined)
    const started = () =>
      local.session.assignment ? clockMinutes(local.session.assignment.startedAt) : ""
    const last = () => {
      const at = activity().get(local.session.sessionID)?.lastActivityAt ?? null
      return at === null ? "" : formatAge(now() - at)
    }
    return (
      <p class="lazers-radar-facts-line">
        <Show when={model()}>{(item) => <span>{item().label}</span>}</Show>
        <Show when={local.session.assignment?.attemptNumber}>
          {(attempt) => (
            <span>
              <em>attempt</em> {attempt()}
            </span>
          )}
        </Show>
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
        line.record?.fileTargets?.coverage === "observed" ? line.record.fileTargets.paths : [],
      ),
    ),
  ])
  const sessionMessages = createMemo(() =>
    (live()?.flow ?? [])
      .filter((item) => item.sessionID === selectedSessionID() && item.kind !== "tool-phase")
      .toSorted((left, right) => right.observedAt - left.observedAt),
  )

  const menuActions = () => {
    const session = inspectorSession()
    return session && props.onOpenWorker
      ? [
          {
            label: "Open worker",
            icon: "square-arrow-top-right" as const,
            onSelect: () => props.onOpenWorker!(session.sessionID),
          },
        ]
      : []
  }

  return (
    <div
      class="lazers-radar lazers-radar-monitor"
      data-inspector={showInspector()}
      data-view={props.view}
      data-connection={connection().state}
      ref={(element) => (root = element)}
      style={{
        "--radar-visual-fr": `${props.split}fr`,
        "--radar-detail-fr": `${100 - props.split}fr`,
      }}
    >
      <RadarHeader
        ui={Ui}
        view={props.view}
        onView={props.onView}
        scope={scopeChoice()}
        onScope={props.onScopeChange}
        connection={connection()}
        onRefresh={props.onRefresh}
        actions={menuActions()}
        ref={(element) => (header = element)}
      />
      <div class="lazers-radar-top" ref={(element) => (top = element)}>
        <PanelStatus ui={Ui} status={status} onRetry={props.onRefresh} skeleton="rows" />
        <Show
          when={
            props.view === "monitor" && live() && monitorSegments(live()!).length > 0
              ? live()
              : undefined
          }
        >
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
        aria-label={props.view === "map" ? "Radar map" : "Live session activity"}
        data-panel-dimmed={status.dimmed()}
      >
        <Show when={live()}>
          {(response) => (
            <Show
              when={props.view === "monitor"}
              fallback={
                <Show when={map()}>
                  {(value) => (
                    <RadarMapView
                      map={value()}
                      selectedID={mapSelectedID()}
                      onSelect={chooseNode}
                    />
                  )}
                </Show>
              }
            >
              <Show
                when={!nothingRunning(response())}
                fallback={
                  <div class="lazers-radar-idle">
                    <h3>Nothing is running</h3>
                    <p>{idleSentence(response())}</p>
                    <Show when={props.onOpenTasks}>
                      <button
                        type="button"
                        class="lazers-radar-outline-button"
                        onClick={() => props.onOpenTasks!()}
                      >
                        Open Tasks
                      </button>
                    </Show>
                  </div>
                }
              >
                <Show when={groups().leading.length > 0}>
                  <ul class="lazers-radar-sessions" aria-label="Sessions">
                    <For each={groups().leading}>{(id) => <SessionRow id={id} />}</For>
                  </ul>
                </Show>
              </Show>
            </Show>
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
          aria-label="Selected details"
        >
          <Show
            when={inspectorSession()}
            fallback={
              <Show when={mapSelection()}>
                {(node) => (
                  <>
                    <h3 class="lazers-radar-inspector-title">{node().title}</h3>
                    <Show when={node().sub}>
                      <p class="lazers-radar-facts-line">
                        <span>{node().sub}</span>
                      </p>
                    </Show>
                    <Show when={live() ? mapFacts(live()!, node()) : []}>
                      {(facts) => (
                        <dl class="lazers-radar-facts">
                          <For each={facts()}>
                            {(fact) => (
                              <>
                                <dt>{fact.label}</dt>
                                <dd>{fact.value}</dd>
                              </>
                            )}
                          </For>
                        </dl>
                      )}
                    </Show>
                  </>
                )}
              </Show>
            }
          >
            {(session) => (
              <>
                <header class="lazers-radar-inspector-head">
                  <span class="lazers-radar-inspector-state" data-tone={sessionTone(session())}>
                    <span class="lazers-radar-inspector-glyph" aria-hidden="true">
                      <Show
                        when={session().isCurrentArchitect === true}
                        fallback={<TaskRing glyph={sessionGlyph(session())} />}
                      >
                        <Ui.Icon name={sessionRole(session()).icon} size="small" />
                      </Show>
                    </span>
                    <span class="lazers-radar-inspector-word">{sessionState(session())}</span>
                    <Show when={session().assignment?.taskReference}>
                      {(reference) => (
                        <code
                          class="lazers-radar-session-ref"
                          style={{ "font-family": props.monoFont }}
                        >
                          {reference()}
                        </code>
                      )}
                    </Show>
                  </span>
                  <Actions session={session()} />
                </header>
                <h3 class="lazers-radar-inspector-title">{sessionHeading(session())}</h3>
                <Facts session={session()} />

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
                    Messages <span>{sessionMessages().length}</span>
                  </button>
                </div>

                <Show when={tab() === "calls"}>
                  <ul class="lazers-radar-inspector-list" aria-label="Calls">
                    <For each={sessionCalls()}>
                      {(line) => (
                        <li data-selected={selectedLine()?.id === line.id}>
                          <CallRow id={line.id} detailed />
                          <Show when={selectedLine()?.id === line.id ? selectedLine() : undefined}>
                            {(selected) => <CallDetail line={selected()} />}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                  <details class="lazers-radar-disclosure lazers-radar-monitor-history">
                    <summary>
                      Earlier calls
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
                      <button
                        type="button"
                        class="lazers-radar-text-button"
                        onClick={props.onLoadMoreHistory}
                        disabled={props.data().historyLoading}
                      >
                        Load older
                      </button>
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
                  <ol class="lazers-radar-messages" aria-label="Messages">
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

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import type { Ui } from "@opencode/plugin/gui"
import type { ObservationScope } from "../observability/contract.ts"
import type { RadarMonitorData } from "./monitor-state.ts"
import { createPanelStatus, PanelStatus } from "../panel-status.tsx"
import { TaskRing } from "../tasks/state-glyph.tsx"
import { isRingGlyph } from "../tasks/row-presentation.ts"
import {
  ActivityLane,
  Disclosure,
  Identifiers,
  Label,
  Rows,
  Row,
  Section,
  StatRow,
} from "../details/index.ts"
import type { LiveAttemptResponse, LiveGroupResponse } from "../observability/contract.ts"
import {
  callTarget,
  idleText,
  lastCall,
  recentCalls,
  toolName,
  workerLane,
  workerState,
  workerStats,
} from "./worker-pane.ts"
import type { WorkerAttempt } from "./worker-pane.ts"
import { isHeldWorker } from "./worker-hold.ts"
import { DetailsPane } from "../details-pane.tsx"
import type { DetailsState } from "../details-pane.ts"
import { RadarFlowActions, RadarFlowBody, RadarFlowCanvas, RadarFlowTabs } from "./flow-view.tsx"
import { createFlowModel, filterFeed, quietSentences } from "./flow-model.ts"
import type { FlowSelection } from "./flow-model.ts"
import { RadarMapView } from "./map-view.tsx"
import { createRadarMap, mapFacts } from "./map-model.ts"
import { RadarHeader } from "./radar-header.tsx"
import type { RadarScopeChoice, RadarViewChoice } from "./radar-header.tsx"
import {
  callRow,
  clockCompact,
  clockMinutes,
  clockTime,
  connectionStatus,
  flowIcon,
  flowPhase,
  formatAge,
  formatDuration,
  formatTimer,
  idleSentence,
  flowSegments,
  visibleSessions,
  monitorSegments,
  sessionActivity,
  sessionCallLines,
  sessionGlyph,
  sessionGroups,
  sessionModel,
  sessionRole,
  sessionTask,
  sessionTaskTitle,
  sessionTone,
} from "./monitor-model.ts"
import type { ActivityLine, LiveFlow, LiveSession } from "./monitor-model.ts"

export type MonitorScopeChoice = RadarScopeChoice

type Props = {
  ui: Ui
  data: Accessor<RadarMonitorData>
  /** Monitor lists sessions; Map draws the org tree. Both share the header and the inspector. */
  view: "monitor" | "map" | "flow"
  scope: ObservationScope
  anchorSessionID: string
  includeUnmanagedSessions: boolean
  monoFont: string
  /** The details pane: closed by default; callers persist it per view. */
  details: DetailsState
  onDetailsChange: (change: Partial<DetailsState>) => void
  onScopeChange: (choice: MonitorScopeChoice) => void
  onSelectSession: (sessionID: string) => void
  onRefresh: () => void
  onLoadMoreHistory: () => void
  onView: (view: RadarViewChoice) => void
  onOpenTasks?: () => void
  onOpenWorker?: (sessionID: string) => void
  onOpenTask?: (taskID: string) => void
  onOpenTrajectory?: (taskID: string, reference?: string) => void
  /** The selected worker's call count, model and tick summary; absent on an older server. */
  readAttempt?: (sessionID: string, signal: AbortSignal) => Promise<LiveAttemptResponse>
  /** The tasks behind a Map group node; absent on an older server. */
  readGroup?: (
    group: "needs-you" | "failed" | "queued",
    signal: AbortSignal,
  ) => Promise<LiveGroupResponse>
  /** The task lifecycle statechart, kept behind the ⋯ menu. */
  onOpenLifecycle?: () => void
  /** Idle sessions are hidden by default; the choice is stored with the view state. */
  showIdle: boolean
  onShowIdleChange: (show: boolean) => void
}

export function RadarMonitorView(props: Props) {
  const Ui = props.ui
  /** The selected call is highlighted in the list; the inspector heading never changes for it. */
  const [selectedCallID, setSelectedCallID] = createSignal<string | null>(null)
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(clock))
  let root: HTMLDivElement | undefined
  /** The inspector opens only once the user picks something; nothing is selected at first. */
  const [inspecting, setInspecting] = createSignal(false)
  const [mapSelectedID, setMapSelectedID] = createSignal<string | null>(null)

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
  const visibility = createMemo(() =>
    live()
      ? visibleSessions(live()!, now(), {
          showIdle: props.showIdle,
          selectedID: inspecting() ? props.data().selectedSessionID : null,
        })
      : undefined,
  )
  const groups = createMemo(() =>
    live()
      ? sessionGroups(live()!, visibility()?.shown)
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

  const [narrow, setNarrow] = createSignal(false)
  onMount(() => {
    if (!root) return
    setNarrow(root.clientWidth > 0 && root.clientWidth <= 420)
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width > 0) setNarrow(width <= 420)
    })
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })
  const flowModel = createMemo(() =>
    live() ? createFlowModel(live()!, now(), visibility()?.shown) : undefined,
  )
  const [flowSelection, setFlowSelection] = createSignal<FlowSelection>(null)
  const [flowTab, setFlowTab] = createSignal<"feed" | "models">("feed")
  const flowPane = () => props.view === "flow" && flowModel() !== undefined && !flowModel()!.quiet
  const flowSelectionLabel = () => {
    const selection = flowSelection()
    const model = flowModel()
    if (!selection || !model) return ""
    if (selection.kind === "destination")
      return model.destinations.find((dest) => dest.id === selection.id)?.name ?? ""
    const session = model.sessions.find((item) => item.sessionID === selection.id)
    return session ? session.ref || session.role : ""
  }
  const map = createMemo(() =>
    live() ? createRadarMap(live()!, now(), visibility()?.shown) : undefined,
  )
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
  /** A person picked something: open the pane at its stored size. Never called on mount or refresh. */
  const openDetails = () => {
    if (!props.details.open) props.onDetailsChange({ open: true })
  }
  const chooseLine = (line: ActivityLine) => {
    openDetails()
    setInspecting(true)
    chooseSession(line.sessionID)
    setSelectedCallID(selectedCallID() === line.id ? null : line.id)
  }
  const chooseNode = (id: string) => {
    openDetails()
    setMapSelectedID(id)
    const node = map()?.nodeByID.get(id)
    if (node?.sessionID) {
      setInspecting(true)
      setSelectedCallID(null)
      chooseSession(node.sessionID)
    }
  }

  const connection = () => connectionStatus(props.data())
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
              <code
                class="lazers-radar-call-clock"
                style={{ "font-family": props.monoFont }}
                title={clockTime(line()!.startedAt)}
              >
                {clockCompact(line()!.startedAt)}
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
                stateOf(value()).word.toLowerCase(),
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
                openDetails()
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
                  <span class="lazers-radar-session-title">
                    {value().assignment?.taskReference ? "" : "· "}
                    {sessionTaskTitle(value())}
                  </span>
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
                <Show when={stateOf(value()).word.toLowerCase()}>
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

  const sessionCalls = () => callsBySession().get(selectedSessionID() ?? "") ?? []
  const sessionFiles = createMemo(() => [
    ...new Set(
      sessionCalls().flatMap((line) =>
        line.record?.fileTargets?.coverage === "observed"
          ? line.record.fileTargets.paths
          : line.detail && /^(read|view|edit|write|multiedit)$/i.test(line.tool)
            ? [line.detail]
            : [],
      ),
    ),
  ])
  const sessionMessages = createMemo(() =>
    (live()?.flow ?? [])
      .filter((item) => item.sessionID === selectedSessionID() && item.kind !== "tool-phase")
      .toSorted((left, right) => right.observedAt - left.observedAt),
  )

  const paneAttempt = () => {
    const session = paneSession()
    return session ? attemptOf(session) : undefined
  }
  const calls = createMemo(() => recentCalls(sessionCalls()))
  const lastCallLine = () => lastCall(sessionCalls())
  const idle = () => {
    const session = paneSession()
    if (!session) return undefined
    return idleText(
      activity().get(session.sessionID)?.lastActivityAt ?? null,
      now(),
      sessionCalls().some((line) => line.current),
    )
  }
  const stats = () => {
    const session = paneSession()
    return session && live()
      ? workerStats({
          live: live()!,
          session,
          attempt: paneAttempt(),
          now: now(),
          lastActivityAt: activity().get(session.sessionID)?.lastActivityAt ?? null,
        })
      : []
  }
  const lane = () => workerLane(paneAttempt(), now())
  /** Older runner-progress calls that precede every call the live read already lists. */
  const olderCalls = () => {
    const oldest = Math.min(...sessionCalls().map((line) => line.startedAt ?? Infinity))
    return (props.data().history?.items ?? []).filter(
      (item) => item.tool !== null && item.at < oldest,
    )
  }
  const earlierCount = () => calls().earlier.length + olderCalls().length
  /** One call row: tool, target, duration, time. Target is never blank. */
  const renderCallRow = (line: ActivityLine) => (
    <Row onSelect={() => chooseLine(line)}>
      <span>{toolName(line.tool)}</span>
      <code
        class="lazers-radar-row-target"
        data-failed={line.status === "failed"}
        style={{ "font-family": props.monoFont }}
        title={callTarget(line)}
      >
        {line.status === "failed" ? (line.error ?? callTarget(line)) : callTarget(line)}
      </code>
      <span>{callElapsed(line)}</span>
      <span>{clockMinutes(line.startedAt)}</span>
    </Row>
  )

  /** Flow's line leaves out the queue: it is about what is moving. */
  const summarySegments = (response: NonNullable<ReturnType<typeof live>>) =>
    props.view === "flow" ? flowSegments(response) : monitorSegments(response)

  const idleAction = () =>
    (visibility()?.hidden ?? 0) > 0 || props.showIdle
      ? [
          {
            label: "Show idle sessions",
            icon: props.showIdle ? ("check-small" as const) : undefined,
            onSelect: () => props.onShowIdleChange(!props.showIdle),
          },
        ]
      : []

  const menuActions = () => [...menuItems(), ...idleAction()]
  const menuItems = () => {
    const session = props.view === "flow" ? undefined : inspectorSession()
    const lifecycle =
      props.view === "flow" && props.onOpenLifecycle
        ? [{ label: "Task lifecycle diagram", onSelect: () => props.onOpenLifecycle!() }]
        : []
    if (lifecycle.length > 0) return lifecycle
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

  const flowCounts = () => {
    const model = flowModel()
    return {
      feed: model ? filterFeed(model, flowSelection()).length : 0,
      models: model?.models.length ?? 0,
    }
  }
  /** The session the pane describes: chosen in Monitor, or by a Map session node. */
  const paneSession = () =>
    props.view === "monitor"
      ? inspecting()
        ? selectedSession()
        : undefined
      : props.view === "map" && mapSelection()?.sessionID !== undefined
        ? selectedSession()
        : undefined
  const paneNode = () =>
    props.view === "map" && mapSelection()?.sessionID === undefined ? mapSelection() : undefined
  /** The selected worker's attempt read, refreshed at most every ten seconds of live updates. */
  const [attemptRead, setAttemptRead] = createSignal<{
    sessionID: string
    attempt: WorkerAttempt | null
  }>()
  createEffect(() => {
    const session = paneSession()
    void Math.floor((live()?.observedAt ?? 0) / 10_000)
    const read = props.readAttempt
    if (!read || !session?.assignment) return
    const sessionID = session.sessionID
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    read(sessionID, controller.signal).then(
      (response) => {
        if (!controller.signal.aborted) setAttemptRead({ sessionID, attempt: response.attempt })
      },
      () => {},
    )
  })
  const attemptOf = (session: LiveSession) => {
    const read = attemptRead()
    return read?.sessionID === session.sessionID ? read.attempt : undefined
  }
  /** One state word per session; a worker's task word is the one Tasks shows. */
  const stateOf = (session: LiveSession) => workerState(session, attemptOf(session))
  const groupOf = (node: { id: string; kind: string; parent: string | null }) => {
    const id = node.kind === "more" ? (node.parent ?? "") : node.id
    return id === "item:needs-you"
      ? ("needs-you" as const)
      : id === "item:failed"
        ? ("failed" as const)
        : id === "group:queue"
          ? ("queued" as const)
          : undefined
  }
  const [groupRead, setGroupRead] = createSignal<
    { group: string; read: LiveGroupResponse } | undefined
  >()
  createEffect(() => {
    const node = paneNode()
    const workload = live()?.workload
    void workload?.queued
    void workload?.needsYou
    void workload?.failed
    const group = node ? groupOf(node) : undefined
    const read = props.readGroup
    if (!read || !group) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    read(group, controller.signal).then(
      (response) => {
        if (!controller.signal.aborted) setGroupRead({ group, read: response })
      },
      () => {},
    )
  })
  const groupTasks = (node: { id: string; kind: string; parent: string | null }) => {
    const read = groupRead()
    return read && read.group === groupOf(node) ? read.read : undefined
  }
  /** The workers under a Runtime or Checks node. */
  const groupSessions = (nodeID: string) =>
    (map()?.nodes ?? [])
      .filter((node) => node.parent === nodeID && node.kind === "session" && node.sessionID)
      .flatMap((node) => {
        const session = sessionByID().get(node.sessionID!)
        return session ? [{ node, session }] : []
      })
  const renderStateGlyph = (session: LiveSession) => {
    const task = stateOf(session).task
    if (task)
      return isRingGlyph(task.icon) ? (
        <TaskRing glyph={task.icon} />
      ) : (
        <Ui.Icon name={task.icon} size="small" />
      )
    return session.isCurrentArchitect === true ? (
      <Ui.Icon name={sessionRole(session).icon} size="small" />
    ) : (
      <TaskRing glyph={sessionGlyph(session)} />
    )
  }
  const paneEmpty = () => (props.view === "flow" ? "Nothing is flowing" : "No session selected")
  /** One line saying what is selected; it is also the collapsed pane. */
  const paneHeader = () => {
    if (props.view === "flow")
      return flowPane() ? (
        <RadarFlowTabs
          feedCount={flowCounts().feed}
          modelsCount={flowCounts().models}
          tab={flowTab()}
          onTab={(next) => {
            setFlowTab(next)
            if (!props.details.open) props.onDetailsChange({ open: true })
          }}
        />
      ) : undefined
    const session = paneSession()
    if (session)
      return (
        <>
          <span
            class="lazers-radar-inspector-state"
            data-tone={sessionTone(session)}
            data-lazers-tone={stateOf(session).tone}
          >
            <span class="lazers-radar-inspector-glyph" aria-hidden="true">
              {renderStateGlyph(session)}
            </span>
            <span class="lazers-radar-inspector-word">{stateOf(session).word}</span>
            <Show when={session.assignment?.taskReference}>
              {(reference) => (
                <code class="lazers-radar-session-ref" style={{ "font-family": props.monoFont }}>
                  {reference()}
                </code>
              )}
            </Show>
          </span>
          <span class="lazers-radar-pane-title">
            {" · "}
            {sessionHeading(session)}
          </span>
        </>
      )
    const node = paneNode()
    return node ? (
      <>
        <strong>{node.title}</strong>
        <Show when={node.sub}>
          <span class="lazers-radar-pane-title">
            {" · "}
            {node.sub}
          </span>
        </Show>
      </>
    ) : undefined
  }
  const paneActions = () => {
    if (props.view === "flow")
      return (
        <RadarFlowActions
          selection={flowSelection()}
          selectionLabel={flowSelectionLabel()}
          onClear={() => setFlowSelection(null)}
        />
      )
    const session = paneSession()
    return session ? (
      <>
        <Actions session={session} />
        <Show when={props.onOpenWorker}>
          <Ui.Menu
            label="Session actions"
            icon="outline-dots"
            items={[
              {
                label: "Open worker",
                icon: "square-arrow-top-right",
                onSelect: () => props.onOpenWorker!(session.sessionID),
              },
            ]}
          />
        </Show>
      </>
    ) : undefined
  }

  return (
    <div
      class="lazers-radar lazers-radar-monitor"
      data-view={props.view}
      data-connection={connection().state}
      ref={(element) => (root = element)}
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
      />
      <DetailsPane
        ui={Ui}
        class="lazers-radar-pane"
        bodyClass="lazers-radar-detail lazers-radar-monitor-inspector"
        open={props.details.open}
        size={props.details.size}
        onOpen={(open) => props.onDetailsChange({ open })}
        onSize={(size) => props.onDetailsChange({ size })}
        header={paneHeader()}
        actions={paneActions()}
        empty={paneEmpty()}
        disabled={props.view === "flow" && !flowPane()}
        dimmed={status.dimmed()}
        label="Resize Radar details"
        top={
          <div class="lazers-radar-pane-top">
            <div class="lazers-radar-top">
              <PanelStatus ui={Ui} status={status} onRetry={props.onRefresh} skeleton="rows" />
              <Show
                when={
                  props.view !== "map" &&
                  live() &&
                  (summarySegments(live()!).length > 0 ||
                    (visibility()?.hidden ?? 0) > 0 ||
                    props.showIdle)
                    ? live()
                    : undefined
                }
              >
                {(response) => (
                  <p class="lazers-radar-summary">
                    <For each={summarySegments(response())}>
                      {(segment) => (
                        <span>
                          <strong>{segment.count}</strong> {segment.word}
                        </span>
                      )}
                    </For>
                    <Show when={(visibility()?.hidden ?? 0) > 0 || props.showIdle}>
                      <button
                        type="button"
                        class="lazers-radar-text-button lazers-radar-idle-toggle"
                        aria-pressed={props.showIdle}
                        onClick={() => props.onShowIdleChange(!props.showIdle)}
                      >
                        {props.showIdle ? "Hide idle" : `${visibility()?.hidden ?? 0} idle hidden`}
                      </button>
                    </Show>
                    <Show when={props.view === "flow" && flowModel()}>
                      {(model) => (
                        <span class="lazers-radar-summary-end">
                          <strong>{model().flows}</strong> flows / 2 min
                        </span>
                      )}
                    </Show>
                  </p>
                )}
              </Show>
            </div>
            <div
              id="lazers-radar-monitor-activity"
              class="lazers-radar-visual lazers-radar-monitor-activity"
              role="region"
              aria-label={
                props.view === "map"
                  ? "Radar map"
                  : props.view === "flow"
                    ? "Radar flow"
                    : "Live session activity"
              }
              data-panel-dimmed={status.dimmed()}
            >
              <Show when={live()}>
                {(response) => (
                  <Show
                    when={props.view !== "map"}
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
                      when={props.view === "monitor"}
                      fallback={
                        <Show
                          when={flowModel() && !flowModel()!.quiet}
                          fallback={
                            <div class="lazers-radar-idle">
                              <h3>Nothing is flowing</h3>
                              <p>{quietSentences(response()).line}</p>
                              <Show when={quietSentences(response()).state}>
                                <p>{quietSentences(response()).state}</p>
                              </Show>
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
                          <RadarFlowCanvas
                            model={flowModel()!}
                            selection={flowSelection()}
                            onSelect={(selection) => {
                              // Re-selecting the chosen item while collapsed reopens the pane instead.
                              if (
                                selection === null &&
                                flowSelection() !== null &&
                                !props.details.open
                              ) {
                                openDetails()
                                return
                              }
                              setFlowSelection(selection)
                              if (selection) openDetails()
                            }}
                          />
                        </Show>
                      }
                    >
                      <Show
                        when={
                          groups().leading.length > 0 &&
                          (props.showIdle || (visibility()?.active.size ?? 0) > 0)
                        }
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
                  </Show>
                )}
              </Show>
            </div>
          </div>
        }
      >
        <Show
          when={props.view !== "flow"}
          fallback={
            <Show when={flowModel()}>
              {(model) => (
                <RadarFlowBody
                  model={model()}
                  selection={flowSelection()}
                  now={now()}
                  monoFont={props.monoFont}
                  tab={flowTab()}
                  narrow={narrow()}
                />
              )}
            </Show>
          }
        >
          <Show
            when={paneSession()}
            fallback={
              <Show
                when={paneNode()}
                fallback={
                  <p class="lazers-radar-note">
                    {props.view === "map"
                      ? "Select a node on the map."
                      : "Select a session to see what it is doing."}
                  </p>
                }
              >
                {(node) => (
                  <>
                    <StatRow
                      stats={(live() ? mapFacts(live()!, node()) : [])
                        .filter((fact) => ["Scheduler", "Participants"].includes(fact.label))
                        .map((fact) => ({ label: fact.label, value: fact.value }))}
                    />
                    <Show when={groupOf(node())}>
                      <Show when={groupTasks(node())}>
                        {(group) => (
                          <>
                            <Rows columns="72px minmax(0, 1fr)" label="Tasks" items={group().tasks}>
                              {(task) => (
                                <Row onSelect={() => props.onOpenTask?.(task.taskID)}>
                                  <code style={{ "font-family": props.monoFont }}>
                                    {task.reference ?? task.taskID.slice(0, 8)}
                                  </code>
                                  <span class="lazers-radar-row-title">{task.title}</span>
                                </Row>
                              )}
                            </Rows>
                            <Show when={group().total > group().tasks.length}>
                              <p class="lazers-radar-note">
                                {group().total - group().tasks.length} more are in Tasks.
                              </p>
                            </Show>
                          </>
                        )}
                      </Show>
                    </Show>
                    <Show
                      when={["group:runtime", "group:checks", "group:waiting"].includes(node().id)}
                    >
                      <Rows
                        columns="72px minmax(0, 1fr) auto"
                        label="Workers"
                        items={groupSessions(node().id)}
                      >
                        {(item) => (
                          <Row onSelect={() => chooseNode(item.node.id)}>
                            <code style={{ "font-family": props.monoFont }}>
                              {item.session.assignment?.taskReference ?? ""}
                            </code>
                            <span class="lazers-radar-row-title">
                              {sessionRole(item.session).label}
                            </span>
                            <span class="lazers-radar-row-state">{stateOf(item.session).word}</span>
                          </Row>
                        )}
                      </Rows>
                    </Show>
                    <Show when={node().kind === "you"}>
                      <p class="lazers-radar-note">
                        Your session. Select the Architect or a worker to inspect it.
                      </p>
                    </Show>
                  </>
                )}
              </Show>
            }
          >
            {(session) => (
              <>
                <Show when={lastCallLine()}>
                  {(call) => (
                    <p class="lazers-radar-last-call">
                      <span class="lazers-radar-last-call-label">Last call</span>
                      <strong>{toolName(call().tool)}</strong>
                      <code style={{ "font-family": props.monoFont }} title={callTarget(call())}>
                        {callTarget(call())}
                      </code>
                      <Show when={idle()}>
                        {(text) => (
                          <Label tone={isHeldWorker(session()) ? "warning" : "neutral"}>
                            {text()}
                          </Label>
                        )}
                      </Show>
                    </p>
                  )}
                </Show>
                <StatRow stats={stats()} />
                <Show when={lane()}>
                  {(shown) => (
                    <Section label="Activity">
                      <ActivityLane
                        label="Tool calls of the latest attempt"
                        ticks={shown().ticks}
                        durationMs={shown().durationMs}
                        originAt={shown().originAt}
                      />
                    </Section>
                  )}
                </Show>
                <Show when={calls().recent.length > 0}>
                  <Section label="Recent calls">
                    <Rows
                      columns="64px minmax(0, 1fr) 56px 64px"
                      header={["Tool", "Target", "Duration", "Time"]}
                      items={calls().recent}
                      label="Recent calls"
                    >
                      {(line) => renderCallRow(line)}
                    </Rows>
                    <Show when={selectedLine()}>
                      {(selected) => <CallDetail line={selected()} />}
                    </Show>
                  </Section>
                </Show>

                <div class="lazers-radar-disclosures">
                  <Disclosure
                    label="Calls"
                    count={earlierCount() > 0 ? earlierCount() : undefined}
                    when={earlierCount() > 0 || Boolean(props.data().history?.nextCursor)}
                  >
                    <Rows
                      columns="64px minmax(0, 1fr) 56px 64px"
                      header={["Tool", "Target", "Duration", "Time"]}
                      items={calls().earlier}
                      label="Earlier calls"
                    >
                      {(line) => renderCallRow(line)}
                    </Rows>
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
                    <Rows
                      columns="64px minmax(0, 1fr) 64px"
                      header={["Tool", "Target", "Time"]}
                      items={olderCalls()}
                      label="Older calls"
                    >
                      {(item) => (
                        <Row>
                          <span>{toolName(item.tool ?? "")}</span>
                          <code
                            class="lazers-radar-row-target"
                            data-failed={item.status === "failed"}
                            style={{ "font-family": props.monoFont }}
                          >
                            {item.error ??
                              (item.fileTargets?.coverage === "observed" &&
                              item.fileTargets.paths.length > 0
                                ? item.fileTargets.paths.join(", ")
                                : (item.status ?? "—"))}
                          </code>
                          <span>{clockMinutes(item.at)}</span>
                        </Row>
                      )}
                    </Rows>
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
                  </Disclosure>
                  <Disclosure label="Files" count={sessionFiles().length}>
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
                  </Disclosure>
                  <Disclosure label="Messages" count={sessionMessages().length}>
                    <ol class="lazers-radar-messages" aria-label="Messages">
                      <For each={sessionMessages()}>{(item) => <FlowRow id={item.id} />}</For>
                    </ol>
                  </Disclosure>
                  <Disclosure label="Identifiers">
                    <Identifiers
                      items={[
                        { label: "Session", value: session().sessionID },
                        { label: "Task", value: session().assignment?.taskID },
                        { label: "Attempt", value: session().assignment?.attemptID },
                        { label: "Call", value: selectedLine()?.callID },
                      ]}
                    />
                  </Disclosure>
                </div>
              </>
            )}
          </Show>
        </Show>
      </DetailsPane>
    </div>
  )
}

import { Store, bindPlugin, createKeyed, createLatest, usePanel } from "@opencode/plugin/gui"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { Observability } from "../observability/contract.ts"
import { clampSplit, splitFromKey, splitFromPointer, visibleTicks } from "./panel-layout.ts"
import type { PanelData, PanelPreferences, Selection } from "./panel-state.ts"
import { selectedAttemptFor, selectedEventFor, TrajectoryPanelState } from "./panel-state.ts"
import {
  buildTimeline,
  checkTiming,
  checkKey,
  detailedChecks,
  eventTitle,
  eventPayload,
  sourceReferences,
} from "./projection.ts"
import type { DetailedCheck, TrajectoryEvent, TrajectoryReport } from "./projection.ts"
import { createTrajectoryTransport } from "./projection.ts"
import { registerTrajectoryPanel } from "./registration.ts"
import css from "./panel.css?inline"

const SelectionKind = Schema.Literals(["", "attempt", "check", "event"])
const TaskTarget = Schema.Struct({
  requestID: Schema.String,
  taskID: Schema.String,
  reference: Schema.String,
  projectID: Schema.String,
  projectDirectory: Schema.String,
})
const View = Schema.Struct({
  scope: Schema.Literals(["session", "project"]),
  selectedTaskID: Schema.NullOr(Schema.String),
  selectedReference: Schema.optionalKey(Schema.NullOr(Schema.String)),
  target: Schema.optionalKey(Schema.NullOr(TaskTarget)),
  selectedKind: SelectionKind,
  selectedRecordID: Schema.String,
  split: Schema.Number,
})
const initial: typeof View.Type = {
  scope: "session",
  selectedTaskID: null,
  selectedReference: null,
  target: null,
  selectedKind: "",
  selectedRecordID: "",
  split: 56,
}

export const trajectoryStores = {
  trajectoryView: Store.session(Schema.Struct({ projects: Schema.Record(Schema.String, View) }), {
    projects: {},
  }),
}
type TrajectoryContext = SetupContext<{ stores: typeof trajectoryStores }>

function selectionFrom(view: typeof initial): Selection | null {
  if (!view.selectedKind || !view.selectedRecordID) return null
  return { kind: view.selectedKind, id: view.selectedRecordID }
}

function formatTime(value: number | null, origin: number | null) {
  if (value === null) return "Unknown"
  const absolute = new Date(value).toLocaleTimeString()
  if (origin === null) return absolute
  const elapsed = Math.max(0, Math.round((value - origin) / 1_000))
  const minutes = Math.floor(elapsed / 60)
  const seconds = elapsed % 60
  return `${absolute} · +${minutes}:${String(seconds).padStart(2, "0")}`
}

function elapsedText(value: number) {
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(3)} s (${value} ms)`
}

function endpointText(label: string, value: number | null, origin: number | null) {
  return value === null
    ? `${label} · unavailable`
    : `${label} · ${value} Unix ms · ${formatTime(value, origin)}`
}

function timingHint(check: { startedAt: number | null; endedAt: number | null }) {
  const timing = checkTiming(check)
  return timing.status === "known"
    ? `duration ${elapsedText(timing.durationMs)}`
    : `duration unavailable: ${timing.reason}`
}

type ScrollAnchor = { key: string; offset: number; scrollTop: number } | undefined

function captureScrollAnchor(element: HTMLElement | undefined): ScrollAnchor {
  if (!element) return undefined
  const bounds = element.getBoundingClientRect()
  const anchor = [...element.querySelectorAll<HTMLElement>("[data-scroll-anchor]")].find((item) => {
    const rect = item.getBoundingClientRect()
    return rect.bottom > bounds.top && rect.top < bounds.bottom
  })
  return anchor?.dataset.scrollAnchor
    ? {
        key: anchor.dataset.scrollAnchor,
        offset: anchor.getBoundingClientRect().top - bounds.top,
        scrollTop: element.scrollTop,
      }
    : { key: "", offset: 0, scrollTop: element.scrollTop }
}

function restoreScrollAnchor(element: HTMLElement | undefined, anchor: ScrollAnchor) {
  if (!element || !anchor) return
  if (!anchor.key) {
    element.scrollTop = anchor.scrollTop
    return
  }
  const target = [...element.querySelectorAll<HTMLElement>("[data-scroll-anchor]")].find(
    (item) => item.dataset.scrollAnchor === anchor.key,
  )
  if (!target) {
    element.scrollTop = anchor.scrollTop
    return
  }
  element.scrollTop +=
    target.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset
}

function eventTime(event: TrajectoryEvent) {
  return typeof event.at === "number" ? new Date(event.at).toLocaleTimeString() : "Time unknown"
}

function modelName(report: PanelData["report"]) {
  const attempt = report?.attempts.at(-1)
  const model = attempt?.observedCurrentModel ?? attempt?.admittedModel
  if (!model) return "Model unavailable"
  return `${model.id}${model.variant ? ` · ${model.variant}` : ""}`
}

function attemptCount(report: PanelData["report"]) {
  if (!report) return ""
  const attempts = report.attempts.length
  const calls = report.effort.toolCalls.count.toLocaleString()
  return `${attempts} ${attempts === 1 ? "attempt" : "attempts"} · ${calls} tool calls`
}

function PanelView(props: PanelProps & { ctx: TrajectoryContext }) {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()
  const [data, setData] = createSignal<PanelData>({
    key: "",
    tasks: [],
    taskID: null,
    taskReference: null,
    selection: null,
    events: [],
    liveEvents: [],
    capturedEventIDs: [],
    eventCursor: null,
    totalEvents: 0,
    historyCapturedAt: null,
    historyExpiresAt: null,
    historyError: "",
    recapturingHistory: false,
    loading: true,
    loadingActivity: false,
    stale: false,
    error: "",
  })
  const [split, setSplit] = createSignal(initial.split)
  const [axisWidth, setAxisWidth] = createSignal(0)
  let axisObserver: ResizeObserver | undefined
  let topPane: HTMLDivElement | undefined
  let inspectorPane: HTMLDivElement | undefined
  const state = new TrajectoryPanelState(
    (next) => {
      const previous = data()
      const preserve = previous.key === next.key && previous.taskID === next.taskID
      const topAnchor = preserve ? captureScrollAnchor(topPane) : undefined
      const inspectorAnchor = preserve ? captureScrollAnchor(inspectorPane) : undefined
      setData(next)
      if (preserve)
        queueMicrotask(() => {
          restoreScrollAnchor(topPane, topAnchor)
          restoreScrollAnchor(inspectorPane, inspectorAnchor)
        })
    },
    (preferences: PanelPreferences) => {
      save({
        selectedTaskID: preferences.taskID,
        selectedKind: preferences.selection?.kind ?? "",
        selectedRecordID: preferences.selection?.id ?? "",
      })
    },
  )
  let root: HTMLDivElement | undefined
  let separator: HTMLDivElement | undefined
  let endDrag: (() => void) | undefined
  let handledTargetRequestID = ""

  const source = createLatest(
    () => {
      if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
      return {
        client: props.session.server.client,
        server: props.session.server.id,
        session: props.session.id,
        directory: props.session.directory,
      }
    },
    async (value, signal) => {
      const location = await value.client.location.get(
        { location: { directory: value.directory } },
        { signal },
      )
      return {
        ...value,
        project: location.project.canonical,
        projectID: location.project.id,
      }
    },
  )
  const current = () => {
    if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
    const value = source.latest
    return value &&
      value.session === props.session.id &&
      value.server === props.session.server.id &&
      value.directory === props.session.directory &&
      !source.loading
      ? value
      : undefined
  }
  const prefs = () => {
    const value = current()
    return value
      ? (ctx.stores.trajectoryView(props.session).value?.projects[value.project] ?? initial)
      : initial
  }
  function save(change: Partial<typeof initial>) {
    const value = current()
    if (!value) return
    const store = ctx.stores.trajectoryView(props.session)
    store.update((draft) => {
      draft.projects[value.project] = { ...(draft.projects[value.project] ?? initial), ...change }
    })
  }

  const expectedKey = () => {
    const value = current()
    const view = prefs()
    return value
      ? JSON.stringify([value.server, value.project, value.projectID, value.session, view.scope])
      : ""
  }
  const visible = () => (data().key === expectedKey() ? data() : undefined)
  onCleanup(() => {
    state.close()
    endDrag?.()
    axisObserver?.disconnect()
  })

  createKeyed(
    () => {
      const value = current()
      if (!value || !ctx.stores.trajectoryView(props.session).ready()) return undefined
      const view = prefs()
      return {
        value,
        view,
        key: JSON.stringify([
          value.server,
          value.project,
          value.projectID,
          value.session,
          view.scope,
        ]),
      }
    },
    ({ value, view, key }) => {
      setSplit(clampSplit(view.split))
      const scope = { kind: view.scope, sessionID: value.session } as const
      const rpc = value.client.rpc(Observability)
      const transport = createTrajectoryTransport(
        rpc,
        value.directory,
        () => props.session.server.connected,
        value.client.event,
        value.projectID,
      )
      handledTargetRequestID = view.target?.requestID ?? ""
      state.connect(key, value.projectID, value.project, scope, transport, {
        target: view.target,
        taskID: view.selectedTaskID,
        selection: selectionFrom(view),
      })
      onCleanup(() => state.close())
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => state.close(),
    },
  )

  createEffect(() => {
    const value = current()
    if (value && props.session.server.connected) void state.refresh()
  })

  createEffect(() => {
    const value = current()
    const target = prefs().target
    if (!value || !target || target.requestID === handledTargetRequestID) return
    handledTargetRequestID = target.requestID
    state.selectTarget(target)
  })

  const currentData = () => visible()
  const report = () => currentData()?.report
  const selectedTask = () =>
    currentData()?.tasks.find((task) => task.taskID === currentData()?.taskID)
  const allTaskChecks = () => (report() ? detailedChecks(report()!) : [])
  const selectedEvent = () => selectedEventFor(currentData())
  const selectedCheck = () => {
    const selection = currentData()?.selection
    return selection?.kind === "check"
      ? allTaskChecks().find((check) => checkKey(check) === selection.id)
      : undefined
  }
  const selectedAttempt = () => selectedAttemptFor(currentData())
  const checksForInspector = () => {
    const attempt = selectedAttempt()
    return allTaskChecks().filter(
      (check) => !attempt || check.attemptID === attempt.id || check.scope === "plan",
    )
  }
  const timelineInput = createMemo(
    () => {
      const value = currentData()
      return value?.taskID && (value.snapshot || value.report)
        ? { snapshot: value.snapshot, taskID: value.taskID, report: value.report }
        : undefined
    },
    undefined,
    {
      equals: (left, right) =>
        left?.snapshot === right?.snapshot &&
        left?.taskID === right?.taskID &&
        left?.report === right?.report,
    },
  )
  const timeline = createMemo(() => {
    const value = timelineInput()
    return value ? buildTimeline(value.snapshot, value.taskID, value.report) : undefined
  })
  const model = () => modelName(report())
  const runTotal = () => attemptCount(report())
  const splitTo = (next: number) => setSplit(clampSplit(next))
  const drag: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    endDrag?.()
    const key = expectedKey()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      const rect = root?.getBoundingClientRect()
      if (rect)
        splitTo(
          splitFromPointer(
            split(),
            rect.top,
            rect.height,
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
  const selectionForTimelineCheck = (check: {
    planID?: string | null
    attemptID: string | null
    checkID: string
  }) =>
    allTaskChecks().find(
      (candidate) =>
        candidate.planID === check.planID &&
        candidate.attemptID === check.attemptID &&
        candidate.id === check.checkID,
    )
  const openAttemptSession = (sessionID: string) => {
    ctx.tabs.open({ server: props.session.server.id, id: sessionID }, { focus: true })
  }
  const openSource = (reference: { path: string; line: number }) => {
    const path = props.screen.file.resolve(reference.path)
    if (props.screen.file.absolute(path)) return
    props.screen.file.selection.set(path, { start: reference.line, end: reference.line })
    ctx.links.open({
      href: path,
      exact: true,
      base: props.session.directory,
      session: props.session,
    })
  }
  const timeText = (value: number | null) => formatTime(value, timeline()?.origin ?? null)
  const selectScope = (scope: "session" | "project") => {
    save({
      scope,
      selectedTaskID: null,
      selectedReference: null,
      target: null,
      selectedKind: "",
      selectedRecordID: "",
    })
  }
  const selectTask = (taskID: string) => {
    save({
      selectedTaskID: taskID,
      selectedReference: null,
      target: null,
      selectedKind: "",
      selectedRecordID: "",
    })
    state.selectTask(taskID)
  }
  const checkOutput = (check: DetailedCheck) =>
    [
      check.stdout ? `stdout\n${check.stdout}` : "",
      check.stderr ? `stderr\n${check.stderr}` : "",
      check.error ? `error\n${check.error}` : "",
    ]
      .filter(Boolean)
      .join("\n\n") || "No output was recorded."
  const checkSources = (check: DetailedCheck) =>
    sourceReferences(`${check.stdout ?? ""}\n${check.stderr ?? ""}\n${check.error ?? ""}`)
  const checkLabel = (check: DetailedCheck) => check.command ?? check.id
  const checkResult = (check: DetailedCheck) =>
    check.exitCode === null ? check.result : `${check.result} · exit ${check.exitCode}`

  return (
    <div
      class="lazers-trajectory"
      ref={(element) => {
        root = element
      }}
      style={{
        "--trajectory-visual-fr": `${split()}fr`,
        "--trajectory-inspector-fr": `${100 - split()}fr`,
      }}
    >
      <div
        class="lazers-trajectory-top"
        ref={(element) => {
          topPane = element
        }}
      >
        <div class="lazers-trajectory-controls">
          <span class="lazers-trajectory-task-menu">
            <Ui.Menu
              label={
                selectedTask()?.taskID.slice(0, 8) ??
                currentData()?.taskID?.slice(0, 8) ??
                "Choose task"
              }
              trigger="button"
              disabled={!currentData()?.tasks.length}
              items={(currentData()?.tasks ?? []).map((task) => ({
                label: `${task.title ?? task.taskID.slice(0, 8)} · ${task.status}`,
                onSelect: () => selectTask(task.taskID),
              }))}
            />
          </span>
          <span class="lazers-trajectory-scope">
            <Ui.Menu
              label={prefs().scope === "session" ? "Session" : "Project"}
              trigger="button"
              items={[
                { label: "This session", onSelect: () => selectScope("session") },
                { label: "Project tasks", onSelect: () => selectScope("project") },
              ]}
            />
          </span>
          <span
            class="lazers-trajectory-dot"
            data-stale={Boolean(currentData()?.stale || !props.session.server.connected)}
            role="img"
            aria-label={
              !props.session.server.connected
                ? "Trajectory updates disconnected"
                : currentData()?.stale
                  ? "Trajectory data may be stale"
                  : "Trajectory updates connected"
            }
          />
        </div>
        <Show when={currentData()?.error}>
          <div class="lazers-trajectory-error" role="alert">
            {currentData()?.error}
            <Ui.Button variant="ghost" size="small" onClick={() => void state.refresh()}>
              Retry status
            </Ui.Button>
          </div>
        </Show>
        <Show when={!report() && currentData()?.historyError}>
          <div class="lazers-trajectory-error" role="alert">
            {currentData()?.historyError}
            <Ui.Button
              variant="ghost"
              size="small"
              busy={currentData()?.recapturingHistory}
              onClick={() => void state.recaptureActivity()}
            >
              Recapture history
            </Ui.Button>
          </div>
        </Show>
        <Show
          when={currentData()?.report}
          fallback={
            <div class="lazers-trajectory-note">
              {currentData()?.loading ? (
                <Ui.Loader size="small" />
              ) : currentData()?.tasks.length ? (
                "Trajectory data is not available yet."
              ) : (
                "No tasks are associated with this scope."
              )}
            </div>
          }
        >
          <>
            <h2 class="lazers-trajectory-heading">{report()?.task.specification.objective}</h2>
            <div class="lazers-trajectory-heading-row">
              <span
                class="lazers-trajectory-id"
                style={{ "font-family": ctx.appearance.font("mono") }}
              >
                {currentData()?.taskReference ? `${currentData()!.taskReference} · ` : ""}
                {report()?.task.id.slice(0, 8)}
                {report()?.task.revision ? ` · r${report()?.task.revision}` : ""}
              </span>
              <Ui.Button
                size="small"
                variant="ghost-muted"
                class="lazers-trajectory-copy"
                aria-label="Copy task ID"
                onClick={() => {
                  const id = report()?.task.id
                  if (id) void ctx.system.copy(id)
                }}
              >
                Copy ID
              </Ui.Button>
            </div>
            <div class="lazers-trajectory-task-meta">
              <span>{model()}</span>
              <span aria-hidden="true">·</span>
              <span>{runTotal()}</span>
            </div>
            <div class="lazers-trajectory-axis-caption">Elapsed since first attempt</div>
            <Show when={timeline()?.origin !== null && timeline()?.origin !== undefined}>
              <div class="lazers-trajectory-axis" aria-hidden="true">
                <span />
                <div
                  class="lazers-trajectory-axis-track"
                  ref={(element) => {
                    axisObserver?.disconnect()
                    setAxisWidth(element.getBoundingClientRect().width)
                    axisObserver = new ResizeObserver((entries) =>
                      setAxisWidth(entries[0]?.contentRect.width ?? 0),
                    )
                    axisObserver.observe(element)
                  }}
                >
                  <For
                    each={visibleTicks(
                      timeline()?.ticks ?? [],
                      timeline()?.durationMs ?? 0,
                      axisWidth(),
                    )}
                  >
                    {(tick) => (
                      <span
                        class="lazers-trajectory-tick"
                        style={{
                          left: `${(tick.elapsedMs / (timeline()?.durationMs || 1)) * 100}%`,
                        }}
                      >
                        {tick.label}
                      </span>
                    )}
                  </For>
                </div>
                <span />
              </div>
              <div
                class="lazers-trajectory-attempts"
                role="group"
                aria-label="Worker attempts timeline"
              >
                <For each={timeline()?.attempts ?? []}>
                  {(lane) => {
                    const detail = () =>
                      report()?.attempts.find((attempt) => attempt.id === lane.attempt.id)
                    const selected = () =>
                      (currentData()?.selection?.kind === "attempt" &&
                        currentData()?.selection?.id === lane.attempt.id) ||
                      (currentData()?.selection?.kind === "check" &&
                        selectedCheck()?.attemptID === lane.attempt.id)
                    return (
                      <div
                        class="lazers-trajectory-attempt"
                        data-selected={selected()}
                        aria-current={selected() ? "true" : undefined}
                      >
                        <button
                          type="button"
                          class="lazers-trajectory-attempt-label"
                          aria-label={`Select attempt ${lane.attempt.number}, ${lane.attempt.state}`}
                          aria-pressed={selected()}
                          title={lane.attempt.timingBasis}
                          onClick={() => state.selectAttempt(lane.attempt.id)}
                        >
                          <span class="lazers-trajectory-attempt-number">
                            {lane.attempt.number}
                          </span>
                          <span class="lazers-trajectory-attempt-state">{lane.attempt.state}</span>
                        </button>
                        <div class="lazers-trajectory-track">
                          <For each={lane.segments}>
                            {(segment) => (
                              <span
                                class="lazers-trajectory-segment"
                                data-failed={lane.attempt.state === "failed"}
                                data-point={segment.pointOnly}
                                hidden={!segment.visible}
                                title={segment.basis}
                                style={{
                                  left: `${segment.left}%`,
                                  width: `${segment.width}%`,
                                }}
                              />
                            )}
                          </For>
                          <For
                            each={
                              timeline()?.checks.filter(
                                (check) => check.attemptID === lane.attempt.id,
                              ) ?? []
                            }
                          >
                            {(check) => {
                              const detailed = () => selectionForTimelineCheck(check)
                              const timing = () => checkTiming(check)
                              const selected = () =>
                                Boolean(
                                  detailed() &&
                                  selectedCheck() &&
                                  checkKey(detailed()!) === checkKey(selectedCheck()!),
                                )
                              return (
                                <>
                                  <span
                                    class="lazers-trajectory-check-interval"
                                    data-result={detailed()?.result ?? "unknown"}
                                    data-point={check.pointOnly}
                                    data-selected={selected()}
                                    data-invalid={timing().status === "invalid-order"}
                                    aria-hidden="true"
                                    hidden={!check.visible}
                                    style={{ left: `${check.left}%`, width: `${check.width}%` }}
                                  />
                                  <Show
                                    when={
                                      timing().status === "invalid-order" && check.endLeft !== null
                                    }
                                  >
                                    <span
                                      class="lazers-trajectory-check-endpoint"
                                      aria-hidden="true"
                                      style={{ left: `${check.endLeft}%` }}
                                    />
                                  </Show>
                                  <Show when={check.visible}>
                                    <button
                                      type="button"
                                      class="lazers-trajectory-check-marker"
                                      data-result={detailed()?.result ?? "unknown"}
                                      aria-pressed={selected()}
                                      aria-label={`Select check ${check.checkID}, ${detailed()?.result ?? check.state}, ${timingHint(check)}`}
                                      title={`${check.checkID} · ${check.timingBasis}`}
                                      style={{
                                        left: `clamp(12px, ${check.left + check.width / 2}%, calc(100% - 12px))`,
                                      }}
                                      onClick={() => {
                                        const value = detailed()
                                        if (value) state.selectCheck(checkKey(value))
                                      }}
                                    />
                                  </Show>
                                </>
                              )
                            }}
                          </For>
                        </div>
                        <span class="lazers-trajectory-tool-count">
                          {detail()?.toolCount.value.toLocaleString() ?? "Unknown"} calls
                        </span>
                      </div>
                    )
                  }}
                </For>
                <For each={timeline()?.checks.filter((check) => check.attemptID === null) ?? []}>
                  {(check) => {
                    const detailed = () => selectionForTimelineCheck(check)
                    const timing = () => checkTiming(check)
                    const selected = () =>
                      Boolean(
                        detailed() &&
                        selectedCheck() &&
                        checkKey(detailed()!) === checkKey(selectedCheck()!),
                      )
                    return (
                      <div class="lazers-trajectory-plan-checks" data-selected={selected()}>
                        <span>Plan check · {check.checkID}</span>
                        <div class="lazers-trajectory-track">
                          <span
                            class="lazers-trajectory-check-interval"
                            data-result={detailed()?.result ?? "unknown"}
                            data-point={check.pointOnly}
                            data-selected={selected()}
                            data-invalid={timing().status === "invalid-order"}
                            aria-hidden="true"
                            hidden={!check.visible}
                            style={{ left: `${check.left}%`, width: `${check.width}%` }}
                          />
                          <Show
                            when={timing().status === "invalid-order" && check.endLeft !== null}
                          >
                            <span
                              class="lazers-trajectory-check-endpoint"
                              aria-hidden="true"
                              style={{ left: `${check.endLeft}%` }}
                            />
                          </Show>
                          <Show when={check.visible}>
                            <button
                              type="button"
                              class="lazers-trajectory-check-marker"
                              data-result={detailed()?.result ?? "unknown"}
                              aria-pressed={selected()}
                              aria-label={`Select plan check ${check.checkID}, ${timingHint(check)}`}
                              title={`${check.checkID} · ${check.timingBasis}`}
                              style={{
                                left: `clamp(12px, ${check.left + check.width / 2}%, calc(100% - 12px))`,
                              }}
                              onClick={() => {
                                const value = detailed()
                                if (value) state.selectCheck(checkKey(value))
                              }}
                            />
                          </Show>
                        </div>
                        <span />
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </>
        </Show>
      </div>

      <div
        class="lazers-trajectory-separator"
        ref={(element) => {
          separator = element
        }}
        role="separator"
        aria-label="Resize trajectory inspector"
        aria-orientation="horizontal"
        aria-valuemin={20}
        aria-valuemax={75}
        aria-valuenow={Math.round(split())}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
          event.preventDefault()
          splitTo(splitFromKey(split(), event.key))
          save({ split: split() })
        }}
      />

      <div
        class="lazers-trajectory-inspector"
        ref={(element) => {
          inspectorPane = element
        }}
      >
        <Show
          when={currentData()?.selection}
          fallback={<div class="lazers-trajectory-note">Select an attempt, check, or event.</div>}
        >
          <>
            <Show when={selectedCheck()}>
              {(check) => (
                <>
                  <div class="lazers-trajectory-inspector-heading">
                    <h3>
                      {selectedAttempt() ? `Attempt ${selectedAttempt()!.number} · ` : ""}
                      {checkLabel(check())}
                    </h3>
                    <span class="lazers-trajectory-result" data-result={check().result}>
                      {checkResult(check())}
                    </span>
                  </div>
                  <div class="lazers-trajectory-metadata">
                    <p>
                      {check().scope === "plan" ? "Plan check" : "Attempt check"} · {check().state}
                    </p>
                    <p>{endpointText("Start", check().startedAt, timeline()?.origin ?? null)}</p>
                    <p>{endpointText("End", check().endedAt, timeline()?.origin ?? null)}</p>
                    <p
                      role={checkTiming(check()).status === "invalid-order" ? "alert" : "status"}
                      aria-live={
                        checkTiming(check()).status === "invalid-order" ? "assertive" : "polite"
                      }
                    >
                      {checkTiming(check()).status === "known"
                        ? `Elapsed duration · ${elapsedText(checkTiming(check()).durationMs!)}`
                        : `Duration unavailable · ${checkTiming(check()).reason}`}
                    </p>
                    <p>Timing source · {check().timingBasis}</p>
                  </div>
                  <div class="lazers-trajectory-source-links">
                    <For each={checkSources(check())}>
                      {(reference) => (
                        <button type="button" onClick={() => openSource(reference)}>
                          {reference.path}:{reference.line}
                          {reference.column ? `:${reference.column}` : ""}
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={selectedAttempt()}>
                    {(attempt) => (
                      <button
                        type="button"
                        class="lazers-trajectory-session-link"
                        onClick={() => openAttemptSession(attempt().sessionID)}
                      >
                        Open worker session <span aria-hidden="true">↗</span>
                      </button>
                    )}
                  </Show>
                  <details class="lazers-trajectory-payload">
                    <summary>Check output</summary>
                    <div class="lazers-trajectory-metadata">
                      <Show when={check().timedOut !== null || check().unchanged !== null}>
                        <p>
                          {check().timedOut === null
                            ? "Timeout unknown"
                            : check().timedOut
                              ? "Timed out"
                              : "Not timed out"}
                          {check().unchanged === null
                            ? " · artifact change unknown"
                            : check().unchanged
                              ? " · artifact unchanged"
                              : " · artifact changed"}
                        </p>
                      </Show>
                    </div>
                    <pre>{checkOutput(check())}</pre>
                  </details>
                </>
              )}
            </Show>

            <Show when={!selectedCheck() && selectedAttempt()}>
              {(attempt) => (
                <>
                  <div class="lazers-trajectory-inspector-heading">
                    <h3>Attempt {attempt().number}</h3>
                    <span class="lazers-trajectory-result">{attempt().state}</span>
                  </div>
                  <div class="lazers-trajectory-metadata">
                    <p>
                      Runner reservation start · {timeText(attempt().intervals.attempt.startedAt)}
                    </p>
                    <p>Runner attempt end · {timeText(attempt().intervals.attempt.endedAt)}</p>
                    <p>{attempt().intervals.attempt.basis}</p>
                    <p>Worker session · {attempt().sessionID}</p>
                  </div>
                  <button
                    type="button"
                    class="lazers-trajectory-session-link"
                    onClick={() => openAttemptSession(attempt().sessionID)}
                  >
                    Open worker session <span aria-hidden="true">↗</span>
                  </button>
                </>
              )}
            </Show>

            <Show when={selectedEvent()}>
              {(event) => (
                <>
                  <div class="lazers-trajectory-inspector-heading">
                    <h3>{eventTitle(event())}</h3>
                    <span class="lazers-trajectory-result">{eventTime(event())}</span>
                  </div>
                  <div class="lazers-trajectory-metadata">
                    <p>
                      {event().kind} · {timeText(event().at ?? null)}
                    </p>
                    <Show when={event().sessionID}>
                      {(sessionID) => (
                        <button
                          type="button"
                          class="lazers-trajectory-session-link"
                          onClick={() => openAttemptSession(sessionID())}
                        >
                          Open worker session <span aria-hidden="true">↗</span>
                        </button>
                      )}
                    </Show>
                  </div>
                  <details class="lazers-trajectory-payload">
                    <summary>Payload</summary>
                    <pre>{JSON.stringify(eventPayload(event()), null, 2)}</pre>
                  </details>
                </>
              )}
            </Show>

            <Show when={checksForInspector().length > 0}>
              <section class="lazers-trajectory-section">
                <div class="lazers-trajectory-section-heading">
                  <h4>Checks</h4>
                </div>
                <div class="lazers-trajectory-check-list" role="list" aria-label="Recorded checks">
                  <For each={checksForInspector()}>
                    {(check) => (
                      <button
                        type="button"
                        class="lazers-trajectory-check-row"
                        aria-pressed={
                          currentData()?.selection?.kind === "check" &&
                          currentData()?.selection?.id === checkKey(check)
                        }
                        onClick={() => state.selectCheck(checkKey(check))}
                      >
                        <span class="lazers-trajectory-check-name">{checkLabel(check)}</span>
                        <span class="lazers-trajectory-check-status">{checkResult(check)}</span>
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            <Show when={report()}>
              {(currentReport) => {
                const usage = () => currentReport().effort.tokenUsage
                const tokenValue = (
                  key: keyof TrajectoryReport["effort"]["tokenUsage"]["measuredSubtotal"],
                ) => {
                  const value =
                    usage().total?.[key] ??
                    (usage().knownSessions > 0 ? usage().measuredSubtotal[key] : null)
                  return value === null ? "—" : value.toLocaleString()
                }
                const partial = () => usage().total === null
                const apiCost = () => currentReport().effort.recordedCost.apiEquivalentTotalUsd
                const marketCost = () => currentReport().effort.marketEquivalentCost
                const marketStatus = () => marketCost()?.status ?? "unknown"
                const formatMarketUSD = (value: number) =>
                  `$${new Intl.NumberFormat("en-US", {
                    maximumSignificantDigits: 6,
                    useGrouping: false,
                  }).format(value)}`
                const displayedMarketCost = () => {
                  const value = apiCost()
                  if (value !== null) return formatMarketUSD(value)
                  const subtotal = marketCost()?.subtotalUSD ?? null
                  return subtotal === null ? "—" : `${formatMarketUSD(subtotal)} subtotal`
                }
                const priceSourceSummary = () => {
                  const index = marketCost()?.currentIndex
                  if (!index) return "Price source unavailable"
                  const sources = index.sources.map(
                    (source) =>
                      `${source.source === "openrouter-models" ? "OpenRouter" : "OpenCode"} · generation ${source.generation}`,
                  )
                  return `${sources.join("; ") || "No selected cached price source"} · ${index.freshness} freshness`
                }
                const categories = [
                  ["Uncached input", "uncachedInput"],
                  ["Cache read", "cacheRead"],
                  ["Cache write", "cacheWrite"],
                  ["Output", "output"],
                  ["Reasoning", "reasoning"],
                ] as const
                return (
                  <>
                    <section class="lazers-trajectory-section" aria-label="Token usage">
                      <div class="lazers-trajectory-section-heading">
                        <h4>Tokens</h4>
                        <span class="lazers-trajectory-token-scope">
                          All {currentReport().attempts.length}{" "}
                          {currentReport().attempts.length === 1 ? "attempt" : "attempts"}
                        </span>
                      </div>
                      <Show when={partial()}>
                        <div class="lazers-trajectory-coverage" role="status">
                          Known subtotal · full total unavailable; {usage().knownSessions} of{" "}
                          {usage().totalSessions} unique worker sessions have token snapshots.
                        </div>
                      </Show>
                      <For each={categories}>
                        {([label, key]) => (
                          <div class="lazers-trajectory-token-row">
                            <span>{label}</span>
                            <output>{tokenValue(key)}</output>
                          </div>
                        )}
                      </For>
                      <div
                        class="lazers-trajectory-cost"
                        title="Market-equivalent worker usage is not actual provider charges or full task cost."
                      >
                        <span>API equivalent · {marketStatus()}</span>
                        <span>{displayedMarketCost()}</span>
                      </div>
                      <Show when={marketCost()}>
                        <div class="lazers-trajectory-coverage">
                          <span>{priceSourceSummary()}</span>
                        </div>
                        <details class="lazers-trajectory-payload lazers-trajectory-valuation">
                          <summary>Pricing coverage and provenance</summary>
                          <p>{marketCost()!.meaning}</p>
                          <Show when={marketCost()!.currentIndex}>
                            {(index) => (
                              <div class="lazers-trajectory-coverage">
                                <div>Models index {index().indexID}</div>
                                <div>Read {new Date(index().retrievedAt).toLocaleString()}</div>
                                <For each={index().sources}>
                                  {(source) => (
                                    <div>
                                      {source.source} · snapshot {source.snapshotID} · generation{" "}
                                      {source.generation} · {source.priceBasis} · {source.rateUnit}
                                      {source.asOf ? ` · as of ${source.asOf}` : ""}
                                    </div>
                                  )}
                                </For>
                              </div>
                            )}
                          </Show>
                          <div class="lazers-trajectory-coverage">
                            {marketCost()!.coverage.pricedSessions} /{" "}
                            {marketCost()!.coverage.totalUniqueSessions} sessions fully priced ·{" "}
                            {marketCost()!.coverage.partialSessions} partial ·{" "}
                            {marketCost()!.coverage.unpricedSessionIDs.length} unpriced
                          </div>
                          <For each={marketCost()!.sessions}>
                            {(session) => (
                              <div class="lazers-trajectory-coverage">
                                <span>
                                  Session {session.sessionID} · {session.status} · route{" "}
                                  {session.routeAllocation.status} · price {session.pinStatus}
                                </span>
                                <span>
                                  <For each={Object.entries(session.categories)}>
                                    {([name, category]) => (
                                      <span>
                                        {name}: {category.status}
                                        {category.valueUSD === null
                                          ? ""
                                          : ` · ${formatMarketUSD(category.valueUSD)}`}{" "}
                                      </span>
                                    )}
                                  </For>
                                </span>
                              </div>
                            )}
                          </For>
                        </details>
                      </Show>
                      <div class="lazers-trajectory-coverage">
                        <span>
                          {usage().knownSessions} / {usage().totalSessions} unique sessions ·{" "}
                          {usage().unknownAttempts.length} worker-session token gaps
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          Context {currentReport().coverage.availableSessionContexts} available ·{" "}
                          {currentReport().coverage.unavailableSessionContexts} unavailable
                        </span>
                        <Show when={currentReport().coverage.compacted}>
                          <span>Compacted context; complete history is not guaranteed.</span>
                        </Show>
                      </div>
                    </section>
                    <details class="lazers-trajectory-activity">
                      <summary>Captured activity · {currentData()?.totalEvents ?? 0}</summary>
                      <div class="lazers-trajectory-activity-list">
                        <div class="lazers-trajectory-capture-note" role="status">
                          <span>
                            {currentData()?.historyCapturedAt
                              ? `Captured ${new Date(currentData()!.historyCapturedAt!).toLocaleString()} · expires ${new Date(currentData()!.historyExpiresAt!).toLocaleTimeString()}`
                              : "History capture time unavailable"}
                          </span>
                          <Ui.Button
                            variant="ghost"
                            size="small"
                            busy={currentData()?.recapturingHistory}
                            onClick={() => void state.recaptureActivity()}
                          >
                            Recapture history
                          </Ui.Button>
                        </div>
                        <Show when={currentData()?.historyError}>
                          <div class="lazers-trajectory-error" role="alert">
                            {currentData()?.historyError}
                          </div>
                        </Show>
                        <For each={currentData()?.events ?? []}>
                          {(event) => (
                            <button
                              type="button"
                              class="lazers-trajectory-event"
                              data-scroll-anchor={`history:${event.id}`}
                              aria-pressed={
                                currentData()?.selection?.kind === "event" &&
                                currentData()?.selection?.id === event.id
                              }
                              onClick={() => state.selectEvent(event.id)}
                            >
                              <span class="lazers-trajectory-event-title">{eventTitle(event)}</span>
                              <time>{eventTime(event)}</time>
                            </button>
                          )}
                        </For>
                        <Show when={currentData()?.eventCursor}>
                          <Ui.Button
                            variant="ghost"
                            size="small"
                            busy={
                              currentData()?.loadingActivity || currentData()?.recapturingHistory
                            }
                            onClick={() => void state.loadMoreActivity()}
                          >
                            Load more activity
                          </Ui.Button>
                        </Show>
                      </div>
                    </details>
                    <Show when={(currentData()?.liveEvents.length ?? 0) > 0}>
                      <details class="lazers-trajectory-live">
                        <summary>Live progress · {currentData()?.liveEvents.length ?? 0}</summary>
                        <p class="lazers-trajectory-live-note">
                          Current progress is shown separately; captured history stays as of its
                          capture until you recapture it.
                        </p>
                        <div class="lazers-trajectory-activity-list">
                          <For each={currentData()?.liveEvents ?? []}>
                            {(event) => (
                              <button
                                type="button"
                                class="lazers-trajectory-event"
                                data-scroll-anchor={`live:${event.id}`}
                                aria-pressed={
                                  currentData()?.selection?.kind === "event" &&
                                  currentData()?.selection?.id === event.id
                                }
                                onClick={() => state.selectEvent(event.id)}
                              >
                                <span class="lazers-trajectory-event-title">
                                  {eventTitle(event)}
                                </span>
                                <time>{eventTime(event)}</time>
                              </button>
                            )}
                          </For>
                        </div>
                      </details>
                    </Show>
                  </>
                )
              }}
            </Show>
          </>
        </Show>
      </div>
    </div>
  )
}

export function setupTrajectoryPanel(ctx: TrajectoryContext) {
  const Ui = ctx.ui
  registerTrajectoryPanel(
    ctx,
    css,
    bindPlugin((props: PanelProps) => <PanelView {...props} ctx={ctx} />),
    () => (
      <div class="flex min-w-0 items-center gap-1.5">
        <Ui.Icon name="branch" size="small" class="shrink-0" />
        <span class="truncate">Trajectory</span>
      </div>
    ),
  )
}

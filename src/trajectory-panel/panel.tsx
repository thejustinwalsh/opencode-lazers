import { Store, bindPlugin, createKeyed, createLatest, usePanel } from "@opencode/plugin/gui"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { Observability } from "../observability/contract.ts"
import { clampSplit, splitFromKey, splitFromPointer, visibleTicks } from "./panel-layout.ts"
import type { PanelData, PanelPreferences, Selection } from "./panel-state.ts"
import { selectedAttemptFor, TrajectoryPanelState } from "./panel-state.ts"
import {
  buildTimeline,
  checkKey,
  detailedChecks,
  eventPayload,
  sourceReferences,
} from "./projection.ts"
import type { DetailedCheck, TrajectoryEvent, TrajectoryReport } from "./projection.ts"
import { createTrajectoryTransport } from "./projection.ts"
import { registerTrajectoryPanel } from "./registration.ts"
import css from "./panel.css?inline"

const SelectionKind = Schema.Literals(["", "attempt", "check", "event"])
const View = Schema.Struct({
  scope: Schema.Literals(["session", "project"]),
  selectedTaskID: Schema.NullOr(Schema.String),
  selectedKind: SelectionKind,
  selectedRecordID: Schema.String,
  split: Schema.Number,
})
const initial: typeof View.Type = {
  scope: "session",
  selectedTaskID: null,
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

function eventTitle(event: TrajectoryEvent) {
  if (event.kind === "tool") return `${event.tool ?? "Tool"} · ${event.status ?? "unknown"}`
  if (event.kind === "verification")
    return `Check ${event.checkID ?? ""} · ${event.status ?? "unknown"}`
  if (event.kind === "runner-transition")
    return `${event.event ?? "Transition"}${event.to ? ` · ${event.to}` : ""}`
  if (event.kind === "runner-effect")
    return `${event.effect ?? "Runner effect"} · ${event.state ?? "unknown"}`
  if (event.kind === "assistant-text") return "Worker message"
  return event.kind
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
    selection: null,
    events: [],
    eventCursor: null,
    totalEvents: 0,
    loading: true,
    loadingActivity: false,
    stale: false,
    error: "",
  })
  const [split, setSplit] = createSignal(initial.split)
  const [axisWidth, setAxisWidth] = createSignal(0)
  let axisObserver: ResizeObserver | undefined
  const state = new TrajectoryPanelState(setData, (preferences: PanelPreferences) => {
    save({
      selectedTaskID: preferences.taskID,
      selectedKind: preferences.selection?.kind ?? "",
      selectedRecordID: preferences.selection?.id ?? "",
    })
  })
  let root: HTMLDivElement | undefined
  let separator: HTMLDivElement | undefined
  let endDrag: (() => void) | undefined

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
      )
      state.connect(key, value.projectID, scope, transport, {
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

  const currentData = () => visible()
  const report = () => currentData()?.report
  const selectedTask = () =>
    currentData()?.tasks.find((task) => task.taskID === currentData()?.taskID)
  const allTaskChecks = () => (report() ? detailedChecks(report()!) : [])
  const selectedEvent = () => {
    const selection = currentData()?.selection
    return selection?.kind === "event"
      ? currentData()?.events.find((event) => event.id === selection.id)
      : undefined
  }
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
  const timeline = () => {
    const value = currentData()
    return value?.snapshot && value.taskID
      ? buildTimeline(value.snapshot, value.taskID, value.report)
      : undefined
  }
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
    save({ scope, selectedTaskID: null, selectedKind: "", selectedRecordID: "" })
  }
  const selectTask = (taskID: string) => {
    save({ selectedTaskID: taskID, selectedKind: "", selectedRecordID: "" })
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
      <div class="lazers-trajectory-top">
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
              Retry
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
                              return (
                                <button
                                  type="button"
                                  class="lazers-trajectory-check-marker"
                                  data-result={detailed()?.result ?? "unknown"}
                                  aria-pressed={Boolean(
                                    detailed() &&
                                    selectedCheck() &&
                                    checkKey(detailed()!) === checkKey(selectedCheck()!),
                                  )}
                                  aria-label={`Select check ${check.checkID}, ${detailed()?.result ?? check.state}`}
                                  title={`${check.checkID} · ${check.timingBasis}`}
                                  style={{ left: `${check.left}%` }}
                                  onClick={() => {
                                    const value = detailed()
                                    if (value) state.selectCheck(checkKey(value))
                                  }}
                                />
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
                    return (
                      <div
                        class="lazers-trajectory-plan-checks"
                        data-selected={Boolean(
                          detailed() &&
                          selectedCheck() &&
                          checkKey(detailed()!) === checkKey(selectedCheck()!),
                        )}
                      >
                        <span>Plan check · {check.checkID}</span>
                        <div class="lazers-trajectory-track">
                          <button
                            type="button"
                            class="lazers-trajectory-check-marker"
                            data-result={detailed()?.result ?? "unknown"}
                            aria-pressed={Boolean(
                              detailed() &&
                              selectedCheck() &&
                              checkKey(detailed()!) === checkKey(selectedCheck()!),
                            )}
                            aria-label={`Select plan check ${check.checkID}`}
                            title={check.timingBasis}
                            style={{ left: `${check.left}%` }}
                            onClick={() => {
                              const value = detailed()
                              if (value) state.selectCheck(checkKey(value))
                            }}
                          />
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

      <div class="lazers-trajectory-inspector">
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
                    <p>
                      Started {timeText(check().startedAt)} · ended {timeText(check().endedAt)}
                    </p>
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
                      <p>{check().timingBasis}</p>
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
                        title="API-equivalent cost is unknown without complete pricing provenance."
                      >
                        <span>API equivalent</span>
                        <span>{apiCost() === null ? "—" : `$${apiCost()!.toFixed(4)}`}</span>
                      </div>
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
                      <summary>Activity · {currentData()?.totalEvents ?? 0}</summary>
                      <div class="lazers-trajectory-activity-list">
                        <For each={currentData()?.events ?? []}>
                          {(event) => (
                            <button
                              type="button"
                              class="lazers-trajectory-event"
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
                            busy={currentData()?.loadingActivity}
                            onClick={() => void state.loadMoreActivity()}
                          >
                            Load more activity
                          </Ui.Button>
                        </Show>
                      </div>
                    </details>
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

import {
  Command,
  MenuItem,
  Panel,
  Store,
  Style,
  bindPlugin,
  createLatest,
  createKeyed,
  usePanel,
} from "@opencode/plugin/gui"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { For, Show, createSignal, onCleanup, createEffect } from "solid-js"
import type { JSX } from "solid-js"
import { Tasks } from "./contract.ts"
import { TaskPanelState } from "./panel-state.ts"
import type { PanelData } from "./panel-state.ts"
import { clampSplit, splitFromPointer } from "./panel-layout.ts"
import { taskTitle } from "./presentation.ts"
import { StartFeedback, ScrollRestoration, canStart, connectionLabel } from "./panel-view.ts"
import css from "./panel.css?inline"

const View = Schema.Struct({
  scope: Schema.Literals(["session", "project"]),
  selectedID: Schema.NullOr(Schema.String),
  search: Schema.String,
  split: Schema.Number,
  listScroll: Schema.Number,
  detailScroll: Schema.Number,
})
const initial: typeof View.Type = {
  scope: "session",
  selectedID: null,
  search: "",
  split: 48,
  listScroll: 0,
  detailScroll: 0,
}
export const taskStores = {
  taskView: Store.session(Schema.Struct({ projects: Schema.Record(Schema.String, View) }), {
    projects: {},
  }),
}
type TaskContext = SetupContext<{ stores: typeof taskStores }>

function TaskPanel(props: PanelProps & { ctx: TaskContext }) {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()
  const [data, setData] = createSignal<PanelData>({
    key: "",
    tasks: [],
    loading: true,
    stale: false,
    error: "",
  })
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [split, setSplit] = createSignal(48)
  const [startFeedback, setStartFeedback] = createSignal({ taskID: "", error: "" })
  const feedback = new StartFeedback(setStartFeedback)
  const listRestore = new ScrollRestoration()
  const detailRestore = new ScrollRestoration()
  let root: HTMLDivElement | undefined
  let header: HTMLElement | undefined
  let list: HTMLDivElement | undefined
  let separator: HTMLDivElement | undefined
  let detail: HTMLDivElement | undefined
  let endDrag: (() => void) | undefined
  const scope = createLatest(
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
      const location = await source.client.location.get(
        { location: { directory: source.directory } },
        { signal },
      )
      return { ...source, project: location.project.canonical }
    },
  )
  const current = () => {
    if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
    const value = scope.latest
    return value &&
      value.session === props.session.id &&
      value.server === props.session.server.id &&
      value.directory === props.session.directory &&
      !scope.loading
      ? value
      : undefined
  }
  const prefs = () => {
    const value = current()
    return value
      ? (ctx.stores.taskView(props.session).value?.projects[value.project] ?? initial)
      : initial
  }
  const save = (change: Partial<typeof initial>) => {
    const value = current()
    if (!value) return
    const store = ctx.stores.taskView(props.session)
    store.update((draft) => {
      draft.projects[value.project] = { ...(draft.projects[value.project] ?? initial), ...change }
    })
  }
  const state = new TaskPanelState(setData, (selectedID) =>
    save({
      selectedID,
      detailScroll: selectedID === prefs().selectedID ? prefs().detailScroll : 0,
    }),
  )
  onCleanup(() => {
    state.close()
    feedback.reset("")
    listRestore.restore("", false, undefined, 0)
    detailRestore.restore("", false, undefined, 0)
    endDrag?.()
  })
  createKeyed(
    () => {
      const value = current()
      if (!value || !frame.visible() || !ctx.stores.taskView(props.session).ready()) {
        return undefined
      }
      const key = JSON.stringify([
        value.server,
        value.project,
        value.session,
        prefs().scope,
        prefs().search,
      ])
      return { value, key }
    },
    ({ value, key }) => {
      const view = prefs()
      setSplit(view.split)
      const sessionID = view.scope === "session" ? value.session : undefined
      const rpc = () => props.session.server.client.rpc(Tasks)
      state.connect(
        key,
        value.project,
        {
          query: (input, signal) =>
            rpc().query(input, { location: { directory: value.directory }, signal }),
          get: (taskID, signal) =>
            rpc().get({ taskID, sessionID }, { location: { directory: value.directory }, signal }),
          start: (input, signal) =>
            rpc().start(input, { location: { directory: value.directory }, signal }),
          changes: (signal) =>
            (async function* () {
              for await (const event of rpc().events.subscribe("changed", { signal }))
                yield event.data
            })(),
          online: () => props.session.server.connected,
        },
        { search: view.search, sessionID, limit: 30 },
        view.selectedID ?? undefined,
      )
      onCleanup(() => state.close())
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => state.close(),
    },
  )
  const expectedKey = () => {
    const value = current()
    const view = prefs()
    return value
      ? JSON.stringify([value.server, value.project, value.session, view.scope, view.search])
      : ""
  }
  const visible = () => (data().key === expectedKey() ? data() : undefined)
  const selectionKey = () => JSON.stringify([expectedKey(), visible()?.selectedID])
  createEffect(() => {
    const value = visible()
    const view = prefs()
    listRestore.restore(expectedKey(), Boolean(value && !value.loading), list, view.listScroll)
    detailRestore.restore(
      selectionKey(),
      value?.detail?.status === "found",
      detail,
      view.detailScroll,
    )
  })
  createEffect(() => feedback.reset(selectionKey()))
  const selectedTask = () => {
    const result = visible()?.detail
    return result?.status === "found" ? result.task : undefined
  }
  const selectedExecution = () => {
    const detail = visible()?.detail
    return detail?.status === "found" ? detail.execution : undefined
  }
  const selectedDetail = () => {
    const result = visible()?.detail
    return result?.status === "found" ? result : undefined
  }
  const startTask = async (taskID: string, revision: 1) => {
    const value = current()
    if (!value) return
    feedback.reset(selectionKey())
    const ticket = feedback.begin(taskID)
    if (!ticket) return
    try {
      await state.start({ taskID, revision, sessionID: props.session.id })
    } catch (error) {
      feedback.fail(ticket, error)
    } finally {
      feedback.finish(ticket)
    }
  }
  const rowKey: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const rows = [...(list?.querySelectorAll<HTMLButtonElement>("[data-task-id]") ?? [])]
    const index = rows.indexOf(event.currentTarget)
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
    rows[next]?.focus()
    const id = rows[next]?.dataset.taskId
    if (id) void state.select(id)
  }
  const resize = (next: number) => setSplit(clampSplit(next))
  const drag: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    endDrag?.()
    const key = expectedKey()
    event.currentTarget.setPointerCapture(event.pointerId)
    const element = event.currentTarget
    const move = (moveEvent: PointerEvent) => {
      const rect = root?.getBoundingClientRect()
      if (rect)
        resize(
          splitFromPointer(
            split(),
            rect.top,
            rect.height,
            header?.getBoundingClientRect().height ?? 0,
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
  return (
    <div
      class="lazers-tasks"
      ref={(element) => {
        root = element
      }}
      style={{
        "--task-list-fr": `${split()}fr`,
        "--task-detail-fr": `${100 - split()}fr`,
      }}
    >
      <header
        class="lazers-tasks-header"
        ref={(element) => {
          header = element
        }}
      >
        <h2>Tasks</h2>
        <span
          class="lazers-tasks-dot"
          data-stale={visible()?.stale || !props.session.server.connected}
          role="img"
          aria-label={connectionLabel(Boolean(visible()?.stale), props.session.server.connected)}
        />
        <div class="lazers-tasks-controls">
          <span class="lazers-tasks-scope">
            <Ui.Menu
              label={prefs().scope === "session" ? "Session" : "Project"}
              trigger="button"
              icon="chevron-down"
              items={[
                {
                  label: "This session",
                  onSelect: () => save({ scope: "session", selectedID: null }),
                },
                {
                  label: "Project tasks",
                  onSelect: () => save({ scope: "project", selectedID: null }),
                },
              ]}
            />
          </span>
          <Ui.Tooltip value="Search tasks">
            <Ui.IconButton
              icon="magnifying-glass"
              label="Search tasks"
              size="small"
              pressed={searchOpen()}
              onClick={() => {
                if (searchOpen()) save({ search: "" })
                setSearchOpen(!searchOpen())
              }}
            />
          </Ui.Tooltip>
        </div>
        <Show when={searchOpen() || prefs().search}>
          <div
            class="lazers-tasks-search"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                save({ search: "" })
                setSearchOpen(false)
              }
            }}
          >
            <Ui.Icon name="magnifying-glass" size="small" />
            <Ui.TextInput
              type="search"
              label="Find tasks"
              placeholder="Search tasks…"
              value={prefs().search}
              onInput={(search) => save({ search })}
              autofocus
            />
            <Ui.IconButton
              icon="close"
              size="small"
              label="Close search"
              onClick={() => {
                save({ search: "" })
                setSearchOpen(false)
              }}
            />
          </div>
        </Show>
      </header>
      <div
        class="lazers-tasks-list"
        ref={(element) => {
          list = element
        }}
        onScroll={(event) => {
          if (listRestore.restored(expectedKey()))
            save({ listScroll: event.currentTarget.scrollTop })
        }}
      >
        <Show when={scope.error || visible()?.error}>
          <div class="lazers-tasks-note lazers-tasks-error" role="alert">
            {String(scope.error ?? visible()?.error)}
            <Ui.Button variant="ghost" onClick={() => void state.refresh()}>
              Retry
            </Ui.Button>
          </div>
        </Show>
        <Show when={visible()?.stale}>
          <div class="lazers-tasks-note" role="status">
            Updates disconnected. Displayed tasks may be stale.
          </div>
        </Show>
        <Show
          when={visible()}
          fallback={
            <div class="lazers-tasks-note">
              {!props.session.location ? (
                "Session location is unavailable."
              ) : (
                <Ui.Loader size="small" />
              )}
            </div>
          }
        >
          {(value) => (
            <>
              <Show
                when={!value().loading}
                fallback={
                  <div class="lazers-tasks-note">
                    <Ui.Loader size="small" />
                  </div>
                }
              >
                <Show
                  when={value().tasks.length}
                  fallback={
                    <div class="lazers-tasks-note">
                      {prefs().search
                        ? "No matching tasks."
                        : prefs().scope === "session"
                          ? "No tasks submitted from this session."
                          : "No tasks in this project."}
                    </div>
                  }
                >
                  <div aria-label="Open tasks">
                    <For each={value().tasks}>
                      {(task, index) => (
                        <button
                          type="button"
                          class="lazers-tasks-row"
                          data-task-id={task.taskID}
                          aria-pressed={task.taskID === value().selectedID}
                          aria-label={`${taskTitle(task.objective)}, ${task.status}${task.reason ? `: ${task.reason}` : ""}`}
                          tabIndex={
                            task.taskID === value().selectedID ||
                            (!value().selectedID && index() === 0)
                              ? 0
                              : -1
                          }
                          onKeyDown={rowKey}
                          onClick={() => void state.select(task.taskID)}
                        >
                          <span
                            class="lazers-tasks-state"
                            data-state={task.status}
                            aria-hidden="true"
                          />
                          <span>{taskTitle(task.objective)}</span>
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={value().page?.nextCursor}>
                    <Ui.Button variant="ghost" onClick={() => void state.more()}>
                      Load more
                    </Ui.Button>
                  </Show>
                </Show>
              </Show>
            </>
          )}
        </Show>
      </div>
      <div
        class="lazers-tasks-separator"
        ref={(element) => {
          separator = element
        }}
        role="separator"
        aria-label="Resize task list"
        aria-orientation="horizontal"
        aria-valuemin={20}
        aria-valuemax={75}
        aria-valuenow={Math.round(split())}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
          event.preventDefault()
          resize(
            event.key === "Home"
              ? 20
              : event.key === "End"
                ? 75
                : split() + (event.key === "ArrowDown" ? 5 : -5),
          )
          save({ split: split() })
        }}
      />
      <div
        class="lazers-tasks-detail"
        ref={(element) => {
          detail = element
        }}
        onScroll={(event) => {
          if (detailRestore.restored(selectionKey()))
            save({ detailScroll: event.currentTarget.scrollTop })
        }}
      >
        <Show
          when={selectedTask()}
          fallback={
            <div class="lazers-tasks-note">
              {visible()?.detail?.status === "not_found"
                ? "Task is not available in this view."
                : visible()?.selectedID
                  ? "Loading task…"
                  : "Select a task to see its details."}
            </div>
          }
        >
          {(task) => (
            <>
              <div class="lazers-tasks-reference-row">
                <span
                  class="lazers-tasks-reference"
                  style={{ "font-family": ctx.appearance.font("mono") }}
                  aria-label={`Task ID ${task().id}`}
                >
                  <Ui.Tooltip value={task().id}>{task().id.slice(0, 8)}</Ui.Tooltip>
                </span>
                <span
                  class="lazers-tasks-inspector-state"
                  data-state={selectedExecution()?.state ?? task().status}
                  aria-label={`${selectedExecution()?.state ?? task().status}${selectedExecution()?.reason ? `: ${selectedExecution()!.reason}` : ""}`}
                >
                  {selectedExecution()?.state ?? task().status}
                </span>
                <Show when={canStart(selectedExecution()?.state ?? task().status)}>
                  <Ui.Button
                    size="small"
                    variant="ghost-muted"
                    class="lazers-tasks-start"
                    busy={startFeedback().taskID === task().id}
                    disabled={Boolean(startFeedback().taskID)}
                    aria-label={`Start ${taskTitle(task().proposal.objective)}`}
                    onClick={() => void startTask(task().id, task().revision)}
                  >
                    Start
                  </Ui.Button>
                </Show>
              </div>
              <Show when={selectedExecution()?.reason}>
                {(reason) => (
                  <p class="lazers-tasks-reason" role="status">
                    {reason()}
                  </p>
                )}
              </Show>
              <Show when={selectedExecution()?.waitingOn.length}>
                <p class="lazers-tasks-reason">
                  Waiting on{" "}
                  {selectedExecution()!
                    .waitingOn.map((id) => id.slice(0, 8))
                    .join(", ")}
                </p>
              </Show>
              <Show when={startFeedback().error}>
                <p class="lazers-tasks-error" role="alert">
                  {startFeedback().error}
                </p>
              </Show>
              <div class="lazers-tasks-objective">
                <Ui.Markdown text={task().proposal.objective} />
              </div>
              <h4>Done when</h4>
              <ul class="lazers-tasks-assertions">
                <For each={task().proposal.acceptance}>
                  {(assertion) => (
                    <li>
                      <Ui.Markdown text={assertion.assertion} />
                    </li>
                  )}
                </For>
              </ul>
              <details class="lazers-tasks-section">
                <summary>
                  <Ui.Icon name="chevron-right" size="small" />
                  Details
                </summary>
                <details class="lazers-tasks-evidence">
                  <summary>Required evidence</summary>
                  <For each={task().proposal.acceptance}>
                    {(assertion) => (
                      <>
                        <h4>{assertion.id}</h4>
                        <For each={assertion.evidence}>
                          {(evidence) => (
                            <Ui.Markdown
                              text={
                                evidence.kind === "verification"
                                  ? `Verification: ${evidence.verificationID}`
                                  : evidence.kind === "artifact"
                                    ? evidence.reference
                                    : evidence.decision
                              }
                            />
                          )}
                        </For>
                      </>
                    )}
                  </For>
                </details>
                <dl>
                  <dt>Task ID</dt>
                  <dd style={{ "font-family": ctx.appearance.font("mono") }}>{task().id}</dd>
                  <dt>Status</dt>
                  <dd>
                    {selectedExecution()?.state ?? task().status} · specification revision{" "}
                    {task().revision}
                    <Show when={selectedExecution()?.reason}>{(reason) => <p>{reason()}</p>}</Show>
                  </dd>
                  <dt>Session association</dt>
                  <dd>
                    <span style={{ "font-family": ctx.appearance.font("mono") }}>
                      {task().provenance.sessionID}
                    </span>
                  </dd>
                  <Show when={selectedExecution()}>
                    {(execution) => (
                      <>
                        <dt>Plan</dt>
                        <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                          {execution().planID}
                        </dd>
                        <Show when={selectedDetail()?.attempts?.length}>
                          <dt>Attempts</dt>
                          <dd>
                            <For each={selectedDetail()?.attempts}>
                              {(attempt) => (
                                <p>
                                  {attempt.number} · {attempt.state} ·{" "}
                                  <span style={{ "font-family": ctx.appearance.font("mono") }}>
                                    {attempt.id.slice(0, 8)}
                                  </span>
                                  <Show when={attempt.artifact}>
                                    {(artifact) => (
                                      <>
                                        {" · "}
                                        <span
                                          style={{ "font-family": ctx.appearance.font("mono") }}
                                        >
                                          {artifact().slice(0, 8)}
                                        </span>
                                      </>
                                    )}
                                  </Show>
                                </p>
                              )}
                            </For>
                          </dd>
                        </Show>
                      </>
                    )}
                  </Show>
                  <dt>Repository</dt>
                  <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                    {task().provenance.projectDirectory}
                  </dd>
                  <dt>Workspace</dt>
                  <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                    {task().provenance.workspaceDirectory}
                  </dd>
                  <dt>Starting revision</dt>
                  <dd style={{ "font-family": ctx.appearance.font("mono") }}>
                    {task().provenance.startingRevision.kind === "git"
                      ? (task().provenance.startingRevision as { kind: "git"; commit: string })
                          .commit
                      : "Unborn repository"}
                  </dd>
                  <For
                    each={
                      [
                        ["Exclusions", task().proposal.exclusions],
                        ["Constraints", task().proposal.constraints],
                        ["Assumptions", task().proposal.assumptions],
                      ] as const
                    }
                  >
                    {([label, values]) => (
                      <Show when={values.length}>
                        <dt>{label}</dt>
                        <dd>
                          <For each={values}>{(text) => <Ui.Markdown text={text} />}</For>
                        </dd>
                      </Show>
                    )}
                  </For>
                  <Show when={task().proposal.guidance}>
                    <dt>Implementation guidance (advisory)</dt>
                    <dd>
                      <Ui.Markdown text={task().proposal.guidance!} />
                    </dd>
                  </Show>
                  <dt>Write scope</dt>
                  <dd>
                    <ul
                      class="lazers-tasks-paths"
                      style={{ "font-family": ctx.appearance.font("mono") }}
                    >
                      <For each={task().proposal.writeScope}>{(path) => <li>{path}</li>}</For>
                    </ul>
                  </dd>
                  <Show when={task().proposal.context.length}>
                    <dt>Context</dt>
                    <dd>
                      <For each={task().proposal.context}>
                        {(item) => (
                          <>
                            <Ui.Markdown text={item.reference} />
                            <Show when={item.revision}>
                              <code style={{ "font-family": ctx.appearance.font("mono") }}>
                                {item.revision}
                              </code>
                            </Show>
                          </>
                        )}
                      </For>
                    </dd>
                  </Show>
                  <dt>Requirements</dt>
                  <dd>
                    <p>Risk: {task().proposal.requirements.risk}</p>
                    <Show when={task().proposal.requirements.policyReference}>
                      {(reference) => <Ui.Markdown text={reference()} />}
                    </Show>
                    <For each={task().proposal.requirements.capabilities}>
                      {(text) => <Ui.Markdown text={text} />}
                    </For>
                    <For each={task().proposal.requirements.skills}>
                      {(text) => <Ui.Markdown text={text} />}
                    </For>
                  </dd>
                  <Show when={task().proposal.verification.length}>
                    <dt>Verification</dt>
                    <dd>
                      <For each={task().proposal.verification}>
                        {(item) => (
                          <div>
                            <p>
                              {item.id} · timeout {item.timeoutMs / 1000}s
                            </p>
                            <Ui.Code content={item.command} language="bash" />
                          </div>
                        )}
                      </For>
                    </dd>
                  </Show>
                  <Show
                    when={task().proposal.limits}
                    fallback={
                      <>
                        <dt>Budget</dt>
                        <dd>Not configured</dd>
                      </>
                    }
                  >
                    {(limits) => (
                      <>
                        <dt>Historical proposed limits</dt>
                        <dd>
                          <p>
                            {limits().maxTokens.toLocaleString()} tokens · $
                            {limits().maxEstimatedCostUsd} estimated cost ·{" "}
                            {limits().maxElapsedMs / 60000} minutes
                          </p>
                          <p>
                            {limits().maxToolCalls} tool calls · {limits().maxProviderRetries}{" "}
                            provider retries · {limits().maxRepairAttempts} repairs
                          </p>
                          <p>Historical proposal; no model-based execution budget is configured.</p>
                        </dd>
                      </>
                    )}
                  </Show>
                </dl>
                <details>
                  <summary>Full specification</summary>
                  <div
                    class="lazers-tasks-json"
                    role="region"
                    aria-label="Full task specification JSON"
                    tabIndex={0}
                  >
                    <Ui.Code content={JSON.stringify(task(), null, 2)} language="json" />
                  </div>
                </details>
              </details>
              <details class="lazers-tasks-section">
                <summary>
                  <Ui.Icon name="chevron-right" size="small" />
                  Activity
                </summary>
                <p>
                  Submitted {new Date(task().createdAt).toLocaleString()} ·{" "}
                  <span style={{ "font-family": ctx.appearance.font("mono") }}>
                    {task().provenance.sessionID}
                  </span>
                </p>
                <For each={selectedDetail()?.activity ?? []}>
                  {(event) => (
                    <div class="lazers-tasks-event">
                      <div>
                        <strong>{event.event}</strong>
                        <time dateTime={new Date(event.createdAt).toISOString()}>
                          {new Date(event.createdAt).toLocaleString()}
                        </time>
                      </div>
                      <Ui.Code content={event.payload} language="json" />
                    </div>
                  )}
                </For>
              </details>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}

export function setupTaskPanel(ctx: TaskContext) {
  const tab = { id: "tasks", title: "Tasks", closable: "hover" as const }
  const open = () => {
    const session = ctx.sessions.current()
    if (session?.location) ctx.layout.open(`${ctx.id}:tasks`, session, { tab: "select" })
  }
  ctx.add(Style, css)
  ctx.add(Panel, {
    id: "tasks",
    region: "side",
    list: (input) => (input.open.includes(tab.id) ? [tab] : []),
    render: bindPlugin((props: PanelProps) => <TaskPanel {...props} ctx={ctx} />),
  })
  ctx.add(Command, {
    id: "tasks.open",
    title: "Open LAZERS tasks",
    section: "session",
    slash: { name: "tasks" },
    run: open,
  })
  ctx.add(MenuItem, {
    id: "tasks.open",
    menu: "session.panel",
    title: "Tasks",
    icon: "task",
    run: open,
  })
}

import {
  Command,
  LinkHandler,
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
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { Tasks } from "./contract.ts"
import { Observability } from "../observability/contract.ts"
import { TaskPanelState } from "./panel-state.ts"
import type { PanelData } from "./panel-state.ts"
import { clampSplit, splitFromPointer } from "./panel-layout.ts"
import { taskTitle } from "./presentation.ts"
import { createTaskLinkHandler, taskMarkdownLink } from "./links.ts"
import { StartFeedback, ScrollRestoration, canStart, connectionLabel } from "./panel-view.ts"
import { buildExecutionList, selectForkForTask } from "./execution-list.ts"
import type { ExecutionListRow, ExecutionPlanGroup } from "./execution-list.ts"
import css from "./panel.css?inline"

const View = Schema.Struct({
  scope: Schema.Literals(["session", "project"]),
  selectedID: Schema.NullOr(Schema.String),
  search: Schema.String,
  split: Schema.Number,
  listScroll: Schema.Number,
  detailScroll: Schema.Number,
  history: Schema.optionalKey(Schema.Boolean),
  collapsedForks: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  revealTaskID: Schema.optionalKey(Schema.String),
})
const initial: typeof View.Type = {
  scope: "session",
  selectedID: null,
  search: "",
  split: 48,
  listScroll: 0,
  detailScroll: 0,
  history: false,
  collapsedForks: {},
  revealTaskID: "",
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
    linkedDetails: {},
    loading: true,
    stale: false,
    error: "",
  })
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [split, setSplit] = createSignal(48)
  const [startFeedback, setStartFeedback] = createSignal({ taskID: "", error: "" })
  const [copyStatus, setCopyStatus] = createSignal("")
  const [revealedTaskIDs, setRevealedTaskIDs] = createSignal<Set<string>>(new Set())
  const [temporarilyExpandedForks, setTemporarilyExpandedForks] = createSignal<Set<string>>(
    new Set(),
  )
  const [temporarilyCollapsedForks, setTemporarilyCollapsedForks] = createSignal<Set<string>>(
    new Set(),
  )
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
        prefs().history ?? false,
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
            rpc().get(
              { taskID, ...(sessionID ? { sessionID } : {}) },
              { location: { directory: value.directory }, signal },
            ),
          snapshot: (signal) =>
            value.client.rpc(Observability).snapshot(
              {
                scope:
                  view.scope === "session"
                    ? { kind: "session", sessionID: value.session }
                    : { kind: "project", sessionID: value.session },
              },
              { location: { directory: value.directory }, signal },
            ),
          start: (input, signal) =>
            rpc().start(input, { location: { directory: value.directory }, signal }),
          changes: (signal) =>
            (async function* () {
              for await (const event of rpc().events.subscribe("changed", { signal }))
                yield event.data
            })(),
          online: () => props.session.server.connected,
        },
        {
          search: view.search,
          sessionID,
          limit: 30,
          includeCompleted: view.history ?? false,
        },
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
      ? JSON.stringify([
          value.server,
          value.project,
          value.session,
          view.scope,
          view.search,
          view.history ?? false,
        ])
      : ""
  }
  let revealIdentity = ""
  createEffect(() => {
    const key = expectedKey()
    if (key === revealIdentity) return
    revealIdentity = key
    setRevealedTaskIDs(new Set<string>())
    setTemporarilyExpandedForks(new Set<string>())
    setTemporarilyCollapsedForks(new Set<string>())
  })
  const visible = () => (data().key === expectedKey() ? data() : undefined)
  const selectionKey = () => JSON.stringify([expectedKey(), visible()?.selectedID])
  const executionList = createMemo(() =>
    buildExecutionList({
      topology: visible()?.topology,
      tasks: visible()?.tasks ?? [],
      search: prefs().search,
      revealTaskIDs: revealedTaskIDs(),
    }),
  )
  const forkPreferenceKey = (planID: string, forkID: string) => {
    const value = current()
    return JSON.stringify([
      value?.server,
      value?.project,
      value?.session,
      prefs().scope,
      planID,
      forkID,
    ])
  }
  const forkExpanded = (group: ExecutionPlanGroup, row: ExecutionListRow) => {
    if (!row.fork) return false
    const key = forkPreferenceKey(group.planID, row.fork.id)
    const saved = (prefs().collapsedForks ?? {})[key] === false
    const searchReveal = Boolean(
      prefs().search &&
      row.fork.branches.some((branch) => branch.rows.some((child) => !child.contextOnly)),
    )
    if (prefs().search && temporarilyCollapsedForks().has(key)) return false
    return saved || searchReveal || temporarilyExpandedForks().has(key)
  }
  const revealTask = (taskID: string) => {
    setRevealedTaskIDs((current) => new Set([...current, taskID]))
    const group = buildExecutionList({
      topology: visible()?.topology,
      tasks: visible()?.tasks ?? [],
      search: prefs().search,
      revealTaskIDs: new Set([taskID]),
    })
    const fork = selectForkForTask(group.plans, taskID)
    if (fork) {
      const key = forkPreferenceKey(fork.planID, fork.forkID)
      if (prefs().search) {
        setTemporarilyExpandedForks((current) => new Set([...current, key]))
        setTemporarilyCollapsedForks((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      } else {
        save({ collapsedForks: { ...(prefs().collapsedForks ?? {}), [key]: false } })
      }
    }
  }
  const selectTask = (taskID: string) => {
    revealTask(taskID)
    void state.select(taskID)
  }
  const toggleFork = (group: ExecutionPlanGroup, row: ExecutionListRow) => {
    if (!row.fork) return
    const key = forkPreferenceKey(group.planID, row.fork.id)
    const expanded = forkExpanded(group, row)
    if (prefs().search) {
      const nextExpanded = !expanded
      setTemporarilyExpandedForks((current) => {
        const next = new Set(current)
        if (nextExpanded) next.add(key)
        else next.delete(key)
        return next
      })
      setTemporarilyCollapsedForks((current) => {
        const next = new Set(current)
        if (nextExpanded) next.delete(key)
        else next.add(key)
        return next
      })
    } else {
      save({ collapsedForks: { ...(prefs().collapsedForks ?? {}), [key]: expanded } })
    }
    setTemporarilyExpandedForks((current) => {
      const next = new Set(current)
      if (!prefs().search) next.delete(key)
      return next
    })
  }
  let handledReveal = ""
  createEffect(() => {
    const taskID = prefs().revealTaskID ?? ""
    const value = visible()
    if (!taskID) {
      handledReveal = ""
      return
    }
    if (!value || value.loading || handledReveal === taskID) return
    handledReveal = taskID
    save({ revealTaskID: "" })
    if (value.selectedID === taskID) revealTask(taskID)
    else selectTask(taskID)
  })
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
  createEffect(() => {
    const value = current()
    if (!value || !frame.visible() || !ctx.stores.taskView(props.session).ready()) return
    const selectedID = prefs().selectedID ?? undefined
    if (data().key !== expectedKey() || data().selectedID === selectedID || !selectedID) return
    void state.select(selectedID)
  })
  createEffect(() => {
    selectionKey()
    setCopyStatus("")
  })
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
  const selectedRelations = () => {
    const taskID = visible()?.selectedID
    const waitingOn = selectedExecution()?.waitingOn ?? []
    const waitingSet = new Set(waitingOn)
    const prerequisites = new Set<string>()
    const successors = new Set<string>()
    for (const plan of visible()?.topology?.plans ?? [])
      for (const edge of plan.dependencies) {
        if (edge.successor === taskID && !waitingSet.has(edge.prerequisite))
          prerequisites.add(edge.prerequisite)
        if (edge.prerequisite === taskID) successors.add(edge.successor)
      }
    return {
      prerequisites: [...prerequisites],
      waitingOn,
      successors: [...successors],
    }
  }
  const relationLabel = (taskID: string) =>
    visible()?.tasks.find((task) => task.taskID === taskID)?.reference ??
    visible()?.linkedDetails[taskID]?.reference ??
    taskID.slice(0, 8)
  const renderRelation = (taskID: string) => {
    const reference = relationLabel(taskID)
    const task = selectedTask()
    if (reference.startsWith("LZ-") && task)
      return <Ui.Markdown text={taskMarkdownLink(reference, task.provenance.projectID)} />
    return (
      <button
        type="button"
        class="lazers-tasks-dependency-ref"
        aria-label={`Open related task ${reference}`}
        onClick={() => selectTask(taskID)}
      >
        {reference}
      </button>
    )
  }
  createEffect(() => {
    const value = visible()
    if (!value?.selectedID || value.detail?.status !== "found") return
    const relationIDs = new Set([
      ...selectedRelations().prerequisites,
      ...selectedRelations().successors,
    ])
    for (const taskID of relationIDs) {
      const hasReference = Boolean(
        value.tasks.find((task) => task.taskID === taskID)?.reference ??
        value.linkedDetails[taskID]?.reference,
      )
      if (!hasReference) void state.resolveLinked(taskID)
    }
  })
  const rowValues = createMemo(() => {
    const model = executionList()
    const rows: ExecutionListRow[] = []
    const visit = (taskRow: ExecutionListRow, group?: ExecutionPlanGroup) => {
      rows.push(taskRow)
      if (!group || !taskRow.fork || !forkExpanded(group, taskRow)) return
      for (const branch of taskRow.fork.branches)
        for (const child of branch.rows) visit(child, group)
    }
    for (const group of model.plans) for (const taskRow of group.rows) visit(taskRow, group)
    rows.push(...model.unplanned)
    return rows
  })
  const focusTaskID = createMemo(() => {
    const rows = rowValues()
    const selectedID = visible()?.selectedID
    return rows.some((row) => row.taskID === selectedID) ? selectedID : rows[0]?.taskID
  })
  const rowTabIndex = (taskID: string) => {
    return taskID === focusTaskID() ? 0 : -1
  }
  const renderTaskRow = (
    taskRow: ExecutionListRow,
    group?: ExecutionPlanGroup,
    depth = 0,
  ): JSX.Element => {
    const expanded = Boolean(group && taskRow.fork && forkExpanded(group, taskRow))
    const relationshipCount = new Set([...taskRow.prerequisites, ...taskRow.successors]).size
    return (
      <div class="lazers-tasks-entry" data-context-only={taskRow.contextOnly}>
        <div class="lazers-tasks-entry-line" style={{ "padding-left": `${depth * 12}px` }}>
          <Show when={taskRow.fork && group}>
            <button
              type="button"
              class="lazers-tasks-disclosure"
              aria-label={`${expanded ? "Collapse" : "Expand"} parallel work under ${taskTitle(taskRow.title)}`}
              aria-expanded={expanded}
              onClick={(event) => {
                event.stopPropagation()
                if (group) toggleFork(group, taskRow)
              }}
            >
              <Ui.Icon name={expanded ? "chevron-down" : "chevron-right"} size="small" />
            </button>
          </Show>
          <Show when={!taskRow.fork || !group}>
            <span class="lazers-tasks-disclosure-spacer" aria-hidden="true" />
          </Show>
          <button
            type="button"
            class="lazers-tasks-row"
            data-task-id={taskRow.taskID}
            aria-pressed={taskRow.taskID === visible()?.selectedID}
            aria-label={`${taskTitle(taskRow.title)}, ${taskRow.status}${taskRow.contextOnly ? ", context" : ""}${taskRow.reason ? `: ${taskRow.reason}` : ""}`}
            tabIndex={rowTabIndex(taskRow.taskID)}
            onKeyDown={rowKey}
            onClick={() => selectTask(taskRow.taskID)}
          >
            <span class="lazers-tasks-state" data-state={taskRow.status} aria-hidden="true" />
            <span>{taskTitle(taskRow.title)}</span>
            <Show when={relationshipCount > 0}>
              <span
                class="lazers-tasks-dependency-count"
                aria-label={`${relationshipCount} recorded dependencies`}
                title={`${relationshipCount} recorded dependencies`}
              >
                {relationshipCount} links
              </span>
            </Show>
          </button>
        </div>
        <Show when={taskRow.fork && group && expanded}>
          <div class="lazers-tasks-branches">
            <For each={taskRow.fork?.branches ?? []}>
              {(branch) => (
                <div class="lazers-tasks-branch">
                  <For each={branch.rows}>{(child) => renderTaskRow(child, group, depth + 1)}</For>
                  <Show when={branch.hiddenCount > 0}>
                    <div class="lazers-tasks-branch-note">
                      {branch.hiddenCount} task{branch.hiddenCount === 1 ? "" : "s"} not shown in
                      this page or filter
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    )
  }
  const copyTaskLink = async () => {
    const task = selectedTask()
    const detail = selectedDetail()
    if (!task || !detail) return
    try {
      await ctx.system.copy(taskMarkdownLink(detail.reference, task.provenance.projectID))
      setCopyStatus("Task link copied.")
    } catch {
      setCopyStatus("Could not copy task link.")
    }
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
    if (id) selectTask(id)
  }
  let focusedSelection = ""
  createEffect(() => {
    const selectedID = visible()?.selectedID
    const key = selectionKey()
    if (!selectedID || visible()?.detail?.status !== "found" || key === focusedSelection) return
    focusedSelection = key
    queueMicrotask(() => {
      if (selectionKey() !== key) return
      const row = [...(list?.querySelectorAll<HTMLButtonElement>("[data-task-id]") ?? [])].find(
        (item) => item.dataset.taskId === selectedID,
      )
      row?.scrollIntoView({ block: "nearest" })
      row?.focus({ preventScroll: true })
    })
  })
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
              label={`${prefs().scope === "session" ? "Session" : "Project"}${prefs().history ? " · History" : ""}`}
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
                {
                  label: prefs().history ? "Hide completed history" : "Show completed history",
                  onSelect: () =>
                    save({ history: !prefs().history, selectedID: null, listScroll: 0 }),
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
        <Show when={visible()?.topologyError}>
          {(message) => (
            <div class="lazers-tasks-note" role="status">
              {message()}
            </div>
          )}
        </Show>
        <Show when={visible() && !visible()?.topology && !visible()?.topologyError}>
          <div class="lazers-tasks-note" role="status">
            Execution topology unavailable. Showing tasks without grouping.
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
                  when={rowValues().length}
                  fallback={
                    <div class="lazers-tasks-note">
                      {prefs().search
                        ? "No matching tasks."
                        : prefs().history
                          ? "No tasks in this history view."
                          : prefs().scope === "session"
                            ? "No open tasks in this session. Show completed history to review finished work."
                            : "No open tasks in this project. Show completed history to review finished work."}
                    </div>
                  }
                >
                  <div aria-label="Open tasks">
                    <For each={executionList().plans}>
                      {(group) => (
                        <section
                          class="lazers-tasks-plan"
                          aria-label={`${group.hasRecordedTitle ? group.title : "Recorded plan"}, ${group.activeCount} active of ${group.totalCount} tasks`}
                        >
                          <div class="lazers-tasks-plan-heading">
                            <span>{group.hasRecordedTitle ? group.title : "Recorded plan"}</span>
                            <span>
                              {group.activeCount}/{group.totalCount}
                            </span>
                          </div>
                          <For each={group.rows}>{(taskRow) => renderTaskRow(taskRow, group)}</For>
                        </section>
                      )}
                    </For>
                    <For each={executionList().unplanned}>
                      {(taskRow) => renderTaskRow(taskRow)}
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
                  aria-label={`Task reference ${selectedDetail()?.reference ?? "unknown"}`}
                >
                  <Ui.Tooltip value={task().id}>{selectedDetail()?.reference ?? "Task"}</Ui.Tooltip>
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
                <Ui.Button
                  size="small"
                  variant="ghost-muted"
                  aria-label="Copy task link"
                  disabled={!selectedDetail()?.reference}
                  onClick={() => void copyTaskLink()}
                >
                  Copy task link
                </Ui.Button>
              </div>
              <Show when={copyStatus()}>
                <p class="lazers-tasks-reason" role="status">
                  {copyStatus()}
                </p>
              </Show>
              <Show when={selectedExecution()?.reason}>
                {(reason) => (
                  <p class="lazers-tasks-reason" role="status">
                    {reason()}
                  </p>
                )}
              </Show>
              <Show when={selectedRelations().waitingOn.length}>
                <div class="lazers-tasks-dependencies">
                  <span>Waiting on </span>
                  <For each={selectedRelations().waitingOn}>
                    {(taskID, index) => (
                      <>
                        {index() ? ", " : ""}
                        {renderRelation(taskID)}
                      </>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={selectedRelations().prerequisites.length}>
                <div class="lazers-tasks-dependencies">
                  <span>Prerequisites </span>
                  <For each={selectedRelations().prerequisites}>
                    {(taskID, index) => (
                      <>
                        {index() ? ", " : ""}
                        {renderRelation(taskID)}
                      </>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={selectedRelations().successors.length}>
                <div class="lazers-tasks-dependencies">
                  <span>Blocks </span>
                  <For each={selectedRelations().successors}>
                    {(taskID, index) => (
                      <>
                        {index() ? ", " : ""}
                        {renderRelation(taskID)}
                      </>
                    )}
                  </For>
                </div>
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
  const Ui = ctx.ui
  ctx.add(
    LinkHandler,
    createTaskLinkHandler({
      session(source) {
        return ctx.sessions
          .list()
          .find((session) => session.id === source.id && session.server.id === source.server.id)
      },
      async project(session, signal) {
        const server = ctx.servers.get(session.server.id)
        if (!server?.connected || !session.location) throw new Error("Task link session is offline")
        const location = await server.client.location.get(
          { location: session.location },
          { signal },
        )
        return location.project
      },
      get(session, reference, signal) {
        const server = ctx.servers.get(session.server.id)
        if (!server?.connected || !session.location) throw new Error("Task link session is offline")
        return server.client
          .rpc(Tasks)
          .get({ taskID: reference }, { location: session.location, signal })
      },
      signal: () => AbortSignal.any([ctx.signal, AbortSignal.timeout(5_000)]),
      open(target) {
        const session = ctx.sessions
          .list()
          .find(
            (candidate) =>
              candidate.id === target.session.id &&
              candidate.server.id === target.session.server.id &&
              candidate.location?.directory === target.sessionDirectory,
          )
        if (!session) return
        const store = ctx.stores.taskView(session)
        store.update((draft) => {
          const view = draft.projects[target.projectDirectory] ?? initial
          draft.projects[target.projectDirectory] = {
            ...view,
            scope: "project",
            search: "",
            selectedID: target.taskID,
            detailScroll: 0,
            revealTaskID: target.taskID,
          }
        })
        ctx.layout.open(`${ctx.id}:tasks`, session, { tab: "select" })
      },
    }),
  )
  // One stable tab object, like the host tabs: a session switch never renders its label again.
  // The tab keeps `title` as its accessible name and closable hover button; the label adds the
  // themed native icon so the strip reads like the review, browser, terminal, and file tabs.
  const tab = {
    id: "tasks",
    title: "Tasks",
    closable: "hover" as const,
    label: () => (
      <div class="flex items-center gap-1.5">
        <Ui.Icon name="task" size="small" />
        <span>Tasks</span>
      </div>
    ),
  }
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
  // Native `session.panel` items list in ascending `order` (Review 10, Browser 15, Terminal 20,
  // Files 30); Tasks 40 places it last in the extra-panel + menu.
  ctx.add(MenuItem, {
    id: "tasks.open",
    menu: "session.panel",
    title: "Tasks",
    icon: "task",
    order: 40,
    run: open,
  })
}

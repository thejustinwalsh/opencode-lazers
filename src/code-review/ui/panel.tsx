import { createKeyed, createLatest, usePanel } from "@opencode/plugin/gui"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js"
import type { JSX } from "solid-js"
import type { CodeReviewComparison, CodeReviewHistory, CodeReviewMode } from "../contract.ts"
import { resolvePanelProject } from "../../panel-project.ts"
import { DetailsPane } from "../../details-pane.tsx"
import { storedState } from "../../details-pane.ts"
import { Disclosure, Identifiers } from "../../details/index.ts"
import { createPanelStatus, PanelStatus } from "../../panel-status.tsx"
import { composerParts, lineSpan, reviewHref } from "./model/anchor.ts"
import type { DiscussIntent, ReviewAnchor, ReviewRequest } from "./model/anchor.ts"
import { sourceIdentity, splitPath } from "./model/files.ts"
import type { ReviewFile } from "./model/files.ts"
import { excerptOf } from "./model/source-text.ts"
import { fromLineSelection, fromTextSelection } from "./model/selection.ts"
import type { CodeSelection } from "./model/selection.ts"
import { ReviewCodeView } from "./renderer/code-view.tsx"
import type { ReviewCodeViewHandle } from "./renderer/code-view.tsx"
import { acquireHighlighter } from "./renderer/highlighter.ts"
import { ReviewSession } from "./session.ts"
import type { FileView } from "./session.ts"
import { discussWithArchitect } from "./discuss.ts"
import { whenRouted } from "./routing.ts"
import { initialReviewView, reviewStores } from "./state.ts"
import { resolveRequest } from "./model/request.ts"
import type { Revision } from "./model/request.ts"
import type { ReviewView } from "./state.ts"
import { rpcReviewTransport } from "./transport.ts"
import type { IntegrationTarget, ReviewTransport } from "./transport.ts"

export type ReviewContext = SetupContext<{ stores: typeof reviewStores }>

export type ReviewOpeners = {
  openTask(
    session: PanelProps["session"],
    target: { projectDirectory: string; taskID: string },
  ): void
  openTasks(session: PanelProps["session"]): void
}

/** Width at which the base and head panes sit side by side. */
const SPLIT_WIDTH = 720

const MODE_LABELS: Record<CodeReviewMode, string> = {
  task: "Task",
  attempt: "Attempt",
  since: "Since review",
  live: "Live",
  plan: "Plan",
}

/** Why a mode has nothing to resolve, in the reader's words. */
function missingReason(mode: CodeReviewMode) {
  if (mode === "plan") return "This task is not in a plan."
  if (mode === "since") return "Since review needs two attempts with recorded work."
  return "This task has no attempt with recorded work yet."
}

const STATUS_GLYPH: Record<ReviewFile["status"], { glyph: string; word: string }> = {
  added: { glyph: "+", word: "Added" },
  deleted: { glyph: "−", word: "Deleted" },
  modified: { glyph: "•", word: "Modified" },
  conflicted: { glyph: "!", word: "Conflicted" },
  unchanged: { glyph: "", word: "Unchanged" },
}

function Counts(props: { view: FileView }) {
  return (
    <Show when={props.view.phase === "ready" ? props.view : undefined}>
      {(ready) => (
        <span class="lz-review-counts">
          <Show when={ready().added > 0}>
            <span class="lz-review-added">+{ready().added}</span>
          </Show>
          <Show when={ready().removed > 0}>
            <span class="lz-review-removed">−{ready().removed}</span>
          </Show>
        </span>
      )}
    </Show>
  )
}

function attemptLabel(revision: Revision) {
  return `Attempt ${revision.attemptNumber}`
}

export function ReviewPanel(
  props: PanelProps & { ctx: ReviewContext; openers: ReviewOpeners },
): JSX.Element {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()

  const location = createLatest(
    () => {
      if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
      return {
        client: props.session.server.client,
        server: props.session.server.id,
        session: props.session.id,
        directory: props.session.directory,
      }
    },
    async (value, signal) => ({
      ...value,
      ...(await resolvePanelProject(value.client, value.directory, signal, value.session)),
    }),
  )
  const current = () => {
    const value = location.latest
    return value && value.session === props.session.id && value.server === props.session.server.id
      ? value
      : undefined
  }
  const store = () => ctx.stores.reviewView(props.session)
  const view = (): ReviewView => {
    const value = current()
    return value ? (store().value?.projects[value.project] ?? initialReviewView) : initialReviewView
  }
  const save = (change: Partial<ReviewView>) => {
    const value = current()
    if (!value) return
    store().update((draft) => {
      draft.projects[value.project] = {
        ...(draft.projects[value.project] ?? initialReviewView),
        ...change,
      }
    })
  }

  // One transport per project location; it aborts with the location.
  const [transport, setTransport] = createSignal<ReviewTransport>()
  const [retries, setRetries] = createSignal(0)
  createKeyed(
    () => {
      const value = current()
      return value
        ? { value, key: `${value.server}\u0000${value.session}\u0000${value.project}` }
        : undefined
    },
    ({ value }) => {
      const controller = new AbortController()
      setTransport(
        rpcReviewTransport({
          client: value.client as unknown as Parameters<typeof rpcReviewTransport>[0]["client"],
          sessionID: value.session,
          projectDirectory: value.project,
          signal: controller.signal,
        }),
      )
      onCleanup(() => {
        controller.abort()
        setTransport(undefined)
      })
    },
    { equals: (a, b) => a.key === b.key, otherwise: () => setTransport(undefined) },
  )

  // Narrow memos: saving the reader's scroll position must not refetch the task or comparison.
  const taskID = createMemo(() => view().taskID)
  const chosen = createMemo(() => view().request, undefined, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  })
  const task = createLatest(
    () => {
      const t = transport()
      const id = taskID()
      return t && id ? { t, id, retry: retries() } : undefined
    },
    ({ t, id }, signal) => t.task(id, signal),
  )
  const history = createLatest(
    () => {
      const t = transport()
      const id = taskID()
      return t && id ? { t, id, retry: retries() } : undefined
    },
    async ({ t, id }, signal) => {
      const revisions: Revision[] = []
      let cursor: CodeReviewHistory["nextCursor"] = null
      do {
        const page: CodeReviewHistory = await t.history(id, cursor, signal)
        revisions.push(...page.revisions)
        cursor = page.nextCursor
      } while (cursor)
      return revisions
    },
  )
  const revisions = () => history.latest ?? []
  const request = createMemo(
    () => {
      const id = taskID()
      if (!id) return undefined
      const mode = chosen().mode
      // Attempt-based modes wait for the history; the others resolve at once.
      if ((mode === "attempt" || mode === "since") && !history.latest) return undefined
      if (mode === "plan" && !task.latest && !chosen().planID) return undefined
      return resolveRequest(id, chosen(), task.latest, revisions()) ?? null
    },
    undefined,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  )
  const comparison = createLatest(
    () => {
      const t = transport()
      const input = request()
      return t && input ? { t, input, key: JSON.stringify(input), retry: retries() } : undefined
    },
    ({ t, input }, signal) => t.resolve(input, signal),
  )
  const lineage = createLatest(
    () => {
      const t = transport()
      const id = taskID()
      return t?.lineage && id ? { t, id } : undefined
    },
    ({ t, id }, signal) => t.lineage!(id, signal),
  )

  // One session per resolved comparison; a newer comparison replaces it and aborts its reads.
  const [session, setSession] = createSignal<ReviewSession>()
  createKeyed(
    () => {
      const t = transport()
      const resolved = comparison.latest
      const id = taskID()
      return t && resolved && resolved.available && resolved.identity.taskID === id
        ? { t, resolved, key: `${resolved.identity.comparisonID}\u0000${retries()}` }
        : undefined
    },
    ({ t, resolved }) => {
      const controller = new AbortController()
      const next = new ReviewSession(t, resolved, controller.signal)
      setSession(next)
      void next.load()
      onCleanup(() => {
        controller.abort()
        setSession(undefined)
      })
    },
    { equals: (a, b) => a.key === b.key, otherwise: () => setSession(undefined) },
  )

  // Renderer: highlight workers live while the panel is mounted.
  const highlighter = acquireHighlighter()
  onCleanup(() => highlighter.release())
  const [handle, setHandle] = createSignal<ReviewCodeViewHandle>()
  const [width, setWidth] = createSignal(0)
  const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
  onCleanup(() => observer.disconnect())
  const split = () => {
    const layout = view().layout ?? "auto"
    return layout === "split" || (layout === "auto" && width() >= SPLIT_WIDTH)
  }

  createEffect(() => {
    const s = session()
    const h = handle()
    if (s && h) s.onItem = (item) => h.updateItem(item)
  })

  // Selection: a gutter selection from Pierre, or text selected in the code.
  const [selection, setSelection] = createSignal<CodeSelection>()
  createEffect(on(session, () => setSelection(undefined)))
  const onPointerUp = () => {
    const h = handle()
    const container = h?.container()
    if (!container) return
    const text = fromTextSelection(container, itemOf)
    if (text) select(text)
  }
  const itemOf = (host: Element) => {
    const container = handle()?.container()
    if (!container) return undefined
    for (const id of handle()?.renderedIDs() ?? []) {
      const header = container.querySelector(`[data-lz-review-header="${CSS.escape(id)}"]`)
      if (header && host.contains(header)) return id
    }
    return undefined
  }
  const select = (next: CodeSelection | undefined) => {
    setSelection(next)
    if (next && !(view().open ?? false)) save({ open: true })
  }

  const anchor = createMemo((): ReviewAnchor | undefined => {
    const s = session()
    const picked = selection()
    if (!s || !picked) return undefined
    const file = s.file(picked.path)
    const texts = s.textsOf(picked.path)
    const side = picked.side === "base" ? file?.base : file?.head
    const text = picked.side === "base" ? texts?.base : texts?.head
    if (!file || !side || text === null || text === undefined) return undefined
    const identity = s.comparison.identity
    return {
      source: sourceIdentity(s.comparison, file.path, side),
      baseRevision: identity.baseRevision,
      headRevision: identity.headRevision,
      snapshotID: identity.snapshotID,
      startLine: picked.startLine,
      endLine: picked.endLine,
      ...(picked.startChar !== undefined && picked.endChar !== undefined
        ? { startChar: picked.startChar, endChar: picked.endChar }
        : {}),
      excerpt: excerptOf(text, picked),
      createdAt: Math.floor(Date.now() / 1000),
    }
  })

  const reference = () => task.latest?.reference || view().reference || ""
  const title = () => task.latest?.title || comparison.latest?.taskTitle || ""
  const [notice, setNotice] = createSignal("")
  const discuss = async (intent: DiscussIntent) => {
    const pinned = anchor()
    const value = current()
    const s = session()
    if (!pinned || !value || !s) return
    const href = reviewHref({
      projectID: value.projectID,
      reference: reference() || s.comparison.taskReference,
      request: view().request,
      comparisonID: s.comparison.identity.comparisonID,
      path: pinned.source.path,
      side: pinned.source.side,
      startLine: pinned.startLine,
      endLine: pinned.endLine,
    })
    const parts = composerParts({
      anchor: pinned,
      intent,
      reference: reference() || s.comparison.taskReference,
      title: title(),
      origin: ctx.id,
      href,
      id: crypto.randomUUID(),
    })
    const result = await discussWithArchitect(
      {
        currentSessionID: () => ctx.sessions.current()?.id,
        screen: () => ctx.screen.current(),
        openSession: (session) => ctx.tabs.open(session, { focus: true }),
        routed: (sessionID, signal) =>
          whenRouted(() => ctx.sessions.current()?.id, sessionID, signal),
        signal: ctx.signal,
      },
      {
        server: props.session.server.id,
        architectSessionID: task.latest?.architectSessionID ?? null,
        ...parts,
      },
    )
    setNotice(
      result === "no-architect"
        ? "This task has no Architect conversation to discuss it in."
        : result === "cancelled"
          ? "The Architect conversation did not open."
          : "",
    )
  }

  // A navigation (from Tasks, a link, a composer chip): show its file and lines once loaded.
  createEffect(() => {
    const s = session()
    const h = handle()
    const target = view().target
    if (!s || !h || !target || !s.complete()) return
    untrack(() => {
      save({ target: null })
      if (!target.path || !s.file(target.path)) return
      const path = target.path
      void s.ensure(path).then(() => {
        if (target.startLine) {
          const side = target.side === "base" ? "deletions" : "additions"
          const range = {
            start: target.startLine,
            end: target.endLine ?? target.startLine,
            side,
          } as const
          h.select({ id: path, range })
          h.scrollTo({ type: "range", id: path, range, align: "center" })
          select({
            path,
            side: target.side === "base" ? "base" : "head",
            startLine: range.start,
            endLine: range.end,
          })
        } else h.scrollTo({ type: "item", id: path, align: "start" })
      })
    })
  })
  // Returning to a comparison restores the file the reader had at the top.
  let restored = ""
  createEffect(() => {
    const s = session()
    const h = handle()
    const top = untrack(() => view().topPath)
    if (!s || !h || !s.complete() || restored === s.comparison.identity.comparisonID) return
    restored = s.comparison.identity.comparisonID
    if (top && s.file(top) && !untrack(() => view().target))
      h.scrollTo({ type: "item", id: top, align: "start" })
  })
  let lastTop = ""
  const onRendered = (ids: string[]) => {
    session()?.near(ids)
    const h = handle()
    if (!h) return
    const top = ids.find((id) => (h.topOf(id) ?? -1) + 1 >= h.scrollTop()) ?? ids[0]
    if (top && top !== lastTop) {
      lastTop = top
      save({ topPath: top })
    }
  }

  // Next and previous change across files, from the row at the top of the view.
  const step = (direction: 1 | -1) => {
    const s = session()
    const h = handle()
    if (!s || !h) return
    const files = s.files()
    const start = Math.max(
      0,
      files.findIndex((file) => file.path === (lastTop || files[0]?.path)),
    )
    for (let offset = 0; offset < files.length; offset++) {
      const index = start + direction * offset
      const file = files[index]
      if (!file) break
      const state = s.view(file.path)
      if (state.phase !== "ready" || state.regions.length === 0) continue
      const region = direction === 1 ? state.regions[0]! : state.regions.at(-1)!
      if (offset === 0 && files.length > 1) continue
      h.scrollTo({
        type: "line",
        id: file.path,
        lineNumber: region.line,
        side: region.side,
        align: "start",
      })
      return
    }
  }
  const jumpTo = (path: string) => {
    const s = session()
    const h = handle()
    if (!s || !h) return
    void s.ensure(path)
    h.scrollTo({ type: "item", id: path, align: "start" })
  }

  const hasContent = () => Boolean(session()?.files().length)
  const statusError = () => {
    const errors = [task.error, history.error, comparison.error, session()?.error()].filter(Boolean)
    return errors.length ? String((errors[0] as Error)?.message ?? errors[0]) : undefined
  }
  const status = createPanelStatus(() => ({
    subject: "the review",
    hasContent: hasContent(),
    loading:
      Boolean(taskID()) &&
      (location.loading || task.loading || comparison.loading || !(session()?.complete() ?? false)),
    ...(statusError() ? { error: statusError() } : {}),
  }))
  const retry = () => setRetries((count) => count + 1)

  const modeOptions = createMemo(() => {
    const artifacts = revisions().filter((revision) => revision.artifactRevision).length
    return (Object.keys(MODE_LABELS) as CodeReviewMode[])
      .filter(
        (mode) =>
          mode === "task" ||
          mode === "live" ||
          (mode === "attempt" && artifacts > 0) ||
          (mode === "since" && artifacts > 1) ||
          (mode === "plan" && Boolean(task.latest?.planID)),
      )
      .map((mode) => ({ value: mode, label: MODE_LABELS[mode] }))
  })
  const attemptOptions = () =>
    revisions()
      .filter((revision) => revision.artifactRevision)
      .map((revision) => ({ value: revision.attemptID, label: attemptLabel(revision) }))
  const setRequest = (next: ReviewRequest) => batch(() => save({ request: next, topPath: "" }))

  const fileHeader = (path: string) => {
    const s = session()
    if (!s) return <div />
    const file = () => s.file(path)
    const state = () => s.view(path)
    const name = () => splitPath(path)
    return (
      <div class="lz-review-file-header" data-lz-review-header={path}>
        <span
          class="lz-review-status"
          data-status={file()?.status}
          title={STATUS_GLYPH[file()?.status ?? "modified"].word}
          aria-label={STATUS_GLYPH[file()?.status ?? "modified"].word}
        >
          {STATUS_GLYPH[file()?.status ?? "modified"].glyph}
        </span>
        <span class="lz-review-file-name" title={path}>
          {name().name}
        </span>
        <span class="lz-review-file-folder">{name().folder}</span>
        <Switch>
          <Match when={state().phase === "ready"}>
            <Show
              when={
                state().phase === "ready" &&
                (state() as Extract<FileView, { phase: "ready" }>).engine === "line"
              }
            >
              <span
                class="lz-review-engine"
                title="Line diff: Difftastic's structural comparison is not available for this file yet."
                aria-label="Line diff"
              >
                ≈
              </span>
            </Show>
            <Counts view={state()} />
          </Match>
          <Match when={state().phase === "opaque"}>
            <span class="lz-review-file-note">Not text</span>
          </Match>
          <Match when={state().phase === "failed"}>
            <button type="button" class="lz-review-link" onClick={() => void s.retry(path)}>
              Retry
            </button>
          </Match>
        </Switch>
      </div>
    )
  }

  const selectionHeader = () => {
    const pinned = anchor()
    if (!pinned) return undefined
    const name = splitPath(pinned.source.path).name
    const side = pinned.source.side === "base" ? "before" : "after"
    return (
      <span class="lz-review-selection-title">
        <span class="lz-review-mono">{name}</span> · {lineSpan(pinned)} · {side}
      </span>
    )
  }

  return (
    <div
      class="lz-review"
      ref={(element) => observer.observe(element)}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
        const target = event.target as HTMLElement
        if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
        if (event.key === "j") step(1)
        else if (event.key === "k") step(-1)
        else return
        event.preventDefault()
      }}
    >
      <header class="lz-review-header">
        <div class="lz-review-title-row">
          <Show when={reference()}>
            <button
              type="button"
              class="lz-review-reference lz-review-mono"
              title="Open task"
              onClick={() => {
                const value = current()
                const id = taskID()
                if (value && id)
                  props.openers.openTask(props.session, {
                    projectDirectory: value.project,
                    taskID: id,
                  })
              }}
            >
              {reference()}
            </button>
          </Show>
          <span class="lz-review-title" title={title()}>
            {title() || (taskID() ? "" : "Review")}
          </span>
          <Show when={taskID()}>
            <Ui.Menu
              label="Review options"
              trigger="icon"
              icon="outline-dots"
              placement="bottom-end"
              items={[
                {
                  label: "Paired panes when wide",
                  icon: view().layout === "auto" || !view().layout ? "check" : undefined,
                  onSelect: () => save({ layout: "auto" }),
                },
                {
                  label: "Always paired panes",
                  icon: view().layout === "split" ? "check" : undefined,
                  onSelect: () => save({ layout: "split" }),
                },
                {
                  label: "Always one column",
                  icon: view().layout === "unified" ? "check" : undefined,
                  onSelect: () => save({ layout: "unified" }),
                },
                { type: "separator" },
                {
                  label: view().wrap ? "Don't wrap lines" : "Wrap lines",
                  onSelect: () => save({ wrap: !view().wrap }),
                },
              ]}
            />
          </Show>
        </div>
        <Show when={taskID()}>
          <div class="lz-review-controls">
            <Ui.Select
              label="Comparison"
              class="lz-review-mode"
              options={modeOptions()}
              value={view().request.mode}
              onChange={(mode) => setRequest({ mode })}
            />
            <Show when={view().request.mode === "attempt"}>
              <Ui.Select
                label="Attempt"
                options={attemptOptions()}
                value={comparison.latest?.identity.attemptID ?? view().request.attemptID}
                onChange={(attemptID) => setRequest({ mode: "attempt", attemptID })}
              />
            </Show>
            <Show when={view().request.mode === "since"}>
              <Ui.Select
                label="Reviewed attempt"
                options={attemptOptions()}
                value={request()?.baseAttemptID}
                onChange={(baseAttemptID) =>
                  setRequest({ ...view().request, mode: "since", baseAttemptID })
                }
              />
              <span class="lz-review-arrow" aria-hidden="true">
                →
              </span>
              <Ui.Select
                label="Newer attempt"
                options={attemptOptions()}
                value={request()?.headAttemptID}
                onChange={(headAttemptID) =>
                  setRequest({ ...view().request, mode: "since", headAttemptID })
                }
              />
            </Show>
            <span class="lz-review-spacer" />
            <Ui.Tooltip value="Previous change" keys={["K"]}>
              <Ui.IconButton
                icon="chevron-left"
                label="Previous change"
                variant="ghost"
                size="small"
                disabled={!session()}
                onClick={() => step(-1)}
              />
            </Ui.Tooltip>
            <Ui.Tooltip value="Next change" keys={["J"]}>
              <Ui.IconButton
                icon="chevron-right"
                label="Next change"
                variant="ghost"
                size="small"
                disabled={!session()}
                onClick={() => step(1)}
              />
            </Ui.Tooltip>
          </div>
          <Show when={lineage.latest}>{(target) => <TargetLine target={target()} />}</Show>
        </Show>
      </header>

      <Switch>
        <Match when={!taskID()}>
          <div class="lz-review-empty">
            <p>Review shows a task's code changes. Open it from a task.</p>
            <Ui.Button
              variant="neutral"
              size="small"
              onClick={() => props.openers.openTasks(props.session)}
            >
              Open Tasks
            </Ui.Button>
          </div>
        </Match>
        <Match when={request() === null}>
          <div class="lz-review-empty">
            <p>{missingReason(view().request.mode)}</p>
            <Show when={view().request.mode !== "task"}>
              <Ui.Button
                variant="neutral"
                size="small"
                onClick={() => setRequest({ mode: "task" })}
              >
                Review the task
              </Ui.Button>
            </Show>
          </div>
        </Match>
        <Match
          when={comparison.latest && !comparison.latest.available ? comparison.latest : undefined}
        >
          {(unavailable) => (
            <div class="lz-review-empty">
              <p>{unavailable().unavailableReason ?? "This comparison has no source to show."}</p>
            </div>
          )}
        </Match>
        <Match when={true}>
          <DetailsPane
            ui={Ui}
            class="lz-review-split"
            open={storedState({ open: view().open, size: view().size }).open}
            size={storedState({ open: view().open, size: view().size }).size}
            onOpen={(open) => save({ open })}
            onSize={(size) => save({ size })}
            empty="Select lines to discuss them"
            disabled={!anchor()}
            header={selectionHeader()}
            label="Resize selection details"
            actions={
              <Show when={anchor()}>
                <div class="lz-review-actions">
                  <Ui.Button
                    size="small"
                    variant="ghost"
                    icon="speech-bubble"
                    onClick={() => void discuss("ask")}
                  >
                    Ask Architect
                  </Ui.Button>
                  <Ui.Button
                    size="small"
                    variant="neutral"
                    icon="pencil-line"
                    onClick={() => void discuss("fix")}
                  >
                    Request fix
                  </Ui.Button>
                </div>
              </Show>
            }
            top={
              <div class="lz-review-top" data-panel-dimmed={status.dimmed()}>
                <PanelStatus ui={Ui} status={status} onRetry={retry} skeleton="rows" />
                <Show when={session()} keyed>
                  {(current) => {
                    const s = () => current
                    return (
                      <>
                        <FileList
                          session={s()}
                          open={view().files ?? false}
                          onToggle={() => save({ files: !(view().files ?? false) })}
                          onPick={jumpTo}
                        />
                        <div class="lz-review-code" onPointerUp={onPointerUp}>
                          <ReviewCodeView
                            class="lz-review-scroller"
                            label={`Code changes of ${reference() || "the task"}`}
                            items={s().items()}
                            fallback={s().fallback()}
                            mode={ctx.appearance.mode()}
                            mono={ctx.appearance.font("mono")}
                            split={split()}
                            wrap={view().wrap ?? false}
                            pool={highlighter.pool}
                            header={fileHeader}
                            onSelection={(range) => select(fromLineSelection(range))}
                            onRendered={onRendered}
                            ref={setHandle}
                          />
                        </div>
                      </>
                    )
                  }}
                </Show>
              </div>
            }
          >
            <Show when={anchor()}>
              {(pinned) => (
                <div class="lz-review-detail">
                  <Show when={notice()}>
                    <p class="lz-review-notice" role="status">
                      {notice()}
                    </p>
                  </Show>
                  <Ui.Code content={pinned().excerpt} class="lz-review-excerpt" />
                  <Disclosure label="Identifiers">
                    <Identifiers
                      items={[
                        { label: "Path", value: pinned().source.path },
                        { label: "Side", value: pinned().source.side },
                        { label: "Object", value: pinned().source.revision },
                        { label: "Comparison", value: pinned().source.comparisonID },
                        ...(pinned().baseRevision
                          ? [{ label: "Base", value: pinned().baseRevision! }]
                          : []),
                        ...(pinned().headRevision
                          ? [{ label: "Head", value: pinned().headRevision! }]
                          : []),
                        ...(pinned().snapshotID
                          ? [{ label: "Snapshot", value: pinned().snapshotID! }]
                          : []),
                      ]}
                    />
                  </Disclosure>
                </div>
              )}
            </Show>
          </DetailsPane>
        </Match>
      </Switch>
    </div>
  )

  function FileList(listProps: {
    session: ReviewSession
    open: boolean
    onToggle(): void
    onPick(path: string): void
  }) {
    const files = () => listProps.session.files()
    return (
      <div class="lz-review-files" data-open={listProps.open ? "true" : undefined}>
        <button
          type="button"
          class="lz-review-files-toggle"
          aria-expanded={listProps.open}
          onClick={() => listProps.onToggle()}
        >
          <Ui.Icon name={listProps.open ? "chevron-down" : "chevron-right"} size="small" />
          <span>
            {files().length} {files().length === 1 ? "file" : "files"}
          </span>
          <Show when={!listProps.session.complete()}>
            <span class="lz-review-file-note">loading</span>
          </Show>
        </button>
        <Show when={listProps.open}>
          <ul class="lz-review-file-list" role="list">
            <For each={files()}>
              {(file) => (
                <li>
                  <button
                    type="button"
                    class="lz-review-file-row"
                    title={file.path}
                    onClick={() => listProps.onPick(file.path)}
                  >
                    <span
                      class="lz-review-status"
                      data-status={file.status}
                      aria-label={STATUS_GLYPH[file.status].word}
                    >
                      {STATUS_GLYPH[file.status].glyph}
                    </span>
                    <span class="lz-review-file-name">{splitPath(file.path).name}</span>
                    <span class="lz-review-file-folder">{splitPath(file.path).folder}</span>
                    <Counts view={listProps.session.view(file.path)} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    )
  }
}

function TargetLine(props: { target: IntegrationTarget }) {
  return (
    <div class="lz-review-target" title="Where this task's work lands">
      <span class="lz-review-mono">{props.target.branch}</span>
      <Show when={props.target.pullRequest}>{(pull) => <span> · PR #{pull().number}</span>}</Show>
    </div>
  )
}

export type { CodeReviewComparison }

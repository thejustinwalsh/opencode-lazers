import { For, Show, createEffect, createMemo, type Accessor, type JSX } from "solid-js"
import { Disclosure, Row, Rows } from "../details/index.ts"
import { createStream, type StreamsTransport } from "../streams/gui.ts"
import {
  liveHistoryItem,
  liveHistoryRef,
  type LiveHistoryItem,
} from "../streams/sources/live-history-ref.ts"
import { clockMinutes } from "./monitor-model.ts"
import { toolName } from "./worker-pane.ts"

/**
 * The older calls of the selected worker's attempt: its progress rows that carry a tool, newest
 * first, read through the `observability.liveHistory` stream. The list is one scroll area sized to
 * every row (the stream's counts are exact), and only the rows of the stream's window are drawn
 * inside it, at their place. Scrolling moves the window by items.
 *
 * ```
 *   scroll area (VIEW_ROWS high)         content (total rows high)
 *   ┌──────────────┐                     ┌──────────────┐  0
 *   │ rows in view │  ◄── scrollTop ──►  │ before       │  (not drawn)
 *   └──────────────┘                     │ ┌──────────┐ │  before rows down
 *                                        │ │ window   │ │  rows that fit + slop each side
 *                                        │ └──────────┘ │
 *                                        │ after        │  (not drawn)
 *                                        └──────────────┘
 * ```
 */
export const HISTORY_ROW_PX = 28
const VIEW_ROWS = 8
/** Rows that fit, with one more for a partly visible row. */
const FIT_ROWS = VIEW_ROWS + 1
const SLOP_ROWS = 12
export const HISTORY_WINDOW = FIT_ROWS + 2 * SLOP_ROWS
const COLUMNS = "64px minmax(0, 1fr) 64px"

export type HistoryTarget = { attemptID: string; sessionID: string; beforeAt?: number }
export type HistorySource = {
  transport: StreamsTransport
  projectDirectory: string
  scope: { kind: "session" | "project" | "all"; sessionID: string }
}

/** The older calls of one attempt as a stream. Call inside the owner that should close it. */
export function createOlderCalls(source: HistorySource, target: Accessor<HistoryTarget>) {
  const stream = createStream(source.transport, liveHistoryRef, () => {
    const now = target()
    return {
      filter: {
        projectDirectory: source.projectDirectory,
        attemptID: now.attemptID,
        sessionID: now.sessionID,
        scope: source.scope,
        toolsOnly: true,
        ...(now.beforeAt !== undefined && Number.isFinite(now.beforeAt)
          ? { beforeAt: now.beforeAt }
          : {}),
      },
      order: "recent",
      window: HISTORY_WINDOW,
    }
  })
  // Rows keep their object while their fields are unchanged, so the list keeps their elements.
  const known = new Map<number, LiveHistoryItem>()
  const items = createMemo(() => {
    const next = stream.items().map((row) => {
      const item = liveHistoryItem(row)
      const kept = known.get(item.sequence)
      return kept &&
        kept.tool === item.tool &&
        kept.status === item.status &&
        kept.error === item.error &&
        kept.at === item.at &&
        JSON.stringify(kept.fileTargets) === JSON.stringify(item.fileTargets)
        ? kept
        : item
    })
    known.clear()
    for (const item of next) known.set(item.sequence, item)
    return next
  })
  /** Every older call, when the stream has counted them; undefined until its first frame. */
  const total = createMemo(() => {
    const before = stream.before()
    const after = stream.after()
    return typeof before === "number" && typeof after === "number"
      ? before + stream.items().length + after
      : undefined
  })
  return { stream, items, total }
}
export type OlderCalls = ReturnType<typeof createOlderCalls>

function targetOf(item: LiveHistoryItem) {
  return (
    item.error ??
    (item.fileTargets?.coverage === "observed" && item.fileTargets.paths.length > 0
      ? item.fileTargets.paths.join(", ")
      : (item.status ?? "—"))
  )
}

function OlderRows(props: { older: OlderCalls; monoFont: string }) {
  const { stream, items, total } = props.older
  let area: HTMLDivElement | undefined
  let moving = false
  const start = () => {
    const before = stream.before()
    return typeof before === "number" ? before : 0
  }
  /** Bring the window around what is in view; one move at a time, each answered by a frame. */
  const follow = () => {
    const count = total()
    if (!area || count === undefined || moving) return
    const first = Math.floor(area.scrollTop / HISTORY_ROW_PX)
    const want = Math.min(Math.max(0, first - SLOP_ROWS), Math.max(0, count - HISTORY_WINDOW))
    const delta = want - start()
    if (Math.abs(delta) < SLOP_ROWS / 2) return
    moving = true
    stream.slide(delta)
  }
  createEffect(() => {
    items()
    moving = false
    follow()
  })
  return (
    <div
      class="lazers-kit-rows lazers-radar-history"
      role="table"
      aria-label="Older calls"
      style={{ "--lazers-kit-columns": COLUMNS }}
    >
      <div class="lazers-kit-row lazers-kit-rows-head" role="row">
        <For each={["Tool", "Target", "Time"]}>
          {(name) => <span role="columnheader">{name}</span>}
        </For>
      </div>
      <div
        ref={area}
        class="lazers-radar-history-scroll"
        tabindex="0"
        style={{ height: `${Math.min(total() ?? 0, VIEW_ROWS) * HISTORY_ROW_PX}px` }}
        onScroll={follow}
      >
        <div
          class="lazers-radar-history-content"
          style={{ height: `${(total() ?? 0) * HISTORY_ROW_PX}px` }}
        >
          <div
            class="lazers-radar-history-window"
            style={{ transform: `translateY(${start() * HISTORY_ROW_PX}px)` }}
          >
            <For each={items()}>
              {(item) => (
                <Row>
                  <span>{toolName(item.tool ?? "")}</span>
                  <code
                    class="lazers-radar-row-target"
                    data-failed={item.status === "failed"}
                    data-sequence={item.sequence}
                    style={{ "font-family": props.monoFont }}
                    title={targetOf(item)}
                  >
                    {targetOf(item)}
                  </code>
                  <span>{clockMinutes(item.at)}</span>
                </Row>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}

type CallsProps<L> = {
  /** Calls the live read lists as earlier; the caller draws their rows. */
  earlier: readonly L[]
  renderEarlier: (line: L) => JSX.Element
  /** Where older calls come from; absent when there is no stream to ask. */
  source?: HistorySource
  /** The attempt whose older calls are listed; absent for a session without one. */
  target?: HistoryTarget
  monoFont: string
}

function CallsBody<L>(props: CallsProps<L> & { older?: OlderCalls }) {
  const olderTotal = () => props.older?.total() ?? 0
  const count = () => props.earlier.length + olderTotal()
  return (
    <Disclosure label="Calls" count={count()} when={count() > 0}>
      <Rows
        columns="64px minmax(0, 1fr) 56px 64px"
        header={["Tool", "Target", "Duration", "Time"]}
        items={props.earlier}
        label="Earlier calls"
      >
        {(line) => props.renderEarlier(line)}
      </Rows>
      <Show when={props.older?.stream.error()}>
        <p class="lazers-radar-note" data-error="true">
          Couldn't load history.
        </p>
      </Show>
      <Show when={props.older && olderTotal() > 0}>
        <OlderRows older={props.older!} monoFont={props.monoFont} />
      </Show>
    </Disclosure>
  )
}

/** The Calls disclosure: the live read's earlier calls, then the attempt's older ones. */
export function CallsDisclosure<L>(props: CallsProps<L>) {
  return (
    <Show
      when={props.source && props.target ? props.source : undefined}
      keyed
      fallback={<CallsBody {...props} />}
    >
      {(source) => {
        const older = createOlderCalls(source, () => props.target!)
        return <CallsBody {...props} older={older} />
      }}
    </Show>
  )
}

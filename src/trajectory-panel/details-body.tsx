import type { Ui as HostUi } from "@opencode/plugin/gui"
import { For, Show, createMemo } from "solid-js"
import type { JSX } from "solid-js"
import {
  ActivityLane,
  Callout,
  Coverage,
  Disclosure,
  Identifiers,
  Row,
  Rows,
  Section,
  StatRow,
  callsText,
  durationText,
} from "../details/index.ts"
import type { LabelTone, LaneTick } from "../details/index.ts"
import { caveats, coverageView, costView, ratesRows, tokensText } from "./attempt-summary.ts"
import type { EndReason, SummaryRow } from "./attempt-summary.ts"
import { eventFilters, eventLabel, eventMatchesFilter } from "./event-names.ts"
import type { EventFilter } from "./event-names.ts"
import type { TrajectoryEvent, TrajectoryReport } from "./projection.ts"

export const clock = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`

/** `8:14:02 PM · +22m`: the clock time and the offset into the attempt, when there is one. */
export function startedText(at: number, origin: number | null) {
  const offset = origin === null ? 0 : Math.max(0, at - origin)
  return offset > 0 ? `${clock(at)} · +${durationText(offset)}` : clock(at)
}

export type AttemptPaneProps = {
  ui: HostUi
  report: TrajectoryReport
  duration: { ms: number; open: boolean } | null
  state: string
  files: number
  calls: number
  summary: readonly SummaryRow[]
  reason: EndReason | null
  /** The glyph for the Callout, already drawn. */
  reasonIcon: JSX.Element
  events: readonly TrajectoryEvent[]
  notes: readonly string[]
  identifiers: ReadonlyArray<{ label: string; value?: string | null }>
  capture: { at: number | null; expiresAt: number | null; error: string; busy: boolean }
  onRecapture: () => void
  onSelectEvent: (id: string) => void
  /** Bumps when "Show" on the Errors row asks for the filtered events. */
  eventsRequest: { open: boolean; filter: EventFilter }
  onEventsOpen: (open: boolean) => void
  onFilter: (filter: EventFilter) => void
  onShowErrors: () => void
}

function SummaryTable(props: { rows: readonly SummaryRow[]; onShowErrors: () => void }) {
  return (
    <Section label="Summary">
      <Rows columns="56px minmax(0, 1fr) auto" items={props.rows} label="Summary">
        {(row) => (
          <Row>
            <span class="lazers-trajectory-summary-label">{row.label}</span>
            <span class="lazers-trajectory-summary-text" title={row.text}>
              {row.text}
            </span>
            <span class="lazers-trajectory-summary-time">
              <Show
                when={row.action === "errors"}
                fallback={
                  row.durationMs !== undefined
                    ? durationText(row.durationMs)
                    : row.at !== undefined
                      ? new Date(row.at).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })
                      : ""
                }
              >
                <button
                  type="button"
                  class="lazers-trajectory-link"
                  onClick={() => props.onShowErrors()}
                >
                  Show
                </button>
              </Show>
            </span>
          </Row>
        )}
      </Rows>
    </Section>
  )
}

/** The attempt's pane: why it ended, the numbers, a summary, coverage and four disclosures. */
export function AttemptPane(props: AttemptPaneProps) {
  const cost = createMemo(() => costView(props.report))
  const coverage = createMemo(() => coverageView(props.report))
  const rates = createMemo(() => ratesRows(props.report))
  const lines = createMemo(() => caveats(props.report))
  const filterCounts = createMemo(() => {
    const counts = new Map<EventFilter, number>()
    for (const filter of eventFilters)
      counts.set(filter.id, props.events.filter((e) => eventMatchesFilter(e, filter.id)).length)
    return counts
  })
  const shown = createMemo(() =>
    props.events.filter((event) => eventMatchesFilter(event, props.eventsRequest.filter)),
  )
  const gapEvents = createMemo(() => props.events.filter((event) => event.kind === "worker-gap"))
  const gapCount = () => props.notes.length + gapEvents().length
  return (
    <div class="lazers-trajectory-pane-body" data-pane="attempt">
      <Show when={props.reason}>
        {(reason) => (
          <Callout
            class="lazers-trajectory-callout"
            iconTone={reason().tone}
            icon={props.reasonIcon}
            text={reason().text}
            {...(reason().raw ? { raw: reason().raw } : {})}
          />
        )}
      </Show>
      <StatRow
        stats={[
          {
            label: "Duration",
            value: props.duration
              ? `${durationText(props.duration.ms)}${props.duration.open ? " so far" : ""}`
              : null,
          },
          { label: "Calls", value: callsText(props.calls, props.files) },
          { label: "Tokens", value: tokensText(props.report.effort.tokenUsage) },
          {
            label: "Cost",
            value: cost()?.value ?? null,
            ...(cost()?.partial
              ? {
                  note: {
                    text: "partial",
                    tone: "warning" as LabelTone,
                    title: "Some recorded usage has no published price",
                  },
                }
              : {}),
          },
        ]}
      />
      <Show when={props.summary.length > 0}>
        <SummaryTable rows={props.summary} onShowErrors={props.onShowErrors} />
      </Show>
      <Show when={coverage()}>
        {(view) => (
          <Section
            label="Coverage"
            aside={<span class="lazers-trajectory-weak">{view().aside}</span>}
          >
            <Coverage
              priced={view().priced}
              unpriced={view().unpriced}
              caption={view().caption}
              {...(view().note ? { note: view().note } : {})}
            />
          </Section>
        )}
      </Show>
      <div class="lazers-trajectory-disclosures">
        <Disclosure label="Rates" when={rates().length > 0}>
          <div class="lazers-trajectory-rates">
            <Rows
              columns="minmax(72px, 1.4fr) repeat(4, minmax(0, 1fr))"
              header={["Rate", "Input", "Output", "Cache read", "Cache write"]}
              items={rates()}
              label="Rates in USD per million tokens"
            >
              {(row) => (
                <Row>
                  <span>{row.tier}</span>
                  <For each={row.cells}>
                    {(cell) => <span class="lazers-kit-mono">{cell}</span>}
                  </For>
                </Row>
              )}
            </Rows>
            <p class="lazers-trajectory-note">USD per million tokens</p>
            <For each={lines()}>{(line) => <p class="lazers-trajectory-note">{line}</p>}</For>
          </div>
        </Disclosure>
        <Disclosure
          label="Events"
          count={props.events.length}
          open={props.eventsRequest.open}
          onOpenChange={props.onEventsOpen}
        >
          <div class="lazers-trajectory-activity-list">
            <div class="lazers-trajectory-filters" role="group" aria-label="Filter events">
              <For each={eventFilters.filter((f) => f.id === "all" || filterCounts().get(f.id))}>
                {(filter) => (
                  <button
                    type="button"
                    class="lazers-trajectory-filter"
                    aria-pressed={props.eventsRequest.filter === filter.id}
                    onClick={() => props.onFilter(filter.id)}
                  >
                    {filter.label}
                  </button>
                )}
              </For>
            </div>
            <div class="lazers-trajectory-capture-note" role="status">
              <span>
                {props.capture.at
                  ? `Captured ${new Date(props.capture.at).toLocaleString()}${
                      props.capture.expiresAt
                        ? ` · expires ${new Date(props.capture.expiresAt).toLocaleTimeString()}`
                        : ""
                    }`
                  : ""}
              </span>
              <props.ui.Button
                variant="ghost"
                size="small"
                busy={props.capture.busy}
                onClick={() => props.onRecapture()}
              >
                Recapture history
              </props.ui.Button>
            </div>
            <Show when={props.capture.error}>
              <div class="lazers-trajectory-error" role="alert">
                {props.capture.error}
              </div>
            </Show>
            <For each={shown()}>
              {(event) => (
                <button
                  type="button"
                  class="lazers-trajectory-event"
                  data-scroll-anchor={`event:${event.id}`}
                  onClick={() => props.onSelectEvent(event.id)}
                >
                  <span class="lazers-trajectory-event-title">{eventLabel(event)}</span>
                  <time>
                    {typeof event.at === "number" ? new Date(event.at).toLocaleTimeString() : ""}
                  </time>
                </button>
              )}
            </For>
          </div>
        </Disclosure>
        <Disclosure label="Gaps" count={gapCount()}>
          <ul class="lazers-trajectory-gap-list">
            <For each={props.notes}>{(note) => <li>{note}</li>}</For>
            <For each={gapEvents()}>
              {(event) => (
                <li>
                  {event.reason ?? "Recording gap"}
                  <Show when={typeof event.at === "number"}>
                    <time> · {clock(event.at as number)}</time>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Disclosure>
        <Disclosure label="Identifiers">
          <Identifiers items={props.identifiers} />
        </Disclosure>
      </div>
    </div>
  )
}

export type CallPaneProps = {
  /** `LZ-240 · Attempt 1`, the link back to the attempt. */
  parent: string
  onParent: () => void
  /** What the item is, after the link: `shell`, `Check`, `Runner step`. */
  name: string
  /** The command or target, in a code block. */
  command: string
  /** A reason or message, clamped to two lines; the full text is in Payload. */
  note: string
  sources: ReadonlyArray<{ label: string; open: () => void }>
  started: string | null
  /** Shown only when there is no start: a check recorded with just its end. */
  ended?: string | null
  durationMs: number | null
  result: { text: string; tone: LabelTone } | null
  lane: {
    ticks: readonly LaneTick[]
    durationMs: number
    selectedId: string | undefined
    start: string
    end: string
  } | null
  output: string
  outputOpen: boolean
  files: readonly string[]
  payload: unknown
  identifiers: ReadonlyArray<{ label: string; value?: string | null }>
}

const lineCount = (text: string) => plural(text.split(/\r?\n/).length, "line")

/** One call, check or event and nothing else: the attempt's report is not repeated here. */
export function CallPane(props: { view: CallPaneProps }) {
  return (
    <div class="lazers-trajectory-pane-body" data-pane="call">
      <nav class="lazers-trajectory-crumb" aria-label="Parent">
        <button type="button" class="lazers-trajectory-link" onClick={() => props.view.onParent()}>
          {props.view.parent}
        </button>
        <span aria-hidden="true">›</span>
        <span class="lazers-kit-mono">{props.view.name}</span>
      </nav>
      <Show when={props.view.command}>
        <Section label="Command">
          <pre class="lazers-trajectory-command lazers-kit-mono">{props.view.command}</pre>
        </Section>
      </Show>
      <Show when={props.view.note}>
        <p class="lazers-trajectory-clamp" title={props.view.note}>
          {props.view.note}
        </p>
      </Show>
      <Show when={props.view.sources.length > 0}>
        <div class="lazers-trajectory-source-links">
          <For each={props.view.sources}>
            {(source) => (
              <button type="button" onClick={() => source.open()}>
                {source.label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <StatRow
        stats={[
          { label: "Started", value: props.view.started },
          { label: "Ended", value: props.view.started ? null : (props.view.ended ?? null) },
          {
            label: "Duration",
            value: props.view.durationMs === null ? null : durationText(props.view.durationMs),
          },
          {
            label: "Result",
            ...(props.view.result
              ? { note: { text: props.view.result.text, tone: props.view.result.tone } }
              : {}),
          },
        ]}
      />
      <Show when={props.view.lane}>
        {(lane) => (
          <Section label="Position">
            <ActivityLane
              label="Position in the attempt"
              ticks={lane().ticks}
              durationMs={lane().durationMs}
              {...(lane().selectedId ? { selectedId: lane().selectedId } : {})}
              start={lane().start}
              end={lane().end}
            />
          </Section>
        )}
      </Show>
      <div class="lazers-trajectory-disclosures">
        <Disclosure
          label="Output"
          when={props.view.output !== ""}
          defaultOpen={props.view.outputOpen}
        >
          <pre class="lazers-trajectory-pre">{props.view.output}</pre>
          <p class="lazers-trajectory-note">{lineCount(props.view.output)}</p>
        </Disclosure>
        <Disclosure label="Files" count={props.view.files.length}>
          <ul class="lazers-trajectory-files">
            <For each={props.view.files}>{(path) => <li class="lazers-kit-mono">{path}</li>}</For>
          </ul>
        </Disclosure>
        <Disclosure
          label="Payload"
          when={props.view.payload !== undefined && props.view.payload !== null}
        >
          <pre class="lazers-trajectory-pre">{JSON.stringify(props.view.payload, null, 2)}</pre>
        </Disclosure>
        <Disclosure label="Identifiers">
          <Identifiers items={props.view.identifiers} />
        </Disclosure>
      </div>
    </div>
  )
}

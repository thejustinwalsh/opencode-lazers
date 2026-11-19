import { For, Show, createMemo, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { durationText } from "./format.ts"
import { laneLayout } from "./lane.ts"
import type { LaneInput, LaneMark } from "./lane.ts"
import { progressSteps } from "./progress.ts"
import type { LabelTone } from "./tone.ts"

const present = (value: unknown) =>
  value !== undefined && value !== null && value !== "" && value !== false

/** Up to four label/value columns between two hairlines. A column with no value is not rendered. */
export function StatRow(props: {
  stats: ReadonlyArray<{
    label: string
    value?: string | number | null
    /** A Label after the value, for a state that changes how the number reads (`partial`). */
    note?: { text: string; tone: LabelTone; title?: string }
  }>
}): JSX.Element {
  const shown = createMemo(() =>
    props.stats.filter((stat) => present(stat.value) || stat.note).slice(0, 4),
  )
  return (
    <Show when={shown().length > 0}>
      <dl class="lazers-kit-stats" style={{ "--lazers-kit-columns": shown().length }}>
        <For each={shown()}>
          {(stat) => (
            <div class="lazers-kit-stat">
              <dt>{stat.label}</dt>
              <dd title={present(stat.value) ? String(stat.value) : undefined}>
                {stat.value}
                <Show when={stat.note}>
                  {(note) => (
                    <>
                      {present(stat.value) ? " " : ""}
                      <Label tone={note().tone} title={note().title}>
                        {note().text}
                      </Label>
                    </>
                  )}
                </Show>
              </dd>
            </div>
          )}
        </For>
      </dl>
    </Show>
  )
}

/** A state that changes how a number reads: 1 px border and a 22 % fill in the tone's hue. */
export function Label(props: {
  tone: LabelTone
  children: JSX.Element
  title?: string
}): JSX.Element {
  return (
    <span class="lazers-kit-label" data-lazers-tone={props.tone} title={props.title}>
      {props.children}
    </span>
  )
}

/** Ordered steps: passed, current (in `tone`) and later. Green only on the final step. */
export function Progress(props: {
  steps: readonly string[]
  /** Index of the current step; below zero when nothing has started. */
  current: number
  tone?: LabelTone
  label?: string
}): JSX.Element {
  const steps = createMemo(() => progressSteps(props.steps, props.current, props.tone))
  return (
    <ol
      class="lazers-kit-progress"
      aria-label={props.label ?? "Progress"}
      style={{ "--lazers-kit-steps": props.steps.length }}
    >
      <For each={steps()}>
        {(step) => (
          <li
            class="lazers-kit-step"
            data-state={step.state}
            data-lazers-tone={step.tone}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <span>{step.label}</span>
          </li>
        )}
      </For>
    </ol>
  )
}

/** Width of a collapsed quiet stretch; it carries no text, only a break in the track. */
const IDLE_PX = 20

/**
 * One Trajectory-style lane: a bare track with no text and no captions. Hover or keyboard focus
 * (the lane takes Arrow keys) shows the detail of one mark or quiet stretch, and the lane's
 * accessible name states the summary in words. The DOM holds at most `maxMarks` marks per active
 * segment however many ticks there are.
 *
 * `originAt` (epoch ms of the lane's start) turns offsets into clock times; without it hovers
 * read as offsets (`+4m 12s`). `noun` names what the ticks are (`calls`).
 */
export function ActivityLane(
  props: LaneInput & {
    label: string
    originAt?: number
    noun?: string
    /** Retained for callers that still pass captions; the lane no longer draws them. */
    start?: string
    middle?: string
    end?: string
  },
): JSX.Element {
  const segments = createMemo(() => laneLayout(props))
  const [active, setActive] = createSignal(-1)
  const clock = (ms: number) =>
    props.originAt === undefined
      ? `+${durationText(ms)}`
      : new Date(props.originAt + ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  const range = (from: number, to: number) =>
    from === to ? clock(from) : `${clock(from)} – ${clock(to)}`
  const markTip = (mark: LaneMark) =>
    mark.count > 1
      ? `${mark.count} ${props.noun ?? "calls"} · ${range(mark.fromMs, mark.toMs)}${mark.failed ? " · includes a failure" : ""}`
      : [
          mark.label ?? "Call",
          clock(mark.fromMs),
          mark.durationMs !== undefined ? durationText(mark.durationMs) : "",
          mark.failed ? "failed" : "",
        ]
          .filter(Boolean)
          .join(" · ")
  const idleTip = (segment: { startMs: number; endMs: number; label: string }) =>
    `${segment.label} · ${range(segment.startMs, segment.endMs)}`
  const activeSum = createMemo(() =>
    segments().reduce((sum, segment) => sum + (segment.kind === "active" ? segment.width : 0), 0),
  )
  const idleCount = createMemo(() => segments().filter((segment) => segment.kind === "idle").length)
  /** Marks and idle stretches in track order: what Arrow keys step through. */
  const stops = createMemo(() =>
    segments().flatMap((segment) =>
      segment.kind === "idle"
        ? [{ tip: idleTip(segment) }]
        : segment.marks.map((mark) => ({ tip: markTip(mark) })),
    ),
  )
  const span = () => {
    const last = segments().at(-1)
    return { start: 0, end: last?.endMs ?? 0 }
  }
  const summary = createMemo(() => {
    const ticks = props.ticks.length
    const lastTick = props.ticks.reduce((max, tick) => Math.max(max, tick.at), 0)
    const idle = segments().flatMap((segment) =>
      segment.kind === "idle" ? [`idle ${segment.label.replace(/ idle$/, "")}`] : [],
    )
    return [
      `${ticks} ${props.noun ?? "calls"}${props.originAt !== undefined ? ` from ${clock(0)}` : ""}`,
      ticks > 0 && props.originAt !== undefined ? `last activity ${clock(lastTick)}` : "",
      ...idle,
    ]
      .filter(Boolean)
      .join(", ")
  })
  /** Index of each segment's first stop. */
  const starts = createMemo(() => {
    let next = 0
    return segments().map((segment) => {
      const start = next
      next += segment.kind === "idle" ? 1 : segment.marks.length
      return start
    })
  })
  const trackTip = () =>
    props.originAt !== undefined ? range(span().start, span().end) : undefined
  return (
    <div class="lazers-kit-section">
      <div
        class="lazers-kit-lane"
        role="img"
        tabIndex={0}
        aria-label={`${props.label}: ${summary()}`}
        data-tip={trackTip()}
        onKeyDown={(event) => {
          const count = stops().length
          if (!count) return
          if (event.key === "ArrowRight") setActive(Math.min(count - 1, active() + 1))
          else if (event.key === "ArrowLeft") setActive(Math.max(0, active() - 1))
          else if (event.key === "Escape") setActive(-1)
          else return
          event.preventDefault()
        }}
        onBlur={() => setActive(-1)}
      >
        <For each={segments()}>
          {(segment, segmentIndex) => {
            const start = starts()[segmentIndex()]!
            return segment.kind === "idle" ? (
              <div
                class="lazers-kit-lane-idle"
                style={{ width: `${IDLE_PX}px` }}
                data-tip={idleTip(segment)}
                data-active={active() === start}
              />
            ) : (
              <div
                class="lazers-kit-lane-active"
                style={{
                  width: `calc((100% - ${idleCount() * IDLE_PX}px) * ${(segment.width / (activeSum() || 1)).toFixed(6)})`,
                }}
              >
                <For each={segment.marks}>
                  {(mark, markIndex) => (
                    <span
                      class="lazers-kit-tick"
                      data-failed={mark.failed}
                      data-selected={mark.selected}
                      data-active={active() === start + markIndex()}
                      data-edge={mark.left < 18 ? "start" : mark.left > 82 ? "end" : undefined}
                      data-tip={markTip(mark)}
                      style={{ left: `${mark.left}%` }}
                    />
                  )}
                </For>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}

/** A 4 px two-part bar and one caption line. Not rendered when nothing was counted. */
export function Coverage(props: {
  priced: number
  unpriced: number
  /** Left caption, e.g. `24 calls priced`. */
  caption: string
  /** Right caption in the warning tone, e.g. what has no price. */
  note?: string
}): JSX.Element {
  const total = () => props.priced + props.unpriced
  return (
    <Show when={total() > 0}>
      <div class="lazers-kit-section">
        <div class="lazers-kit-coverage-bar">
          <div
            class="lazers-kit-coverage-priced"
            style={{ width: `${(props.priced / total()) * 100}%` }}
          />
          <div
            class="lazers-kit-coverage-unpriced"
            style={{ width: `${(props.unpriced / total()) * 100}%` }}
          />
        </div>
        <div class="lazers-kit-coverage-caption">
          <span>{props.caption}</span>
          <Show when={props.note}>
            <span class="lazers-kit-coverage-note">{props.note}</span>
          </Show>
        </div>
      </div>
    </Show>
  )
}

/**
 * Flat rows with hairlines and an optional 26 px weak header. `columns` is a CSS grid template
 * shared by the header and every row. Not rendered when there are no items.
 */
export function Rows<T>(props: {
  columns: string
  header?: readonly string[]
  items: readonly T[]
  children: (item: T, index: number) => JSX.Element
  label?: string
}): JSX.Element {
  return (
    <Show when={props.items.length > 0}>
      <div
        class="lazers-kit-rows"
        role="table"
        aria-label={props.label}
        style={{ "--lazers-kit-columns": props.columns }}
      >
        <Show when={props.header}>
          {(header) => (
            <div class="lazers-kit-row lazers-kit-rows-head" role="row">
              <For each={header()}>{(name) => <span role="columnheader">{name}</span>}</For>
            </div>
          )}
        </Show>
        <For each={props.items}>{(item, index) => props.children(item, index())}</For>
      </div>
    </Show>
  )
}

/** One row of `Rows`; a button when `onSelect` is given. Children are its cells. */
export function Row(props: { children: JSX.Element; onSelect?: () => void }): JSX.Element {
  return props.onSelect ? (
    <button type="button" class="lazers-kit-row" role="row" onClick={() => props.onSelect?.()}>
      {props.children}
    </button>
  ) : (
    <div class="lazers-kit-row" role="row">
      {props.children}
    </div>
  )
}

function Chevron(): JSX.Element {
  return (
    <svg
      class="lazers-kit-chevron"
      aria-hidden="true"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
    >
      <path d="M3.5 2 6.5 5l-3 3" />
    </svg>
  )
}

/**
 * A bare chevron row: label, then `· count`. Not rendered when `when` is false, `count` is zero,
 * or there is no content. Content mounts only while open.
 */
export function Disclosure(props: {
  label: string
  count?: number
  when?: boolean
  defaultOpen?: boolean
  /** Controls the open state from outside, e.g. a link that opens this row. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: JSX.Element
}): JSX.Element {
  const [inner, setInner] = createSignal(props.defaultOpen ?? false)
  const open = () => props.open ?? inner()
  const setOpen = (next: boolean) => {
    setInner(next)
    props.onOpenChange?.(next)
  }
  const visible = () => props.when !== false && props.count !== 0
  return (
    <Show when={visible()}>
      <div class="lazers-kit-disclosure">
        <button
          type="button"
          class="lazers-kit-disclosure-toggle"
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
        >
          <Chevron />
          <span>{props.label}</span>
          <Show when={props.count !== undefined}>
            <span class="lazers-kit-disclosure-count">· {props.count}</span>
          </Show>
        </button>
        <Show when={open()}>
          <div class="lazers-kit-disclosure-body">{props.children}</div>
        </Show>
      </div>
    </Show>
  )
}

/**
 * The reason a task, attempt or worker is where it is: a raised surface, a tone on the glyph only,
 * one or two sentences and an optional Details link that reveals `raw`.
 */
export function Callout(props: {
  icon: JSX.Element
  /** Sets `data-tone` on the glyph; the caller's CSS or a `LabelTone` colors it. */
  iconTone?: string
  text: string
  /** Raw detail revealed by the Details link. */
  raw?: string
  class?: string
  /** Rendered under the sentence. */
  children?: JSX.Element
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  return (
    <div
      class={`lazers-callout ${props.class ?? ""}`.trim()}
      data-tone={props.iconTone}
      role="status"
    >
      <span class="lazers-callout-icon" data-tone={props.iconTone}>
        {props.icon}
      </span>
      <div class="lazers-callout-body">
        <div class="lazers-callout-text">
          {props.text}
          <Show when={props.raw}>
            <>
              {" "}
              <button
                type="button"
                class="lazers-callout-toggle"
                aria-expanded={open()}
                onClick={() => setOpen(!open())}
              >
                Details
              </button>
            </>
          </Show>
        </div>
        <Show when={props.raw}>
          {(raw) => (
            <pre class="lazers-callout-raw" hidden={!open()}>
              {raw()}
            </pre>
          )}
        </Show>
        {props.children}
      </div>
    </div>
  )
}

function copy(value: string) {
  try {
    void globalThis.navigator?.clipboard?.writeText(value)
  } catch {
    /* no clipboard in this host: the button still reports nothing copied */
  }
}

/** Label/value rows in mono with a copy control per value. Rows without a value are omitted. */
export function Identifiers(props: {
  items: ReadonlyArray<{ label: string; value?: string | null }>
}): JSX.Element {
  const shown = createMemo(() => props.items.filter((item) => present(item.value)))
  const [copied, setCopied] = createSignal<string>()
  return (
    <Show when={shown().length > 0}>
      <dl class="lazers-kit-ids">
        <For each={shown()}>
          {(item) => (
            <div class="lazers-kit-id">
              <dt>{item.label}</dt>
              <dd>
                <span class="lazers-kit-id-value" title={item.value ?? ""}>
                  {item.value}
                </span>
              </dd>
              <dd class="lazers-kit-id-copy-cell">
                <button
                  type="button"
                  class="lazers-kit-copy"
                  aria-label={`Copy ${item.label}`}
                  onClick={() => {
                    copy(item.value!)
                    setCopied(item.label)
                  }}
                >
                  {copied() === item.label ? "Copied" : "Copy"}
                </button>
              </dd>
            </div>
          )}
        </For>
      </dl>
    </Show>
  )
}

/** Section title row used above Progress, Activity and Coverage: a weak label and an optional link. */
export function Section(props: {
  label: string
  aside?: JSX.Element
  children: JSX.Element
}): JSX.Element {
  return (
    <div class="lazers-kit-section">
      <div class="lazers-kit-section-head">
        <span>{props.label}</span>
        {props.aside}
      </div>
      {props.children}
    </div>
  )
}

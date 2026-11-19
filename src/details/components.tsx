import { For, Show, createMemo, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { laneLayout } from "./lane.ts"
import type { LaneInput } from "./lane.ts"
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
  const shown = createMemo(() => props.stats.filter((stat) => present(stat.value) || stat.note).slice(0, 4))
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

/**
 * One Trajectory-style lane. Layout is `laneLayout`, which merges ticks into a bounded number of
 * marks, so thousands of ticks cost at most `maxMarks` nodes per active segment.
 */
export function ActivityLane(
  props: LaneInput & { label: string; start?: string; middle?: string; end?: string },
): JSX.Element {
  const segments = createMemo(() => laneLayout(props))
  return (
    <div class="lazers-kit-section">
      <div class="lazers-kit-lane" role="img" aria-label={props.label}>
        <For each={segments()}>
          {(segment) =>
            segment.kind === "idle" ? (
              <div class="lazers-kit-lane-idle" style={{ width: `${segment.width}%` }}>
                {segment.label}
              </div>
            ) : (
              <div class="lazers-kit-lane-active" style={{ width: `${segment.width}%` }}>
                <For each={segment.marks}>
                  {(mark) => (
                    <span
                      class="lazers-kit-tick"
                      data-failed={mark.failed}
                      data-selected={mark.selected}
                      style={{ left: `${mark.left}%` }}
                    />
                  )}
                </For>
              </div>
            )
          }
        </For>
      </div>
      <Show when={props.start || props.middle || props.end}>
        <div class="lazers-kit-lane-captions">
          <span>{props.start}</span>
          <span>{props.middle}</span>
          <span>{props.end}</span>
        </div>
      </Show>
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

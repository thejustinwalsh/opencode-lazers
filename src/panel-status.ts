/**
 * One loading, reconnect and failure contract for every LAZERS panel.
 *
 *   first load        → skeleton of the real layout + one status line
 *   > 10 s            → "Still loading · 12 s" + Retry
 *   refresh/reconnect → keep the last content, dim it, one banner with Retry
 *   failed            → one sentence in user terms + Retry; transport detail behind Details
 *
 * This file is the pure decision; `panel-status.tsx` renders it.
 */

export const SLOW_AFTER_MS = 10_000

export interface PanelStatusInput {
  /** What the panel loads, as it reads after "Loading": "tasks", "live activity". */
  subject: string
  /** The panel holds something worth keeping on screen. */
  hasContent: boolean
  /** A read is in flight. */
  loading: boolean
  /** The live link is down, so the shown content is the last known. */
  disconnected?: boolean
  /** The last read failed. Raw text; it is shown only behind Details. */
  error?: string
  /** Epoch ms the shown content was last confirmed current. */
  asOf?: number
  /** Extra words after "Loading <subject>", such as "14 tasks so far". */
  progress?: string
}

export type PanelStatusView =
  | { kind: "ready" }
  | { kind: "loading"; slow: boolean; line: string }
  /** Content stays, dimmed, under one banner. */
  | { kind: "reconnecting"; line: string; detail?: string }
  | { kind: "failed"; line: string; detail?: string }

export function panelClock(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function cause(error: string): string {
  if (/time[d-]? ?out|deadline/i.test(error)) return "the LAZERS service did not answer in time"
  if (
    /offline|disconnect|not connected|unreachable|network|fetch failed|ECONN|socket|abort/i.test(
      error,
    )
  )
    return "the LAZERS service is not reachable"
  return ""
}

/** One plain sentence. The raw error never appears in it. */
export function panelFailureSentence(subject: string, error: string): string {
  const reason = cause(error)
  return reason ? `Couldn't load ${subject}: ${reason}.` : `Couldn't load ${subject}.`
}

/**
 * `elapsed` is how long the current first load has run, in ms. The caller owns the clock so
 * the decision stays pure.
 */
export function panelStatus(input: PanelStatusInput, elapsed = 0): PanelStatusView {
  const error = input.error?.trim() ?? ""
  if (input.hasContent) {
    if (!input.disconnected && !error) return { kind: "ready" }
    const asOf = input.asOf === undefined ? "" : ` · as of ${panelClock(input.asOf)}`
    return {
      kind: "reconnecting",
      line: `${input.disconnected || input.loading ? "Reconnecting" : `Couldn't update ${input.subject}`}${asOf}`,
      ...(error ? { detail: error } : {}),
    }
  }
  if (input.loading) {
    const slow = elapsed >= SLOW_AFTER_MS
    const progress = input.progress ? ` · ${input.progress}` : ""
    return {
      kind: "loading",
      slow,
      line: slow
        ? `Still loading · ${Math.floor(elapsed / 1000)} s`
        : `Loading ${input.subject}${progress}`,
    }
  }
  if (error || input.disconnected)
    return {
      kind: "failed",
      line: panelFailureSentence(input.subject, error || "disconnected"),
      ...(error ? { detail: error } : {}),
    }
  return { kind: "ready" }
}

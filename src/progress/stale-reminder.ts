/**
 * Advice for a worker whose last `lz-report-progress` is far behind its own activity. It is text on
 * a tool result: never a refusal, hold, state or gate.
 *
 * Staleness is counted in the worker's own tool calls since its last report (or since it started),
 * because the panels and the recovery detector read progress as a sequence of tool calls rather than
 * as time, and a worker waiting on a long check is not stale.
 *
 * `STALE_PROGRESS_CALLS` was chosen against the production journal (209 worker attempts with tool
 * rows, Nov 2026): attempts make a median of 99 tool calls (p75 221, p90 426), and only 29 of
 * them ever called `lz-report-progress` (53 reports). Where a worker did report, the median
 * stretch of tool calls before a report was 41 (p75 122, p90 243). The reminder fires once at
 * 50, just above the cadence workers keep on their own, so it reaches the 80% of attempts that
 * never report without nagging the ones that do. Re-measure with the journal when reports become
 * common: if the median gap falls, lower the constant.
 */
export const STALE_PROGRESS_CALLS = 50

export const STALE_PROGRESS_REMINDER = (calls: number) =>
  `Reminder: ${calls} tool calls since your last lz-report-progress. When convenient, record a short note on what is done and what comes next. Advice only; nothing is blocked.`

type Count = { calls: number; reminded: boolean }

export class ProgressStaleness {
  private readonly sessions = new Map<string, Count>()

  constructor(private readonly threshold = STALE_PROGRESS_CALLS) {}

  /** A tool call finished for this worker. A completed report resets the count. */
  record(sessionID: string, tool: string, completed: boolean): void {
    if (tool === "lz-report-progress" && completed) {
      this.sessions.set(sessionID, { calls: 0, reminded: false })
      return
    }
    const count = this.sessions.get(sessionID) ?? { calls: 0, reminded: false }
    count.calls += 1
    this.sessions.set(sessionID, count)
  }

  /** The reminder for the result being delivered now, once per stale stretch. */
  due(sessionID: string): string | undefined {
    const count = this.sessions.get(sessionID)
    if (!count || count.reminded || count.calls < this.threshold) return undefined
    count.reminded = true
    return STALE_PROGRESS_REMINDER(count.calls)
  }

  forget(sessionID: string): void {
    this.sessions.delete(sessionID)
  }
}

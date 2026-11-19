import type { ExecutionListRow } from "../tasks/execution-list.ts"
import { attemptEnd } from "../tasks/stats.ts"
import { taskExplanation, taskStateView } from "../tasks/task-state.ts"
import type { TaskStateView } from "../tasks/task-state.ts"
import { currentTaskState, isActiveAttemptState } from "./projection.ts"
import type { TrajectoryAttempt, TrajectoryEvent, TrajectoryReport } from "./projection.ts"

const terminalNodes = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])

/** The latest recorded reason a task or plan was held, from the runner's BLOCKED transitions. */
export function holdReason(events: readonly TrajectoryEvent[]) {
  const blocked = events
    .filter((event) => event.kind === "runner-transition" && event.event === "BLOCKED")
    .toSorted((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return blocked.find((event) => event.reason?.trim())?.reason ?? null
}

/**
 * The task row `taskStateView` reads, rebuilt from the report the way Radar rebuilds it from an
 * attempt read: a blocked task, or a blocked plan around a task that is not finished, is held.
 */
export function reportTaskRow(
  report: Pick<TrajectoryReport, "task" | "plans" | "attempts">,
  events: readonly TrajectoryEvent[],
): ExecutionListRow {
  const state = currentTaskState(report)
  const planID = report.attempts.at(-1)?.planID
  const plan = report.plans.find((item) => item.id === planID) ?? report.plans.at(-1)
  const held = state === "blocked" || (plan?.state === "blocked" && !terminalNodes.has(state))
  const reason = held ? holdReason(events) : null
  return {
    taskID: report.task.id,
    title: "",
    status: state,
    reason,
    waiting: held,
    holdReason: reason,
    ordinal: 0,
    contextOnly: false,
    prerequisites: [],
    successors: [],
  }
}

/** The state word, tone and glyph every panel shows for this task, and whether it is working. */
export function reportTaskView(
  report: Pick<TrajectoryReport, "task" | "plans" | "attempts">,
  events: readonly TrajectoryEvent[],
): TaskStateView & { working: boolean } {
  const view = taskStateView(reportTaskRow(report, events))
  return { ...view, working: view.tone === "running" }
}

/** The callout sentence Tasks shows for a waiting, paused, failed or attention state. */
export function taskReason(
  view: Pick<TaskStateView, "tone" | "explained">,
  events: readonly TrajectoryEvent[],
  failure?: string | null,
) {
  const hold = holdReason(events)
  return taskExplanation(view, { hold: hold ? [hold] : [], failure: failure ?? null })
}

/**
 * Recorded attempt duration. An attempt recorded as running reports elapsed time as of capture
 * only while its task is genuinely working; held or interrupted, it stopped at its last activity
 * (`held`), the same rule Tasks and Radar use through `attemptEnd`.
 */
export function attemptDuration(
  attempt: TrajectoryAttempt,
  asOf: number | null,
  held?: { lastActivity: number | null },
) {
  const start = attempt.intervals.attempt.startedAt ?? attempt.startedAt
  const end = attempt.intervals.attempt.endedAt
  if (end !== null && end >= start) return { ms: end - start, open: false }
  if (end !== null || !isActiveAttemptState(attempt.state)) return null
  const working = held === undefined
  const stop = attemptEnd(
    {
      state: attempt.state,
      startedAt: start,
      toolCount: attempt.toolCount.value,
      ...(held?.lastActivity != null
        ? { summary: { ticks: [], lastActivityAt: held.lastActivity } }
        : {}),
    },
    asOf ?? 0,
    working,
  )
  if (stop === undefined || (working && asOf === null) || stop < start) return null
  return { ms: stop - start, open: working }
}

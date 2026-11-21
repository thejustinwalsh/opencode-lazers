import type { ExecutionListRow } from "../tasks/task-row.ts"
import { attemptEnd } from "../tasks/stats.ts"
import { taskExplanation, taskStateView } from "../tasks/task-state.ts"
import type { TaskStateView } from "../tasks/task-state.ts"
import { currentTaskState, isActiveAttemptState } from "./projection.ts"
import type { TrajectoryAttempt, TrajectoryEvent, TrajectoryReport } from "./projection.ts"

const terminalNodes = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])

type TaskReport = Pick<TrajectoryReport, "task" | "plans" | "attempts">

const latestPlan = (report: TaskReport) =>
  report.plans.find((item) => item.id === report.attempts.at(-1)?.planID) ?? report.plans.at(-1)

/**
 * Recorded hold reasons, most specific first: the task's current hold from its stored schedule
 * row, then the latest plan's node and plan reasons (the sources Tasks and Radar read). Stored
 * state only: what the timeline window holds never changes the reason.
 */
export function holdReasons(report: TaskReport) {
  const plan = latestPlan(report)
  return [
    ...new Set(
      [report.task.hold?.reason, plan?.taskReason, plan?.reason].filter(
        (reason): reason is string => Boolean(reason?.trim()),
      ),
    ),
  ]
}

/**
 * The task row `taskStateView` reads. With the stored schedule row's hold, it is that row's
 * (`listRowOf`, as Tasks lists it); otherwise it is rebuilt from the report the way Radar rebuilds
 * it from an attempt read: a blocked task, or a blocked plan around a task that is not finished.
 */
function reportTaskRow(report: TaskReport): ExecutionListRow {
  const state = currentTaskState(report)
  const plan = latestPlan(report)
  const held =
    report.task.hold?.waiting ??
    (state === "blocked" || (plan?.state === "blocked" && !terminalNodes.has(state)))
  const reason = held ? (holdReasons(report)[0] ?? null) : null
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
export function reportTaskView(report: TaskReport): TaskStateView & { working: boolean } {
  const view = taskStateView(reportTaskRow(report))
  return { ...view, working: view.tone === "running" }
}

/** The callout sentence Tasks shows for a waiting, paused, failed or attention state. */
export function taskReason(
  view: Pick<TaskStateView, "tone" | "explained">,
  report: TaskReport,
  failure?: string | null,
) {
  return taskExplanation(view, {
    hold: holdReasons(report),
    failure: latestPlan(report)?.reason ?? failure ?? null,
  })
}

/**
 * The last recorded worker activity of an attempt: what the attempt summary's `lastActivityAt`
 * reads (the newest progress fact). Runner transitions and session messages are not worker
 * activity, so a late interruption record does not stretch the attempt.
 */
export function lastWorkerActivity(events: readonly TrajectoryEvent[], attemptID: string) {
  let last: number | null = null
  for (const event of events) {
    if (event.attemptID !== attemptID || typeof event.at !== "number") continue
    if (event.kind !== "commentary" && !event.kind.startsWith("worker-")) continue
    last = last === null ? event.at : Math.max(last, event.at)
  }
  return last
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

/** What marks an attempt beside its state word: an open concern and an Architect takeover. */
export function attemptSignals(attempt: Pick<TrajectoryAttempt, "concern" | "takeover">) {
  return {
    ...(attempt.concern
      ? {
          concern: {
            line: attempt.concern.line,
            ...(attempt.concern.action
              ? {
                  recommendation: `Recommended: ${attempt.concern.action}${
                    attempt.concern.because ? `. ${attempt.concern.because}` : ""
                  }`,
                }
              : {}),
          },
        }
      : {}),
    ...(attempt.takeover ? { takeover: true as const } : {}),
  }
}

/** `Attempt 2`, or `Architect takeover` when the Architect, not a worker, ran the attempt. */
export function attemptName(attempt: Pick<TrajectoryAttempt, "number" | "takeover">) {
  return attempt.takeover ? "Architect takeover" : `Attempt ${attempt.number}`
}

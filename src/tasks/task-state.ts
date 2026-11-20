import type { LabelTone } from "../details/tone.ts"
import type { CurrentTaskActivity } from "./contract.ts"
import type { ExecutionListRow } from "./task-row.ts"
import { taskReasonView } from "./presentation.ts"
import { taskRowPresentation } from "./row-presentation.ts"
import type { TaskRowPresentation, TaskTone } from "./row-presentation.ts"

/**
 * The one presentation of a task's state: one word, one tone, one glyph. The Tasks bar, callout
 * and list, Radar and Trajectory all read it, so a task is never "Waiting" in one panel and
 * "running" in another. It names what was recorded, with holds and native requests taking
 * precedence over the raw lifecycle (a running task under a hold is Waiting).
 */
export type TaskStateView = TaskRowPresentation & {
  /** The tone as a kit label hue. */
  labelTone: LabelTone
  /** The state asks for an explanation: waiting, paused, failed or needing the person. */
  explained: boolean
  /** The task keeps consuming effort without landing; shown beside the state word. */
  concern?: ExecutionListRow["concern"]
}

const labelTones: Record<TaskTone, LabelTone> = {
  attention: "warning",
  waiting: "warning",
  paused: "warning",
  running: "interactive",
  ready: "interactive",
  scheduled: "interactive",
  submitted: "neutral",
  accepted: "interactive",
  integrated: "success",
  failed: "critical",
  cancelled: "neutral",
}

const explainedTones = new Set<TaskTone>(["attention", "waiting", "paused", "failed"])

export function taskStateView(
  row: ExecutionListRow,
  activity?: Parameters<typeof taskRowPresentation>[1],
  label?: (taskID: string) => string,
): TaskStateView {
  const presentation = taskRowPresentation(row, activity, label)
  return {
    ...presentation,
    labelTone: labelTones[presentation.tone],
    explained: explainedTones.has(presentation.tone),
    ...(row.concern ? { concern: row.concern } : {}),
  }
}

export type TaskExplanationSource = {
  /** Recorded hold reasons, most specific first. */
  hold: readonly string[]
  /** The dispatch pause's reason. */
  pause?: string | null
  /** Why the last attempt or plan failed. */
  failure?: string | null
  activity?: Pick<CurrentTaskActivity, "pendingInput" | "pendingPermissions" | "pendingForms">
}

/**
 * The callout sentence: the real reason in user terms and what happens or what to do next.
 * Nothing for a state that needs no explanation.
 */
export function taskExplanation(
  view: Pick<TaskStateView, "tone" | "explained">,
  source: TaskExplanationSource,
): string | undefined {
  if (!view.explained) return undefined
  const activity = source.activity
  if (view.tone === "attention")
    return activity?.pendingInput
      ? "The worker is waiting for your answer. Reply to it from Radar."
      : "The worker needs your approval to continue. Approve it from Radar."
  if (view.tone === "paused") return taskReasonView(source.pause ?? "", "paused").text
  if (view.tone === "failed") return taskReasonView(source.failure ?? "", "failed").text
  return taskReasonView(source.hold.find((reason) => reason.trim()) ?? "", "waiting").text
}

import type { IconName } from "@opencode/plugin/gui"
import type { CurrentTaskActivity } from "./contract.ts"
import type { ExecutionListRow } from "./execution-list.ts"

/** Visual family of a task row; each tone pairs a state glyph with a theme status color. */
export type TaskTone =
  | "attention"
  | "waiting"
  | "paused"
  | "running"
  | "ready"
  | "scheduled"
  | "submitted"
  | "accepted"
  | "integrated"
  | "failed"
  | "cancelled"

/**
 * Linear-style ring glyphs drawn by Tasks for lifecycle states the host icon set has no circle for.
 * The host `status` glyphs are stacked panels, which read as layout, not state.
 */
export type TaskRingGlyph =
  "ring" | "ring-dot" | "ring-progress" | "ring-dashed" | "ring-pause" | "ring-minus"

/** A host icon where the host has a circled state mark, otherwise a Tasks ring glyph. */
export type TaskGlyph = IconName | TaskRingGlyph

const ringGlyphs = new Set<string>([
  "ring",
  "ring-dot",
  "ring-progress",
  "ring-dashed",
  "ring-pause",
  "ring-minus",
])

export function isRingGlyph(glyph: TaskGlyph): glyph is TaskRingGlyph {
  return ringGlyphs.has(glyph)
}

/** A typed task or plan the row is waiting behind; rows link the first one. */
export type TaskBlocker = { kind: "task" | "plan"; id: string }

export type TaskRowPresentation = {
  tone: TaskTone
  icon: TaskGlyph
  /** One short word naming the state: the icon's accessible name and tooltip lead. */
  label: string
  /** The recorded source reason behind the state, for its tooltip and accessible description. */
  detail: string | null
  /** Waiting-on tasks, plans and reservation holders, in that order, without duplicates. */
  blockers: TaskBlocker[]
  /** Known blocker count, including references the scheduling read did not enumerate. */
  blockerTotal: number
}

type Activity = Pick<
  CurrentTaskActivity,
  "waiting" | "holdReason" | "pendingInput" | "pendingPermissions" | "pendingForms"
>

const terminal = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])

export function distinctReasons(reasons: readonly (string | null | undefined)[]) {
  return [...new Set(reasons.filter((reason): reason is string => Boolean(reason?.trim())))]
}

/** Recorded hold reasons: row/plan first, then the worker observation, then the scheduler. */
export function rowHoldReasons(row: ExecutionListRow, activity?: Activity) {
  return distinctReasons([
    row.waiting ? row.holdReason : null,
    activity?.waiting ? activity.holdReason : null,
    row.scheduling?.decision === "waiting" ? row.scheduling.reason : null,
  ])
}

/** Typed blockers from the topology and the scheduling read; never parsed from reason text. */
export function rowBlockers(row: ExecutionListRow) {
  const tasks = [
    ...new Set([
      ...(row.dependencyTasks ?? [])
        .filter((dependency) => dependency.waiting)
        .map((dependency) => dependency.taskID),
      ...(row.scheduling?.waitingOn ?? []),
      ...(row.scheduling?.reservationTaskIDs ?? []),
    ]),
  ]
  const plans = [...new Set(row.scheduling?.waitingOnPlans ?? [])]
  const enumerated = row.scheduling?.reservationTaskIDs.length ?? 0
  const unlisted = Math.max(0, (row.scheduling?.reservationTaskCount ?? enumerated) - enumerated)
  const unlistedPlans = Math.max(
    0,
    (row.scheduling?.waitingOnPlansCount ?? plans.length) - plans.length,
  )
  const blockers: TaskBlocker[] = [
    ...tasks.map((id) => ({ kind: "task" as const, id })),
    ...plans.map((id) => ({ kind: "plan" as const, id })),
  ]
  return { blockers, blockerTotal: blockers.length + unlisted + unlistedPlans }
}

/** Native attention requests are the only states that ask the person for something now. */
export function attentionLabel(activity?: Activity) {
  return [
    ...(activity?.pendingInput ? ["Input pending"] : []),
    ...((activity?.pendingPermissions ?? 0) > 0 || (activity?.pendingForms ?? 0) > 0
      ? ["Approval pending"]
      : []),
  ].join(" · ")
}

/**
 * Derive the one-line row state from recorded lifecycle, runtime holds, the scheduling read and
 * native attention. Nothing here ranks or schedules work; it only names what was recorded.
 */
export function taskRowPresentation(
  row: ExecutionListRow,
  activity?: Activity,
  label: (taskID: string) => string = (taskID) => taskID.slice(0, 8),
): TaskRowPresentation {
  const status = row.status
  const open = !terminal.has(status)
  const { blockers, blockerTotal } = open ? rowBlockers(row) : { blockers: [], blockerTotal: 0 }
  const state = (
    tone: TaskTone,
    icon: TaskGlyph,
    label: string,
    detail: string | null = null,
  ): TaskRowPresentation => ({ tone, icon, label, detail, blockers, blockerTotal })
  const attention = attentionLabel(activity)
  if (open && attention)
    return state(
      "attention",
      "circle-exclamation",
      activity?.pendingInput ? "Input" : "Approval",
      attention,
    )
  if (row.dispatchPause && ["queued", "ready"].includes(status))
    return state("paused", "ring-pause", "Paused", row.dispatchPause.reason)
  if (
    open &&
    (row.waiting ||
      activity?.waiting ||
      row.scheduling?.decision === "waiting" ||
      status === "blocked")
  ) {
    const reasons = rowHoldReasons(row, activity)
    const pending = (row.dependencyTasks ?? []).filter((dependency) => dependency.waiting)
    const detail = reasons.length
      ? reasons.join("; ")
      : pending.length
        ? `Waiting on ${pending
            .map(
              (dependency) =>
                `${dependency.reference ?? label(dependency.taskID)} (${dependency.state})`,
            )
            .join(", ")}`
        : status === "blocked"
          ? row.reason
          : null
    return state("waiting", "circle-ban-sign", status === "blocked" ? "Blocked" : "Waiting", detail)
  }
  switch (status) {
    case "running":
      return state("running", "ring-progress", "Running")
    case "verifying":
      return state("running", "ring-progress", "Verifying")
    case "ready":
      return state("ready", "ring-dot", "Ready")
    case "queued":
      return state("scheduled", "ring", "Queued")
    case "submitted":
      return state("submitted", "ring-dashed", "Proposed")
    case "accepted":
      return state("accepted", "circle-check", "Accepted", "Accepted; not yet integrated")
    case "incorporated":
      return state("integrated", "circle-check", "Integrated")
    case "failed":
      return state("failed", "circle-x", "Failed", row.reason)
    case "exhausted":
      return state("failed", "circle-x", "Exhausted", row.reason)
    case "cancelled":
      return state("cancelled", "ring-minus", "Cancelled")
    default:
      return state("scheduled", "ring", stateWord(status))
  }
}

function stateWord(status: string) {
  const word = status.split(/[^a-z]/iu).find(Boolean) ?? "Unknown"
  return `${word[0]!.toUpperCase()}${word.slice(1).toLowerCase()}`
}

/**
 * The blocker a row links beside its title, if any. Native attention outranks recorded waits, so an
 * attention row links none; the inspector still lists every reference.
 */
export function taskRowBlocker(presentation: TaskRowPresentation): TaskBlocker | undefined {
  return presentation.tone === "attention" ? undefined : presentation.blockers[0]
}

/** Hover and focus text for the row's state icon: the state word, then its recorded reason. */
export function taskStateTooltip(presentation: TaskRowPresentation) {
  return presentation.detail ? `${presentation.label} · ${presentation.detail}` : presentation.label
}

/** Plan-level lifecycle worth naming beside a plan heading; ordinary running/queued stays quiet. */
export function planStateLabel(state: string | undefined) {
  switch (state) {
    case "blocked":
      return "Blocked"
    case "draft":
      return "Draft"
    case "failed":
      return "Failed"
    case "cancelling":
      return "Cancelling"
    case "cancelled":
      return "Cancelled"
    case "accepted":
      return "Awaiting integration"
    case "integrated":
      return "Integrated"
    case "cleaning":
      return "Cleaning up"
    case "cleanup-blocked":
      return "Cleanup blocked"
    default:
      return null
  }
}

import type { IconName } from "@opencode/plugin/gui"
import type { CurrentTaskActivity } from "./contract.ts"
import type { ExecutionListRow } from "./execution-list.ts"

/** Visual family of a task row; each tone pairs a host icon with an optional short badge. */
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

export type TaskRowPresentation = {
  tone: TaskTone
  icon: IconName
  /** Short visible label. Quiet scheduled and integrated rows carry none. */
  badge: string | null
  /** Complete text behind the badge, for its tooltip and accessible description. */
  badgeDetail: string | null
}

type Activity = Pick<
  CurrentTaskActivity,
  "waiting" | "holdReason" | "pendingInput" | "pendingPermissions" | "pendingForms"
>

const terminal = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])

export function distinctReasons(reasons: readonly (string | null | undefined)[]) {
  return [...new Set(reasons.filter((reason): reason is string => Boolean(reason?.trim())))]
}

/** Recorded runtime hold reasons for a row, row/plan first, then the worker observation. */
export function rowHoldReasons(row: ExecutionListRow, activity?: Activity) {
  return distinctReasons([
    row.waiting ? row.holdReason : null,
    activity?.waiting ? activity.holdReason : null,
  ])
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

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0]!.trim()

/**
 * Derive the one-line row state from recorded lifecycle, runtime holds and native attention.
 * Nothing here ranks or schedules work; it only names what the runtime already recorded.
 */
export function taskRowPresentation(
  row: ExecutionListRow,
  activity?: Activity,
  label: (taskID: string) => string = (taskID) => taskID.slice(0, 8),
): TaskRowPresentation {
  const status = row.status
  const open = !terminal.has(status)
  const attention = attentionLabel(activity)
  if (open && attention)
    return {
      tone: "attention",
      icon: "circle-exclamation",
      badge: activity?.pendingInput ? "Needs input" : "Needs approval",
      badgeDetail: attention,
    }
  if (open && (row.waiting || activity?.waiting)) {
    const pending = (row.dependencyTasks ?? []).filter((dependency) => dependency.waiting)
    if (pending.length) {
      const names = pending.map((dependency) => dependency.reference ?? label(dependency.taskID))
      return {
        tone: "waiting",
        icon: "circle-ban-sign",
        badge: `Waiting on ${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}`,
        badgeDetail: `Waiting on ${pending
          .map((dependency, index) => `${names[index]} (${dependency.state})`)
          .join(", ")}`,
      }
    }
    const reasons = rowHoldReasons(row, activity)
    return {
      tone: "waiting",
      icon: "circle-ban-sign",
      badge: reasons.length ? firstLine(reasons[0]!) : "Blocked",
      badgeDetail: reasons.length ? reasons.join("; ") : null,
    }
  }
  if (row.dispatchPause && ["queued", "ready"].includes(status))
    return {
      tone: "paused",
      icon: "stop",
      badge: "Paused",
      badgeDetail: row.dispatchPause.reason,
    }
  switch (status) {
    case "running":
      return { tone: "running", icon: "status-active", badge: "Running", badgeDetail: null }
    case "verifying":
      return { tone: "running", icon: "status-active", badge: "Verifying", badgeDetail: null }
    case "ready":
      return { tone: "ready", icon: "status", badge: "Ready", badgeDetail: null }
    case "queued":
      return { tone: "scheduled", icon: "status", badge: null, badgeDetail: null }
    case "submitted":
      return { tone: "submitted", icon: "dash", badge: "Not started", badgeDetail: null }
    case "accepted":
      return {
        tone: "accepted",
        icon: "check",
        badge: "Accepted",
        badgeDetail: "Accepted; not yet integrated",
      }
    case "incorporated":
      return { tone: "integrated", icon: "circle-check", badge: null, badgeDetail: null }
    case "failed":
      return { tone: "failed", icon: "circle-x", badge: "Failed", badgeDetail: row.reason }
    case "exhausted":
      return { tone: "failed", icon: "circle-x", badge: "Exhausted", badgeDetail: row.reason }
    case "cancelled":
      return { tone: "cancelled", icon: "minus", badge: null, badgeDetail: null }
    case "blocked":
      return {
        tone: "waiting",
        icon: "circle-ban-sign",
        badge: row.reason ? firstLine(row.reason) : "Blocked",
        badgeDetail: row.reason,
      }
    default:
      return { tone: "scheduled", icon: "status", badge: null, badgeDetail: null }
  }
}

/** Plan-level lifecycle worth naming beside a plan heading; ordinary running/queued stays quiet. */
export function planStateLabel(state: string) {
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

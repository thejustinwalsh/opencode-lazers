/** Display names for runner events whose wording the person would not recognise. */
const names: Readonly<Record<string, string>> = {
  READY: "Ready to run",
  DISPATCH: "Worker dispatched",
  ADMITTED: "Admitted",
  VERIFY: "Checks started",
  ACCEPT: "Accepted",
  BLOCK: "Put on hold",
  BLOCKED: "Put on hold",
  RECONCILE_REQUESTED: "Reconcile requested",
  CANCEL: "Cancelled",
  CANCEL_REQUESTED: "Cancellation requested",
  PLAN_SUBMITTED: "Plan submitted",
  PLAN_ACCEPTED: "Plan accepted",
  PLAN_STEP_FAILED: "Plan step failed",
  WORKER_STARTED: "Worker started",
  WORKER_STOPPED: "Worker stopped",
  WORKER_APPROVAL_WAIT: "Worker waiting for approval",
  WORKER_BACKGROUND_WAIT: "Worker waiting on background work",
  WORKER_BACKGROUND_UNKNOWN: "Worker background work unclear",
  ATTEMPT_RESUMED: "Attempt resumed",
  ARTIFACT_ACCEPTED: "Result accepted",
  DEPENDENCIES_INTEGRATED: "Prerequisites integrated",
  INTEGRATION_RECORDED: "Integration recorded",
  TASK_INTEGRATION_RECORDED: "Integration recorded",
  CONTEXT_RESOLVED: "Context resolved",
  EFFECT_INTENDED: "Action planned",
  EFFECT_COMPLETED: "Action completed",
  OWNER_CONTINUED: "Architect continued",
  OWNER_REASSIGNED: "Architect reassigned",
  CLEANUP_BLOCKED: "Cleanup held",
  CLEANUP_RETRY_SCHEDULED: "Cleanup retry scheduled",
  WORKTREES_RECONCILED: "Worktrees reconciled",
  WORKER_CONCERN_RAISED: "Concern raised",
  TAKEOVER_REQUESTED: "Takeover requested",
  TAKEOVER_NOTICE_DELIVERED: "Notice delivered",
  TAKEOVER_HANDOFF_RECEIVED: "Handoff received",
  TAKEOVER_WORKER_STOPPED: "Worker stopped",
  TAKEOVER_STARTED: "Takeover started",
  TAKEOVER_VERIFY_FAILED: "Takeover check failed",
  TAKEOVER_ABANDONED: "Takeover abandoned",
  TAKEOVER_SUBMITTED: "Takeover submitted",
}

const dropped = new Set(["OUTCOME", "ARCHITECT", "EVENT"])

/**
 * The display name of a runner event. The raw name (`EFFECT_INTENDED`) stays in the row's payload;
 * an event not listed reads as its words in sentence case without the subsystem prefix.
 */
export function eventLabel(event: string) {
  const known = names[event]
  if (known) return known
  const words = event
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
  const kept = words.length > 1 && dropped.has(words[0]!.toUpperCase()) ? words.slice(1) : words
  const text = kept.join(" ")
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : event
}

/**
 * An event payload as the person reads it: JSON indented over lines, so a long payload wraps by
 * field instead of running off as one line. Text that is not JSON reads as it was stored.
 */
export function eventPayloadText(payload: string) {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2)
  } catch {
    return payload
  }
}

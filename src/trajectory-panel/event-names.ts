import type { TrajectoryEvent } from "./projection.ts"

/**
 * Display names for every recorded trajectory event. Raw names (`EFFECT_INTENDED`,
 * `worker-execution-outcome`) are never display text; the pane keeps the raw name in the row's
 * Payload. `test/trajectory-panel/event-names.test.ts` scans the sources and fails when a kind or
 * runner transition has no entry here.
 */

export type EventGroup = "calls" | "checks" | "messages" | "model" | "runner" | "gaps"

/** One entry per event `kind`: its display name and the filter group it belongs to. */
export const eventKinds: Record<string, { name: string; group: EventGroup }> = {
  // Session messages and steps (src/trajectory/read.ts)
  user: { name: "User request", group: "messages" },
  synthetic: { name: "Session input", group: "messages" },
  "assistant-step": { name: "Model step", group: "model" },
  "assistant-text": { name: "Worker message", group: "messages" },
  "assistant-error": { name: "Model error", group: "model" },
  tool: { name: "Tool call", group: "calls" },
  shell: { name: "Shell command", group: "calls" },
  "provider-retry": { name: "Provider retry", group: "model" },
  compaction: { name: "Context compacted", group: "gaps" },
  "session-idle": { name: "Session idle", group: "runner" },
  "model-switched": { name: "Model switched", group: "model" },
  "agent-switched": { name: "Agent switched", group: "model" },
  "location-switched": { name: "Workspace switched", group: "runner" },
  // Runner records
  "runner-transition": { name: "Runner step", group: "runner" },
  "runner-effect": { name: "Runner action", group: "runner" },
  verification: { name: "Check", group: "checks" },
  // Worker progress facts (src/progress/projection.ts)
  commentary: { name: "Worker note", group: "messages" },
  "worker-tool": { name: "Tool call", group: "calls" },
  "worker-visible-text": { name: "Worker message", group: "messages" },
  "worker-step": { name: "Model step", group: "model" },
  "worker-usage-snapshot": { name: "Usage snapshot", group: "model" },
  "worker-provider-retry": { name: "Provider retry", group: "model" },
  "worker-execution-outcome": { name: "Worker outcome", group: "runner" },
  "worker-outcome-snapshot": { name: "Outcome snapshot", group: "runner" },
  "worker-shell": { name: "Shell command", group: "calls" },
  "worker-verification": { name: "Check", group: "checks" },
  "worker-artifact": { name: "Artifact", group: "runner" },
  "worker-gap": { name: "Recording gap", group: "gaps" },
  "worker-reminder": { name: "Reminder", group: "messages" },
  "worker-unknown": { name: "Other worker event", group: "runner" },
}

/** One entry per runner transition event (`runner_transitions.event`). */
export const runnerTransitions: Record<string, string> = {
  ACCEPT: "Accepted",
  ACTIVATE: "Activated",
  ADMITTED: "Admitted",
  ADOPT_ACCEPT: "Adoption accepted",
  ARCHITECT_CONTINUATION_READY: "Architect continuation ready",
  ARCHITECT_CONTINUITY_RECORDED: "Architect continuity recorded",
  ARCHITECT_CONTINUITY_TRANSFERRED: "Architect continuity transferred",
  ARCHITECT_RENEWAL_ARCHIVE_DEFERRED: "Architect renewal archive deferred",
  ARCHITECT_RENEWAL_ARCHIVE_RECONCILED: "Architect renewal archive reconciled",
  ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN: "Architect renewal archive uncertain",
  ARCHITECT_RENEWAL_BLOCKED_STALE_CHECKPOINT: "Architect renewal blocked by a stale checkpoint",
  ARCHITECT_RENEWAL_COMMIT_UNCERTAIN: "Architect renewal commit uncertain",
  ARCHITECT_RENEWAL_COMMITTED: "Architect renewal committed",
  ARCHITECT_RENEWAL_DEFERRED: "Architect renewal deferred",
  ARCHITECT_RENEWAL_NATIVE_INPUT_OBSERVED: "Architect renewal input observed",
  ARCHITECT_RENEWAL_PREPARED: "Architect renewal prepared",
  ARCHITECT_RENEWAL_RECOVERY_FAILED: "Architect renewal recovery failed",
  ARCHITECT_RENEWAL_RETRY_BLOCKED: "Architect renewal retry blocked",
  ARCHITECT_RENEWAL_ROLLED_BACK: "Architect renewal rolled back",
  ARCHITECT_RENEWAL_SOURCE_RESULT_OBSERVED: "Architect renewal source result observed",
  ARCHITECT_RENEWAL_SUCCESSOR_UNAVAILABLE: "Architect renewal successor missing",
  ARCHITECT_RENEWAL_TRANSFERRED: "Architect renewal transferred",
  ARCHITECT_ROUTED: "Routed to Architect",
  ARCHITECT_SOURCE_SCAN_FAILED: "Architect source scan failed",
  ARTIFACT_ACCEPTED: "Artifact accepted",
  ATTEMPT_RESUMED: "Attempt resumed",
  ATTEMPT_STALE_SETTLED: "Stale attempt settled",
  BLOCKED: "Blocked",
  CANCEL: "Cancelled",
  CANCEL_REQUESTED: "Cancel requested",
  CANCEL_WAIT: "Waiting for cancel",
  CANCEL_WAIT_STARTED: "Started waiting for cancel",
  CANCEL_WORKER_ARCHIVED: "Worker session archived",
  CANCEL_WORKER_INTERRUPTED: "Worker interrupted",
  CANCELLATION_CLEANUP_HELD: "Cancel cleanup held",
  CANCELLED_WORKTREES_RECONCILED: "Cancelled worktrees reconciled",
  CLEANUP_BLOCKED: "Cleanup blocked",
  CONTEXT_RESOLVED: "Context resolved",
  DEPENDENCIES_INTEGRATED: "Dependencies integrated",
  DEPENDENCY_CANCELLATION: "Dependency cancelled",
  DEPENDENCY_EDGE_DROPPED: "Dependency dropped",
  DESCENDANT_ADOPTED: "Descendant adopted",
  DESCENDANT_ADOPTION_HELD: "Descendant adoption held",
  DESCENDANT_ADOPTION_REQUESTED: "Descendant adoption requested",
  DISPATCH: "Dispatched",
  DISPATCH_PAUSED: "Dispatch paused",
  DISPATCH_UNPAUSED: "Dispatch resumed",
  EFFECT_COMPLETED: "Action completed",
  EFFECT_INTENDED: "Action started",
  EFFECT_NOT_SENT: "Action not sent",
  EFFECT_SUPERSEDED: "Action superseded",
  FAIL: "Failed",
  FALLOW_UNAVAILABLE: "Code analysis unavailable",
  HOST_ACTIVE_STALE: "Host went stale",
  INTEGRATION_RECORDED: "Integration recorded",
  OUTCOME_DELIVERY_FAILED: "Outcome delivery failed",
  OUTCOME_HOST_DELIVERED: "Outcome delivered to host",
  OUTCOME_INBOX_UNREADABLE: "Outcome inbox unreadable",
  OUTCOME_NO_ARCHITECT: "Outcome not delivered, no Architect",
  OUTCOME_OLD_INBOX_UNREADABLE: "Earlier outcome inbox unreadable",
  OUTCOME_SUPERSEDED: "Outcome superseded",
  OWNER_ADOPTED: "Owner adopted",
  OWNER_CONTINUATION_ROLLED_BACK: "Owner continuation rolled back",
  OWNER_CONTINUED: "Owner continued",
  OWNER_REASSIGNED: "Owner reassigned",
  PAUSE: "Paused",
  PLAN_ACCEPTED: "Plan accepted",
  PLAN_GATE_RETIRED: "Plan gate retired",
  PLAN_STEP_SLOW: "Plan step slow",
  PLAN_SUBMITTED: "Plan submitted",
  PREPARE: "Preparing",
  PROMPT_NOT_DISPATCHED: "Prompt not sent",
  QUEUE_REVIEW_REQUESTED: "Queue review requested",
  READY: "Ready",
  RECONCILE: "Reconciled",
  RECONCILE_REQUESTED: "Reconcile requested",
  REPAIR: "Repair",
  RESUME: "Resumed",
  RETAINED_ACCEPT: "Retained result accepted",
  RETAINED_CANDIDATE_ACCEPTED: "Retained candidate accepted",
  RETAINED_REPAIR: "Retained repair",
  RETAINED_REPAIR_REQUESTED: "Retained repair requested",
  RETAINED_TASK_CANDIDATE_ACCEPTED: "Retained task candidate accepted",
  RETAINED_VERIFICATION_CANCELLED: "Retained check cancelled",
  RETAINED_VERIFICATION_CHECK_COMPLETED: "Retained check completed",
  RETAINED_VERIFICATION_CHECK_RESOURCES_UNCERTAIN: "Retained check resources uncertain",
  RETAINED_VERIFICATION_CONTEXT_CLEANED: "Retained check context cleaned",
  RETAINED_VERIFICATION_CONTEXT_CLEANUP_FAILED: "Retained check context cleanup failed",
  RETAINED_VERIFICATION_FAILED: "Retained check failed",
  RETAINED_VERIFICATION_REQUESTED: "Retained check requested",
  RETAINED_VERIFICATION_RETIRED: "Retained check retired",
  RETAINED_VERIFICATION_SETUP_CLEANED: "Retained check setup cleaned",
  RETAINED_VERIFICATION_SETUP_CLEANUP_FAILED: "Retained check setup cleanup failed",
  RETAINED_VERIFICATION_TERMINAL_CLEANUP_COMPLETED: "Retained check cleanup completed",
  RETAINED_VERIFICATION_TERMINAL_CLEANUP_PENDING: "Retained check cleanup pending",
  RETAINED_VERIFICATION_WORKSPACE_CLEANED: "Retained check workspace cleaned",
  RETAINED_VERIFICATION_WORKSPACE_CLEANUP_FAILED: "Retained check workspace cleanup failed",
  RETAINED_VERIFICATION_WORKSPACE_OWNED: "Retained check workspace claimed",
  RETAINED_VERIFICATION_WORKSPACE_REMOVAL_INTENDED: "Retained check workspace removal started",
  RETAINED_VERIFICATION_WORKSPACE_RESERVED: "Retained check workspace reserved",
  RETIRE: "Retired",
  RETRY: "Retry",
  RETRY_REQUESTED: "Retry requested",
  SCHEDULE_UPDATED: "Schedule updated",
  SCOPE_AMENDED: "Scope amended",
  SCOPE_DECISION_REQUIRED: "Scope decision needed",
  SCOPE_OVERLAP_WARNING: "Scope overlap warning",
  STARTUP_RECOVERY_AUTHORIZED: "Startup recovery authorized",
  STARTUP_RECOVERY_OPERATION_RESUMED: "Startup recovery resumed",
  STARTUP_RECOVERY_WORKTREE_READY: "Startup recovery worktree ready",
  TASK_INTEGRATION_RECORDED: "Task integration recorded",
  UNPAUSE: "Resumed",
  UNSTARTED_BASELINE_SELECTED: "Baseline selected",
  UNSTARTED_TASK_REQUEUED: "Task requeued",
  VERIFICATION_CANCELLATION_UNCERTAIN: "Check cancellation uncertain",
  VERIFICATION_DEADLINE_EXTENDED: "Check deadline extended",
  VERIFICATION_RESUMED: "Checks resumed",
  VERIFY: "Checking",
  WORKER_APPROVAL_WAIT: "Worker waiting for approval",
  WORKER_AUTO_RESUMED: "Worker resumed automatically",
  WORKER_BACKGROUND_WAIT: "Worker waiting on background work",
  WORKER_CANCEL_WITHOUT_IDLE: "Worker cancelled while busy",
  WORKER_NO_PROGRESS_INTERRUPT: "Worker interrupted, no progress",
  WORKER_OBSERVATION_SETTLED: "Worker observation settled",
  WORKER_REVIEW_INPUT_RECONCILED: "Worker review input reconciled",
  WORKER_SESSION_ABSENT: "Worker session missing",
  WORKER_STARTED: "Worker started",
  WORKER_STOPPED: "Worker stopped",
  WORKSPACE_SELECTED: "Workspace selected",
  WORKTREE_RECOVERY_RESUMED: "Worktree recovery resumed",
  WORKTREE_STARTUP_FAILURE_SETTLED_ABSENT: "Worktree startup failure settled",
  WORKTREES_RECONCILED: "Worktrees reconciled",
}

const capitalize = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text)

/** `worker-gap`, `EFFECT_X`, `verify:lint` as words, for a name this build has no entry for. */
export function humanize(name: string) {
  return capitalize(
    name
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_:\-./]+/g, " ")
      .trim()
      .toLowerCase(),
  )
}

export function transitionName(event: string | undefined) {
  if (!event) return eventKinds["runner-transition"]!.name
  return runnerTransitions[event] ?? humanize(event)
}

/** Replaces runtime tokens inside a free-text reason with their display names. */
export function translateRuntimeWords(text: string) {
  return text.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (token) =>
    (runnerTransitions[token] ?? humanize(token)).toLowerCase(),
  )
}

/** The status words recorded on calls, as lower-case display text. */
const statusWord = (status: string | null | undefined) =>
  status ? status.replace(/[_-]+/g, " ").toLowerCase() : ""

/** The row title: a display name, never the recorded kind or event name. */
export function eventLabel(event: TrajectoryEvent) {
  const join = (...parts: Array<string | undefined | null>) => parts.filter(Boolean).join(" · ")
  switch (event.kind) {
    case "runner-transition":
      return transitionName(event.event)
    case "runner-effect":
      return join(humanize(event.effect ?? "runner action"), statusWord(event.state))
    case "tool":
    case "worker-tool":
      return join(event.tool ?? eventKinds[event.kind]!.name, statusWord(event.status))
    case "shell":
    case "worker-shell":
      return join(eventKinds[event.kind]!.name, statusWord(event.status))
    case "verification":
    case "worker-verification":
      return join(event.checkID ? `Check ${event.checkID}` : "Check", statusWord(event.status))
    case "worker-step":
    case "assistant-step":
      return join(eventKinds[event.kind]!.name, statusWord(event.status))
    default:
      return eventKinds[event.kind]?.name ?? humanize(event.kind)
  }
}

export function eventGroup(event: TrajectoryEvent): EventGroup {
  return eventKinds[event.kind]?.group ?? "runner"
}

const FAILED_STATUS = new Set(["failed", "error", "errored", "timed-out", "timeout"])

/** Failures, provider retries, model errors and recording gaps: what the Errors filter keeps. */
export function eventIsError(event: TrajectoryEvent) {
  if (
    event.kind === "assistant-error" ||
    event.kind === "provider-retry" ||
    event.kind === "worker-provider-retry" ||
    event.kind === "worker-gap"
  )
    return true
  if (event.status && FAILED_STATUS.has(event.status.toLowerCase())) return true
  if (event.kind === "verification" || event.kind === "worker-verification")
    return event.status === "failed"
  const code = event.exit ?? event.exitCode
  if (typeof code === "number" && code !== 0) return true
  return event.error !== undefined && event.error !== null
}

export type EventFilter = "all" | "calls" | "checks" | "messages" | "model" | "runner" | "errors"

export const eventFilters: ReadonlyArray<{ id: EventFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "calls", label: "Calls" },
  { id: "checks", label: "Checks" },
  { id: "messages", label: "Messages" },
  { id: "model", label: "Model" },
  { id: "runner", label: "Runner" },
  { id: "errors", label: "Errors" },
]

export function eventMatchesFilter(event: TrajectoryEvent, filter: EventFilter) {
  if (filter === "all") return true
  if (filter === "errors") return eventIsError(event)
  const group = eventGroup(event)
  return filter === "runner" ? group === "runner" || group === "gaps" : group === filter
}

import { FallowAcceptance } from "../audit/contract.ts"
import { findingLine, renderNotice } from "../audit/fallow-render.ts"
import { ScopeReport, scopeNotice } from "./scope.ts"
import { RECOVERY_BUNDLE_STATUS, recoveryBundleText } from "./recovery-bundle.ts"

/** Human action beside durable machine identity, without replaying full check logs. */
export function outcomeText(serialized: string, project?: string) {
  const payload = JSON.parse(serialized)
  let action: string
  switch (payload.status) {
    case RECOVERY_BUNDLE_STATUS:
      return recoveryBundleText(serialized)
    case "architect-handoff": {
      const planIDs = Array.isArray(payload.planIDs)
        ? payload.planIDs.filter((id: unknown): id is string => typeof id === "string")
        : [payload.planID].filter((id: unknown): id is string => typeof id === "string")
      const continuity =
        typeof payload.continuity === "object" && payload.continuity !== null
          ? (payload.continuity as Record<string, unknown>)
          : {}
      const decisions = Array.isArray(continuity.decisions)
        ? continuity.decisions.filter((item: unknown): item is string => typeof item === "string")
        : []
      const unresolvedQuestions = Array.isArray(continuity.unresolvedQuestions)
        ? continuity.unresolvedQuestions.filter(
            (item: unknown): item is string => typeof item === "string",
          )
        : []
      const coverage =
        typeof payload.sourceCoverage === "object" && payload.sourceCoverage !== null
          ? (payload.sourceCoverage as Record<string, unknown>)
          : {}
      return [
        "LAZERS Architect continuity handoff",
        `Purpose: ${typeof payload.label === "string" ? payload.label : "Continue the existing project work"}`,
        `Predecessor: ${String(payload.predecessorSessionID ?? "unknown")} (archived; linked as parent).`,
        `Plan IDs: ${planIDs.join(", ") || "none recorded"}.`,
        `Predecessor input-history scan: ${coverage.complete === true ? "complete for the recorded pass" : `continuing at cursor ${String(coverage.cursor ?? "unknown")}`}; later scans remain required.`,
        "Native input IDs, dispositions and assistant-result changes remain in the durable predecessor source journal. Page the metadata journal and explicitly fetch selected original messages when needed.",
        ...(decisions.length
          ? ["Recorded decisions:", ...decisions.map((item) => `- ${item}`)]
          : ["Recorded decisions: none."]),
        ...(unresolvedQuestions.length
          ? ["Unresolved questions:", ...unresolvedQuestions.map((item) => `- ${item}`)]
          : ["Unresolved questions: none."]),
        "No prior transcript was replayed. Fetch current durable state with lz-inspect-plan for these IDs and review the current outcomes before deciding.",
        "Existing workers continue unchanged; do not restart them.",
      ].join("\n")
    }
    case "task-accepted":
      action =
        "Review the accepted task artifact now. For a concrete defect in an unintegrated isolated artifact, use retained-repair with the latest attempt, exact artifact and defect reason; it continues the same worker and re-verifies. Otherwise integrate the reviewed result through runtime commands and continue the existing backlog. Do not disturb unrelated active workers."
      break
    case "accepted":
      action =
        "Review and merge the accepted combined artifact before starting new work. If it is already in the target branch, record integration against that branch now. Verify native cleanup and continue the queue."
      break
    case "dispatch-resumed":
    case "dependency-resolved":
      action =
        "The recorded wait has cleared. Continue the existing plan; running workers and retained work are unchanged."
      break
    case "queue-review":
      action =
        "Unblock the queue now. Inspect the listed plans with lz-inspect-plan, act through lz-plan-command, and verify eligible work can start. Own sequencing, parallelism, and retries. If stuck, use the native question tool to state the blocker and next action and ask for the human input needed."
      break
    case "blocked":
      action =
        "Unblock this plan now. Verify the cause with lz-inspect-plan, reconcile uncertain effects, and apply an allowed lz-plan-command. Confirm work can proceed. If stuck, use the native question tool to state the blocker and next action and ask for the human input needed."
      break
    case "retained-verification-failed":
      action =
        "The retained verification did not pass; its reason is in the notice. Inspect the operation and its receipts with lz-inspect-plan, fix the cause (retained-repair for a defect in the candidate, or a corrected check or environment), then run verify-retained again on the commit. Nothing is waiting on the failed call. If stuck, use the native question tool to state the blocker and next action and ask for the human input needed."
      break
    case "cleanup-blocked":
      action =
        "Cleanup retries on its own when the observed facts change (a running shell ends, the worker goes idle, the worktree becomes clean or its commits are contained in the checkout). To act now: commit or discard uncommitted work in the held worktree, merge its unmerged commits, then re-record integration with integrated at the current plan version, or cancel the plan. Use the native question tool when a decision requires human input."
      break
    case "cancelled":
      action =
        "Review the cancelled plan and retained work; decide whether to leave it stopped or explicitly resume/retry through runtime commands. Do not redispatch cancelled work automatically."
      break
    default:
      action = "Recorded runtime update; no automatic action is requested."
  }
  if (payload.status === "task-accepted" && payload.fallow) action += fallowNotice(payload.fallow)
  if (payload.status === "task-accepted" && payload.scope) {
    const scope = ScopeReport.safeParse(payload.scope)
    if (scope.success) action += scopeNotice(scope.data)
  }
  if (payload.status === "accepted" && payload.fallow) action += planFallowNotice(payload.fallow)
  const evidence = Array.isArray(payload.evidence)
    ? payload.evidence.map((check: unknown) =>
        typeof check === "object" && check !== null && "id" in check ? check.id : check,
      )
    : payload.evidence
  return `LAZERS outcome${project ? ` · ${project}` : ""}\n${action}\n${JSON.stringify({ ...payload, ...(evidence ? { evidence } : {}) })}`
}

/**
 * One notice for everything pending on an Architect session: the latest outcome
 * of each plan, never one message per change.
 */
export function coalescedOutcomeText(
  entries: ReadonlyArray<{ planID: string; payload: string }>,
  project?: string,
) {
  if (entries.length === 1) return outcomeText(entries[0]!.payload, project)
  const plans = new Set(entries.map((entry) => entry.planID)).size
  return [
    `LAZERS outcomes${project ? ` · ${project}` : ""}: ${entries.length} updates across ${plans} ${plans === 1 ? "plan" : "plans"}, the latest state of each`,
    ...entries.map(
      (entry) => `--- plan ${entry.planID} ---\n${outcomeText(entry.payload, project)}`,
    ),
  ].join("\n\n")
}

/** Remaining Fallow findings of an accepted task and what the repair did, from the typed package. */
function fallowNotice(fallow: unknown): string {
  const parsed = FallowAcceptance.safeParse(fallow)
  return parsed.success ? `\n${renderNotice(parsed.data.package, parsed.data.dispositions)}` : ""
}

/** The task(s) a plan-level finding is attributed to, for the Architect to send it back to. */
function taskReference(item: { taskID?: unknown; taskIDs?: unknown }): string {
  const ids = Array.isArray(item.taskIDs)
    ? item.taskIDs.filter((id): id is string => typeof id === "string")
    : typeof item.taskID === "string"
      ? [item.taskID]
      : []
  return ids.length ? ` (${ids.length > 1 ? "tasks" : "task"} ${ids.join(", ")})` : ""
}

/** Findings only the combined plan shows, such as two tasks that each added the same helper. */
function planFallowNotice(fallow: unknown): string {
  const parsed = FallowAcceptance.safeParse(fallow)
  if (!parsed.success) return ""
  const live = parsed.data.package.findings.filter((f) => f.attribution !== "inherited")
  if (!live.length) return ""
  const lines = live
    .slice(0, 10)
    .map((item) => `- ${item.severity} ${findingLine(item)}${taskReference(item)}`)
  return `\nFallow audit of the combined plan, verdict ${parsed.data.package.verdict} (${live.length} findings):\n${lines.join("\n")}\nThe plan is accepted. Send a finding back to the named task, submit a cleanup task, or accept it.`
}

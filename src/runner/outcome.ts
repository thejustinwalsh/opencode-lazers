/** Human action beside durable machine identity, without replaying full check logs. */
export function outcomeText(serialized: string) {
  const payload = JSON.parse(serialized)
  let action: string
  switch (payload.status) {
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
  const evidence = Array.isArray(payload.evidence)
    ? payload.evidence.map((check: unknown) =>
        typeof check === "object" && check !== null && "id" in check ? check.id : check,
      )
    : payload.evidence
  return `LAZERS outcome\n${action}\n${JSON.stringify({ ...payload, ...(evidence ? { evidence } : {}) })}`
}

/**
 * One notice for everything pending on an Architect session: the latest outcome
 * of each plan, never one message per change.
 */
export function coalescedOutcomeText(entries: ReadonlyArray<{ planID: string; payload: string }>) {
  if (entries.length === 1) return outcomeText(entries[0]!.payload)
  const plans = new Set(entries.map((entry) => entry.planID)).size
  return [
    `LAZERS outcomes: ${entries.length} updates across ${plans} ${plans === 1 ? "plan" : "plans"}, the latest state of each`,
    ...entries.map((entry) => `--- plan ${entry.planID} ---\n${outcomeText(entry.payload)}`),
  ].join("\n\n")
}

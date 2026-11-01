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
      return [
        "LAZERS Architect continuity handoff",
        `Purpose: ${typeof payload.label === "string" ? payload.label : "Continue the existing project work"}`,
        `Predecessor: ${String(payload.predecessorSessionID ?? "unknown")} (archived; linked as parent).`,
        `Plan IDs: ${planIDs.join(", ") || "none recorded"}.`,
        ...(decisions.length
          ? ["Recorded decisions:", ...decisions.map((item) => `- ${item}`)]
          : ["Recorded decisions: none."]),
        ...(unresolvedQuestions.length
          ? ["Unresolved questions:", ...unresolvedQuestions.map((item) => `- ${item}`)]
          : ["Unresolved questions: none."]),
        "No prior transcript was replayed. Fetch current durable state with lazers_inspect_plan for these IDs and review the current outcomes before deciding.",
        "Existing workers continue unchanged; do not restart them.",
      ].join("\n")
    }
    case "task-accepted":
      action =
        "Review the accepted task artifact now; repair defects, integrate the reviewed result through runtime commands, and continue the existing backlog. Do not wait for plan finalization or disturb active workers."
      break
    case "accepted":
      action =
        "Review and merge the accepted combined artifact, then record integration through runtime commands and verify native non-forced cleanup. Continue existing work; acceptance alone is not integration."
      break
    case "blocked":
      action =
        "Inspect this blocked plan and resolve the recorded cause using its allowed actions. Preserve work and reconcile uncertain effects before retrying."
      break
    case "cleanup-blocked":
      action =
        "Resolve the native cleanup failure without force or loss of dirty/unmerged work, then retry the existing integration command with the current plan version."
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

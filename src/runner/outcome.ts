const escalateBlocker =
  "If you still cannot unblock work, use the native question tool before ending your turn. State the exact blocker and next action, then ask for the specific human decision or action needed to proceed. Handle sequencing, parallelism, and retries yourself."

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
        "Native input IDs, dispositions and assistant-result changes remain in the durable predecessor source journal. Compact source-change pointers are delivered separately; page the metadata journal and explicitly fetch selected original messages when needed.",
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
    case "architect-source-reference": {
      const inputs = Array.isArray(payload.inputIDs) ? payload.inputIDs : []
      const results = Array.isArray(payload.results) ? payload.results : []
      const references = inputs.flatMap((input: unknown) => {
        if (typeof input !== "object" || input === null) return []
        const row = input as { id?: unknown; disposition?: unknown; type?: unknown }
        if (typeof row.id !== "string") return []
        return [
          `- ${row.id}: ${String(row.disposition ?? "unknown")} ${String(row.type ?? "input")}`,
        ]
      })
      const resultReferences = results.flatMap((result: unknown) => {
        if (typeof result !== "object" || result === null) return []
        const row = result as {
          id?: unknown
          revision?: unknown
          state?: unknown
          finish?: unknown
          toolCounts?: unknown
        }
        if (typeof row.id !== "string" || typeof row.revision !== "number") return []
        const counts =
          typeof row.toolCounts === "object" && row.toolCounts !== null
            ? (row.toolCounts as Record<string, unknown>)
            : {}
        return [
          `- assistant result ${row.id} revision ${row.revision}: ${String(row.state ?? "unknown")}; finish ${String(row.finish ?? "unknown")}; tools running/completed/failed/other ${String(counts.running ?? 0)}/${String(counts.completed ?? 0)}/${String(counts.failed ?? 0)}/${String(counts.other ?? 0)}`,
        ]
      })
      return [
        "LAZERS retained Architect input update",
        `Source session: ${String(payload.sourceSessionID ?? "unknown")} (reconciliation revision ${String(payload.sourceRevision ?? "unknown")}).`,
        "Original native inputs remain on the predecessor. These references do not authorize execution, replay, cancellation, permission grants, or answering forms.",
        ...(references.length ? references : ["- No input IDs in this update."]),
        ...resultReferences,
        "Inspect current durable plan state and the original source session before deciding what to do.",
      ].join("\n")
    }
    case "architect-source-change":
      return [
        "LAZERS Architect source changed",
        `Source session: ${String(payload.sourceSessionID ?? "unknown")} (journal revision ${String(payload.sourceRevision ?? "unknown")}).`,
        "The durable source journal is progressively inspectable with lz-inspect-plan view='journal'. It contains metadata and original message IDs, not transcript bodies or proof of completeness/consumption.",
        "Use the authenticated selected-message view only for relevant user/synthetic inputs or assistant results. Pending, steering and unknown input dispositions remain blockers; this notice does not replay input or authorize execution.",
        "Existing workers continue unchanged.",
      ].join("\n")
    case "task-accepted":
      action =
        "Review the accepted task artifact now. For a concrete defect in an unintegrated isolated artifact, use retained-repair with the latest attempt, exact artifact and defect reason; it continues the same worker and re-verifies. Otherwise integrate the reviewed result through runtime commands and continue the existing backlog. Do not disturb unrelated active workers."
      break
    case "accepted":
      action =
        "Review and merge the accepted combined artifact, then record integration through runtime commands and verify native non-forced cleanup. Continue existing work; acceptance alone is not integration."
      break
    case "dispatch-resumed":
    case "dependency-resolved":
      action =
        "The recorded wait has cleared. Continue the existing plan; running workers and retained work are unchanged."
      break
    case "queue-review":
      action =
        "Unblock the project queue in this turn. Use lz-inspect-plan to find the first actionable blocker in the listed plans, then use lz-plan-command to resolve it and confirm eligible work can proceed. Decide sequencing, parallelism and retries yourself. " +
        escalateBlocker
      break
    case "blocked":
      action =
        "Unblock this plan in this turn. Use lz-inspect-plan to verify the recorded cause, then apply the appropriate allowed action through lz-plan-command. Reconcile uncertain effects before retrying. Confirm that work can proceed. " +
        escalateBlocker
      break
    case "cleanup-blocked":
      action =
        "Resolve the native cleanup failure without force or loss of dirty/unmerged work, then retry the existing integration command with the current plan version. " +
        escalateBlocker
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

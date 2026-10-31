/** Human action beside durable machine identity, without replaying full check logs. */
export function outcomeText(serialized: string) {
  const payload = JSON.parse(serialized)
  let action: string
  switch (payload.status) {
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

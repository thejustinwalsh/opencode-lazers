export type PrerequisiteIntegrationRow = {
  plan_id: string
  project_directory: string
  state: string
  artifact: string | null
  accepted_id: number | null
  accepted_version: number | null
  accepted_payload: string | null
  integration_id: number | null
  integration_version: number | null
  integration_payload: string | null
  invalidation_id: number | null
}

const isCommitID = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** One decision's durable evidence and unchanged Git proof; never cached across decisions. */
export function evaluatePrerequisiteIntegration(
  directory: string,
  prerequisites: readonly string[],
  rows: readonly PrerequisiteIntegrationRow[],
  git: (directory: string, args: string[]) => string,
  candidateBaseline?: string,
): string | undefined {
  if (
    !prerequisites.length ||
    new Set(prerequisites).size !== prerequisites.length ||
    rows.length !== prerequisites.length
  )
    return undefined
  const proof: Array<{ artifact: string; head: string }> = []
  for (const row of rows) {
    if (
      !prerequisites.includes(row.plan_id) ||
      row.project_directory !== directory ||
      !["cleaning", "cleanup-blocked", "integrated"].includes(row.state) ||
      !isCommitID(row.artifact) ||
      !Number.isSafeInteger(row.accepted_id) ||
      !Number.isSafeInteger(row.accepted_version) ||
      !Number.isSafeInteger(row.integration_id) ||
      !Number.isSafeInteger(row.integration_version) ||
      row.accepted_id === null ||
      row.accepted_version === null ||
      row.integration_id === null ||
      row.integration_version === null ||
      row.accepted_id >= row.integration_id ||
      row.integration_version < row.accepted_version ||
      (row.invalidation_id !== null &&
        (!Number.isSafeInteger(row.invalidation_id) || row.accepted_id <= row.invalidation_id))
    )
      return undefined

    let accepted: unknown
    let integration: unknown
    try {
      accepted = JSON.parse(row.accepted_payload ?? "") as unknown
      integration = JSON.parse(row.integration_payload ?? "") as unknown
    } catch {
      return undefined
    }
    if (!isRecord(accepted) || !isRecord(integration)) return undefined
    if (
      accepted.artifact !== row.artifact ||
      integration.artifact !== row.artifact ||
      typeof integration.branch !== "string" ||
      !integration.branch.trim() ||
      typeof integration.reason !== "string" ||
      !integration.reason.trim() ||
      !isCommitID(integration.head)
    )
      return undefined

    proof.push({ artifact: row.artifact, head: integration.head })
  }
  let baseline: string
  try {
    baseline = candidateBaseline ?? git(directory, ["rev-parse", "HEAD"])
    if (git(directory, ["rev-parse", `${baseline}^{commit}`]) !== baseline) return undefined
  } catch {
    return undefined
  }
  if (!isCommitID(baseline)) return undefined

  for (const row of proof) {
    try {
      git(directory, ["merge-base", "--is-ancestor", row.artifact, row.head])
      git(directory, ["merge-base", "--is-ancestor", row.head, baseline])
      git(directory, ["merge-base", "--is-ancestor", row.artifact, baseline])
    } catch {
      return undefined
    }
  }
  return baseline
}

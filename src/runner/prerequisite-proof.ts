import type { ChangeEvidence } from "./change-identity.ts"
import { containmentReason, evidenceContained } from "./integration-proof.ts"

export type PrerequisiteIntegrationRow = {
  plan_id: string
  project_directory: string
  state: string
  reason?: string | null
  artifact: string | null
  accepted_id: number | null
  accepted_version: number | null
  accepted_payload: string | null
  integration_id: number | null
  integration_version: number | null
  integration_payload: string | null
  invalidation_id: number | null
}

export type TaskPrerequisiteIntegrationRow = {
  plan_id: string
  task_id: string
  project_directory: string
  node_state: string
  artifact: string | null
  integration_id: number | null
  integration_payload: string | null
}

export type IntegrationDecision =
  | { status: "ready"; baseline: string }
  | { status: "waiting"; reason: string }
  | { status: "unknown"; reason: string }

export function prerequisitePlanAction(state: string) {
  if (state === "cancelling" || state === "cancelled")
    return "The runtime drops this cancelled edge and notifies the Architect; dependent work can continue. Cancelled workers are never restarted automatically."
  if (state === "accepted")
    return "The current Architect must integrate this accepted source before dependent work can continue."
  if (["blocked", "failed", "exhausted"].includes(state))
    return "The current Architect must resolve or replan this prerequisite; failed work is not restarted automatically."
  return "The prerequisite must complete and its source be integrated before dependent work can continue."
}

/** Stored change identity for an artifact SHA (tree, patch-id, change id, base tree), if any. */
export type ArtifactEvidenceLookup = (
  artifact: string,
) => (ChangeEvidence & { baseTree?: string | null }) | undefined

type Git = (directory: string, args: string[]) => Promise<string>

const isCommitID = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Is the change an artifact recorded still in the baseline? Exact ancestry is
 * the cheap first check; otherwise the change identity decides (note, patch-id,
 * tree). The recorded integration head is an observation and not re-validated.
 */
async function artifactIntegrated(
  directory: string,
  git: Git,
  artifact: string,
  baseline: string,
  lookup: ArtifactEvidenceLookup | undefined,
) {
  try {
    await git(directory, ["merge-base", "--is-ancestor", artifact, baseline])
    return { status: "contained" as const, via: "ancestor" as const }
  } catch {
    // Ancestry failed or the commit vanished: decide by change identity.
  }
  return evidenceContained(directory, { ...lookup?.(artifact), commit: artifact }, baseline)
}

async function resolveBaseline(directory: string, git: Git, candidate: string | undefined) {
  const baseline = candidate ?? (await git(directory, ["rev-parse", "HEAD"]))
  if ((await git(directory, ["rev-parse", `${baseline}^{commit}`])) !== baseline) return undefined
  return isCommitID(baseline) ? baseline : undefined
}

/** One decision's durable evidence and fresh Git proof; never cached across decisions. */
export async function evaluatePrerequisiteIntegration(
  directory: string,
  prerequisites: readonly string[],
  rows: readonly PrerequisiteIntegrationRow[],
  git: Git,
  candidateBaseline?: string,
  lookup?: ArtifactEvidenceLookup,
  onUnproven?: (reason: string) => void,
): Promise<string | undefined> {
  if (
    !prerequisites.length ||
    new Set(prerequisites).size !== prerequisites.length ||
    rows.length !== prerequisites.length
  )
    return undefined
  const proof: Array<{ planID: string; artifact: string }> = []
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

    proof.push({ planID: row.plan_id, artifact: row.artifact })
  }
  let baseline: string | undefined
  try {
    baseline = await resolveBaseline(directory, git, candidateBaseline)
  } catch {
    return undefined
  }
  if (!baseline) return undefined

  for (const row of proof) {
    const result = await artifactIntegrated(directory, git, row.artifact, baseline, lookup)
    if (result.status !== "contained") {
      onUnproven?.(
        containmentReason(result, `Plan ${row.planID.slice(0, 8)} source`, "the selected checkout"),
      )
      return undefined
    }
  }
  return baseline
}

/** Fresh task-level source proof; unlike plan prerequisites this does not require cleanup. */
export async function evaluateTaskPrerequisiteIntegration(
  directory: string,
  branch: string,
  prerequisites: readonly string[],
  rows: readonly TaskPrerequisiteIntegrationRow[],
  git: Git,
  candidateBaseline?: string,
  lookup?: ArtifactEvidenceLookup,
): Promise<IntegrationDecision> {
  if (!prerequisites.length || new Set(prerequisites).size !== prerequisites.length)
    return { status: "waiting", reason: "Task dependencies are incomplete." }
  if (rows.length !== prerequisites.length)
    return { status: "waiting", reason: "A prerequisite task source has not been integrated." }

  const proof: Array<{ taskID: string; artifact: string }> = []
  for (const row of rows) {
    if (
      !prerequisites.includes(row.task_id) ||
      row.project_directory !== directory ||
      row.node_state !== "accepted" ||
      !isCommitID(row.artifact) ||
      !Number.isSafeInteger(row.integration_id) ||
      row.integration_id === null
    )
      return { status: "waiting", reason: "A prerequisite task source has not been integrated." }

    let payload: unknown
    try {
      payload = JSON.parse(row.integration_payload ?? "") as unknown
    } catch {
      return { status: "waiting", reason: "A prerequisite task integration receipt is invalid." }
    }
    if (
      !isRecord(payload) ||
      payload.artifact !== row.artifact ||
      typeof payload.branch !== "string" ||
      payload.branch.trim() !== branch ||
      !isCommitID(payload.head)
    )
      return {
        status: "waiting",
        reason: "A prerequisite task integration receipt does not match its source.",
      }
    proof.push({ taskID: row.task_id, artifact: row.artifact })
  }

  let baseline: string | undefined
  try {
    baseline = await resolveBaseline(directory, git, candidateBaseline)
  } catch {
    return { status: "unknown", reason: "The selected checkout ancestry could not be read." }
  }
  if (!baseline)
    return {
      status: "waiting",
      reason: "The selected checkout is not a valid integrated baseline.",
    }

  for (const row of proof) {
    const result = await artifactIntegrated(directory, git, row.artifact, baseline, lookup)
    if (result.status !== "contained")
      return {
        status: "waiting",
        reason:
          result.status === "ambiguous"
            ? containmentReason(
                result,
                `Task ${row.taskID.slice(0, 8)} source`,
                "the selected checkout",
              )
            : `Task ${row.taskID.slice(0, 8)} source is not present in the selected checkout.`,
      }
  }
  return { status: "ready", baseline }
}

/** Compatibility names for the read projection, which was the first async caller. */
export const evaluatePrerequisiteIntegrationAsync = evaluatePrerequisiteIntegration
export const evaluateTaskPrerequisiteIntegrationAsync = evaluateTaskPrerequisiteIntegration

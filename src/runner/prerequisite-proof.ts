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

/** Fresh task-level source proof; unlike plan prerequisites this does not require cleanup. */
export function evaluateTaskPrerequisiteIntegration(
  directory: string,
  branch: string,
  prerequisites: readonly string[],
  rows: readonly TaskPrerequisiteIntegrationRow[],
  git: (directory: string, args: string[]) => string,
  candidateBaseline?: string,
): IntegrationDecision {
  if (!prerequisites.length || new Set(prerequisites).size !== prerequisites.length)
    return { status: "waiting", reason: "Task dependencies are incomplete." }
  if (rows.length !== prerequisites.length)
    return { status: "waiting", reason: "A prerequisite task source has not been integrated." }

  const proof: Array<{ taskID: string; artifact: string; head: string }> = []
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
    proof.push({ taskID: row.task_id, artifact: row.artifact, head: payload.head })
  }

  let baseline: string
  try {
    baseline = candidateBaseline ?? git(directory, ["rev-parse", "HEAD"])
    if (git(directory, ["rev-parse", `${baseline}^{commit}`]) !== baseline || !isCommitID(baseline))
      return {
        status: "waiting",
        reason: "The selected checkout is not a valid integrated baseline.",
      }
  } catch {
    return { status: "unknown", reason: "The selected checkout ancestry could not be read." }
  }

  for (const row of proof) {
    try {
      git(directory, ["merge-base", "--is-ancestor", row.artifact, row.head])
      git(directory, ["merge-base", "--is-ancestor", row.head, baseline])
      git(directory, ["merge-base", "--is-ancestor", row.artifact, baseline])
    } catch {
      return {
        status: "waiting",
        reason: `Task ${row.taskID.slice(0, 8)} source is not present in the selected checkout.`,
      }
    }
  }
  return { status: "ready", baseline }
}

/** Async read projection variant; runtime dispatch keeps its synchronous fresh authority path. */
export async function evaluatePrerequisiteIntegrationAsync(
  directory: string,
  prerequisites: readonly string[],
  rows: readonly PrerequisiteIntegrationRow[],
  git: (directory: string, args: string[]) => Promise<string>,
  candidateBaseline?: string,
): Promise<string | undefined> {
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
    baseline = candidateBaseline ?? (await git(directory, ["rev-parse", "HEAD"]))
    if ((await git(directory, ["rev-parse", `${baseline}^{commit}`])) !== baseline) return undefined
  } catch {
    return undefined
  }
  if (!isCommitID(baseline)) return undefined

  for (const row of proof) {
    try {
      await git(directory, ["merge-base", "--is-ancestor", row.artifact, row.head])
      await git(directory, ["merge-base", "--is-ancestor", row.head, baseline])
      await git(directory, ["merge-base", "--is-ancestor", row.artifact, baseline])
    } catch {
      return undefined
    }
  }
  return baseline
}

/** Async read projection variant; runtime prompt admission keeps its synchronous fresh proof. */
export async function evaluateTaskPrerequisiteIntegrationAsync(
  directory: string,
  branch: string,
  prerequisites: readonly string[],
  rows: readonly TaskPrerequisiteIntegrationRow[],
  git: (directory: string, args: string[]) => Promise<string>,
  candidateBaseline?: string,
): Promise<IntegrationDecision> {
  if (!prerequisites.length || new Set(prerequisites).size !== prerequisites.length)
    return { status: "waiting", reason: "Task dependencies are incomplete." }
  if (rows.length !== prerequisites.length)
    return { status: "waiting", reason: "A prerequisite task source has not been integrated." }

  const proof: Array<{ taskID: string; artifact: string; head: string }> = []
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
    proof.push({ taskID: row.task_id, artifact: row.artifact, head: payload.head })
  }

  let baseline: string
  try {
    baseline = candidateBaseline ?? (await git(directory, ["rev-parse", "HEAD"]))
    if (
      (await git(directory, ["rev-parse", `${baseline}^{commit}`])) !== baseline ||
      !isCommitID(baseline)
    )
      return {
        status: "waiting",
        reason: "The selected checkout is not a valid integrated baseline.",
      }
  } catch {
    return { status: "unknown", reason: "The selected checkout ancestry could not be read." }
  }

  for (const row of proof) {
    try {
      await git(directory, ["merge-base", "--is-ancestor", row.artifact, row.head])
      await git(directory, ["merge-base", "--is-ancestor", row.head, baseline])
      await git(directory, ["merge-base", "--is-ancestor", row.artifact, baseline])
    } catch {
      return {
        status: "waiting",
        reason: `Task ${row.taskID.slice(0, 8)} source is not present in the selected checkout.`,
      }
    }
  }
  return { status: "ready", baseline }
}

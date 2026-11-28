import { randomUUID } from "node:crypto"
import { fingerprint } from "../../identity.ts"
import { prepareIntegrationComparison } from "../../code-review/integrations/comparison.ts"
import type { PreparedIntegrationComparison } from "../../code-review/integrations/comparison.ts"
import { CodeReviewIntegrationTargetStore } from "../../code-review/integrations/target-store.ts"
import type { CodeReviewIntegrationTarget } from "../../code-review/integrations/contract.ts"
import type { StoredIntegrationTarget } from "../../code-review/integrations/target-store.ts"
import { isAncestorAsync, gitRun, isObjectID, MAX_CHANGE_RANGE_COMMITS } from "./git.ts"
import {
  proofForArtifact,
  requireIntegration,
  type IntegrationProof,
} from "../integration-proof.ts"
import type { AttemptRow, NodeRow, PlanRow, RunnerStore } from "../store.ts"
import type { CommandInput } from "../schema.ts"
import { integrationTaskSources } from "./task-sources.ts"
import { retainIntegrationSource } from "./source-retention.ts"

export type ManagedIntegrationRecord = {
  id: string
  taskID: string
  artifact: string
  attempt: AttemptRow
  proof: IntegrationProof
  proofID: string
  comparison: PreparedIntegrationComparison
}

export type ManagedTargetIntegration = {
  targetBeforeRevision: string
  targetAfterRevision: string
  landedCommits: string[]
  target: CodeReviewIntegrationTarget
  batch: { batchID: string; taskIDs: string[] } | null
  records: ManagedIntegrationRecord[]
  createdAt: number
}

type ManagedTargetPreparation = {
  input: {
    store: RunnerStore
    projectID: string
    plan: PlanRow
    command: CommandInput
    proof: IntegrationProof
  }
  target: StoredIntegrationTarget
  taskIDs: string[]
  sources: Map<string, { node: NodeRow; attempts: AttemptRow[] }>
  before: string
  after: string
}

function selectedManagedTarget(
  input: ManagedTargetPreparation["input"],
): StoredIntegrationTarget | undefined {
  const { command, store } = input
  if (!command.targetBranch || !command.taskID) return undefined
  const target = new CodeReviewIntegrationTargetStore(store.repository).targetByBranch(
    command.targetBranch,
  )
  if (!target) return undefined
  if (target.target.projectID !== input.projectID)
    throw new Error("Integration target belongs to another OpenCode project")
  if (!command.expectedTargetHead || command.expectedTargetHead !== input.proof.head)
    throw new Error("Expected target head is stale; re-inspect the reviewed branch")
  return target
}

function managedTargetTaskIDs(command: CommandInput, target: StoredIntegrationTarget): string[] {
  const taskIDs = command.batchTaskIDs ?? [command.taskID!]
  if (taskIDs.some((taskID) => !target.target.taskIDs.includes(taskID)))
    throw new Error("Every integration task must belong to the selected target")
  return taskIDs
}

function managedTargetPreparation(
  input: ManagedTargetPreparation["input"],
): ManagedTargetPreparation | undefined {
  const target = selectedManagedTarget(input)
  if (!target) return undefined
  const { command, store } = input
  const taskIDs = managedTargetTaskIDs(command, target)
  const selectedAttemptIDs = new Map(
    (command.integrationAttempts ?? []).map(({ taskID, attemptID }) => [taskID, attemptID]),
  )
  const sources = integrationTaskSources(store, taskIDs, selectedAttemptIDs)
  return {
    input,
    target,
    taskIDs,
    sources,
    before: target.observedHead,
    after: input.proof.head,
  }
}

async function landedRange(root: string, before: string, after: string): Promise<string[]> {
  if (!(await isAncestorAsync(root, before, after)))
    throw new Error("Integration target was rewritten or diverged; refresh its recorded head first")
  const range = await gitRun(root, ["rev-list", "--reverse", "--topo-order", `${before}..${after}`])
  if (range.code !== 0)
    throw new Error(`Could not read the exact integration range: ${range.stderr}`)
  const commits = range.stdout ? range.stdout.split("\n") : []
  if (commits.some((commit) => !isObjectID(commit)))
    throw new Error("Git returned an invalid commit in the integration range")
  if (commits.length > MAX_CHANGE_RANGE_COMMITS)
    throw new Error(
      "Integration range exceeds the retained commit limit; record a narrower landing",
    )
  return commits
}

function acceptedManagedSource(
  preparation: ManagedTargetPreparation,
  taskID: string,
): { node: NodeRow; artifact: string; attempt: AttemptRow } {
  const source = preparation.sources.get(taskID)
  const node = source?.node
  if (!node || node.state !== "accepted" || !node.artifact)
    throw new Error(`Only accepted task artifacts can be recorded as integrated: ${taskID}`)
  const matchingAttempts = source.attempts
  const attempt = matchingAttempts.length === 1 ? matchingAttempts[0] : undefined
  if (!attempt)
    throw new Error(
      matchingAttempts.length > 1
        ? `Accepted task ${taskID} has multiple matching attempts; specify integrationAttempts`
        : `Accepted integration task has no retained attempt: ${taskID}`,
    )
  return { node, artifact: node.artifact, attempt }
}

async function managedIntegrationRecord(
  preparation: ManagedTargetPreparation,
  taskID: string,
  createdAt: number,
): Promise<ManagedIntegrationRecord> {
  const { input, target, before, after } = preparation
  const { command, store } = input
  const { artifact, attempt } = acceptedManagedSource(preparation, taskID)

  const proof = await proofForArtifact(
    (run) => store.repository.read(run),
    store.repository.projectDirectory,
    {
      artifact,
      attemptID: attempt.id,
      base: attempt.base_commit,
      target: after,
    },
  )
  if (proof.head !== after)
    throw new Error("Batch artifacts were not checked against the same target head")
  requireIntegration(
    proof,
    artifact,
    "The accepted task artifact",
    `branch ${command.targetBranch}`,
  )

  const id = randomUUID()
  const proofID = fingerprint({
    targetID: target.target.id,
    targetBeforeRevision: before,
    targetAfterRevision: after,
    taskID,
    attemptID: attempt.id,
    artifact,
    containment: proof.containment,
  })
  const comparison = await prepareIntegrationComparison({
    repository: store.repository,
    projectID: input.projectID,
    integrationID: id,
    taskID,
    planID: attempt.plan_id,
    attemptID: attempt.id,
    baseRevision: before,
    headRevision: after,
    capturedAt: createdAt,
  })
  await retainIntegrationSource(
    store.repository.projectDirectory,
    id,
    attempt.base_commit,
    artifact,
  )
  return { id, taskID, artifact, attempt, proof, proofID, comparison }
}

export async function prepareManagedTargetIntegration(input: {
  store: RunnerStore
  projectID: string
  plan: PlanRow
  command: CommandInput
  proof: IntegrationProof
}): Promise<ManagedTargetIntegration | undefined> {
  const preparation = managedTargetPreparation(input)
  if (!preparation) return undefined
  const { store } = input
  const landedCommits = await landedRange(
    store.repository.projectDirectory,
    preparation.before,
    preparation.after,
  )
  const createdAt = Date.now()
  const batch =
    preparation.taskIDs.length > 1
      ? { batchID: randomUUID(), taskIDs: [...preparation.taskIDs].sort() }
      : null
  const records = await Promise.all(
    preparation.taskIDs.map((taskID) => managedIntegrationRecord(preparation, taskID, createdAt)),
  )

  return {
    targetBeforeRevision: preparation.before,
    targetAfterRevision: preparation.after,
    landedCommits,
    target: preparation.target.target,
    batch,
    records,
    createdAt,
  }
}

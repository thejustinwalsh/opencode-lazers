import type { Database } from "bun:sqlite"
import { CodeReviewStore } from "../../code-review/comparisons/store.ts"
import {
  CodeReviewIntegrationSchema,
  type CodeReviewIntegrationTarget,
} from "../../code-review/integrations/contract.ts"
import { CodeReviewIntegrationStore } from "../../code-review/integrations/store.ts"
import { CodeReviewIntegrationTargetStore } from "../../code-review/integrations/target-store.ts"
import type { ManagedTargetIntegration, ManagedIntegrationRecord } from "./target.ts"
import { requireIntegration, type IntegrationProof } from "../integration-proof.ts"
import type { CommandInput } from "../schema.ts"
import type { PlanRow, RunnerStore } from "../store.ts"

type IntegrationInput = {
  store: RunnerStore
  db: Database
  plan: PlanRow
  command: CommandInput
  currentBranch: string
  currentHead: string
  targetHead: string
  proof?: IntegrationProof
  managed?: ManagedTargetIntegration
  projectID?: string
}

/**
 * The change must be contained in the reviewed branch, proven before the
 * transaction by `proveIntegration` (ancestry, change-id note, patch-id or
 * tree), so a rewritten history still proves. Never a bare SHA ancestry check.
 */
function reviewedBranchHead(
  currentBranch: string,
  currentHead: string,
  branch: string,
  artifact: string,
  proof: IntegrationProof | undefined,
) {
  if (currentBranch !== branch)
    throw new Error("The current checkout is not the reviewed target branch")
  const head = requireIntegration(proof, artifact, "The accepted artifact", `branch ${branch}`)
  if (currentHead !== head)
    throw new Error("The target head changed after its integration proof; inspect and retry")
  return head
}

function acceptedTaskForIntegration(
  store: RunnerStore,
  plan: PlanRow,
  command: CommandInput,
): { node: { task_id: string; artifact: string }; branch: string; reason: string } {
  const node = command.taskID
    ? store.nodes(plan.id).find((item) => item.task_id === command.taskID)
    : undefined
  if (node?.state !== "accepted" || !node.artifact)
    throw new Error("Only an accepted task result can be recorded as integrated")
  if (command.artifact !== node.artifact || !command.targetBranch || !command.reason)
    throw new Error("Record the accepted task artifact, reviewed targetBranch and reason")
  return {
    node: { task_id: node.task_id, artifact: node.artifact },
    branch: command.targetBranch,
    reason: command.reason,
  }
}

function legacyTaskIntegration(
  input: IntegrationInput,
  node: { task_id: string; artifact: string },
  branch: string,
  reason: string,
  head: string,
) {
  input.store.record(input.plan.id, node.task_id, "TASK_INTEGRATION_RECORDED", {
    artifact: node.artifact,
    branch,
    head,
    reason,
  })
  input.db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(input.plan.id)
  return { status: "task-integration-recorded", version: input.plan.version + 1, head }
}

function recordManagedIntegrationEvent(
  input: IntegrationInput,
  comparisons: CodeReviewStore,
  integrationStore: CodeReviewIntegrationStore,
  target: CodeReviewIntegrationTarget,
  managed: ManagedTargetIntegration,
  record: ManagedIntegrationRecord,
  branch: string,
  reason: string,
  head: string,
): void {
  const integration = CodeReviewIntegrationSchema.parse({
    id: record.id,
    target,
    taskID: record.taskID,
    planID: record.attempt.plan_id,
    attemptID: record.attempt.id,
    sourceBaseRevision: record.attempt.base_commit,
    sourceArtifactRevision: record.artifact,
    sourceWorkspaceID: record.attempt.workspace,
    targetBeforeRevision: managed.targetBeforeRevision,
    targetAfterRevision: managed.targetAfterRevision,
    landedCommits: managed.landedCommits,
    proofID: record.proofID,
    lineage: "proven",
    batch: managed.batch,
    createdAt: managed.createdAt,
  })
  comparisons.persistIn(
    input.db,
    record.comparison.comparison,
    record.comparison.files,
    record.comparison.blobs,
  )
  integrationStore.recordIntegrationIn(
    input.db,
    integration,
    record.comparison.comparison.identity.comparisonID,
  )
  input.store.record(record.attempt.plan_id, record.taskID, "TASK_INTEGRATION_RECORDED", {
    artifact: record.artifact,
    branch,
    head,
    reason,
    integrationID: record.id,
    attemptID: record.attempt.id,
    targetID: target.id,
    targetBeforeRevision: managed.targetBeforeRevision,
    targetAfterRevision: managed.targetAfterRevision,
    landedCommits: managed.landedCommits,
    batch: managed.batch,
    proofID: record.proofID,
  })
}

function assertManagedSourceNodeCurrent(input: IntegrationInput, record: ManagedIntegrationRecord) {
  const node = input.db
    .query<{ state: string; artifact: string | null }, [string, string, string]>(
      `SELECT n.state,n.artifact FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
       WHERE p.project_directory=? AND n.plan_id=? AND n.task_id=?`,
    )
    .get(input.store.repository.projectDirectory, record.attempt.plan_id, record.taskID)
  if (node?.state !== "accepted" || node.artifact !== record.artifact)
    throw new Error(
      `Accepted task source changed or became ambiguous before integration was recorded: ${record.taskID}`,
    )
}

function matchingManagedSourceAttempts(
  input: IntegrationInput,
  record: ManagedIntegrationRecord,
): number {
  const attempt = input.db
    .query<
      {
        base_commit: string
        workspace: string
        matching_attempts: number
      },
      [string, string, string, string, string]
    >(
      `SELECT a.base_commit,a.workspace,
         (SELECT COUNT(*) FROM runner_attempts matching
          WHERE matching.plan_id=a.plan_id AND matching.task_id=a.task_id
            AND matching.artifact=a.artifact) AS matching_attempts
       FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
       WHERE p.project_directory=? AND a.plan_id=? AND a.task_id=? AND a.id=? AND a.artifact=?`,
    )
    .get(
      input.store.repository.projectDirectory,
      record.attempt.plan_id,
      record.taskID,
      record.attempt.id,
      record.artifact,
    )
  if (
    !attempt ||
    attempt.base_commit !== record.attempt.base_commit ||
    attempt.workspace !== record.attempt.workspace
  )
    throw new Error(
      `Accepted task source changed or became ambiguous before integration was recorded: ${record.taskID}`,
    )
  return attempt.matching_attempts
}

function assertManagedSourceAttemptSelection(
  input: IntegrationInput,
  record: ManagedIntegrationRecord,
  matchingAttempts: number,
) {
  const selected = input.command.integrationAttempts?.some(
    (selection) => selection.taskID === record.taskID && selection.attemptID === record.attempt.id,
  )
  if (matchingAttempts > 1 && !selected)
    throw new Error(
      `Accepted task source changed or became ambiguous before integration was recorded: ${record.taskID}`,
    )
}

function assertManagedIntegrationRange(
  input: IntegrationInput,
  head: string,
  managed: ManagedTargetIntegration,
): void {
  if (managed.targetAfterRevision !== head || input.targetHead !== head || !input.projectID)
    throw new Error("The managed integration target changed before its receipt was recorded")
  const primary = managed.records.find((record) => record.taskID === input.command.taskID)
  if (!primary || primary.artifact !== input.command.artifact)
    throw new Error("The primary task does not match the prepared integration range")
  for (const record of managed.records) {
    assertManagedSourceNodeCurrent(input, record)
    const matchingAttempts = matchingManagedSourceAttempts(input, record)
    assertManagedSourceAttemptSelection(input, record, matchingAttempts)
  }
}

function advanceManagedTarget(
  input: IntegrationInput,
  branch: string,
  managed: ManagedTargetIntegration,
): CodeReviewIntegrationTarget {
  const targetStore = new CodeReviewIntegrationTargetStore(input.store.repository)
  const currentTarget = targetStore.targetIn(input.db, managed.target.id)
  if (
    !currentTarget ||
    currentTarget.target.projectID !== input.projectID ||
    currentTarget.target.branch !== branch ||
    managed.records.some((record) => !currentTarget.target.taskIDs.includes(record.taskID))
  )
    throw new Error("Integration target changed before its receipt was recorded")
  const target = targetStore.advanceObservedHeadIn(
    input.db,
    currentTarget.target.id,
    managed.targetBeforeRevision,
    managed.targetAfterRevision,
    managed.createdAt,
  )
  return target
}

function persistManagedIntegrationRecords(
  input: IntegrationInput,
  target: CodeReviewIntegrationTarget,
  managed: ManagedTargetIntegration,
  branch: string,
  reason: string,
  head: string,
): void {
  const comparisons = new CodeReviewStore(input.store.repository)
  const integrationStore = new CodeReviewIntegrationStore(input.store.repository)
  for (const record of managed.records)
    recordManagedIntegrationEvent(
      input,
      comparisons,
      integrationStore,
      target,
      managed,
      record,
      branch,
      reason,
      head,
    )
}

function recordManagedTaskIntegration(
  input: IntegrationInput,
  branch: string,
  reason: string,
  head: string,
  managed: ManagedTargetIntegration,
): { status: string; version: number; head: string; targetID: string; integrationIDs: string[] } {
  assertManagedIntegrationRange(input, head, managed)
  const target = advanceManagedTarget(input, branch, managed)
  persistManagedIntegrationRecords(input, target, managed, branch, reason, head)
  const planIDs = new Set(managed.records.map((record) => record.attempt.plan_id))
  for (const planID of planIDs)
    input.db
      .query("UPDATE runner_plans SET version=version+1 WHERE id=? AND project_directory=?")
      .run(planID, input.store.repository.projectDirectory)
  return {
    status: "task-integration-recorded",
    version: input.plan.version + 1,
    head,
    targetID: target.id,
    integrationIDs: managed.records.map((record) => record.id),
  }
}

function recordTaskIntegration(input: IntegrationInput) {
  const { node, branch, reason } = acceptedTaskForIntegration(
    input.store,
    input.plan,
    input.command,
  )
  const { managed } = input
  const head = managed
    ? requireIntegration(input.proof, node.artifact, "The accepted artifact", `branch ${branch}`)
    : reviewedBranchHead(input.currentBranch, input.currentHead, branch, node.artifact, input.proof)
  if (managed) return recordManagedTaskIntegration(input, branch, reason, head, managed)
  return legacyTaskIntegration(input, node, branch, reason, head)
}

function planIntegrationHead(
  input: IntegrationInput,
  target: ReturnType<CodeReviewIntegrationTargetStore["targetByBranch"]>,
): { head: string; target?: CodeReviewIntegrationTarget } {
  const { command, plan, proof } = input
  if (!plan.artifact || !command.targetBranch)
    throw new Error("Record the accepted artifact, reviewed targetBranch and reason")
  if (target) {
    const head = requireIntegration(
      proof,
      plan.artifact,
      "The accepted artifact",
      `branch ${command.targetBranch}`,
    )
    if (
      target.target.projectID !== input.projectID ||
      input.targetHead !== head ||
      !command.expectedTargetHead ||
      command.expectedTargetHead !== head ||
      target.observedHead !== head
    )
      throw new Error(
        "Plan cleanup can use a managed target only after its accepted task landings are recorded",
      )
    return { head, target: target.target }
  }
  return {
    head: reviewedBranchHead(
      input.currentBranch,
      input.currentHead,
      command.targetBranch,
      plan.artifact,
      proof,
    ),
  }
}

function recordPlanIntegration(input: IntegrationInput) {
  const { store, db, plan, command } = input
  if (!["accepted", "cleanup-blocked"].includes(plan.state) || !plan.artifact)
    throw new Error("Only an accepted result can be integrated")
  if (command.artifact !== plan.artifact || !command.targetBranch || !command.reason)
    throw new Error("Record the accepted artifact, reviewed targetBranch and reason")
  const registeredTarget = input.projectID
    ? new CodeReviewIntegrationTargetStore(store.repository).targetByBranch(command.targetBranch)
    : undefined
  const { head, target } = planIntegrationHead(input, registeredTarget)
  store.record(plan.id, null, "INTEGRATION_RECORDED", {
    artifact: plan.artifact,
    branch: command.targetBranch,
    head,
    reason: command.reason,
    ...(target ? { targetID: target.id } : {}),
  })
  db.query(
    "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'cleaning'),reason=NULL,version=version+1 WHERE id=?",
  ).run(plan.id)
  return { status: "cleanup-requested", version: store.plan(plan.id)!.version }
}

/** `currentBranch` and `currentHead` are legacy checkout observations; managed targets use targetHead. */
export function recordIntegration(
  store: RunnerStore,
  db: Database,
  plan: PlanRow,
  command: CommandInput,
  currentBranch: string,
  currentHead: string,
  targetHead: string,
  proof?: IntegrationProof,
  managed?: ManagedTargetIntegration,
  projectID?: string,
) {
  const input: IntegrationInput = {
    store,
    db,
    plan,
    command,
    currentBranch,
    currentHead,
    targetHead,
    proof,
    managed,
    projectID,
  }
  return command.taskID ? recordTaskIntegration(input) : recordPlanIntegration(input)
}

function recordReconciledTarget(input: {
  store: RunnerStore
  db: Database
  plan: PlanRow
  command: CommandInput
  projectID: string
  observed: { head: string }
  targetStore: CodeReviewIntegrationTargetStore
  existing: NonNullable<ReturnType<CodeReviewIntegrationTargetStore["targetByBranch"]>>
}) {
  const { store, db, plan, command, projectID, observed, targetStore, existing } = input
  if (
    command.targetPullRequest !== undefined ||
    existing.target.projectID !== projectID ||
    existing.target.baseBranch !== command.targetBaseBranch ||
    existing.target.baseRevision !== command.targetBaseRevision ||
    existing.observedHead !== command.expectedTargetHead
  )
    throw new Error(
      "Target reconciliation must preserve the recorded project, base, task group and PR association",
    )
  const target = targetStore.reconcileObservedHeadIn(db, {
    targetID: existing.target.id,
    projectID,
    branch: command.targetBranch!,
    baseBranch: command.targetBaseBranch!,
    baseRevision: command.targetBaseRevision!,
    taskIDs: command.targetTaskIDs!,
    expectedHead: existing.observedHead,
    nextHead: observed.head,
  })
  store.record(plan.id, null, "INTEGRATION_TARGET_RECONCILED", {
    targetID: target.id,
    branch: target.branch,
    previousObservedHead: existing.observedHead,
    observedHead: observed.head,
    reason: command.reason,
  })
  db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(plan.id)
  return {
    status: "integration-target-reconciled",
    version: plan.version + 1,
    target,
    previousObservedHead: existing.observedHead,
    observedHead: observed.head,
  }
}

function recordSelectedTarget(input: {
  store: RunnerStore
  db: Database
  plan: PlanRow
  command: CommandInput
  projectID: string
  observed: {
    head: string
    baseBranchHead: string
  }
  targetStore: CodeReviewIntegrationTargetStore
  existing: ReturnType<CodeReviewIntegrationTargetStore["targetByBranch"]>
}) {
  const { store, db, plan, command, projectID, observed, targetStore, existing } = input
  if (!existing && observed.baseBranchHead !== command.targetBaseRevision)
    throw new Error("Selected target base is stale; re-inspect the base branch before creating it")
  const result = targetStore.createOrExtendIn(db, {
    projectID,
    taskIDs: command.targetTaskIDs!,
    branch: command.targetBranch!,
    baseBranch: command.targetBaseBranch!,
    baseRevision: command.targetBaseRevision!,
    expectedHead: command.expectedTargetHead!,
    currentHead: observed.head,
    ...(command.targetPullRequest !== undefined ? { pullRequest: command.targetPullRequest } : {}),
  })
  store.record(plan.id, null, "INTEGRATION_TARGET_RECORDED", {
    target: result.target,
    observedHead: observed.head,
    created: result.created,
    reason: command.reason,
  })
  db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(plan.id)
  return {
    status: result.created ? "integration-target-recorded" : "integration-target-updated",
    version: plan.version + 1,
    target: result.target,
    observedHead: observed.head,
  }
}

export function recordIntegrationTarget(
  store: RunnerStore,
  db: Database,
  plan: PlanRow,
  command: CommandInput,
  projectID: string,
  observed: {
    head: string
    baseBranchHead: string
    baseRevision: string
    baseIsAncestor: boolean
  },
) {
  if (
    command.action !== "integration-target" ||
    !command.targetBranch ||
    !command.expectedTargetHead ||
    !command.targetBaseBranch ||
    !command.targetBaseRevision ||
    !command.targetTaskIDs?.length ||
    !command.reason
  )
    throw new Error("Integration target setup requires its branch, base, task group and reason")
  if (!command.reconcileTargetHead && observed.head !== command.expectedTargetHead)
    throw new Error("Integration target head changed; re-inspect before recording it")
  if (observed.baseRevision !== command.targetBaseRevision || !observed.baseIsAncestor)
    throw new Error("Selected target base is unavailable or is not an ancestor of the target head")
  if (command.targetTaskIDs.some((taskID) => !store.repository.get(taskID)))
    throw new Error("Integration target tasks must belong to this project")

  const targetStore = new CodeReviewIntegrationTargetStore(store.repository)
  const existing = targetStore.targetByBranch(command.targetBranch)
  const targetInput = {
    store,
    db,
    plan,
    command,
    projectID,
    observed,
    targetStore,
    existing,
  }
  return command.reconcileTargetHead
    ? recordReconciledTarget({
        ...targetInput,
        existing: existing!,
      })
    : recordSelectedTarget(targetInput)
}

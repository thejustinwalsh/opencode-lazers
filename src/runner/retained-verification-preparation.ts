import { sameModelSnapshot } from "./model-route.ts"
import { existsSync, realpathSync } from "node:fs"

import { commitIsAncestor, gitAsync } from "./artifacts.ts"
import { protectedPaths } from "./scope.ts"
import type { HostSession } from "./host.ts"
import { ModelPolicy, PlanInput } from "./schema.ts"
import type { CommandInput as PlanCommand } from "./schema.ts"
import type { PlanRow, AttemptRow } from "./store.ts"
import { canonicalProjectWorktreePath, samePhysicalWorkspace } from "./workspace-location.ts"
import { activeRetainedVerifications } from "./retained-verification/store.ts"
import type { RetainedVerification } from "./retained-verification/schema.ts"
import { retainedVerificationEnvironmentIdentity } from "./retained-verification/isolation.ts"
import { sameProject } from "../project-key.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { RetainedVerificationSeed } from "./runtime-helpers.ts"
import type { RetainedRepairRecords } from "./retained-repair-records.ts"
import type { WorkerObservation } from "./worker-observation.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `RetainedVerificationPreparation` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type RetainedVerificationPreparationDeps = {
  retainedAttemptModel: RetainedRepairRecords["retainedAttemptModel"]
  retainedRepairForAttempt: RetainedRepairRecords["retainedRepairForAttempt"]
  retainedRepairObservation: RetainedRepairRecords["retainedRepairObservation"]
  retainedRepairWorkerProblem: RetainedRepairRecords["retainedRepairWorkerProblem"]
  backgroundBlockReason: WorkerObservation["backgroundBlockReason"]
  validArchitect: ArchitectOwnership["validArchitect"]
}

/**
 * Retained verification preparation: whether a retained repair candidate is current, observing it,
 * the scope availability check, and preparing a retained verification. Moved out of `TaskRuntime`
 * without rewriting; the private aliases below keep the member bodies identical to what they were.
 */
export class RetainedVerificationPreparation {
  private readonly retainedAttemptModel: RetainedVerificationPreparationDeps["retainedAttemptModel"]
  private readonly retainedRepairForAttempt: RetainedVerificationPreparationDeps["retainedRepairForAttempt"]
  private readonly retainedRepairObservation: RetainedVerificationPreparationDeps["retainedRepairObservation"]
  private readonly retainedRepairWorkerProblem: RetainedVerificationPreparationDeps["retainedRepairWorkerProblem"]
  private readonly backgroundBlockReason: RetainedVerificationPreparationDeps["backgroundBlockReason"]
  private readonly validArchitect: RetainedVerificationPreparationDeps["validArchitect"]

  constructor(
    private readonly core: RuntimeCore,
    deps: RetainedVerificationPreparationDeps,
  ) {
    this.retainedAttemptModel = (...args) => deps.retainedAttemptModel(...args)
    this.retainedRepairForAttempt = (...args) => deps.retainedRepairForAttempt(...args)
    this.retainedRepairObservation = (...args) => deps.retainedRepairObservation(...args)
    this.retainedRepairWorkerProblem = (...args) => deps.retainedRepairWorkerProblem(...args)
    this.backgroundBlockReason = (...args) => deps.backgroundBlockReason(...args)
    this.validArchitect = deps.validArchitect
  }

  private get now() {
    return this.core.now
  }

  private get store() {
    return this.core.store
  }

  private get directory() {
    return this.core.directory
  }

  private get host() {
    return this.core.host
  }

  private get projectID() {
    return this.core.projectID
  }

  retainedVerificationWorkspacePath(operationID: string, phase: "task") {
    return canonicalProjectWorktreePath(this.directory, `retained-${operationID}-${phase}`)
  }
  retainedRepairCandidateCurrent(
    plan: PlanRow,
    attempt: AttemptRow,
    binding: NonNullable<RetainedVerification["repair"]>,
  ) {
    const repair = this.retainedRepairForAttempt(attempt)
    if (
      !repair ||
      repair.operationID !== binding.operationID ||
      repair.sessionID !== attempt.session_id ||
      repair.workspace !== attempt.workspace
    )
      return false
    try {
      const route = this.retainedAttemptModel(plan, attempt)
      const repairRoute = ModelPolicy.parse(repair.route)
      if (!route || !sameModelSnapshot(route, repairRoute)) return false
      const effects = this.store.effects(plan.id)
      if (
        effects.some(
          (effect) =>
            effect.attempt_id === attempt.id && ["intended", "uncertain"].includes(effect.state),
        )
      )
        return false
      return effects.some((effect) => {
        if (
          effect.attempt_id !== attempt.id ||
          effect.kind !== "prompt" ||
          effect.state !== "completed"
        )
          return false
        const payload = JSON.parse(effect.payload) as { repairID?: unknown; messageID?: unknown }
        return payload.repairID === binding.operationID && payload.messageID === attempt.message_id
      })
    } catch {
      return false
    }
  }
  async observeRetainedRepairCandidate(
    plan: PlanRow,
    attempt: AttemptRow,
    binding: NonNullable<RetainedVerification["repair"]>,
    observeOwner?: () => Promise<void>,
  ) {
    const model = ModelPolicy.parse(JSON.parse(attempt.policy).model)
    const validate = (worker: HostSession | null | undefined) => {
      const problem = this.retainedRepairWorkerProblem(
        plan,
        attempt,
        worker,
        attempt.message_id,
        model,
      )
      if (problem) throw new Error(problem)
      const backgroundProblem = worker ? this.backgroundBlockReason(worker) : undefined
      if (backgroundProblem) throw new Error(`Retained repair is not idle: ${backgroundProblem}`)
    }
    const before = await this.host.session(attempt.session_id, { messages: true })
    validate(before)
    await observeOwner?.()
    const after = await this.host.session(attempt.session_id, { messages: true })
    validate(after)
    if (
      !before ||
      !after ||
      this.retainedRepairObservation(before) !== this.retainedRepairObservation(after) ||
      !this.retainedRepairCandidateCurrent(plan, attempt, binding)
    )
      throw new Error("Retained repair changed during candidate observation")
  }
  assertRetainedVerificationScopeAvailable(
    planID: string,
    taskID: string,
    attemptID: string,
    taskWorkspace: string,
  ) {
    // Checks use private worktrees/resources, not an implementor's source scope.
    // Serialize shared authority and physical destinations, not unrelated paths
    // with the same relative names in different checkouts.
    const occupiesDestination = (workspace: string | null | undefined) =>
      Boolean(workspace && samePhysicalWorkspace(workspace, taskWorkspace))
    const competingAttempt = this.store
      .activeProjectAttempts()
      .find(
        (candidate) =>
          candidate.id !== attemptID &&
          ["preparing", "running", "verifying"].includes(candidate.state) &&
          (candidate.task_id === taskID || occupiesDestination(candidate.workspace)),
      )
    if (competingAttempt)
      throw new Error(
        "A conflicting active implementation attempt uses this task or verification checkout",
      )
    const conflictingAdoption = this.store
      .activeAdoptions()
      .find(
        (candidate) =>
          candidate.plan_id === planID ||
          candidate.task_id === taskID ||
          occupiesDestination(candidate.task_workspace) ||
          occupiesDestination(candidate.combined_workspace),
      )
    if (conflictingAdoption)
      throw new Error("A conflicting descendant adoption prevents retained verification")
    const conflictingVerification = this.store.atomic((db) =>
      activeRetainedVerifications(db, this.directory).find(
        (candidate) =>
          candidate.planID === planID ||
          candidate.taskID === taskID ||
          occupiesDestination(candidate.taskWorkspace),
      ),
    )
    if (conflictingVerification)
      throw new Error("A conflicting retained verification authority is already active")
  }
  async prepareRetainedVerification(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ): Promise<RetainedVerificationSeed> {
    if (
      !command.projectID ||
      !command.planRevision ||
      !command.taskRevision ||
      !command.taskID ||
      !command.attemptID ||
      !command.artifact ||
      !command.reason
    )
      throw new Error(
        "Retained verification requires current project, plan, task, attempt and candidate bindings",
      )
    if (!this.validArchitect(ownerSession) || command.projectID !== this.projectID)
      throw new Error("Retained verification requires the current same-project Architect owner")
    if (command.planRevision !== plan.revision)
      throw new Error("Retained verification plan revision is stale")
    if (this.store.activeAdoptions(plan.id).length)
      throw new Error("A descendant adoption conflicts with retained verification")
    const input = PlanInput.parse(JSON.parse(plan.body))
    const task = this.store.repository.get(command.taskID)
    const node = this.store.nodes(plan.id).find((item) => item.task_id === command.taskID)
    const attempt = this.store
      .attempts(plan.id)
      .filter((item) => item.task_id === command.taskID)
      .at(-1)
    if (
      !task ||
      !node ||
      !attempt ||
      attempt.id !== command.attemptID ||
      task.revision !== command.taskRevision ||
      input.nodes.find((entry) => entry.taskID === task.id)?.revision !== task.revision ||
      !sameProject(task.provenance.projectID, this.projectID) ||
      task.provenance.projectDirectory !== this.directory ||
      this.store.repository.taskDisposition(task.id)
    )
      throw new Error(
        "Retained verification must name the current task revision and latest original attempt",
      )
    const stoppedPlan = ["blocked", "accepted", "cleanup-blocked"].includes(plan.state)
    if (!stoppedPlan) throw new Error("Retained verification requires a stopped or accepted plan")
    const repairingCandidate = attempt.artifact !== null && attempt.artifact !== command.artifact
    const repair = repairingCandidate ? this.retainedRepairForAttempt(attempt) : undefined
    const repairBinding =
      repair && attempt.artifact
        ? { operationID: repair.operationID, previousArtifact: attempt.artifact }
        : undefined
    if (
      repairingCandidate &&
      (!repairBinding ||
        node.artifact !== null ||
        node.state !== "running" ||
        attempt.state !== "running" ||
        !this.retainedRepairCandidateCurrent(plan, attempt, repairBinding))
    )
      throw new Error(
        "Candidate does not match the recorded result or current authorized retained repair",
      )
    if (
      !repairingCandidate &&
      ((attempt.artifact !== null && attempt.artifact !== command.artifact) ||
        (node.artifact !== null && node.artifact !== command.artifact))
    )
      throw new Error(
        "Candidate does not match the exact committed result recorded for the latest attempt",
      )
    if (node.state === "cancelled" || node.state === "exhausted" || node.state === "incorporated")
      throw new Error("A cancelled, exhausted or incorporated task cannot be retained-verified")
    const id = crypto.randomUUID()
    const taskWorkspace = this.retainedVerificationWorkspacePath(id, "task")
    this.assertRetainedVerificationScopeAvailable(plan.id, task.id, attempt.id, taskWorkspace)
    if (!existsSync(attempt.workspace)) throw new Error("Original attempt workspace is unavailable")
    const originalWorkspace = realpathSync(attempt.workspace)
    if (
      realpathSync(await gitAsync(attempt.workspace, ["rev-parse", "--show-toplevel"])) !==
      originalWorkspace
    )
      throw new Error("Original attempt workspace is not a canonical repository checkout")
    if (originalWorkspace !== realpathSync(this.directory)) {
      const worktrees = await this.host.worktrees()
      if (!worktrees.some((workspace) => samePhysicalWorkspace(workspace, originalWorkspace)))
        throw new Error(
          "Original attempt checkout is not positively owned by the native worktree adapter",
        )
    }
    if (
      (await gitAsync(attempt.workspace, ["rev-parse", `${command.artifact}^{commit}`])) !==
      command.artifact
    )
      throw new Error(
        "Candidate must be an exact committed Git identity in the original attempt repository",
      )
    if (
      (attempt.artifact === null || repairingCandidate) &&
      (await gitAsync(attempt.workspace, ["rev-parse", "HEAD"])) !== command.artifact
    )
      throw new Error(
        "Unrecorded candidate must be the exact committed HEAD of the original attempt",
      )
    if (repairBinding) {
      if (
        !(await commitIsAncestor(
          attempt.workspace,
          repairBinding.previousArtifact,
          command.artifact,
        ))
      )
        throw new Error("Retained repair candidate must descend from its prior artifact")
      if (
        this.store
          .effects(plan.id)
          .some(
            (effect) =>
              effect.attempt_id === attempt.id && ["intended", "uncertain"].includes(effect.state),
          )
      )
        throw new Error("Uncertain original effects prevent repaired-candidate verification")
      await this.observeRetainedRepairCandidate(plan, attempt, repairBinding)
    }
    if (!(await commitIsAncestor(attempt.workspace, attempt.base_commit, command.artifact)))
      throw new Error("Candidate is not based on the original attempt's committed baseline")
    const changed = (
      await gitAsync(attempt.workspace, [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        attempt.base_commit,
        command.artifact,
      ])
    )
      .split("\0")
      .filter(Boolean)
    const violations = protectedPaths(changed, this.store.effectiveScope(task.id))
    if (violations.length)
      throw new Error(
        `Retained candidate changes protected paths: ${violations.slice(0, 20).join(", ")}`,
      )

    const environmentIdentity = retainedVerificationEnvironmentIdentity()
    const seed = {
      schemaVersion: 1 as const,
      id,
      projectID: this.projectID,
      projectDirectory: this.directory,
      planID: plan.id,
      planRevision: plan.revision,
      owner: caller,
      taskID: task.id,
      taskRevision: task.revision,
      attemptID: attempt.id,
      originalSessionID: attempt.session_id,
      originalMessageID: attempt.message_id,
      originalWorkspace: originalWorkspace,
      artifact: command.artifact,
      ...(repairBinding ? { repair: repairBinding } : {}),
      taskWorkspace,
      taskWorkspaceState: null,
      environmentIdentity,
      reason: command.reason,
      state: "pending" as const,
      failureReason: null,
      cleanupState: "pending" as const,
      createdAt: this.now(),
      updatedAt: this.now(),
    }
    return seed
  }
}

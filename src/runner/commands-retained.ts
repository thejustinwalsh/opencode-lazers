import type { Database } from "bun:sqlite"
import { messageID } from "./runtime-helpers.ts"
import type { CommandContext, RetainedRepairRecoverySeed } from "./runtime-helpers.ts"
import { sameModelSnapshot } from "./model-route.ts"
import { existsSync, realpathSync } from "node:fs"
import { PlanInput } from "./schema.ts"
import type { PlanRow, NodeRow, AttemptRow } from "./store.ts"
import { appendRunnerEffectReceipt } from "./store.ts"
import { samePhysicalWorkspace } from "./workspace-location.ts"
import { createRetainedVerification } from "./retained-verification/store.ts"
import { retainedVerificationProbeBasis } from "./retained-verification/probe.ts"
import { sameProject } from "../project-key.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"
import type { Dispatch } from "./dispatch.ts"
import type { RetainedRepairPreparation } from "./retained-repair-preparation.ts"
import type { RetainedRepairRecords } from "./retained-repair-records.ts"
import type { RetainedVerificationPreparation } from "./retained-verification-preparation.ts"
import type { StartupSettlement } from "./startup-settlement.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `CommandsRetained` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type CommandsRetainedDeps = {
  assertNoDispatchedDependents: RetainedRepairPreparation["assertNoDispatchedDependents"]
  retainedRepairAttemptAccepted: RetainedRepairPreparation["retainedRepairAttemptAccepted"]
  retainedRepairRecoveryCurrent: RetainedRepairPreparation["retainedRepairRecoveryCurrent"]
  preparationAllowed: Dispatch["preparationAllowed"]
  retainedAttemptModel: RetainedRepairRecords["retainedAttemptModel"]
  assertRetainedVerificationScopeAvailable: RetainedVerificationPreparation["assertRetainedVerificationScopeAvailable"]
  retainedRepairCandidateCurrent: RetainedVerificationPreparation["retainedRepairCandidateCurrent"]
  retainedVerificationWorkspacePath: RetainedVerificationPreparation["retainedVerificationWorkspacePath"]
  assertStartupSettlementCurrent: StartupSettlement["assertStartupSettlementCurrent"]
  delegatedAgentCapacity: DelegatedAgentCapacity
  validArchitect: ArchitectOwnership["validArchitect"]
}

/**
 * Retained-work commands: retained repair, adopting a descendant, verifying a retained candidate,
 * settling a startup, and recovering a retained repair. Each handler runs inside `store.command`, so none
 * awaits. Moved out of `TaskRuntime` without rewriting; the private aliases below keep the member bodies
 * identical to what they were.
 */
export class CommandsRetained {
  private readonly assertNoDispatchedDependents: CommandsRetainedDeps["assertNoDispatchedDependents"]
  private readonly retainedRepairAttemptAccepted: CommandsRetainedDeps["retainedRepairAttemptAccepted"]
  private readonly retainedRepairRecoveryCurrent: CommandsRetainedDeps["retainedRepairRecoveryCurrent"]
  private readonly preparationAllowed: CommandsRetainedDeps["preparationAllowed"]
  private readonly retainedAttemptModel: CommandsRetainedDeps["retainedAttemptModel"]
  private readonly assertRetainedVerificationScopeAvailable: CommandsRetainedDeps["assertRetainedVerificationScopeAvailable"]
  private readonly retainedRepairCandidateCurrent: CommandsRetainedDeps["retainedRepairCandidateCurrent"]
  private readonly retainedVerificationWorkspacePath: CommandsRetainedDeps["retainedVerificationWorkspacePath"]
  private readonly assertStartupSettlementCurrent: CommandsRetainedDeps["assertStartupSettlementCurrent"]
  private readonly delegatedAgentCapacity: CommandsRetainedDeps["delegatedAgentCapacity"]
  private readonly validArchitect: CommandsRetainedDeps["validArchitect"]

  constructor(
    private readonly core: RuntimeCore,
    deps: CommandsRetainedDeps,
  ) {
    this.assertNoDispatchedDependents = (...args) => deps.assertNoDispatchedDependents(...args)
    this.retainedRepairAttemptAccepted = (...args) => deps.retainedRepairAttemptAccepted(...args)
    this.retainedRepairRecoveryCurrent = (...args) => deps.retainedRepairRecoveryCurrent(...args)
    this.preparationAllowed = (...args) => deps.preparationAllowed(...args)
    this.retainedAttemptModel = (...args) => deps.retainedAttemptModel(...args)
    this.assertRetainedVerificationScopeAvailable = (...args) =>
      deps.assertRetainedVerificationScopeAvailable(...args)
    this.retainedRepairCandidateCurrent = (...args) => deps.retainedRepairCandidateCurrent(...args)
    this.retainedVerificationWorkspacePath = (...args) =>
      deps.retainedVerificationWorkspacePath(...args)
    this.assertStartupSettlementCurrent = (...args) => deps.assertStartupSettlementCurrent(...args)
    this.delegatedAgentCapacity = deps.delegatedAgentCapacity
    this.validArchitect = deps.validArchitect
  }

  private get now() {
    return this.core.now
  }

  private get store() {
    return this.core.store
  }

  private get projectID() {
    return this.core.projectID
  }

  private get directory() {
    return this.core.directory
  }

  commandRetainedRepair(db: Database, ctx: CommandContext, plan: PlanRow) {
    const { command, caller, baseVersion, ownerSession, retainedRepair, obs } = ctx
    if (!retainedRepair || !ownerSession || !this.validArchitect(ownerSession))
      throw new Error("Retained repair requires the current same-project Architect owner")
    if (caller !== plan.owner || ownerSession.id !== plan.owner)
      throw new Error("Retained repair owner changed before admission")
    if (caller !== retainedRepair.owner || plan.owner !== retainedRepair.owner)
      throw new Error("Retained repair owner/control authorization changed before admission")
    if (!new Set(["running", "accepted", "blocked"]).has(plan.state))
      throw new Error("Retained repair requires a running, accepted or blocked, unintegrated plan")
    const input = PlanInput.parse(JSON.parse(plan.body))
    const task = this.store.repository.get(retainedRepair.taskID)
    const node = this.store.nodes(plan.id).find((item) => item.task_id === retainedRepair.taskID)
    const attempt = this.store
      .attempts(plan.id)
      .filter((item) => item.task_id === retainedRepair.taskID)
      .at(-1)
    if (
      !task ||
      !node ||
      !attempt ||
      node.state !== "accepted" ||
      attempt.id !== retainedRepair.attemptID ||
      !this.retainedRepairAttemptAccepted(plan, attempt, task.revision) ||
      attempt.message_id !== retainedRepair.previousMessageID ||
      attempt.session_id !== retainedRepair.sessionID ||
      attempt.workspace !== retainedRepair.workspace ||
      node.artifact !== retainedRepair.artifact ||
      attempt.artifact !== retainedRepair.artifact ||
      input.nodes.find((item) => item.taskID === task.id)?.revision !== task.revision ||
      !sameProject(task.provenance.projectID, this.projectID) ||
      task.provenance.projectDirectory !== this.directory ||
      this.store.repository.taskDisposition(task.id)
    )
      throw new Error("Retained task, attempt, artifact, or assignment changed before admission")
    const policy = JSON.parse(attempt.policy) as {
      workspaceMode?: unknown
    }
    const route = this.retainedAttemptModel(plan, attempt)
    if (
      policy.workspaceMode !== "isolated" ||
      !route ||
      !sameModelSnapshot(route, retainedRepair.model)
    )
      throw new Error("Retained task execution route changed before admission")
    if (
      this.store.latestTransition(plan.id, task.id, "TASK_INTEGRATION_RECORDED") ||
      obs.isAncestor(
        this.directory,
        retainedRepair.artifact,
        obs.git(this.directory, ["rev-parse", "HEAD"]),
      )
    )
      throw new Error("Source-landed task work cannot be repaired in its retained workspace")
    if (
      this.store.effects(plan.id).some((effect) => ["intended", "uncertain"].includes(effect.state))
    )
      throw new Error("Uncertain effects prevent retained repair")
    this.assertNoDispatchedDependents(plan, task.id, input)
    if (
      !existsSync(attempt.workspace) ||
      obs.git(attempt.workspace, ["rev-parse", "HEAD"]) !== retainedRepair.artifact ||
      !this.preparationAllowed(attempt) ||
      this.store
        .activeProjectAttempts()
        .some(
          (other) =>
            other.id !== attempt.id && samePhysicalWorkspace(other.workspace, attempt.workspace),
        )
    )
      throw new Error("Retained artifact or effective scope reservation changed before admission")

    this.delegatedAgentCapacity.requeueRunnerInTransaction(
      db,
      { planID: plan.id, taskID: task.id, attemptNumber: attempt.number },
      attempt.id,
    )
    this.store.move(plan.id, task.id, "RETAINED_REPAIR", command.reason)
    const cleared = db
      .query(
        "UPDATE runner_nodes SET artifact=NULL WHERE plan_id=? AND task_id=? AND state='ready' AND artifact=?",
      )
      .run(plan.id, task.id, retainedRepair.artifact).changes
    const updatedAttempt = db
      .query(
        "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'preparing'),message_id=? WHERE id=? AND state=? AND message_id=?",
      )
      .run(
        retainedRepair.messageID,
        attempt.id,
        attempt.state,
        retainedRepair.previousMessageID,
      ).changes
    const updatedPlan = db
      .query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,artifact=NULL,version=version+1 WHERE id=? AND version=? AND state IN ('running','accepted','blocked')",
      )
      .run(plan.id, baseVersion + 1).changes
    if (cleared !== 1 || updatedAttempt !== 1 || updatedPlan !== 1)
      throw new Error("Retained repair authorization changed during atomic admission")
    this.store.record(plan.id, task.id, "RETAINED_REPAIR_REQUESTED", {
      operationID: retainedRepair.operationID,
      requestID: command.requestID,
      owner: caller,
      expectedVersion: baseVersion,
      attemptID: attempt.id,
      previousMessageID: retainedRepair.previousMessageID,
      nativeInputID: retainedRepair.nativeInputID,
      nativeAssignmentID: retainedRepair.previousMessageID,
      previousAttemptState: attempt.state,
      messageID: retainedRepair.messageID,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      route: retainedRepair.model,
      artifact: retainedRepair.artifact,
      defect: command.reason,
      workerObservation: retainedRepair.workerObservation,
      usageRetained: true,
      sameAttempt: true,
      sameSession: true,
      sameWorkspace: true,
      sameRoute: true,
    })
    return {
      status: "retained-repair-requested",
      operationID: retainedRepair.operationID,
      taskID: task.id,
      attemptID: attempt.id,
      artifact: retainedRepair.artifact,
      messageID: retainedRepair.messageID,
      version: this.store.plan(plan.id)!.version,
    }
  }
  commandAdoptDescendant(ctx: CommandContext, plan: PlanRow) {
    const { command, caller, ownerSession, adoptionSeed } = ctx
    if (!adoptionSeed || !ownerSession || !this.validArchitect(ownerSession))
      throw new Error("Descendant adoption requires the current same-project Architect owner")
    if (ownerSession.id !== plan.owner || caller !== plan.owner)
      throw new Error("Descendant adoption owner changed")
    const adoptionID = crypto.randomUUID()
    const adoption = this.store.createAdoption({
      id: adoptionID,
      planID: plan.id,
      taskID: adoptionSeed.taskID,
      writeScope: this.store.effectiveReservationScope(adoptionSeed.taskID),
      requestID: command.requestID,
      owner: plan.owner,
      expectedVersion: plan.version,
      taskRevision: adoptionSeed.taskRevision,
      attemptID: adoptionSeed.attemptID,
      nodeState: adoptionSeed.nodeState,
      attemptState: adoptionSeed.attemptState,
      oldArtifact: adoptionSeed.oldArtifact,
      descendantCommit: adoptionSeed.descendantCommit,
      targetBranch: adoptionSeed.targetBranch,
      landingHead: adoptionSeed.landingHead,
      reviewedBaseline: adoptionSeed.reviewedBaseline,
      candidateTree: adoptionSeed.candidateTree,
      inputFingerprint: adoptionSeed.inputFingerprint,
      environmentIdentity: adoptionSeed.environmentIdentity,
      reason: adoptionSeed.reason,
      combinedArtifact: adoptionSeed.combinedArtifact,
    })
    return {
      status: "descendant-adoption-requested",
      adoptionID: adoption.id,
      taskID: adoption.task_id,
      artifact: adoption.descendant_commit,
      combinedArtifact: adoption.combined_artifact,
      version: plan.version + 1,
    }
  }
  commandVerifyRetained(db: Database, ctx: CommandContext, plan: PlanRow) {
    const { command, ownerSession, retainedVerificationSeed, obs } = ctx
    const seed = retainedVerificationSeed
    if (!seed || !ownerSession || !this.validArchitect(ownerSession))
      throw new Error("Retained verification requires the current same-project Architect owner")
    if (
      plan.revision !== seed.planRevision ||
      command.projectID !== this.projectID ||
      command.taskID !== seed.taskID ||
      command.taskRevision !== seed.taskRevision ||
      command.attemptID !== seed.attemptID ||
      command.artifact !== seed.artifact
    )
      throw new Error("Retained verification authorization or candidate changed before reservation")
    const taskRow = db
      .query<{ project_directory: string; body: string }, [string, string]>(
        "SELECT project_directory,body FROM tasks WHERE project_directory=? AND id=?",
      )
      .get(this.directory, seed.taskID)
    const reservedTask = taskRow ? this.store.repository.get(seed.taskID) : undefined
    const attemptRow = db
      .query<
        {
          id: string
          artifact: string | null
          session_id: string
          message_id: string
          workspace: string
        },
        [string, string]
      >(
        "SELECT id,artifact,session_id,message_id,workspace FROM runner_attempts WHERE plan_id=? AND task_id=? ORDER BY number DESC LIMIT 1",
      )
      .get(plan.id, seed.taskID)
    const nodeRow = db
      .query<{ state: string; artifact: string | null }, [string, string]>(
        "SELECT state,artifact FROM runner_nodes WHERE plan_id=? AND task_id=?",
      )
      .get(plan.id, seed.taskID)
    if (
      !["blocked", "accepted", "cleanup-blocked"].includes(plan.state) ||
      !taskRow ||
      taskRow.project_directory !== this.directory ||
      reservedTask?.revision !== seed.taskRevision ||
      reservedTask.provenance.projectID !== this.projectID ||
      reservedTask.provenance.projectDirectory !== this.directory ||
      this.store.repository.taskDisposition(seed.taskID) !== undefined ||
      !attemptRow ||
      attemptRow.id !== seed.attemptID ||
      attemptRow.session_id !== seed.originalSessionID ||
      attemptRow.message_id !== seed.originalMessageID ||
      realpathSync(attemptRow.workspace) !== seed.originalWorkspace ||
      (seed.repair
        ? attemptRow.artifact !== seed.repair.previousArtifact ||
          nodeRow?.artifact !== null ||
          !this.retainedRepairCandidateCurrent(
            plan,
            this.store.attempts(plan.id).find((a) => a.id === seed.attemptID)!,
            seed.repair,
          ) ||
          obs.git(seed.originalWorkspace, ["rev-parse", "HEAD"]) !== seed.artifact
        : (attemptRow.artifact !== null && attemptRow.artifact !== seed.artifact) ||
          (nodeRow?.artifact !== null && nodeRow?.artifact !== seed.artifact))
    )
      throw new Error(
        "Original task, latest attempt or exact committed candidate changed before reservation",
      )
    this.assertRetainedVerificationScopeAvailable(
      plan.id,
      seed.taskID,
      seed.attemptID,
      this.retainedVerificationWorkspacePath(seed.id, "task"),
    )
    const operation = createRetainedVerification(db, this.directory, {
      ...seed,
      state: "pending",
      failureReason: null,
      cleanupState: "pending",
      createdAt: this.now(),
      updatedAt: this.now(),
    })
    this.store.record(plan.id, operation.taskID, "RETAINED_VERIFICATION_REQUESTED", {
      operationID: operation.id,
      taskRevision: operation.taskRevision,
      attemptID: operation.attemptID,
      artifact: operation.artifact,
      owner: operation.owner,
      requestID: command.requestID,
      oldExecutionAndResourceHoldsPreserved: true,
    })
    return {
      status: "retained-verification-requested",
      operationID: operation.id,
      taskID: operation.taskID,
      attemptID: operation.attemptID,
      artifact: operation.artifact,
      retainedVerification: { operationID: operation.id },
      probeBasis: { task: retainedVerificationProbeBasis(operation, "task") },
      version: plan.version,
    }
  }
  commandSettleStartup(db: Database, ctx: CommandContext, plan: PlanRow) {
    const { command, caller, baseVersion, startupSettlement } = ctx
    if (!startupSettlement || !command.taskID || !command.reason)
      throw new Error("Startup settlement evidence is unavailable")
    this.assertStartupSettlementCurrent(
      plan,
      startupSettlement.attempt,
      startupSettlement.effect,
      startupSettlement.failure,
    )
    const receipt = appendRunnerEffectReceipt(
      startupSettlement.effect.receipt,
      startupSettlement.evidence,
    )
    const settledEffect = db
      .query(
        `UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed'),receipt=?
     WHERE id=? AND plan_id=? AND task_id=? AND attempt_id=? AND state='uncertain'`,
      )
      .run(
        receipt,
        startupSettlement.effect.id,
        plan.id,
        command.taskID,
        startupSettlement.attempt.id,
      ).changes
    if (settledEffect !== 1) throw new Error("Original startup effect changed before settlement")
    const reason =
      "Startup worktree failure evidence was settled after all reserved resources were confirmed absent; explicit resume is required"
    const changed = db
      .query(
        `UPDATE runner_plans SET reason=?,version=version+1
     WHERE id=? AND project_directory=? AND owner=? AND version=? AND state='blocked'`,
      )
      .run(reason, plan.id, this.store.repository.projectDirectory, caller, baseVersion).changes
    if (changed !== 1) throw new Error("Plan changed before startup settlement")
    this.store.record(plan.id, command.taskID, "WORKTREE_STARTUP_FAILURE_SETTLED_ABSENT", {
      ...startupSettlement.evidence,
      reason: command.reason,
      caller,
    })
    return {
      status: "startup-failure-settled-absent",
      planID: plan.id,
      taskID: command.taskID,
      attemptID: startupSettlement.attempt.id,
      effectID: startupSettlement.effect.id,
      version: plan.version + 1,
      evidence: startupSettlement.evidence,
    }
  }
  commandRecoverRetainedRepair(
    db: Database,
    ctx: CommandContext,
    plan: PlanRow,
    node: NodeRow | undefined,
    attempt: AttemptRow | undefined,
    retainedRepairRecovery: RetainedRepairRecoverySeed,
  ) {
    const { command, ownerSession } = ctx
    const retry = command.action === "retry"
    const recoveryTask = this.store.repository.get(retainedRepairRecovery.taskID)
    const repairReservation = this.store.latestRetainedRepair<{
      messageID?: unknown
      previousMessageID?: unknown
    }>(plan.id, retainedRepairRecovery.taskID)
    const admittedRecoveryTask = PlanInput.parse(JSON.parse(plan.body)).nodes.find(
      (candidate) => candidate.taskID === retainedRepairRecovery!.taskID,
    )
    if (
      retry ||
      !attempt ||
      !node ||
      retainedRepairRecovery.taskID !== command.taskID ||
      retainedRepairRecovery.taskID !== attempt.task_id ||
      retainedRepairRecovery.taskRevision !== admittedRecoveryTask?.revision ||
      recoveryTask?.id !== retainedRepairRecovery.taskID ||
      recoveryTask.revision !== retainedRepairRecovery.taskRevision ||
      recoveryTask.provenance.projectID !== this.projectID ||
      recoveryTask.provenance.projectDirectory !== this.directory ||
      (retainedRepairRecovery.lineage.kind === "unprompted" &&
        (typeof repairReservation?.messageID !== "string" ||
          typeof repairReservation.previousMessageID !== "string" ||
          repairReservation.messageID !== retainedRepairRecovery.repairMessageID ||
          repairReservation.previousMessageID !== retainedRepairRecovery.predecessorMessageID)) ||
      this.store.repository.taskDisposition(retainedRepairRecovery.taskID) !== undefined ||
      command.taskID !== retainedRepairRecovery.taskID ||
      command.attemptID !== retainedRepairRecovery.attemptID ||
      !this.validArchitect(ownerSession) ||
      ownerSession.id !== retainedRepairRecovery.owner ||
      !this.retainedRepairRecoveryCurrent(plan, attempt, retainedRepairRecovery)
    )
      throw new Error("Retained repair recovery authorization changed before reservation")
    const resumedMessageID = messageID()
    this.delegatedAgentCapacity.requeueRunnerInTransaction(
      db,
      { planID: plan.id, taskID: attempt.task_id, attemptNumber: attempt.number },
      attempt.id,
    )
    this.store.move(plan.id, attempt.task_id, "RESUME", command.reason)
    const updatedAttempt = db
      .query(
        "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'preparing'),message_id=? WHERE id=? AND state='cancelled' AND message_id=?",
      )
      .run(resumedMessageID, attempt.id, retainedRepairRecovery.failedMessageID).changes
    const updatedPlan = db
      .query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason=? AND version=?",
      )
      .run(plan.id, plan.reason, retainedRepairRecovery.planVersion + 1).changes
    if (updatedAttempt !== 1 || updatedPlan !== 1)
      throw new Error("Retained repair recovery reservation changed during atomic admission")
    this.store.record(plan.id, attempt.task_id, "ATTEMPT_RESUMED", {
      attemptID: attempt.id,
      reason: command.reason,
      usageRetained: true,
      budget: null,
      previousMessageID: retainedRepairRecovery.failedMessageID,
      messageID: resumedMessageID,
      terminalInputID: retainedRepairRecovery.lineage.inputID,
      terminalOutcome: retainedRepairRecovery.lineage.outcome,
      ...(retainedRepairRecovery.lineage.kind === "interrupted"
        ? { interruptedInputID: retainedRepairRecovery.lineage.inputID }
        : {}),
      retainedRepairRecovery:
        retainedRepairRecovery.lineage.kind === "unprompted"
          ? {
              schema: "lazers-retained-repair-recovery/v2",
              preAdmissionFenceFailure: true,
              operationID: retainedRepairRecovery.operationID,
              failedMessageID: retainedRepairRecovery.failedMessageID,
              reservedRepairMessageID: repairReservation!.messageID,
              predecessorMessageID: repairReservation!.previousMessageID,
              nativeInputID: retainedRepairRecovery.lineage.inputID,
              terminalOutcome: retainedRepairRecovery.lineage.outcome,
              owner: retainedRepairRecovery.repairAuthor,
              recoveredBy: retainedRepairRecovery.owner,
              failedReservationTransitionID: retainedRepairRecovery.reservationTransitionID,
              unpromptedMessageIDs: retainedRepairRecovery.unpromptedMessageIDs,
              blockedTransitionID: retainedRepairRecovery.blockedTransitionID,
              cancelledTransitionID: retainedRepairRecovery.cancelledTransitionID,
            }
          : {
              schema: "lazers-retained-repair-recovery/v1",
              operationID: retainedRepairRecovery.operationID,
              failedMessageID: retainedRepairRecovery.failedMessageID,
              interruptedInputID: retainedRepairRecovery.lineage.inputID,
              owner: retainedRepairRecovery.repairAuthor,
              recoveredBy: retainedRepairRecovery.owner,
              failedResumeTransitionID: retainedRepairRecovery.resumedTransitionID,
              blockedTransitionID: retainedRepairRecovery.blockedTransitionID,
              cancelledTransitionID: retainedRepairRecovery.cancelledTransitionID,
            },
    })
    return {
      status: "retained-repair-recovered",
      version: this.store.plan(plan.id)!.version,
      taskID: attempt.task_id,
      attemptID: attempt.id,
      messageID: resumedMessageID,
    }
  }
}

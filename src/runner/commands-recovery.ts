import type { Database } from "bun:sqlite"
import { messageID, isRerunnableEffect } from "./runtime-helpers.ts"
import type { CommandContext, StartupRecoveryAuthorization } from "./runtime-helpers.ts"
import { type BaseReach } from "./integration-proof.ts"
import type { HostSession } from "./host.ts"
import { ModelPolicy, PlanInput } from "./schema.ts"
import type { NodeRow } from "./store.ts"
import { matchesReviewInputAlias, parseReviewInputAlias } from "./review-input.ts"
import { startupFailureSettlementFromReceipt } from "./startup-recovery.ts"
import { verificationActivitiesForDatabase } from "./verification-activities.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { CommandsRetained } from "./commands-retained.ts"
import type { ContinuationPreparation } from "./continuation-preparation.ts"
import type { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"
import type { Dispatch } from "./dispatch.ts"
import type { StartupSettlement } from "./startup-settlement.ts"
import type { AttemptRow, EffectRow, PlanRow } from "./store.ts"
import type { RuntimeCore } from "./runtime-core.ts"
import { planIs } from "./identity-read.ts"

/** What `CommandsRecovery` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type CommandsRecoveryDeps = {
  assertTerminalContinuation: ContinuationPreparation["assertTerminalContinuation"]
  commandRecoverRetainedRepair: CommandsRetained["commandRecoverRetainedRepair"]
  interruptedChecksFor: (plan: PlanRow, attempt: AttemptRow) => EffectRow[]
  settledStartupEffect: StartupSettlement["settledStartupEffect"]
  hasMeaningfulWorkerProgress: StartupSettlement["hasMeaningfulWorkerProgress"]
  preparationAllowed: Dispatch["preparationAllowed"]
  delegatedAgentCapacity: DelegatedAgentCapacity
  validArchitect: ArchitectOwnership["validArchitect"]
}

/**
 * Recovery commands: resume or retry, resuming combined or interrupted verification, requeueing an
 * unstarted task, authorizing startup recovery, selecting a shared workspace, and reconcile. Each handler
 * runs inside `store.command`, so none awaits. Moved out of `TaskRuntime` without rewriting; the private
 * aliases below keep the member bodies identical to what they were.
 */
export class CommandsRecovery {
  private readonly assertTerminalContinuation: CommandsRecoveryDeps["assertTerminalContinuation"]
  private readonly commandRecoverRetainedRepair: CommandsRecoveryDeps["commandRecoverRetainedRepair"]
  private readonly interruptedChecksFor: CommandsRecoveryDeps["interruptedChecksFor"]
  private readonly settledStartupEffect: CommandsRecoveryDeps["settledStartupEffect"]
  private readonly hasMeaningfulWorkerProgress: CommandsRecoveryDeps["hasMeaningfulWorkerProgress"]
  private readonly preparationAllowed: CommandsRecoveryDeps["preparationAllowed"]
  private readonly delegatedAgentCapacity: CommandsRecoveryDeps["delegatedAgentCapacity"]
  private readonly validArchitect: CommandsRecoveryDeps["validArchitect"]

  constructor(
    private readonly core: RuntimeCore,
    deps: CommandsRecoveryDeps,
  ) {
    this.assertTerminalContinuation = (...args) => deps.assertTerminalContinuation(...args)
    this.commandRecoverRetainedRepair = (...args) => deps.commandRecoverRetainedRepair(...args)
    this.interruptedChecksFor = (...args) => deps.interruptedChecksFor(...args)
    this.settledStartupEffect = (...args) => deps.settledStartupEffect(...args)
    this.hasMeaningfulWorkerProgress = (...args) => deps.hasMeaningfulWorkerProgress(...args)
    this.preparationAllowed = (...args) => deps.preparationAllowed(...args)
    this.delegatedAgentCapacity = deps.delegatedAgentCapacity
    this.validArchitect = deps.validArchitect
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

  /**
   * Record tree OID, patch-id, change id and the `refs/notes/lazers` note for
   * every stored artifact and base that has no current identity. This is an
   * observation: it never grants, revokes or delays an acceptance, and a
   * failure (for example a repository that is not available) is ignored and
   * retried on the next call. Calls coalesce; unforced calls are throttled.
   */
  /** The reachability verdict computed before the transaction for `base`, as a readable error. */
  requireBaseReachable(bases: ReadonlyMap<string, BaseReach>, base: string) {
    const reach = bases.get(base)
    if (!reach) throw new Error(`Baseline ${base.slice(0, 8)} was not checked against HEAD`)
    if (!reach.ok) throw new Error(reach.reason)
  }
  commandResumeOrRetry(db: Database, ctx: CommandContext, plan: PlanRow) {
    const {
      command,
      ownerSession,
      terminalContinuation,
      terminalRepairContinuation,
      retainedRepairRecovery,
    } = ctx
    const retry = command.action === "retry"
    if (!ownerSession || ownerSession.archived) throw new Error("Owner unavailable")
    if (!command.taskID) return this.commandResumeCombinedVerification(db, ctx, plan)
    if (!command.taskID || !command.reason) throw new Error("Resume requires taskID and reason")
    const node = this.store.nodes(plan.id).find((n) => n.task_id === command.taskID)
    const attempt = this.store
      .attempts(plan.id)
      .filter((a) => a.task_id === command.taskID)
      .at(-1)
    if (command.attemptID && command.attemptID !== attempt?.id)
      throw new Error("Command attemptID does not match the exact latest task attempt")
    if (retainedRepairRecovery)
      return this.commandRecoverRetainedRepair(db, ctx, plan, node, attempt, retainedRepairRecovery)
    if (!retry && node?.state === "verifying" && attempt?.state === "verifying") {
      const interrupted = this.interruptedChecksFor(plan, attempt)
      if (interrupted.length)
        return this.commandResumeInterruptedVerification(db, ctx, plan, attempt, interrupted)
    }
    const continuingTerminalWorker = Boolean(
      !retry &&
      terminalContinuation &&
      attempt?.id === terminalContinuation.attemptID &&
      attempt.message_id === terminalContinuation.messageID,
    )
    if (continuingTerminalWorker) this.assertTerminalContinuation(ctx, plan, attempt)
    if (retry && node?.state === "cancelled" && !attempt)
      return this.commandRequeueUnstartedTask(db, ctx, plan, node, ownerSession)
    if (
      !["blocked", "cancelled", "failed"].includes(plan.state) ||
      !node ||
      !["exhausted", "cancelled", "running", "verifying", "failed", "blocked"].includes(
        node.state,
      ) ||
      !attempt ||
      (!continuingTerminalWorker &&
        !["exhausted", "cancelled", "preparing", "failed"].includes(attempt.state))
    )
      throw new Error("Only an exhausted or cancelled, stopped attempt can resume")
    if (
      this.store.effects(plan.id).some((effect) => ["intended", "uncertain"].includes(effect.state))
    )
      throw new Error("Reconcile uncertain effects first")

    const settledStartupEffect = attempt ? this.settledStartupEffect(plan.id, attempt) : undefined
    if (settledStartupEffect)
      return this.commandAuthorizeStartupRecovery(db, ctx, plan, attempt, settledStartupEffect)

    if (!retry)
      this.delegatedAgentCapacity.requeueRunnerInTransaction(
        db,
        { planID: plan.id, taskID: node.task_id, attemptNumber: attempt.number },
        attempt.id,
      )
    if (retry) this.store.move(plan.id, node.task_id, "RETRY", command.reason)
    else if (node.state !== "running")
      this.store.move(plan.id, node.task_id, "RESUME", command.reason)
    const planInput = PlanInput.parse(JSON.parse(plan.body))
    const sharedMode =
      command.workspaceMode === "shared" ||
      (command.workspaceMode === undefined && planInput.workspaceMode === "shared")
    let selectedBaseline: string | null = null
    if (
      !continuingTerminalWorker &&
      (command.workspaceMode === "shared" ||
        (retry && sharedMode && command.baseCommit !== undefined))
    )
      selectedBaseline = this.selectSharedWorkspace(db, ctx, plan, node, attempt)
    // A retry may leave the shared checkout: the command's isolated mode is recorded on the plan
    // body, the same way `selectSharedWorkspace` records a shared one, so the new attempt gets a
    // native worktree instead of queueing behind every other plan's reservation.
    if (retry && command.workspaceMode === "isolated" && !continuingTerminalWorker) {
      const priorMode =
        JSON.parse(plan.body).workspaceMode ??
        (attempt.workspace === this.directory ? "shared" : "isolated")
      if (priorMode !== "isolated") {
        const revised = PlanInput.parse({ ...JSON.parse(plan.body), workspaceMode: "isolated" })
        db.query("UPDATE runner_plans SET body=?,revision=revision+1 WHERE id=?").run(
          JSON.stringify(revised),
          plan.id,
        )
        db.query("INSERT INTO runner_plan_revisions VALUES(?,?,?,?,?)").run(
          plan.id,
          plan.revision + 1,
          JSON.stringify(revised),
          plan.owner,
          Date.now(),
        )
        this.store.record(plan.id, node.task_id, "WORKSPACE_SELECTED", {
          attemptID: attempt.id,
          from: attempt.workspace,
          mode: "isolated",
          reason: command.reason,
        })
      }
    }
    let resumedMessageID: string | undefined
    if (retry)
      db.query(
        "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'cancelled') WHERE id=? AND state='preparing'",
      ).run(attempt.id)
    else {
      resumedMessageID = messageID()
      db.query(
        "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'preparing'),message_id=? WHERE id=?",
      ).run(resumedMessageID, attempt.id)
    }
    db.query(
      "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=?",
    ).run(plan.id)
    this.store.record(plan.id, node.task_id, retry ? "RETRY_REQUESTED" : "ATTEMPT_RESUMED", {
      attemptID: attempt.id,
      reason: command.reason,
      usageRetained: true,
      budget: null,
      ...(resumedMessageID
        ? {
            previousMessageID: attempt.message_id,
            messageID: resumedMessageID,
          }
        : {}),
      ...(continuingTerminalWorker
        ? {
            terminalInputID: terminalContinuation!.inputID,
            terminalOutcome: terminalContinuation!.worker.outcome,
            ...(terminalContinuation!.worker.outcome === "interrupted"
              ? { interruptedInputID: terminalContinuation!.inputID }
              : {}),
          }
        : {}),
      ...(continuingTerminalWorker && terminalRepairContinuation
        ? {
            retainedRepairContinuation: {
              schema: "lazers-retained-repair-continuation/v1",
              operationID: terminalRepairContinuation.operationID,
              owner: terminalRepairContinuation.owner,
            },
          }
        : {}),
      ...(retry ? { selectedBaseline } : {}),
    })
    return {
      status: retry ? "retrying" : "resuming",
      version: this.store.plan(plan.id)!.version,
    }
  }
  commandResumeCombinedVerification(db: Database, ctx: CommandContext, plan: PlanRow) {
    const { command, caller, baseVersion, ownerSession } = ctx
    const retry = command.action === "retry"
    if (retry || !command.reason?.trim())
      throw new Error("Resume requires an exact task attempt or a blocked combined check")
    if (plan.state !== "blocked" || plan.artifact !== null || !this.validArchitect(ownerSession))
      throw new Error("Combined verification resume requires a blocked, unaccepted plan")
    if (
      verificationActivitiesForDatabase(this.store.repository.path).some(
        (activity) => activity.metadata.planID === plan.id && activity.state === "running",
      )
    )
      throw new Error("A live verification activity prevents combined verification resume")
    // A combined check without a conclusive receipt is simply re-run.
    const superseded = this.store
      .effects(plan.id)
      .filter(
        (effect) =>
          effect.task_id === null &&
          effect.kind.startsWith("graph-verify:") &&
          ["intended", "uncertain"].includes(effect.state),
      )
    for (const effect of superseded)
      db.query(
        "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed') WHERE id=? AND state IN ('intended','uncertain')",
      ).run(effect.id)
    const changedPlan = db
      .query(
        `UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1
     WHERE id=? AND version=? AND state='blocked' AND artifact IS NULL`,
      )
      .run(plan.id, baseVersion).changes
    if (changedPlan !== 1) throw new Error("Combined verification plan changed")
    const resumed = this.store.plan(plan.id)!
    this.store.record(plan.id, null, "RECONCILE_REQUESTED", {
      caller,
      verificationEpoch: resumed.version,
      continuation: "combined-verification",
      supersededEffectIDs: superseded.map((effect) => effect.id),
    })
    return {
      status: "combined-verification-resumed",
      planID: plan.id,
      supersededEffectIDs: superseded.map((effect) => effect.id),
      verificationEpoch: resumed.version,
      version: resumed.version,
    }
  }
  commandResumeInterruptedVerification(
    db: Database,
    ctx: CommandContext,
    plan: PlanRow,
    attempt: AttemptRow,
    interrupted: EffectRow[],
  ) {
    const { command, ownerSession } = ctx
    if (
      plan.state !== "blocked" ||
      !this.validArchitect(ownerSession) ||
      command.attemptID !== attempt.id ||
      command.workspaceMode !== undefined ||
      command.baseCommit !== undefined
    )
      throw new Error("Interrupted verification resume requires its exact preserved attempt")
    const interruptedIDs = new Set(interrupted.map((effect) => effect.id))
    if (
      this.store
        .effects(plan.id)
        .some(
          (effect) =>
            ["intended", "uncertain"].includes(effect.state) && !interruptedIDs.has(effect.id),
        )
    )
      throw new Error("Reconcile other uncertain effects first")
    for (const effect of interrupted)
      db.query(
        "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed') WHERE id=? AND state='uncertain'",
      ).run(effect.id)
    const verificationEpoch =
      (this.store.latestTransition<{ verificationEpoch: number }>(
        plan.id,
        attempt.task_id,
        "VERIFICATION_RESUMED",
      )?.verificationEpoch ?? 0) + 1
    this.store.record(plan.id, attempt.task_id, "VERIFICATION_RESUMED", {
      attemptID: attempt.id,
      interruptedEffectIDs: [...interruptedIDs],
      verificationEpoch,
      reason: command.reason,
    })
    db.query(
      "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=?",
    ).run(plan.id)
    return {
      status: "verification-resumed",
      version: this.store.plan(plan.id)!.version,
      attemptID: attempt.id,
    }
  }
  commandRequeueUnstartedTask(
    db: Database,
    ctx: CommandContext,
    plan: PlanRow,
    node: NodeRow,
    ownerSession: HostSession,
  ) {
    const { command, caller, preflight, obs } = ctx
    if (
      !["blocked", "cancelled", "failed", "running"].includes(plan.state) ||
      plan.artifact !== null
    )
      throw new Error("Only an admitted, nonintegrated plan can requeue an unstarted task")
    if (ownerSession.id !== plan.owner || ownerSession.projectID !== this.projectID)
      throw new Error("Foreign owner session")
    if (
      this.store.effects(plan.id).some((effect) => ["intended", "uncertain"].includes(effect.state))
    )
      throw new Error("Reconcile uncertain effects first")

    const input = PlanInput.parse(JSON.parse(plan.body))
    if (command.baseCommit !== undefined && command.baseCommit !== input.baseCommit) {
      if (this.store.attempts(plan.id).length)
        throw new Error("A plan with prior attempts cannot change its unstarted baseline")
      const baseCommit = obs.git(this.directory, ["rev-parse", `${command.baseCommit}^{commit}`])
      if (baseCommit !== command.baseCommit)
        throw new Error("An explicit baseline must identify a commit")
      obs.git(this.directory, ["merge-base", "--is-ancestor", input.baseCommit, baseCommit])
      this.requireBaseReachable(preflight.bases, baseCommit)
      this.store.revisePlan(
        plan,
        PlanInput.parse({ ...input, baseCommit }),
        "UNSTARTED_BASELINE_SELECTED",
        { from: input.baseCommit, baseCommit, caller, reason: command.reason },
      )
    }
    this.store.move(plan.id, node.task_id, "RETRY", command.reason)
    if (plan.state !== "running")
      db.query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=?",
      ).run(plan.id)
    this.store.record(plan.id, node.task_id, "UNSTARTED_TASK_REQUEUED", {
      caller,
      reason: command.reason,
    })
    return { status: "requeued", version: this.store.plan(plan.id)!.version }
  }
  commandAuthorizeStartupRecovery(
    db: Database,
    ctx: CommandContext,
    plan: PlanRow,
    attempt: AttemptRow,
    settledStartupEffect: EffectRow,
  ) {
    const { command, ownerSession } = ctx
    const retry = command.action === "retry"
    const settlement = startupFailureSettlementFromReceipt(settledStartupEffect.receipt)
    if (
      retry ||
      !command.attemptID ||
      command.attemptID !== attempt!.id ||
      attempt!.state !== "preparing" ||
      plan.state !== "blocked" ||
      !this.validArchitect(ownerSession) ||
      !settlement
    )
      throw new Error("Startup recovery requires explicit resume of the exact settled attempt")
    const workerEffects = this.store
      .effects(plan.id)
      .some(
        (effect) =>
          effect.attempt_id === attempt!.id &&
          (effect.kind === "session" ||
            effect.kind === "prompt" ||
            effect.kind.startsWith("verify:") ||
            effect.kind.startsWith("graph-verify:")),
      )
    if (
      workerEffects ||
      this.hasMeaningfulWorkerProgress(attempt!.id) ||
      !this.preparationAllowed(attempt!)
    )
      throw new Error(
        "Startup recovery cannot continue after worker effects or conflicting ownership",
      )

    const recoveryID = crypto.randomUUID()
    const authorization: StartupRecoveryAuthorization = {
      schema: "lazers-worktree-startup-authorization/v1",
      recoveryID,
      sourceEffectID: settledStartupEffect.id,
      settlementRequestID: settlement.requestID,
      requestID: command.requestID,
      owner: plan.owner,
      planVersion: plan.version + 1,
      planRevision: plan.revision,
      taskID: attempt!.task_id,
      attemptID: attempt!.id,
      sessionID: attempt!.session_id,
      messageID: attempt!.message_id,
      workspace: attempt!.workspace,
      base: attempt!.base_commit,
      policy: attempt!.policy,
    }
    this.delegatedAgentCapacity.requeueRunnerInTransaction(
      db,
      { planID: plan.id, taskID: attempt.task_id, attemptNumber: attempt.number },
      attempt.id,
    )
    db.query(
      "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND version=?",
    ).run(plan.id, plan.version)
    this.store.record(plan.id, attempt!.task_id, "STARTUP_RECOVERY_AUTHORIZED", authorization)
    this.store.record(plan.id, attempt!.task_id, "ATTEMPT_RESUMED", {
      attemptID: attempt!.id,
      reason: command.reason,
      usageRetained: true,
      budget: null,
      startupRecoveryID: recoveryID,
      sourceEffectID: settledStartupEffect.id,
    })
    return {
      status: "startup-recovery-authorized",
      version: plan.version + 1,
      attemptID: attempt!.id,
      recoveryID,
    }
  }
  selectSharedWorkspace(
    db: Database,
    ctx: CommandContext,
    plan: PlanRow,
    node: NodeRow,
    attempt: AttemptRow,
  ) {
    const { command, preflight, obs } = ctx
    const retry = command.action === "retry"
    const source = command.baseCommit ?? obs.git(this.directory, ["rev-parse", "HEAD"])
    if (command.baseCommit !== undefined) this.requireBaseReachable(preflight.bases, source)
    if (!retry)
      db.query("UPDATE runner_attempts SET workspace=?,base_commit=? WHERE id=?").run(
        this.directory,
        source,
        attempt.id,
      )
    const revised = PlanInput.parse({
      ...JSON.parse(plan.body),
      workspaceMode: "shared",
      baseCommit: source,
    })
    db.query("UPDATE runner_plans SET body=?,revision=revision+1 WHERE id=?").run(
      JSON.stringify(revised),
      plan.id,
    )
    db.query("INSERT INTO runner_plan_revisions VALUES(?,?,?,?,?)").run(
      plan.id,
      plan.revision + 1,
      JSON.stringify(revised),
      plan.owner,
      Date.now(),
    )
    this.store.record(plan.id, node.task_id, "WORKSPACE_SELECTED", {
      attemptID: attempt.id,
      from: attempt.workspace,
      directory: this.directory,
      source,
      explicitBaseline: retry && command.baseCommit !== undefined,
      mode: "shared",
      reason: command.reason,
    })
    return retry && command.baseCommit !== undefined ? source : null
  }
  commandReconcile(db: Database, ctx: CommandContext, plan: PlanRow) {
    const { command, caller, baseVersion, ownerSession, reviewInput } = ctx
    if (!ownerSession || ownerSession.archived) throw new Error("Owner unavailable")
    let existingReviewInput = false
    if (reviewInput) {
      const { binding, evidence } = reviewInput
      if (
        !this.validArchitect(ownerSession) ||
        ownerSession.id !== binding.ownerSessionID ||
        binding.planID !== plan.id ||
        binding.expectedPlanVersion !== baseVersion ||
        binding.commandRequestID !== command.requestID ||
        !["running", "blocked"].includes(plan.state)
      )
        throw new Error("Review input reconciliation authorization or plan version changed")

      const latest = this.store
        .attempts(plan.id)
        .filter((attempt) => attempt.task_id === binding.taskID)
        .at(-1)
      const node = this.store.nodes(plan.id).find((item) => item.task_id === binding.taskID)
      const task = this.store.repository.get(binding.taskID)
      if (
        !latest ||
        latest.id !== binding.attemptID ||
        !["running", "verifying"].includes(latest.state) ||
        latest.session_id !== binding.sessionID ||
        latest.workspace !== binding.workspace ||
        latest.message_id !== binding.assignedMessageID ||
        !node ||
        node.state !== latest.state ||
        !task ||
        task.provenance.projectID !== binding.projectID ||
        task.provenance.projectDirectory !== binding.projectDirectory ||
        task.revision !==
          PlanInput.parse(JSON.parse(plan.body)).nodes.find(
            (item) => item.taskID === binding.taskID,
          )?.revision
      )
        throw new Error("Review input worker assignment changed during native observation")

      const policy = ModelPolicy.parse(JSON.parse(latest.policy).model)
      if (
        policy.providerID !== binding.model.providerID ||
        policy.id !== binding.model.id ||
        policy.variant !== binding.model.variant
      )
        throw new Error("Review input worker route changed during native observation")

      const aliases = db
        .query<{ id: number; payload: string }, [string, string]>(
          `SELECT id,payload FROM runner_transitions
       WHERE ${planIs(db, "runner_transitions")} AND task_id=? AND event='WORKER_REVIEW_INPUT_RECONCILED'
       ORDER BY id`,
        )
        .all(plan.id, binding.taskID)
      for (const row of aliases) {
        let prior: ReturnType<typeof parseReviewInputAlias>
        try {
          prior = parseReviewInputAlias(JSON.parse(row.payload))
        } catch {
          prior = undefined
        }
        if (!prior || prior.attemptID !== binding.attemptID) continue
        if (prior.reviewInputID !== binding.reviewInputID) continue
        if (
          !matchesReviewInputAlias(prior, {
            projectDirectory: binding.projectDirectory,
            projectID: binding.projectID,
            planID: binding.planID,
            taskID: binding.taskID,
            attemptID: binding.attemptID,
            sessionID: binding.sessionID,
            workspace: binding.workspace,
            assignedMessageID: binding.assignedMessageID,
            reviewInputID: binding.reviewInputID,
          }) ||
          prior.reviewRequestID !== evidence.reviewRequestID
        )
          throw new Error("Review input already has a different durable lineage relationship")
        existingReviewInput = true
        break
      }
    }
    if (
      this.store
        .effects(plan.id)
        .some((e) => ["intended", "uncertain"].includes(e.state) && !isRerunnableEffect(e.kind))
    )
      return {
        status: "blocked",
        reason: "Uncertain effects require conclusive host/artifact evidence",
        version: plan.version,
      }
    if (plan.state === "blocked") {
      db.query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=?",
      ).run(plan.id)
      for (const node of this.store.nodes(plan.id))
        if (
          node.state === "blocked" &&
          !this.store.attempts(plan.id).some((a) => a.task_id === node.task_id)
        )
          this.store.move(plan.id, node.task_id, "RECONCILE")
    }
    if (reviewInput && !existingReviewInput) {
      const { binding, evidence } = reviewInput
      this.store.record(plan.id, binding.taskID, "WORKER_REVIEW_INPUT_RECONCILED", {
        schemaVersion: 1,
        kind: "owner-reviewed-native-input-alias",
        source: "observed-native-review-input",
        runtimeSentMessage: false,
        projectDirectory: binding.projectDirectory,
        projectID: binding.projectID,
        planID: binding.planID,
        taskID: binding.taskID,
        attemptID: binding.attemptID,
        sessionID: binding.sessionID,
        workspace: binding.workspace,
        assignedMessageID: binding.assignedMessageID,
        reviewInputID: binding.reviewInputID,
        reviewRequestID: evidence.reviewRequestID,
        ownerSessionID: binding.ownerSessionID,
        commandRequestID: binding.commandRequestID,
        expectedPlanVersion: binding.expectedPlanVersion,
        model: binding.model,
        input: evidence.input,
        observation: evidence.observation,
      })
    }
    this.store.record(plan.id, null, "RECONCILE_REQUESTED", {
      caller,
      verificationEpoch: this.store.plan(plan.id)!.version,
      ...(reviewInput ? { reviewInputID: reviewInput.binding.reviewInputID } : {}),
    })
    return {
      status: "reconciling",
      version: this.store.plan(plan.id)!.version,
      ...(reviewInput
        ? {
            reviewInputID: reviewInput.binding.reviewInputID,
            relationshipRecorded: !existingReviewInput,
          }
        : {}),
    }
  }
}

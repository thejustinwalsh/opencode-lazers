import type { Database } from "bun:sqlite"
import { changeDispatchPause, changeSchedule, recordIntegration } from "./plan-control.ts"
import { GitObservations } from "./git-observations.ts"
import type {
  CommandContext,
  RetainedRepairRecoverySeed,
  RetainedRepairSeed,
  RetainedVerificationSeed,
} from "./runtime-helpers.ts"
import { workerAgent } from "./worker-agent.ts"
import {
  baseReachable,
  proofForArtifact,
  type BaseReach,
  type IntegrationProof,
} from "./integration-proof.ts"
import { knownTree } from "./identity-store.ts"
import type { HostSession } from "./host.ts"
import { CommandInput } from "./schema.ts"
import type { CommandInput as PlanCommand } from "./schema.ts"
import {
  PLAN_MOVED_RETRIES,
  PlanMovedDuringCommand,
  planCommandProblem,
  withoutLegacyVersion,
} from "./plan-commands.ts"
import type { PlanRow } from "./store.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { ArchitectSources } from "./architect-sources.ts"
import type { CleanupAudit } from "./cleanup-audit.ts"
import type { ContinuationPreparation } from "./continuation-preparation.ts"
import type { StartupSettlement } from "./startup-settlement.ts"
import type { AdoptionPreparation } from "./adoption-preparation.ts"
import type { RetainedRepairPreparation } from "./retained-repair-preparation.ts"
import type { RetainedVerificationPreparation } from "./retained-verification-preparation.ts"
import type { RetainedRepairRecords } from "./retained-repair-records.ts"
import type { Dispatch } from "./dispatch.ts"
import type { CommandsControl } from "./commands-control.ts"
import type { CommandsScope } from "./commands-scope.ts"
import type { CommandsRetained } from "./commands-retained.ts"
import type { CommandsRecovery } from "./commands-recovery.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `CommandPipeline` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type CommandPipelineDeps = {
  ensureArchitectOwner: ArchitectOwnership["ensureArchitectOwner"]
  assertSchedulerActive: ArchitectSources["assertSchedulerActive"]
  cleanupAuditDiagnostics: CleanupAudit["cleanupAuditDiagnostics"]
  assertCombinedVerificationResume: ContinuationPreparation["assertCombinedVerificationResume"]
  prepareResumeContinuation: ContinuationPreparation["prepareResumeContinuation"]
  prepareStartupSettlement: StartupSettlement["prepareStartupSettlement"]
  prepareAdoption: AdoptionPreparation["prepareAdoption"]
  prepareRetainedRepair: RetainedRepairPreparation["prepareRetainedRepair"]
  prepareReviewInputReconciliation: RetainedRepairPreparation["prepareReviewInputReconciliation"]
  retainedRepairRecoveryCurrent: RetainedRepairPreparation["retainedRepairRecoveryCurrent"]
  prepareRetainedVerification: RetainedVerificationPreparation["prepareRetainedVerification"]
  observeRetainedRepairCandidate: RetainedVerificationPreparation["observeRetainedRepairCandidate"]
  retainedRepairBackgroundProblem: RetainedRepairRecords["retainedRepairBackgroundProblem"]
  retainedRepairObservation: RetainedRepairRecords["retainedRepairObservation"]
  retainedRepairWorkerProblem: RetainedRepairRecords["retainedRepairWorkerProblem"]
  preparationAllowed: Dispatch["preparationAllowed"]
  commandRun: CommandsControl["commandRun"]
  commandCancel: CommandsControl["commandCancel"]
  commandReassign: CommandsControl["commandReassign"]
  commandTakeoverSubmit: CommandsControl["commandTakeoverSubmit"]
  commandAmendScope: CommandsScope["commandAmendScope"]
  commandSendBackDivergence: CommandsScope["commandSendBackDivergence"]
  divergenceHold: CommandsScope["divergenceHold"]
  commandAdoptDescendant: CommandsRetained["commandAdoptDescendant"]
  commandVerifyRetained: CommandsRetained["commandVerifyRetained"]
  commandSettleStartup: CommandsRetained["commandSettleStartup"]
  commandRetainedRepair: CommandsRetained["commandRetainedRepair"]
  commandReconcile: CommandsRecovery["commandReconcile"]
  commandResumeOrRetry: CommandsRecovery["commandResumeOrRetry"]
  validArchitect: ArchitectOwnership["validArchitect"]
  requestTick: () => Promise<void>
  wakeScheduler: ((delayMs?: number) => void) | undefined
}

/**
 * The command pipeline: admission, async preparation outside the transaction, the plan-moved retry,
 * and one `store.command` transaction that applies the action through its handler. Moved out of
 * `TaskRuntime` without rewriting; the private aliases below keep the member bodies identical to what
 * they were.
 */
export class CommandPipeline {
  private readonly ensureArchitectOwner: CommandPipelineDeps["ensureArchitectOwner"]
  private readonly assertSchedulerActive: CommandPipelineDeps["assertSchedulerActive"]
  private readonly cleanupAuditDiagnostics: CommandPipelineDeps["cleanupAuditDiagnostics"]
  private readonly assertCombinedVerificationResume: CommandPipelineDeps["assertCombinedVerificationResume"]
  private readonly prepareResumeContinuation: CommandPipelineDeps["prepareResumeContinuation"]
  private readonly prepareStartupSettlement: CommandPipelineDeps["prepareStartupSettlement"]
  private readonly prepareAdoption: CommandPipelineDeps["prepareAdoption"]
  private readonly prepareRetainedRepair: CommandPipelineDeps["prepareRetainedRepair"]
  private readonly prepareReviewInputReconciliation: CommandPipelineDeps["prepareReviewInputReconciliation"]
  private readonly retainedRepairRecoveryCurrent: CommandPipelineDeps["retainedRepairRecoveryCurrent"]
  private readonly prepareRetainedVerification: CommandPipelineDeps["prepareRetainedVerification"]
  private readonly observeRetainedRepairCandidate: CommandPipelineDeps["observeRetainedRepairCandidate"]
  private readonly retainedRepairBackgroundProblem: CommandPipelineDeps["retainedRepairBackgroundProblem"]
  private readonly retainedRepairObservation: CommandPipelineDeps["retainedRepairObservation"]
  private readonly retainedRepairWorkerProblem: CommandPipelineDeps["retainedRepairWorkerProblem"]
  private readonly preparationAllowed: CommandPipelineDeps["preparationAllowed"]
  private readonly commandRun: CommandPipelineDeps["commandRun"]
  private readonly commandCancel: CommandPipelineDeps["commandCancel"]
  private readonly commandReassign: CommandPipelineDeps["commandReassign"]
  private readonly commandTakeoverSubmit: CommandPipelineDeps["commandTakeoverSubmit"]
  private readonly commandAmendScope: CommandPipelineDeps["commandAmendScope"]
  private readonly commandSendBackDivergence: CommandPipelineDeps["commandSendBackDivergence"]
  private readonly divergenceHold: CommandPipelineDeps["divergenceHold"]
  private readonly commandAdoptDescendant: CommandPipelineDeps["commandAdoptDescendant"]
  private readonly commandVerifyRetained: CommandPipelineDeps["commandVerifyRetained"]
  private readonly commandSettleStartup: CommandPipelineDeps["commandSettleStartup"]
  private readonly commandRetainedRepair: CommandPipelineDeps["commandRetainedRepair"]
  private readonly commandReconcile: CommandPipelineDeps["commandReconcile"]
  private readonly commandResumeOrRetry: CommandPipelineDeps["commandResumeOrRetry"]
  private readonly validArchitect: CommandPipelineDeps["validArchitect"]
  private readonly requestTick: CommandPipelineDeps["requestTick"]
  private readonly wakeScheduler: CommandPipelineDeps["wakeScheduler"]

  constructor(
    private readonly core: RuntimeCore,
    deps: CommandPipelineDeps,
  ) {
    this.ensureArchitectOwner = (...args) => deps.ensureArchitectOwner(...args)
    this.assertSchedulerActive = (...args) => deps.assertSchedulerActive(...args)
    this.cleanupAuditDiagnostics = (...args) => deps.cleanupAuditDiagnostics(...args)
    this.assertCombinedVerificationResume = (...args) =>
      deps.assertCombinedVerificationResume(...args)
    this.prepareResumeContinuation = (...args) => deps.prepareResumeContinuation(...args)
    this.prepareStartupSettlement = (...args) => deps.prepareStartupSettlement(...args)
    this.prepareAdoption = (...args) => deps.prepareAdoption(...args)
    this.prepareRetainedRepair = (...args) => deps.prepareRetainedRepair(...args)
    this.prepareReviewInputReconciliation = (...args) =>
      deps.prepareReviewInputReconciliation(...args)
    this.retainedRepairRecoveryCurrent = (...args) => deps.retainedRepairRecoveryCurrent(...args)
    this.prepareRetainedVerification = (...args) => deps.prepareRetainedVerification(...args)
    this.observeRetainedRepairCandidate = (...args) => deps.observeRetainedRepairCandidate(...args)
    this.retainedRepairBackgroundProblem = (...args) =>
      deps.retainedRepairBackgroundProblem(...args)
    this.retainedRepairObservation = (...args) => deps.retainedRepairObservation(...args)
    this.retainedRepairWorkerProblem = (...args) => deps.retainedRepairWorkerProblem(...args)
    this.preparationAllowed = (...args) => deps.preparationAllowed(...args)
    this.commandRun = (...args) => deps.commandRun(...args)
    this.commandCancel = (...args) => deps.commandCancel(...args)
    this.commandReassign = (...args) => deps.commandReassign(...args)
    this.commandTakeoverSubmit = (...args) => deps.commandTakeoverSubmit(...args)
    this.commandAmendScope = (...args) => deps.commandAmendScope(...args)
    this.commandSendBackDivergence = (...args) => deps.commandSendBackDivergence(...args)
    this.divergenceHold = (...args) => deps.divergenceHold(...args)
    this.commandAdoptDescendant = (...args) => deps.commandAdoptDescendant(...args)
    this.commandVerifyRetained = (...args) => deps.commandVerifyRetained(...args)
    this.commandSettleStartup = (...args) => deps.commandSettleStartup(...args)
    this.commandRetainedRepair = (...args) => deps.commandRetainedRepair(...args)
    this.commandReconcile = (...args) => deps.commandReconcile(...args)
    this.commandResumeOrRetry = (...args) => deps.commandResumeOrRetry(...args)
    this.validArchitect = deps.validArchitect
    this.requestTick = deps.requestTick
    this.wakeScheduler = deps.wakeScheduler
  }

  private get store() {
    return this.core.store
  }

  private get host() {
    return this.core.host
  }

  private get directory() {
    return this.core.directory
  }

  /**
   * Async Git proofs a command needs, gathered before its transaction:
   * integration containment (`integrated`) and baseline
   * reachability (an explicit `baseCommit`).
   */
  async preflightProofs(command: CommandInput, plan: PlanRow) {
    const bases = new Map<string, BaseReach>()
    let integration: IntegrationProof | undefined
    if (command.baseCommit)
      bases.set(
        command.baseCommit,
        await baseReachable(
          this.directory,
          command.baseCommit,
          "HEAD",
          this.store.repository.read((db) => knownTree(db, command.baseCommit)),
        ),
      )
    if (command.action === "integrated") {
      const task = command.taskID
        ? this.store.nodes(plan.id).find((node) => node.task_id === command.taskID)
        : undefined
      const artifact = task?.artifact ?? plan.artifact
      if (artifact) {
        const attempt = command.taskID
          ? this.store
              .attempts(plan.id)
              .filter((candidate) => candidate.task_id === command.taskID)
              .at(-1)
          : undefined
        integration = await proofForArtifact(
          (run) => this.store.repository.read(run),
          this.directory,
          { artifact, attemptID: attempt?.id, base: attempt?.base_commit },
        )
      }
    }
    return { bases, integration }
  }
  async runCommand(input: unknown, caller: string, admission: boolean): Promise<unknown> {
    const command = CommandInput.parse(withoutLegacyVersion(input))
    if (admission && command.action !== "run")
      throw new Error("Only admission runs without an Architect caller")
    // The runtime samples host and Git facts asynchronously, then commits only
    // against the plan version it read first. A scheduler tick that moved the
    // plan in between sends the command back through the machine, bounded.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runCommandOnce(command, caller, admission)
      } catch (error) {
        if (!(error instanceof PlanMovedDuringCommand)) throw error
        if (attempt < PLAN_MOVED_RETRIES) continue
        const current = this.store.plan(command.planID)
        throw new Error(
          `Plan ${current?.state ?? "unknown"} changed repeatedly while ${command.action} was applied. ${
            current ? (planCommandProblem(current.state, command) ?? "Retry the command.") : ""
          }`.trim(),
          { cause: error },
        )
      }
    }
  }
  async runCommandOnce(command: PlanCommand, caller: string, admission: boolean): Promise<unknown> {
    const prior = this.store.priorCommand<unknown>(command.requestID, { command, caller })
    if (prior !== undefined) return prior
    // Resolve host facts before the transaction, then recheck against the version read here.
    const old = await this.admitCommandPlan(command, caller, admission)
    const baseVersion = old.version
    let continuedOwner: string | undefined
    const configuredWorker =
      command.action === "run" && !JSON.parse(old.body).workerModel
        ? await this.host.workerModel?.(workerAgent(JSON.parse(old.body).workerAgent))
        : undefined
    let ownerSession = await this.commandOwnerSession(command, old)
    // Integration and baseline proofs run before the transaction (they read Git
    // asynchronously) and are consumed, never recomputed, inside it.
    const preflight = await this.preflightProofs(command, old)
    const resumption =
      command.action === "resume" && command.taskID
        ? await this.prepareResumeContinuation(old, command, caller, ownerSession, command.taskID)
        : undefined
    if (command.action === "resume" && !command.taskID)
      this.assertCombinedVerificationResume(old, command, ownerSession)
    if (command.action === "run" && !this.validArchitect(ownerSession)) {
      ownerSession = await this.ensureArchitectOwner(old, ownerSession, false)
      continuedOwner = ownerSession.id
    }
    const adoptionSeed =
      command.action === "adopt-descendant"
        ? await this.prepareAdoption(old, command, caller, ownerSession)
        : undefined
    const retainedVerificationSeed =
      command.action === "verify-retained"
        ? await this.prepareRetainedVerification(old, command, caller, ownerSession)
        : undefined
    const retainedRepair =
      command.action === "retained-repair" && !this.divergenceHold(old, command.taskID)
        ? await this.prepareRetainedRepair(old, command, caller, ownerSession)
        : undefined
    const reviewInput = await this.prepareReviewInputReconciliation(
      old,
      command,
      caller,
      ownerSession,
    )
    const startupSettlement =
      command.action === "settle-startup"
        ? await this.prepareStartupSettlement(old, command, ownerSession)
        : undefined

    if (retainedVerificationSeed)
      ownerSession = await this.revalidateRetainedVerification(
        old,
        caller,
        retainedVerificationSeed,
        ownerSession,
      )
    if (retainedRepair)
      await this.revalidateRetainedRepair(old, caller, baseVersion, retainedRepair)
    if (resumption?.retainedRepairRecovery)
      await this.revalidateRetainedRepairRecovery(old, caller, resumption.retainedRepairRecovery)
    // Native cleanup observations are sampled outside the command transaction,
    // then published only if the recorded plan version is still current.
    const cleanupDiagnostics =
      command.action === "audit" ? await this.cleanupAuditDiagnostics(old) : undefined
    const obs = new GitObservations()
    const ctx: CommandContext = {
      command,
      caller,
      baseVersion,
      continuedOwner,
      configuredWorker,
      ownerSession,
      preflight,
      terminalContinuation: resumption?.terminalContinuation,
      terminalRepairContinuation: resumption?.terminalRepairContinuation,
      retainedRepairRecovery: resumption?.retainedRepairRecovery,
      adoptionSeed,
      retainedVerificationSeed,
      retainedRepair,
      reviewInput,
      startupSettlement,
      cleanupDiagnostics,
      obs,
    }
    const result = await obs.run(
      () =>
        this.store.command(command.requestID, { command, caller }, (db) =>
          this.applyCommandIn(db, ctx),
        ),
      () => this.assertSchedulerActive(),
    )
    if (commandWakesScheduler(command, result)) this.wakeScheduler?.()
    if (
      command.action === "verify-retained" ||
      command.action === "pause" ||
      command.action === "unpause"
    )
      await this.requestTick()
    return result
  }
  /** The plan a command may act on, with its owner adopted by the commanding Architect. */
  async admitCommandPlan(command: PlanCommand, caller: string, admission: boolean) {
    let old = this.store.plan(command.planID)
    if (!old) throw new Error("Plan not found")
    // The recorded state decides legality; reject before any asynchronous owner recovery effect.
    const unavailable = planCommandProblem(old.state, command)
    if (unavailable) throw new Error(unavailable)
    // The owner is advisory. Any live Architect of this project may command the
    // plan and is adopted as its owner; reading (audit) needs no Architect.
    if (command.action !== "audit" && !admission) {
      if (!this.validArchitect(await this.host.session(caller)))
        throw new Error("A live Architect session of this project must command the plan")
      if (caller !== old.owner && this.store.adoptPlanOwner(old.id, old.owner, caller))
        old = this.store.plan(command.planID)!
    }
    return old
  }
  async commandOwnerSession(
    command: PlanCommand,
    old: PlanRow,
  ): Promise<HostSession | null | undefined> {
    const target = command.action === "reassign" ? command.targetSessionID : old.owner
    if (
      ![
        "run",
        "pause",
        "unpause",
        "reassign",
        "reconcile",
        "resume",
        "retry",
        "adopt-descendant",
        "settle-startup",
        "retained-repair",
        "verify-retained",
      ].includes(command.action)
    )
      return undefined
    if (!target) throw new Error("Target session required")
    return this.host.session(target)
  }
  /** Re-reads the owner (and repair candidate) at the last moment before a retained verification reserves. */
  async revalidateRetainedVerification(
    old: PlanRow,
    caller: string,
    seed: RetainedVerificationSeed,
    ownerSession: HostSession | null | undefined,
  ) {
    const [currentOwner, currentPlan] = await Promise.all([
      this.host.session(caller),
      Promise.resolve(this.store.plan(old.id)),
    ])
    if (
      !this.validArchitect(currentOwner) ||
      !currentPlan ||
      currentPlan.revision !== seed.planRevision
    )
      throw new Error("Retained verification owner or plan revision changed before reservation")
    let observed = ownerSession
    const observeOwner = async () => {
      observed = await this.host.session(caller)
      if (!this.validArchitect(observed))
        throw new Error("Retained verification owner changed during final native admission")
    }
    if (seed.repair) {
      const latest = this.store.attempts(old.id).find((a) => a.id === seed.attemptID)
      if (!latest) throw new Error("Retained repair attempt disappeared before reservation")
      await this.observeRetainedRepairCandidate(currentPlan, latest, seed.repair, observeOwner)
    } else await observeOwner()
    return observed
  }
  async revalidateRetainedRepair(
    old: PlanRow,
    caller: string,
    baseVersion: number,
    retainedRepair: RetainedRepairSeed,
  ) {
    const attempt = this.store
      .attempts(old.id)
      .find((candidate) => candidate.id === retainedRepair.attemptID)
    if (!attempt)
      throw new Error("Retained repair attempt changed before final native revalidation")
    if (this.store.plan(old.id)?.version !== baseVersion) throw new PlanMovedDuringCommand()
    const observedOwner = await this.host.session(old.owner)
    if (!this.validArchitect(observedOwner) || observedOwner.id !== caller)
      throw new Error("Retained repair owner changed before final admission")
    // One worker read, compared against the observation the repair was prepared on, then the
    // owner is read again: a change in either after the worker read still stops admission.
    const worker = await this.host.session(attempt.session_id, { messages: true })
    const problem = this.retainedRepairWorkerProblem(
      old,
      attempt,
      worker,
      retainedRepair.nativeInputID,
      retainedRepair.model,
    )
    const backgroundProblem = this.retainedRepairBackgroundProblem(
      worker,
      retainedRepair.nativeInputID,
    )
    if (
      problem ||
      backgroundProblem ||
      !worker ||
      this.retainedRepairObservation(worker) !== retainedRepair.workerObservation
    )
      throw new Error(problem ?? "Retained worker changed before final admission")
    const confirmedOwner = await this.host.session(old.owner)
    if (!this.validArchitect(confirmedOwner) || confirmedOwner.id !== caller)
      throw new Error("Retained repair owner changed during final admission")
    if (this.store.plan(old.id)?.version !== baseVersion) throw new PlanMovedDuringCommand()
    if (!this.preparationAllowed(attempt))
      throw new Error("Retained repair authorization changed during final admission")
  }
  async revalidateRetainedRepairRecovery(
    old: PlanRow,
    caller: string,
    recovery: RetainedRepairRecoverySeed,
  ) {
    const currentOwner = await this.host.session(caller)
    const recoveryAttempt = this.store
      .attempts(old.id)
      .find((candidate) => candidate.id === recovery.attemptID)
    const currentWorker = await this.host.session(recovery.worker.id, { messages: true })
    if (
      !recoveryAttempt ||
      !this.validArchitect(currentOwner) ||
      currentOwner.id !== recovery.owner ||
      !currentWorker ||
      this.retainedRepairObservation(currentWorker) !== recovery.workerObservation ||
      currentWorker.messages.some((message) => message.id === recovery.failedMessageID) ||
      !this.retainedRepairRecoveryCurrent(old, recoveryAttempt, recovery)
    )
      throw new Error("Retained repair recovery changed during final native revalidation")
  }
  /** The command's one transaction: re-check the plan version, then apply the action. */
  applyCommandIn(db: Database, ctx: CommandContext) {
    const { command, continuedOwner, baseVersion } = ctx
    const plan = this.store.plan(command.planID)!
    if (plan.version !== baseVersion) throw new PlanMovedDuringCommand()
    const unavailableNow = planCommandProblem(plan.state, command)
    if (unavailableNow) throw new Error(unavailableNow)
    // Commit owner adoption with the original request receipt. If native
    // creation succeeds but this command fails, exact replay can recover it
    // without granting an old owner authority over a reassigned plan.
    if (continuedOwner) this.store.updatePlanOwner(plan.id, plan.owner, continuedOwner)
    const activeAdoptions = this.store.activeAdoptions(plan.id)
    if (activeAdoptions.length && !["adopt-descendant", "cancel", "audit"].includes(command.action))
      throw new Error(
        "A descendant adoption is pending; only its adoption or cancellation is allowed",
      )
    return this.dispatchCommandIn(db, ctx, plan)
  }
  dispatchCommandIn(db: Database, ctx: CommandContext, plan: PlanRow) {
    const { command, caller, ownerSession, preflight, cleanupDiagnostics, obs } = ctx
    if (command.action === "retained-repair")
      return this.divergenceHold(plan, command.taskID)
        ? this.commandSendBackDivergence(db, ctx, plan)
        : this.commandRetainedRepair(db, ctx, plan)
    if (command.action === "amend-scope") return this.commandAmendScope(db, ctx, plan)
    if (command.action === "adopt-descendant") return this.commandAdoptDescendant(ctx, plan)
    if (command.action === "verify-retained") return this.commandVerifyRetained(db, ctx, plan)
    if (command.action === "integrated")
      return recordIntegration(
        this.store,
        db,
        plan,
        command,
        obs.git(this.directory, ["branch", "--show-current"]),
        preflight.integration,
      )
    if (command.action === "pause" || command.action === "unpause")
      return changeDispatchPause(
        this.store,
        plan,
        command,
        caller,
        ownerSession,
        this.validArchitect(ownerSession),
      )
    if (command.action === "schedule")
      return changeSchedule(this.store, plan, command, caller, this.directory, preflight.bases)
    if (command.action === "audit")
      return {
        status: "audited",
        ...this.store.audit(),
        version: plan.version,
        ...(cleanupDiagnostics ? { cleanupDiagnostics } : {}),
      }
    if (command.action === "settle-startup") return this.commandSettleStartup(db, ctx, plan)
    if (command.action === "reassign") return this.commandReassign(db, ctx, plan)
    if (command.action === "cancel") return this.commandCancel(db, ctx, plan)
    if (command.action === "takeover-submit") return this.commandTakeoverSubmit(ctx, plan)
    if (command.action === "resume" || command.action === "retry")
      return this.commandResumeOrRetry(db, ctx, plan)
    if (command.action === "reconcile") return this.commandReconcile(db, ctx, plan)
    return this.commandRun(db, ctx, plan)
  }
}

/** Whether a command's outcome leaves work the scheduler should pick up now. */
function commandWakesScheduler(command: PlanCommand, result: unknown): boolean {
  const outcome = result as { status?: unknown; instructionUpdates?: unknown } | null | undefined
  const status = outcome?.status
  switch (command.action) {
    case "run":
      return status === "running"
    case "integrated":
      return status === "cleanup-requested"
    case "reconcile":
      return status === "reconciling"
    case "cancel":
      return status === "cancelling"
    case "resume":
      return (
        status === "resuming" ||
        status === "verification-resumed" ||
        status === "combined-verification-resumed"
      )
    case "retry":
      return status === "retrying"
    case "amend-scope":
      return (
        status === "scope-amended" &&
        Array.isArray(outcome?.instructionUpdates) &&
        outcome.instructionUpdates.length > 0
      )
    case "retained-repair":
      return status === "retained-repair-requested"
    default:
      return false
  }
}

import { section, sectionAsync } from "../diagnostics/stall-probe.ts"
import { terminalPlanStates as terminal } from "./plan-control.ts"

import { RetainedVerificationExecution } from "./retained-verification-execution.ts"
import { checkSettlementProblem, errorText } from "./runtime-helpers.ts"

import type { RuntimeCore } from "./runtime-core.ts"
import { RuntimeJournal } from "./runtime-journal.ts"
import { ArchitectOwnership } from "./architect-ownership.ts"
import { ArchitectSources } from "./architect-sources.ts"
import { ArchitectRenewal } from "./architect-renewal.ts"
import { Dispatch } from "./dispatch.ts"
import { WorkerObservation } from "./worker-observation.ts"
import { CleanupAudit } from "./cleanup-audit.ts"
import { AttemptAdvance } from "./attempt-advance.ts"
import { Cancellation } from "./cancellation.ts"
import { activeProfile, profileRevisionByID } from "../projects/profile-store.ts"
import { checkRunProfile } from "../projects/profile-runtime.ts"
import { CheckActivities } from "./check-activities.ts"
import { VerificationCandidate } from "./verification-candidate.ts"
import { EffectReconciliation } from "./effect-reconciliation.ts"
import { VerificationReview } from "./verification-review.ts"
import { PlanFinish } from "./plan-finish.ts"
import { PlanStep } from "./plan-step.ts"
import { CommandPipeline } from "./command-pipeline.ts"
import { CommandsRecovery } from "./commands-recovery.ts"
import { CommandsRetained } from "./commands-retained.ts"
import { CommandsScope } from "./commands-scope.ts"
import { CommandsControl } from "./commands-control.ts"
import { QueueReview } from "./queue-review.ts"
import { WorkerPreparation } from "./worker-preparation.ts"
import { ContinuationPreparation } from "./continuation-preparation.ts"
import { StartupSettlement } from "./startup-settlement.ts"
import { AdoptionPreparation } from "./adoption-preparation.ts"
import { RetainedRepairPreparation } from "./retained-repair-preparation.ts"
import { RetainedVerificationPreparation } from "./retained-verification-preparation.ts"
import { RetainedRepairRecords } from "./retained-repair-records.ts"
import { AdoptionExecution } from "./adoption-execution.ts"
import { WorktreeCleanup } from "./worktree-cleanup.ts"
import { OutcomeDelivery } from "./outcome-delivery.ts"
import { RecoveryBundles } from "./recovery-bundle.ts"
import { RecoveryDetector } from "../recovery/detector.ts"
import { TakeoverExecution, takeoverAwareHost, type TakeoverResult } from "./takeover.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"

import { privacyStats, safeText } from "../trajectory/privacy.ts"

import { defaultAuditorReport, type AuditorReport } from "./auditor-report.ts"

import { dirname, join } from "node:path"
import { fingerprint } from "../identity.ts"

import { verificationTimeoutDefaults } from "./verification-timeout.ts"
import type { VerificationTimeoutDefaults } from "./verification-timeout.ts"

import { defaultFallowPlanReview, defaultFallowReview, type FallowReview } from "./fallow-check.ts"

import { fallowConfigGate } from "../audit/fallow-gate.ts"
import { FallowConfigRequiredError } from "../audit/fallow-refusal.ts"

import { ensureNotesConfig } from "./change-identity.ts"
import {
  architectCacheWindowMs,
  architectReuseMaxContextTokens,
  type ArchitectRoutingOptions,
} from "./architect-routing.ts"
import { stampChangeIdentity } from "./identity-stamp.ts"

import type { HostSession, RunnerHost } from "./host.ts"
import { ModelPolicy, PlanInput } from "./schema.ts"

import type { PlanRow } from "./store.ts"
import { RunnerStore } from "./store.ts"

import type { StartTaskInput, StartTaskResult } from "../tasks/contract.ts"
import type { SchedulingInput, SchedulingPage } from "../tasks/scheduling-contract.ts"
import { TaskSchedulingRead } from "../tasks/scheduling-read.ts"

import { ModelMappingResolver } from "../models/mapping-resolver.ts"
import { ModelMappingStore } from "../models/mapping-store.ts"
import { ProgressRecorder } from "../progress/recorder.ts"

import { sharedScheduler } from "./scheduler-coordinator.ts"

import { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"

import { activeRetainedVerifications } from "./retained-verification/store.ts"
import {
  abortVerificationActivities,
  forgetVerificationActivity,
  startVerificationActivity,
  verificationActivityKey,
} from "./verification-activities.ts"
import type { VerificationActivity } from "./verification-activities.ts"

import type { RetainedDependencyInstaller } from "./retained-verification/isolation.ts"

const taskStartRequestID = (taskID: string) => `task-start:${taskID}:1`

// Recheck external/native facts periodically, but don't repeat full safety
// observations on every ordinary scheduler tick when durable facts are stable.
export type TaskRuntimeOptions = {
  delegatedAgentProjectKey?: string | Promise<string>
  /** Deprecated alias of `architectCacheWindowMs`. */
  architectIdleWindowMs?: number
  architectCacheWindowMs?: number
  /** Resume an interrupted worker without a command. Default true; tests of explicit resume turn it off. */
  autoResumeInterrupted?: boolean
  /** A busy worker with no observable progress this long is interrupted once. Default 30 minutes; 0 disables. */
  workerNoProgressWindowMs?: number
  /** Cancellation waits this long after interrupting a busy worker, then settles without its idleness. Default 30 seconds. */
  cancelIdleWaitMs?: number
  architectReuseMaxContextTokens?: number
  /**
   * Total tokens of a task past which the recovery detector raises a takeover concern, with
   * stronger wording as the spend doubles. Off when undefined. It never stops the worker.
   */
  /** A token ceiling, or a read of it taken at each evaluation. */
  workerSpendCeilingTokens?: number | (() => number | undefined)
  /** Takeover timing; tests shorten it. Defaults in `takeover.ts`. */
  takeoverHandoffWindowMs?: number
  takeoverStopWaitMs?: number
  takeoverPollMs?: number
  /** Review each candidate for introduced duplication and complexity. Default "on". */
  fallowReview?: "on" | "off"
  /** The review itself; defaults to the Fallow analyzer. Tests inject a stub. */
  fallowReviewRun?: FallowReview
  /** The combined-artifact review; defaults to the Fallow analyzer. Tests inject a stub. */
  fallowPlanReviewRun?: FallowReview
  /** The Auditor's baseline and follow-up report; defaults to the durable Fallow report. */
  auditorReportRun?: AuditorReport
  verificationTimeoutDefaults?: VerificationTimeoutDefaults
  now?: () => number
  architectPromptHook?: boolean
  requestTick?: () => Promise<void>
  wakeScheduler?: (delayMs?: number) => void
  retainedDependencyInstaller?: RetainedDependencyInstaller
  beforeRetainedCheckBegin?: (input: {
    operationID: string
    phase: "task"
    checkID: string
  }) => Promise<void>
}

/** A plan reconcile longer than this leaves a PLAN_STEP_SLOW record naming where the time went. */
const SLOW_RECONCILE_MS = 30_000

/** Only a plan submitted with `draft: true` stays a draft; older drafts predate that choice. */
function explicitDraft(plan: PlanRow): boolean {
  try {
    return (JSON.parse(plan.body) as { draft?: unknown }).draft === true
  } catch {
    return false
  }
}

/** Deprecated alias of `architectCacheWindowMs`; the plugin entry point still passes this option. */
export function architectIdleWindowMs(value: unknown): number {
  return architectCacheWindowMs(value)
}

export class TaskRuntime {
  private readonly outcomeDelivery: OutcomeDelivery
  private readonly recoveryBundles: RecoveryBundles
  private readonly recoveryDetector: RecoveryDetector
  private readonly takeovers: TakeoverExecution
  private readonly worktreeCleanup: WorktreeCleanup
  private readonly adoptionExecution: AdoptionExecution
  private readonly retainedVerificationExecution: RetainedVerificationExecution
  readonly owner = crypto.randomUUID()
  readonly progress: ProgressRecorder
  private readonly core: RuntimeCore
  private readonly journal: RuntimeJournal
  private readonly ownership: ArchitectOwnership
  private readonly sources: ArchitectSources
  private readonly renewal: ArchitectRenewal
  private readonly dispatchModule: Dispatch
  private readonly workerObservation: WorkerObservation
  private readonly cleanupAudit: CleanupAudit
  private readonly attemptAdvance: AttemptAdvance
  private readonly cancellation: Cancellation
  private readonly checkActivities: CheckActivities
  private readonly verificationCandidate: VerificationCandidate
  private readonly effectReconciliation: EffectReconciliation
  private readonly verificationReview: VerificationReview
  private readonly planFinish: PlanFinish
  private readonly planStep: PlanStep
  private readonly commandPipeline: CommandPipeline
  private readonly commandsRecovery: CommandsRecovery
  private readonly commandsRetained: CommandsRetained
  private readonly commandsScope: CommandsScope
  private readonly commandsControl: CommandsControl
  private readonly queueReview: QueueReview
  private readonly workerPreparation: WorkerPreparation
  private readonly continuationPreparation: ContinuationPreparation
  private readonly startupSettlement: StartupSettlement
  private readonly adoptionPreparation: AdoptionPreparation
  private readonly retainedRepairPreparation: RetainedRepairPreparation
  private readonly retainedVerificationPrep: RetainedVerificationPreparation
  private readonly repairRecords: RetainedRepairRecords
  private running = false
  private stopped = false
  private tickRequested = false
  private tickPromise: Promise<void> | undefined
  private readonly idleWaiters: (() => void)[] = []
  private readonly retainedVerificationAborts = new Map<string, AbortController>()
  private readonly retainedVerificationRuns = new Map<string, Promise<void>>()
  private readonly terminalRetainedVerificationCleanupChecks = new Map<
    string,
    { updatedAt: number; checkedAt: number }
  >()
  private readonly now: () => number
  private readonly architectRouting: ArchitectRoutingOptions
  private readonly autoResumeInterrupted: boolean
  private readonly fallowReviewEnabled: boolean
  private reconcileTiming: Map<string, number> | undefined
  private readonly slowRecorded = new Set<string>()
  private readonly workerNoProgressWindowMs: number
  private readonly cancelIdleWaitMs: number
  private readonly verificationTimeoutDefaults: VerificationTimeoutDefaults
  private readonly architectPromptHook: boolean
  private readonly requestTick: () => Promise<void>
  private readonly wakeScheduler: ((delayMs?: number) => void) | undefined
  private readonly retainedDependencyInstaller: RetainedDependencyInstaller | undefined
  private readonly beforeRetainedCheckBegin: TaskRuntimeOptions["beforeRetainedCheckBegin"]
  private readonly modelMappingResolver: ModelMappingResolver
  private readonly schedulingRead: TaskSchedulingRead
  readonly delegatedAgentCapacity: DelegatedAgentCapacity
  constructor(
    readonly store: RunnerStore,
    readonly host: RunnerHost,
    readonly projectID: string,
    progress?: ProgressRecorder,
    options: TaskRuntimeOptions = {},
  ) {
    // Attempts the Architect works itself have no native session: one choke point reads them as absent.
    this.host = takeoverAwareHost(host)
    this.progress = progress ?? new ProgressRecorder(store, projectID)
    this.now = options.now ?? Date.now
    this.delegatedAgentCapacity = new DelegatedAgentCapacity(
      store.repository,
      options.delegatedAgentProjectKey,
    )
    this.schedulingRead = new TaskSchedulingRead(
      store,
      this.now,
      {},
      undefined,
      this.delegatedAgentCapacity,
    )
    this.autoResumeInterrupted = options.autoResumeInterrupted ?? true
    this.fallowReviewEnabled = (options.fallowReview ?? "on") === "on"
    this.workerNoProgressWindowMs = options.workerNoProgressWindowMs ?? 30 * 60_000
    this.cancelIdleWaitMs = options.cancelIdleWaitMs ?? 30_000
    this.architectRouting = {
      architectCacheWindowMs: architectCacheWindowMs(
        options.architectCacheWindowMs ?? options.architectIdleWindowMs,
      ),
      architectReuseMaxContextTokens: architectReuseMaxContextTokens(
        options.architectReuseMaxContextTokens,
      ),
    }
    this.verificationTimeoutDefaults = verificationTimeoutDefaults(
      options.verificationTimeoutDefaults,
    )
    this.architectPromptHook = options.architectPromptHook ?? false
    this.requestTick = options.requestTick ?? (() => this.tick())
    this.wakeScheduler = options.wakeScheduler
    this.retainedDependencyInstaller = options.retainedDependencyInstaller
    this.beforeRetainedCheckBegin = options.beforeRetainedCheckBegin
    this.modelMappingResolver = new ModelMappingResolver(new ModelMappingStore(store.repository))
    this.core = {
      store: this.store,
      host: this.host,
      projectID: this.projectID,
      owner: this.owner,
      directory: this.directory,
      dataDirectory: this.dataDirectory,
      now: this.now,
      progress: this.progress,
    }
    this.journal = new RuntimeJournal(this.core, {
      workerObservationCurrent: (...args) =>
        this.workerObservation.workerObservationCurrent(...args),
      startupRecoveryAuthorization: (...args) =>
        this.startupSettlement.startupRecoveryAuthorization(...args),
      startupRecoveryAuthorityCurrent: (...args) =>
        this.startupSettlement.startupRecoveryAuthorityCurrent(...args),
      holdAdoption: (...args) => this.adoptionExecution.holdAdoption(...args),
    })
    this.checkActivities = new CheckActivities(this.core, {
      requestTick: () => this.requestTick(),
      verificationTimeoutDefaults: this.verificationTimeoutDefaults,
      retainedVerificationAborts: this.retainedVerificationAborts,
      retainedVerificationExecution: () => this.retainedVerificationExecution,
      adoptionExecution: () => this.adoptionExecution,
      reconcileEffect: (...args) => this.effectReconciliation.reconcileEffect(...args),
      checkProfile: (revisionID) => this.activeCheckProfile(revisionID),
    })
    this.verificationCandidate = new VerificationCandidate(this.core, {
      hold: (...args) => this.journal.hold(...args),
      effect: (...args) => this.journal.effect(...args),
      outcome: (...args) => this.journal.outcome(...args),
      uncertain: (...args) => this.journal.uncertain(...args),
      checkActivity: (...args) => this.checkActivities.checkActivity(...args),
      startCheckActivity: (...args) => this.checkActivities.startCheckActivity(...args),
      verificationDeadline: (...args) => this.checkActivities.verificationDeadline(...args),
      deadlineAwaitingTaskContinuation: (...args) =>
        this.checkActivities.deadlineAwaitingTaskContinuation(...args),
      verificationTarget: (...args) => this.checkActivities.verificationTarget(...args),
      runVerificationCheck: (...args) => this.checkActivities.runVerificationCheck(...args),
      preparationAllowed: (...args) => this.dispatchModule.preparationAllowed(...args),
      retainedRepairGeneration: (...args) => this.repairRecords.retainedRepairGeneration(...args),
      failAttempt: (...args) => this.verificationReview.failAttempt(...args),
      startAuditorReport: (...args) => this.verificationReview.startAuditorReport(...args),
      verificationTimeoutDefaults: this.verificationTimeoutDefaults,
      activeProfile: () => activeProfile(this.store.repository, this.directory),
      profileRevision: (id) => profileRevisionByID(this.store.repository, id),
    })
    this.effectReconciliation = new EffectReconciliation(this.core, {
      supersedeEffect: (...args) => this.journal.supersedeEffect(...args),
      uncertain: (...args) => this.journal.uncertain(...args),
      receipt: (...args) => this.journal.receipt(...args),
      checkActivity: (...args) => this.checkActivities.checkActivity(...args),
      resumeStartupRecovery: (...args) => this.startupSettlement.resumeStartupRecovery(...args),
      requestRetick: () => {
        this.tickRequested = true
      },
    })
    this.verificationReview = new VerificationReview(this.core, {
      hold: (...args) => this.journal.hold(...args),
      effect: (...args) => this.journal.effect(...args),
      checkActivity: (...args) => this.checkActivities.checkActivity(...args),
      startCheckActivity: (...args) => this.checkActivities.startCheckActivity(...args),
      acceptVerifiedAttempt: (...args) => this.verificationCandidate.acceptVerifiedAttempt(...args),
      captureAutomaticFixes: (...args) => this.verificationCandidate.captureAutomaticFixes(...args),
      collectCheckReceipts: (...args) => this.verificationCandidate.collectCheckReceipts(...args),
      commitVerificationCandidate: (...args) =>
        this.verificationCandidate.commitVerificationCandidate(...args),
      prepareVerificationCandidate: (...args) =>
        this.verificationCandidate.prepareVerificationCandidate(...args),
      recordAttemptArtifact: (...args) => this.verificationCandidate.recordAttemptArtifact(...args),
      verificationAwaitsTaskContinuation: (...args) =>
        this.verificationCandidate.verificationAwaitsTaskContinuation(...args),
      verificationCurrentGuard: (...args) =>
        this.verificationCandidate.verificationCurrentGuard(...args),
      retainedRepairGeneration: (...args) => this.repairRecords.retainedRepairGeneration(...args),
      retainedRepairForAttempt: (...args) => this.repairRecords.retainedRepairForAttempt(...args),
      stampIdentity: (...args) => this.stampIdentity(...args),
      fallowReviewEnabled: this.fallowReviewEnabled,
      delegatedAgentCapacity: this.delegatedAgentCapacity,
      fallowReviewRun: options.fallowReviewRun ?? defaultFallowReview,
      fallowPlanReviewRun: options.fallowPlanReviewRun ?? defaultFallowPlanReview,
      auditorReportRun: options.auditorReportRun ?? defaultAuditorReport,
    })
    this.planFinish = new PlanFinish(this.core, {
      effect: (...args) => this.journal.effect(...args),
      hold: (...args) => this.journal.hold(...args),
      outcome: (...args) => this.journal.outcome(...args),
      receipt: (...args) => this.journal.receipt(...args),
      uncertain: (...args) => this.journal.uncertain(...args),
      checkActivity: (...args) => this.checkActivities.checkActivity(...args),
      startCheckActivity: (...args) => this.checkActivities.startCheckActivity(...args),
      runVerificationCheck: (...args) => this.checkActivities.runVerificationCheck(...args),
      verificationDeadline: (...args) => this.checkActivities.verificationDeadline(...args),
      verificationTarget: (...args) => this.checkActivities.verificationTarget(...args),
      missingEvidence: (...args) => this.verificationReview.missingEvidence(...args),
      planFallowReview: (...args) => this.verificationReview.planFallowReview(...args),
      retainedRepairGeneration: (...args) => this.repairRecords.retainedRepairGeneration(...args),
    })
    this.ownership = new ArchitectOwnership(this.core, {
      architectRouting: this.architectRouting,
      journal: this.journal,
    })
    this.repairRecords = new RetainedRepairRecords(this.core, {
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
      preparationAllowed: (...args) => this.dispatchModule.preparationAllowed(...args),
      backgroundBlockReason: (...args) => this.backgroundBlockReason(...args),
    })
    this.retainedVerificationPrep = new RetainedVerificationPreparation(this.core, {
      retainedAttemptModel: (...args) => this.repairRecords.retainedAttemptModel(...args),
      retainedRepairForAttempt: (...args) => this.repairRecords.retainedRepairForAttempt(...args),
      retainedRepairObservation: (...args) => this.repairRecords.retainedRepairObservation(...args),
      retainedRepairWorkerProblem: (...args) =>
        this.repairRecords.retainedRepairWorkerProblem(...args),
      backgroundBlockReason: (...args) => this.backgroundBlockReason(...args),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.retainedRepairPreparation = new RetainedRepairPreparation(this.core, {
      transitionHistory: (...args) => this.repairRecords.transitionHistory(...args),
      retainedAttemptModel: (...args) => this.repairRecords.retainedAttemptModel(...args),
      retainedRepairObservation: (...args) => this.repairRecords.retainedRepairObservation(...args),
      retainedRepairWorkerProblem: (...args) =>
        this.repairRecords.retainedRepairWorkerProblem(...args),
      retainedRepairBackgroundProblem: (...args) =>
        this.repairRecords.retainedRepairBackgroundProblem(...args),
      retainedRepairForAttempt: (...args) => this.repairRecords.retainedRepairForAttempt(...args),
      preparationAllowed: (...args) => this.dispatchModule.preparationAllowed(...args),
      matchesWorkerInput: (...args) => this.workerObservation.matchesWorkerInput(...args),
      parseTransitionPayload: this.repairRecords.parseTransitionPayload.bind(this.repairRecords),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.adoptionPreparation = new AdoptionPreparation(this.core, {
      backgroundBlockReason: (...args) => this.backgroundBlockReason(...args),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.startupSettlement = new StartupSettlement(this.core, {
      preparationAllowed: (...args) => this.dispatchModule.preparationAllowed(...args),
      effect: (...args) => this.journal.effect(...args),
      uncertain: (...args) => this.journal.uncertain(...args),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.continuationPreparation = new ContinuationPreparation(this.core, {
      matchesWorkerInput: (...args) => this.workerObservation.matchesWorkerInput(...args),
      interruptedChecksFor: (...args) => this.planStep.interruptedChecksFor(...args),
      prepareRetainedRepairRecovery: (...args) =>
        this.retainedRepairPreparation.prepareRetainedRepairRecovery(...args),
      preparationAllowed: (...args) => this.dispatchModule.preparationAllowed(...args),
      retainedRepairForAttempt: (...args) => this.repairRecords.retainedRepairForAttempt(...args),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.workerPreparation = new WorkerPreparation(this.core, {
      effect: (...args) => this.journal.effect(...args),
      hold: (...args) => this.journal.hold(...args),
      receipt: (...args) => this.journal.receipt(...args),
      uncertain: (...args) => this.journal.uncertain(...args),
      promptAdmissionAllowed: (...args) => this.dispatchModule.promptAdmissionAllowed(...args),
      repairFailureBrief: (...args) => this.verificationReview.repairFailureBrief(...args),
      startAuditorReport: (...args) => this.verificationReview.startAuditorReport(...args),
      retainedRepairForAttempt: (...args) => this.repairRecords.retainedRepairForAttempt(...args),
      retainedRepairPromptCurrent: (...args) =>
        this.repairRecords.retainedRepairPromptCurrent(...args),
      sessionTitle: (...args) => this.ownership.sessionTitle(...args),
      startupWorkspaceReady: (...args) => this.startupSettlement.startupWorkspaceReady(...args),
      workerEvent: (...args) => this.workerObservation.workerEvent(...args),
      parseTransitionPayload: this.repairRecords.parseTransitionPayload.bind(this.repairRecords),
    })
    this.outcomeDelivery = new OutcomeDelivery({
      directory: this.directory,
      ensureArchitectOwner: (...args) => this.ownership.ensureArchitectOwner(...args),
      host: this.host,
      owner: this.owner,
      projectID: this.projectID,
      reconcilePlan: (...args) => this.reconcilePlan(...args),
      store: this.store,
      validArchitect: this.validArchitect.bind(this),
    })
    this.queueReview = new QueueReview(this.core, {
      backgroundBlockReason: (...args) => this.backgroundBlockReason(...args),
      outcome: (...args) => this.journal.outcome(...args),
      fallowGate: (...args) => this.fallowGate(...args),
      outcomeDelivery: this.outcomeDelivery,
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.recoveryDetector = new RecoveryDetector({
      store: this.store,
      handoff: new HandoffStore(this.store.repository),
      now: this.now,
      ...(options.workerSpendCeilingTokens === undefined
        ? {}
        : { spendCeilingTokens: options.workerSpendCeilingTokens }),
    })
    this.takeovers = new TakeoverExecution({
      store: this.store,
      host: this.host,
      now: this.now,
      validArchitect: this.validArchitect.bind(this),
      handoff: new HandoffStore(this.store.repository),
      notify: (planID, result) =>
        this.journal.outcome(planID, { status: "takeover-ready", takeover: result }, true),
      holdSlot: (db, attempt, attemptID, fromAttemptID) =>
        this.delegatedAgentCapacity.holdTaskSlotInTransaction(
          db,
          attempt,
          attemptID,
          fromAttemptID,
        ),
      ...(options.takeoverHandoffWindowMs === undefined
        ? {}
        : { handoffWindowMs: options.takeoverHandoffWindowMs }),
      ...(options.takeoverStopWaitMs === undefined
        ? {}
        : { stopWaitMs: options.takeoverStopWaitMs }),
      ...(options.takeoverPollMs === undefined ? {} : { pollMs: options.takeoverPollMs }),
    })
    this.commandsControl = new CommandsControl(this.core, {
      hold: (...args) => this.journal.hold(...args),
      resolveTaskDispatchRoute: (...args) => this.dispatchModule.resolveTaskDispatchRoute(...args),
      assertNoDispatchedDependents: (...args) =>
        this.retainedRepairPreparation.assertNoDispatchedDependents(...args),
      requestRetick: () => {
        this.tickRequested = true
      },
      takeovers: this.takeovers,
      retainedVerificationAborts: this.retainedVerificationAborts,
      parseTransitionPayload: this.repairRecords.parseTransitionPayload.bind(this.repairRecords),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.commandsScope = new CommandsScope(this.core, {
      repairAvailable: (...args) => this.verificationReview.repairAvailable(...args),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.commandsRetained = new CommandsRetained(this.core, {
      assertNoDispatchedDependents: (...args) =>
        this.retainedRepairPreparation.assertNoDispatchedDependents(...args),
      retainedRepairAttemptAccepted: (...args) =>
        this.retainedRepairPreparation.retainedRepairAttemptAccepted(...args),
      retainedRepairRecoveryCurrent: (...args) =>
        this.retainedRepairPreparation.retainedRepairRecoveryCurrent(...args),
      preparationAllowed: (...args) => this.dispatchModule.preparationAllowed(...args),
      retainedAttemptModel: (...args) => this.repairRecords.retainedAttemptModel(...args),
      assertRetainedVerificationScopeAvailable: (...args) =>
        this.retainedVerificationPrep.assertRetainedVerificationScopeAvailable(...args),
      retainedRepairCandidateCurrent: (...args) =>
        this.retainedVerificationPrep.retainedRepairCandidateCurrent(...args),
      retainedVerificationWorkspacePath: (...args) =>
        this.retainedVerificationPrep.retainedVerificationWorkspacePath(...args),
      assertStartupSettlementCurrent: (...args) =>
        this.startupSettlement.assertStartupSettlementCurrent(...args),
      delegatedAgentCapacity: this.delegatedAgentCapacity,
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.commandsRecovery = new CommandsRecovery(this.core, {
      assertTerminalContinuation: (...args) =>
        this.continuationPreparation.assertTerminalContinuation(...args),
      commandRecoverRetainedRepair: (...args) =>
        this.commandsRetained.commandRecoverRetainedRepair(...args),
      interruptedChecksFor: (...args) => this.planStep.interruptedChecksFor(...args),
      settledStartupEffect: (...args) => this.startupSettlement.settledStartupEffect(...args),
      hasMeaningfulWorkerProgress: (...args) =>
        this.startupSettlement.hasMeaningfulWorkerProgress(...args),
      preparationAllowed: (...args) => this.dispatchModule.preparationAllowed(...args),
      delegatedAgentCapacity: this.delegatedAgentCapacity,
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.commandPipeline = new CommandPipeline(this.core, {
      ensureArchitectOwner: (...args) => this.ownership.ensureArchitectOwner(...args),
      assertSchedulerActive: (...args) => this.sources.assertSchedulerActive(...args),
      cleanupAuditDiagnostics: (...args) => this.cleanupAudit.cleanupAuditDiagnostics(...args),
      assertCombinedVerificationResume: (...args) =>
        this.continuationPreparation.assertCombinedVerificationResume(...args),
      prepareResumeContinuation: (...args) =>
        this.continuationPreparation.prepareResumeContinuation(...args),
      prepareStartupSettlement: (...args) =>
        this.startupSettlement.prepareStartupSettlement(...args),
      prepareAdoption: (...args) => this.adoptionPreparation.prepareAdoption(...args),
      prepareRetainedRepair: (...args) =>
        this.retainedRepairPreparation.prepareRetainedRepair(...args),
      prepareReviewInputReconciliation: (...args) =>
        this.retainedRepairPreparation.prepareReviewInputReconciliation(...args),
      retainedRepairRecoveryCurrent: (...args) =>
        this.retainedRepairPreparation.retainedRepairRecoveryCurrent(...args),
      prepareRetainedVerification: (...args) =>
        this.retainedVerificationPrep.prepareRetainedVerification(...args),
      observeRetainedRepairCandidate: (...args) =>
        this.retainedVerificationPrep.observeRetainedRepairCandidate(...args),
      retainedRepairBackgroundProblem: (...args) =>
        this.repairRecords.retainedRepairBackgroundProblem(...args),
      retainedRepairObservation: (...args) => this.repairRecords.retainedRepairObservation(...args),
      retainedRepairWorkerProblem: (...args) =>
        this.repairRecords.retainedRepairWorkerProblem(...args),
      preparationAllowed: (...args) => this.dispatchModule.preparationAllowed(...args),
      commandRun: (...args) => this.commandsControl.commandRun(...args),
      commandCancel: (...args) => this.commandsControl.commandCancel(...args),
      commandReassign: (...args) => this.commandsControl.commandReassign(...args),
      commandTakeoverSubmit: (...args) => this.commandsControl.commandTakeoverSubmit(...args),
      commandAmendScope: (...args) => this.commandsScope.commandAmendScope(...args),
      commandSendBackDivergence: (...args) => this.commandsScope.commandSendBackDivergence(...args),
      divergenceHold: (...args) => this.commandsScope.divergenceHold(...args),
      commandAdoptDescendant: (...args) => this.commandsRetained.commandAdoptDescendant(...args),
      commandVerifyRetained: (...args) => this.commandsRetained.commandVerifyRetained(...args),
      commandSettleStartup: (...args) => this.commandsRetained.commandSettleStartup(...args),
      commandRetainedRepair: (...args) => this.commandsRetained.commandRetainedRepair(...args),
      commandReconcile: (...args) => this.commandsRecovery.commandReconcile(...args),
      commandResumeOrRetry: (...args) => this.commandsRecovery.commandResumeOrRetry(...args),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
      requestTick: this.requestTick,
      wakeScheduler: this.wakeScheduler,
    })
    this.recoveryBundles = new RecoveryBundles({
      store: this.store,
      host: this.host,
      directory: this.directory,
      projectID: this.projectID,
      owner: this.owner,
      now: this.now,
      validArchitect: this.validArchitect.bind(this),
      ensureArchitectOwner: (plan, previous, adopt) =>
        this.ownership.ensureArchitectOwner(plan, previous, adopt),
    })
    this.worktreeCleanup = new WorktreeCleanup({
      adoptionCheckReceiptMatches: (...args) =>
        this.adoptionExecution.adoptionCheckReceiptMatches(...args),
      adoptionCheckInputMatches: (...args) =>
        this.adoptionExecution.adoptionCheckInputMatches(...args),
      backgroundBlockReason: (...args) => this.backgroundBlockReason(...args),
      directory: this.directory,
      effect: (...args) => this.journal.effect(...args),
      host: this.host,
      now: (...args) => this.now(...args),
      outcome: (...args) => this.journal.outcome(...args),
      owner: this.owner,
      progress: this.progress,
      projectID: this.projectID,
      store: this.store,
      timed: (name, run) => this.timed(name, run),
    })
    this.adoptionExecution = new AdoptionExecution({
      adoptionArtifactScopeViolations: (...args) =>
        this.adoptionPreparation.adoptionArtifactScopeViolations(...args),
      adoptionWorkerIdle: (...args) => this.adoptionPreparation.adoptionWorkerIdle(...args),
      checkActivity: (...args) => this.checkActivities.checkActivity(...args),
      checkProfile: () => this.activeCheckProfile(),
      conflictingActiveAttempt: (...args) =>
        this.adoptionPreparation.conflictingActiveAttempt(...args),
      currentAdoptionInputFingerprint: (...args) =>
        this.adoptionPreparation.currentAdoptionInputFingerprint(...args),
      dataDirectory: this.dataDirectory,
      directory: this.directory,
      effect: (...args) => this.journal.effect(...args),
      host: this.host,
      missingEvidence: (...args) => this.verificationReview.missingEvidence(...args),
      outcome: (...args) => this.journal.outcome(...args),
      owner: this.owner,
      projectID: this.projectID,
      receipt: (...args) => this.journal.receipt(...args),
      reconcileEffect: (...args) => this.effectReconciliation.reconcileEffect(...args),
      reviewedAdoptionBaseline: (...args) =>
        this.adoptionPreparation.reviewedAdoptionBaseline(...args),
      startCheckActivity: (...args) => this.checkActivities.startCheckActivity(...args),
      store: this.store,
      validArchitect: this.validArchitect.bind(this),
      verificationTimeoutDefaults: this.verificationTimeoutDefaults,
    })
    this.retainedVerificationExecution = new RetainedVerificationExecution({
      checkActivity: (...args) => this.checkActivities.checkActivity(...args),
      dataDirectory: this.dataDirectory,
      directory: this.directory,
      host: this.host,
      now: (...args) => this.now(...args),
      observeRetainedRepairCandidate: (...args) =>
        this.retainedVerificationPrep.observeRetainedRepairCandidate(...args),
      outcome: (...args) => this.journal.outcome(...args),
      owner: this.owner,
      projectID: this.projectID,
      beforeRetainedCheckBegin: this.beforeRetainedCheckBegin,
      recoverCancelledRetainedChecks: (...args) =>
        this.checkActivities.recoverCancelledRetainedChecks(...args),
      retainedDependencyInstaller: this.retainedDependencyInstaller,
      retainedRepairCandidateCurrent: (...args) =>
        this.retainedVerificationPrep.retainedRepairCandidateCurrent(...args),
      retainedVerificationAborts: this.retainedVerificationAborts,
      retainedVerificationWorkspacePath: (...args) =>
        this.retainedVerificationPrep.retainedVerificationWorkspacePath(...args),
      runVerificationCheck: (...args) => this.checkActivities.runVerificationCheck(...args),
      startCheckActivity: (...args) => this.checkActivities.startCheckActivity(...args),
      store: this.store,
      terminalRetainedVerificationCleanupChecks: this.terminalRetainedVerificationCleanupChecks,
      validArchitect: this.validArchitect.bind(this),
      verificationDeadline: (...args) => this.checkActivities.verificationDeadline(...args),
      verificationTarget: (...args) => this.checkActivities.verificationTarget(...args),
    })
    this.planStep = new PlanStep(this.core, {
      advanceAttempt: (...args) => this.attemptAdvance.advanceAttempt(...args),
      architectRoute: (...args) => this.ownership.architectRoute(...args),
      recordArchitectRoute: (...args) => this.ownership.recordArchitectRoute(...args),
      ensureArchitectOwner: (...args) => this.ownership.ensureArchitectOwner(...args),
      cancelCheckActivities: (...args) => this.checkActivities.cancelCheckActivities(...args),
      reconcileCancelledCheckActivities: (...args) =>
        this.checkActivities.reconcileCancelledCheckActivities(...args),
      recoverCancelledRetainedChecks: (...args) =>
        this.checkActivities.recoverCancelledRetainedChecks(...args),
      retainedCheckSettlementProblem: (...args) =>
        this.checkActivities.retainedCheckSettlementProblem(...args),
      cancelReservedAttempt: (...args) => this.cancellation.cancelReservedAttempt(...args),
      cancelWorkers: (...args) => this.cancellation.cancelWorkers(...args),
      command: (...args) => this.command(...args),
      considerArchitectRenewal: (...args) => this.renewal.considerArchitectRenewal(...args),
      continueArchitectRenewal: (...args) => this.renewal.continueArchitectRenewal(...args),
      dispatch: (...args) => this.dispatchModule.dispatch(...args),
      integratedPrerequisiteBaseline: (...args) =>
        this.dispatchModule.integratedPrerequisiteBaseline(...args),
      preparationAllowed: (...args) => this.dispatchModule.preparationAllowed(...args),
      taskDependencyIDs: (...args) => this.dispatchModule.taskDependencyIDs(...args),
      taskDependencyIntegration: (...args) =>
        this.dispatchModule.taskDependencyIntegration(...args),
      finish: (...args) => this.planFinish.finish(...args),
      hold: (...args) => this.journal.hold(...args),
      outcome: (...args) => this.journal.outcome(...args),
      holdAbandonedTakeover: (...args) => this.commandsControl.holdAbandonedTakeover(...args),
      reconcileEffect: (...args) => this.effectReconciliation.reconcileEffect(...args),
      retainedRepairForAttempt: (...args) => this.repairRecords.retainedRepairForAttempt(...args),
      settledStartupEffect: (...args) => this.startupSettlement.settledStartupEffect(...args),
      verify: (...args) => this.verificationReview.verify(...args),
      requestRetick: () => {
        this.tickRequested = true
      },
      adoptionExecution: this.adoptionExecution,
      takeovers: this.takeovers,
      worktreeCleanup: this.worktreeCleanup,
      delegatedAgentCapacity: this.delegatedAgentCapacity,
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
      timed: (name, run) => this.timed(name, run),
    })
    this.renewal = new ArchitectRenewal(this.core, {
      architectPromptHook: this.architectPromptHook,
      ownership: this.ownership,
      sources: {
        inspectArchitectSourcePage: (...args) => this.sources.inspectArchitectSourcePage(...args),
        inspectArchitectSourceSweep: (...args) => this.sources.inspectArchitectSourceSweep(...args),
      },
    })
    this.dispatchModule = new Dispatch(this.core, {
      delegatedAgentCapacity: this.delegatedAgentCapacity,
      modelMappingResolver: this.modelMappingResolver,
      fallowReviewEnabled: this.fallowReviewEnabled,
      fallowGate: () => this.fallowGate(),
      prepareWorker: (...args) => this.workerPreparation.prepareWorker(...args),
      startupRecoveryAuthorization: (...args) =>
        this.startupSettlement.startupRecoveryAuthorization(...args),
      startupRecoveryAuthorityCurrent: (...args) =>
        this.startupSettlement.startupRecoveryAuthorityCurrent(...args),
      journal: this.journal,
    })
    this.workerObservation = new WorkerObservation(this.core, {
      sameModel: (...args) => this.repairRecords.sameModel(...args),
      journal: this.journal,
    })
    this.cleanupAudit = new CleanupAudit(this.core)
    this.attemptAdvance = new AttemptAdvance(this.core, {
      autoResumeInterrupted: this.autoResumeInterrupted,
      workerNoProgressWindowMs: this.workerNoProgressWindowMs,
      command: (...args) => this.command(...args),
      prepareWorker: (...args) => this.workerPreparation.prepareWorker(...args),
      verify: (...args) => this.verificationReview.verify(...args),
      failAttempt: (...args) => this.verificationReview.failAttempt(...args),
      validArchitect: this.validArchitect.bind(this),
      observeUsage: (...args) => this.dispatchModule.observeUsage(...args),
      journal: this.journal,
      workerObservation: this.workerObservation,
    })
    this.cancellation = new Cancellation(this.core, {
      cancelIdleWaitMs: this.cancelIdleWaitMs,
      observeUsage: (...args) => this.dispatchModule.observeUsage(...args),
      journal: this.journal,
      workerObservation: this.workerObservation,
    })
    this.sources = new ArchitectSources(this.core, {
      isStopped: () => this.stopped,
      ownership: this.ownership,
      renewalEvent: (...args) => this.renewal.renewalEvent(...args),
    })
  }
  get directory() {
    return this.store.repository.projectDirectory
  }

  private identityStamping: Promise<void> | undefined
  private identityStampedAt = Number.NEGATIVE_INFINITY
  private notesConfigured = false

  stampIdentity(force = false): Promise<void> {
    if (this.identityStamping) return this.identityStamping
    if (!force && this.now() - this.identityStampedAt < 30_000) return Promise.resolve()
    this.identityStampedAt = this.now()
    const running: Promise<void> = sectionAsync("stampIdentity", async () => {
      try {
        if (!this.notesConfigured) {
          await ensureNotesConfig(this.directory)
          this.notesConfigured = true
        }
        await stampChangeIdentity(
          {
            read: (run) => this.store.repository.read(run),
            write: (run) => this.store.repository.atomic(run),
          },
          this.directory,
          { projectDirectory: this.directory },
        )
      } catch {
        // Identity is derived, additive data; the next call repairs any gap.
      }
    }).finally(() => {
      if (this.identityStamping === running) this.identityStamping = undefined
    })
    this.identityStamping = running
    return running
  }
  get dataDirectory() {
    return join(dirname(this.store.repository.path), "runner")
  }

  /** The profile for a check run: a verify effect's pinned revision, else the active one. */
  private activeCheckProfile(revisionID?: number) {
    const active =
      revisionID === undefined
        ? activeProfile(this.store.repository, this.directory)
        : profileRevisionByID(this.store.repository, revisionID)
    return active ? checkRunProfile(active) : undefined
  }

  readScheduling(input: SchedulingInput): Promise<SchedulingPage> {
    return this.schedulingRead.read(input)
  }

  async command(input: unknown, caller: string): Promise<unknown> {
    return this.commandPipeline.runCommand(input, caller, false)
  }

  /**
   * Admission is the scheduler's act, not an Architect command: a plan is
   * admitted when it is submitted or started, whoever submitted it.
   */
  private admitPlan(plan: PlanRow, requestID: string) {
    return this.commandPipeline.runCommand(
      { requestID, planID: plan.id, action: "run" },
      plan.owner,
      true,
    )
  }

  /**
   * `lz-request-handoff`: one blocking call that tells the worker, waits for its handoff within
   * the window, stops it and returns the handoff. A repeated call with the same requestID joins
   * the same takeover; the scheduler finishes one whose call was cut short.
   */
  takeover(input: unknown, caller: string, signal?: AbortSignal): Promise<TakeoverResult> {
    return this.takeovers.run(input as never, caller, signal)
  }

  /** `lz-takeover-handoff`: the worker's slim handoff for an open takeover; never rejected for shape. */
  takeoverHandoff(input: unknown, sessionID: string) {
    return this.takeovers.recordWorkerHandoff(input, sessionID)
  }

  /**
   * Submitting a plan admits it: the scheduler runs its tasks with no separate
   * Architect `run`. Base-commit and model-route preflight stay in admission.
   * A plan is saved as a draft only when the Architect explicitly asks.
   */
  /** The base the audit of the attempt running in `sessionID` measures from; none for other sessions. */
  attemptBaseForSession(sessionID: string): string | undefined {
    const row = this.store.read((db) =>
      db
        .query<{ plan_id: string; id: string }, [string]>(
          "SELECT plan_id,id FROM runner_attempts WHERE session_id=?",
        )
        .get(sessionID),
    )
    const attempt = row && this.store.attempts(row.plan_id).find((a) => a.id === row.id)
    return attempt ? this.verificationReview.taskChainBase(attempt) : undefined
  }

  /** The refusal to queue work while the review is on and the project has no Fallow config. */
  fallowGate() {
    return fallowConfigGate({
      enabled: this.fallowReviewEnabled,
      directory: this.directory,
      repository: this.store.repository,
    })
  }

  async submitPlan(input: unknown, owner: string) {
    const refused = await this.fallowGate()
    if (refused) return refused
    const receipt = this.store.submit(input, owner, this.verificationTimeoutDefaults)
    const plan = this.store.plan(receipt.planID)
    if (!plan || plan.state !== "draft" || explicitDraft(plan)) return receipt
    await this.admitPlan(plan, `submit-admit:${plan.id}`)
    await this.requestTick()
    return { ...receipt, status: "submitted", admitted: true }
  }

  async startTask(input: StartTaskInput): Promise<StartTaskResult> {
    const actor = await this.host.session(input.sessionID)
    if (!actor || actor.archived || actor.projectID !== this.projectID)
      throw new Error("Start requires a live session in this project")

    const task = this.store.repository.get(input.taskID)
    if (
      !task ||
      task.provenance.projectDirectory !== this.directory ||
      task.provenance.projectID !== this.projectID
    )
      throw new Error("Task is not available in this project")
    if (task.revision !== input.revision) throw new Error("Stale task revision")
    if (this.store.repository.taskDisposition(task.id))
      throw new Error("Task has been retired; inspect its disposition")

    let existing = this.store.execution(task.id)
    // Read the native implementor selection, not the Architect's model. A plan
    // already carrying an explicit route keeps that route unchanged.
    let workerModel: ModelPolicy | undefined
    if (!existing) {
      workerModel = await this.host.workerModel?.()
      existing = this.store.execution(task.id)
      if (!existing && !workerModel)
        throw new Error("Select an implementor model in native OpenCode agent configuration")
    }
    let plan: PlanRow
    let created = false
    if (existing) {
      plan = this.store.plan(existing.planID)!
      if (plan.state !== "draft" || !["queued", "ready"].includes(existing.state)) {
        if (plan.state === "running" && ["queued", "ready"].includes(existing.state))
          await this.requestTick()
        return { status: "existing", planID: plan.id, state: this.store.execution(task.id)!.state }
      }
    } else {
      const refused = await this.fallowGate()
      if (refused) throw new FallowConfigRequiredError(refused)
      if (task.status !== "submitted") throw new Error("Task cannot be started")
      if (task.provenance.startingRevision.kind !== "git")
        throw new Error("Task has no committed starting revision")
      const proposal = task.proposal
      const receipt = this.store.submit(
        {
          requestID: taskStartRequestID(task.id),
          objective: proposal.objective,
          baseCommit: task.provenance.startingRevision.commit,
          workspaceMode: "shared",
          nodes: [{ taskID: task.id, revision: task.revision }],
          dependencies: [],
          integrationOrder: [task.id],
          verification: proposal.verification,
          acceptance: proposal.acceptance,
          dispositions: [],
        },
        task.provenance.sessionID,
        this.verificationTimeoutDefaults,
      )
      plan = this.store.plan(receipt.planID)!
      created = true
    }

    if (plan.state === "draft") await this.admitPlan(plan, `task-start-run:${task.id}:1`)
    await this.requestTick()
    const execution = this.store.execution(task.id)
    if (!execution) throw new Error("Runtime did not record task execution")
    return {
      status: created ? "started" : "existing",
      planID: execution.planID,
      state: execution.state,
    }
  }

  private taskStartID(plan: PlanRow): string | undefined {
    try {
      const body = PlanInput.parse(JSON.parse(plan.body))
      const taskID = body.nodes.length === 1 ? body.nodes[0]?.taskID : undefined
      return taskID && body.requestID === taskStartRequestID(taskID) ? taskID : undefined
    } catch {
      return undefined
    }
  }

  private validArchitect(session: HostSession | null | undefined): session is HostSession {
    return this.ownership.validArchitect(session)
  }

  observeArchitectPrompt(...args: Parameters<ArchitectSources["observeArchitectPrompt"]>) {
    return this.sources.observeArchitectPrompt(...args)
  }

  observeArchitectSourceEvent(
    ...args: Parameters<ArchitectSources["observeArchitectSourceEvent"]>
  ) {
    return this.sources.observeArchitectSourceEvent(...args)
  }

  private get sourceResyncPending() {
    return this.sources.sourceResyncPending
  }

  flushSourceInvalidations(...args: Parameters<ArchitectSources["flushSourceInvalidations"]>) {
    return this.sources.flushSourceInvalidations(...args)
  }

  recordArchitectContinuity(...args: Parameters<ArchitectSources["recordArchitectContinuity"]>) {
    return this.sources.recordArchitectContinuity(...args)
  }

  inspectArchitectSourceMessages(
    ...args: Parameters<ArchitectSources["inspectArchitectSourceMessages"]>
  ) {
    return this.sources.inspectArchitectSourceMessages(...args)
  }

  async tick() {
    if (this.stopped) return
    if (this.tickPromise) {
      this.tickRequested = true
      await this.tickPromise
      if (this.tickRequested && !this.stopped) {
        this.tickRequested = false
        await this.tick()
      }
      return
    }
    const current = sectionAsync("tick", () => this.runTick())
    this.tickPromise = current
    try {
      await current
    } finally {
      if (this.tickPromise === current) this.tickPromise = undefined
      if (this.tickRequested && !this.stopped) {
        this.tickRequested = false
        await this.tick()
      }
    }
  }

  private async reconcilePlan(
    planID: string,
    fence: number,
    phase: "step" | "cleanup" | "delivery",
    run: () => void | Promise<void>,
  ) {
    const timing = new Map<string, number>()
    this.reconcileTiming = timing
    const started = this.now()
    try {
      await sectionAsync("tick:plan", async () => run())
    } catch (error) {
      this.store.fenced(this.owner, fence, () => {
        if (!this.store.plan(planID)) return
        this.store.recordOnce(planID, null, `PLAN_${phase.toUpperCase()}_FAILED`, {
          error: safeText(errorText(error), privacyStats()),
        })
      })
    } finally {
      this.reconcileTiming = undefined
      this.recordSlowReconcile(planID, phase, this.now() - started, timing, fence)
    }
  }

  /** Time an awaited host or runtime call inside the plan reconcile in progress. */
  private async timed<T>(name: string, run: () => Promise<T>): Promise<T> {
    const timing = this.reconcileTiming
    const started = this.now()
    try {
      return await sectionAsync(name, run)
    } finally {
      if (timing) timing.set(name, (timing.get(name) ?? 0) + (this.now() - started))
    }
  }

  /** Diagnostics only: a journal record, never a state change, and never a failure. */
  private recordSlowReconcile(
    planID: string,
    phase: "step" | "cleanup" | "delivery",
    ms: number,
    timing: Map<string, number>,
    fence: number,
  ) {
    if (ms <= SLOW_RECONCILE_MS || this.slowRecorded.has(`${planID}:${phase}`)) return
    this.slowRecorded.add(`${planID}:${phase}`)
    const sections = [...timing]
      .map(([name, sectionMs]) => ({ name, ms: sectionMs }))
      .sort((left, right) => right.ms - left.ms)
      .slice(0, 8)
    try {
      this.store.fenced(this.owner, fence, () => {
        if (this.store.plan(planID))
          this.store.record(planID, null, "PLAN_STEP_SLOW", { ms, phase, sections })
      })
    } catch {
      // Timing facts never affect scheduling.
    }
  }

  private async runTick() {
    this.slowRecorded.clear()
    this.running = true
    let heartbeat: ReturnType<typeof sharedScheduler.register> | undefined
    try {
      const fence = section("tick:claim", () => this.store.claim(this.owner))
      if (fence === null) {
        // Another owner's lease is still live. Come back when it lapses rather than a full interval later.
        this.wakeScheduler?.(this.store.leaseRetryDelayMs(this.now()))
        return
      }
      if (this.sourceResyncPending) this.observeArchitectSourceEvent()
      section("tick:flushSourceInvalidations", () => this.flushSourceInvalidations())
      let heartbeatFailed = false
      let heartbeatError: unknown
      heartbeat = sharedScheduler.register(
        JSON.stringify(["lease", this.owner, fence]),
        {
          intervalMs: 10000,
          run: () => {
            this.store.renew(this.owner, fence)
          },
          onError: (error) => {
            heartbeatFailed = true
            heartbeatError = error
          },
        },
        10000,
      )
      // A lease only selects a reconciler; it never proves an old side effect stopped.
      for (const renewal of section("tick:architectRenewals", () =>
        this.store.architectRenewalsNeedingRecovery(),
      )) {
        try {
          await sectionAsync("tick:continueArchitectRenewal", () =>
            this.renewal.continueArchitectRenewal(renewal, fence),
          )
        } catch (error) {
          // A recorded native recovery failure stays retryable without blocking
          // dispatch for plans outside that renewal.
          this.store.fenced(this.owner, fence, () => {
            const recordedFailure = this.store.architectRenewal(renewal.id)
            if (
              recordedFailure?.state !== renewal.state ||
              recordedFailure.error !== errorText(error)
            )
              throw error
          })
        }
      }
      if (heartbeatFailed) throw heartbeatError
      await sectionAsync("tick:reconcileArchitectSources", () =>
        this.sources.reconcileArchitectSources(fence),
      )
      const retainedOperations = section("tick:activeRetained", () =>
        this.store.atomic((db) => activeRetainedVerifications(db, this.directory)),
      )
      for (const operation of retainedOperations) {
        if (this.retainedVerificationRuns.has(operation.id)) continue
        const id = `retained-advance:${operation.id}`
        const key = verificationActivityKey(this.store.repository.path, id)
        const identity = fingerprint({ operationID: operation.id })
        const { activity } = startVerificationActivity({
          databasePath: this.store.repository.path,
          key,
          identity,
          owner: this.owner,
          metadata: {
            kind: "retained-advance",
            projectDirectory: this.directory,
            planID: operation.planID,
            taskID: operation.taskID,
            attemptID: operation.attemptID,
            operationID: operation.id,
          },
          run: async (signal) => {
            try {
              await this.retainedVerificationExecution.advanceRetainedVerification(
                operation,
                fence,
                signal,
              )
            } catch (error) {
              if (!signal.aborted)
                await this.retainedVerificationExecution.failRetainedVerification(
                  operation,
                  errorText(error),
                  fence,
                )
              throw error
            }
          },
        })
        const running = activity.promise
        this.retainedVerificationRuns.set(operation.id, running)
        const finished = () => {
          if (this.retainedVerificationRuns.get(operation.id) === running)
            this.retainedVerificationRuns.delete(operation.id)
          forgetVerificationActivity(key, identity)
        }
        void running.then(finished, finished)
      }
      await sectionAsync("tick:reconcileTerminalRetained", () =>
        this.retainedVerificationExecution.reconcileTerminalRetainedVerifications(fence),
      )
      await sectionAsync("tick:settleStaleAttempts", () =>
        this.attemptAdvance.settleStaleAttempts(fence),
      )
      for (const planID of section("tick:closeoutReviewPlanIDs", () =>
        this.store.closeoutReviewPlanIDs(),
      )) {
        const plan = this.store.plan(planID)!
        this.journal.outcome(
          planID,
          {
            status: plan.state,
            artifact: plan.artifact,
            reason: plan.reason,
            closeoutReminder: true,
          },
          true,
        )
      }
      await sectionAsync("tick:fallowConfigHolds", () =>
        this.queueReview.releaseFallowConfigHolds(fence),
      )
      const waits: Parameters<QueueReview["requestQueueReview"]>[0] = []
      let closeoutDelivered = false
      for (const candidate of section("tick:runnablePlans", () =>
        this.store.runnablePlans(terminal),
      )) {
        if (!closeoutDelivered && candidate.queue_rank === 0) {
          await this.outcomeDelivery.deliver(fence, true)
          closeoutDelivered = true
        }
        await this.reconcilePlan(candidate.id, fence, "step", async () => {
          // The body is read only for the plan being stepped, never for the whole candidate list.
          let plan = this.store.plan(candidate.id)
          if (!plan) return
          if (plan.state === "draft") {
            // Only an explicit draft waits. Every other draft is admitted: the request is the authorization.
            if (explicitDraft(plan)) return
            const taskID = this.taskStartID(plan)
            await this.admitPlan(
              plan,
              taskID ? `task-start-run:${taskID}:1` : `submit-admit:${plan.id}`,
            )
            plan = this.store.plan(plan.id)!
          }
          // A live retained verification owns the stopped plan until it records pass or fail.
          if (
            plan.state !== "cancelling" &&
            this.store.atomic((db) => activeRetainedVerifications(db, this.directory, plan.id))
              .length > 0
          )
            return
          const wait = await sectionAsync("tick:step", () => this.planStep.step(plan, fence))
          if (wait) waits.push(wait)
        })
        if (heartbeatFailed) throw heartbeatError
      }
      if (waits.length)
        await this.reconcilePlan(waits[0]!.planID, fence, "step", () =>
          this.queueReview.requestQueueReview(waits, fence),
        )
      // Worktree cleanup of cancelled and blocked plans holds no dispatch reservation, so it runs
      // after the plans that can make progress: a slow removal delays only itself.
      const terminalCleanupPlanIDs = section("tick:terminalCleanupPlanIDs", () =>
        this.store.terminalCleanupPlanIDs(),
      )
      for (const planID of terminalCleanupPlanIDs) {
        await this.reconcilePlan(planID, fence, "cleanup", async () => {
          const plan = this.store.plan(planID)
          if (!plan || !["cleanup-blocked", "cancelled"].includes(plan.state)) return
          if (!this.worktreeCleanup.pendingOwnedWorktreeCleanup(plan)) return
          if (plan.state === "cleanup-blocked") {
            if (!(await this.worktreeCleanup.worktreeCleanupFactsChanged(plan))) return
            await this.worktreeCleanup.cleanupWorktrees(plan, fence)
          } else if (await this.worktreeCleanup.worktreeCleanupFactsChanged(plan))
            await this.worktreeCleanup.cleanupWorktrees(plan, fence, "cancellation")
        })
        if (heartbeatFailed) throw heartbeatError
      }
      // Stale failed or held work is handed to an Architect as one bundle, then delivered below.
      await sectionAsync("tick:recoveryBundle", async () => {
        try {
          this.recoveryDetector.evaluate(this.owner, fence)
          await this.recoveryBundles.reconcile(fence)
        } catch (error) {
          if (errorText(error).includes("Stale scheduler fence")) throw error
          const anchorID = this.store.anchorPlanID()
          if (anchorID)
            this.store.fenced(this.owner, fence, () =>
              this.store.recordOnce(anchorID, null, "RECOVERY_BUNDLE_FAILED", {
                error: errorText(error).slice(0, 300),
              }),
            )
        }
      })
      // Notices held for a retryable reason are tried again soon, not at the next full interval.
      if (await sectionAsync("tick:deliver", () => this.outcomeDelivery.deliver(fence)))
        this.wakeScheduler?.(15_000)
    } finally {
      await heartbeat?.dispose()
      this.running = false
      for (const resolve of this.idleWaiters.splice(0)) resolve()
    }
  }
  async stop() {
    this.stopped = true
    for (const controller of this.retainedVerificationAborts.values()) controller.abort()
    const activities = new Map<string, VerificationActivity>()
    const abortOwnedActivities = async () => {
      for (const activity of await abortVerificationActivities(
        (candidate) => candidate.owner === this.owner,
      )) {
        activities.set(activity.key, activity)
        if (activity.metadata.kind === "retained")
          await this.checkActivities.settleCancelledRetainedActivity(activity)
      }
    }
    await abortOwnedActivities()
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
    // A tick already inside reconciliation can admit a check after the first
    // sweep. Drain that tick, then abort its exact owned activities before the
    // caller is allowed to close the store.
    await abortOwnedActivities()
    const uncertain = [...activities.values()].find((activity) => checkSettlementProblem(activity))
    if (uncertain)
      throw new Error(
        `Verification activity ${uncertain.key} did not settle conclusively: ${checkSettlementProblem(uncertain)}`,
      )
  }

  backgroundBlockReason(session: HostSession): string | undefined {
    return this.workerObservation.backgroundBlockReason(session)
  }

  /**
   * An attempt row counts as an active dispatch reservation until it is settled, so one that no
   * longer has a worker would hold its checkout and write scope forever. Two machine-decided
   * exits, neither depending on Architect contact:
   * - the task's node is already accepted (a retained acceptance recorded before it also settled
   *   the attempt): the attempt becomes `accepted`;
   * - the plan is blocked or ended (a cancelling plan is settled by `cancelWorkers`) and the worker session is gone, or archived and
   *   quiet: the attempt becomes `failed` (blocked plan, so retry/resume stay available) or
   *   `cancelled`.
   * A live session, or an intended or uncertain effect of the attempt, is never settled.
   */
}

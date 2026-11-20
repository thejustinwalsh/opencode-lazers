import type { Database } from "bun:sqlite"
import { section, sectionAsync } from "../diagnostics/stall-probe.ts"
import {
  changeDispatchPause,
  changeSchedule,
  recordIntegration,
  terminalPlanStates as terminal,
} from "./plan-control.ts"
import { GitObservations } from "./git-observations.ts"
import { RetainedVerificationExecution } from "./retained-verification-execution.ts"
import {
  messageID,
  actualCheckResultFromEffect,
  checkSettlementProblem,
  errorText,
  isRerunnableEffect,
} from "./runtime-helpers.ts"
import type {
  CommandContext,
  RetainedRepairRecoverySeed,
  RetainedRepairSeed,
  RetainedVerificationSeed,
  RunnerTransitionRecord,
  StartupRecoveryAuthorization,
} from "./runtime-helpers.ts"
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
import { RecoveryDetector, isTakeoverAttempt } from "../recovery/detector.ts"
import { TakeoverExecution, takeoverAwareHost, type TakeoverResult } from "./takeover.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"
import { sameModelSnapshot } from "./model-route.ts"

import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { workerAgent } from "./worker-agent.ts"
import { defaultAuditorReport, type AuditorReport } from "./auditor-report.ts"
import { existsSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fingerprint } from "../identity.ts"

import { verificationTimeoutDefaults } from "./verification-timeout.ts"
import type { VerificationTimeoutDefaults } from "./verification-timeout.ts"

import { checkResourcesSettled, scopePatternsConflict } from "./artifacts.ts"

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

import {
  baseReachable,
  proofForArtifact,
  type BaseReach,
  type IntegrationProof,
} from "./integration-proof.ts"
import { knownTree } from "./identity-store.ts"

import type { HostSession, RunnerHost } from "./host.ts"
import { CommandInput, ModelPolicy, PlanInput } from "./schema.ts"
import type { CommandInput as PlanCommand } from "./schema.ts"
import {
  PLAN_MOVED_RETRIES,
  PlanMovedDuringCommand,
  planCommandProblem,
  withoutLegacyVersion,
} from "./plan-commands.ts"
import type { PlanRow, NodeRow, AttemptRow, EffectRow } from "./store.ts"
import { appendRunnerEffectReceipt, RunnerStore } from "./store.ts"

import { RETAINED_REPAIR_FENCE_FAILURE_REASON } from "./interrupted-continuation.ts"

import type { StartTaskInput, StartTaskResult } from "../tasks/contract.ts"
import type { SchedulingInput, SchedulingPage } from "../tasks/scheduling-contract.ts"
import { TaskSchedulingRead } from "../tasks/scheduling-read.ts"

import { ModelMappingResolver } from "../models/mapping-resolver.ts"
import { ModelMappingStore } from "../models/mapping-store.ts"
import { ProgressRecorder } from "../progress/recorder.ts"

import { sharedScheduler } from "./scheduler-coordinator.ts"
import { samePhysicalWorkspace } from "./workspace-location.ts"
import { selectSchedulingCandidates } from "./scheduling-selection.ts"
import type { SchedulingReservation } from "./scheduling-selection.ts"
import { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"
import { matchesReviewInputAlias, parseReviewInputAlias } from "./review-input.ts"

import { startupFailureSettlementFromReceipt } from "./startup-recovery.ts"

import {
  activeRetainedVerifications,
  createRetainedVerification,
  retainedVerificationsForPlan,
} from "./retained-verification/store.ts"
import {
  abortVerificationActivities,
  forgetVerificationActivity,
  startVerificationActivity,
  verificationActivityKey,
  verificationActivitiesForDatabase,
} from "./verification-activities.ts"
import type { VerificationActivity } from "./verification-activities.ts"

import type { RetainedDependencyInstaller } from "./retained-verification/isolation.ts"
import { retainedVerificationProbeBasis } from "./retained-verification/probe.ts"

import { sameProject } from "../project-key.ts"

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
      workerObservationCurrent: (...args) => this.workerObservationCurrent(...args),
      startupRecoveryAuthorization: (...args) => this.startupRecoveryAuthorization(...args),
      startupRecoveryAuthorityCurrent: (...args) => this.startupRecoveryAuthorityCurrent(...args),
      holdAdoption: (...args) => this.adoptionExecution.holdAdoption(...args),
    })
    this.checkActivities = new CheckActivities(this.core, {
      requestTick: () => this.requestTick(),
      verificationTimeoutDefaults: this.verificationTimeoutDefaults,
      retainedVerificationAborts: this.retainedVerificationAborts,
      retainedVerificationExecution: () => this.retainedVerificationExecution,
      adoptionExecution: () => this.adoptionExecution,
      reconcileEffect: (...args) => this.reconcileEffect(...args),
      checkProfile: (revisionID) => this.activeCheckProfile(revisionID),
    })
    this.verificationCandidate = new VerificationCandidate(this.core, {
      hold: (...args) => this.hold(...args),
      effect: (...args) => this.effect(...args),
      outcome: (...args) => this.outcome(...args),
      uncertain: (...args) => this.uncertain(...args),
      checkActivity: (...args) => this.checkActivity(...args),
      startCheckActivity: (...args) => this.startCheckActivity(...args),
      verificationDeadline: (...args) => this.verificationDeadline(...args),
      deadlineAwaitingTaskContinuation: (...args) => this.deadlineAwaitingTaskContinuation(...args),
      verificationTarget: (...args) => this.verificationTarget(...args),
      runVerificationCheck: (...args) => this.runVerificationCheck(...args),
      preparationAllowed: (...args) => this.preparationAllowed(...args),
      retainedRepairGeneration: (...args) => this.retainedRepairGeneration(...args),
      failAttempt: (...args) => this.failAttempt(...args),
      startAuditorReport: (...args) => this.startAuditorReport(...args),
      verificationTimeoutDefaults: this.verificationTimeoutDefaults,
      activeProfile: () => activeProfile(this.store.repository, this.directory),
      profileRevision: (id) => profileRevisionByID(this.store.repository, id),
    })
    this.effectReconciliation = new EffectReconciliation(this.core, {
      supersedeEffect: (...args) => this.supersedeEffect(...args),
      uncertain: (...args) => this.uncertain(...args),
      receipt: (...args) => this.receipt(...args),
      checkActivity: (...args) => this.checkActivity(...args),
      resumeStartupRecovery: (...args) => this.resumeStartupRecovery(...args),
      requestRetick: () => {
        this.tickRequested = true
      },
    })
    this.verificationReview = new VerificationReview(this.core, {
      hold: (...args) => this.hold(...args),
      effect: (...args) => this.effect(...args),
      checkActivity: (...args) => this.checkActivity(...args),
      startCheckActivity: (...args) => this.startCheckActivity(...args),
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
      retainedRepairGeneration: (...args) => this.retainedRepairGeneration(...args),
      retainedRepairForAttempt: (...args) => this.retainedRepairForAttempt(...args),
      stampIdentity: (...args) => this.stampIdentity(...args),
      fallowReviewEnabled: this.fallowReviewEnabled,
      delegatedAgentCapacity: this.delegatedAgentCapacity,
      fallowReviewRun: options.fallowReviewRun ?? defaultFallowReview,
      fallowPlanReviewRun: options.fallowPlanReviewRun ?? defaultFallowPlanReview,
      auditorReportRun: options.auditorReportRun ?? defaultAuditorReport,
    })
    this.planFinish = new PlanFinish(this.core, {
      effect: (...args) => this.effect(...args),
      hold: (...args) => this.hold(...args),
      outcome: (...args) => this.outcome(...args),
      receipt: (...args) => this.receipt(...args),
      uncertain: (...args) => this.uncertain(...args),
      checkActivity: (...args) => this.checkActivity(...args),
      startCheckActivity: (...args) => this.startCheckActivity(...args),
      runVerificationCheck: (...args) => this.runVerificationCheck(...args),
      verificationDeadline: (...args) => this.verificationDeadline(...args),
      verificationTarget: (...args) => this.verificationTarget(...args),
      missingEvidence: (...args) => this.missingEvidence(...args),
      planFallowReview: (...args) => this.planFallowReview(...args),
      retainedRepairGeneration: (...args) => this.retainedRepairGeneration(...args),
    })
    this.ownership = new ArchitectOwnership(this.core, {
      architectRouting: this.architectRouting,
      journal: this.journal,
    })
    this.repairRecords = new RetainedRepairRecords(this.core, {
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
      preparationAllowed: (...args) => this.preparationAllowed(...args),
      backgroundBlockReason: (...args) => this.backgroundBlockReason(...args),
    })
    this.retainedVerificationPrep = new RetainedVerificationPreparation(this.core, {
      retainedAttemptModel: (...args) => this.retainedAttemptModel(...args),
      retainedRepairForAttempt: (...args) => this.retainedRepairForAttempt(...args),
      retainedRepairObservation: (...args) => this.retainedRepairObservation(...args),
      retainedRepairWorkerProblem: (...args) => this.retainedRepairWorkerProblem(...args),
      backgroundBlockReason: (...args) => this.backgroundBlockReason(...args),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.retainedRepairPreparation = new RetainedRepairPreparation(this.core, {
      transitionHistory: (...args) => this.transitionHistory(...args),
      retainedAttemptModel: (...args) => this.retainedAttemptModel(...args),
      retainedRepairObservation: (...args) => this.retainedRepairObservation(...args),
      retainedRepairWorkerProblem: (...args) => this.retainedRepairWorkerProblem(...args),
      retainedRepairBackgroundProblem: (...args) => this.retainedRepairBackgroundProblem(...args),
      retainedRepairForAttempt: (...args) => this.retainedRepairForAttempt(...args),
      preparationAllowed: (...args) => this.preparationAllowed(...args),
      matchesWorkerInput: (...args) => this.matchesWorkerInput(...args),
      parseTransitionPayload: this.repairRecords.parseTransitionPayload.bind(this.repairRecords),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.adoptionPreparation = new AdoptionPreparation(this.core, {
      backgroundBlockReason: (...args) => this.backgroundBlockReason(...args),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.startupSettlement = new StartupSettlement(this.core, {
      preparationAllowed: (...args) => this.preparationAllowed(...args),
      effect: (...args) => this.effect(...args),
      uncertain: (...args) => this.uncertain(...args),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.continuationPreparation = new ContinuationPreparation(this.core, {
      matchesWorkerInput: (...args) => this.matchesWorkerInput(...args),
      interruptedChecksFor: (...args) => this.interruptedChecksFor(...args),
      prepareRetainedRepairRecovery: (...args) => this.prepareRetainedRepairRecovery(...args),
      preparationAllowed: (...args) => this.preparationAllowed(...args),
      retainedRepairForAttempt: (...args) => this.retainedRepairForAttempt(...args),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.workerPreparation = new WorkerPreparation(this.core, {
      effect: (...args) => this.effect(...args),
      hold: (...args) => this.hold(...args),
      receipt: (...args) => this.receipt(...args),
      uncertain: (...args) => this.uncertain(...args),
      promptAdmissionAllowed: (...args) => this.promptAdmissionAllowed(...args),
      repairFailureBrief: (...args) => this.repairFailureBrief(...args),
      startAuditorReport: (...args) => this.startAuditorReport(...args),
      retainedRepairForAttempt: (...args) => this.retainedRepairForAttempt(...args),
      retainedRepairPromptCurrent: (...args) => this.retainedRepairPromptCurrent(...args),
      sessionTitle: (...args) => this.sessionTitle(...args),
      startupWorkspaceReady: (...args) => this.startupWorkspaceReady(...args),
      workerEvent: (...args) => this.workerEvent(...args),
      parseTransitionPayload: this.repairRecords.parseTransitionPayload.bind(this.repairRecords),
    })
    this.outcomeDelivery = new OutcomeDelivery({
      directory: this.directory,
      ensureArchitectOwner: (...args) => this.ensureArchitectOwner(...args),
      host: this.host,
      owner: this.owner,
      projectID: this.projectID,
      reconcilePlan: (...args) => this.reconcilePlan(...args),
      store: this.store,
      validArchitect: this.validArchitect.bind(this),
    })
    this.queueReview = new QueueReview(this.core, {
      backgroundBlockReason: (...args) => this.backgroundBlockReason(...args),
      outcome: (...args) => this.outcome(...args),
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
        this.outcome(planID, { status: "takeover-ready", takeover: result }, true),
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
      hold: (...args) => this.hold(...args),
      resolveTaskDispatchRoute: (...args) => this.resolveTaskDispatchRoute(...args),
      assertNoDispatchedDependents: (...args) => this.assertNoDispatchedDependents(...args),
      requestRetick: () => {
        this.tickRequested = true
      },
      takeovers: this.takeovers,
      retainedVerificationAborts: this.retainedVerificationAborts,
      parseTransitionPayload: this.repairRecords.parseTransitionPayload.bind(this.repairRecords),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
    })
    this.commandsScope = new CommandsScope(this.core, {
      repairAvailable: (...args) => this.repairAvailable(...args),
      validArchitect: this.ownership.validArchitect.bind(this.ownership),
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
        this.ensureArchitectOwner(plan, previous, adopt),
    })
    this.worktreeCleanup = new WorktreeCleanup({
      adoptionCheckReceiptMatches: (...args) =>
        this.adoptionExecution.adoptionCheckReceiptMatches(...args),
      adoptionCheckInputMatches: (...args) =>
        this.adoptionExecution.adoptionCheckInputMatches(...args),
      backgroundBlockReason: (...args) => this.backgroundBlockReason(...args),
      directory: this.directory,
      effect: (...args) => this.effect(...args),
      host: this.host,
      now: (...args) => this.now(...args),
      outcome: (...args) => this.outcome(...args),
      owner: this.owner,
      progress: this.progress,
      projectID: this.projectID,
      store: this.store,
      timed: (name, run) => this.timed(name, run),
    })
    this.adoptionExecution = new AdoptionExecution({
      adoptionArtifactScopeViolations: (...args) => this.adoptionArtifactScopeViolations(...args),
      adoptionWorkerIdle: (...args) => this.adoptionWorkerIdle(...args),
      checkActivity: (...args) => this.checkActivity(...args),
      checkProfile: () => this.activeCheckProfile(),
      conflictingActiveAttempt: (...args) => this.conflictingActiveAttempt(...args),
      currentAdoptionInputFingerprint: (...args) => this.currentAdoptionInputFingerprint(...args),
      dataDirectory: this.dataDirectory,
      directory: this.directory,
      effect: (...args) => this.effect(...args),
      host: this.host,
      missingEvidence: (...args) => this.missingEvidence(...args),
      outcome: (...args) => this.outcome(...args),
      owner: this.owner,
      projectID: this.projectID,
      receipt: (...args) => this.receipt(...args),
      reconcileEffect: (...args) => this.reconcileEffect(...args),
      reviewedAdoptionBaseline: (...args) => this.reviewedAdoptionBaseline(...args),
      startCheckActivity: (...args) => this.startCheckActivity(...args),
      store: this.store,
      validArchitect: this.validArchitect.bind(this),
      verificationTimeoutDefaults: this.verificationTimeoutDefaults,
    })
    this.retainedVerificationExecution = new RetainedVerificationExecution({
      checkActivity: (...args) => this.checkActivity(...args),
      dataDirectory: this.dataDirectory,
      directory: this.directory,
      host: this.host,
      now: (...args) => this.now(...args),
      observeRetainedRepairCandidate: (...args) => this.observeRetainedRepairCandidate(...args),
      outcome: (...args) => this.outcome(...args),
      owner: this.owner,
      projectID: this.projectID,
      beforeRetainedCheckBegin: this.beforeRetainedCheckBegin,
      recoverCancelledRetainedChecks: (...args) => this.recoverCancelledRetainedChecks(...args),
      retainedDependencyInstaller: this.retainedDependencyInstaller,
      retainedRepairCandidateCurrent: (...args) => this.retainedRepairCandidateCurrent(...args),
      retainedVerificationAborts: this.retainedVerificationAborts,
      retainedVerificationWorkspacePath: (...args) =>
        this.retainedVerificationWorkspacePath(...args),
      runVerificationCheck: (...args) => this.runVerificationCheck(...args),
      startCheckActivity: (...args) => this.startCheckActivity(...args),
      store: this.store,
      terminalRetainedVerificationCleanupChecks: this.terminalRetainedVerificationCleanupChecks,
      validArchitect: this.validArchitect.bind(this),
      verificationDeadline: (...args) => this.verificationDeadline(...args),
      verificationTarget: (...args) => this.verificationTarget(...args),
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
      prepareWorker: (...args) => this.prepareWorker(...args),
      startupRecoveryAuthorization: (...args) => this.startupRecoveryAuthorization(...args),
      startupRecoveryAuthorityCurrent: (...args) => this.startupRecoveryAuthorityCurrent(...args),
      journal: this.journal,
    })
    this.workerObservation = new WorkerObservation(this.core, {
      sameModel: (...args) => this.sameModel(...args),
      journal: this.journal,
    })
    this.cleanupAudit = new CleanupAudit(this.core)
    this.attemptAdvance = new AttemptAdvance(this.core, {
      autoResumeInterrupted: this.autoResumeInterrupted,
      workerNoProgressWindowMs: this.workerNoProgressWindowMs,
      command: (...args) => this.command(...args),
      prepareWorker: (...args) => this.prepareWorker(...args),
      verify: (...args) => this.verify(...args),
      failAttempt: (...args) => this.failAttempt(...args),
      validArchitect: this.validArchitect.bind(this),
      observeUsage: (...args) => this.observeUsage(...args),
      journal: this.journal,
      workerObservation: this.workerObservation,
    })
    this.cancellation = new Cancellation(this.core, {
      cancelIdleWaitMs: this.cancelIdleWaitMs,
      observeUsage: (...args) => this.observeUsage(...args),
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

  /**
   * Record tree OID, patch-id, change id and the `refs/notes/lazers` note for
   * every stored artifact and base that has no current identity. This is an
   * observation: it never grants, revokes or delays an acceptance, and a
   * failure (for example a repository that is not available) is ignored and
   * retried on the next call. Calls coalesce; unforced calls are throttled.
   */
  /** The reachability verdict computed before the transaction for `base`, as a readable error. */
  private requireBaseReachable(bases: ReadonlyMap<string, BaseReach>, base: string) {
    const reach = bases.get(base)
    if (!reach) throw new Error(`Baseline ${base.slice(0, 8)} was not checked against HEAD`)
    if (!reach.ok) throw new Error(reach.reason)
  }

  /**
   * Async Git proofs a command needs, gathered before its transaction:
   * integration containment (`integrated`) and baseline
   * reachability (an explicit `baseCommit`).
   */
  private async preflightProofs(command: CommandInput, plan: PlanRow) {
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

  private startCheckActivity(...args: Parameters<CheckActivities["startCheckActivity"]>) {
    return this.checkActivities.startCheckActivity(...args)
  }

  /** The profile for a check run: a verify effect's pinned revision, else the active one. */
  private activeCheckProfile(revisionID?: number) {
    const active =
      revisionID === undefined
        ? activeProfile(this.store.repository, this.directory)
        : profileRevisionByID(this.store.repository, revisionID)
    return active ? checkRunProfile(active) : undefined
  }

  private checkActivity(...args: Parameters<CheckActivities["checkActivity"]>) {
    return this.checkActivities.checkActivity(...args)
  }

  private verificationDeadline(...args: Parameters<CheckActivities["verificationDeadline"]>) {
    return this.checkActivities.verificationDeadline(...args)
  }

  private deadlineAwaitingTaskContinuation(
    ...args: Parameters<CheckActivities["deadlineAwaitingTaskContinuation"]>
  ) {
    return this.checkActivities.deadlineAwaitingTaskContinuation(...args)
  }

  private verificationTarget(...args: Parameters<CheckActivities["verificationTarget"]>) {
    return this.checkActivities.verificationTarget(...args)
  }

  private runVerificationCheck(...args: Parameters<CheckActivities["runVerificationCheck"]>) {
    return this.checkActivities.runVerificationCheck(...args)
  }

  private cancelCheckActivities(...args: Parameters<CheckActivities["cancelCheckActivities"]>) {
    return this.checkActivities.cancelCheckActivities(...args)
  }

  private retainedCheckSettlementProblem(
    ...args: Parameters<CheckActivities["retainedCheckSettlementProblem"]>
  ) {
    return this.checkActivities.retainedCheckSettlementProblem(...args)
  }

  private reconcileCancelledCheckActivities(
    ...args: Parameters<CheckActivities["reconcileCancelledCheckActivities"]>
  ) {
    return this.checkActivities.reconcileCancelledCheckActivities(...args)
  }

  private settleCancelledRetainedActivity(
    ...args: Parameters<CheckActivities["settleCancelledRetainedActivity"]>
  ) {
    return this.checkActivities.settleCancelledRetainedActivity(...args)
  }

  private recoverCancelledRetainedChecks(
    ...args: Parameters<CheckActivities["recoverCancelledRetainedChecks"]>
  ) {
    return this.checkActivities.recoverCancelledRetainedChecks(...args)
  }

  readScheduling(input: SchedulingInput): Promise<SchedulingPage> {
    return this.schedulingRead.read(input)
  }

  private retainedVerificationWorkspacePath(
    ...args: Parameters<RetainedVerificationPreparation["retainedVerificationWorkspacePath"]>
  ) {
    return this.retainedVerificationPrep.retainedVerificationWorkspacePath(...args)
  }

  private currentAdoptionInputFingerprint(
    ...args: Parameters<AdoptionPreparation["currentAdoptionInputFingerprint"]>
  ) {
    return this.adoptionPreparation.currentAdoptionInputFingerprint(...args)
  }

  private conflictingActiveAttempt(
    ...args: Parameters<AdoptionPreparation["conflictingActiveAttempt"]>
  ) {
    return this.adoptionPreparation.conflictingActiveAttempt(...args)
  }

  private reviewedAdoptionBaseline(
    ...args: Parameters<AdoptionPreparation["reviewedAdoptionBaseline"]>
  ) {
    return this.adoptionPreparation.reviewedAdoptionBaseline(...args)
  }

  private adoptionArtifactScopeViolations(
    ...args: Parameters<AdoptionPreparation["adoptionArtifactScopeViolations"]>
  ) {
    return this.adoptionPreparation.adoptionArtifactScopeViolations(...args)
  }

  private adoptionWorkerIdle(...args: Parameters<AdoptionPreparation["adoptionWorkerIdle"]>) {
    return this.adoptionPreparation.adoptionWorkerIdle(...args)
  }

  private prepareAdoption(...args: Parameters<AdoptionPreparation["prepareAdoption"]>) {
    return this.adoptionPreparation.prepareAdoption(...args)
  }

  private retainedRepairCandidateCurrent(
    ...args: Parameters<RetainedVerificationPreparation["retainedRepairCandidateCurrent"]>
  ) {
    return this.retainedVerificationPrep.retainedRepairCandidateCurrent(...args)
  }

  private observeRetainedRepairCandidate(
    ...args: Parameters<RetainedVerificationPreparation["observeRetainedRepairCandidate"]>
  ) {
    return this.retainedVerificationPrep.observeRetainedRepairCandidate(...args)
  }

  private assertRetainedVerificationScopeAvailable(
    ...args: Parameters<RetainedVerificationPreparation["assertRetainedVerificationScopeAvailable"]>
  ) {
    return this.retainedVerificationPrep.assertRetainedVerificationScopeAvailable(...args)
  }

  private prepareRetainedVerification(
    ...args: Parameters<RetainedVerificationPreparation["prepareRetainedVerification"]>
  ) {
    return this.retainedVerificationPrep.prepareRetainedVerification(...args)
  }

  private sameModel(...args: Parameters<RetainedRepairRecords["sameModel"]>) {
    return this.repairRecords.sameModel(...args)
  }

  private retainedAttemptModel(...args: Parameters<RetainedRepairRecords["retainedAttemptModel"]>) {
    return this.repairRecords.retainedAttemptModel(...args)
  }

  private retainedRepairObservation(
    ...args: Parameters<RetainedRepairRecords["retainedRepairObservation"]>
  ) {
    return this.repairRecords.retainedRepairObservation(...args)
  }

  private retainedRepairWorkerProblem(
    ...args: Parameters<RetainedRepairRecords["retainedRepairWorkerProblem"]>
  ) {
    return this.repairRecords.retainedRepairWorkerProblem(...args)
  }

  private retainedRepairBackgroundProblem(
    ...args: Parameters<RetainedRepairRecords["retainedRepairBackgroundProblem"]>
  ) {
    return this.repairRecords.retainedRepairBackgroundProblem(...args)
  }

  private transitionHistory(...args: Parameters<RetainedRepairRecords["transitionHistory"]>) {
    return this.repairRecords.transitionHistory(...args)
  }

  private parseTransitionPayload<T>(transition: RunnerTransitionRecord | undefined): T | undefined {
    return this.repairRecords.parseTransitionPayload<T>(transition)
  }

  private prepareRetainedRepairRecovery(
    ...args: Parameters<RetainedRepairPreparation["prepareRetainedRepairRecovery"]>
  ) {
    return this.retainedRepairPreparation.prepareRetainedRepairRecovery(...args)
  }

  private retainedRepairRecoveryCurrent(
    ...args: Parameters<RetainedRepairPreparation["retainedRepairRecoveryCurrent"]>
  ) {
    return this.retainedRepairPreparation.retainedRepairRecoveryCurrent(...args)
  }

  private assertNoDispatchedDependents(
    ...args: Parameters<RetainedRepairPreparation["assertNoDispatchedDependents"]>
  ) {
    return this.retainedRepairPreparation.assertNoDispatchedDependents(...args)
  }

  private retainedRepairAttemptAccepted(
    ...args: Parameters<RetainedRepairPreparation["retainedRepairAttemptAccepted"]>
  ) {
    return this.retainedRepairPreparation.retainedRepairAttemptAccepted(...args)
  }

  private prepareRetainedRepair(
    ...args: Parameters<RetainedRepairPreparation["prepareRetainedRepair"]>
  ) {
    return this.retainedRepairPreparation.prepareRetainedRepair(...args)
  }

  private prepareReviewInputReconciliation(
    ...args: Parameters<RetainedRepairPreparation["prepareReviewInputReconciliation"]>
  ) {
    return this.retainedRepairPreparation.prepareReviewInputReconciliation(...args)
  }

  private hasMeaningfulWorkerProgress(
    ...args: Parameters<StartupSettlement["hasMeaningfulWorkerProgress"]>
  ) {
    return this.startupSettlement.hasMeaningfulWorkerProgress(...args)
  }

  private settledStartupEffect(...args: Parameters<StartupSettlement["settledStartupEffect"]>) {
    return this.startupSettlement.settledStartupEffect(...args)
  }

  private assertStartupSettlementCurrent(
    ...args: Parameters<StartupSettlement["assertStartupSettlementCurrent"]>
  ) {
    return this.startupSettlement.assertStartupSettlementCurrent(...args)
  }

  private startupRecoveryAuthorization(
    ...args: Parameters<StartupSettlement["startupRecoveryAuthorization"]>
  ) {
    return this.startupSettlement.startupRecoveryAuthorization(...args)
  }

  private startupRecoveryAuthorityCurrent(
    ...args: Parameters<StartupSettlement["startupRecoveryAuthorityCurrent"]>
  ) {
    return this.startupSettlement.startupRecoveryAuthorityCurrent(...args)
  }

  private startupWorkspaceReady(...args: Parameters<StartupSettlement["startupWorkspaceReady"]>) {
    return this.startupSettlement.startupWorkspaceReady(...args)
  }

  private assertCombinedVerificationResume(
    ...args: Parameters<ContinuationPreparation["assertCombinedVerificationResume"]>
  ) {
    return this.continuationPreparation.assertCombinedVerificationResume(...args)
  }

  async command(input: unknown, caller: string): Promise<unknown> {
    return this.runCommand(input, caller, false)
  }

  /**
   * Admission is the scheduler's act, not an Architect command: a plan is
   * admitted when it is submitted or started, whoever submitted it.
   */
  private admitPlan(plan: PlanRow, requestID: string) {
    return this.runCommand({ requestID, planID: plan.id, action: "run" }, plan.owner, true)
  }

  private async runCommand(input: unknown, caller: string, admission: boolean): Promise<unknown> {
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

  private async runCommandOnce(
    command: PlanCommand,
    caller: string,
    admission: boolean,
  ): Promise<unknown> {
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
  private async admitCommandPlan(command: PlanCommand, caller: string, admission: boolean) {
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

  private async commandOwnerSession(
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

  private prepareResumeContinuation(
    ...args: Parameters<ContinuationPreparation["prepareResumeContinuation"]>
  ) {
    return this.continuationPreparation.prepareResumeContinuation(...args)
  }

  private prepareStartupSettlement(
    ...args: Parameters<StartupSettlement["prepareStartupSettlement"]>
  ) {
    return this.startupSettlement.prepareStartupSettlement(...args)
  }

  /** Re-reads the owner (and repair candidate) at the last moment before a retained verification reserves. */
  private async revalidateRetainedVerification(
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

  private async revalidateRetainedRepair(
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
    const observedWorker = await this.host.session(attempt.session_id, { messages: true })
    const observedProblem = this.retainedRepairWorkerProblem(
      old,
      attempt,
      observedWorker,
      retainedRepair.nativeInputID,
      retainedRepair.model,
    )
    const observedBackgroundProblem = this.retainedRepairBackgroundProblem(
      observedWorker,
      retainedRepair.nativeInputID,
    )
    if (
      observedProblem ||
      observedBackgroundProblem ||
      !observedWorker ||
      this.retainedRepairObservation(observedWorker) !== retainedRepair.workerObservation
    )
      throw new Error(observedProblem ?? "Retained worker changed before final admission")
    const confirmedOwner = await this.host.session(old.owner)
    if (!this.validArchitect(confirmedOwner) || confirmedOwner.id !== caller)
      throw new Error("Retained repair owner changed during final admission")
    const confirmedWorker = await this.host.session(attempt.session_id, { messages: true })
    const confirmedProblem = this.retainedRepairWorkerProblem(
      old,
      attempt,
      confirmedWorker,
      retainedRepair.nativeInputID,
      retainedRepair.model,
    )
    const confirmedBackgroundProblem = this.retainedRepairBackgroundProblem(
      confirmedWorker,
      retainedRepair.nativeInputID,
    )
    if (this.store.plan(old.id)?.version !== baseVersion) throw new PlanMovedDuringCommand()
    if (
      confirmedProblem ||
      confirmedBackgroundProblem ||
      !confirmedWorker ||
      this.retainedRepairObservation(confirmedWorker) !== retainedRepair.workerObservation ||
      !this.preparationAllowed(attempt)
    )
      throw new Error(
        confirmedProblem ??
          confirmedBackgroundProblem ??
          "Retained repair authorization changed during final admission",
      )
  }

  private async revalidateRetainedRepairRecovery(
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
  private applyCommandIn(db: Database, ctx: CommandContext) {
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

  private dispatchCommandIn(db: Database, ctx: CommandContext, plan: PlanRow) {
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

  private commandRetainedRepair(db: Database, ctx: CommandContext, plan: PlanRow) {
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

  private commandAmendScope(...args: Parameters<CommandsScope["commandAmendScope"]>) {
    return this.commandsScope.commandAmendScope(...args)
  }

  private divergenceHold(...args: Parameters<CommandsScope["divergenceHold"]>) {
    return this.commandsScope.divergenceHold(...args)
  }

  private commandSendBackDivergence(
    ...args: Parameters<CommandsScope["commandSendBackDivergence"]>
  ) {
    return this.commandsScope.commandSendBackDivergence(...args)
  }

  private commandAdoptDescendant(ctx: CommandContext, plan: PlanRow) {
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

  private commandVerifyRetained(db: Database, ctx: CommandContext, plan: PlanRow) {
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

  private commandSettleStartup(db: Database, ctx: CommandContext, plan: PlanRow) {
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

  private commandReassign(...args: Parameters<CommandsControl["commandReassign"]>) {
    return this.commandsControl.commandReassign(...args)
  }

  private commandTakeoverSubmit(...args: Parameters<CommandsControl["commandTakeoverSubmit"]>) {
    return this.commandsControl.commandTakeoverSubmit(...args)
  }

  private holdAbandonedTakeover(...args: Parameters<CommandsControl["holdAbandonedTakeover"]>) {
    return this.commandsControl.holdAbandonedTakeover(...args)
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

  private commandCancel(...args: Parameters<CommandsControl["commandCancel"]>) {
    return this.commandsControl.commandCancel(...args)
  }

  private commandResumeOrRetry(db: Database, ctx: CommandContext, plan: PlanRow) {
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

  private commandResumeCombinedVerification(db: Database, ctx: CommandContext, plan: PlanRow) {
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

  private commandRecoverRetainedRepair(
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
      this.store.repository.taskDisposition(retainedRepairRecovery.taskID) !== undefined ||
      command.taskID !== retainedRepairRecovery.taskID ||
      command.attemptID !== retainedRepairRecovery.attemptID ||
      !this.validArchitect(ownerSession) ||
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
      .run(
        plan.id,
        RETAINED_REPAIR_FENCE_FAILURE_REASON,
        retainedRepairRecovery.planVersion + 1,
      ).changes
    if (updatedAttempt !== 1 || updatedPlan !== 1)
      throw new Error("Retained repair recovery reservation changed during atomic admission")
    this.store.record(plan.id, attempt.task_id, "ATTEMPT_RESUMED", {
      attemptID: attempt.id,
      reason: command.reason,
      usageRetained: true,
      budget: null,
      previousMessageID: retainedRepairRecovery.failedMessageID,
      messageID: resumedMessageID,
      terminalInputID: retainedRepairRecovery.interruptedInputID,
      terminalOutcome: "interrupted",
      interruptedInputID: retainedRepairRecovery.interruptedInputID,
      retainedRepairRecovery: {
        schema: "lazers-retained-repair-recovery/v1",
        operationID: retainedRepairRecovery.operationID,
        failedMessageID: retainedRepairRecovery.failedMessageID,
        interruptedInputID: retainedRepairRecovery.interruptedInputID,
        owner: retainedRepairRecovery.owner,
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

  private commandResumeInterruptedVerification(
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

  private assertTerminalContinuation(
    ...args: Parameters<ContinuationPreparation["assertTerminalContinuation"]>
  ) {
    return this.continuationPreparation.assertTerminalContinuation(...args)
  }

  private commandRequeueUnstartedTask(
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

  private commandAuthorizeStartupRecovery(
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

  private selectSharedWorkspace(
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

  private commandReconcile(db: Database, ctx: CommandContext, plan: PlanRow) {
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
       WHERE plan_id=? AND task_id=? AND event='WORKER_REVIEW_INPUT_RECONCILED'
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

  private commandRun(...args: Parameters<CommandsControl["commandRun"]>) {
    return this.commandsControl.commandRun(...args)
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
    return attempt ? this.taskChainBase(attempt) : undefined
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

  private ensureArchitectOwner(...args: Parameters<ArchitectOwnership["ensureArchitectOwner"]>) {
    return this.ownership.ensureArchitectOwner(...args)
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

  private assertSchedulerActive(...args: Parameters<ArchitectSources["assertSchedulerActive"]>) {
    return this.sources.assertSchedulerActive(...args)
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

  private reconcileArchitectSources(
    ...args: Parameters<ArchitectSources["reconcileArchitectSources"]>
  ) {
    return this.sources.reconcileArchitectSources(...args)
  }

  private sessionTitle(...args: Parameters<ArchitectOwnership["sessionTitle"]>) {
    return this.ownership.sessionTitle(...args)
  }

  private architectRoute(...args: Parameters<ArchitectOwnership["architectRoute"]>) {
    return this.ownership.architectRoute(...args)
  }

  private recordArchitectRoute(...args: Parameters<ArchitectOwnership["recordArchitectRoute"]>) {
    return this.ownership.recordArchitectRoute(...args)
  }

  private considerArchitectRenewal(
    ...args: Parameters<ArchitectRenewal["considerArchitectRenewal"]>
  ) {
    return this.renewal.considerArchitectRenewal(...args)
  }

  private continueArchitectRenewal(
    ...args: Parameters<ArchitectRenewal["continueArchitectRenewal"]>
  ) {
    return this.renewal.continueArchitectRenewal(...args)
  }

  private hold(...args: Parameters<RuntimeJournal["hold"]>) {
    return this.journal.hold(...args)
  }

  private terminalWorkerObservation(
    ...args: Parameters<RuntimeJournal["terminalWorkerObservation"]>
  ) {
    return this.journal.terminalWorkerObservation(...args)
  }

  private outcome(...args: Parameters<RuntimeJournal["outcome"]>) {
    return this.journal.outcome(...args)
  }

  private effect(...args: Parameters<RuntimeJournal["effect"]>) {
    return this.journal.effect(...args)
  }

  private receipt(...args: Parameters<RuntimeJournal["receipt"]>) {
    return this.journal.receipt(...args)
  }

  private supersedeEffect(...args: Parameters<RuntimeJournal["supersedeEffect"]>) {
    return this.journal.supersedeEffect(...args)
  }

  private uncertain(...args: Parameters<RuntimeJournal["uncertain"]>) {
    return this.journal.uncertain(...args)
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

  private requestQueueReview(...args: Parameters<QueueReview["requestQueueReview"]>) {
    return this.queueReview.requestQueueReview(...args)
  }

  private releaseFallowConfigHolds(...args: Parameters<QueueReview["releaseFallowConfigHolds"]>) {
    return this.queueReview.releaseFallowConfigHolds(...args)
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
            this.continueArchitectRenewal(renewal, fence),
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
        this.reconcileArchitectSources(fence),
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
      await sectionAsync("tick:settleStaleAttempts", () => this.settleStaleAttempts(fence))
      for (const planID of section("tick:closeoutReviewPlanIDs", () =>
        this.store.closeoutReviewPlanIDs(),
      )) {
        const plan = this.store.plan(planID)!
        this.outcome(
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
      await sectionAsync("tick:fallowConfigHolds", () => this.releaseFallowConfigHolds(fence))
      const waits: Parameters<TaskRuntime["requestQueueReview"]>[0] = []
      let closeoutDelivered = false
      for (const candidate of section("tick:runnablePlans", () =>
        this.store.runnablePlans(terminal),
      )) {
        if (!closeoutDelivered && candidate.queue_rank === 0) {
          await this.outcomeDelivery.deliver(fence, true)
          closeoutDelivered = true
        }
        await this.reconcilePlan(candidate.id, fence, "step", async () => {
          let plan: PlanRow = candidate
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
          const wait = await sectionAsync("tick:step", () => this.step(plan, fence))
          if (wait) waits.push(wait)
        })
        if (heartbeatFailed) throw heartbeatError
      }
      if (waits.length)
        await this.reconcilePlan(waits[0]!.planID, fence, "step", () =>
          this.requestQueueReview(waits, fence),
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
          const anchor = this.store.plans()[0]
          if (anchor)
            this.store.fenced(this.owner, fence, () =>
              this.store.recordOnce(anchor.id, null, "RECOVERY_BUNDLE_FAILED", {
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
          await this.settleCancelledRetainedActivity(activity)
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

  /**
   * A cancelled prerequisite drops its dependency edge and notifies the
   * Architect; dependents are never held on it. The dropped edge is recorded
   * in a plan revision. A hold left by an earlier version is released through
   * the task and plan machines.
   */
  private reconcileCancelledDependencies(planID: string, fence: number) {
    return this.store.fenced(this.owner, fence, (db) => {
      const plan = this.store.plan(planID)!
      if (!["running", "blocked"].includes(plan.state)) return plan
      const input = PlanInput.parse(JSON.parse(plan.body))
      const cancelledPlan = (id: string) =>
        ["cancelling", "cancelled"].includes(this.store.plan(id)?.state ?? "")
      const nodes = this.store.nodes(planID)
      const planEdges = (input.afterPlans ?? []).filter(cancelledPlan)
      const pause = this.store.dispatchPause(planID)
      const pausedUntil = (pause?.untilPlans ?? []).filter(cancelledPlan)
      const taskEdges = input.dependencies.filter(
        (edge) => nodes.find((node) => node.task_id === edge.prerequisite)?.state === "cancelled",
      )
      if (planEdges.length || taskEdges.length) {
        this.store.revisePlan(
          plan,
          PlanInput.parse({
            ...input,
            afterPlans: (input.afterPlans ?? []).filter((id) => !planEdges.includes(id)),
            dependencies: input.dependencies.filter((edge) => !taskEdges.includes(edge)),
          }),
          "DEPENDENCY_EDGE_DROPPED",
          {
            planPrerequisites: planEdges,
            taskEdges: taskEdges.map((edge) => ({
              prerequisite: edge.prerequisite,
              successor: edge.successor,
            })),
          },
        )
        for (const edge of taskEdges)
          db.query(
            "DELETE FROM runner_dependencies WHERE plan_id=? AND prerequisite=? AND successor=?",
          ).run(planID, edge.prerequisite, edge.successor)
      }
      if (pause && pausedUntil.length) {
        const remaining = pause.untilPlans.filter((id) => !pausedUntil.includes(id))
        this.store.setDispatchPause(
          planID,
          remaining.length ? { reason: pause.reason, untilPlans: remaining } : null,
          { droppedCancelledPrerequisites: pausedUntil },
        )
      }
      if (planEdges.length || taskEdges.length || pausedUntil.length)
        this.outcome(
          planID,
          {
            status: "dependency-dropped",
            reason: "A cancelled prerequisite was dropped; dependent work continues",
            droppedPlanPrerequisites: planEdges,
            droppedTaskPrerequisites: taskEdges.map((edge) => edge.prerequisite),
            droppedPauseConditions: pausedUntil,
            allowedActions: ["schedule", "audit"],
          },
          true,
        )
      this.releaseLegacyDependencyHold(plan.id)
      return this.store.plan(planID)!
    })
  }

  /** Releases a hold applied by an earlier version for a cancelled prerequisite. */
  private releaseLegacyDependencyHold(planID: string) {
    type Saved = {
      roots: string[]
      nodes: Array<{ taskID: string; version: number; reason: string }>
      planHold: { previousState: string; previousReason: string | null; reason: string } | null
    }
    const previous = this.store.latestTransition<Saved>(planID, null, "DEPENDENCY_CANCELLATION")
    if (!previous || (!previous.nodes.length && !previous.planHold)) return
    for (const node of this.store.nodes(planID)) {
      const saved = previous.nodes.find((item) => item.taskID === node.task_id)
      if (saved && node.state === "blocked" && node.version === saved.version)
        this.store.move(planID, node.task_id, "RECONCILE")
    }
    const plan = this.store.plan(planID)!
    const hold = previous.planHold
    if (hold && plan.state === "blocked" && plan.reason === hold.reason)
      this.store.atomic((db) =>
        db
          .query(
            "UPDATE runner_plans SET state=lz_runner_transition('plan',state,?),reason=?,version=version+1 WHERE id=?",
          )
          .run(hold.previousState, hold.previousReason, planID),
      )
    this.store.record(planID, null, "DEPENDENCY_CANCELLATION", {
      roots: [],
      nodes: [],
      planHold: null,
    } satisfies Saved)
  }

  private interruptedChecksFor(plan: PlanRow, attempt: AttemptRow) {
    return this.store.effects(plan.id).filter((effect) => {
      const receipt = actualCheckResultFromEffect(effect)
      return (
        effect.state === "uncertain" &&
        effect.attempt_id === attempt.id &&
        effect.kind.startsWith("verify:") &&
        receipt?.aborted === true &&
        receipt.cwd === attempt.workspace &&
        receipt.artifact === attempt.artifact &&
        receipt.inputIdentity === attempt.artifact &&
        checkResourcesSettled(receipt)
      )
    })
  }

  private async step(initialPlan: PlanRow, fence: number) {
    let plan = this.store.plan(initialPlan.id)
    if (!plan) return
    if (plan.state !== "running") await this.delegatedAgentCapacity.cancelRunnerQueue(plan.id)
    if (plan.state === "cancelling") {
      const activities = await this.timed("step:cancelCheckActivities", () =>
        this.cancelCheckActivities(plan!.id),
      )
      await this.timed("step:reconcileCancelledCheckActivities", () =>
        this.reconcileCancelledCheckActivities(plan!, activities, fence),
      )
      const cancelledOperations = this.store.atomic((db) =>
        retainedVerificationsForPlan(db, this.directory, plan!.id).filter(
          (operation) => operation.state === "cancelled",
        ),
      )
      for (const operation of cancelledOperations)
        await this.timed("step:recoverCancelledRetainedChecks", () =>
          this.recoverCancelledRetainedChecks(operation.id),
        )
      const retainedProblem = this.store.atomic((db) =>
        retainedVerificationsForPlan(db, this.directory, plan!.id).some(
          (operation) =>
            operation.state === "cancelled" &&
            Boolean(this.retainedCheckSettlementProblem(operation.id)),
        ),
      )
      const unsettled = activities.find((activity) => checkSettlementProblem(activity))
      if (unsettled || retainedProblem) {
        // Process uncertainty fences terminal settlement, not interruption of
        // other owned workers. Continue cancellation without declaring idle.
        await this.timed("step:cancelWorkers", () => this.cancelWorkers(plan!, fence, false))
        const reason = `Verification cancellation settlement is uncertain: ${unsettled ? checkSettlementProblem(unsettled) : "retained check resources remain unconfirmed"}`
        this.store.fenced(this.owner, fence, (db) => {
          if (this.store.plan(plan!.id)?.reason === reason) return
          db.query("UPDATE runner_plans SET reason=? WHERE id=? AND state='cancelling'").run(
            reason,
            plan!.id,
          )
          this.store.record(plan!.id, null, "VERIFICATION_CANCELLATION_UNCERTAIN", { reason })
        })
        return
      }
      await this.timed("step:cancelWorkers", () => this.cancelWorkers(plan!, fence))
      const pending = this.store
        .effects(plan.id)
        .find((e) => ["intended", "uncertain"].includes(e.state))
      if (pending)
        await this.timed("step:reconcileEffect", () => this.reconcileEffect(pending, fence))
      return
    }
    const contactPaused = this.store.architectContactPaused()
    const planRenewal = contactPaused ? undefined : this.store.architectRenewalForPlan(plan.id)
    if (
      planRenewal &&
      ["creating", "archiving", "recovering-input", "rolling-back"].includes(planRenewal.state)
    ) {
      await this.timed("step:continueArchitectRenewal", () =>
        this.continueArchitectRenewal(planRenewal, fence),
      )
      return
    }
    // Routing always reaches a live Architect: the owner is advisory, so a
    // missing or archived one is replaced before any branch can return early.
    const owner = await this.timed("step:host.session", () => this.host.session(plan!.owner))
    if (!this.validArchitect(owner) && !contactPaused) {
      this.recordArchitectRoute(plan, this.architectRoute(owner), owner)
      await this.timed("step:ensureArchitectOwner", () => this.ensureArchitectOwner(plan!, owner))
      plan = this.store.plan(plan.id)!
    }
    if (plan.state === "cleaning") {
      await this.timed("step:cleanupWorktrees", () =>
        this.worktreeCleanup.cleanupWorktrees(plan!, fence),
      )
      return
    }
    const adoption = this.store.activeAdoptions(plan.id)[0]
    if (adoption) {
      await this.timed("step:advanceAdoption", () =>
        this.adoptionExecution.advanceAdoption(plan!, adoption, fence),
      )
      return
    }
    if (this.validArchitect(owner) && !contactPaused) {
      const renewal = this.store.architectRenewalForSource(owner.id)
      if (
        renewal &&
        ["creating", "archiving", "recovering-input", "rolling-back"].includes(renewal.state)
      ) {
        await this.timed("step:continueArchitectRenewal", () =>
          this.continueArchitectRenewal(renewal, fence),
        )
        return
      }
      // Only work that needs judgement routes; a cold, large Architect is replaced.
      if (["blocked", "accepted", "cleanup-blocked"].includes(plan.state)) {
        this.recordArchitectRoute(plan, this.architectRoute(owner), owner)
        if (
          await this.timed("step:considerArchitectRenewal", () =>
            this.considerArchitectRenewal(plan!, owner, fence),
          )
        )
          return
      }
    }
    // An owner read can overlap an authorized resume, cancellation, or reassignment.
    if (this.store.plan(plan.id)?.version !== plan.version) return
    plan = this.reconcileCancelledDependencies(plan.id, fence)
    const unresolved = this.store
      .effects(plan.id)
      .filter((e) => ["intended", "uncertain"].includes(e.state))
    const pending = unresolved[0]
    if (pending) {
      await this.delegatedAgentCapacity.cancelRunnerQueue(plan.id)
      const attempt = pending.attempt_id
        ? this.store.attempts(plan.id).find((item) => item.id === pending.attempt_id)
        : undefined
      if (
        plan.state === "blocked" &&
        plan.reason?.startsWith(`Recovery uncertain for ${pending.kind} ${pending.id}:`) &&
        attempt?.state === "verifying" &&
        unresolved.length === 1 &&
        actualCheckResultFromEffect(pending)?.processCleanup &&
        this.interruptedChecksFor(plan, attempt).some((effect) => effect.id === pending.id)
      ) {
        await this.command(
          {
            requestID: `resume-settled-check:${pending.id}:${plan.version}`,
            planID: plan.id,
            action: "resume",
            taskID: attempt.task_id,
            attemptID: attempt.id,
            reason: "Resume the interrupted check after confirming subprocess cleanup",
          },
          plan.owner,
        )
        this.tickRequested = true
        return
      }
      await this.timed("step:reconcileEffect", () => this.reconcileEffect(pending, fence))
      // A settled effect of a running plan unblocks the rest of its step: continue now, not at
      // the next periodic pass. An unsettled effect waits for new facts instead of spinning, and
      // a held plan waits for its Architect.
      const settled = this.store.effects(plan.id).find((effect) => effect.id === pending.id)
      if (
        this.store.plan(plan.id)?.state === "running" &&
        settled &&
        !["intended", "uncertain"].includes(settled.state)
      )
        this.tickRequested = true
      return
    }
    // A takeover in progress owns its worker attempt: advance it, and leave that worker alone.
    for (const takeover of this.takeovers.open(plan.id))
      await this.timed("step:takeover", () => this.takeovers.advance(takeover, true))
    plan = this.store.plan(plan.id)!
    const heldByTakeover = this.takeovers.heldAttempts(plan.id)
    const active = this.store
      .attempts(plan.id)
      .filter((a) => ["preparing", "running", "verifying"].includes(a.state))
      .filter((a) => !heldByTakeover.has(a.id))
    if (active.length) {
      await Promise.all(
        active.map((attempt) => {
          // The Architect works its own attempt; it is verified once submitted.
          if (isTakeoverAttempt(attempt.policy)) {
            if (attempt.state !== "verifying")
              return this.timed("step:takeoverLiveness", () =>
                this.holdAbandonedTakeover(this.store.plan(plan!.id)!, attempt),
              )
            const task = this.store.repository.get(attempt.task_id)!
            return this.timed("step:verifyTakeover", () =>
              this.verify(this.store.plan(plan!.id)!, attempt, task.proposal, fence),
            )
          }
          const promptCompleted = this.store
            .effects(plan!.id)
            .some(
              (effect) =>
                effect.attempt_id === attempt.id &&
                effect.kind === "prompt" &&
                JSON.parse(effect.payload).messageID === attempt.message_id &&
                effect.state === "completed",
            )
          const settledStartup = this.settledStartupEffect(plan!.id, attempt)
          if (
            plan!.state === "blocked" &&
            attempt.state === "preparing" &&
            !promptCompleted &&
            !settledStartup &&
            !this.retainedRepairForAttempt(attempt)
          )
            return this.cancelReservedAttempt(plan!, attempt, fence)
          if (plan!.state === "blocked" && settledStartup) return
          const scopeWait = this.store.latestTransition<{ attemptID: string; reason: string }>(
            plan!.id,
            attempt.task_id,
            "SCOPE_DECISION_REQUIRED",
          )
          if (
            plan!.state === "blocked" &&
            scopeWait?.attemptID === attempt.id &&
            scopeWait.reason === plan!.reason
          )
            return
          return this.timed("step:advanceAttempt", () =>
            this.advanceAttempt(this.store.plan(plan!.id)!, attempt, fence),
          )
        }),
      )
      plan = this.store.plan(plan.id)!
      if (plan.state === "cancelling") {
        await this.timed("step:cancelWorkers", () => this.cancelWorkers(plan!, fence))
        return
      }
    }
    if (plan.state === "blocked") return

    let rawInput = JSON.parse(plan.body)
    let input = PlanInput.parse(rawInput)
    const prerequisites = input.afterPlans ?? []
    const prerequisiteBaseline = prerequisites.length
      ? await this.timed("step:integratedPrerequisiteBaseline", () =>
          this.integratedPrerequisiteBaseline(prerequisites),
        )
      : undefined
    if (prerequisites.length && !prerequisiteBaseline) {
      await this.delegatedAgentCapacity.cancelRunnerQueue(plan.id)
      if (
        !this.store.effectiveDispatchPause(plan.id) &&
        this.store.nodes(plan.id).some((node) => ["queued", "ready"].includes(node.state))
      )
        return { planID: plan.id, prerequisitePlanIDs: prerequisites }
      return
    }
    if (prerequisites.length && !this.store.attempts(plan.id).length) {
      // Dependents inherit the selected checkout after every prerequisite's
      // current combined integration proof is present in its Git history.
      const baseCommit = prerequisiteBaseline!
      if (input.baseCommit !== baseCommit) {
        input = PlanInput.parse({ ...rawInput, baseCommit })
        this.store.revisePlan(plan, input, "DEPENDENCIES_INTEGRATED", { prerequisites, baseCommit })
        plan = this.store.plan(plan.id)!
        rawInput = JSON.parse(plan.body)
      }
    }
    if (rawInput.workspaceMode === undefined) {
      const attempts = this.store.attempts(plan.id)
      if (attempts.length)
        input.workspaceMode = attempts.at(-1)!.workspace === this.directory ? "shared" : "isolated"
    }
    const nodes = this.store.nodes(plan.id)
    const occupied = this.store.dispatchReservations()
    let pause = this.store.dispatchPause(plan.id)
    if (
      pause?.untilPlans.length &&
      (await this.timed("step:integratedPrerequisiteBaseline", () =>
        this.integratedPrerequisiteBaseline(pause!.untilPlans),
      ))
    ) {
      this.store.fenced(this.owner, fence, () =>
        this.store.setDispatchPause(plan!.id, null, { source: "resume-condition" }),
      )
      plan = this.store.plan(plan.id)!
      this.outcome(
        plan.id,
        { status: "dispatch-resumed", reason: "Resume prerequisites integrated" },
        true,
      )
      pause = undefined
    }
    // A project or global pause holds new dispatch whatever the plan's own pause says.
    const held = this.store.effectiveDispatchPause(plan.id)
    const ready: NodeRow[] = []
    for (const node of nodes) {
      if (
        held ||
        !["queued", "ready"].includes(node.state) ||
        this.store.execution(node.task_id)!.waitingOn.length > 0
      )
        continue
      const prerequisites = this.taskDependencyIDs(input, node)
      if (
        prerequisites.length === 0 ||
        (
          await this.timed("step:taskDependencyIntegration", () =>
            this.taskDependencyIntegration(plan!, input, node),
          )
        ).status === "ready"
      )
        ready.push(node)
    }
    const selection = selectSchedulingCandidates(
      input.workspaceMode,
      ready.map((node) => ({
        taskID: node.task_id,
        scopes: this.store.effectiveReservationScope(node.task_id),
      })),
      occupied as SchedulingReservation[],
    )
    const selected = selection.selectedTaskIDs.flatMap((taskID) => {
      const node = ready.find((candidate) => candidate.task_id === taskID)
      return node ? [node] : []
    })
    if (selected.length) {
      const admissionRequests = new Map<string, string>()
      for (const node of selected) {
        const attemptNumber =
          this.store.attempts(plan.id).filter((attempt) => attempt.task_id === node.task_id)
            .length + 1
        admissionRequests.set(
          node.task_id,
          await this.delegatedAgentCapacity.ensureRunnerQueued({
            planID: plan.id,
            taskID: node.task_id,
            attemptNumber,
          }),
        )
      }
      const activeTaskIDs = this.store
        .attempts(plan.id)
        .filter(
          (attempt) =>
            attempt.state === "running" ||
            (attempt.state === "preparing" && this.preparationAllowed(attempt)),
        )
        .map((attempt) => attempt.task_id)
      await this.delegatedAgentCapacity.cancelRunnerQueue(plan.id, [
        ...new Set([...selected.map((node) => node.task_id), ...activeTaskIDs]),
      ])
      await Promise.all(
        selected.map(async (node) => {
          try {
            await this.timed("step:dispatch", () =>
              this.dispatch(plan!, node, fence, admissionRequests.get(node.task_id)!),
            )
          } catch (error) {
            const current = this.store.plan(plan!.id)
            if (current && current.state !== "blocked")
              this.hold(current, `Dispatch failed for ${node.task_id}: ${errorText(error)}`)
          }
        }),
      )
      return
    }
    const outstanding = this.store
      .attempts(plan.id)
      .filter((attempt) => ["preparing", "running", "verifying"].includes(attempt.state))
    await this.delegatedAgentCapacity.cancelRunnerQueue(
      plan.id,
      outstanding
        .filter(
          (attempt) =>
            attempt.state === "running" ||
            (attempt.state === "preparing" && this.preparationAllowed(attempt)),
        )
        .map((attempt) => attempt.task_id),
    )
    if (outstanding.length) {
      if (!held && nodes.some((node) => ["queued", "ready"].includes(node.state)))
        return {
          planID: plan.id,
          reservationTaskIDs: [...new Set(outstanding.map((attempt) => attempt.task_id))].sort(),
        }
      return
    }
    const failed = nodes.find((n) =>
      ["failed", "cancelled", "exhausted", "blocked"].includes(n.state),
    )
    if (failed) {
      this.hold(plan, `Task ${failed.task_id}: ${failed.reason ?? failed.state}`)
      return
    }
    if (nodes.every((n) => n.state === "accepted" || n.state === "incorporated")) {
      await this.timed("step:finish", () => this.finish(plan!, fence))
      return
    }
    if (ready.length && occupied.length) {
      const reservationTaskIDs = occupied
        .filter(
          (entry) =>
            input.workspaceMode === "shared" ||
            entry.shared ||
            ready.some((node) =>
              scopePatternsConflict(
                entry.scopes,
                this.store.effectiveReservationScope(node.task_id),
              ),
            ),
        )
        .map((entry) => entry.taskID)
      return { planID: plan.id, reservationTaskIDs: [...new Set(reservationTaskIDs)].sort() }
    }
  }

  private cancelWorkers(...args: Parameters<Cancellation["cancelWorkers"]>) {
    return this.cancellation.cancelWorkers(...args)
  }

  private cancelReservedAttempt(...args: Parameters<Cancellation["cancelReservedAttempt"]>) {
    return this.cancellation.cancelReservedAttempt(...args)
  }

  private workerEvent(...args: Parameters<WorkerObservation["workerEvent"]>) {
    return this.workerObservation.workerEvent(...args)
  }

  private matchesWorkerInput(...args: Parameters<WorkerObservation["matchesWorkerInput"]>) {
    return this.workerObservation.matchesWorkerInput(...args)
  }

  private isPriorContinuationInput(
    ...args: Parameters<WorkerObservation["isPriorContinuationInput"]>
  ) {
    return this.workerObservation.isPriorContinuationInput(...args)
  }

  private approvalWait(...args: Parameters<WorkerObservation["approvalWait"]>) {
    return this.workerObservation.approvalWait(...args)
  }

  private holdApprovalObservation(
    ...args: Parameters<WorkerObservation["holdApprovalObservation"]>
  ) {
    return this.workerObservation.holdApprovalObservation(...args)
  }

  private workerObservationFence(...args: Parameters<WorkerObservation["workerObservationFence"]>) {
    return this.workerObservation.workerObservationFence(...args)
  }

  private workerObservationCurrent(
    ...args: Parameters<WorkerObservation["workerObservationCurrent"]>
  ) {
    return this.workerObservation.workerObservationCurrent(...args)
  }

  private approvalWaitReason(...args: Parameters<WorkerObservation["approvalWaitReason"]>) {
    return this.workerObservation.approvalWaitReason(...args)
  }

  private resumeTransientObservationWait(
    ...args: Parameters<WorkerObservation["resumeTransientObservationWait"]>
  ) {
    return this.workerObservation.resumeTransientObservationWait(...args)
  }

  private backgroundWait(...args: Parameters<WorkerObservation["backgroundWait"]>) {
    return this.workerObservation.backgroundWait(...args)
  }

  backgroundBlockReason(session: HostSession): string | undefined {
    return this.workerObservation.backgroundBlockReason(session)
  }

  private cleanupAuditDiagnostics(...args: Parameters<CleanupAudit["cleanupAuditDiagnostics"]>) {
    return this.cleanupAudit.cleanupAuditDiagnostics(...args)
  }

  private async dispatch(...args: Parameters<Dispatch["dispatch"]>) {
    return this.dispatchModule.dispatch(...args)
  }

  private preparationAllowed(...args: Parameters<Dispatch["preparationAllowed"]>) {
    return this.dispatchModule.preparationAllowed(...args)
  }

  private promptAdmissionAllowed(...args: Parameters<Dispatch["promptAdmissionAllowed"]>) {
    return this.dispatchModule.promptAdmissionAllowed(...args)
  }

  private observeUsage(...args: Parameters<Dispatch["observeUsage"]>) {
    return this.dispatchModule.observeUsage(...args)
  }

  private taskDependencyIDs(...args: Parameters<Dispatch["taskDependencyIDs"]>) {
    return this.dispatchModule.taskDependencyIDs(...args)
  }

  private taskDependencyIntegration(...args: Parameters<Dispatch["taskDependencyIntegration"]>) {
    return this.dispatchModule.taskDependencyIntegration(...args)
  }

  private integratedPrerequisiteBaseline(
    ...args: Parameters<Dispatch["integratedPrerequisiteBaseline"]>
  ) {
    return this.dispatchModule.integratedPrerequisiteBaseline(...args)
  }

  private resolveTaskDispatchRoute(...args: Parameters<Dispatch["resolveTaskDispatchRoute"]>) {
    return this.dispatchModule.resolveTaskDispatchRoute(...args)
  }

  private retainedRepairForAttempt(
    ...args: Parameters<RetainedRepairRecords["retainedRepairForAttempt"]>
  ) {
    return this.repairRecords.retainedRepairForAttempt(...args)
  }

  private retainedRepairGeneration(
    ...args: Parameters<RetainedRepairRecords["retainedRepairGeneration"]>
  ) {
    return this.repairRecords.retainedRepairGeneration(...args)
  }

  private retainedRepairPromptCurrent(
    ...args: Parameters<RetainedRepairRecords["retainedRepairPromptCurrent"]>
  ) {
    return this.repairRecords.retainedRepairPromptCurrent(...args)
  }

  private prepareWorker(...args: Parameters<WorkerPreparation["prepareWorker"]>) {
    return this.workerPreparation.prepareWorker(...args)
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
  private settleStaleAttempts(...args: Parameters<AttemptAdvance["settleStaleAttempts"]>) {
    return this.attemptAdvance.settleStaleAttempts(...args)
  }

  private advanceAttempt(...args: Parameters<AttemptAdvance["advanceAttempt"]>) {
    return this.attemptAdvance.advanceAttempt(...args)
  }

  private prepareVerificationCandidate(
    ...args: Parameters<VerificationCandidate["prepareVerificationCandidate"]>
  ) {
    return this.verificationCandidate.prepareVerificationCandidate(...args)
  }

  private verificationCurrentGuard(
    ...args: Parameters<VerificationCandidate["verificationCurrentGuard"]>
  ) {
    return this.verificationCandidate.verificationCurrentGuard(...args)
  }

  private verificationAwaitsTaskContinuation(
    ...args: Parameters<VerificationCandidate["verificationAwaitsTaskContinuation"]>
  ) {
    return this.verificationCandidate.verificationAwaitsTaskContinuation(...args)
  }

  private commitVerificationCandidate(
    ...args: Parameters<VerificationCandidate["commitVerificationCandidate"]>
  ) {
    return this.verificationCandidate.commitVerificationCandidate(...args)
  }

  private recordAttemptArtifact(
    ...args: Parameters<VerificationCandidate["recordAttemptArtifact"]>
  ) {
    return this.verificationCandidate.recordAttemptArtifact(...args)
  }

  private collectCheckReceipts(...args: Parameters<VerificationCandidate["collectCheckReceipts"]>) {
    return this.verificationCandidate.collectCheckReceipts(...args)
  }

  private captureAutomaticFixes(
    ...args: Parameters<VerificationCandidate["captureAutomaticFixes"]>
  ) {
    return this.verificationCandidate.captureAutomaticFixes(...args)
  }

  private acceptVerifiedAttempt(
    ...args: Parameters<VerificationCandidate["acceptVerifiedAttempt"]>
  ) {
    return this.verificationCandidate.acceptVerifiedAttempt(...args)
  }

  private verify(...args: Parameters<VerificationReview["verify"]>) {
    return this.verificationReview.verify(...args)
  }

  private fallowReviewResult(...args: Parameters<VerificationReview["fallowReviewResult"]>) {
    return this.verificationReview.fallowReviewResult(...args)
  }

  private startAuditorReport(...args: Parameters<VerificationReview["startAuditorReport"]>) {
    return this.verificationReview.startAuditorReport(...args)
  }

  private planFallowReview(...args: Parameters<VerificationReview["planFallowReview"]>) {
    return this.verificationReview.planFallowReview(...args)
  }

  private taskChainBase(...args: Parameters<VerificationReview["taskChainBase"]>) {
    return this.verificationReview.taskChainBase(...args)
  }

  private repairAvailable(...args: Parameters<VerificationReview["repairAvailable"]>) {
    return this.verificationReview.repairAvailable(...args)
  }

  private missingEvidence(...args: Parameters<VerificationReview["missingEvidence"]>) {
    return this.verificationReview.missingEvidence(...args)
  }

  private repairFailureBrief(...args: Parameters<VerificationReview["repairFailureBrief"]>) {
    return this.verificationReview.repairFailureBrief(...args)
  }
  private failAttempt(...args: Parameters<VerificationReview["failAttempt"]>) {
    return this.verificationReview.failAttempt(...args)
  }

  private finish(...args: Parameters<PlanFinish["finish"]>) {
    return this.planFinish.finish(...args)
  }
  private reconcileEffect(...args: Parameters<EffectReconciliation["reconcileEffect"]>) {
    return this.effectReconciliation.reconcileEffect(...args)
  }

  private resumeStartupRecovery(...args: Parameters<StartupSettlement["resumeStartupRecovery"]>) {
    return this.startupSettlement.resumeStartupRecovery(...args)
  }
}

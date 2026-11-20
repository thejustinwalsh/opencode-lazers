import type { Database } from "bun:sqlite"
import { section, sectionAsync } from "../diagnostics/stall-probe.ts"
import {
  changeDispatchPause,
  changeSchedule,
  recordIntegration,
  terminalPlanStates as terminal,
} from "./plan-control.ts"
import { GitObservations, ObservationRequired } from "./git-observations.ts"
import { RetainedVerificationExecution } from "./retained-verification-execution.ts"
import {
  messageID,
  isCommitID,
  isRecord,
  actualCheckResultFromEffect,
  checkSettlementProblem,
  errorText,
  isRerunnableEffect,
} from "./runtime-helpers.ts"
import type { RetainedRepairRecord, StartupRecoveryAuthorization } from "./runtime-helpers.ts"
import type { RuntimeCore } from "./runtime-core.ts"
import { RuntimeJournal } from "./runtime-journal.ts"
import { ArchitectOwnership } from "./architect-ownership.ts"
import { ArchitectSources } from "./architect-sources.ts"
import { ArchitectRenewal } from "./architect-renewal.ts"
import { Dispatch } from "./dispatch.ts"
import { WorkerObservation } from "./worker-observation.ts"
import { CleanupAudit, type CleanupAuditDiagnostics } from "./cleanup-audit.ts"
import { AttemptAdvance } from "./attempt-advance.ts"
import { Cancellation } from "./cancellation.ts"
import { activeProfile, profileRevisionByID } from "../projects/profile-store.ts"
import { checkRunProfile } from "../projects/profile-runtime.ts"
import { CheckActivities } from "./check-activities.ts"
import { VerificationCandidate } from "./verification-candidate.ts"
import { EffectReconciliation } from "./effect-reconciliation.ts"
import { VerificationReview } from "./verification-review.ts"
import { PlanFinish } from "./plan-finish.ts"
import { AdoptionExecution } from "./adoption-execution.ts"
import { WorktreeCleanup } from "./worktree-cleanup.ts"
import { OutcomeDelivery } from "./outcome-delivery.ts"
import { RecoveryBundles } from "./recovery-bundle.ts"
import { RecoveryDetector, isTakeoverAttempt } from "../recovery/detector.ts"
import { TakeoverExecution, takeoverAwareHost, type TakeoverResult } from "./takeover.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"
import { sameModelSnapshot, sameNativeModel } from "./model-route.ts"

import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { isWorkerAgent, workerAgent } from "./worker-agent.ts"
import { defaultAuditorReport, type AuditorReport } from "./auditor-report.ts"
import { existsSync, lstatSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fingerprint } from "../identity.ts"

import { verificationTimeoutDefaults } from "./verification-timeout.ts"
import type { VerificationTimeoutDefaults } from "./verification-timeout.ts"

import {
  commitIsAncestor,
  checkResourcesSettled,
  combineArtifacts,
  gitAsync,
  worktreeListPorcelain,
  reviewedScopeBase,
  scopePatternsConflict,
  verificationEnvironmentIdentity,
} from "./artifacts.ts"

import { classifyChanges, protectedPaths } from "./scope.ts"

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
import { FINGERPRINT_V2_PREFIX, isFingerprintV2 } from "./identity-store.ts"
import {
  baseReachable,
  proofForArtifact,
  type BaseReach,
  type IntegrationProof,
} from "./integration-proof.ts"
import { knownTree } from "./identity-store.ts"

import type { HostSession, RunnerHost, WorkerInstruction } from "./host.ts"
import { CommandInput, ModelPolicy, PlanInput, WorkerPersona } from "./schema.ts"
import type { CommandInput as PlanCommand } from "./schema.ts"
import {
  PLAN_MOVED_RETRIES,
  PlanMovedDuringCommand,
  planCommandProblem,
  withoutLegacyVersion,
} from "./plan-commands.ts"
import type {
  PlanRow,
  NodeRow,
  AttemptRow,
  EffectRow,
  OutboxRow,
  AdoptionRow,
  ProgressRow,
} from "./store.ts"
import { appendRunnerEffectReceipt, RunnerStore } from "./store.ts"

import {
  resolveRetainedRepairInputLineage,
  RETAINED_REPAIR_FENCE_FAILURE_REASON,
  terminalWorkerContinuationProblem as checkTerminalWorkerContinuation,
} from "./interrupted-continuation.ts"
import type {
  RetainedRepairContinuationTransition,
  TerminalWorkerHold,
  TerminalWorkerContinuationFacts,
} from "./interrupted-continuation.ts"
import type { StartTaskInput, StartTaskResult } from "../tasks/contract.ts"
import type { SchedulingInput, SchedulingPage } from "../tasks/scheduling-contract.ts"
import { TaskSchedulingRead } from "../tasks/scheduling-read.ts"
import { workerPersonaLabels, workerPersonaOverlay } from "../personas/index.ts"
import { DispatchRouteDecisionSchema } from "../models/dispatch-resolution.ts"
import { ModelMappingResolver } from "../models/mapping-resolver.ts"
import { ModelMappingStore } from "../models/mapping-store.ts"
import { ProgressRecorder } from "../progress/recorder.ts"

import { PROJECT_RECONCILIATION_INTERVAL_MS, sharedScheduler } from "./scheduler-coordinator.ts"
import { canonicalProjectWorktreePath, samePhysicalWorkspace } from "./workspace-location.ts"
import { selectSchedulingCandidates } from "./scheduling-selection.ts"
import type { SchedulingReservation } from "./scheduling-selection.ts"
import { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"
import {
  matchesReviewInputAlias,
  observeReviewInput,
  parseReviewInputAlias,
} from "./review-input.ts"
import type { ReviewInputBinding, ReviewInputEvidence } from "./review-input.ts"
import {
  isStartupWorktreeCandidate,
  startupFailureSettlementFromReceipt,
  startupWorktreeFailureEvidence,
  startupWorktreeCandidates,
} from "./startup-recovery.ts"
import type { StartupAbsenceEvidence, StartupWorktreeFailureEvidence } from "./startup-recovery.ts"
import {
  activeRetainedVerifications,
  createRetainedVerification,
  retainedVerificationsForPlan,
  saveRetainedVerification,
} from "./retained-verification/store.ts"
import {
  abortVerificationActivities,
  forgetVerificationActivity,
  startVerificationActivity,
  verificationActivityKey,
  verificationActivitiesForDatabase,
} from "./verification-activities.ts"
import type { VerificationActivity } from "./verification-activities.ts"
import type { RetainedVerification } from "./retained-verification/schema.ts"
import { retainedVerificationEnvironmentIdentity } from "./retained-verification/isolation.ts"
import type { RetainedDependencyInstaller } from "./retained-verification/isolation.ts"
import { retainedVerificationProbeBasis } from "./retained-verification/probe.ts"

import { sameProject } from "../project-key.ts"

const taskStartRequestID = (taskID: string) => `task-start:${taskID}:1`

/** Activity completion means a receipt exists, not that its process tree is idle. */
function isUnavailableSessionRecoveryGap(fact: ProgressRow) {
  if (
    fact.kind !== "gap" ||
    fact.source !== "recovery" ||
    fact.call_id !== null ||
    fact.message_id !== null
  )
    return false
  try {
    const sources: unknown = JSON.parse(fact.sources_json)
    const eventIDs: unknown = JSON.parse(fact.event_ids_json)
    const payload: unknown = JSON.parse(fact.payload)
    return (
      Array.isArray(sources) &&
      sources.every((source) => source === "recovery") &&
      Array.isArray(eventIDs) &&
      eventIDs.length === 0 &&
      isRecord(payload) &&
      typeof payload.reason === "string" &&
      payload.reason.startsWith("Assigned native session is unavailable:")
    )
  } catch {
    return false
  }
}
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

type AdoptionSeed = {
  taskID: string
  taskRevision: number
  attemptID: string
  nodeState: string
  attemptState: string
  oldArtifact: string
  descendantCommit: string
  targetBranch: string
  landingHead: string
  reviewedBaseline: string
  candidateTree: string
  environmentIdentity: string
  inputFingerprint: string
  reason: string
  combinedArtifact: string
}

type RetainedRepairSeed = {
  taskID: string
  attemptID: string
  artifact: string
  previousMessageID: string
  nativeInputID: string
  messageID: string
  operationID: string
  owner: string
  sessionID: string
  workspace: string
  model: ModelPolicy
  workerObservation: string
}

type RetainedRepairRecoverySeed = {
  operationID: string
  attemptID: string
  taskID: string
  failedMessageID: string
  interruptedInputID: string
  owner: string
  taskRevision: number
  planVersion: number
  planRevision: number
  resumedTransitionID: number
  blockedTransitionID: number
  cancelledTransitionID: number
  usage: { tokenCount: number | null; toolCount: number; cost: number | null }
  worker: HostSession
  workerObservation: string
}

type RunnerTransitionRecord = {
  id: number
  task_id: string | null
  event: string
  payload: string
}

type RetainedVerificationSeed = RetainedVerification

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

type AdoptionFingerprintInput = {
  plan: PlanRow
  originalPlanVersion: number
  taskID: string
  taskRevision: number
  attemptID: string
  nodeState: string
  attemptState: string
  oldArtifact: string
  descendantCommit: string
  targetBranch: string
  landingHead: string
  reviewedBaseline: string
  candidateTree: string
  combinedArtifact: string
  reason: string
  environmentIdentity: string
}

type CommandContext = {
  command: PlanCommand
  caller: string
  baseVersion: number
  continuedOwner: string | undefined
  configuredWorker: ModelPolicy | undefined
  ownerSession: HostSession | null | undefined
  preflight: { bases: Map<string, BaseReach>; integration: IntegrationProof | undefined }
  terminalContinuation:
    { attemptID: string; messageID: string; inputID: string; worker: HostSession } | undefined
  terminalRepairContinuation: { operationID: string; owner: string } | undefined
  retainedRepairRecovery: RetainedRepairRecoverySeed | undefined
  adoptionSeed: AdoptionSeed | undefined
  retainedVerificationSeed: RetainedVerificationSeed | undefined
  retainedRepair: RetainedRepairSeed | undefined
  reviewInput: { binding: ReviewInputBinding; evidence: ReviewInputEvidence } | undefined
  startupSettlement:
    | {
        attempt: AttemptRow
        effect: EffectRow
        failure: StartupWorktreeFailureEvidence
        evidence: StartupAbsenceEvidence
      }
    | undefined
  cleanupDiagnostics: CleanupAuditDiagnostics | undefined
  obs: GitObservations
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

  private retainedVerificationWorkspacePath(operationID: string, phase: "task") {
    return canonicalProjectWorktreePath(this.directory, `retained-${operationID}-${phase}`)
  }

  /**
   * Versioned. `v1` (no prefix) hashes commit SHAs and stays valid for rows
   * already stored. `v2:` hashes tree OIDs and stable ids, so rewriting history
   * cannot invalidate it. New rows use v2; stored rows keep the version they
   * were written with.
   */
  private adoptionInputFingerprint(input: AdoptionFingerprintInput, version: "v1" | "v2" = "v2") {
    const task = this.store.repository.get(input.taskID)
    if (!task) throw new Error("Adoption task is missing")
    const base = {
      projectID: this.projectID,
      planID: input.plan.id,
      planRevision: input.plan.revision,
      planVersion: input.originalPlanVersion,
      taskID: input.taskID,
      taskRevision: input.taskRevision,
      taskProposal: task.proposal,
      attemptID: input.attemptID,
      nodeState: input.nodeState,
      attemptState: input.attemptState,
      targetBranch: input.targetBranch,
      candidateTree: input.candidateTree,
      effectiveWriteScope: this.store.effectiveWriteScope(input.taskID),
      reason: input.reason,
      environmentIdentity: input.environmentIdentity,
    }
    if (version === "v1")
      return fingerprint({
        ...base,
        planBody: input.plan.body,
        oldArtifact: input.oldArtifact,
        descendantCommit: input.descendantCommit,
        landingHead: input.landingHead,
        reviewedBaseline: input.reviewedBaseline,
        combinedArtifact: input.combinedArtifact,
      })
    const ref = (sha: string) => this.store.treeRef(sha)
    return `${FINGERPRINT_V2_PREFIX}${fingerprint({
      ...base,
      planBody: this.store.planBodyIdentity(input.plan.body),
      oldArtifact: ref(input.oldArtifact),
      descendantCommit: ref(input.descendantCommit),
      landingHead: ref(input.landingHead),
      reviewedBaseline: input.reviewedBaseline ? ref(input.reviewedBaseline) : "",
      combinedArtifact: ref(input.combinedArtifact),
    })}`
  }

  private currentAdoptionInputFingerprint(plan: PlanRow, adoption: AdoptionRow) {
    // Recompute with the version the row was stored with.
    return this.adoptionInputFingerprint(
      {
        plan,
        originalPlanVersion: adoption.plan_version,
        taskID: adoption.task_id,
        taskRevision: adoption.task_revision,
        attemptID: adoption.attempt_id,
        nodeState: adoption.node_state,
        attemptState: adoption.attempt_state,
        oldArtifact: adoption.old_artifact,
        descendantCommit: adoption.descendant_commit,
        targetBranch: adoption.target_branch,
        landingHead: adoption.landing_head,
        reviewedBaseline: adoption.reviewed_baseline,
        candidateTree: adoption.candidate_tree,
        combinedArtifact: adoption.combined_artifact,
        reason: adoption.reason,
        environmentIdentity: adoption.environment_identity,
      },
      isFingerprintV2(adoption.input_fingerprint) ? "v2" : "v1",
    )
  }

  private conflictingActiveAttempt(taskID: string): AttemptRow | undefined {
    const scope = this.store.effectiveReservationScope(taskID)
    return this.store
      .activeProjectAttempts()
      .find(
        (attempt) =>
          ["preparing", "running", "verifying"].includes(attempt.state) &&
          (attempt.workspace === this.directory ||
            scopePatternsConflict(scope, this.store.effectiveReservationScope(attempt.task_id))),
      )
  }

  private async reviewedAdoptionBaseline(
    targetBranch: string,
    oldArtifact: string,
    candidate: string,
  ) {
    const rows = this.store.atomic((db) =>
      db
        .query<{ event: string; payload: string }, [string]>(
          `SELECT t.event,t.payload FROM runner_transitions t
           JOIN runner_plans p ON p.id=t.plan_id
           WHERE p.project_directory=? AND t.event IN ('INTEGRATION_RECORDED','TASK_INTEGRATION_RECORDED')
           ORDER BY t.id`,
        )
        .all(this.directory),
    )
    const firstParent = (await gitAsync(this.directory, ["rev-list", "--first-parent", candidate]))
      .split(/\s+/)
      .filter(Boolean)
    const firstParentIndex = new Map(firstParent.map((commit, index) => [commit, index]))
    let baseline = oldArtifact
    let nearest = Number.POSITIVE_INFINITY
    for (const row of rows) {
      let payload: { artifact?: unknown; branch?: unknown; head?: unknown }
      try {
        payload = JSON.parse(row.payload) as typeof payload
      } catch {
        continue
      }
      if (
        payload.branch !== targetBranch ||
        typeof payload.artifact !== "string" ||
        typeof payload.head !== "string" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(payload.artifact) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(payload.head) ||
        payload.head === candidate
      )
        continue
      const position = firstParentIndex.get(payload.head)
      if (position === undefined || position >= nearest) continue
      try {
        await gitAsync(this.directory, ["merge-base", "--is-ancestor", oldArtifact, payload.head])
        await gitAsync(this.directory, [
          "merge-base",
          "--is-ancestor",
          payload.artifact,
          payload.head,
        ])
      } catch {
        continue
      }
      baseline = payload.head
      nearest = position
    }
    return baseline
  }

  private async adoptionArtifactScopeViolations(
    attempt: AttemptRow,
    artifact: string,
    branch: string,
  ) {
    // Worker scope belongs to its patch. The owner reviews the integrated branch
    // separately, and fresh checks qualify that exact descendant.
    const reviewed = await this.reviewedAdoptionBaseline(branch, attempt.base_commit, artifact)
    const base = await reviewedScopeBase(this.directory, attempt.base_commit, artifact, reviewed)
    const paths = (
      await gitAsync(this.directory, ["diff", "--name-only", "--no-renames", "-z", base, artifact])
    )
      .split("\0")
      .filter(Boolean)
    return protectedPaths(paths, this.store.effectiveScope(attempt.task_id))
  }

  private adoptionWorkerIdle(attempt: AttemptRow, worker: HostSession): boolean {
    return (
      worker.busy === false &&
      worker.pendingInput !== true &&
      !worker.observationUnstable &&
      (worker.pendingPermissions ?? 0) === 0 &&
      (worker.pendingForms ?? 0) === 0 &&
      Boolean(worker.outcome) &&
      ["completed", "interrupted"].includes(worker.turn?.state ?? "unknown") &&
      !this.backgroundBlockReason(worker)
    )
  }

  private async prepareAdoption(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ): Promise<AdoptionSeed> {
    if (
      !command.taskID ||
      !command.attemptID ||
      !command.artifact ||
      !command.descendantCommit ||
      !command.targetBranch ||
      !command.reason
    )
      throw new Error(
        "Descendant adoption requires taskID, attemptID, exact old artifact, descendantCommit, targetBranch and reason",
      )
    if (!this.validArchitect(ownerSession))
      throw new Error("Descendant adoption requires the current same-project Architect owner")
    if (plan.state !== "blocked")
      throw new Error("Descendant adoption is only available for a blocked, non-finalized plan")
    if (this.store.activeAdoptions(plan.id).length)
      throw new Error("A descendant adoption is already pending for this plan")
    if (
      this.store.effects(plan.id).some((effect) => ["intended", "uncertain"].includes(effect.state))
    )
      throw new Error("Uncertain effects must be resolved before descendant adoption")

    const input = PlanInput.parse(JSON.parse(plan.body))
    const node = this.store.nodes(plan.id).find((item) => item.task_id === command.taskID)
    const task = this.store.repository.get(command.taskID)
    const attempts = this.store
      .attempts(plan.id)
      .filter((attempt) => attempt.task_id === command.taskID)
    const latest = attempts.at(-1)
    if (!node || !task || !latest || latest.id !== command.attemptID)
      throw new Error("Descendant adoption must name the exact latest task attempt")
    if (
      task.revision !== 1 ||
      task.revision !== input.nodes.find((entry) => entry.taskID === task.id)?.revision
    )
      throw new Error("Task revision changed since plan admission")
    if (
      !["ready", "failed", "accepted"].includes(node.state) ||
      (node.state === "accepted" && latest.state !== "accepted") ||
      (node.state !== "accepted" && latest.state !== "failed")
    )
      throw new Error("Adoption requires the latest failed attempt or its accepted task result")
    if (
      !latest.artifact ||
      node.artifact !== latest.artifact ||
      command.artifact !== latest.artifact
    )
      throw new Error("Old artifact does not match the exact latest attempt and task result")
    if (
      this.store
        .nodes(plan.id)
        .some(
          (candidate) =>
            candidate.task_id !== command.taskID &&
            !["accepted", "incorporated"].includes(candidate.state),
        )
    )
      throw new Error("All other plan tasks must be accepted before adopting a descendant")

    if (this.conflictingActiveAttempt(command.taskID))
      throw new Error("A conflicting worker prevents descendant adoption")
    const scopes = this.store.effectiveReservationScope(command.taskID)
    if (
      this.store
        .activeAdoptions()
        .some((adoption) =>
          scopePatternsConflict(scopes, this.store.effectiveReservationScope(adoption.task_id)),
        )
    )
      throw new Error("An active descendant reservation conflicts with this task scope")

    const worker = await this.host.session(latest.session_id, { messages: true })
    if (
      !worker ||
      worker.id !== latest.session_id ||
      worker.projectID !== this.projectID ||
      worker.directory !== latest.workspace ||
      !isWorkerAgent(worker.agent) ||
      worker.archived ||
      worker.metadata?.lazersAttemptID !== latest.id
    )
      throw new Error("Latest worker session is not the owned attempt")
    if (!this.adoptionWorkerIdle(latest, worker))
      throw new Error("Latest worker activity or control state is not conclusively idle")

    const branch = await gitAsync(this.directory, ["branch", "--show-current"])
    const head = await gitAsync(this.directory, ["rev-parse", "HEAD"])
    if (branch !== command.targetBranch || command.descendantCommit !== head)
      throw new Error("Reviewed descendant must be the exact current HEAD of targetBranch")
    if (
      (await gitAsync(this.directory, ["status", "--porcelain", "--untracked-files=all"])) ||
      (await gitAsync(this.directory, ["ls-files", "-u", "-z"]))
    )
      throw new Error("Dirty or unmerged candidate checkout cannot be adopted")
    const oldArtifact = await gitAsync(this.directory, [
      "rev-parse",
      `${command.artifact}^{commit}`,
    ])
    const descendantCommit = await gitAsync(this.directory, [
      "rev-parse",
      `${command.descendantCommit}^{commit}`,
    ])
    if (oldArtifact !== command.artifact || descendantCommit !== command.descendantCommit)
      throw new Error("Adoption artifacts must be exact full commit identities")
    if (oldArtifact === descendantCommit)
      throw new Error("Reviewed candidate must be a strict descendant of the old artifact")
    await gitAsync(this.directory, ["merge-base", "--is-ancestor", oldArtifact, descendantCommit])
    const reviewedBaseline = await this.reviewedAdoptionBaseline(
      branch,
      oldArtifact,
      descendantCommit,
    )
    const violations = await this.adoptionArtifactScopeViolations(latest, oldArtifact, branch)
    if (violations.length)
      throw new Error(
        `Worker artifact contains changes outside the task's authorized scope: ${violations.slice(0, 20).join(", ")}`,
      )
    const candidateTree = await gitAsync(this.directory, [
      "rev-parse",
      `${descendantCommit}^{tree}`,
    ])
    const branches = input.integrationOrder.map((taskID) => {
      if (taskID === command.taskID) return descendantCommit
      const other = this.store.nodes(plan.id).find((candidate) => candidate.task_id === taskID)
      if (!other?.artifact || !["accepted", "incorporated"].includes(other.state))
        throw new Error("Combined adoption requires every other task's accepted artifact")
      return other.artifact
    })
    const combinedArtifact = await combineArtifacts(this.directory, input.baseCommit, branches)
    const seed = {
      taskID: task.id,
      taskRevision: task.revision,
      attemptID: latest.id,
      nodeState: node.state,
      attemptState: latest.state,
      oldArtifact,
      descendantCommit,
      targetBranch: branch,
      landingHead: head,
      reviewedBaseline,
      candidateTree,
      combinedArtifact,
      reason: command.reason,
    }
    const environmentIdentity = verificationEnvironmentIdentity()
    return {
      ...seed,
      environmentIdentity,
      inputFingerprint: this.adoptionInputFingerprint({
        plan,
        originalPlanVersion: plan.version,
        ...seed,
        environmentIdentity,
      }),
    }
  }

  private retainedRepairCandidateCurrent(
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

  private async observeRetainedRepairCandidate(
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

  private assertRetainedVerificationScopeAvailable(
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

  private async prepareRetainedVerification(
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

  private sameModel(left: ModelPolicy | undefined, right: ModelPolicy | undefined) {
    return sameNativeModel(left, right)
  }

  private retainedAttemptPlanModelMatches(plan: PlanRow, model: ModelPolicy) {
    try {
      const planModel = plan.model ? ModelPolicy.safeParse(JSON.parse(plan.model)) : undefined
      return Boolean(planModel?.success && sameModelSnapshot(model, planModel.data))
    } catch {
      return false
    }
  }

  private retainedAttemptDecisionModel(
    plan: PlanRow,
    model: ModelPolicy,
    routeDecision: unknown,
  ): ModelPolicy | undefined {
    const decision = DispatchRouteDecisionSchema.safeParse(routeDecision)
    if (
      !decision.success ||
      decision.data.status !== "resolved" ||
      !sameModelSnapshot(model, decision.data.route)
    )
      return undefined
    if (
      decision.data.source === "explicit-plan-selection" &&
      !this.retainedAttemptPlanModelMatches(plan, model)
    )
      return undefined
    return model
  }

  private retainedAttemptModel(plan: PlanRow, attempt: AttemptRow): ModelPolicy | undefined {
    try {
      const policy = JSON.parse(attempt.policy) as {
        model?: unknown
        routeDecision?: unknown
      }
      const model = ModelPolicy.safeParse(policy.model)
      if (!model.success) return undefined
      if (policy.routeDecision === undefined)
        return this.retainedAttemptPlanModelMatches(plan, model.data) ? model.data : undefined
      return this.retainedAttemptDecisionModel(plan, model.data, policy.routeDecision)
    } catch {
      return undefined
    }
  }

  private retainedRepairObservation(worker: HostSession) {
    return JSON.stringify({
      id: worker.id,
      parentID: worker.parentID ?? null,
      projectID: worker.projectID,
      directory: worker.directory,
      agent: worker.agent,
      archived: worker.archived,
      attemptID: worker.metadata?.lazersAttemptID,
      model: worker.model ?? null,
      busy: worker.busy,
      pendingInput: worker.pendingInput,
      pendingPermissions: worker.pendingPermissions,
      pendingForms: worker.pendingForms,
      observationUnstable: worker.observationUnstable ?? false,
      outcome: worker.outcome ?? null,
      turn: worker.turn ?? null,
      runningShells: worker.runningShells ?? 0,
      activeChildren: worker.activeChildren ?? 0,
      idleAt: worker.idleAt ?? null,
      messages: worker.messages.map((message) => ({ id: message.id, type: message.type ?? null })),
    })
  }

  private retainedRepairWorkerProblem(
    plan: PlanRow,
    attempt: AttemptRow,
    worker: HostSession | null | undefined,
    expectedInputID: string,
    model: ModelPolicy,
    expectedOutcome: "succeeded" | "interrupted" | "failed" = "succeeded",
  ) {
    if (
      !worker ||
      worker.id !== attempt.session_id ||
      worker.projectID !== this.projectID ||
      worker.directory !== attempt.workspace ||
      !isWorkerAgent(worker.agent) ||
      worker.archived ||
      worker.metadata?.lazersAttemptID !== attempt.id ||
      !this.sameModel(worker.model, model)
    )
      return "Retained repair worker identity, location, or route changed"
    if (
      worker.busy !== false ||
      worker.pendingInput !== false ||
      worker.observationUnstable ||
      worker.pendingPermissions !== 0 ||
      worker.pendingForms !== 0
    )
      return "Retained repair worker has active foreground or pending executable controls"
    const expectedTurnState = expectedOutcome === "interrupted" ? "interrupted" : "completed"
    if (
      worker.outcome !== expectedOutcome ||
      worker.turn?.state !== expectedTurnState ||
      worker.turn.inputID !== expectedInputID
    )
      return expectedOutcome === "interrupted"
        ? "Retained repair worker's exact interrupted input is no longer its current turn"
        : "Retained repair worker's accepted input is no longer its completed current turn"
    return undefined
  }

  private retainedRepairBackgroundProblem(
    worker: HostSession | null | undefined,
    inputID: string | undefined,
  ) {
    if (!worker) return "Retained repair worker session is unavailable"
    const reason = this.backgroundBlockReason(worker)
    if (reason) return `${reason}; it must finish before the retained repair can continue`
    if (!inputID || worker.turn?.inputID !== inputID)
      return "Retained repair worker's current turn is not the repaired input"
    return undefined
  }

  private transitionHistory(planID: string): RunnerTransitionRecord[] {
    return this.store.atomic((db) =>
      db
        .query<RunnerTransitionRecord, [string]>(
          "SELECT id,task_id,event,payload FROM runner_transitions WHERE plan_id=? ORDER BY id",
        )
        .all(planID),
    )
  }

  private parseTransitionPayload<T>(transition: RunnerTransitionRecord | undefined): T | undefined {
    if (!transition) return undefined
    try {
      return JSON.parse(transition.payload) as T
    } catch {
      return undefined
    }
  }

  private async prepareRetainedRepairRecovery(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
    attempt: AttemptRow,
  ): Promise<RetainedRepairRecoverySeed> {
    if (!command.taskID || !command.attemptID || !command.reason)
      throw new Error("Retained repair recovery requires the exact task, attempt and reason")
    if (!this.validArchitect(ownerSession) || ownerSession.projectID !== this.projectID)
      throw new Error("Retained repair recovery requires the current same-project Architect owner")
    if (plan.state !== "blocked" || plan.artifact !== null)
      throw new Error("Retained repair recovery requires the original blocked, unintegrated plan")

    const task = this.store.repository.get(command.taskID)
    const node = this.store.nodes(plan.id).find((candidate) => candidate.task_id === command.taskID)
    const latest = this.store
      .attempts(plan.id)
      .filter((candidate) => candidate.task_id === command.taskID)
      .at(-1)
    const input = PlanInput.parse(JSON.parse(plan.body))
    const admitted = input.nodes.find((candidate) => candidate.taskID === command.taskID)
    if (
      !task ||
      !node ||
      !latest ||
      latest.id !== attempt.id ||
      latest.id !== command.attemptID ||
      latest.state !== "cancelled" ||
      node.state !== "cancelled" ||
      task.revision !== admitted?.revision ||
      !sameProject(task.provenance.projectID, this.projectID) ||
      task.provenance.projectDirectory !== this.directory ||
      this.store.repository.taskDisposition(task.id)
    )
      throw new Error("Retained repair recovery must name the exact current cancelled attempt")

    const history = this.transitionHistory(plan.id)
    const repairTransition = history
      .filter(
        (transition) =>
          transition.task_id === task.id && transition.event === "RETAINED_REPAIR_REQUESTED",
      )
      .at(-1)
    const repair = this.parseTransitionPayload<Record<string, unknown>>(repairTransition)
    const operationID = repair?.operationID
    const repairMessageID = repair?.messageID
    const previousMessageID = repair?.previousMessageID
    const repairRoute = ModelPolicy.safeParse(repair?.route)
    const policy = (() => {
      try {
        return JSON.parse(attempt.policy) as { workspaceMode?: unknown; model?: unknown }
      } catch {
        return undefined
      }
    })()
    const attemptRoute = this.retainedAttemptModel(plan, attempt)
    const artifact = repair?.artifact
    if (
      !repairTransition ||
      typeof operationID !== "string" ||
      typeof repairMessageID !== "string" ||
      typeof previousMessageID !== "string" ||
      repair?.attemptID !== attempt.id ||
      repairTransition.task_id !== task.id ||
      typeof repair?.sessionID !== "string" ||
      repair.sessionID !== attempt.session_id ||
      repair.workspace !== attempt.workspace ||
      artifact !== attempt.artifact ||
      node.artifact !== null ||
      !isCommitID(artifact) ||
      !attemptRoute ||
      !repairRoute.success ||
      policy?.workspaceMode !== "isolated" ||
      !sameModelSnapshot(attemptRoute, repairRoute.data) ||
      this.store.latestTransition(plan.id, task.id, "TASK_INTEGRATION_RECORDED")
    )
      throw new Error("Retained repair recovery authority, artifact, route or task lineage changed")

    const repairEffects = this.store
      .effects(plan.id)
      .filter((effect) => effect.attempt_id === attempt.id)
    const unresolved = this.store
      .effects(plan.id)
      .some((effect) => ["intended", "uncertain"].includes(effect.state))
    const sessionReceipt = repairEffects.some((effect) => {
      if (effect.kind !== "session" || effect.state !== "completed") return false
      try {
        const payload = JSON.parse(effect.payload) as Record<string, unknown>
        const receipt = JSON.parse(effect.receipt ?? "null") as Record<string, unknown> | null
        return payload.sessionID === attempt.session_id && receipt?.sessionID === attempt.session_id
      } catch {
        return false
      }
    })
    const repairPromptReceipt = repairEffects.some((effect) => {
      if (effect.kind !== "prompt" || effect.state !== "completed") return false
      try {
        const payload = JSON.parse(effect.payload) as Record<string, unknown>
        const receipt = JSON.parse(effect.receipt ?? "null") as Record<string, unknown> | null
        return (
          payload.sessionID === attempt.session_id &&
          payload.messageID === repairMessageID &&
          payload.workspace === attempt.workspace &&
          payload.repairID === operationID &&
          receipt?.messageID === repairMessageID &&
          receipt?.taskID === task.id &&
          receipt?.repairID === operationID
        )
      } catch {
        return false
      }
    })
    if (!sessionReceipt || !repairPromptReceipt || unresolved)
      throw new Error(
        "Retained repair recovery requires completed original receipts and no uncertain effects",
      )
    if (
      repairEffects.some((effect) => {
        if (effect.kind !== "prompt") return false
        try {
          return JSON.parse(effect.payload).messageID === attempt.message_id
        } catch {
          return false
        }
      })
    )
      throw new Error("Retained repair recovery refuses an already-admitted reservation input")

    const matchingResume = history
      .filter(
        (transition) => transition.task_id === task.id && transition.event === "ATTEMPT_RESUMED",
      )
      .map((transition) => ({
        transition,
        payload: this.parseTransitionPayload<Record<string, unknown>>(transition),
      }))
      .filter(({ payload }) => payload?.attemptID === attempt.id)
      .at(-1)
    const resumed = matchingResume?.payload
    const priorHoldTransition = matchingResume
      ? history
          .filter(
            (transition) =>
              transition.task_id === null &&
              transition.event === "BLOCKED" &&
              transition.id < matchingResume.transition.id,
          )
          .at(-1)
      : undefined
    const priorHold = this.parseTransitionPayload<{ workerObservation?: TerminalWorkerHold }>(
      priorHoldTransition,
    )?.workerObservation
    const fenceBlockTransition = matchingResume
      ? history
          .filter(
            (transition) =>
              transition.task_id === null &&
              transition.event === "BLOCKED" &&
              transition.id > matchingResume.transition.id,
          )
          .at(-1)
      : undefined
    const fenceBlock = this.parseTransitionPayload<{
      reason?: unknown
      workerObservation?: unknown
    }>(fenceBlockTransition)
    const cancelTransition = history
      .filter((transition) => transition.task_id === task.id && transition.event === "CANCEL")
      .at(-1)
    const cancel = this.parseTransitionPayload<{ from?: unknown; to?: unknown; reason?: unknown }>(
      cancelTransition,
    )
    if (
      !matchingResume ||
      !resumed ||
      resumed.previousMessageID !== repairMessageID ||
      resumed.messageID !== attempt.message_id ||
      resumed.terminalOutcome !== "interrupted" ||
      resumed.terminalInputID !== repairMessageID ||
      resumed.interruptedInputID !== repairMessageID ||
      resumed.retainedRepairContinuation !== undefined ||
      resumed.retainedRepairRecovery !== undefined ||
      !priorHoldTransition ||
      priorHoldTransition.id <= repairTransition.id ||
      priorHold?.kind !== "terminal-worker-observation" ||
      priorHold.attemptID !== attempt.id ||
      priorHold.sessionID !== attempt.session_id ||
      priorHold.workspace !== attempt.workspace ||
      priorHold.inputID !== repairMessageID ||
      priorHold.outcome !== "interrupted" ||
      priorHold.turnState !== "interrupted" ||
      !fenceBlockTransition ||
      fenceBlock?.reason !== RETAINED_REPAIR_FENCE_FAILURE_REASON ||
      fenceBlock.workerObservation !== undefined ||
      plan.reason !== RETAINED_REPAIR_FENCE_FAILURE_REASON ||
      !cancelTransition ||
      cancelTransition.id <= fenceBlockTransition.id ||
      cancel?.from !== "running" ||
      cancel.to !== "cancelled" ||
      cancel.reason !== null ||
      history.some(
        (transition) =>
          transition.task_id === null &&
          transition.event === "CANCEL_REQUESTED" &&
          transition.id > repairTransition.id,
      )
    )
      throw new Error(
        "Retained repair cancellation is not the exact runtime-created interrupted fence failure",
      )

    const stopped = history
      .filter(
        (transition) =>
          transition.task_id === task.id &&
          transition.event === "WORKER_STOPPED" &&
          transition.id < matchingResume.transition.id,
      )
      .map((transition) => ({
        transition,
        payload: this.parseTransitionPayload<Record<string, unknown>>(transition),
      }))
      .filter(
        ({ payload }) =>
          payload?.attemptID === attempt.id &&
          payload.sessionID === attempt.session_id &&
          payload.workspace === attempt.workspace &&
          payload.outcome === "interrupted" &&
          payload.inputID === repairMessageID,
      )
      .at(-1)?.payload
    if (!stopped)
      throw new Error(
        "Retained repair recovery has no matching durable interrupted-worker stop receipt",
      )

    this.assertNoDispatchedDependents(plan, task.id, input)
    if (
      !existsSync(attempt.workspace) ||
      attempt.workspace === this.directory ||
      realpathSync(await gitAsync(attempt.workspace, ["rev-parse", "--show-toplevel"])) !==
        realpathSync(attempt.workspace) ||
      (await gitAsync(attempt.workspace, ["rev-parse", `${artifact}^{commit}`])) !== artifact ||
      !(await commitIsAncestor(
        attempt.workspace,
        artifact,
        await gitAsync(attempt.workspace, ["rev-parse", "HEAD"]),
      )) ||
      !isCommitID(attempt.base_commit) ||
      !(await commitIsAncestor(attempt.workspace, attempt.base_commit, artifact)) ||
      !this.preparationAllowed(attempt)
    )
      throw new Error("Retained repair recovery no longer matches the original retained checkout")
    const nativeWorktrees = await this.host.worktrees()
    if (!nativeWorktrees.some((workspace) => samePhysicalWorkspace(workspace, attempt.workspace)))
      throw new Error(
        "Retained repair recovery checkout is not owned by the native worktree adapter",
      )

    const freshOwner = async () => {
      const current = await this.host.session(plan.owner)
      if (
        !this.validArchitect(current) ||
        current.id !== caller ||
        current.projectID !== this.projectID
      )
        throw new Error("Retained repair recovery owner changed during native revalidation")
      return current
    }
    const firstWorker = await this.host.session(attempt.session_id, { messages: true })
    const currentOwner = await freshOwner()
    const confirmedWorker = await this.host.session(attempt.session_id, { messages: true })
    const route = attemptRoute
    const problem = this.retainedRepairWorkerProblem(
      plan,
      attempt,
      confirmedWorker,
      repairMessageID,
      route,
      "interrupted",
    )
    if (
      problem ||
      !firstWorker ||
      !confirmedWorker ||
      this.retainedRepairObservation(firstWorker) !==
        this.retainedRepairObservation(confirmedWorker) ||
      confirmedWorker.messages.some((message) => message.id === attempt.message_id)
    )
      throw new Error(problem ?? "Retained repair recovery worker changed during revalidation")

    const historicalAttempt = { ...attempt, state: "running" as const, message_id: repairMessageID }
    const continuationProblem = checkTerminalWorkerContinuation({
      plan: { state: "blocked", owner: plan.owner, model: JSON.stringify(route), artifact: null },
      node: { task_id: node.task_id, state: "running" },
      attempt: historicalAttempt,
      latestAttemptID: attempt.id,
      commandTaskID: command.taskID,
      commandAttemptID: command.attemptID,
      caller,
      owner: currentOwner,
      worker: confirmedWorker,
      projectID: this.projectID,
      taskCurrent: true,
      assignedInputMatches: confirmedWorker.turn?.inputID === repairMessageID,
      stopObservation: stopped,
      planHoldObservation: priorHold,
      retainedSession: sessionReceipt,
      retainedPrompt: repairPromptReceipt,
      hasUnresolvedEffects: unresolved,
      reservationAvailable: this.preparationAllowed(attempt),
    } satisfies TerminalWorkerContinuationFacts)
    if (continuationProblem) throw new Error(continuationProblem)
    if (this.store.plan(plan.id)?.version !== plan.version)
      throw new Error(
        "Retained repair recovery plan or owner authorization changed during revalidation",
      )

    return {
      operationID,
      attemptID: attempt.id,
      taskID: task.id,
      failedMessageID: attempt.message_id,
      interruptedInputID: repairMessageID,
      owner: caller,
      taskRevision: task.revision,
      planVersion: plan.version,
      planRevision: plan.revision,
      resumedTransitionID: matchingResume.transition.id,
      blockedTransitionID: fenceBlockTransition.id,
      cancelledTransitionID: cancelTransition.id,
      usage: {
        tokenCount: attempt.token_count,
        toolCount: attempt.tool_count,
        cost: attempt.cost,
      },
      worker: confirmedWorker,
      workerObservation: this.retainedRepairObservation(confirmedWorker),
    }
  }

  private retainedRepairRecoveryCurrent(
    plan: PlanRow,
    attempt: AttemptRow,
    recovery: RetainedRepairRecoverySeed,
  ) {
    const currentPlan = this.store.plan(plan.id)
    const currentAttempt = this.store
      .attempts(plan.id)
      .find((candidate) => candidate.id === attempt.id)
    const currentNode = this.store
      .nodes(plan.id)
      .find((candidate) => candidate.task_id === attempt.task_id)
    const currentRepair = currentAttempt ? this.retainedRepairForAttempt(currentAttempt) : undefined
    const history = this.transitionHistory(plan.id)
    const matching = (id: number, event: string, taskID: string | null) =>
      history.find(
        (transition) =>
          transition.id === id && transition.event === event && transition.task_id === taskID,
      )
    return Boolean(
      currentPlan?.state === "blocked" &&
      currentPlan.version === recovery.planVersion &&
      currentPlan.revision === recovery.planRevision &&
      currentPlan.reason === RETAINED_REPAIR_FENCE_FAILURE_REASON &&
      currentAttempt?.state === "cancelled" &&
      currentAttempt.message_id === recovery.failedMessageID &&
      currentAttempt.session_id === attempt.session_id &&
      currentAttempt.workspace === attempt.workspace &&
      currentAttempt.base_commit === attempt.base_commit &&
      currentAttempt.policy === attempt.policy &&
      currentRepair?.operationID === recovery.operationID &&
      currentAttempt.token_count === recovery.usage.tokenCount &&
      currentAttempt.tool_count === recovery.usage.toolCount &&
      currentAttempt.cost === recovery.usage.cost &&
      currentNode?.state === "cancelled" &&
      matching(recovery.resumedTransitionID, "ATTEMPT_RESUMED", attempt.task_id) &&
      matching(recovery.blockedTransitionID, "BLOCKED", null) &&
      matching(recovery.cancelledTransitionID, "CANCEL", attempt.task_id) &&
      !history.some(
        (transition) =>
          transition.task_id === null &&
          transition.event === "CANCEL_REQUESTED" &&
          transition.id > recovery.blockedTransitionID,
      ) &&
      !this.store
        .effects(plan.id)
        .some((effect) => ["intended", "uncertain"].includes(effect.state)) &&
      this.preparationAllowed(attempt),
    )
  }

  private assertNoDispatchedDependents(plan: PlanRow, taskID: string, input: PlanInput) {
    const reachable = new Set<string>([taskID])
    let changed = true
    while (changed) {
      changed = false
      for (const edge of input.dependencies)
        if (reachable.has(edge.prerequisite) && !reachable.has(edge.successor)) {
          reachable.add(edge.successor)
          changed = true
        }
    }
    const dependentTask = [...reachable].find(
      (candidate) =>
        candidate !== taskID &&
        this.store.attempts(plan.id).some((attempt) => attempt.task_id === candidate),
    )
    if (dependentTask)
      throw new Error(
        `A dispatched transitive dependent prevents retained repair: ${dependentTask}`,
      )

    const dependentPlan = this.store.startedDependentPlan(plan.id)
    if (dependentPlan)
      throw new Error(
        `A dispatched cross-plan dependent prevents retained repair: ${dependentPlan.id}`,
      )
  }

  private retainedRepairAttemptAccepted(plan: PlanRow, attempt: AttemptRow, taskRevision: number) {
    if (attempt.state === "accepted") return true
    if (attempt.state !== "failed") return false
    return this.store
      .atomic((db) => retainedVerificationsForPlan(db, this.directory, plan.id))
      .some(
        (operation) =>
          operation.state === "accepted" &&
          operation.projectID === this.projectID &&
          operation.taskID === attempt.task_id &&
          operation.taskRevision === taskRevision &&
          operation.attemptID === attempt.id &&
          operation.artifact === attempt.artifact &&
          operation.originalSessionID === attempt.session_id &&
          operation.originalMessageID === attempt.message_id,
      )
  }

  private async prepareRetainedRepair(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ): Promise<RetainedRepairSeed> {
    if (!command.taskID || !command.attemptID || !command.artifact || !command.reason?.trim())
      throw new Error(
        "Retained repair requires taskID, attemptID, exact artifact and concrete defect reason",
      )
    if (!this.validArchitect(ownerSession))
      throw new Error("Retained repair requires the current same-project Architect owner")
    if (!["running", "accepted", "blocked"].includes(plan.state))
      throw new Error("Retained repair requires a running, accepted or blocked, unintegrated plan")
    if (this.store.activeAdoptions(plan.id).length)
      throw new Error("A descendant adoption prevents retained repair")
    if (
      this.store.effects(plan.id).some((effect) => ["intended", "uncertain"].includes(effect.state))
    )
      throw new Error("Uncertain effects must be resolved before retained repair")

    const input = PlanInput.parse(JSON.parse(plan.body))
    const task = this.store.repository.get(command.taskID)
    const node = this.store.nodes(plan.id).find((item) => item.task_id === command.taskID)
    const attempts = this.store
      .attempts(plan.id)
      .filter((attempt) => attempt.task_id === command.taskID)
    const attempt = attempts.at(-1)
    const admitted = input.nodes.find((item) => item.taskID === command.taskID)
    if (
      !task ||
      !node ||
      !attempt ||
      attempt.id !== command.attemptID ||
      node.state !== "accepted" ||
      !this.retainedRepairAttemptAccepted(plan, attempt, task.revision) ||
      !admitted ||
      admitted.revision !== task.revision ||
      !sameProject(task.provenance.projectID, this.projectID) ||
      task.provenance.projectDirectory !== this.directory ||
      this.store.repository.taskDisposition(task.id)
    )
      throw new Error("Retained repair must name the latest accepted task and attempt")
    if (
      !isCommitID(command.artifact) ||
      attempt.artifact !== command.artifact ||
      node.artifact !== command.artifact
    )
      throw new Error("Retained repair artifact must exactly match the accepted task and attempt")

    let policy: { workspaceMode?: unknown }
    try {
      policy = JSON.parse(attempt.policy) as typeof policy
    } catch {
      throw new Error("Retained attempt policy is unavailable")
    }
    const attemptModel = this.retainedAttemptModel(plan, attempt)
    if (
      attempt.workspace === this.directory ||
      policy.workspaceMode !== "isolated" ||
      !attemptModel
    )
      throw new Error(
        "Retained repair requires the original isolated workspace and execution route",
      )

    const effects = this.store.effects(plan.id).filter((effect) => effect.attempt_id === attempt.id)
    const sessionEffect = effects.find((effect) => effect.kind === "session")
    const originalPrompt = effects.find(
      (effect) =>
        effect.kind === "prompt" &&
        (() => {
          try {
            const payload = JSON.parse(effect.payload)
            return (
              payload.messageID === attempt.message_id &&
              payload.sessionID === attempt.session_id &&
              payload.workspace === attempt.workspace
            )
          } catch {
            return false
          }
        })(),
    )
    if (sessionEffect?.state !== "completed" || originalPrompt?.state !== "completed")
      throw new Error("Retained session or assigned prompt is not conclusively owned")
    if (this.store.latestTransition(plan.id, task.id, "TASK_INTEGRATION_RECORDED"))
      throw new Error("Source-landed task work cannot be repaired in its retained workspace")

    this.assertNoDispatchedDependents(plan, task.id, input)
    if (!this.host.waitForSession)
      throw new Error("Public foreground wait is unavailable for retained repair")
    if (!existsSync(attempt.workspace)) throw new Error("Retained repair workspace is missing")
    const worktrees = await this.host.worktrees()
    if (
      !worktrees.some((directory) => samePhysicalWorkspace(directory, attempt.workspace)) ||
      realpathSync(attempt.workspace) === realpathSync(this.directory) ||
      realpathSync(await gitAsync(attempt.workspace, ["rev-parse", "--show-toplevel"])) !==
        realpathSync(attempt.workspace)
    )
      throw new Error("Retained repair requires the exact native-owned isolated worktree")
    const workspaceHead = await gitAsync(attempt.workspace, ["rev-parse", "HEAD"])
    if (
      (await gitAsync(attempt.workspace, ["rev-parse", `${command.artifact}^{commit}`])) !==
        command.artifact ||
      workspaceHead !== command.artifact
    )
      throw new Error("Retained repair artifact is missing or not the workspace HEAD")
    const sourceHead = await gitAsync(this.directory, ["rev-parse", "HEAD"])
    if (await commitIsAncestor(this.directory, command.artifact, sourceHead))
      throw new Error("Source-landed task work cannot be repaired in its retained workspace")
    if (!this.preparationAllowed(attempt))
      throw new Error("A conflicting reservation prevents retained repair")
    if (
      this.store
        .activeProjectAttempts()
        .some(
          (other) =>
            other.id !== attempt.id && samePhysicalWorkspace(other.workspace, attempt.workspace),
        )
    )
      throw new Error("Another active attempt owns the retained repair workspace")

    const previousMessageID = attempt.message_id
    await this.host.waitForSession(attempt.session_id)
    const observed = await this.host.session(attempt.session_id, { messages: true })
    const nativeInputID = observed?.turn?.inputID ?? undefined
    const backgroundProblem = this.retainedRepairBackgroundProblem(observed, nativeInputID)
    if (!nativeInputID || !this.matchesWorkerInput(attempt, nativeInputID))
      throw new Error("Retained repair requires the exact captured successful native input")
    const problem = this.retainedRepairWorkerProblem(
      plan,
      attempt,
      observed,
      nativeInputID,
      attemptModel,
    )
    if (backgroundProblem || problem) throw new Error(backgroundProblem ?? problem)
    const currentOwner = await this.host.session(plan.owner)
    if (!this.validArchitect(currentOwner) || currentOwner.id !== caller)
      throw new Error("Retained repair owner changed during native observation")
    const confirmed = await this.host.session(attempt.session_id, { messages: true })
    const confirmedProblem = this.retainedRepairWorkerProblem(
      plan,
      attempt,
      confirmed,
      nativeInputID,
      attemptModel,
    )
    const confirmedBackgroundProblem = this.retainedRepairBackgroundProblem(
      confirmed,
      nativeInputID,
    )
    if (
      confirmedProblem ||
      confirmedBackgroundProblem ||
      !observed ||
      !confirmed ||
      this.retainedRepairObservation(observed) !== this.retainedRepairObservation(confirmed)
    )
      throw new Error(
        confirmedProblem ??
          confirmedBackgroundProblem ??
          "Retained worker input or ownership changed during repair admission",
      )
    if (this.store.plan(plan.id)?.version !== plan.version) throw new PlanMovedDuringCommand()
    return {
      taskID: task.id,
      attemptID: attempt.id,
      artifact: command.artifact,
      previousMessageID,
      nativeInputID,
      messageID: messageID(),
      operationID: crypto.randomUUID(),
      owner: caller,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      model: attemptModel,
      workerObservation: this.retainedRepairObservation(confirmed),
    }
  }

  private async prepareReviewInputReconciliation(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ): Promise<{ binding: ReviewInputBinding; evidence: ReviewInputEvidence } | undefined> {
    if (command.reviewInputID === undefined) return undefined
    if (command.action !== "reconcile" || !command.taskID || !command.attemptID)
      throw new Error("Review input reconciliation requires reconcile, taskID and attemptID")
    if (!this.validArchitect(ownerSession))
      throw new Error(
        "Review input reconciliation requires the current same-project Architect owner",
      )
    if (!(["running", "blocked"] as const).includes(plan.state as "running" | "blocked"))
      throw new Error("Review input reconciliation requires a running or blocked plan")
    if (this.store.activeAdoptions(plan.id).length)
      throw new Error(
        "A descendant adoption is pending; review input reconciliation is unavailable",
      )

    const proposal = PlanInput.parse(JSON.parse(plan.body))
    const task = this.store.repository.get(command.taskID)
    const node = this.store.nodes(plan.id).find((item) => item.task_id === command.taskID)
    const latest = this.store
      .attempts(plan.id)
      .filter((attempt) => attempt.task_id === command.taskID)
      .at(-1)
    const proposalNode = proposal.nodes.find((item) => item.taskID === command.taskID)
    if (
      !task ||
      !node ||
      !proposalNode ||
      !latest ||
      latest.id !== command.attemptID ||
      !["running", "verifying"].includes(latest.state) ||
      node.state !== latest.state ||
      task.revision !== proposalNode.revision ||
      !sameProject(task.provenance.projectID, this.projectID) ||
      task.provenance.projectDirectory !== this.directory
    )
      throw new Error(
        "Review input reconciliation must name the exact current running or verifying task attempt",
      )

    const model = ModelPolicy.parse(JSON.parse(latest.policy).model)
    const binding: ReviewInputBinding = {
      projectDirectory: this.directory,
      projectID: this.projectID,
      planID: plan.id,
      taskID: latest.task_id,
      attemptID: latest.id,
      sessionID: latest.session_id,
      workspace: latest.workspace,
      assignedMessageID: latest.message_id,
      reviewInputID: command.reviewInputID,
      ownerSessionID: plan.owner,
      commandRequestID: command.requestID,
      expectedPlanVersion: plan.version,
      model,
    }
    const worker = await this.host.session(latest.session_id, { messages: true })
    if (!worker) throw new Error("Exact review-input worker session is unavailable")
    const observedEvidence = observeReviewInput(worker, binding)

    // Recheck owner liveness after the asynchronous worker observation. The
    // worker is then read again so input/execution changes during that owner
    // read cannot leave a stale relationship in the journal. The transaction
    // below separately fences durable reassignment/version/attempt races.
    const currentOwner = await this.host.session(plan.owner)
    if (!this.validArchitect(currentOwner) || currentOwner.id !== caller)
      throw new Error("Review input reconciliation owner is no longer current and active")
    const currentWorker = await this.host.session(latest.session_id, { messages: true })
    if (!currentWorker) throw new Error("Exact review-input worker session is unavailable")
    const evidence = observeReviewInput(currentWorker, binding)
    if (JSON.stringify(evidence) !== JSON.stringify(observedEvidence))
      throw new Error("Review input native observation changed during owner revalidation")
    return { binding, evidence }
  }

  private terminalWorkerContinuationProblem(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    owner: HostSession | null | undefined,
    worker: HostSession | null | undefined,
  ) {
    const taskID = command.taskID
    const attempt = taskID
      ? this.store
          .attempts(plan.id)
          .filter((candidate) => candidate.task_id === taskID)
          .at(-1)
      : undefined
    const node = taskID
      ? this.store.nodes(plan.id).find((candidate) => candidate.task_id === taskID)
      : undefined
    const stopObservation = taskID
      ? this.store.latestTransition<Record<string, unknown>>(plan.id, taskID, "WORKER_STOPPED")
      : undefined
    const blockedObservation = this.store.latestTransition<{ workerObservation?: unknown }>(
      plan.id,
      null,
      "BLOCKED",
    )?.workerObservation
    let continuationPlan = plan
    if (attempt) {
      try {
        const attemptPolicy = JSON.parse(attempt.policy) as {
          model?: unknown
          routeDecision?: unknown
        }
        const decision = DispatchRouteDecisionSchema.safeParse(attemptPolicy.routeDecision)
        const route = ModelPolicy.safeParse(attemptPolicy.model)
        if (
          decision.success &&
          decision.data.status === "resolved" &&
          route.success &&
          sameModelSnapshot(decision.data.route, route.data)
        )
          continuationPlan = { ...plan, model: JSON.stringify(route.data) }
      } catch {
        // The retained attempt remains fail-closed if its route snapshot is malformed.
      }
    }
    const planHoldObservation =
      typeof blockedObservation === "object" && blockedObservation !== null
        ? (blockedObservation as TerminalWorkerHold)
        : undefined
    const effects = this.store.effects(plan.id)
    let taskCurrent = false
    if (attempt) {
      try {
        const admitted = PlanInput.parse(JSON.parse(plan.body)).nodes.find(
          (candidate) => candidate.taskID === attempt.task_id,
        )
        const task = this.store.repository.get(attempt.task_id)
        taskCurrent = Boolean(
          admitted &&
          task &&
          task.revision === admitted.revision &&
          task.provenance.projectID === this.projectID &&
          task.provenance.projectDirectory === this.directory &&
          !this.store.repository.taskDisposition(task.id),
        )
      } catch {
        taskCurrent = false
      }
    }
    return checkTerminalWorkerContinuation({
      plan: continuationPlan,
      node,
      attempt,
      latestAttemptID: attempt?.id,
      commandTaskID: command.taskID,
      commandAttemptID: command.attemptID,
      caller,
      owner,
      worker,
      projectID: this.projectID,
      taskCurrent,
      assignedInputMatches: Boolean(
        attempt && worker?.turn && this.matchesWorkerInput(attempt, worker.turn.inputID),
      ),
      stopObservation,
      planHoldObservation,
      retainedSession: Boolean(
        attempt &&
        effects.some((effect) => {
          if (
            effect.attempt_id !== attempt.id ||
            effect.kind !== "session" ||
            effect.state !== "completed"
          )
            return false
          try {
            return JSON.parse(effect.payload).sessionID === attempt.session_id
          } catch {
            return false
          }
        }),
      ),
      retainedPrompt: Boolean(
        attempt &&
        effects.some((effect) => {
          if (
            effect.attempt_id !== attempt.id ||
            effect.kind !== "prompt" ||
            effect.state !== "completed"
          )
            return false
          try {
            const payload = JSON.parse(effect.payload)
            return (
              payload.sessionID === attempt.session_id &&
              payload.messageID === attempt.message_id &&
              payload.workspace === attempt.workspace
            )
          } catch {
            return false
          }
        }),
      ),
      hasUnresolvedEffects: effects.some((effect) =>
        ["intended", "uncertain"].includes(effect.state),
      ),
      reservationAvailable: attempt ? this.preparationAllowed(attempt) : false,
    })
  }

  private startupSettlementCandidate(
    plan: PlanRow,
    taskID: string,
    attemptID: string,
  ): { attempt: AttemptRow; effect: EffectRow; failure: StartupWorktreeFailureEvidence } {
    if (plan.state !== "blocked") throw new Error("Startup settlement requires a blocked plan")
    const input = PlanInput.parse(JSON.parse(plan.body))
    if (input.workspaceMode !== "isolated")
      throw new Error("Startup settlement applies only to isolated worktree creation")
    const node = this.store.nodes(plan.id).find((candidate) => candidate.task_id === taskID)
    const attempt = this.store.attempts(plan.id).find((candidate) => candidate.id === attemptID)
    if (
      !node ||
      node.state !== "running" ||
      !attempt ||
      attempt.task_id !== taskID ||
      attempt.plan_id !== plan.id ||
      attempt.state !== "preparing" ||
      attempt.workspace === this.directory
    )
      throw new Error("Startup settlement identity does not match a preparing attempt")
    const effects = this.store.effects(plan.id)
    const authorization = this.startupRecoveryAuthorization(plan, attempt)
    let effect: EffectRow | undefined
    if (authorization) {
      effect = this.historicalStartupRecoveryOperation(plan, attempt, effects, authorization)
      if (!effect)
        throw new Error("Startup settlement requires the current linked recovery operation")
    } else {
      effect = effects.find(
        (candidate) =>
          candidate.kind === "worktree" &&
          candidate.task_id === taskID &&
          candidate.attempt_id === attemptID,
      )
    }
    if (!effect || effect.state !== "uncertain")
      throw new Error("Startup settlement requires the current uncertain startup worktree effect")
    const failure = startupWorktreeFailureEvidence({
      planID: plan.id,
      taskID: attempt.task_id,
      attemptID: attempt.id,
      effectID: effect.id,
      kind: effect.kind,
      state: effect.state,
      receipt: effect.receipt,
      payload: effect.payload,
      sessionID: attempt.session_id,
      messageID: attempt.message_id,
      workspace: attempt.workspace,
      base: attempt.base_commit,
    })
    if (!failure || startupFailureSettlementFromReceipt(effect.receipt))
      throw new Error(
        "Startup worktree effect lacks bound terminal native failure evidence or exact legacy inference",
      )

    if (
      effects.some(
        (candidate) =>
          ["intended", "uncertain"].includes(candidate.state) && candidate.id !== effect.id,
      ) ||
      effects.some(
        (candidate) =>
          candidate.attempt_id === attemptID &&
          (candidate.kind === "session" ||
            candidate.kind === "prompt" ||
            candidate.kind.startsWith("verify:") ||
            candidate.kind.startsWith("graph-verify:")),
      ) ||
      this.hasMeaningfulWorkerProgress(attemptID) ||
      this.store.latestTransition<{ attemptID?: string }>(plan.id, taskID, "WORKER_STARTED")
        ?.attemptID === attemptID ||
      !this.preparationAllowed(attempt)
    )
      throw new Error("Startup settlement is unsafe after downstream work or conflicting ownership")
    return { attempt, effect, failure }
  }

  private hasMeaningfulWorkerProgress(attemptID: string) {
    return this.store
      .progressFacts([attemptID])
      .some((fact) => !isUnavailableSessionRecoveryGap(fact))
  }

  private startupSettlementForEffect(
    planID: string,
    attempt: AttemptRow,
    effect: EffectRow,
    effects = this.store.effects(planID),
  ): StartupAbsenceEvidence | undefined {
    if (
      effect.plan_id !== planID ||
      effect.task_id !== attempt.task_id ||
      effect.attempt_id !== attempt.id ||
      effect.state !== "failed" ||
      !["worktree", "worktree-recovery"].includes(effect.kind)
    )
      return undefined
    const settlement = startupFailureSettlementFromReceipt(effect.receipt)
    if (
      !settlement ||
      settlement.effectID !== effect.id ||
      settlement.planID !== planID ||
      settlement.attemptID !== attempt.id ||
      settlement.taskID !== attempt.task_id ||
      settlement.sessionID !== attempt.session_id ||
      settlement.workspace !== attempt.workspace ||
      settlement.base !== attempt.base_commit
    )
      return undefined
    if (settlement.legacyFailure) {
      const binding = settlement.legacyFailure.binding
      if (
        binding.planID !== planID ||
        binding.taskID !== attempt.task_id ||
        binding.attemptID !== attempt.id ||
        binding.effectID !== effect.id ||
        binding.sessionID !== attempt.session_id ||
        binding.messageID !== attempt.message_id ||
        binding.workspace !== attempt.workspace ||
        binding.base !== attempt.base_commit
      )
        return undefined
    }

    if (effect.kind === "worktree") {
      return effect.payload ===
        JSON.stringify({ workspace: attempt.workspace, base: attempt.base_commit })
        ? settlement
        : undefined
    }

    let operation: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(effect.payload)
      operation = isRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
    if (!operation) return undefined
    const sourceIndex = effects.findIndex((candidate) => candidate.id === operation?.sourceEffectID)
    const effectIndex = effects.findIndex((candidate) => candidate.id === effect.id)
    if (
      sourceIndex < 0 ||
      sourceIndex >= effectIndex ||
      operation.schema !== "lazers-worktree-recovery-operation/v1" ||
      operation.workspace !== attempt.workspace ||
      operation.base !== attempt.base_commit ||
      operation.sessionID !== attempt.session_id ||
      operation.messageID !== attempt.message_id ||
      operation.policy !== attempt.policy ||
      typeof operation.recoveryID !== "string" ||
      typeof operation.sourceEffectID !== "string" ||
      typeof operation.settlementRequestID !== "string" ||
      typeof operation.authorizationRequestID !== "string" ||
      typeof operation.authorizedOwner !== "string" ||
      typeof operation.authorizedVersion !== "number"
    )
      return undefined
    const source = effects.find((candidate) => candidate.id === operation.sourceEffectID)
    if (!source) return undefined
    const sourceSettlement = this.startupSettlementForEffect(planID, attempt, source, effects)
    if (
      !sourceSettlement ||
      sourceSettlement.requestID !== operation.settlementRequestID ||
      !this.store.activity(planID, attempt.task_id).some((entry) => {
        if (entry.event !== "STARTUP_RECOVERY_AUTHORIZED") return false
        try {
          const authorization = JSON.parse(entry.payload) as Record<string, unknown>
          return (
            authorization.schema === "lazers-worktree-startup-authorization/v1" &&
            authorization.recoveryID === operation.recoveryID &&
            authorization.sourceEffectID === source.id &&
            authorization.settlementRequestID === sourceSettlement.requestID &&
            authorization.requestID === operation.authorizationRequestID &&
            authorization.owner === operation.authorizedOwner &&
            authorization.planVersion === operation.authorizedVersion &&
            authorization.taskID === attempt.task_id &&
            authorization.attemptID === attempt.id &&
            authorization.sessionID === attempt.session_id &&
            authorization.messageID === attempt.message_id &&
            authorization.workspace === attempt.workspace &&
            authorization.base === attempt.base_commit &&
            authorization.policy === attempt.policy
          )
        } catch {
          return false
        }
      })
    )
      return undefined
    return settlement
  }

  private settledStartupEffect(planID: string, attempt: AttemptRow): EffectRow | undefined {
    const effects = this.store.effects(planID)
    return effects
      .filter((effect) => this.startupSettlementForEffect(planID, attempt, effect, effects))
      .at(-1)
  }

  private historicalStartupRecoveryOperation(
    plan: PlanRow,
    attempt: AttemptRow,
    effects: EffectRow[],
    authorization: StartupRecoveryAuthorization,
  ): EffectRow | undefined {
    if (
      authorization.planVersion > plan.version ||
      authorization.planRevision !== plan.revision ||
      authorization.taskID !== attempt.task_id ||
      authorization.attemptID !== attempt.id ||
      authorization.sessionID !== attempt.session_id ||
      authorization.messageID !== attempt.message_id ||
      authorization.workspace !== attempt.workspace ||
      authorization.base !== attempt.base_commit ||
      authorization.policy !== attempt.policy
    )
      return undefined
    const source = effects.find((candidate) => candidate.id === authorization.sourceEffectID)
    const sourceSettlement = source
      ? this.startupSettlementForEffect(plan.id, attempt, source, effects)
      : undefined
    if (!sourceSettlement || sourceSettlement.requestID !== authorization.settlementRequestID)
      return undefined
    const matching = effects.filter((candidate) => {
      if (
        candidate.kind !== "worktree-recovery" ||
        candidate.task_id !== attempt.task_id ||
        candidate.attempt_id !== attempt.id
      )
        return false
      try {
        const parsed: unknown = JSON.parse(candidate.payload)
        if (!isRecord(parsed)) return false
        const operation = parsed
        return (
          operation.recoveryID === authorization.recoveryID &&
          operation.sourceEffectID === authorization.sourceEffectID &&
          operation.settlementRequestID === authorization.settlementRequestID &&
          operation.authorizationRequestID === authorization.requestID &&
          operation.authorizedOwner === authorization.owner &&
          operation.authorizedVersion === authorization.planVersion &&
          operation.sessionID === authorization.sessionID &&
          operation.messageID === authorization.messageID &&
          operation.workspace === authorization.workspace &&
          operation.base === authorization.base &&
          operation.policy === authorization.policy
        )
      } catch {
        return false
      }
    })
    return matching.length === 1 ? matching[0] : undefined
  }

  private currentStartupRecoveryOperation(
    plan: PlanRow,
    attempt: AttemptRow,
    effects: EffectRow[],
    authorization: StartupRecoveryAuthorization,
  ) {
    if (!this.startupRecoveryAuthorityCurrent(plan, attempt, authorization)) return undefined
    return this.historicalStartupRecoveryOperation(plan, attempt, effects, authorization)
  }

  private completeStartupRecovery(
    plan: PlanRow,
    attempt: AttemptRow,
    operation: EffectRow,
    authorization: StartupRecoveryAuthorization,
    workspace: string,
    fence: number,
  ): boolean {
    return this.store.fenced(this.owner, fence, (db) => {
      const currentPlan = db
        .query<PlanRow, [string, string]>(
          "SELECT * FROM runner_plans WHERE id=? AND project_directory=?",
        )
        .get(plan.id, this.store.repository.projectDirectory)
      const currentAttempt = db
        .query<AttemptRow, [string]>("SELECT * FROM runner_attempts WHERE id=?")
        .get(attempt.id)
      const currentOperation = db
        .query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE id=?")
        .get(operation.id)
      const latestAuthorization = db
        .query<{ payload: string }, [string, string]>(
          `SELECT payload FROM runner_transitions
           WHERE plan_id=? AND task_id=? AND event='STARTUP_RECOVERY_AUTHORIZED'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(plan.id, attempt.task_id)
      let operationPayload: Record<string, unknown> | undefined
      try {
        const parsed: unknown = JSON.parse(currentOperation?.payload ?? "null")
        operationPayload = isRecord(parsed) ? parsed : undefined
      } catch {
        operationPayload = undefined
      }
      if (
        !currentPlan ||
        !currentAttempt ||
        !currentOperation ||
        currentPlan.state !== "running" ||
        currentPlan.version < authorization.planVersion ||
        currentPlan.revision !== authorization.planRevision ||
        !latestAuthorization ||
        fingerprint(JSON.parse(latestAuthorization.payload)) !== fingerprint(authorization) ||
        currentAttempt.state !== "preparing" ||
        currentAttempt.task_id !== attempt.task_id ||
        currentAttempt.session_id !== authorization.sessionID ||
        currentAttempt.message_id !== authorization.messageID ||
        currentAttempt.workspace !== authorization.workspace ||
        currentAttempt.base_commit !== authorization.base ||
        currentAttempt.policy !== authorization.policy ||
        currentOperation.plan_id !== plan.id ||
        currentOperation.task_id !== attempt.task_id ||
        currentOperation.attempt_id !== attempt.id ||
        currentOperation.kind !== "worktree-recovery" ||
        !["intended", "uncertain"].includes(currentOperation.state) ||
        operationPayload?.schema !== "lazers-worktree-recovery-operation/v1" ||
        operationPayload.recoveryID !== authorization.recoveryID ||
        operationPayload.sourceEffectID !== authorization.sourceEffectID ||
        operationPayload.settlementRequestID !== authorization.settlementRequestID ||
        operationPayload.authorizationRequestID !== authorization.requestID ||
        operationPayload.authorizedOwner !== authorization.owner ||
        operationPayload.authorizedVersion !== authorization.planVersion ||
        operationPayload.sessionID !== authorization.sessionID ||
        operationPayload.messageID !== authorization.messageID ||
        operationPayload.workspace !== authorization.workspace ||
        operationPayload.base !== authorization.base ||
        operationPayload.policy !== authorization.policy ||
        workspace !== authorization.workspace
      )
        return false
      const changed = db
        .query(
          "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'completed'),receipt=? WHERE id=? AND state IN ('intended','uncertain')",
        )
        .run(
          JSON.stringify({
            workspace,
            base: authorization.base,
            recoveryID: authorization.recoveryID,
            sourceEffectID: authorization.sourceEffectID,
            ready: true,
          }),
          operation.id,
        ).changes
      if (changed !== 1) return false
      this.store.record(plan.id, attempt.task_id, "EFFECT_COMPLETED", {
        effectID: operation.id,
        kind: operation.kind,
      })
      this.store.record(plan.id, attempt.task_id, "STARTUP_RECOVERY_WORKTREE_READY", {
        effectID: operation.id,
        sourceEffectID: authorization.sourceEffectID,
        recoveryID: authorization.recoveryID,
        attemptID: attempt.id,
        workspace,
        base: authorization.base,
      })
      return true
    })
  }

  private assertStartupSettlementCurrent(
    expectedPlan: PlanRow,
    expectedAttempt: AttemptRow,
    expectedEffect: EffectRow,
    failure: StartupWorktreeFailureEvidence,
  ) {
    const plan = this.store.plan(expectedPlan.id)
    const attempt = this.store
      .attempts(expectedPlan.id)
      .find((candidate) => candidate.id === expectedAttempt.id)
    const effect = this.store
      .effects(expectedPlan.id)
      .find((candidate) => candidate.id === expectedEffect.id)
    let currentCandidate:
      | { attempt: AttemptRow; effect: EffectRow; failure: StartupWorktreeFailureEvidence }
      | undefined
    try {
      if (plan && attempt)
        currentCandidate = this.startupSettlementCandidate(plan, attempt.task_id, attempt.id)
    } catch {
      currentCandidate = undefined
    }
    if (
      !plan ||
      plan.version !== expectedPlan.version ||
      plan.state !== "blocked" ||
      !attempt ||
      attempt.task_id !== expectedAttempt.task_id ||
      attempt.number !== expectedAttempt.number ||
      attempt.session_id !== expectedAttempt.session_id ||
      attempt.message_id !== expectedAttempt.message_id ||
      attempt.workspace !== expectedAttempt.workspace ||
      attempt.base_commit !== expectedAttempt.base_commit ||
      attempt.policy !== expectedAttempt.policy ||
      attempt.state !== "preparing" ||
      !effect ||
      effect.state !== "uncertain" ||
      effect.attempt_id !== expectedAttempt.id ||
      effect.task_id !== expectedAttempt.task_id ||
      currentCandidate?.effect.id !== expectedEffect.id ||
      fingerprint(currentCandidate.failure) !== fingerprint(failure) ||
      startupFailureSettlementFromReceipt(effect.receipt) ||
      !this.preparationAllowed(attempt)
    )
      throw new Error("Startup settlement identity, version, or ownership changed")
  }

  private async observeStartupAbsence(
    plan: PlanRow,
    attempt: AttemptRow,
    effect: EffectRow,
    failure: StartupWorktreeFailureEvidence,
    requestID: string,
  ): Promise<StartupAbsenceEvidence> {
    const candidates = startupWorktreeCandidates(attempt.workspace)
    const assertCurrent = () => this.assertStartupSettlementCurrent(plan, attempt, effect, failure)

    const worker = await this.host.session(attempt.session_id)
    assertCurrent()
    if (worker)
      throw new Error("Reserved worker session already exists; startup settlement refused")

    const nativeWorktrees = await this.host.worktrees()
    assertCurrent()
    if (nativeWorktrees.some((path) => isStartupWorktreeCandidate(attempt.workspace, path)))
      throw new Error("Native worktree or collision candidate exists; startup settlement refused")

    const gitWorktrees = (await worktreeListPorcelain(this.directory))
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
    if (gitWorktrees.some((path) => isStartupWorktreeCandidate(attempt.workspace, path)))
      throw new Error("Git worktree or collision candidate exists; startup settlement refused")

    for (const candidate of candidates) {
      let present = false
      try {
        lstatSync(candidate)
        present = true
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT")
          throw new Error(
            `Filesystem absence observation failed for ${candidate}: ${errorText(error)}`,
            { cause: error },
          )
      }
      if (present)
        throw new Error(
          "Filesystem worktree or collision candidate exists; startup settlement refused",
        )
    }

    const owner = await this.host.session(plan.owner)
    assertCurrent()
    if (!this.validArchitect(owner) || owner.id !== plan.owner)
      throw new Error("Current Architect owner changed during startup settlement")

    const evidence = {
      kind: "worktree-startup-failure-settled-absent" as const,
      schema: "lazers-worktree-startup-settlement/v1" as const,
      requestID,
      planID: plan.id,
      taskID: attempt.task_id,
      attemptID: attempt.id,
      effectID: effect.id,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      base: attempt.base_commit,
      observedAt: this.now(),
      observations: {
        candidates,
        nativeAbsent: true as const,
        gitAbsent: true as const,
        filesystemAbsent: true as const,
        sessionAbsent: true as const,
      },
    }
    return failure.kind === "native-typed-failure"
      ? { ...evidence, nativeFailure: failure.nativeFailure }
      : { ...evidence, legacyFailure: failure.legacyFailure }
  }

  private startupRecoveryAuthorization(
    plan: PlanRow,
    attempt: AttemptRow,
  ): StartupRecoveryAuthorization | undefined {
    const authorization = this.store.latestTransition<unknown>(
      plan.id,
      attempt.task_id,
      "STARTUP_RECOVERY_AUTHORIZED",
    )
    if (!isRecord(authorization)) return undefined
    if (
      authorization.schema !== "lazers-worktree-startup-authorization/v1" ||
      typeof authorization.recoveryID !== "string" ||
      typeof authorization.sourceEffectID !== "string" ||
      typeof authorization.settlementRequestID !== "string" ||
      typeof authorization.requestID !== "string" ||
      typeof authorization.owner !== "string" ||
      typeof authorization.planVersion !== "number" ||
      typeof authorization.planRevision !== "number" ||
      authorization.taskID !== attempt.task_id ||
      authorization.attemptID !== attempt.id ||
      typeof authorization.sessionID !== "string" ||
      typeof authorization.messageID !== "string" ||
      typeof authorization.workspace !== "string" ||
      typeof authorization.base !== "string" ||
      typeof authorization.policy !== "string"
    )
      return undefined
    return authorization as StartupRecoveryAuthorization
  }

  private startupRecoveryAuthorityCurrent(
    plan: PlanRow,
    attempt: AttemptRow,
    authorization: StartupRecoveryAuthorization,
  ) {
    const current = this.store.plan(plan.id)
    const currentAttempt = this.store
      .attempts(plan.id)
      .find((candidate) => candidate.id === attempt.id)
    return Boolean(
      current &&
      currentAttempt &&
      current.state === "running" &&
      current.version >= authorization.planVersion &&
      current.revision === authorization.planRevision &&
      currentAttempt.state === "preparing" &&
      currentAttempt.task_id === authorization.taskID &&
      currentAttempt.session_id === authorization.sessionID &&
      currentAttempt.message_id === authorization.messageID &&
      currentAttempt.workspace === authorization.workspace &&
      currentAttempt.base_commit === authorization.base &&
      currentAttempt.policy === authorization.policy,
    )
  }

  private async startupWorkspaceReady(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
  ): Promise<boolean> {
    if (attempt.workspace === this.directory) return true
    const effects = this.store.effects(plan.id).filter((effect) => effect.attempt_id === attempt.id)
    const matchingReceipt = (effect: EffectRow) => {
      if (effect.state !== "completed" || !effect.receipt) return false
      try {
        const receipt = JSON.parse(effect.receipt) as { workspace?: unknown; base?: unknown }
        return receipt.workspace === attempt.workspace && receipt.base === attempt.base_commit
      } catch {
        return false
      }
    }
    const recoveryAuthorization = this.startupRecoveryAuthorization(plan, attempt)
    const authorizedRecovery = recoveryAuthorization
      ? this.currentStartupRecoveryOperation(
          plan,
          attempt,
          this.store.effects(plan.id),
          recoveryAuthorization,
        )
      : undefined
    if (
      effects.some((effect) => effect.kind === "worktree" && matchingReceipt(effect)) ||
      (authorizedRecovery?.kind === "worktree-recovery" && matchingReceipt(authorizedRecovery))
    ) {
      try {
        if (!existsSync(attempt.workspace)) return false
        const head = await gitAsync(attempt.workspace, ["rev-parse", "HEAD"])
        const workerWasAdmitted =
          effects.some(
            (effect) =>
              effect.kind === "prompt" &&
              effect.state === "completed" &&
              effect.attempt_id === attempt.id,
          ) || this.hasMeaningfulWorkerProgress(attempt.id)
        return workerWasAdmitted || head === attempt.base_commit
      } catch {
        return false
      }
    }

    const authorization = this.startupRecoveryAuthorization(plan, attempt)
    if (!authorization || !this.startupRecoveryAuthorityCurrent(plan, attempt, authorization))
      return false
    const sourceEffect = effects.find((effect) => effect.id === authorization.sourceEffectID)
    const settlement = sourceEffect
      ? this.startupSettlementForEffect(plan.id, attempt, sourceEffect, effects)
      : undefined
    if (
      sourceEffect?.state !== "failed" ||
      !settlement ||
      settlement.planID !== plan.id ||
      settlement.taskID !== attempt.task_id ||
      settlement.attemptID !== attempt.id ||
      settlement.sessionID !== attempt.session_id ||
      settlement.workspace !== attempt.workspace ||
      settlement.base !== attempt.base_commit ||
      settlement.requestID !== authorization.settlementRequestID ||
      !this.preparationAllowed(attempt)
    )
      return false

    const recoveryEffect = effects.find((effect) => {
      if (effect.kind !== "worktree-recovery") return false
      try {
        return (
          (JSON.parse(effect.payload) as { recoveryID?: unknown }).recoveryID ===
          authorization.recoveryID
        )
      } catch {
        return false
      }
    })
    if (recoveryEffect) return false

    const workerEffects = this.store
      .effects(plan.id)
      .some(
        (effect) =>
          effect.attempt_id === attempt.id &&
          (effect.kind === "session" || effect.kind === "prompt"),
      )
    if (workerEffects || this.hasMeaningfulWorkerProgress(attempt.id)) return false

    const candidates = startupWorktreeCandidates(attempt.workspace)
    try {
      const worker = await this.host.session(attempt.session_id)
      if (!this.startupRecoveryAuthorityCurrent(plan, attempt, authorization) || worker)
        return false
      const nativeWorktrees = await this.host.worktrees()
      if (!this.startupRecoveryAuthorityCurrent(plan, attempt, authorization)) return false
      if (nativeWorktrees.some((path) => isStartupWorktreeCandidate(attempt.workspace, path)))
        return false
      const gitWorktrees = (await worktreeListPorcelain(this.directory))
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
      if (gitWorktrees.some((path) => isStartupWorktreeCandidate(attempt.workspace, path)))
        return false
      for (const candidate of candidates) {
        try {
          lstatSync(candidate)
          return false
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") return false
        }
      }
      if (!this.startupRecoveryAuthorityCurrent(plan, attempt, authorization)) return false
    } catch {
      return false
    }

    const operation = this.effect(
      plan.id,
      attempt.task_id,
      attempt.id,
      "worktree-recovery",
      {
        schema: "lazers-worktree-recovery-operation/v1",
        recoveryID: authorization.recoveryID,
        sourceEffectID: authorization.sourceEffectID,
        settlementRequestID: authorization.settlementRequestID,
        authorizationRequestID: authorization.requestID,
        authorizedOwner: authorization.owner,
        authorizedVersion: authorization.planVersion,
        sessionID: attempt.session_id,
        messageID: attempt.message_id,
        workspace: attempt.workspace,
        base: attempt.base_commit,
        policy: attempt.policy,
      },
      fence,
    )
    if (!this.startupRecoveryAuthorityCurrent(plan, attempt, authorization)) return false
    try {
      const actual = await this.host.worktree({
        directory: attempt.workspace,
        base: attempt.base_commit,
      })
      if (
        actual !== attempt.workspace ||
        (await gitAsync(actual, ["rev-parse", "HEAD"])) !== attempt.base_commit
      )
        throw new Error("Recovered native worktree did not match the reserved workspace and source")
      return this.completeStartupRecovery(plan, attempt, operation, authorization, actual, fence)
    } catch (error) {
      this.uncertain(operation, error, fence)
      return false
    }
  }

  /**
   * `resume` without a task re-runs the combined check on the current
   * candidate. It needs a live Architect and a blocked, unaccepted plan; no
   * earlier receipt, fingerprint or deadline has to match.
   */
  private assertCombinedVerificationResume(
    plan: PlanRow,
    command: PlanCommand,
    ownerSession: HostSession | null | undefined,
  ) {
    if (
      !command.reason?.trim() ||
      command.attemptID !== undefined ||
      command.workspaceMode !== undefined ||
      command.baseCommit !== undefined
    )
      throw new Error("Plan-level verification resume requires only a reason, not task controls")
    if (!this.validArchitect(ownerSession))
      throw new Error("Combined verification resume requires the current same-project Architect")
    if (plan.state !== "blocked" || plan.artifact !== null)
      throw new Error("Combined verification resume requires a blocked, unaccepted plan")
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

  /** Resume of a task: the worker continuation or retained-repair recovery its latest attempt allows. */
  private async prepareResumeContinuation(
    old: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
    taskID: string,
  ): Promise<
    Pick<
      CommandContext,
      "terminalContinuation" | "terminalRepairContinuation" | "retainedRepairRecovery"
    >
  > {
    const attempt = this.store
      .attempts(old.id)
      .filter((candidate) => candidate.task_id === taskID)
      .at(-1)
    const latestStop = attempt
      ? this.store.latestTransition<Record<string, unknown>>(
          old.id,
          attempt.task_id,
          "WORKER_STOPPED",
        )
      : undefined
    const terminalNativeFailure = attempt?.state === "failed" && latestStop?.outcome === "failed"
    const interruptedVerification = Boolean(
      attempt?.state === "verifying" && this.interruptedChecksFor(old, attempt).length > 0,
    )
    let continuation: Pick<CommandContext, "terminalContinuation" | "terminalRepairContinuation"> =
      {
        terminalContinuation: undefined,
        terminalRepairContinuation: undefined,
      }
    if (
      attempt &&
      !interruptedVerification &&
      (attempt.state === "running" || attempt.state === "verifying" || terminalNativeFailure)
    )
      continuation = await this.prepareTerminalContinuation(
        old,
        command,
        caller,
        ownerSession,
        attempt,
      )
    let retainedRepairRecovery: RetainedRepairRecoverySeed | undefined
    if (
      !continuation.terminalContinuation &&
      attempt?.state === "cancelled" &&
      this.store.nodes(old.id).find((candidate) => candidate.task_id === attempt.task_id)?.state ===
        "cancelled" &&
      old.state === "blocked" &&
      old.reason === RETAINED_REPAIR_FENCE_FAILURE_REASON &&
      this.store.latestRetainedRepair<{ attemptID?: unknown }>(old.id, attempt.task_id)
        ?.attemptID === attempt.id
    )
      retainedRepairRecovery = await this.prepareRetainedRepairRecovery(
        old,
        command,
        caller,
        ownerSession,
        attempt,
      )
    return { ...continuation, retainedRepairRecovery }
  }

  private async prepareTerminalContinuation(
    old: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
    attempt: AttemptRow,
  ): Promise<Pick<CommandContext, "terminalContinuation" | "terminalRepairContinuation">> {
    if (!command.attemptID || command.attemptID !== attempt.id)
      throw new Error("Terminal worker continuation requires the exact latest attemptID")
    const worker = await this.host.session(attempt.session_id, { messages: true })
    const problem = this.terminalWorkerContinuationProblem(
      old,
      command,
      caller,
      ownerSession,
      worker,
    )
    if (problem) throw new Error(problem)
    const terminalContinuation = {
      attemptID: attempt.id,
      messageID: attempt.message_id,
      inputID: worker!.turn!.inputID!,
      worker: worker!,
    }
    let terminalRepairContinuation: { operationID: string; owner: string } | undefined
    const latestRepair = this.store.latestRetainedRepair<{ attemptID?: unknown }>(
      old.id,
      attempt.task_id,
    )
    if (latestRepair?.attemptID === attempt.id) {
      const repair = this.retainedRepairForAttempt(attempt)
      if (!repair || repair.messageID !== attempt.message_id)
        throw new Error(
          "Retained repair continuation is missing its current owner/control authorization",
        )
      terminalRepairContinuation = { operationID: repair.operationID, owner: repair.owner }
    }
    return { terminalContinuation, terminalRepairContinuation }
  }

  private async prepareStartupSettlement(
    old: PlanRow,
    command: PlanCommand,
    ownerSession: HostSession | null | undefined,
  ) {
    if (
      !command.taskID ||
      !command.attemptID ||
      !command.reason ||
      !ownerSession ||
      !this.validArchitect(ownerSession)
    )
      throw new Error(
        "Startup settlement requires the current Architect owner and exact task attempt",
      )
    const candidate = this.startupSettlementCandidate(old, command.taskID, command.attemptID)
    const evidence = await this.observeStartupAbsence(
      old,
      candidate.attempt,
      candidate.effect,
      candidate.failure,
      command.requestID,
    )
    this.assertStartupSettlementCurrent(old, candidate.attempt, candidate.effect, candidate.failure)
    return { ...candidate, evidence }
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

  private commandAmendScope(db: Database, ctx: CommandContext, plan: PlanRow) {
    const { command, caller } = ctx
    if (
      !command.taskID ||
      (!command.scopeAdditions?.length && !command.scopeRemovals?.length) ||
      !command.reason
    )
      throw new Error("Scope amendment requires task, changed paths and reason")
    const node = this.store.nodes(plan.id).find((item) => item.task_id === command.taskID)
    if (!node || terminal.has(plan.state) || ["accepted", "incorporated"].includes(node.state))
      throw new Error("Scope amendment requires unfinished work in this plan")
    const previous = this.store.effectiveWriteScope(node.task_id)
    const original = this.store.repository.get(node.task_id)!.proposal.writeScope
    const requestedRemovals = new Set(command.scopeRemovals ?? [])
    if (original.some((path) => requestedRemovals.has(path)))
      throw new Error("Scope amendment cannot remove original task scope")
    if (command.scopeAdditions?.some((path) => requestedRemovals.has(path)))
      throw new Error("Scope amendment cannot add and remove the same pattern")
    const writeScope = [
      ...new Set([
        ...previous.filter((path) => !requestedRemovals.has(path)),
        ...(command.scopeAdditions ?? []),
      ]),
    ]
    if (writeScope.length > 100) throw new Error("Effective write scope exceeds 100 paths")
    const additions = writeScope.filter((path) => !previous.includes(path))
    const removals = previous.filter((path) => !writeScope.includes(path))
    if (!additions.length && !removals.length)
      return { status: "scope-unchanged", version: plan.version }
    const active = ["preparing", "running", "verifying"]
    const writers = this.store
      .attempts(plan.id)
      .filter((a) => a.task_id === node.task_id && active.includes(a.state))
    if (removals.length && writers.length)
      throw new Error("Scope removal requires stopped task writers")
    if (writers.length) {
      for (const other of this.store.activeProjectAttempts())
        if (
          other.task_id !== node.task_id &&
          active.includes(other.state) &&
          scopePatternsConflict(writeScope, this.store.effectiveReservationScope(other.task_id))
        )
          throw new Error(`Scope amendment conflicts with active task ${other.task_id}`)
    }
    this.store.record(plan.id, node.task_id, "SCOPE_AMENDED", {
      additions,
      ...(removals.length ? { removals } : {}),
      writeScope,
      reason: command.reason,
      caller,
      taskRevision: this.store.repository.get(node.task_id)!.revision,
    })
    const instructionUpdates: string[] = []
    for (const attempt of this.store
      .attempts(plan.id)
      .filter(
        (item) =>
          item.task_id === node.task_id &&
          (["running", "verifying"].includes(item.state) ||
            (item.state === "preparing" &&
              this.store
                .effects(plan.id)
                .some(
                  (effect) =>
                    effect.attempt_id === item.id &&
                    effect.kind === "prompt" &&
                    effect.state !== "failed",
                ))),
      )) {
      const payload: WorkerInstruction = {
        sessionID: attempt.session_id,
        attemptID: attempt.id,
        projectID: this.projectID,
        directory: attempt.workspace,
        key: `lazers-scope-${attempt.id}-${fingerprint(writeScope)}`,
        text: `Architect-authorized additive execution scope for task ${node.task_id}, revision 1, attempt ${attempt.id}. The immutable specification is unchanged.\nAdded paths: ${JSON.stringify(additions)}\nAuthorized cumulative write scope: ${JSON.stringify(writeScope)}\nReason: ${command.reason}\nContinue in this same assigned workspace; preserve legitimate dependency/test changes. All original acceptance and verification requirements still apply. This is authorization, not evidence of acceptance.`,
      }
      const kind = "scope-instruction"
      const id = fingerprint({
        planID: plan.id,
        taskID: node.task_id,
        attemptID: attempt.id,
        kind,
        payload,
      })
      // Command authorization and native-update intent commit atomically.
      // The fenced runtime owns delivery and recovery, including lost replies.
      db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'intended',?,NULL,0)").run(
        id,
        plan.id,
        node.task_id,
        attempt.id,
        kind,
        JSON.stringify(payload),
      )
      this.store.record(plan.id, node.task_id, "EFFECT_INTENDED", {
        effectID: id,
        kind,
        attemptID: attempt.id,
      })
      instructionUpdates.push(id)
    }
    db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(plan.id)
    const continued = this.continueAfterDivergenceDecision(db, plan, node.task_id, caller)
    return {
      status: "scope-amended",
      version: plan.version + 1 + (continued ? 1 : 0),
      writeScope,
      instructionUpdates,
      ...(continued ? { continued: true } : {}),
    }
  }

  /** The undecided divergence this plan is held on for the task, if any. */
  private divergenceHold(plan: PlanRow, taskID: string | undefined) {
    if (!taskID || plan.state !== "blocked") return undefined
    const wait = this.store.latestTransition<{ kind?: string; reason: string; attemptID: string }>(
      plan.id,
      taskID,
      "SCOPE_DECISION_REQUIRED",
    )
    return wait?.kind === "divergence" && wait.reason === plan.reason ? wait : undefined
  }

  /**
   * The Architect sends a held, verified divergence back (`retained-repair`): the attempt moves to
   * the task's one repair, whose prompt carries the out-of-scope paths and the Architect's reason.
   * With no repair left it is refused; amend-scope or cancel remain the exits.
   */
  private commandSendBackDivergence(db: Database, ctx: CommandContext, plan: PlanRow) {
    const { command, caller, ownerSession } = ctx
    const wait = this.divergenceHold(plan, command.taskID)
    if (!wait || !ownerSession || !this.validArchitect(ownerSession) || caller !== plan.owner)
      throw new Error("Sending back a divergence requires the current Architect owner")
    const attempt = this.store
      .attempts(plan.id)
      .filter((item) => item.task_id === command.taskID)
      .at(-1)
    if (
      !attempt ||
      attempt.id !== wait.attemptID ||
      attempt.id !== command.attemptID ||
      attempt.state !== "verifying" ||
      attempt.artifact !== command.artifact ||
      !command.reason?.trim()
    )
      throw new Error("Send-back must name the held attempt, its exact artifact and a reason")
    if (!this.repairAvailable(attempt))
      throw new Error(
        "The task's one repair is spent; accept the divergence with amend-scope or cancel",
      )
    const reason = `Scope divergence sent back by the Architect: ${command.reason}`
    db.query(
      "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'failed') WHERE id=?",
    ).run(attempt.id)
    // REPAIR must stay the task's newest transition: it marks the next attempt as the repair.
    this.store.record(plan.id, attempt.task_id, "SCOPE_SENT_BACK", {
      attemptID: attempt.id,
      reason: command.reason,
      caller,
    })
    this.store.move(plan.id, attempt.task_id, "REPAIR", reason)
    db.query(
      "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=?",
    ).run(plan.id)
    return { status: "scope-sent-back", attemptID: attempt.id, version: plan.version + 1 }
  }

  /**
   * An amendment that covers every path of an undecided divergence is the decision: the held,
   * already-verified candidate continues to acceptance without a separate reconcile. Anything else
   * outstanding (protected hold, uncovered paths, pending effects) still waits for reconcile.
   */
  private continueAfterDivergenceDecision(
    db: Database,
    plan: PlanRow,
    taskID: string,
    caller: string,
  ): boolean {
    const current = this.store.plan(plan.id)!
    const wait = this.store.latestTransition<{
      kind?: string
      reason: string
      divergences?: { path: string; status: "added" | "modified" | "deleted" }[]
    }>(plan.id, taskID, "SCOPE_DECISION_REQUIRED")
    if (
      current.state !== "blocked" ||
      wait?.kind !== "divergence" ||
      wait.reason !== current.reason ||
      !wait.divergences?.length
    )
      return false
    const model = this.store.effectiveScope(taskID)
    const open = classifyChanges(wait.divergences, model).some(
      (change) => change.class === "divergence" || change.class === "protected",
    )
    if (open) return false
    if (
      this.store
        .effects(plan.id)
        .some(
          (e) =>
            ["intended", "uncertain"].includes(e.state) &&
            !isRerunnableEffect(e.kind) &&
            e.kind !== "scope-instruction",
        )
    )
      return false
    db.query(
      "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=?",
    ).run(plan.id)
    this.store.record(plan.id, null, "RECONCILE_REQUESTED", {
      caller,
      verificationEpoch: this.store.plan(plan.id)!.version,
      cause: "scope-divergence-decision",
    })
    return true
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

  private commandReassign(db: Database, ctx: CommandContext, plan: PlanRow) {
    const { command, caller, ownerSession } = ctx
    if (!ownerSession || ownerSession.archived || ownerSession.projectID !== this.projectID)
      throw new Error("Reassignment needs an unarchived same-project owner")
    const retiredSource = db
      .query<{ present: number }, [string, string, string]>(
        `SELECT 1 AS present FROM runner_architect_renewals r
     JOIN runner_architect_renewal_plans rp ON rp.renewal_id=r.id
     WHERE r.previous_session_id=? AND rp.plan_id=? AND rp.transferred=1
       AND EXISTS(SELECT 1 FROM runner_plans current WHERE current.id=rp.plan_id AND current.owner<>?)
     LIMIT 1`,
      )
      .get(caller, plan.id, caller)
    if (caller !== plan.owner && retiredSource)
      throw new Error("A retired Architect predecessor cannot reassign a transferred plan")
    db.query("UPDATE runner_plans SET owner=?,version=version+1 WHERE id=?").run(
      ownerSession.id,
      plan.id,
    )
    this.store.record(plan.id, null, "OWNER_REASSIGNED", {
      from: plan.owner,
      to: ownerSession.id,
      reason: command.reason,
    })
    return { status: "reassigned", version: plan.version + 1 }
  }

  /** The Architect finished a task it took over: its attempt goes to the ordinary verification. */
  private commandTakeoverSubmit(ctx: CommandContext, plan: PlanRow) {
    const { command } = ctx
    if (!command.taskID || !command.reason)
      throw new Error("takeover-submit requires taskID and reason")
    const attempt = this.store
      .attempts(plan.id)
      .filter((item) => item.task_id === command.taskID)
      .at(-1)
    // A verifying attempt resubmits only when its verification is held: a new candidate then.
    const resubmitHeld = attempt?.state === "verifying" && plan.state === "blocked"
    // An accepted takeover result the plan is held on (combined verification) is the Architect's
    // own work: it corrects it in the same workspace and resubmits, as a worker's retained repair.
    const reopenAccepted =
      attempt?.state === "accepted" &&
      plan.state === "blocked" &&
      attempt !== undefined &&
      isTakeoverAttempt(attempt.policy)
    if (
      !attempt ||
      !isTakeoverAttempt(attempt.policy) ||
      (attempt.state !== "running" && !resubmitHeld && !reopenAccepted)
    )
      throw new Error(
        "takeover-submit needs the task's running takeover attempt; call lz-request-handoff first",
      )
    if (reopenAccepted) this.assertTakeoverReopenable(plan, attempt, ctx.obs)
    const submission =
      this.store
        .activity(plan.id, attempt.task_id)
        .filter(
          (event) =>
            event.event === "TAKEOVER_SUBMITTED" &&
            this.parseTransitionPayload<{ attemptID?: unknown }>(event)?.attemptID === attempt.id,
        ).length + 1
    const takeoverID = (JSON.parse(attempt.policy) as { takeover: { takeoverID: string } }).takeover
      .takeoverID
    if (reopenAccepted) {
      this.store.move(plan.id, attempt.task_id, "RETAINED_REPAIR", command.reason)
      this.store.move(plan.id, attempt.task_id, "DISPATCH")
    }
    if (!resubmitHeld) this.store.move(plan.id, attempt.task_id, "VERIFY", command.reason)
    this.store.atomic((db) => {
      // Each submission is a new candidate: its own input identity, so mechanical-fix and check
      // effects journaled for an earlier submission are never matched or reused (as a repair
      // attempt's new attempt or a retained repair's new input keys them apart).
      const state = resubmitHeld
        ? "state"
        : reopenAccepted
          ? "lz_runner_transition('attempt',lz_runner_transition('attempt',lz_runner_transition('attempt',state,'preparing'),'running'),'verifying')"
          : "lz_runner_transition('attempt',state,'verifying')"
      db.query(
        `UPDATE runner_attempts SET state=${state},message_id=?,artifact=NULL WHERE id=?`,
      ).run(`takeover-${takeoverID}-submission-${submission}`, attempt.id)
      if (reopenAccepted)
        db.query("UPDATE runner_nodes SET artifact=NULL WHERE plan_id=? AND task_id=?").run(
          plan.id,
          attempt.task_id,
        )
      // A resubmission after a failed verification lifts its hold.
      if (plan.state === "blocked")
        db.query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,artifact=NULL,version=version+1 WHERE id=?",
        ).run(plan.id)
    })
    this.store.record(plan.id, attempt.task_id, "TAKEOVER_SUBMITTED", {
      attemptID: attempt.id,
      reason: command.reason,
      submission,
    })
    this.tickRequested = true
    return { status: "takeover-submitted", attemptID: attempt.id, version: plan.version }
  }

  /** The retained-repair boundaries, for the Architect's own accepted takeover result. */
  private assertTakeoverReopenable(plan: PlanRow, attempt: AttemptRow, obs: GitObservations) {
    const node = this.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)
    if (
      !node ||
      node.state !== "accepted" ||
      !node.artifact ||
      plan.artifact !== null ||
      this.store.latestTransition(plan.id, attempt.task_id, "TASK_INTEGRATION_RECORDED") ||
      this.store.repository.taskDisposition(attempt.task_id) ||
      obs.isAncestor(this.directory, node.artifact, obs.git(this.directory, ["rev-parse", "HEAD"]))
    )
      throw new Error("Only an accepted, unintegrated takeover result held by its plan reopens")
    if (
      this.store.effects(plan.id).some((effect) => ["intended", "uncertain"].includes(effect.state))
    )
      throw new Error("Uncertain effects prevent reopening the takeover result")
    this.assertNoDispatchedDependents(plan, attempt.task_id, PlanInput.parse(JSON.parse(plan.body)))
    if (!existsSync(attempt.workspace)) throw new Error("The takeover's retained workspace is gone")
  }

  /**
   * A takeover attempt lives while the Architect session that took it over does. When that session
   * is gone or archived the work is not failed: the plan holds, advertising takeover-submit (any
   * live Architect continues in the workspace) and cancel, and the recovery bundle lists it.
   */
  private async holdAbandonedTakeover(plan: PlanRow, attempt: AttemptRow) {
    if (plan.state !== "running") return
    const takeover = (
      JSON.parse(attempt.policy) as { takeover: { architectSessionID: string; takeoverID: string } }
    ).takeover
    const architect = await this.host.session(takeover.architectSessionID)
    if (this.validArchitect(architect)) return
    this.store.recordOnce(plan.id, attempt.task_id, "TAKEOVER_ABANDONED", {
      takeoverID: takeover.takeoverID,
      attemptID: attempt.id,
      architectSessionID: takeover.architectSessionID,
      cause: architect ? "archived" : "absent",
    })
    this.hold(
      plan,
      `Takeover abandoned: Architect session ${takeover.architectSessionID} is ${architect ? "archived" : "gone"}; the work stays in ${attempt.workspace}`,
      ["takeover-submit", "cancel"],
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

  private commandCancel(db: Database, ctx: CommandContext, plan: PlanRow) {
    const { command, caller } = ctx
    this.store.cancelAdoptions(plan.id, "Cancellation requested")
    this.takeovers.cancelForPlan(plan.id, command.reason ?? "Cancellation requested")
    for (const operation of activeRetainedVerifications(db, this.directory, plan.id)) {
      saveRetainedVerification(db, {
        ...operation,
        state: "cancelled",
        failureReason: "Plan cancellation requested",
        updatedAt: this.now(),
      })
      db.query(
        `UPDATE runner_retained_verification_resources SET state=lz_runner_transition('resource',state,'uncertain'),updated_at=?
     WHERE operation_id=? AND state IN ('creating','active')`,
      ).run(this.now(), operation.id)
      this.retainedVerificationAborts.get(operation.id)?.abort()
      this.store.record(plan.id, operation.taskID, "RETAINED_VERIFICATION_CANCELLED", {
        operationID: operation.id,
        source: "plan-cancellation",
        previousState: operation.state,
        previousFailureReason: operation.failureReason,
        reason: "Plan cancellation requested",
        oldExecutionAndResourceHoldsPreserved: true,
      })
    }
    // Stop admission now. In-flight work remains running until interruption is proven.
    db.query(
      "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'cancelling'),reason=?,version=version+1 WHERE id=?",
    ).run(command.reason ?? "Cancellation requested", plan.id)
    for (const node of this.store.nodes(plan.id))
      if (!terminal.has(node.state) && node.state !== "running" && node.state !== "verifying")
        this.store.move(plan.id, node.task_id, "CANCEL")
    this.store.record(plan.id, null, "CANCEL_REQUESTED", { caller, reason: command.reason })
    return { status: "cancelling", version: this.store.plan(plan.id)!.version }
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
    ctx: CommandContext,
    plan: PlanRow,
    attempt: AttemptRow | undefined,
  ) {
    const { command, caller, ownerSession, terminalContinuation, terminalRepairContinuation } = ctx
    const retainedMode = attempt!.workspace === this.directory ? "shared" : "isolated"
    if (
      (command.workspaceMode !== undefined && command.workspaceMode !== retainedMode) ||
      (command.baseCommit !== undefined && command.baseCommit !== attempt!.base_commit)
    )
      throw new Error("Terminal continuation preserves its workspace and baseline")
    const problem = this.terminalWorkerContinuationProblem(
      plan,
      command,
      caller,
      ownerSession,
      terminalContinuation!.worker,
    )
    if (problem) throw new Error(problem)
    if (terminalContinuation!.worker.turn?.inputID !== terminalContinuation!.inputID)
      throw new Error("Native terminal observation changed before continuation admission")
    const latestRepair = this.store.latestRetainedRepair<{ attemptID?: unknown }>(
      plan.id,
      attempt!.task_id,
    )
    const currentRepair = this.retainedRepairForAttempt(attempt!)
    if (
      (latestRepair?.attemptID === attempt!.id &&
        (!terminalRepairContinuation ||
          !currentRepair ||
          currentRepair.operationID !== terminalRepairContinuation.operationID)) ||
      (terminalRepairContinuation && latestRepair?.attemptID !== attempt!.id)
    )
      throw new Error("Retained repair continuation authority changed before reservation")
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

  private commandRun(db: Database, ctx: CommandContext, plan: PlanRow) {
    const { configuredWorker, ownerSession, obs } = ctx
    if (plan.state !== "draft" && plan.state !== "blocked")
      throw new Error("Execution already requested or ended")
    if (this.store.attempts(plan.id).length)
      throw new Error("Existing execution must be reconciled; admission cannot replace its policy")
    if (!ownerSession || ownerSession.projectID !== this.projectID)
      throw new Error("An Architect session of this project must command the plan")
    const proposal = PlanInput.parse(JSON.parse(plan.body))
    const selectedModel = proposal.workerModel ?? configuredWorker
    const configuredRoute = proposal.workerModel ? null : (configuredWorker ?? null)
    const nodeRouteDecisions = proposal.nodes.map((node) =>
      node.persona && proposal.workerAgent !== "auditor"
        ? this.resolveTaskDispatchRoute(proposal, node.taskID, node.persona, configuredRoute)
        : null,
    )
    const everyNodeHasRoute = proposal.nodes.every((node, index) =>
      node.persona && proposal.workerAgent !== "auditor"
        ? nodeRouteDecisions[index]?.status === "resolved"
        : selectedModel !== undefined,
    )
    if (!everyNodeHasRoute)
      return this.hold(plan, "Select an implementor model in native OpenCode agent configuration")
    const model = selectedModel ? ModelPolicy.parse(selectedModel) : null
    try {
      if (
        obs.git(this.directory, ["rev-parse", `${proposal.baseCommit}^{commit}`]) !==
        proposal.baseCommit
      )
        throw new Error("Base mismatch")
    } catch (error) {
      if (error instanceof ObservationRequired) throw error
      return this.hold(plan, `Unavailable committed source baseline: ${errorText(error)}`)
    }
    const audit = this.store.exactContentConflicts(proposal.nodes.map((n) => n.taskID))
    const conflicts = audit.findings
    if (conflicts.length)
      return this.hold(
        plan,
        `Unresolved overlap findings: ${conflicts.map((f) => f.id).join(", ")}`,
      )
    db.query(
      "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),model=?,reason=NULL,version=version+1 WHERE id=?",
    ).run(model ? JSON.stringify(model) : null, plan.id)
    this.store.record(plan.id, null, "ADMITTED", {
      model,
      modelSource: proposal.workerModel
        ? "explicit-plan-selection"
        : configuredWorker
          ? "native-agent-selection"
          : "persona-mapping-selection",
      auditWatermark: audit.watermark,
      source: proposal.baseCommit,
      enforcement: {
        budget: "unconfigured; historical proposed limits are not execution policy",
        tokens: "measured usage only",
        cost: "API-equivalent price unavailable until resolved; never treated as zero",
        tools: "measured usage only",
        repairs: "one bounded verification repair by default",
      },
    })
    return { status: "running", planID: plan.id, version: this.store.plan(plan.id)!.version }
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

  private async requestQueueReview(
    waits: { planID: string; prerequisitePlanIDs?: string[]; reservationTaskIDs?: string[] }[],
    fence: number,
  ) {
    const current = () =>
      waits.filter(
        ({ planID }) =>
          this.store.plan(planID)?.state === "running" &&
          !this.store.effectiveDispatchPause(planID),
      )
    const waiting = current()
    const anchor = waiting[0]
    if (!anchor) return
    const review = { waiting }
    const event = "QUEUE_REVIEW_REQUESTED"
    const prior = this.store.atomic((db) =>
      db
        .query<OutboxRow & { requestedAt: number }, [string, string]>(
          `SELECT o.*, o.rowid AS sequence, CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,
                COALESCE(json_extract(o.payload,'$.requestedAt'),
                  (SELECT max(t.created_at) FROM runner_transitions t
                   WHERE t.plan_id=o.plan_id AND t.event='QUEUE_REVIEW_REQUESTED'), 0) AS requestedAt
           FROM runner_outbox o
          WHERE o.plan_id=? AND json_extract(o.payload,'$.status')='queue-review'
            AND json_extract(o.payload,'$.waiting')=?
          ORDER BY o.rowid DESC LIMIT 1`,
        )
        .get(anchor.planID, JSON.stringify(waiting)),
    )
    if (prior && this.now() - prior.requestedAt < PROJECT_RECONCILIATION_INTERVAL_MS) return
    if (prior?.state === "pending") return
    const checking = () =>
      verificationActivitiesForDatabase(this.store.repository.path).some(
        (activity) =>
          activity.metadata.projectDirectory === this.directory && activity.state === "running",
      )
    if (checking()) return
    const active = this.store.activeProjectAttempts()
    for (const attempt of active) {
      const session = await this.host.session(attempt.session_id)
      if (
        session?.busy ||
        session?.pendingInput ||
        session?.observationUnstable ||
        (session && this.backgroundBlockReason(session))
      )
        return
    }
    const owner = this.store.plan(anchor.planID)?.owner
    if (!owner) return
    const architect = await this.host.session(owner)
    if (
      architect?.busy ||
      architect?.pendingInput ||
      architect?.observationUnstable ||
      (architect?.pendingPermissions ?? 0) > 0 ||
      (architect?.pendingForms ?? 0) > 0
    )
      return

    if (prior?.state === "delivered") {
      // A delivered review still waiting in the Architect's inbox is not asked again.
      if (prior.session_id !== owner || !this.validArchitect(architect)) return
      const observation = await this.outcomeDelivery.outcomeObservation(
        prior,
        owner,
        this.outcomeDelivery.ownership(prior),
      )
      if (observation === "queued") return
    }
    this.store.fenced(this.owner, fence, () => {
      if (
        checking() ||
        this.store.plan(anchor.planID)?.owner !== owner ||
        JSON.stringify(current()) !== JSON.stringify(waiting) ||
        this.store
          .activeProjectAttempts()
          .some(
            (attempt) =>
              !active.some(
                (observed) =>
                  observed.id === attempt.id &&
                  observed.message_id === attempt.message_id &&
                  observed.state === attempt.state,
              ),
          )
      )
        return
      const requestedAt = this.now()
      this.store.record(anchor.planID, null, event, { ...review, requestedAt })
      this.outcome(anchor.planID, { status: "queue-review", ...review, requestedAt }, true)
    })
  }

  /**
   * Plans held at dispatch because the project had no Fallow config resume on their own once one
   * exists (the same running transition the Architect's `run` makes), so a queued task never
   * dead-ends on a rule that arrived after it.
   */
  private async releaseFallowConfigHolds(fence: number) {
    const held = this.store.atomic((db) =>
      db
        .query<{ id: string }, [string]>(
          "SELECT id FROM runner_plans WHERE project_directory=? AND state='blocked' AND reason LIKE 'FALLOW_CONFIG_REQUIRED%'",
        )
        .all(this.directory),
    )
    if (held.length === 0 || (await this.fallowGate())) return
    for (const { id } of held)
      this.store.fenced(this.owner, fence, (db) => {
        const changed = db
          .query(
            "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason LIKE 'FALLOW_CONFIG_REQUIRED%'",
          )
          .run(id).changes
        if (changed === 1)
          this.store.record(id, null, "RECONCILE_REQUESTED", {
            caller: "fallow-config",
            verificationEpoch: this.store.plan(id)!.version,
          })
      })
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

  private retainedRepairForAttempt(attempt: AttemptRow): RetainedRepairRecord | undefined {
    const repair = this.store.latestRetainedRepair<{
      operationID?: unknown
      attemptID?: unknown
      previousMessageID?: unknown
      nativeInputID?: unknown
      nativeAssignmentID?: unknown
      messageID?: unknown
      owner?: unknown
      sessionID?: unknown
      workspace?: unknown
      route?: unknown
      defect?: unknown
      workerObservation?: unknown
    }>(attempt.plan_id, attempt.task_id)
    if (
      !repair ||
      typeof repair.operationID !== "string" ||
      !repair.operationID ||
      typeof repair.attemptID !== "string" ||
      typeof repair.previousMessageID !== "string" ||
      !repair.previousMessageID ||
      typeof repair.messageID !== "string" ||
      !repair.messageID ||
      typeof repair.owner !== "string" ||
      !repair.owner.trim() ||
      typeof repair.sessionID !== "string" ||
      typeof repair.workspace !== "string" ||
      typeof repair.defect !== "string" ||
      repair.attemptID !== attempt.id ||
      repair.sessionID !== attempt.session_id ||
      repair.workspace !== attempt.workspace ||
      repair.route === undefined
    )
      return undefined
    const plan = this.store.plan(attempt.plan_id)
    if (!plan || plan.owner !== repair.owner) return undefined
    const repairRoute = ModelPolicy.safeParse(repair.route)
    const attemptRoute = this.retainedAttemptModel(plan, attempt)
    if (!repairRoute.success || !attemptRoute || !sameModelSnapshot(repairRoute.data, attemptRoute))
      return undefined
    const admissionInputID =
      typeof repair.nativeInputID === "string" ? repair.nativeInputID : repair.previousMessageID
    const admissionAssignmentID =
      typeof repair.nativeAssignmentID === "string"
        ? repair.nativeAssignmentID
        : repair.previousMessageID
    if (typeof repair.nativeInputID === "string") {
      if (typeof repair.workerObservation !== "string") return undefined
      let captured: unknown
      try {
        captured = JSON.parse(repair.workerObservation) as unknown
      } catch {
        return undefined
      }
      if (!isRecord(captured)) return undefined
      const turn = isRecord(captured.turn) ? captured.turn : undefined
      if (
        captured.id !== attempt.session_id ||
        captured.projectID !== this.projectID ||
        captured.directory !== attempt.workspace ||
        captured.attemptID !== attempt.id ||
        captured.busy !== false ||
        captured.pendingInput !== false ||
        captured.observationUnstable !== false ||
        captured.pendingPermissions !== 0 ||
        captured.pendingForms !== 0 ||
        captured.archived !== false ||
        captured.outcome !== "succeeded" ||
        turn?.inputID !== admissionInputID ||
        turn?.state !== "completed" ||
        Number(captured.runningShells ?? 0) !== 0 ||
        Number(captured.activeChildren ?? 0) !== 0
      )
        return undefined
    }
    const history = this.transitionHistory(attempt.plan_id)
    const repairTransition = history
      .filter(
        (entry) => entry.task_id === attempt.task_id && entry.event === "RETAINED_REPAIR_REQUESTED",
      )
      .at(-1)
    const transitions: RetainedRepairContinuationTransition[] = history
      .filter((entry) => entry.task_id === attempt.task_id && entry.event === "ATTEMPT_RESUMED")
      .flatMap((entry) => {
        const receipt = this.parseTransitionPayload<RetainedRepairContinuationTransition>(entry)
        if (!receipt) return []
        const recovery = isRecord(receipt.retainedRepairRecovery)
          ? receipt.retainedRepairRecovery
          : undefined
        if (recovery) {
          const failedResumeID = recovery.failedResumeTransitionID
          const blockedID = recovery.blockedTransitionID
          const cancelledID = recovery.cancelledTransitionID
          const failedResumeTransition = history.find(
            (candidate) => candidate.id === failedResumeID,
          )
          const blockedTransition = history.find((candidate) => candidate.id === blockedID)
          const cancelledTransition = history.find((candidate) => candidate.id === cancelledID)
          const failedResume =
            this.parseTransitionPayload<Record<string, unknown>>(failedResumeTransition)
          const blocked = this.parseTransitionPayload<{
            reason?: unknown
            workerObservation?: unknown
          }>(blockedTransition)
          const cancelled = this.parseTransitionPayload<{
            from?: unknown
            to?: unknown
            reason?: unknown
          }>(cancelledTransition)
          if (
            recovery.schema !== "lazers-retained-repair-recovery/v1" ||
            recovery.operationID !== repair.operationID ||
            recovery.interruptedInputID !== repair.messageID ||
            !repairTransition ||
            !Number.isSafeInteger(failedResumeID) ||
            !Number.isSafeInteger(blockedID) ||
            !Number.isSafeInteger(cancelledID) ||
            failedResumeTransition?.event !== "ATTEMPT_RESUMED" ||
            failedResumeTransition.task_id !== attempt.task_id ||
            blockedTransition?.event !== "BLOCKED" ||
            blockedTransition.task_id !== null ||
            cancelledTransition?.event !== "CANCEL" ||
            cancelledTransition.task_id !== attempt.task_id ||
            failedResumeTransition.id <= repairTransition.id ||
            blockedTransition.id <= failedResumeTransition.id ||
            cancelledTransition.id <= blockedTransition.id ||
            failedResume?.attemptID !== attempt.id ||
            failedResume.previousMessageID !== repair.messageID ||
            failedResume.messageID !== recovery.failedMessageID ||
            failedResume.terminalInputID !== repair.messageID ||
            failedResume.interruptedInputID !== repair.messageID ||
            failedResume.terminalOutcome !== "interrupted" ||
            failedResume.retainedRepairContinuation !== undefined ||
            failedResume.retainedRepairRecovery !== undefined ||
            blocked?.reason !== RETAINED_REPAIR_FENCE_FAILURE_REASON ||
            blocked.workerObservation !== undefined ||
            cancelled?.from !== "running" ||
            cancelled.to !== "cancelled" ||
            cancelled.reason !== null ||
            history.some(
              (candidate) =>
                candidate.task_id === null &&
                candidate.event === "CANCEL_REQUESTED" &&
                repairTransition &&
                candidate.id > repairTransition.id &&
                candidate.id < cancelledTransition.id,
            )
          )
            return []
        }
        return [receipt]
      })
    const lineage = resolveRetainedRepairInputLineage({
      operationID: repair.operationID,
      attemptID: attempt.id,
      originalMessageID: repair.messageID,
      assignedMessageID: attempt.message_id,
      owner: repair.owner,
      allowLegacyReceipt: true,
      transitions,
    })
    if (lineage.status === "invalid") return undefined
    const currentContinuation =
      lineage.status === "continued"
        ? transitions.findLast((candidate) => candidate.messageID === attempt.message_id)
        : undefined
    const nativeAssignmentID =
      lineage.status === "continued"
        ? currentContinuation?.previousMessageID
        : admissionAssignmentID
    if (typeof nativeAssignmentID !== "string" || !nativeAssignmentID) return undefined
    return {
      operationID: repair.operationID,
      attemptID: repair.attemptID,
      previousMessageID: repair.previousMessageID,
      repairMessageID: repair.messageID,
      messageID: attempt.message_id,
      nativeInputID: lineage.status === "continued" ? lineage.nativeInputID : admissionInputID,
      nativeAssignmentID,
      admissionInputID,
      admissionAssignmentID,
      continued: lineage.status === "continued",
      ...(lineage.status === "continued" ? { terminalOutcome: lineage.terminalOutcome } : {}),
      owner: repair.owner,
      sessionID: repair.sessionID,
      workspace: repair.workspace,
      route: repair.route,
      defect: repair.defect,
    }
  }

  private retainedRepairGeneration(planID: string, taskID?: string) {
    const repairForTask = (candidateTaskID: string) => {
      const repair = this.store.latestRetainedRepair<{
        operationID?: unknown
      }>(planID, candidateTaskID)
      // Once a repair supersedes acceptance evidence, keep that invalidation
      // across later attempts; only a newer repair creates a new generation.
      return typeof repair?.operationID === "string" ? repair.operationID : undefined
    }
    if (taskID !== undefined) return repairForTask(taskID)

    const plan = this.store.plan(planID)
    if (!plan) return undefined
    const input = PlanInput.parse(JSON.parse(plan.body))
    const nodes = this.store.nodes(planID)
    const generations = input.integrationOrder.flatMap((candidateTaskID) => {
      const node = nodes.find((candidate) => candidate.task_id === candidateTaskID)
      if (!node || !["accepted", "incorporated"].includes(node.state)) return []
      const attempt = this.store
        .attempts(planID)
        .filter((candidate) => candidate.task_id === candidateTaskID)
        .at(-1)
      if (!attempt || attempt.state !== "accepted" || attempt.artifact !== node.artifact) return []
      const operationID = repairForTask(candidateTaskID)
      return operationID ? [[candidateTaskID, operationID]] : []
    })
    return generations.length ? fingerprint({ planID, generations }) : undefined
  }

  private async retainedRepairPromptCurrent(
    plan: PlanRow,
    attempt: AttemptRow,
    repair: RetainedRepairRecord,
  ) {
    const current = () => {
      const latestPlan = this.store.plan(plan.id)
      const latestAttempt = this.store.attempts(plan.id).find((item) => item.id === attempt.id)
      const latestNode = this.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)
      const latestRepair = this.retainedRepairForAttempt(attempt)
      return Boolean(
        latestPlan?.state === "running" &&
        latestAttempt?.state === "preparing" &&
        latestAttempt.message_id === attempt.message_id &&
        latestAttempt.session_id === attempt.session_id &&
        latestAttempt.workspace === attempt.workspace &&
        latestNode?.state === (repair.continued ? "running" : "ready") &&
        latestRepair?.operationID === repair.operationID &&
        latestRepair?.messageID === repair.messageID &&
        latestRepair?.nativeInputID === repair.nativeInputID &&
        latestRepair?.continued === repair.continued,
      )
    }
    if (!this.host.waitForSession || !current()) return false
    const model = ModelPolicy.safeParse(repair.route)
    if (!model.success) return false
    await this.host.waitForSession(attempt.session_id)
    const observed = await this.host.session(attempt.session_id, { messages: true })
    const expectedInputID = repair.nativeInputID
    const expectedOutcome = repair.continued ? repair.terminalOutcome! : "succeeded"
    const backgroundProblem = this.retainedRepairBackgroundProblem(observed, expectedInputID)
    if (
      backgroundProblem ||
      this.retainedRepairWorkerProblem(
        plan,
        attempt,
        observed,
        expectedInputID,
        model.data,
        expectedOutcome,
      ) ||
      observed?.messages.some((message) => message.id === attempt.message_id) ||
      !current()
    )
      return false
    const owner = await this.host.session(repair.owner)
    if (!this.validArchitect(owner) || owner.id !== repair.owner || !current()) return false
    const confirmed = await this.host.session(attempt.session_id, { messages: true })
    const confirmedBackgroundProblem = this.retainedRepairBackgroundProblem(
      confirmed,
      expectedInputID,
    )
    return Boolean(
      !this.retainedRepairWorkerProblem(
        plan,
        attempt,
        confirmed,
        expectedInputID,
        model.data,
        expectedOutcome,
      ) &&
      !confirmedBackgroundProblem &&
      !confirmed?.messages.some((message) => message.id === attempt.message_id) &&
      observed &&
      confirmed &&
      this.retainedRepairObservation(observed) === this.retainedRepairObservation(confirmed) &&
      current() &&
      this.preparationAllowed(attempt),
    )
  }

  /**
   * A resume reserves a fresh input, but the interruption it answers may have been a stale
   * observation: the worker is still inside its previous turn. Prompting it again would queue a
   * second input behind a live turn and the retained-repair fence rightly refuses a busy worker,
   * leaving the attempt in `preparing` while the worker works. When the session is busy on exactly
   * the input the attempt had before the resume, the attempt takes that input back and runs.
   */
  private async adoptRunningWorker(plan: PlanRow, attempt: AttemptRow, fence: number) {
    const resumed = this.store
      .activity(plan.id, attempt.task_id)
      .filter((event) => event.event === "ATTEMPT_RESUMED")
      .map((event) =>
        this.parseTransitionPayload<{
          attemptID?: unknown
          messageID?: unknown
          previousMessageID?: unknown
        }>(event),
      )
      .filter((payload) => payload?.attemptID === attempt.id)
      .at(-1)
    const previousMessageID = resumed?.previousMessageID
    if (resumed?.messageID !== attempt.message_id || typeof previousMessageID !== "string")
      return false
    const observed = await this.host.session(attempt.session_id, { messages: true })
    if (
      !observed ||
      observed.archived ||
      !observed.busy ||
      observed.directory !== attempt.workspace ||
      observed.turn?.state !== "pending" ||
      observed.turn.inputID !== previousMessageID ||
      observed.messages.some((message) => message.id === attempt.message_id)
    )
      return false
    const adopted = this.store.fenced(this.owner, fence, (db) => {
      if (this.store.plan(plan.id)?.state !== "running") return false
      const changed =
        db
          .query(
            "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'running'),message_id=? WHERE id=? AND state='preparing' AND message_id=?",
          )
          .run(previousMessageID, attempt.id, attempt.message_id).changes === 1
      if (changed)
        this.store.record(plan.id, attempt.task_id, "WORKER_RESUME_ADOPTED", {
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          inputID: previousMessageID,
          reservedMessageID: attempt.message_id,
        })
      return changed
    })
    return adopted
  }

  private async prepareWorker(plan: PlanRow, attempt: AttemptRow, fence: number) {
    const admissionPlan = this.store.plan(plan.id)
    if (!admissionPlan || admissionPlan.state !== "running") return
    if (!(await this.startupWorkspaceReady(admissionPlan, attempt, fence))) return
    if (!(await this.promptAdmissionAllowed(plan.id, attempt))) return
    const retainedRepair = this.retainedRepairForAttempt(attempt)
    const latestRepair = this.store.latestRetainedRepair<{ attemptID?: unknown }>(
      plan.id,
      attempt.task_id,
    )
    if (latestRepair?.attemptID === attempt.id && !retainedRepair) {
      this.hold(plan, "Retained repair is missing a valid owner/control authorization fence")
      return
    }
    if (retainedRepair && (await this.adoptRunningWorker(plan, attempt, fence))) return
    const existing = this.store.effects(plan.id)
    if (
      retainedRepair &&
      !existing.some(
        (effect) =>
          effect.attempt_id === attempt.id &&
          effect.kind === "session" &&
          effect.state === "completed",
      )
    ) {
      this.hold(plan, "Retained repair lost its original native session receipt")
      return
    }
    if (
      !retainedRepair &&
      !existing.some((e) => e.attempt_id === attempt.id && e.kind === "session")
    ) {
      if (!(await this.promptAdmissionAllowed(plan.id, attempt))) return
      const effect = this.effect(
        plan.id,
        attempt.task_id,
        attempt.id,
        "session",
        { sessionID: attempt.session_id },
        fence,
      )
      try {
        await this.host.create({
          id: attempt.session_id,
          parentID: plan.owner,
          agent: workerAgent(JSON.parse(attempt.policy).agent),
          model: ModelPolicy.parse(JSON.parse(attempt.policy).model),
          directory: attempt.workspace,
          title: this.sessionTitle(
            this.store.repository.get(attempt.task_id)!.proposal.objective.slice(0, 100),
          ),
          attemptID: attempt.id,
        })
        this.receipt(effect, { sessionID: attempt.session_id }, fence)
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    if (!(await this.promptAdmissionAllowed(plan.id, attempt))) return
    this.startAuditorReport(attempt, "baseline")
    const repairPrompt = retainedRepair
      ? existing.find(
          (effect) =>
            effect.attempt_id === attempt.id &&
            effect.kind === "prompt" &&
            (() => {
              try {
                return (
                  (JSON.parse(effect.payload) as { repairID?: unknown }).repairID ===
                    retainedRepair.operationID &&
                  (JSON.parse(effect.payload) as { messageID?: unknown }).messageID ===
                    attempt.message_id
                )
              } catch {
                return false
              }
            })(),
        )
      : undefined
    const conflictingPrompt = retainedRepair
      ? existing.find(
          (effect) =>
            effect.attempt_id === attempt.id &&
            effect.kind === "prompt" &&
            (() => {
              try {
                return (
                  (JSON.parse(effect.payload) as { messageID?: unknown }).messageID ===
                  attempt.message_id
                )
              } catch {
                return false
              }
            })(),
        )
      : undefined
    if (retainedRepair && conflictingPrompt && !repairPrompt) {
      this.hold(plan, "Retained repair prompt receipt is not bound to its operation")
      return
    }
    if (retainedRepair && repairPrompt?.state === "failed") {
      this.hold(
        plan,
        "Retained repair prompt was conclusively rejected; explicit review is required",
      )
      return
    }
    if (retainedRepair && repairPrompt && repairPrompt.state !== "completed") {
      this.hold(plan, "Retained repair prompt effect is unresolved; automatic replay is unsafe")
      return
    }
    if (
      !repairPrompt &&
      !existing.some(
        (e) =>
          e.attempt_id === attempt.id &&
          e.kind === "prompt" &&
          JSON.parse(e.payload).messageID === attempt.message_id,
      )
    ) {
      if (!(await this.promptAdmissionAllowed(plan.id, attempt))) return
      if (
        retainedRepair &&
        !(await this.retainedRepairPromptCurrent(plan, attempt, retainedRepair))
      ) {
        this.hold(plan, "Retained worker ownership or input changed before repair prompt admission")
        return
      }
      const effect = this.effect(
        plan.id,
        attempt.task_id,
        attempt.id,
        "prompt",
        {
          sessionID: attempt.session_id,
          messageID: attempt.message_id,
          workspace: attempt.workspace,
          ...(retainedRepair
            ? {
                repairID: retainedRepair.operationID,
                previousMessageID: retainedRepair.previousMessageID,
                nativeInputID: retainedRepair.nativeInputID,
                nativeAssignmentID: retainedRepair.nativeAssignmentID,
                admissionInputID: retainedRepair.admissionInputID,
                repairMessageID: retainedRepair.repairMessageID,
                ...(retainedRepair.continued
                  ? {
                      continuedFromInputID: retainedRepair.nativeInputID,
                      continuedFromOutcome: retainedRepair.terminalOutcome,
                    }
                  : {}),
                defect: retainedRepair.defect,
              }
            : {}),
        },
        fence,
      )
      try {
        const selectedPersona = WorkerPersona.safeParse(JSON.parse(attempt.policy).persona)
        const personaGuidance = selectedPersona.success
          ? `\n\nSelected ${workerPersonaLabels[selectedPersona.data]} persona (advisory, independent of model/provider):\n${workerPersonaOverlay(selectedPersona.data)}`
          : ""
        await this.host.prompt({
          sessionID: attempt.session_id,
          id: attempt.message_id,
          directory: attempt.workspace,
          attemptID: attempt.id,
          model: ModelPolicy.parse(JSON.parse(attempt.policy).model),
          ...(retainedRepair ? { moveIfNeeded: false } : {}),
          text: retainedRepair
            ? `${retainedRepair.continued ? `Continue the interrupted retained repair task ${attempt.task_id} from its exact prior native input ${retainedRepair.nativeInputID}.` : `Repair task ${attempt.task_id}`} Continue in the same retained workspace ${attempt.workspace}. Fetch the task and source bundle once with lz-get-task before editing. Follow your assigned worker role and task guidance. Preserve all valid prior work, usage, session, workspace and route; do not create or move a worker. Concrete defect to repair: ${retainedRepair.defect}. Commit the repair and report concise results.${personaGuidance}`
            : `Implement task ${attempt.task_id} in ${attempt.workspace}. Fetch the task and source bundle once with lz-get-task before editing. Follow your assigned worker role, use the task's code-grounded guidance, and finish with a commit and concise results. If continuing an earlier attempt, preserve its progress in this assigned workspace.${this.repairFailureBrief(attempt)}${personaGuidance}`,
        })
        this.receipt(
          effect,
          {
            messageID: attempt.message_id,
            taskID: attempt.task_id,
            instructions: "readable; lz-get-task",
            ...(retainedRepair
              ? {
                  repairID: retainedRepair.operationID,
                  repairMessageID: retainedRepair.repairMessageID,
                  ...(retainedRepair.continued
                    ? { continuedFromInputID: retainedRepair.nativeInputID }
                    : {}),
                }
              : {}),
          },
          fence,
        )
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    if (!(await this.promptAdmissionAllowed(plan.id, attempt))) return
    const started = this.store.fenced(this.owner, fence, (db) => {
      const currentPlan = this.store.plan(plan.id)
      const currentAttempt = this.store.attempts(plan.id).find((item) => item.id === attempt.id)
      const currentNode = this.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)
      if (
        currentPlan?.state !== "running" ||
        currentAttempt?.state !== "preparing" ||
        currentAttempt.message_id !== attempt.message_id ||
        (retainedRepair
          ? currentNode?.state !== (retainedRepair.continued ? "running" : "ready") ||
            this.retainedRepairForAttempt(currentAttempt)?.operationID !==
              retainedRepair.operationID
          : false)
      )
        return false
      if (retainedRepair && !retainedRepair.continued)
        this.store.move(plan.id, attempt.task_id, "DISPATCH")
      return (
        db
          .query(
            "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'running') WHERE id=? AND state='preparing' AND message_id=?",
          )
          .run(attempt.id, attempt.message_id).changes === 1
      )
    })
    if (!started) return
    this.workerEvent(plan, attempt, "WORKER_STARTED", fence)
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

  /** Unblocks the plan that startup recovery parked on this worktree effect, once it is ready. */
  private resumeStartupRecovery(
    effect: EffectRow,
    fence: number,
    workspace: string,
    startupRecoveryReason: string,
  ) {
    const plan = this.store.plan(effect.plan_id)
    const attempt = plan
      ? this.store.attempts(plan.id).find((item) => item.id === effect.attempt_id)
      : undefined
    const authorization =
      effect.kind === "worktree-recovery" && plan && attempt
        ? this.startupRecoveryAuthorization(plan, attempt)
        : undefined
    let recoveryBinding = true
    if (effect.kind === "worktree-recovery") {
      try {
        const operation = JSON.parse(effect.payload) as {
          recoveryID?: unknown
          sourceEffectID?: unknown
        }
        recoveryBinding = Boolean(
          authorization &&
          plan &&
          plan.version >= authorization.planVersion &&
          operation.recoveryID === authorization.recoveryID &&
          operation.sourceEffectID === authorization.sourceEffectID,
        )
      } catch {
        recoveryBinding = false
      }
    }
    if (!(
      plan?.state === "blocked" &&
      plan.reason === startupRecoveryReason &&
      attempt?.state === "preparing" &&
      recoveryBinding
    ))
      return
    this.store.fenced(this.owner, fence, (db) => {
      const changed =
        db
          .query(
            "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason=?",
          )
          .run(plan.id, startupRecoveryReason).changes === 1
      if (!changed) return
      if (effect.kind === "worktree-recovery" && authorization)
        this.store.record(plan.id, attempt!.task_id, "STARTUP_RECOVERY_OPERATION_RESUMED", {
          effectID: effect.id,
          sourceEffectID: authorization.sourceEffectID,
          recoveryID: authorization.recoveryID,
          attemptID: effect.attempt_id,
          workspace,
          planVersion: plan.version + 2,
        })
      else
        this.store.record(plan.id, null, "WORKTREE_RECOVERY_RESUMED", {
          effectID: effect.id,
          attemptID: effect.attempt_id,
          workspace,
        })
    })
  }
}

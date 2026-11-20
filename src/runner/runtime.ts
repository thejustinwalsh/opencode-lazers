import { sessionTitle } from "./session-title.ts"
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
  sameVerificationCheckIdentity,
  actualCheckResultFromEffect,
  checkSettlementProblem,
  errorText,
} from "./runtime-helpers.ts"
import { AdoptionExecution } from "./adoption-execution.ts"
import { WorktreeCleanup } from "./worktree-cleanup.ts"
import { OutcomeDelivery } from "./outcome-delivery.ts"
import { RecoveryBundles } from "./recovery-bundle.ts"
import { RecoveryDetector, isTakeoverAttempt } from "../recovery/detector.ts"
import { TakeoverExecution, takeoverAwareHost, type TakeoverResult } from "./takeover.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"
import { sameModelSnapshot, sameNativeModel } from "./model-route.ts"
import { agentRouteReader, architectSessionModel } from "../models/agent-route-apply.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { isWorkerAgent, workerAgent } from "./worker-agent.ts"
import { defaultAuditorReport, type AuditorReport } from "./auditor-report.ts"
import {
  evaluatePrerequisiteIntegration,
  evaluateTaskPrerequisiteIntegration,
  type IntegrationDecision,
  type PrerequisiteIntegrationRow,
  type TaskPrerequisiteIntegrationRow,
} from "./prerequisite-proof.ts"
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fingerprint } from "../identity.ts"
import { NoCapabilityProviderError } from "../core/capabilities.ts"
import {
  effectiveVerificationCheck,
  verificationDeadline as resolveVerificationDeadline,
  verificationCheckWithDefaults,
  verificationReceiptDeadline,
  verificationTimeoutDefaults,
} from "./verification-timeout.ts"
import type {
  VerificationDeadline,
  VerificationTimeoutTarget,
  VerificationTimeoutDefaults,
} from "./verification-timeout.ts"
import { LEGACY_FALLOW_CHECK_ID, type TaskProposal } from "../task.ts"
import {
  artifactExists,
  ArtifactScopeViolation,
  artifactUnchanged,
  commitIsAncestor,
  changedPaths,
  checkResourcesSettled,
  canonicalCombinedArtifact,
  combineArtifacts,
  commitArtifact,
  gitAsync,
  worktreeListPorcelain,
  reviewedScopeBase,
  runDeclaredCheck,
  runCheck,
  scopePatternsConflict,
  verificationEnvironmentIdentity,
  workingTreeIdentity,
  writeCheckReceipt,
} from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import {
  buildScopeReport,
  classifyChanges,
  divergenceReason,
  protectedPaths,
  scopeReportEmpty,
  scopeRepairText,
  type ScopeReport,
  type ScopeOwner,
} from "./scope.ts"
import { collectScopeChanges, sizeWarnings } from "./scope-git.ts"
import {
  FALLOW_CHECK_COMMAND,
  FALLOW_CHECK_ID,
  FALLOW_EFFECT_KIND,
  FALLOW_PLAN_EFFECT_KIND,
  defaultFallowPlanReview,
  defaultFallowReview,
  fallowCheckReceipt,
  fallowOutcome,
  isFallowEffectKind,
  fallowReasonText,
  unavailableFallowResult,
  type FallowReview,
} from "./fallow-check.ts"
import type { FallowReviewResult } from "../audit/review.ts"
import { fallowConfigGate, hasStoredFallowConfig } from "../audit/fallow-gate.ts"
import { FallowConfigRequiredError } from "../audit/fallow-refusal.ts"
import { needsRepair } from "../audit/audit-findings.ts"
import type { FallowDisposition } from "../audit/contract.ts"
import { dispositionsAfterRepair } from "../audit/fallow-dispositions.ts"
import { attributeFindingsToTasks, type PlanTaskDiff } from "../audit/task-attribution.ts"
import { ensureNotesConfig } from "./change-identity.ts"
import {
  architectCacheWindowMs,
  architectContextTokens,
  architectReuseMaxContextTokens,
  routeArchitect,
  type ArchitectRoute,
  type ArchitectRoutingOptions,
} from "./architect-routing.ts"
import { holdActions } from "./hold-actions.ts"
import { stampChangeIdentity } from "./identity-stamp.ts"
import { FINGERPRINT_V2_PREFIX, isFingerprintV2 } from "./identity-store.ts"
import {
  baseReachable,
  proofForArtifact,
  storedEvidence,
  type BaseReach,
  type IntegrationProof,
} from "./integration-proof.ts"
import { knownTree } from "./identity-store.ts"
import type { ArtifactEvidenceLookup } from "./prerequisite-proof.ts"
import { checkSucceeded, checkFailureReason } from "./checks.ts"
import { needsMechanicalQualityPreparation } from "./quality-failure.ts"
import type { HostSession, RunnerHost, WorkerInstruction } from "./host.ts"
import {
  ArchitectContinuityInput,
  CommandInput,
  ModelPolicy,
  PlanInput,
  WorkerPersona,
} from "./schema.ts"
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
  ArchitectRenewalRow,
  ProgressRow,
} from "./store.ts"
import { appendRunnerEffectReceipt, RENEWAL_SUCCESSOR_FOREIGN, RunnerStore } from "./store.ts"
import { outcomeText } from "./outcome.ts"
import type { OutcomeOwnership } from "./inbox.ts"
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
import {
  DispatchRouteDecisionSchema,
  resolveDispatchRoute,
  type DispatchRouteDecision,
} from "../models/dispatch-resolution.ts"
import { ModelMappingResolver } from "../models/mapping-resolver.ts"
import { ModelMappingStore } from "../models/mapping-store.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { SourceMessagesInspectPlanSchema } from "./inspection.ts"
import { PROJECT_RECONCILIATION_INTERVAL_MS, sharedScheduler } from "./scheduler-coordinator.ts"
import { canonicalProjectWorktreePath, samePhysicalWorkspace } from "./workspace-location.ts"
import { selectSchedulingCandidates } from "./scheduling-selection.ts"
import type { SchedulingReservation } from "./scheduling-selection.ts"
import {
  matchesReviewInputAlias,
  observeReviewInput,
  parseReviewInputAlias,
} from "./review-input.ts"
import type { ReviewInputBinding, ReviewInputEvidence } from "./review-input.ts"
import {
  isStartupWorktreeCandidate,
  nativeWorktreeFailureEvidence,
  nativeWorktreeFailureFromReceipt,
  startupFailureSettlementFromReceipt,
  startupWorktreeFailureEvidence,
  startupWorktreeCandidates,
  UNCERTAIN_EFFECT_RECEIPT_SCHEMA,
} from "./startup-recovery.ts"
import type { StartupAbsenceEvidence, StartupWorktreeFailureEvidence } from "./startup-recovery.ts"
import {
  activeRetainedVerifications,
  createRetainedVerification,
  markRetainedVerificationCheckUncertain,
  retainedVerification,
  retainedVerificationChecks,
  retainedVerificationsForPlan,
  saveRetainedVerification,
  settleRetainedVerificationResources,
} from "./retained-verification/store.ts"
import {
  abortVerificationActivities,
  canonicalVerificationDatabasePath,
  forgetVerificationActivity,
  startVerificationActivity,
  verificationActivity,
  verificationActivityKey,
  verificationActivitiesForDatabase,
} from "./verification-activities.ts"
import type { VerificationActivity } from "./verification-activities.ts"
import type { RetainedVerification } from "./retained-verification/schema.ts"
import {
  observeRetainedCheckIsolationWitness,
  retainedVerificationEnvironmentIdentity,
} from "./retained-verification/isolation.ts"
import type { RetainedDependencyInstaller } from "./retained-verification/isolation.ts"
import { retainedVerificationProbeBasis } from "./retained-verification/probe.ts"
import {
  retainedProcedurePlan,
  retainedProjectIdentity,
} from "./retained-verification/procedure.ts"
import { sameProject } from "../project-key.ts"

const sessionID = () => `ses_${crypto.randomUUID().replaceAll("-", "")}`
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

type StartupRecoveryAuthorization = {
  schema: "lazers-worktree-startup-authorization/v1"
  recoveryID: string
  sourceEffectID: string
  settlementRequestID: string
  requestID: string
  owner: string
  planVersion: number
  planRevision: number
  taskID: string
  attemptID: string
  sessionID: string
  messageID: string
  workspace: string
  base: string
  policy: string
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

type RetainedRepairRecord = {
  operationID: string
  attemptID: string
  previousMessageID: string
  repairMessageID: string
  messageID: string
  nativeInputID: string
  nativeAssignmentID: string
  admissionInputID: string
  admissionAssignmentID: string
  continued: boolean
  terminalOutcome?: "interrupted" | "succeeded" | "failed"
  owner: string
  sessionID: string
  workspace: string
  route: unknown
  defect: string
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

type WorkerObservationFence = {
  planID: string
  planVersion: number
  planState: string
  owner: string
  reconcileRequestID: number
  taskID: string
  attemptID: string
  attemptState: string
  sessionID: string
  workspace: string
  messageID: string
  policy: string
  nodeState: string
  nodeVersion: number
}

type RetainedVerificationSeed = RetainedVerification

const cleanupObservationStages = [
  "session-read",
  "session-id",
  "project-id",
  "directory",
  "agent",
  "attempt-id",
  "foreground",
  "pending-input",
  "observation-stability",
  "pending-permissions",
  "pending-forms",
  "running-shells",
  "active-children",
] as const
type CleanupObservationStage = (typeof cleanupObservationStages)[number]
type CleanupObservationCheck = {
  stage: CleanupObservationStage
  status: "passed" | "blocked" | "not-evaluated"
  code?: string
}
type CleanupSessionObservation =
  | { kind: "unavailable"; error: unknown }
  | { kind: "absent" }
  | { kind: "observed"; session: HostSession }
type CleanupWorkerClassification = {
  binding: {
    projectID: string
    planID: string
    attemptID: string
    sessionID: string
    workspace: string
    assignedMessageID: string
  }
  firstBlocker: { stage: CleanupObservationStage; code: string } | null
  stages: CleanupObservationCheck[]
}
type CleanupAuditDiagnostics = {
  diagnosticOnly: true
  planID: string
  planVersion: number
  sampledAt: number
  workspace: string
  workers: Array<
    CleanupWorkerClassification & {
      planVersion: number
      sampledAt: number
    }
  >
}

type PlanFallowContext = {
  workspace: string
  artifact: string
  baseCommit: string
  sourceGeneration: string | undefined
  verificationEpoch: number
}

/** The scope review in the `task-accepted` outcome, bounded so a large change stays readable. */
function boundedScopeReport(report: ScopeReport): ScopeReport {
  const limit = 30
  return {
    ...report,
    created: report.created.slice(0, limit),
    missingExpected: report.missingExpected.slice(0, limit),
    divergences: report.divergences.slice(0, limit),
    accepted: report.accepted.slice(0, limit),
    warnings: report.warnings.slice(0, limit),
  }
}

/** The `task-accepted` outcome's Fallow field: only when something remains to report. */
function fallowAcceptance(
  review: FallowReviewResult | undefined,
  dispositions?: FallowDisposition[],
) {
  const fallow = fallowOutcome(review, dispositions)
  return fallow ? { fallow } : {}
}

/** A plan reconcile longer than this leaves a PLAN_STEP_SLOW record naming where the time went. */
const SLOW_RECONCILE_MS = 30_000

/** Verification effects only read the candidate; a missing receipt means run the check again. */
function isRerunnableEffect(kind: string): boolean {
  return kind.startsWith("verify:") || kind.startsWith("graph-verify:") || kind === "mechanical-fix"
}

/** Only a plan submitted with `draft: true` stays a draft; older drafts predate that choice. */
function explicitDraft(plan: PlanRow): boolean {
  try {
    return (JSON.parse(plan.body) as { draft?: unknown }).draft === true
  } catch {
    return false
  }
}

/** A re-runnable effect that was replaced for lack of a receipt; it no longer holds anything. */
function effectSuperseded(effect: EffectRow): boolean {
  if (effect.state !== "failed" || !effect.receipt) return false
  try {
    return (JSON.parse(effect.receipt) as { superseded?: unknown }).superseded === true
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

const WORKTREE_EFFECT_KINDS = [
  "worktree",
  "worktree-recovery",
  "graph-worktree",
  "adoption-task-worktree",
  "adoption-combined-worktree",
]

/** The blocked-plan reason startup recovery wrote for an uncertain worktree effect, if any. */
function startupWorktreeRecoveryReason(
  effect: EffectRow,
  nativeFailure: ReturnType<typeof nativeWorktreeFailureFromReceipt>,
): string | undefined {
  if (
    !["worktree", "worktree-recovery"].includes(effect.kind) ||
    effect.state !== "uncertain" ||
    !effect.receipt ||
    nativeFailure
  )
    return undefined
  try {
    const receipt = JSON.parse(effect.receipt) as { error?: unknown }
    return typeof receipt.error === "string"
      ? `Recovery uncertain for ${effect.kind} ${effect.id}: ${receipt.error}`
      : undefined
  } catch {
    return undefined
  }
}

/** Native worktrees at the effect's base commit (clean ones only, for adoption worktrees). */
async function worktreeReconcileCandidates(
  effect: EffectRow,
  payload: { workspace: string; base: string },
  nativeWorktrees: readonly string[],
) {
  const possibleCandidates: string[] = []
  for (const directory of nativeWorktrees.filter((directory) =>
    effect.kind === "worktree-recovery"
      ? directory === payload.workspace
      : isStartupWorktreeCandidate(payload.workspace, directory),
  ))
    if (
      existsSync(directory) &&
      (await gitAsync(directory, ["rev-parse", "HEAD"])) === payload.base
    )
      possibleCandidates.push(directory)
  const candidates: string[] = []
  for (const directory of possibleCandidates) {
    if (
      effect.kind.startsWith("adoption-") &&
      (await gitAsync(directory, ["status", "--porcelain", "--untracked-files=all"]))
    )
      continue
    candidates.push(directory)
  }
  return candidates
}

/** The check receipt a runner subprocess left at the effect's receipt path, when there is one. */
function readCheckReceipt(payload: { receiptPath: string }): CheckReceipt | undefined {
  return existsSync(payload.receiptPath)
    ? (JSON.parse(readFileSync(payload.receiptPath, "utf8")) as CheckReceipt)
    : undefined
}

function unsettledCheckError(label: "Mechanical" | "Verification", check: CheckReceipt) {
  return new Error(
    `${label} command exited ${check.exitCode ?? "unknown"} with timedOut=${check.timedOut}, but subprocess cleanup is uncertain: ${check.processCleanup?.detail ?? "termination was not confirmed"}`,
  )
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

/** What the pass over one running attempt carries from step to step. */
type AdvanceContext = {
  plan: PlanRow
  attempt: AttemptRow
  fence: number
  observation: WorkerObservationFence
  session: HostSession
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
  private running = false
  private stopped = false
  private tickRequested = false
  private tickPromise: Promise<void> | undefined
  private readonly idleWaiters: (() => void)[] = []
  private readonly renewalLocks = new Map<string, Promise<void>>()
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
  private readonly scopeReports = new Map<string, ScopeReport>()
  private reconcileTiming: Map<string, number> | undefined
  private readonly slowRecorded = new Set<string>()
  private readonly fallowReviewRun: FallowReview
  private readonly fallowPlanReviewRun: FallowReview
  private readonly auditorReportRun: AuditorReport
  private readonly startedAuditorReports = new Set<string>()
  private readonly workerNoProgressWindowMs: number
  private readonly cancelIdleWaitMs: number
  private readonly workerProgress = new Map<string, { fingerprint: string; since: number }>()
  private readonly verificationTimeoutDefaults: VerificationTimeoutDefaults
  private readonly architectPromptHook: boolean
  private readonly requestTick: () => Promise<void>
  private readonly wakeScheduler: ((delayMs?: number) => void) | undefined
  private readonly retainedDependencyInstaller: RetainedDependencyInstaller | undefined
  private readonly beforeRetainedCheckBegin: TaskRuntimeOptions["beforeRetainedCheckBegin"]
  private readonly modelMappingResolver: ModelMappingResolver
  private readonly sourceEpochs = new Map<string, number>()
  private sourceResyncPending = false
  private readonly schedulingRead: TaskSchedulingRead
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
    this.schedulingRead = new TaskSchedulingRead(store, this.now)
    this.autoResumeInterrupted = options.autoResumeInterrupted ?? true
    this.fallowReviewEnabled = (options.fallowReview ?? "on") === "on"
    this.fallowReviewRun = options.fallowReviewRun ?? defaultFallowReview
    this.fallowPlanReviewRun = options.fallowPlanReviewRun ?? defaultFallowPlanReview
    this.auditorReportRun = options.auditorReportRun ?? defaultAuditorReport
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
    for (const id of store.architectSourceSessionIDs()) this.sourceEpochs.set(id, 0)
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

  private startCheckActivity(input: {
    id: string
    identity: unknown
    metadata: Record<string, unknown>
    signal?: AbortSignal
    run(signal: AbortSignal): Promise<CheckReceipt>
  }): { activity: VerificationActivity<CheckReceipt>; created: boolean } {
    return startVerificationActivity({
      databasePath: this.store.repository.path,
      key: verificationActivityKey(this.store.repository.path, input.id),
      identity: fingerprint(input.identity),
      owner: this.owner,
      metadata: input.metadata,
      ...(input.signal ? { signal: input.signal } : {}),
      run: input.run,
      onSettled: () => {
        void this.requestTick().catch(() => undefined)
      },
    })
  }

  private checkActivity(
    id: string,
    identity: unknown,
  ): VerificationActivity<CheckReceipt> | undefined {
    return verificationActivity(
      verificationActivityKey(this.store.repository.path, id),
      fingerprint(identity),
    )
  }

  private verificationDeadline(target: VerificationTimeoutTarget): VerificationDeadline {
    return resolveVerificationDeadline(
      this.store.verificationTimeoutAmendments(target.planID),
      target,
    )
  }

  private deadlineAwaitingTaskContinuation(
    plan: PlanRow,
    target: VerificationTimeoutTarget,
    deadline: VerificationDeadline,
  ): boolean {
    if (!deadline.amendmentID || !target.taskID) return false
    const amendment = this.store
      .verificationTimeoutAmendments(plan.id)
      .find((candidate) => candidate.amendmentID === deadline.amendmentID)
    if (!amendment) throw new Error("Current verification deadline amendment is missing")
    const resumedVersion = this.store.latestTransitionVersion(
      plan.id,
      target.taskID,
      "VERIFICATION_RESUMED",
    )
    return resumedVersion === undefined || resumedVersion < amendment.planVersion
  }

  private verificationTarget(
    plan: PlanRow,
    phase: "task" | "combined",
    check: TaskProposal["verification"][number],
    artifact: string,
    taskID: string | null,
    taskRevision: number | null,
    attemptID: string | null,
  ): VerificationTimeoutTarget {
    return {
      projectID: this.projectID,
      projectDirectory: this.directory,
      planID: plan.id,
      planRevision: plan.revision,
      phase,
      taskID,
      taskRevision,
      attemptID,
      artifact,
      checkID: check.id,
      command: check.command,
      authoredTimeoutMs: check.timeoutMs ?? null,
      authoredInactivityTimeoutMs: check.inactivityTimeoutMs ?? null,
      authoredHardTimeoutMs: check.hardTimeoutMs ?? null,
      defaultInactivityTimeoutMs: this.verificationTimeoutDefaults.inactivityTimeoutMs,
      defaultHardTimeoutMs: this.verificationTimeoutDefaults.hardTimeoutMs,
    }
  }

  private async runVerificationCheck(
    workspace: string,
    artifact: string,
    check: TaskProposal["verification"][number],
    deadline: VerificationDeadline,
    receiptPath: string,
    options?: Parameters<typeof runDeclaredCheck>[4],
  ): Promise<CheckReceipt> {
    const receipt = await runDeclaredCheck(
      workspace,
      artifact,
      effectiveVerificationCheck(check, deadline),
      receiptPath,
      options,
    )
    const annotated = {
      ...receipt,
      verificationDeadline: verificationReceiptDeadline(deadline),
    }
    await writeCheckReceipt(receiptPath, annotated)
    return annotated
  }

  private async cancelCheckActivities(planID: string): Promise<VerificationActivity[]> {
    return abortVerificationActivities(
      (activity) =>
        activity.metadata.databasePath ===
          canonicalVerificationDatabasePath(this.store.repository.path) &&
        activity.metadata.projectDirectory === this.directory &&
        activity.metadata.planID === planID,
    )
  }

  private retainedCheckSettlementProblem(operationID: string): string | undefined {
    return this.store.atomic((db) => {
      for (const check of retainedVerificationChecks(db, operationID)) {
        if (check.state !== "completed" || !check.receipt)
          return "Retained check has no conclusive final receipt"
        try {
          const receipt = JSON.parse(check.receipt) as CheckReceipt
          if (!checkResourcesSettled(receipt))
            return `Command exited ${receipt.exitCode ?? "unknown"} with timedOut=${receipt.timedOut}; subprocess cleanup remains uncertain`
        } catch {
          return "Retained check settlement receipt is unreadable"
        }
      }
      return undefined
    })
  }

  private async reconcileCancelledCheckActivities(
    plan: PlanRow,
    activities: VerificationActivity[],
    fence: number,
  ): Promise<void> {
    for (const activity of activities) {
      const metadata = activity.metadata
      if (metadata.kind === "effect" && typeof metadata.effectID === "string") {
        const effect = this.store
          .effects(plan.id)
          .find((candidate) => candidate.id === metadata.effectID)
        if (effect) await this.reconcileEffect(effect, fence)
        continue
      }
      if (
        metadata.kind === "adoption" &&
        typeof metadata.adoptionID === "string" &&
        (metadata.phase === "task" || metadata.phase === "combined") &&
        typeof metadata.checkID === "string"
      ) {
        const adoptionID = metadata.adoptionID
        const phase = metadata.phase
        const checkID = metadata.checkID
        const row = this.store
          .adoptionChecks(adoptionID, phase)
          .find((candidate) => candidate.check_id === checkID)
        if (!row) continue
        let receipt: CheckReceipt | undefined
        try {
          if (existsSync(row.receipt_path))
            receipt = JSON.parse(readFileSync(row.receipt_path, "utf8")) as CheckReceipt
        } catch {
          receipt = undefined
        }
        const check = JSON.parse(row.check_json) as TaskProposal["verification"][number]
        if (
          activity.state === "completed" &&
          receipt &&
          this.adoptionExecution.adoptionCheckReceiptMatches(receipt, row, check)
        )
          this.store.completeAdoptionCheck(adoptionID, phase, checkID, receipt, {
            owner: this.owner,
            value: fence,
          })
        else
          this.store.markAdoptionCheckUncertain(
            adoptionID,
            phase,
            checkID,
            `Cancelled adoption check has no conclusive receipt${activity.error ? `: ${errorText(activity.error)}` : ""}`,
            { owner: this.owner, value: fence },
          )
        const activityID =
          typeof metadata.activityID === "string"
            ? metadata.activityID
            : `adoption:${adoptionID}:${phase}:${checkID}`
        const activityIdentity = {
          adoptionID,
          phase,
          checkID,
          inputFingerprint: row.input_fingerprint,
          workspace: row.workspace,
          artifact: row.artifact,
          receiptPath: row.receipt_path,
        }
        forgetVerificationActivity(
          verificationActivityKey(this.store.repository.path, activityID),
          fingerprint(activityIdentity),
        )
        continue
      }
      if (metadata.kind === "retained") await this.settleCancelledRetainedActivity(activity)
    }
  }

  private async settleCancelledRetainedActivity(activity: VerificationActivity): Promise<void> {
    await this.settleCancelledRetainedReceipt(activity.metadata, activity)
  }

  private async recoverCancelledRetainedChecks(operationID: string): Promise<void> {
    const operation = this.store.atomic((db) => retainedVerification(db, operationID))
    if (
      !operation ||
      operation.state !== "cancelled" ||
      operation.projectDirectory !== this.directory
    )
      return
    const checks = this.store.atomic((db) => retainedVerificationChecks(db, operationID))
    for (const check of checks) {
      if (check.state === "completed") continue
      // These are durable bindings, not a synthesized successful activity.
      // The disk receipt and isolation witness must independently validate.
      await this.settleCancelledRetainedReceipt({
        operationID,
        phase: check.phase,
        checkID: check.checkID,
        workspace: check.workspace,
        artifact: check.artifact,
        contextPath: check.contextPath,
      })
    }
  }

  private async settleCancelledRetainedReceipt(
    metadata: Record<string, unknown>,
    activity?: VerificationActivity,
  ): Promise<void> {
    if (
      typeof metadata.operationID !== "string" ||
      metadata.phase !== "task" ||
      typeof metadata.checkID !== "string" ||
      typeof metadata.workspace !== "string" ||
      typeof metadata.artifact !== "string" ||
      typeof metadata.contextPath !== "string"
    )
      return
    const operationID = metadata.operationID
    const phase = metadata.phase
    const checkID = metadata.checkID
    const operation = this.store.atomic((db) => retainedVerification(db, operationID))
    const row = this.store.atomic((db) =>
      retainedVerificationChecks(db, operationID, phase).find(
        (candidate) => candidate.checkID === checkID,
      ),
    )
    if (!operation || !row) return
    const identity = {
      operationID,
      phase,
      checkID,
      inputFingerprint: row.inputFingerprint,
      workspace: row.workspace,
      artifact: row.artifact,
      contextPath: row.contextPath,
    }
    let receipt: CheckReceipt | undefined
    try {
      if (existsSync(row.receiptPath))
        receipt = JSON.parse(readFileSync(row.receiptPath, "utf8")) as CheckReceipt
    } catch {
      receipt = undefined
    }
    const check = JSON.parse(row.checkJSON) as TaskProposal["verification"][number]
    const procedure = retainedProcedurePlan(check.command)
    let valid = false
    try {
      if (
        (!activity || activity.state === "completed") &&
        receipt &&
        procedure.status === "supported"
      )
        valid = Boolean(
          row.workspace === metadata.workspace &&
          row.artifact === metadata.artifact &&
          row.contextPath === metadata.contextPath &&
          row.workspace ===
            this.retainedVerificationExecution.retainedVerificationIsolatedWorkspace(
              operation,
              phase,
            ) &&
          row.artifact === operation.artifact &&
          (await observeRetainedCheckIsolationWitness(
            row.contextPath,
            activity ? metadata.isolation : receipt.isolation,
            {
              operationID,
              phase,
              checkID,
              originalWorkspace: operation.originalWorkspace,
              candidateWorkspace: row.workspace,
              taskDatabase: this.store.repository.path,
              projectDirectory: this.directory,
              candidateArtifact: row.artifact,
              projectIdentity: retainedProjectIdentity(this.directory, row.workspace, row.artifact),
              procedurePlan: procedure.plan,
            },
          )) &&
          this.retainedVerificationExecution.retainedVerificationCheckReceipt(
            receipt,
            operation,
            phase,
            check,
            row.workspace,
            row.artifact,
            row.environmentIdentity,
          ) !== undefined,
        )
    } catch {
      valid = false
    }
    if (valid && receipt) {
      this.retainedVerificationExecution.completeRetainedCheck(operation, phase, checkID, receipt)
      if (checkResourcesSettled(receipt))
        await this.retainedVerificationExecution.cleanupRetainedCheckResources(
          operation,
          phase,
          checkID,
          row.contextPath,
          receipt.isolation,
          0,
        )
      else
        this.store.atomic((db) =>
          settleRetainedVerificationResources(
            db,
            operationID,
            phase,
            checkID,
            "uncertain",
            this.now(),
          ),
        )
      if (!checkResourcesSettled(receipt))
        this.store.record(
          operation.planID,
          operation.taskID,
          "RETAINED_VERIFICATION_CHECK_RESOURCES_UNCERTAIN",
          {
            operationID,
            phase,
            checkID,
            receipt,
            processCleanup: receipt.processCleanup,
          },
        )
      this.retainedVerificationAborts.delete(operationID)
    } else {
      this.store.atomic((db) =>
        markRetainedVerificationCheckUncertain(
          db,
          operationID,
          phase,
          checkID,
          activity?.error
            ? `Verification process termination or receipt is uncertain: ${errorText(activity.error)}`
            : "Cancelled verification receipt did not match its retained operation binding",
        ),
      )
      this.store.atomic((db) =>
        settleRetainedVerificationResources(
          db,
          operationID,
          phase,
          checkID,
          "uncertain",
          this.now(),
        ),
      )
    }
    forgetVerificationActivity(
      verificationActivityKey(
        this.store.repository.path,
        `retained:${operationID}:${phase}:${checkID}`,
      ),
      fingerprint(identity),
    )
  }

  readScheduling(input: SchedulingInput): Promise<SchedulingPage> {
    return this.schedulingRead.read(input)
  }

  private retainedVerificationWorkspacePath(operationID: string, phase: "task") {
    return canonicalProjectWorktreePath(this.directory, `retained-${operationID}-${phase}`)
  }

  private resolveTaskDispatchRoute(
    proposal: PlanInput,
    taskID: string,
    persona: NonNullable<PlanInput["nodes"][number]["persona"]>,
    configuredImplementor: NonNullable<PlanInput["workerModel"]> | null,
  ): DispatchRouteDecision {
    return resolveDispatchRoute({
      schemaVersion: 1,
      persona,
      projectDirectory: this.directory,
      taskID,
      explicitOverride: proposal.workerModel
        ? { source: "explicit-plan-selection", route: proposal.workerModel }
        : null,
      mappingResolution: {
        source: "model-mapping-resolver",
        resolution: this.modelMappingResolver.resolve({ persona, taskID }),
      },
      configuredImplementor: {
        source: "native-implementor-selection",
        route: proposal.workerModel ? null : configuredImplementor,
      },
    })
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

  private sourceWorkerWait(
    attempt: Pick<
      AttemptRow,
      "id" | "task_id" | "policy" | "session_id" | "workspace" | "state" | "message_id"
    >,
    session: HostSession | null | undefined,
    requireCompletedForeground = true,
  ) {
    if (
      !session ||
      session.id !== attempt.session_id ||
      session.projectID !== this.projectID ||
      session.directory !== attempt.workspace ||
      !isWorkerAgent(session.agent) ||
      session.metadata?.lazersAttemptID !== attempt.id
    )
      return "Retained worker ownership or location is unavailable"
    if (
      session.busy ||
      session.pendingInput !== false ||
      session.observationUnstable ||
      session.pendingPermissions !== 0 ||
      session.pendingForms !== 0
    )
      return "Retained worker has active or unresolved foreground/input/approval work"
    if (
      attempt.state === "running" &&
      requireCompletedForeground &&
      (session.outcome !== "succeeded" ||
        session.turn?.state !== "completed" ||
        session.turn.inputID !== attempt.message_id)
    )
      return "Retained running attempt requires its current input's completed foreground execution"
    return undefined
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
    return Boolean(
      session &&
      !session.archived &&
      session.agent === "architect" &&
      session.projectID === this.projectID,
    )
  }

  private async ensureArchitectOwner(
    plan: PlanRow,
    previous: HostSession | null | undefined,
    adopt = true,
  ): Promise<HostSession> {
    const current = await this.host.session(plan.owner)
    if (this.validArchitect(current)) return current
    // A user-set pause: never create, resume or fork an Architect session.
    if (this.store.architectContactPaused()) throw new Error("Architect contact is paused")

    let continuation = this.store.continuation(plan.id)
    let priorContinuation: HostSession | null = null
    if (continuation) {
      priorContinuation = await this.host.session(continuation.session_id)
      if (
        this.validArchitect(priorContinuation) &&
        this.matchesContinuation(priorContinuation, plan.id)
      ) {
        if (adopt) this.adoptArchitectOwner(plan, priorContinuation.id)
        return priorContinuation
      }
    }

    let next:
      | { session_id: string; parent_id: string | null; directory: string; model: string | null }
      | undefined
    if (!continuation || priorContinuation) {
      const source = previous?.projectID === this.projectID ? previous : current
      const model = source?.projectID === this.projectID ? source.model : undefined
      next = {
        session_id: sessionID(),
        parent_id: null,
        directory: this.directory,
        model: model ? JSON.stringify(model) : (continuation?.model ?? null),
      }
      continuation = continuation
        ? this.store.replaceContinuation(plan.id, continuation.session_id, next)
        : this.store.ensureContinuation(plan.id, next)
    }

    // A concurrent scheduler may already have selected a different stable ID.
    if (next && continuation.session_id !== next.session_id && continuation.generation > 1) {
      const adopted = await this.host.session(continuation.session_id)
      if (this.validArchitect(adopted) && this.matchesContinuation(adopted, plan.id)) {
        if (adopt) this.adoptArchitectOwner(plan, adopted.id)
        return adopted
      }
    }

    let session = await this.host.session(continuation.session_id)
    if (session && !this.matchesContinuation(session, plan.id))
      throw new Error("Native Architect continuation ID belongs to another session")
    if (!session) {
      try {
        await this.host.createArchitect({
          id: continuation.session_id,
          ...(continuation.parent_id ? { parentID: continuation.parent_id } : {}),
          directory: continuation.directory,
          ...(() => {
            const model = this.architectSessionModel(
              continuation.model ? JSON.parse(continuation.model) : undefined,
            )
            return model ? { model } : {}
          })(),
          title: this.sessionTitle(`continue ${plan.id.slice(0, 8)}`),
          planID: plan.id,
          sourceSessionID: plan.owner,
        })
      } catch (error) {
        const recovered = await this.host.session(continuation.session_id)
        if (!this.matchesContinuation(recovered, plan.id)) throw error
        session = recovered
      }
      session ??= await this.host.session(continuation.session_id)
    }
    if (!this.validArchitect(session) || !this.matchesContinuation(session, plan.id))
      throw new Error("Native Architect continuation is unavailable or foreign")
    this.store.record(plan.id, null, "ARCHITECT_CONTINUATION_READY", {
      sessionID: session.id,
      parentID: continuation.parent_id,
      generation: continuation.generation,
    })
    if (adopt) this.adoptArchitectOwner(plan, session.id)
    return session
  }

  private adoptArchitectOwner(plan: PlanRow, sessionID: string) {
    this.store.atomic(() => {
      if (!this.store.adoptPlanOwner(plan.id, plan.owner, sessionID)) return
      // Persist the replacement's wake with ownership so a restart cannot split them.
      this.wakeRecoveredArchitect(plan.id)
    })
  }

  private wakeRecoveredArchitect(planID: string) {
    const plan = this.store.plan(planID)!
    if (!["blocked", "accepted", "cleanup-blocked"].includes(plan.state)) return
    const pending = this.store.atomic((db) =>
      db
        .query<{ id: string }, [string]>(
          "SELECT id FROM runner_outbox WHERE plan_id=? AND state='pending' LIMIT 1",
        )
        .get(planID),
    )
    // A consumed notice does not mean its unresolved plan was repaired.
    if (!pending) this.outcome(planID, { status: plan.state, reason: plan.reason }, true)
  }

  private matchesContinuation(session: HostSession | null | undefined, planID: string) {
    const continuation = this.store.continuation(planID)
    const listedPlans = session?.metadata?.lazersPlanIDs
    return (
      Boolean(continuation) &&
      session?.agent === "architect" &&
      session.projectID === this.projectID &&
      session.directory === this.directory &&
      session.parentID === (continuation?.parent_id ?? undefined) &&
      session.metadata?.lazersContinuation === true &&
      (session.metadata.lazersPlanID === planID ||
        (Array.isArray(listedPlans) && listedPlans.includes(planID)))
    )
  }

  /** Called by the native prompt hook before OpenCode admits the input to its inbox. */
  async observeArchitectPrompt(sessionID: string, nativeMessageID: string) {
    const observed = this.store.observeArchitectInput(sessionID, nativeMessageID, this.now(), {
      type: "user",
      disposition: "prompt",
      userPrompt: true,
    })
    if (observed.role === "predecessor") {
      this.sourceEpochs.set(sessionID, (this.sourceEpochs.get(sessionID) ?? 0) + 1)
      this.store.invalidateArchitectSource(sessionID, this.now())
    }
  }

  private readonly sourceInvalidations = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; dirty: boolean }
  >()

  /**
   * Called for every native event. O(1) for sessions that are not Architect
   * sources; for sources the epoch bumps in memory at once and the durable
   * invalidation is coalesced (250ms) off the event path.
   */
  observeArchitectSourceEvent(sessionID?: string) {
    if (sessionID) {
      if (!this.sourceEpochs.has(sessionID)) return
      this.scheduleSourceInvalidation(sessionID)
      return
    }
    this.sourceResyncPending = true
    for (const id of this.store.architectSourceSessionIDs())
      if (!this.sourceEpochs.has(id)) this.sourceEpochs.set(id, 0)
    for (const id of [...this.sourceEpochs.keys()]) this.scheduleSourceInvalidation(id)
    this.sourceResyncPending = false
  }

  /** Leading edge writes at once; further events in the 250ms window coalesce into one trailing write. */
  private scheduleSourceInvalidation(sessionID: string) {
    this.sourceEpochs.set(sessionID, (this.sourceEpochs.get(sessionID) ?? 0) + 1)
    const pending = this.sourceInvalidations.get(sessionID)
    if (pending) {
      pending.dirty = true
      return
    }
    this.store.invalidateArchitectSource(sessionID, this.now())
    const entry = {
      dirty: false,
      timer: setTimeout(() => {
        this.sourceInvalidations.delete(sessionID)
        if (!entry.dirty) return
        try {
          this.store.invalidateArchitectSource(sessionID, this.now())
        } catch {
          // The next event or tick re-requests the invalidation.
        }
      }, 250),
    }
    entry.timer.unref?.()
    this.sourceInvalidations.set(sessionID, entry)
  }

  /** Apply pending coalesced invalidations before a decision reads source state. */
  private assertSchedulerActive() {
    if (this.stopped) throw new Error("Scheduler registration was disposed")
  }

  flushSourceInvalidations() {
    for (const [id, entry] of [...this.sourceInvalidations]) {
      if (!entry.dirty) continue
      entry.dirty = false
      this.store.invalidateArchitectSource(id, this.now())
    }
  }

  async recordArchitectContinuity(sessionID: string, input: unknown) {
    const continuity = ArchitectContinuityInput.parse(input)
    const session = await this.host.session(sessionID)
    if (!this.validArchitect(session))
      throw new Error("Architect continuity can only be recorded by the current active Architect")
    if (!this.host.architectInputPage)
      throw new Error("Architect continuity requires public input/history coverage")
    const coverageInputs: Array<{ id: string; type: string; metadata?: Record<string, unknown> }> =
      []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const page = await this.host.architectInputPage(sessionID, cursor)
      coverageInputs.push(...page.inbox, ...page.messages)
      if (!page.nextCursor) break
      if (seenCursors.has(page.nextCursor))
        throw new Error("Architect continuity history pagination did not advance")
      seenCursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
    const saved = this.store.saveArchitectContinuity({
      sessionID,
      decisions: continuity.decisions,
      unresolvedQuestions: continuity.unresolvedQuestions,
      coverageInputs,
      now: this.now(),
    })
    return {
      status: "recorded",
      sessionID,
      revision: saved.revision,
      decisionCount: continuity.decisions.length,
      unresolvedQuestionCount: continuity.unresolvedQuestions.length,
    }
  }

  async inspectArchitectSourceMessages(rawInput: unknown, caller: string) {
    const input = SourceMessagesInspectPlanSchema.parse(rawInput)
    const plan = this.store.plan(input.planID)
    if (!plan || plan.owner !== caller)
      throw new Error("Selected source-message retrieval requires the current plan owner")
    const owner = await this.host.session(caller)
    if (!this.validArchitect(owner))
      throw new Error("Selected source-message retrieval requires the active Architect owner")
    if (!this.host.architectSourceMessage)
      throw new Error("Authenticated native source-message retrieval is unavailable")
    const references = this.store.architectSourceMessageReferences(
      input.planID,
      input.sourceSessionID,
      input.messageIDs,
    )
    if (references.length !== input.messageIDs.length)
      throw new Error("Every selected message ID must identify a journaled source input or result")
    const messages = []
    for (const reference of references) {
      const message = await this.host.architectSourceMessage(
        input.sourceSessionID,
        reference.messageID,
      )
      if (message.id !== reference.messageID || message.type !== reference.type)
        throw new Error("Native source-message identity or journal type changed during retrieval")
      messages.push({ ...message, kind: reference.kind })
    }
    const current = this.store.plan(input.planID)
    if (!current || current.owner !== caller || current.version !== plan.version)
      throw new Error("Plan owner or version changed during selected source-message retrieval")
    return {
      mode: "source-messages" as const,
      planID: input.planID,
      sourceSessionID: input.sourceSessionID,
      selected: messages.length,
      coverage: {
        authenticatedNativeRead: true,
        privacyFiltered: true,
        metadataAndAttachmentsOmitted: true,
        transcriptCompleteness: "unknown" as const,
        nativeConsumption: "unknown" as const,
      },
      messages,
    }
  }

  private async inspectArchitectSourcePage(renewal: ArchitectRenewalRow, fence: number) {
    if (!this.host.architectInputPage)
      throw new Error("Native Architect input/history observation is unavailable")
    this.flushSourceInvalidations()
    const source = this.store.architectSource(renewal.previous_session_id)
    if (!source) throw new Error("Durable Architect predecessor source is unavailable")
    if (!this.sourceEpochs.has(source.session_id)) this.sourceEpochs.set(source.session_id, 0)
    const epoch = this.sourceEpochs.get(source.session_id)
    let known: import("./host.ts").ArchitectSourceObservation | undefined
    try {
      if (source.scan_complete_at !== null && source.observation_json !== null)
        known = JSON.parse(source.observation_json)
    } catch {
      // A damaged cache hint requests a fresh scan; retained history remains usable.
    }
    const page = await this.host.architectInputPage(
      renewal.previous_session_id,
      source.scan_cursor ?? undefined,
      known,
    )
    const result = this.store.recordArchitectSourcePage({
      schedulerOwner: this.owner,
      fence,
      sessionID: renewal.previous_session_id,
      cursor: source.scan_cursor,
      nextCursor: page.nextCursor,
      inbox: page.inbox,
      messages: page.messages,
      now: this.now(),
      projectID: this.projectID,
      ...(page.observation ? { observation: page.observation } : {}),
      unchanged: page.unchanged,
      cacheCurrent: epoch === this.sourceEpochs.get(source.session_id),
    })
    if (!result) throw new Error("Architect predecessor source changed during reconciliation")
    if (result.changedInputs.length)
      this.renewalEvent(
        renewal,
        "ARCHITECT_RENEWAL_NATIVE_INPUT_OBSERVED",
        {
          renewalID: renewal.id,
          sourceRevision: result.revision,
          inputs: result.changedInputs,
          nextCursor: result.nextCursor,
        },
        fence,
      )
    if (result.changedResults.length)
      this.renewalEvent(
        renewal,
        "ARCHITECT_RENEWAL_SOURCE_RESULT_OBSERVED",
        {
          renewalID: renewal.id,
          sourceRevision: result.revision,
          results: result.changedResults,
          nextCursor: result.nextCursor,
        },
        fence,
      )
    if (
      result.nextCursor === null &&
      epoch === this.sourceEpochs.get(source.session_id) &&
      this.store.architectRenewal(renewal.id)?.state === "committed"
    ) {
      const archived = page.archived ?? (await this.host.session(source.session_id))?.archived
      if (archived === true && epoch === this.sourceEpochs.get(source.session_id))
        this.store.retireArchitectSource(source.session_id, this.owner, fence, this.now())
    }
    return result
  }

  private async inspectArchitectSourceSweep(renewal: ArchitectRenewalRow, fence: number) {
    const requestedCursors = new Set<string>()
    for (;;) {
      const source = this.store.architectSource(renewal.previous_session_id)
      if (!source) throw new Error("Durable Architect predecessor source is unavailable")
      const cursor = source.scan_cursor
      if (cursor !== null) {
        if (requestedCursors.has(cursor))
          throw new Error("Native Architect input/history pagination did not advance")
        requestedCursors.add(cursor)
      }
      try {
        const result = await this.inspectArchitectSourcePage(renewal, fence)
        if (result.nextCursor === null) return
        if (result.nextCursor === cursor || requestedCursors.has(result.nextCursor))
          throw new Error("Native Architect input/history pagination did not advance")
      } catch (error) {
        // A prompt hook can defer preparation between the page read and its journal
        // write. That expected state change ends the sweep without masking read errors.
        if (this.store.architectRenewal(renewal.id)?.state !== "creating") return
        throw error
      }
    }
  }

  private readonly sourceScanFailures = new Map<string, string>()

  private async reconcileArchitectSources(fence: number) {
    if (!this.host.architectInputPage) return
    for (const source of this.store.architectSources()) {
      const renewal = this.store.architectRenewal(source.renewal_id)
      if (!renewal) continue
      try {
        await this.inspectArchitectSourcePage(renewal, fence)
        this.sourceScanFailures.delete(source.session_id)
      } catch (error) {
        // No live location is the plugin booting or reloading, not a property of the
        // source: retry on the next tick and record nothing.
        if (error instanceof NoCapabilityProviderError) continue
        const cause = errorText(error)
        if (this.sourceScanFailures.get(source.session_id) === cause) continue
        this.sourceScanFailures.set(source.session_id, cause)
        // A persistent failure is one durable fact, not one row per tick or per process
        // start: record only when the cause differs from this source's newest failure.
        this.store.fenced(this.owner, fence, () =>
          this.store.recordSourceScanFailure(renewal.anchor_plan_id, {
            renewalID: renewal.id,
            sourceSessionID: source.session_id,
            error: cause,
          }),
        )
      }
    }
  }

  private async withRenewalLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.renewalLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => (release = resolve))
    this.renewalLocks.set(key, current)
    await previous
    try {
      return await run()
    } finally {
      release()
      if (this.renewalLocks.get(key) === current) this.renewalLocks.delete(key)
    }
  }

  private async restorePredecessorForInput(renewal: ArchitectRenewalRow, fence?: number) {
    if (!this.host.updateSession)
      throw new Error(
        "Cannot preserve input during Architect renewal: native session update is unavailable",
      )
    const predecessor = await this.host.session(renewal.previous_session_id)
    if (!predecessor)
      throw new Error(
        "Cannot preserve input during Architect renewal: predecessor session is unavailable",
      )
    if (predecessor.archived) {
      await this.host.updateSession({ sessionID: predecessor.id, archived: false })
      const restored = await this.host.session(predecessor.id)
      if (!restored || restored.archived)
        throw new Error(
          "Cannot preserve input during Architect renewal: predecessor did not unarchive",
        )
    }
    if (fence !== undefined) {
      const changed = this.store.rollbackArchitectRenewal(
        this.owner,
        fence,
        renewal.id,
        "deferred",
        null,
      )
      if (!changed) {
        const current = this.store.architectRenewal(renewal.id)
        if (current && ["archiving", "recovering-input", "rolling-back"].includes(current.state))
          throw new Error(
            "Cannot preserve input during Architect renewal: ownership rollback was not recorded",
          )
      }
    }
  }

  private renewalSuccessorMatches(
    session: HostSession | null,
    renewal: ArchitectRenewalRow,
    allowArchived = false,
  ) {
    const model = JSON.parse(renewal.model) as NonNullable<HostSession["model"]>
    const planIDs = this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id)
    const metadataPlanIDs = session?.metadata?.lazersPlanIDs
    // Metadata is the identity snapshot taken when native creation began. Later
    // plans may be admitted to the predecessor while creation is in flight; the
    // durable transfer attaches those plans without changing successor identity.
    const anchorIdentity =
      session?.metadata?.lazersPlanID === renewal.anchor_plan_id &&
      (!Array.isArray(metadataPlanIDs) ||
        (metadataPlanIDs.includes(renewal.anchor_plan_id) &&
          metadataPlanIDs.every((id) => planIDs.includes(String(id)))))
    return Boolean(
      session &&
      (allowArchived || !session.archived) &&
      session.agent === "architect" &&
      session.id === renewal.successor_session_id &&
      session.projectID === this.projectID &&
      session.directory === renewal.directory &&
      (session.parentID === undefined || session.parentID === renewal.previous_session_id) &&
      sameNativeModel(session.model, model) &&
      session.metadata?.lazersContinuation === true &&
      session.metadata.lazersSourceSessionID === renewal.previous_session_id &&
      anchorIdentity,
    )
  }

  private renewalLabel(renewal: ArchitectRenewalRow) {
    const plan = this.store.plan(renewal.anchor_plan_id)
    if (!plan) return `Continue LAZERS plan ${renewal.anchor_plan_id.slice(0, 8)}`
    const input = PlanInput.parse(JSON.parse(plan.body))
    return input.title ?? input.objective.slice(0, 120)
  }

  private renewalContinuity(renewal: ArchitectRenewalRow) {
    if (!renewal.continuity_json)
      throw new Error("Architect renewal has no explicit continuity checkpoint")
    const parsed = JSON.parse(renewal.continuity_json) as { revision?: unknown }
    const content = ArchitectContinuityInput.parse({
      decisions: (parsed as Record<string, unknown>).decisions,
      unresolvedQuestions: (parsed as Record<string, unknown>).unresolvedQuestions,
    })
    if (typeof parsed.revision !== "number" || !Number.isSafeInteger(parsed.revision))
      throw new Error("Architect continuity checkpoint revision is invalid")
    return { revision: parsed.revision, ...content }
  }

  /** `<CODE> · <text>`; `LAZERS` stands in until the project has a code. */
  private sessionTitle(text: string): string {
    return sessionTitle(this.store.repository.projectCode() ?? "LAZERS", text)
  }

  private renewalContinuityCoverage(renewal: ArchitectRenewalRow) {
    const coverage = this.store.architectRenewalCoverageEvidence(renewal.id)
    if (!coverage) throw new Error("Architect renewal continuity coverage is unavailable")
    return {
      revision: coverage.revision,
      inputCount: coverage.inputCount,
      inputFingerprint: coverage.inputFingerprint,
    }
  }

  private renewalWakeContext(renewal: ArchitectRenewalRow, payload: unknown) {
    const text = outcomeText(JSON.stringify(payload), this.store.repository.projectCode())
    return {
      bytes: new TextEncoder().encode(text).byteLength,
      tokens: null,
      tokenProvenance:
        "unknown: OpenCode exposes session-cumulative token counts, not a message-level count for this wake",
      cache: {
        uncachedInput: null,
        read: null,
        write: null,
        provenance:
          "unknown until the native successor reports a public session usage snapshot; no cache hit or savings are inferred",
      },
      sessionID: renewal.successor_session_id,
      sessionUsageProvenance: "OpenCode 2.2.5 session.get cumulative snapshot, not wake-attributed",
    }
  }

  private renewalEvent(
    renewal: ArchitectRenewalRow,
    event: string,
    payload: unknown,
    fence: number,
  ) {
    this.store.fenced(this.owner, fence, () =>
      this.store.record(renewal.anchor_plan_id, null, event, payload),
    )
  }

  private renewalIssue(
    renewal: ArchitectRenewalRow,
    event: string,
    error: string,
    payload: Record<string, unknown>,
    fence: number,
  ) {
    this.store.setArchitectRenewalState(
      this.owner,
      fence,
      renewal.id,
      [renewal.state],
      renewal.state,
      error,
    )
    this.renewalEvent(renewal, event, { renewalID: renewal.id, error, ...payload }, fence)
  }

  /** The single routing decision: reuse a warm or small Architect, otherwise create a fresh one. */
  private architectRoute(session: HostSession | null | undefined): ArchitectRoute {
    return routeArchitect(
      this.validArchitect(session) ? session : null,
      this.now(),
      this.architectRouting,
    )
  }

  /** Record the routing decision once per change, with its reason, before acting on it. */
  private recordArchitectRoute(
    plan: PlanRow,
    route: ArchitectRoute,
    session: HostSession | null | undefined,
  ) {
    const previous = this.store.latestTransition<{ sessionID: string | null; reason: string }>(
      plan.id,
      null,
      "ARCHITECT_ROUTED",
    )
    if (previous?.sessionID === route.sessionID && previous.reason === route.reason) return
    this.store.record(plan.id, null, "ARCHITECT_ROUTED", {
      action: route.action,
      reason: route.reason,
      sessionID: route.sessionID,
      owner: plan.owner,
      contextTokens: session ? architectContextTokens(session) : null,
      cacheWindowMs: this.architectRouting.architectCacheWindowMs,
      reuseMaxContextTokens: this.architectRouting.architectReuseMaxContextTokens,
    })
  }

  /**
   * The one model decision for an Architect session LAZERS creates. A renewal records it and the
   * host creates exactly it, so the successor check compares the session with what was asked for.
   */
  private architectSessionModel(carried: ModelPolicy | undefined) {
    return architectSessionModel(agentRouteReader(this.store.repository)("architect"), carried)
  }

  private architectWaitingForHuman(session: HostSession) {
    return (session.pendingForms ?? 0) > 0 || (session.pendingPermissions ?? 0) > 0
  }

  private async considerArchitectRenewal(plan: PlanRow, owner: HostSession, fence: number) {
    if (
      this.store.architectContactPaused() ||
      !this.architectPromptHook ||
      !this.host.updateSession ||
      !this.host.architectInputPage ||
      owner.idleAt === undefined ||
      owner.busy ||
      this.architectWaitingForHuman(owner) ||
      !owner.model ||
      this.architectRoute(owner).action !== "fresh"
    )
      return false
    if (!this.store.architectContinuity(owner.id)) return false
    const labelPlan = PlanInput.parse(JSON.parse(plan.body))
    const label = labelPlan.title ?? labelPlan.objective.slice(0, 120)
    const renewal = this.store.beginArchitectRenewal({
      schedulerOwner: this.owner,
      fence,
      anchorPlanID: plan.id,
      previousSessionID: owner.id,
      directory: owner.directory,
      model: JSON.stringify(this.architectSessionModel(owner.model)),
      idleAt: owner.idleAt,
      now: this.now(),
      handoffMessageID: messageID(),
    })
    if (!renewal) return false
    await this.continueArchitectRenewal(renewal, fence, label)
    return true
  }

  private async continueArchitectRenewal(
    initial: ArchitectRenewalRow,
    fence: number,
    knownLabel?: string,
  ) {
    // While Architect contact is paused no renewal may create, archive or resume a session.
    if (this.store.architectContactPaused()) return
    try {
      return await this.withRenewalLock(initial.id, async () => {
        let renewal = this.store.architectRenewal(initial.id)
        if (!renewal) return
        if (
          !this.architectPromptHook ||
          !this.host.updateSession ||
          !this.host.architectInputPage
        ) {
          const reason = "Native Architect source reconciliation or archival is unavailable"
          if (renewal.state === "creating") {
            this.store.setArchitectRenewalState(
              this.owner,
              fence,
              renewal.id,
              ["creating"],
              "deferred",
              reason,
            )
            this.renewalEvent(
              renewal,
              "ARCHITECT_RENEWAL_DEFERRED",
              { renewalID: renewal.id, reason },
              fence,
            )
            return
          }
          if (renewal.state === "archiving") {
            this.renewalIssue(renewal, "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN", reason, {}, fence)
            return
          }
        }
        if (["recovering-input", "rolling-back"].includes(renewal.state)) {
          await this.restorePredecessorForInput(renewal, fence)
          return
        }
        if (renewal.state === "committed" || renewal.state === "deferred") return
        if (!renewal.continuity_json) {
          if (renewal.state === "creating") {
            this.store.setArchitectRenewalState(
              this.owner,
              fence,
              renewal.id,
              ["creating"],
              "deferred",
              "No explicit Architect decisions/questions checkpoint was recorded",
            )
            this.renewalEvent(
              renewal,
              "ARCHITECT_RENEWAL_DEFERRED",
              {
                renewalID: renewal.id,
                reason: "No explicit Architect decisions/questions checkpoint was recorded",
              },
              fence,
            )
            return
          }
          if (renewal.state === "archiving") {
            this.renewalIssue(
              renewal,
              "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
              "No explicit Architect decisions/questions checkpoint was recorded",
              {},
              fence,
            )
            return
          }
        }
        if (renewal.state === "creating") {
          // Fail unavailable/foreign successor reads before scanning all source
          // history. Re-read after the sweep below; this is not a cached proof.
          const available = await this.host.session(renewal.successor_session_id)
          if (available && !this.renewalSuccessorMatches(available, renewal))
            return this.deferForeignSuccessor(renewal, fence)
          // A checkpoint is only safe to transfer after its complete current history
          // sweep has been journaled and checked for uncovered user input.
          await this.inspectArchitectSourceSweep(renewal, fence)
          renewal = this.store.architectRenewal(renewal.id)!
          if (renewal.state !== "creating") return
          let successor = await this.host.session(renewal.successor_session_id)
          if (successor && !this.renewalSuccessorMatches(successor, renewal))
            return this.deferForeignSuccessor(renewal, fence)
          if (!successor) {
            const predecessor = await this.host.session(renewal.previous_session_id)
            if (predecessor && this.architectWaitingForHuman(predecessor)) {
              this.store.setArchitectRenewalState(
                this.owner,
                fence,
                renewal.id,
                ["creating"],
                "deferred",
                "Predecessor is waiting for human input",
              )
              return
            }
            const planIDs = this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id)
            await this.host
              .createArchitect({
                id: renewal.successor_session_id,
                directory: renewal.directory,
                model: JSON.parse(renewal.model),
                title: this.sessionTitle(knownLabel ?? this.renewalLabel(renewal)),
                planID: renewal.anchor_plan_id,
                planIDs,
                sourceSessionID: renewal.previous_session_id,
              })
              .catch(async (error) => {
                const recovered = await this.host.session(renewal!.successor_session_id)
                if (!this.renewalSuccessorMatches(recovered, renewal!)) throw error
                successor = recovered
              })
            successor ??= await this.host.session(renewal.successor_session_id)
          }
          if (successor && !this.renewalSuccessorMatches(successor, renewal))
            return this.deferForeignSuccessor(renewal, fence)
          if (!this.renewalSuccessorMatches(successor, renewal))
            throw new Error("Native Architect renewal is unavailable or foreign")
          renewal = this.store.architectRenewal(renewal.id)!
          if (renewal.state !== "creating") return
          // Repeat the complete sweep after successor creation to include inputs
          // observed while the native create call was in flight, before transfer.
          await this.inspectArchitectSourceSweep(renewal, fence)
          renewal = this.store.architectRenewal(renewal.id)!
          if (renewal.state !== "creating") return

          const predecessor = await this.host.session(renewal.previous_session_id)
          const tooRecent =
            predecessor?.idleAt === undefined || this.architectRoute(predecessor).action !== "fresh"
          if (
            !this.validArchitect(predecessor) ||
            predecessor.busy ||
            this.architectWaitingForHuman(predecessor) ||
            tooRecent
          ) {
            this.store.setArchitectRenewalState(
              this.owner,
              fence,
              renewal.id,
              ["creating"],
              "deferred",
            )
            this.renewalEvent(
              renewal,
              "ARCHITECT_RENEWAL_DEFERRED",
              {
                renewalID: renewal.id,
                busy: predecessor?.busy ?? null,
              },
              fence,
            )
            return
          }

          const planIDs = this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id)
          const label = knownLabel ?? this.renewalLabel(renewal)
          const continuity = this.renewalContinuity(renewal)
          const anchor = this.store.plan(renewal.anchor_plan_id)
          if (!anchor) throw new Error("Architect renewal plan disappeared")
          const source = this.store.architectSource(renewal.previous_session_id)
          if (!source) throw new Error("Architect predecessor source disappeared before handoff")
          const payload = {
            status: "architect-handoff",
            planID: renewal.anchor_plan_id,
            version: anchor.version + 1,
            planIDs,
            label,
            continuity,
            continuityCoverage: this.renewalContinuityCoverage(renewal),
            predecessorSessionID: renewal.previous_session_id,
            successorSessionID: renewal.successor_session_id,
            sourceRevision: source?.revision ?? 0,
            sourceCoverage: {
              sourceSessionID: renewal.previous_session_id,
              cursor: source?.scan_cursor ?? null,
              complete: (source?.scan_sweep ?? 0) > 0 && source?.scan_cursor === null,
            },
          }
          const outboxID = fingerprint({
            kind: "architect-handoff",
            renewalID: renewal.id,
            messageID: renewal.handoff_message_id,
          })
          const metadata: OutcomeOwnership = {
            lazersKind: "runner-outcome",
            lazersProjectID: this.projectID,
            lazersProjectDirectory: this.directory,
            lazersPlanID: renewal.anchor_plan_id,
            lazersOutboxID: outboxID,
            lazersMessageID: renewal.handoff_message_id,
            lazersSessionID: renewal.successor_session_id,
            lazersStatus: "architect-handoff",
            lazersVersion: anchor.version + 1,
          }
          if (
            !this.store.transferArchitectRenewal({
              schedulerOwner: this.owner,
              fence,
              renewalID: renewal.id,
              outboxID,
              payload: JSON.stringify(payload),
              metadata: JSON.stringify(metadata),
            })
          ) {
            renewal = this.store.architectRenewal(renewal.id)
            if (renewal?.state === "deferred") return
            throw new Error("Architect ownership transfer lost its durable compare-and-swap")
          }
          renewal = this.store.architectRenewal(renewal.id)!
        }

        if (renewal.state !== "archiving") return
        await this.inspectArchitectSourcePage(renewal, fence)
        renewal = this.store.architectRenewal(renewal.id)!
        if (renewal.state !== "archiving") return
        let successor: HostSession | null
        try {
          successor = await this.host.session(renewal.successor_session_id)
        } catch (error) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_SUCCESSOR_UNAVAILABLE",
            errorText(error),
            { successorSessionID: renewal.successor_session_id },
            fence,
          )
          return
        }
        if (!successor || !this.renewalSuccessorMatches(successor, renewal, true)) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_SUCCESSOR_UNAVAILABLE",
            "Durable Architect successor is missing or has a conflicting identity",
            { successorSessionID: renewal.successor_session_id },
            fence,
          )
          return
        }
        if (successor.archived) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_SUCCESSOR_UNAVAILABLE",
            "Durable Architect successor was archived before renewal recovery",
            { successorSessionID: renewal.successor_session_id },
            fence,
          )
          return
        }
        const predecessorBeforeArchive = await this.host.session(renewal.previous_session_id)
        if (!predecessorBeforeArchive) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            "Predecessor session is unavailable before archival",
            {},
            fence,
          )
          return
        }
        if (
          predecessorBeforeArchive.agent !== "architect" ||
          predecessorBeforeArchive.projectID !== this.projectID ||
          predecessorBeforeArchive.directory !== renewal.directory
        ) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            "Predecessor identity changed before archival",
            {},
            fence,
          )
          return
        }
        if (
          predecessorBeforeArchive.busy ||
          this.architectWaitingForHuman(predecessorBeforeArchive) ||
          predecessorBeforeArchive.idleAt === undefined ||
          this.architectRoute(predecessorBeforeArchive).action !== "fresh"
        ) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_DEFERRED",
            "Predecessor became busy, recent, or started waiting for human input before archival",
            { busy: predecessorBeforeArchive.busy, idleAt: predecessorBeforeArchive.idleAt },
            fence,
          )
          return
        }
        let archiveError: string | null = null
        if (!predecessorBeforeArchive.archived) {
          try {
            await this.host.updateSession!({
              sessionID: renewal.previous_session_id,
              archived: true,
            })
          } catch (error) {
            archiveError = errorText(error)
          }
        }

        let predecessor: HostSession | null
        try {
          predecessor = await this.host.session(renewal.previous_session_id)
        } catch (error) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            errorText(error),
            { archiveError },
            fence,
          )
          return
        }
        if (!predecessor) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            "Predecessor session is unavailable",
            { archiveError },
            fence,
          )
          return
        }
        if (!predecessor.archived) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            archiveError ?? "Native archive was not observed",
            { predecessorSessionID: renewal.previous_session_id },
            fence,
          )
          return
        }
        if (archiveError) {
          this.renewalEvent(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_RECONCILED",
            { renewalID: renewal.id, error: archiveError, archived: true },
            fence,
          )
        }
        try {
          await this.inspectArchitectSourcePage(renewal, fence)
        } catch (error) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_SOURCE_SCAN_FAILED",
            `Native inbox could not be verified after archival: ${errorText(error)}`,
            { sourceSessionID: renewal.previous_session_id },
            fence,
          )
          return
        }
        const source = this.store.architectSource(renewal.previous_session_id)
        if (!source) throw new Error("Architect predecessor source disappeared before commit")
        const payload = {
          status: "architect-handoff",
          planID: renewal.anchor_plan_id,
          planIDs: this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id),
          label: knownLabel ?? this.renewalLabel(renewal),
          continuity: this.renewalContinuity(renewal),
          continuityCoverage: this.renewalContinuityCoverage(renewal),
          predecessorSessionID: renewal.previous_session_id,
          successorSessionID: renewal.successor_session_id,
          sourceRevision: source?.revision ?? 0,
          sourceCoverage: {
            sourceSessionID: renewal.previous_session_id,
            cursor: source?.scan_cursor ?? null,
            complete: source.scan_sweep > 0 && source.scan_cursor === null,
          },
        }
        const committed = this.store.finishArchitectRenewal(
          this.owner,
          fence,
          renewal.id,
          this.renewalWakeContext(renewal, payload),
        )
        if (!committed) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_COMMIT_UNCERTAIN",
            "Durable renewal commit was not confirmed after native archival",
            { predecessorSessionID: renewal.previous_session_id },
            fence,
          )
        }
      })
    } catch (error) {
      const current = this.store.architectRenewal(initial.id)
      if (
        current &&
        ["creating", "archiving", "recovering-input", "rolling-back"].includes(current.state)
      ) {
        const reason = errorText(error)
        const previous = this.store.latestTransition<{
          renewalID: string
          state: string
          error: string
        }>(current.anchor_plan_id, null, "ARCHITECT_RENEWAL_RECOVERY_FAILED")
        // Retry recovery normally, but an unchanged durable failure is not a new
        // observation. Publishing it on every tick rebuilds all watching panels.
        if (
          current.error !== reason ||
          previous?.renewalID !== current.id ||
          previous.state !== current.state ||
          previous.error !== reason
        ) {
          this.store.setArchitectRenewalState(
            this.owner,
            fence,
            current.id,
            [current.state],
            current.state,
            reason,
          )
          this.renewalEvent(
            current,
            "ARCHITECT_RENEWAL_RECOVERY_FAILED",
            { renewalID: current.id, state: current.state, error: reason },
            fence,
          )
        }
      }
      throw error
    }
  }

  /**
   * A successor that exists under the renewal's ID but is not the session it asked for never
   * becomes it: its identity does not change between ticks. The renewal defers once, the
   * predecessor keeps its plans, and the deferred row is not retried onto that session.
   */
  private deferForeignSuccessor(renewal: ArchitectRenewalRow, fence: number) {
    if (
      !this.store.setArchitectRenewalState(
        this.owner,
        fence,
        renewal.id,
        ["creating"],
        "deferred",
        RENEWAL_SUCCESSOR_FOREIGN,
      )
    )
      return
    this.renewalEvent(
      renewal,
      "ARCHITECT_RENEWAL_DEFERRED",
      { renewalID: renewal.id, reason: RENEWAL_SUCCESSOR_FOREIGN },
      fence,
    )
  }

  private async rollbackArchitectRenewal(
    renewal: ArchitectRenewalRow,
    state: "deferred" | "archive-failed",
    error: string | null,
    fence: number,
  ) {
    if (!this.host.updateSession)
      throw new Error("Cannot recover Architect renewal without native session update")
    await this.host.updateSession({ sessionID: renewal.previous_session_id, archived: false })
    const restored = await this.host.session(renewal.previous_session_id)
    if (!restored || restored.archived)
      throw new Error("Architect renewal rollback did not restore the predecessor")
    this.store.rollbackArchitectRenewal(this.owner, fence, renewal.id, state, error)
  }

  private hold(
    plan: PlanRow,
    reason: string,
    requestedActions: readonly string[] = ["audit", "reconcile", "cancel"],
    workerObservation?: TerminalWorkerHold,
    observationFence?: WorkerObservationFence,
  ) {
    // A hold advertises every action that unblocks its reason.
    const allowedActions = holdActions(reason, requestedActions)
    const currentObservation = this.store.atomic((db) => {
      if (observationFence && !this.workerObservationCurrent(observationFence)) return false
      const current = db
        .query<{ state: string; reason: string | null }, [string]>(
          "SELECT state,reason FROM runner_plans WHERE id=?",
        )
        .get(plan.id)
      if (!current) throw new Error("Plan not found")
      const previousBlocked = db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_transitions WHERE plan_id=? AND task_id IS NULL AND event='BLOCKED' ORDER BY id DESC LIMIT 1",
        )
        .get(plan.id)
      let previousObservation: unknown
      try {
        previousObservation = previousBlocked
          ? (JSON.parse(previousBlocked.payload) as { workerObservation?: unknown })
              .workerObservation
          : undefined
      } catch {
        previousObservation = undefined
      }
      const observationChanged =
        workerObservation !== undefined
          ? JSON.stringify(previousObservation) !== JSON.stringify(workerObservation)
          : previousObservation !== undefined
      const changedReason = current.state !== "blocked" || current.reason !== reason
      if (!observationChanged && !changedReason) return true
      db.query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'blocked'),reason=?,version=version+1 WHERE id=?",
      ).run(reason, plan.id)
      this.store.record(plan.id, null, "BLOCKED", {
        reason,
        ...(workerObservation ? { workerObservation } : {}),
      })
      this.outcome(plan.id, { status: "blocked", reason, allowedActions }, true)
      return true
    })
    if (!currentObservation) return undefined
    return {
      status: "blocked",
      reason,
      planID: plan.id,
      version: this.store.plan(plan.id)!.version,
    }
  }

  private terminalWorkerObservation(
    attempt: AttemptRow,
    worker: HostSession,
  ): TerminalWorkerHold | undefined {
    if (
      worker.outcome !== "interrupted" &&
      worker.outcome !== "failed" &&
      worker.outcome !== "succeeded"
    )
      return undefined
    return {
      kind: "terminal-worker-observation",
      attemptID: attempt.id,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      inputID: worker.turn?.inputID,
      outcome: worker.outcome,
      turnState: worker.turn?.state,
      idleAt: worker.idleAt,
      busy: worker.busy,
      pendingInput: worker.pendingInput ?? false,
      pendingPermissions: worker.pendingPermissions ?? 0,
      pendingForms: worker.pendingForms ?? 0,
      observationUnstable: worker.observationUnstable ?? false,
    }
  }
  private outcome(planID: string, payload: unknown, resume: boolean) {
    const plan = this.store.plan(planID)!
    const full = {
      planID,
      planRevision: plan.revision,
      version: plan.version,
      ...(payload as object),
      currentPlan: { state: plan.state, reason: plan.reason },
      reviewableTasks: this.store
        .nodes(planID)
        .filter((node) => node.state === "accepted" && node.artifact)
        .map((node) => {
          const attempt = this.store
            .attempts(planID)
            .findLast(
              (candidate) =>
                candidate.task_id === node.task_id &&
                candidate.state === "accepted" &&
                candidate.artifact === node.artifact,
            )
          const adoption = this.store
            .adoptions(planID)
            .find(
              (candidate) =>
                candidate.state === "accepted" &&
                candidate.task_id === node.task_id &&
                candidate.descendant_commit === node.artifact,
            )
          return {
            taskID: node.task_id,
            artifact: node.artifact,
            attemptID: attempt?.id ?? null,
            ...(adoption ? { adoptionID: adoption.id } : {}),
            evidence: this.store.repository
              .get(node.task_id)!
              .proposal.verification.map((check) => check.id),
          }
        }),
    }
    const id = fingerprint(full)
    const nativeMessageID = messageID()
    const metadata: OutcomeOwnership = {
      lazersKind: "runner-outcome",
      lazersProjectID: this.projectID,
      lazersProjectDirectory: this.directory,
      lazersPlanID: planID,
      lazersOutboxID: id,
      lazersMessageID: nativeMessageID,
      lazersSessionID: plan.owner,
      lazersStatus:
        typeof payload === "object" &&
        payload !== null &&
        "status" in payload &&
        typeof payload.status === "string"
          ? payload.status
          : "update",
      lazersVersion: plan.version,
    }
    this.store.atomic((db) => {
      db.query(
        "INSERT OR IGNORE INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',?,?,NULL)",
      ).run(
        id,
        planID,
        plan.owner,
        nativeMessageID,
        JSON.stringify(full),
        Number(resume),
        JSON.stringify(metadata),
      )
      this.store.repository.changed()
    })
  }
  private effect(
    planID: string,
    taskID: string | null,
    attemptID: string | null,
    kind: string,
    payload: unknown,
    fence: number,
  ): EffectRow {
    const baseID = fingerprint({ planID, taskID, attemptID, kind, payload })
    return this.store.fenced(this.owner, fence, (db) => {
      let id = baseID
      const existing = db
        .query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE id=?")
        .get(baseID)
      if (existing) {
        // A verification effect is re-runnable: once its earlier run was
        // superseded (no receipt), the same check runs again on the candidate.
        if (!isRerunnableEffect(kind))
          throw new Error(`Existing ${kind} effect must be reconciled, never replayed`)
        const runs = db
          .query<{ id: string; state: string }, [string, string, string]>(
            "SELECT id,state FROM runner_effects WHERE plan_id=? AND kind=? AND payload=?",
          )
          .all(planID, kind, JSON.stringify(payload))
          .filter((row) => row.id === baseID || row.id.startsWith(`${baseID}:`))
        if (runs.some((row) => row.state !== "failed"))
          throw new Error(`Existing ${kind} effect must be reconciled, never replayed`)
        id = `${baseID}:${runs.length}`
      }
      db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'intended',?,NULL,?)").run(
        id,
        planID,
        taskID,
        attemptID,
        kind,
        JSON.stringify(payload),
        fence,
      )
      this.store.record(planID, taskID, "EFFECT_INTENDED", { effectID: id, kind, attemptID })
      return db.query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE id=?").get(id)!
    })
  }
  private receipt(effect: EffectRow, receipt: unknown, fence: number) {
    this.store.fenced(this.owner, fence, (db) => {
      const changed = db
        .query(
          "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'completed'),receipt=? WHERE id=? AND state IN ('intended','uncertain','held')",
        )
        .run(JSON.stringify(receipt), effect.id).changes
      if (changed !== 1) return
      this.store.record(effect.plan_id, effect.task_id, "EFFECT_COMPLETED", {
        effectID: effect.id,
        kind: effect.kind,
      })
    })
  }
  /** A re-runnable effect with no receipt is replaced, not left uncertain. */
  private supersedeEffect(effect: EffectRow, reason: string, fence: number) {
    this.store.fenced(this.owner, fence, (db) => {
      const changed = db
        .query(
          "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed'),receipt=? WHERE id=? AND state IN ('intended','uncertain')",
        )
        .run(JSON.stringify({ superseded: true, reason }), effect.id).changes
      if (changed !== 1) return
      this.store.record(effect.plan_id, effect.task_id, "EFFECT_SUPERSEDED", {
        effectID: effect.id,
        kind: effect.kind,
        reason,
      })
    })
  }
  private uncertain(effect: EffectRow, error: unknown, fence: number, result?: unknown) {
    const nativeFailure =
      effect.kind === "worktree" || effect.kind === "worktree-recovery"
        ? nativeWorktreeFailureEvidence(error)
        : undefined
    const changed = this.store.fenced(
      this.owner,
      fence,
      (db) =>
        db
          .query(
            "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'uncertain'),receipt=? WHERE id=? AND state IN ('intended','uncertain')",
          )
          .run(
            JSON.stringify({
              ...(!nativeFailure ? { schema: UNCERTAIN_EFFECT_RECEIPT_SCHEMA } : {}),
              error: errorText(error),
              ...(result === undefined ? {} : { result }),
              ...(nativeFailure ? { nativeFailure } : {}),
            }),
            effect.id,
          ).changes,
    )
    if (changed !== 1) return
    const plan = this.store.plan(effect.plan_id)
    if (!plan || plan.state === "cancelling" || terminal.has(plan.state)) return
    if (effect.kind === "worktree-recovery" && effect.attempt_id) {
      const attempt = this.store
        .attempts(effect.plan_id)
        .find((item) => item.id === effect.attempt_id)
      const authorization = attempt ? this.startupRecoveryAuthorization(plan, attempt) : undefined
      if (
        !attempt ||
        !authorization ||
        !this.startupRecoveryAuthorityCurrent(plan, attempt, authorization)
      )
        return
    }
    {
      const reason = `Recovery uncertain for ${effect.kind} ${effect.id}: ${errorText(error)}`
      const payload = JSON.parse(effect.payload) as { adoptionID?: unknown }
      if (effect.kind.startsWith("adoption-") && typeof payload.adoptionID === "string")
        this.adoptionExecution.holdAdoption(plan, payload.adoptionID, reason, "pending", fence)
      else
        this.hold(
          plan,
          reason,
          effect.kind.startsWith("verify:") &&
            isRecord(result) &&
            isRecord(result.check) &&
            result.check.aborted === true
            ? ["resume", "reconcile", "audit", "cancel"]
            : undefined,
        )
    }
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
      await Promise.all(
        selected.map(async (node) => {
          try {
            await this.timed("step:dispatch", () => this.dispatch(plan!, node, fence))
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

  private async cancelWorkers(plan: PlanRow, fence: number, allowPlanSettlement = true) {
    const active = this.store.attempts(plan.id).filter(
      (attempt) =>
        ["preparing", "running", "verifying"].includes(attempt.state) ||
        (attempt.state === "unknown" &&
          this.store
            .attempts(plan.id)
            .filter((candidate) => candidate.task_id === attempt.task_id)
            .at(-1)?.id === attempt.id),
    )
    let waiting = false
    for (const attempt of active)
      if (await this.cancelAttemptWorker(plan, attempt, fence)) waiting = true
    if (!allowPlanSettlement || waiting) return
    this.settleCancelledPlan(plan, fence)
  }

  /** Stops one attempt's worker for a cancel. True while the attempt still has to be waited on. */
  private async cancelAttemptWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
  ): Promise<boolean> {
    let session = await this.host.session(attempt.session_id)
    if (!session) return !this.cancelMissingWorker(plan, attempt, fence)
    if (session.archived && !session.busy) {
      // An archived session can never run again: it counts as stopped.
      this.store.fenced(this.owner, fence, () =>
        this.store.recordOnce(plan.id, attempt.task_id, "CANCEL_WORKER_ARCHIVED", {
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace: attempt.workspace,
          retainedWorkPreserved: true,
        }),
      )
      return !this.settleCancelledAttempt(plan, attempt, fence, false)
    }
    const promptCompleted = this.store
      .effects(plan.id)
      .some(
        (effect) =>
          effect.attempt_id === attempt.id &&
          effect.kind === "prompt" &&
          JSON.parse(effect.payload).messageID === attempt.message_id &&
          effect.state === "completed",
      )
    this.observeUsage(attempt, session, fence)
    const backgroundReason = this.backgroundBlockReason(session)
    if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0)
      this.approvalWait(plan, attempt, session, fence)
    if (session.busy) {
      const busySession = session
      return this.cancelBusyWorker(plan, attempt, fence, () => {
        if (backgroundReason)
          this.backgroundWait(plan, attempt, busySession, backgroundReason, fence)
      })
    }
    const blocked = this.cancelBlock(session)
    if (blocked) return !this.cancelWait(plan, attempt, fence, blocked)
    if (backgroundReason) {
      this.backgroundWait(plan, attempt, session, backgroundReason, fence)
      return !this.cancelWait(plan, attempt, fence, { cause: "background-activity", bounded: true })
    }
    session = await this.host.session(attempt.session_id, { messages: true })
    if (!session) return !this.cancelMissingWorker(plan, attempt, fence)
    this.observeUsage(attempt, session, fence)
    if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0)
      this.approvalWait(plan, attempt, session, fence)
    if (session.busy) return this.cancelBusyWorker(plan, attempt, fence)
    const detailedBlocked = this.cancelBlock(session)
    if (detailedBlocked) return !this.cancelWait(plan, attempt, fence, detailedBlocked)
    const detailedBackgroundReason = this.backgroundBlockReason(session)
    if (detailedBackgroundReason) {
      this.backgroundWait(plan, attempt, session, detailedBackgroundReason, fence)
      return !this.cancelWait(plan, attempt, fence, { cause: "background-activity", bounded: true })
    }
    return this.settleStoppedWorker(plan, attempt, fence, session, promptCompleted)
  }

  /** A busy worker is interrupted; true (still waiting) unless the bounded wait already elapsed. */
  private async cancelBusyWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    whileWaiting?: () => void,
  ) {
    if (await this.interruptForCancel(plan, attempt, fence))
      return !this.settleCancelledAttempt(plan, attempt, fence, true)
    whileWaiting?.()
    return true
  }

  /** An idle worker: record its stop when its prompt ran, then settle the attempt as cancelled. */
  private settleStoppedWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    session: HostSession,
    promptCompleted: boolean,
  ) {
    if (
      promptCompleted &&
      (!session.turn ||
        !this.matchesWorkerInput(attempt, session.turn.inputID) ||
        (session.turn.state !== "completed" && session.turn.state !== "interrupted"))
    )
      return !this.cancelWait(plan, attempt, fence, {
        cause: "turn-input-mismatch",
        bounded: true,
        detail: {
          turnInputID: session.turn?.inputID ?? null,
          turnState: session.turn?.state ?? null,
        },
      })
    if (promptCompleted) {
      this.workerEvent(plan, attempt, "WORKER_STARTED", fence)
      this.workerEvent(
        plan,
        attempt,
        "WORKER_STOPPED",
        fence,
        session.outcome ?? "cancelled",
        session.turn?.inputID,
      )
    }
    return !this.settleCancelledAttempt(plan, attempt, fence, false)
  }

  /** Every attempt has settled: supersede stuck effects (after a bounded wait) and cancel the plan. */
  private settleCancelledPlan(plan: PlanRow, fence: number) {
    const stuck = this.store
      .effects(plan.id)
      .filter((effect) => ["intended", "uncertain"].includes(effect.state))
    if (stuck.length > 0) {
      if (
        !this.cancelWaitElapsed(plan, null, "plan", "unresolved-effect", fence, {
          effects: stuck.map((effect) => ({
            id: effect.id,
            kind: effect.kind,
            state: effect.state,
          })),
        })
      )
        return
      for (const effect of stuck)
        this.supersedeEffect(effect, "Plan cancelled: effect never resolved", fence)
    }
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'cancelled'),version=version+1 WHERE id=?",
        )
        .run(plan.id),
    )
    this.outcome(plan.id, { status: "cancelled" }, true)
  }

  /**
   * Interrupt a busy worker during cancellation. True once the bounded wait since
   * the first interrupt has elapsed: the host may keep listing the session active
   * with nothing to interrupt, and the worktree is being discarded anyway.
   */
  private async interruptForCancel(plan: PlanRow, attempt: AttemptRow, fence: number) {
    const prior = this.store.latestTransition<{ attemptID: string; sessionID: string; at: number }>(
      plan.id,
      attempt.task_id,
      "CANCEL_WORKER_INTERRUPTED",
    )
    const first = prior?.attemptID === attempt.id ? prior : undefined
    await this.host.interrupt(attempt.session_id)
    if (!first) {
      this.store.fenced(this.owner, fence, () =>
        this.store.record(plan.id, attempt.task_id, "CANCEL_WORKER_INTERRUPTED", {
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          at: this.now(),
        }),
      )
      return false
    }
    return this.now() - first.at >= this.cancelIdleWaitMs
  }

  /**
   * Whether the attempt's unresolved effects no longer block cancel. Effects left in
   * `intended` or `uncertain` get a bounded wait, then are superseded.
   */
  private resolveCancelEffects(plan: PlanRow, attempt: AttemptRow, fence: number): boolean {
    const stuck = this.store
      .effects(plan.id)
      .filter(
        (effect) =>
          effect.attempt_id === attempt.id && ["intended", "uncertain"].includes(effect.state),
      )
    if (stuck.length === 0) return true
    if (
      !this.cancelWaitElapsed(plan, attempt.task_id, attempt.id, "unresolved-effect", fence, {
        attemptID: attempt.id,
        effects: stuck.map((effect) => ({ id: effect.id, kind: effect.kind, state: effect.state })),
      })
    )
      return false
    for (const effect of stuck)
      this.supersedeEffect(effect, "Plan cancelled: effect never resolved", fence)
    return true
  }

  /** A cancel wait that only the user can end, or one bounded by `cancelIdleWaitMs`. */
  private cancelBlock(
    session: HostSession,
  ): { cause: string; bounded: boolean; detail?: Record<string, unknown> } | undefined {
    if (session.pendingInput) return { cause: "pending-input", bounded: false }
    if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0)
      return {
        cause: "pending-approval",
        bounded: false,
        detail: {
          pendingPermissions: session.pendingPermissions ?? 0,
          pendingForms: session.pendingForms ?? 0,
        },
      }
    if (session.observationUnstable) return { cause: "observation-unstable", bounded: true }
    return undefined
  }

  /**
   * Record why a cancel is waiting (once per cause). A bounded cause settles the
   * attempt after `cancelIdleWaitMs`; true means the attempt settled.
   */
  private cancelWait(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    wait: { cause: string; bounded: boolean; detail?: Record<string, unknown> },
  ): boolean {
    const payload = { attemptID: attempt.id, sessionID: attempt.session_id, ...wait.detail }
    if (!wait.bounded) {
      this.store.fenced(this.owner, fence, () =>
        this.store.recordOnce(plan.id, attempt.task_id, "CANCEL_WAIT", {
          scope: attempt.id,
          cause: wait.cause,
          ...payload,
        }),
      )
      return false
    }
    if (!this.cancelWaitElapsed(plan, attempt.task_id, attempt.id, wait.cause, fence, payload))
      return false
    return this.settleCancelledAttempt(plan, attempt, fence, true)
  }

  /** Records the cancel-wait cause once and reports whether the bounded wait since its start elapsed. */
  private cancelWaitElapsed(
    plan: PlanRow,
    taskID: string | null,
    scope: string,
    cause: string,
    fence: number,
    detail: Record<string, unknown>,
  ): boolean {
    this.store.fenced(this.owner, fence, () => {
      this.store.recordOnce(plan.id, taskID, "CANCEL_WAIT", { scope, cause, ...detail })
      const started = this.store.latestTransition<{ scope: string; at: number }>(
        plan.id,
        taskID,
        "CANCEL_WAIT_STARTED",
      )
      if (started?.scope !== scope)
        this.store.record(plan.id, taskID, "CANCEL_WAIT_STARTED", { scope, at: this.now() })
    })
    const started = this.store.latestTransition<{ scope: string; at: number }>(
      plan.id,
      taskID,
      "CANCEL_WAIT_STARTED",
    )
    return started !== undefined && this.now() - started.at >= this.cancelIdleWaitMs
  }

  /** Cancel the attempt and its node once its effects resolve or are superseded. The worktree is preserved. */
  private settleCancelledAttempt(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    workerNeverIdle: boolean,
  ): boolean {
    if (!this.resolveCancelEffects(plan, attempt, fence)) return false
    if (workerNeverIdle)
      this.store.fenced(this.owner, fence, () =>
        this.store.record(plan.id, attempt.task_id, "WORKER_CANCEL_WITHOUT_IDLE", {
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace: attempt.workspace,
          waitedMs: this.cancelIdleWaitMs,
          retainedWorkPreserved: true,
        }),
      )
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query(
          "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'cancelled') WHERE id=?",
        )
        .run(attempt.id),
    )
    const node = this.store
      .nodes(plan.id)
      .find((candidate) => candidate.task_id === attempt.task_id)!
    if (!terminal.has(node.state)) this.store.move(plan.id, node.task_id, "CANCEL")
    return true
  }

  private cancelMissingWorker(plan: PlanRow, attempt: AttemptRow, fence: number): boolean {
    if (!this.resolveCancelEffects(plan, attempt, fence)) return false
    return this.store.fenced(this.owner, fence, () => {
      const currentPlan = this.store.plan(plan.id)
      const current = this.store
        .attempts(plan.id)
        .filter((candidate) => candidate.task_id === attempt.task_id)
        .at(-1)
      if (
        !currentPlan ||
        currentPlan.state !== plan.state ||
        current?.id !== attempt.id ||
        current.session_id !== attempt.session_id ||
        !["preparing", "running", "verifying", "unknown"].includes(current.state) ||
        this.store
          .effects(plan.id)
          .some(
            (effect) =>
              effect.attempt_id === attempt.id && ["intended", "uncertain"].includes(effect.state),
          )
      )
        return false
      this.cancelReservedAttempt(plan, current, fence)
      this.store.record(plan.id, attempt.task_id, "WORKER_SESSION_ABSENT", {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        observedAt: this.now(),
        action: "cancel",
        retainedWorkPreserved: true,
      })
      return true
    })
  }

  private cancelReservedAttempt(plan: PlanRow, attempt: AttemptRow, fence: number) {
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query(
          "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'cancelled') WHERE id=?",
        )
        .run(attempt.id),
    )
    const node = this.store
      .nodes(plan.id)
      .find((candidate) => candidate.task_id === attempt.task_id)!
    if (!terminal.has(node.state)) this.store.move(plan.id, node.task_id, "CANCEL")
  }

  private workerEvent(
    plan: PlanRow,
    attempt: AttemptRow,
    event: "WORKER_STARTED" | "WORKER_STOPPED",
    fence: number,
    outcome?: HostSession["outcome"] | "cancelled",
    inputID?: string | null,
  ) {
    const previous = this.store.latestTransition<{
      attemptID?: string
      outcome?: HostSession["outcome"] | "cancelled"
      inputID?: string
    }>(plan.id, attempt.task_id, event)
    if (
      previous?.attemptID === attempt.id &&
      (event === "WORKER_STARTED" || (previous.outcome === outcome && previous.inputID === inputID))
    )
      return
    this.store.fenced(this.owner, fence, () =>
      this.store.record(plan.id, attempt.task_id, event, {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        observedAt: Date.now(),
        ...(outcome ? { outcome } : {}),
        ...(inputID ? { inputID } : {}),
      }),
    )
  }

  private matchesWorkerInput(attempt: AttemptRow, inputID: string | null | undefined): boolean {
    if (
      this.progress.matchesAssignedInput(
        attempt.id,
        attempt.session_id,
        attempt.message_id,
        inputID,
      )
    )
      return true
    if (!inputID) return false

    const plan = this.store.plan(attempt.plan_id)
    const latest = this.store
      .attempts(attempt.plan_id)
      .filter((candidate) => candidate.task_id === attempt.task_id)
      .at(-1)
    if (
      !plan ||
      !latest ||
      latest.id !== attempt.id ||
      latest.session_id !== attempt.session_id ||
      latest.workspace !== attempt.workspace ||
      latest.message_id !== attempt.message_id
    )
      return false

    const aliases = this.store.atomic((db) =>
      db
        .query<{ id: number; payload: string }, [string, string]>(
          `SELECT id,payload FROM runner_transitions
           WHERE plan_id=? AND task_id=? AND event='WORKER_REVIEW_INPUT_RECONCILED'
           ORDER BY id DESC`,
        )
        .all(attempt.plan_id, attempt.task_id),
    )
    for (const row of aliases) {
      let alias: ReturnType<typeof parseReviewInputAlias>
      try {
        alias = parseReviewInputAlias(JSON.parse(row.payload))
      } catch {
        alias = undefined
      }
      if (
        !alias ||
        !matchesReviewInputAlias(alias, {
          projectDirectory: this.directory,
          projectID: this.projectID,
          planID: attempt.plan_id,
          taskID: attempt.task_id,
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace: attempt.workspace,
          assignedMessageID: attempt.message_id,
          reviewInputID: inputID,
        })
      )
        continue
      return true
    }
    return false
  }

  private isPriorContinuationInput(attempt: AttemptRow, inputID: string | null | undefined) {
    if (!inputID) return false
    return this.store.activity(attempt.plan_id, attempt.task_id).some((entry) => {
      if (entry.event !== "ATTEMPT_RESUMED") return false
      try {
        const resumed = JSON.parse(entry.payload) as {
          attemptID?: unknown
          previousMessageID?: unknown
          interruptedInputID?: unknown
          terminalInputID?: unknown
        }
        return (
          resumed.attemptID === attempt.id &&
          (resumed.previousMessageID === inputID ||
            resumed.interruptedInputID === inputID ||
            resumed.terminalInputID === inputID)
        )
      } catch {
        return false
      }
    })
  }

  private async observeCleanupSession(attempt: AttemptRow): Promise<CleanupSessionObservation> {
    try {
      const session = await this.host.session(attempt.session_id, { messages: true })
      return session ? { kind: "observed", session } : { kind: "absent" }
    } catch (error) {
      return { kind: "unavailable", error }
    }
  }

  private classifyCleanupWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    observation: CleanupSessionObservation,
  ): CleanupWorkerClassification {
    const binding = {
      projectID: this.projectID,
      planID: plan.id,
      attemptID: attempt.id,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      assignedMessageID: attempt.message_id,
    }
    const stages: CleanupObservationCheck[] = []
    const fail = (stage: CleanupObservationStage, code: string) => {
      stages.push({ stage, status: "blocked", code })
      const index = cleanupObservationStages.indexOf(stage)
      for (const later of cleanupObservationStages.slice(index + 1))
        stages.push({ stage: later, status: "not-evaluated" })
      return { binding, firstBlocker: { stage, code }, stages }
    }
    const pass = (stage: CleanupObservationStage) => stages.push({ stage, status: "passed" })

    if (observation.kind === "unavailable") return fail("session-read", "read-unavailable")
    if (observation.kind === "absent") {
      // Current cleanup permits authoritative native absence, not a failed read.
      stages.push({ stage: "session-read", status: "passed", code: "session-absent" })
      for (const stage of cleanupObservationStages.slice(1))
        stages.push({ stage, status: "not-evaluated" })
      return { binding, firstBlocker: null, stages }
    }
    pass("session-read")

    const session = observation.session
    if (session.id !== attempt.session_id) return fail("session-id", "session-id-mismatch")
    pass("session-id")
    if (session.projectID !== this.projectID) return fail("project-id", "project-id-mismatch")
    pass("project-id")
    if (session.directory !== attempt.workspace) return fail("directory", "directory-mismatch")
    pass("directory")
    if (!isWorkerAgent(session.agent)) return fail("agent", "agent-mismatch")
    pass("agent")
    if (session.metadata?.lazersAttemptID !== attempt.id)
      return fail("attempt-id", "attempt-id-mismatch")
    pass("attempt-id")
    if (session.busy !== false) return fail("foreground", "foreground-busy")
    pass("foreground")
    if (session.pendingInput === true) return fail("pending-input", "pending-input")
    pass("pending-input")
    if (session.observationUnstable) return fail("observation-stability", "observation-unstable")
    pass("observation-stability")
    if ((session.pendingPermissions ?? 0) !== 0)
      return fail("pending-permissions", "pending-permissions")
    pass("pending-permissions")
    if ((session.pendingForms ?? 0) !== 0) return fail("pending-forms", "pending-forms")
    pass("pending-forms")
    if ((session.runningShells ?? 0) !== 0) return fail("running-shells", "running-shells")
    pass("running-shells")
    if ((session.activeChildren ?? 0) !== 0) return fail("active-children", "active-children")
    pass("active-children")
    return { binding, firstBlocker: null, stages }
  }

  private async cleanupAuditDiagnostics(
    plan: PlanRow,
  ): Promise<CleanupAuditDiagnostics | undefined> {
    if (plan.state !== "cleanup-blocked") return undefined
    const effects = this.store.effects(plan.id)
    let workspace: string | undefined
    for (const effect of [...effects].reverse()) {
      if (effect.kind !== "worktree-remove" || !["held", "uncertain"].includes(effect.state))
        continue
      try {
        const payload = JSON.parse(effect.payload) as { workspace?: unknown }
        if (typeof payload.workspace === "string") {
          workspace = payload.workspace
          break
        }
      } catch {
        // Malformed cleanup receipts cannot establish a worker binding.
      }
    }
    if (!workspace) return undefined
    const source = effects.find((effect) => {
      if (!["worktree", "worktree-recovery"].includes(effect.kind) || effect.state !== "completed")
        return false
      try {
        return JSON.parse(effect.receipt ?? "{}").workspace === workspace
      } catch {
        return false
      }
    })
    if (!source) return undefined
    const attempts = this.store
      .attempts(plan.id)
      .filter((attempt) => attempt.workspace === workspace)
    if (!attempts.length) return undefined

    const sampledAt = this.now()
    const workers: CleanupAuditDiagnostics["workers"] = []
    for (const attempt of attempts) {
      const observation = await this.observeCleanupSession(attempt)
      const workerSampledAt = this.now()
      const classification = this.classifyCleanupWorker(plan, attempt, observation)
      workers.push({
        ...classification,
        planVersion: plan.version,
        sampledAt: workerSampledAt,
      })
      // Cleanup stops at the first worker that is not conclusively quiescent.
      if (classification.firstBlocker) break
    }
    return {
      diagnosticOnly: true,
      planID: plan.id,
      planVersion: plan.version,
      sampledAt,
      workspace,
      workers,
    }
  }

  /**
   * Live idle check: a worker with a running shell in its worktree or an
   * active child session is not idle. The counts are read from the host at
   * observation time; there is no report to wait for.
   */
  backgroundBlockReason(session: HostSession): string | undefined {
    const shells = session.runningShells ?? 0
    const children = session.activeChildren ?? 0
    if (shells === 0 && children === 0) return undefined
    return `Worker has ${shells} running shell(s) and ${children} active child session(s)`
  }

  private approvalWait(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    fence: number,
    observation?: WorkerObservationFence,
  ) {
    const pendingPermissions = session.pendingPermissions ?? 0
    const pendingForms = session.pendingForms ?? 0
    return this.store.fenced(this.owner, fence, () => {
      if (observation && !this.workerObservationCurrent(observation)) return false
      const previous = this.store.latestTransition<{
        attemptID?: string
        pendingPermissions?: number
        pendingForms?: number
      }>(plan.id, attempt.task_id, "WORKER_APPROVAL_WAIT")
      if (
        previous?.attemptID === attempt.id &&
        previous.pendingPermissions === pendingPermissions &&
        previous.pendingForms === pendingForms
      )
        return false
      this.store.record(plan.id, attempt.task_id, "WORKER_APPROVAL_WAIT", {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        directory: session.directory,
        pendingPermissions,
        pendingForms,
        observedAt: Date.now(),
      })
      return true
    })
  }

  private holdApprovalObservation(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    observation: WorkerObservationFence,
    fence: number,
  ) {
    return this.store.fenced(this.owner, fence, () => {
      if (!this.workerObservationCurrent(observation)) return false
      this.approvalWait(plan, attempt, session, fence, observation)
      this.hold(
        plan,
        `Worker at ${session.directory} has ${session.pendingPermissions ?? 0} pending permission request(s) and ${session.pendingForms ?? 0} pending form(s)`,
        ["audit", "reconcile", "cancel"],
        undefined,
        observation,
      )
      return true
    })
  }

  private reconcileRequestID(planID: string) {
    return this.store.atomic(
      (db) =>
        db
          .query<{ id: number }, [string]>(
            `SELECT COALESCE(MAX(id),0) AS id FROM runner_transitions
             WHERE plan_id=? AND task_id IS NULL AND event='RECONCILE_REQUESTED'`,
          )
          .get(planID)!.id,
    )
  }

  private workerObservationFence(
    plan: PlanRow,
    attempt: AttemptRow,
  ): WorkerObservationFence | undefined {
    const currentPlan = this.store.plan(plan.id)
    const currentAttempt = this.store
      .attempts(plan.id)
      .filter((candidate) => candidate.task_id === attempt.task_id)
      .at(-1)
    const node = this.store
      .nodes(plan.id)
      .find((candidate) => candidate.task_id === attempt.task_id)
    if (
      !currentPlan ||
      currentPlan.version !== plan.version ||
      currentPlan.state !== plan.state ||
      !currentAttempt ||
      currentAttempt.id !== attempt.id ||
      currentAttempt.state !== attempt.state ||
      currentAttempt.session_id !== attempt.session_id ||
      currentAttempt.workspace !== attempt.workspace ||
      currentAttempt.message_id !== attempt.message_id ||
      currentAttempt.policy !== attempt.policy ||
      !node
    )
      return undefined
    return {
      planID: plan.id,
      planVersion: plan.version,
      planState: plan.state,
      owner: plan.owner,
      reconcileRequestID: this.reconcileRequestID(plan.id),
      taskID: attempt.task_id,
      attemptID: attempt.id,
      attemptState: attempt.state,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      messageID: attempt.message_id,
      policy: attempt.policy,
      nodeState: node.state,
      nodeVersion: node.version,
    }
  }

  private workerObservationCurrent(observation: WorkerObservationFence) {
    const plan = this.store.plan(observation.planID)
    const attempt = this.store
      .attempts(observation.planID)
      .filter((candidate) => candidate.task_id === observation.taskID)
      .at(-1)
    const node = this.store
      .nodes(observation.planID)
      .find((candidate) => candidate.task_id === observation.taskID)
    return Boolean(
      plan &&
      plan.version === observation.planVersion &&
      plan.state === observation.planState &&
      this.reconcileRequestID(observation.planID) === observation.reconcileRequestID &&
      attempt?.id === observation.attemptID &&
      attempt.state === observation.attemptState &&
      attempt.session_id === observation.sessionID &&
      attempt.workspace === observation.workspace &&
      attempt.message_id === observation.messageID &&
      attempt.policy === observation.policy &&
      node?.state === observation.nodeState &&
      node.version === observation.nodeVersion,
    )
  }

  private approvalWaitReason(reason: string | null | undefined) {
    return Boolean(
      reason?.startsWith("Worker at ") &&
      reason.includes("pending permission request(s)") &&
      reason.includes("pending form(s)"),
    )
  }

  private conclusiveApprovalClear(attempt: AttemptRow, session: HostSession) {
    if (
      session.id !== attempt.session_id ||
      session.projectID !== this.projectID ||
      session.directory !== attempt.workspace ||
      !isWorkerAgent(session.agent) ||
      session.archived ||
      session.metadata?.lazersAttemptID !== attempt.id ||
      session.pendingInput !== false ||
      session.pendingPermissions !== 0 ||
      session.pendingForms !== 0 ||
      session.observationUnstable ||
      !session.turn ||
      !this.matchesWorkerInput(attempt, session.turn.inputID)
    )
      return false
    try {
      const policy = ModelPolicy.safeParse(JSON.parse(attempt.policy).model)
      return policy.success && this.sameModel(session.model, policy.data)
    } catch {
      return false
    }
  }

  private resumeTransientObservationWait(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    observation: WorkerObservationFence,
    fence: number,
    allowNonterminal = false,
  ) {
    const current = this.store.plan(plan.id)
    const reason = current?.reason
    const observationReason = reason?.replace(/^Worker execution (?:failed|completed); /, "")
    // Legacy holds named the retired experimental.idle report; they clear the same way.
    const backgroundWait =
      observationReason?.startsWith("Native idle background observation") ||
      /^Worker has \d+ known background job\(s\)/.test(observationReason ?? "") ||
      /^Worker has \d+ running shell\(s\) and \d+ active child session\(s\)/.test(
        observationReason ?? "",
      )
    const approvalWait = this.approvalWaitReason(reason)
    if (current?.state !== "blocked" || !reason || (!backgroundWait && !approvalWait)) return
    if (approvalWait && !this.conclusiveApprovalClear(attempt, session)) return false
    if (
      allowNonterminal
        ? !approvalWait || session.outcome !== undefined
        : session.busy || session.pendingInput || session.observationUnstable || !session.outcome
    )
      return false
    return this.store.fenced(this.owner, fence, (db) => {
      if (!this.workerObservationCurrent(observation)) return false
      const current = db
        .query<{ state: string; reason: string | null; version: number; owner: string }, [string]>(
          "SELECT state,reason,version,owner FROM runner_plans WHERE id=?",
        )
        .get(plan.id)
      if (
        current?.state !== "blocked" ||
        current.reason !== reason ||
        current.version !== observation.planVersion
      )
        return false
      const changed =
        db
          .query(
            "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason=? AND version=? AND owner=?",
          )
          .run(plan.id, reason, observation.planVersion, observation.owner).changes === 1
      if (changed)
        this.store.record(plan.id, null, "WORKER_OBSERVATION_SETTLED", {
          previousReason: reason,
          observation: approvalWait ? "worker-approvals" : "live-idle-check",
        })
      return changed
    })
  }

  private backgroundWait(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    reason: string,
    fence: number,
  ) {
    const background = {
      runningShells: session.runningShells ?? 0,
      activeChildren: session.activeChildren ?? 0,
    }
    const previous = this.store.latestTransition<{
      attemptID?: string
      background?: typeof background
    }>(plan.id, attempt.task_id, "WORKER_BACKGROUND_WAIT")
    if (
      previous?.attemptID === attempt.id &&
      JSON.stringify(previous.background) === JSON.stringify(background)
    )
      return
    this.store.fenced(this.owner, fence, () =>
      this.store.record(plan.id, attempt.task_id, "WORKER_BACKGROUND_WAIT", {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        reason,
        background,
      }),
    )
  }

  private async dependencySource(plan: PlanRow, input: PlanInput, node: NodeRow): Promise<string> {
    const prerequisites = this.taskDependencyIDs(input, node)
    if (!prerequisites.length) return input.baseCommit
    const proof = await this.taskDependencyIntegration(plan, input, node)
    if (proof.status !== "ready") throw new Error(proof.reason)
    return proof.baseline
  }

  private taskDependencyIDs(input: PlanInput, node: NodeRow): string[] {
    const dependencies = new Map<string, string[]>()
    for (const edge of input.dependencies) {
      const prerequisites = dependencies.get(edge.successor) ?? []
      prerequisites.push(edge.prerequisite)
      dependencies.set(edge.successor, prerequisites)
    }
    const ancestors = new Set<string>()
    const visit = (taskID: string) => {
      for (const prerequisite of dependencies.get(taskID) ?? []) {
        if (ancestors.has(prerequisite)) continue
        ancestors.add(prerequisite)
        visit(prerequisite)
      }
    }
    visit(node.task_id)
    const order = new Map(input.integrationOrder.map((taskID, index) => [taskID, index]))
    return [...ancestors].toSorted(
      (left, right) =>
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right) ?? Number.MAX_SAFE_INTEGER),
    )
  }

  /** Stored change identity for an artifact SHA, so proof survives a rewritten history. */
  private artifactEvidence: ArtifactEvidenceLookup = (artifact) =>
    this.store.repository.read((db) => storedEvidence(db, { artifact }))

  private async taskDependencyIntegration(
    plan: PlanRow,
    input: PlanInput,
    node: NodeRow,
    candidateBaseline?: string,
    capturedRows?: readonly TaskPrerequisiteIntegrationRow[],
    capturedBranch?: string,
  ): Promise<IntegrationDecision> {
    const prerequisites = this.taskDependencyIDs(input, node)
    if (!prerequisites.length)
      return {
        status: "ready",
        baseline: candidateBaseline ?? input.baseCommit,
      }
    let branch: string
    try {
      branch = capturedBranch ?? (await gitAsync(this.directory, ["branch", "--show-current"]))
    } catch {
      return { status: "unknown", reason: "The integrated source branch could not be read." }
    }
    if (!branch)
      return { status: "waiting", reason: "Task source integration requires the reviewed branch." }
    const rows = capturedRows
      ? capturedRows.filter((row) => row.plan_id === plan.id && prerequisites.includes(row.task_id))
      : this.store.taskPrerequisiteIntegrationRows(plan.id, prerequisites)
    return evaluateTaskPrerequisiteIntegration(
      this.directory,
      branch,
      prerequisites,
      rows,
      gitAsync,
      candidateBaseline,
      this.artifactEvidence,
    )
  }

  private async integratedPrerequisiteBaseline(
    prerequisites: string[],
    candidateBaseline?: string,
  ): Promise<string | undefined> {
    if (!prerequisites.length || new Set(prerequisites).size !== prerequisites.length)
      return undefined

    const rows = this.store.atomic((db) => {
      const result: PrerequisiteIntegrationRow[] = []
      // Bound each query to one hundred plans while reading the latest acceptance
      // and combined-integration transitions from one SQLite snapshot.
      for (let offset = 0; offset < prerequisites.length; offset += 100) {
        const batch = prerequisites.slice(offset, offset + 100)
        const placeholders = batch.map(() => "?").join(",")
        result.push(
          ...db
            .query<PrerequisiteIntegrationRow, string[]>(
              `SELECT p.id AS plan_id,p.project_directory,p.state,p.artifact,
                      accepted.id AS accepted_id,accepted.version AS accepted_version,
                      accepted.payload AS accepted_payload,
                      integration.id AS integration_id,integration.version AS integration_version,
                      integration.payload AS integration_payload,
                      -- Lifecycle labels can be stale; a cancellation invalidates
                      -- older acceptance until a new acceptance/integration pair.
                      (SELECT t.id FROM runner_transitions t
                       WHERE t.plan_id=p.id AND t.task_id IS NULL AND t.event='CANCEL_REQUESTED'
                       ORDER BY t.id DESC LIMIT 1) AS invalidation_id
               FROM runner_plans p
               LEFT JOIN runner_transitions accepted
                 ON accepted.id=(
                   SELECT t.id FROM runner_transitions t
                   WHERE t.plan_id=p.id AND t.task_id IS NULL AND t.event='PLAN_ACCEPTED'
                   ORDER BY t.id DESC LIMIT 1
                 )
               LEFT JOIN runner_transitions integration
                 ON integration.id=(
                   SELECT t.id FROM runner_transitions t
                   WHERE t.plan_id=p.id AND t.task_id IS NULL AND t.event='INTEGRATION_RECORDED'
                   ORDER BY t.id DESC LIMIT 1
                 )
               WHERE p.project_directory=? AND p.id IN (${placeholders})
               ORDER BY p.id`,
            )
            .all(this.directory, ...batch),
        )
      }
      return result
    })
    return evaluatePrerequisiteIntegration(
      this.directory,
      prerequisites,
      rows,
      gitAsync,
      candidateBaseline,
      this.artifactEvidence,
    )
  }

  private async dispatch(plan: PlanRow, node: NodeRow, fence: number) {
    // Work queued before the project had a config (or before this rule) must not dead-end: the
    // plan's Architect gets the same actionable refusal through the hold path, and the tick
    // releases the hold once a config exists.
    const refused =
      !this.fallowReviewEnabled || hasStoredFallowConfig(this.store.repository)
        ? undefined
        : await this.fallowGate()
    if (refused) {
      this.hold(plan, `FALLOW_CONFIG_REQUIRED: ${refused.missing} ${refused.guidance}`)
      return
    }
    const task = this.store.repository.get(node.task_id)!
    const attempts = this.store.attempts(plan.id).filter((a) => a.task_id === task.id)
    const first = attempts[0]
    const audit = this.store.exactContentConflicts([task.id])
    if (audit.findings.length) {
      this.hold(plan, "Overlap audit changed before dispatch")
      return
    }
    const input = PlanInput.parse(JSON.parse(plan.body))
    if (JSON.parse(plan.body).workspaceMode === undefined && attempts.length)
      input.workspaceMode = attempts.at(-1)!.workspace === this.directory ? "shared" : "isolated"
    const persona = input.nodes.find((candidate) => candidate.taskID === task.id)?.persona
    const configuredImplementor = input.workerModel
      ? null
      : persona
        ? ((await this.host.workerModel?.(workerAgent(input.workerAgent))) ?? null)
        : plan.model
          ? ModelPolicy.parse(JSON.parse(plan.model))
          : null
    const routeDecision =
      persona && input.workerAgent !== "auditor"
        ? this.resolveTaskDispatchRoute(input, task.id, persona, configuredImplementor)
        : undefined
    if (routeDecision?.status === "unavailable") {
      this.hold(plan, `No native worker route is available for the ${persona} persona`)
      return
    }
    const model =
      routeDecision?.status === "resolved"
        ? routeDecision.route
        : plan.model
          ? ModelPolicy.parse(JSON.parse(plan.model))
          : null
    if (!model) {
      this.hold(plan, "Select an implementor model in native OpenCode agent configuration")
      return
    }
    const id = crypto.randomUUID()
    // Isolated work inherits its dependency artifacts. A new shared node
    // starts at the actual reviewed checkout, so intervening integrated repairs
    // are input, not attributed to that worker's write scope.
    const retryRequest = this.store.latestTransition<{
      attemptID?: string
      selectedBaseline?: string | null
    }>(plan.id, task.id, "RETRY_REQUESTED")
    const selectedBaseline =
      retryRequest && retryRequest.attemptID === attempts.at(-1)?.id
        ? retryRequest.selectedBaseline
        : null
    const previousBase = selectedBaseline ?? attempts.at(-1)?.artifact ?? undefined
    const taskPrerequisites = this.taskDependencyIDs(input, node)
    const base =
      previousBase ??
      (input.workspaceMode === "shared" && !taskPrerequisites.length
        ? await gitAsync(this.directory, ["rev-parse", "HEAD"])
        : await this.dependencySource(plan, input, node))
    if (taskPrerequisites.length) {
      const proof = await this.taskDependencyIntegration(plan, input, node, base)
      if (proof.status !== "ready") throw new Error(proof.reason)
      if (proof.baseline !== base)
        throw new Error("The prerequisite baseline changed before dispatch")
    }
    const workspace =
      input.workspaceMode === "shared"
        ? this.directory
        : canonicalProjectWorktreePath(this.directory, id)
    const text = JSON.stringify({
      taskID: task.id,
      revision: task.revision,
      specification: task.proposal,
      source: base,
      previousAttempt: first
        ? { id: attempts.at(-1)!.id, evidence: this.store.detail(plan.id).evidence }
        : null,
    })
    const policy = {
      agent: workerAgent(input.workerAgent),
      workspaceMode: input.workspaceMode,
      model,
      ...(routeDecision ? { routeDecision } : {}),
      ...(persona ? { persona } : {}),
      source: base,
      context: text,
      packet: {
        recipe: "task-tool/1",
        taskID: task.id,
        tool: "lz-get-task",
      },
      budget: null,
      repairAttempt: this.store.atomic(
        (db) =>
          db
            .query<{ event: string }, [string, string]>(
              "SELECT event FROM runner_transitions WHERE plan_id=? AND task_id=? ORDER BY id DESC LIMIT 1",
            )
            .get(plan.id, task.id)?.event === "REPAIR",
      ),
      toolPolicy: "inherit host/user/project; delegation forbidden",
      costEstimate: { status: "unavailable", currency: "USD", kind: "equivalent-api" },
    }
    let attempt!: AttemptRow
    const admitted = this.store.fenced(this.owner, fence, (db) => {
      const current = this.store.plan(plan.id)
      const currentNode = this.store
        .nodes(plan.id)
        .find((candidate) => candidate.task_id === node.task_id)
      if (
        !current ||
        current.state !== "running" ||
        this.store.effectiveDispatchPause(plan.id) !== undefined ||
        current.revision !== plan.revision ||
        current.body !== plan.body ||
        currentNode?.state !== node.state
      )
        return false
      if (
        this.store
          .activeAdoptions()
          .some((adoption) =>
            scopePatternsConflict(
              this.store.effectiveReservationScope(task.id),
              this.store.effectiveReservationScope(adoption.task_id),
            ),
          )
      )
        throw new Error("A pending descendant adoption reserves this task's scope")
      if (node.state === "queued") this.store.move(plan.id, task.id, "READY")
      this.store.move(plan.id, task.id, "DISPATCH")
      db.query(
        "INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at) VALUES(?,?,?,?,?,?,?,?,?,'preparing',?)",
      ).run(
        id,
        plan.id,
        task.id,
        attempts.length + 1,
        sessionID(),
        messageID(),
        workspace,
        base,
        JSON.stringify(policy),
        Date.now(),
      )
      attempt = this.store.attempts(plan.id).find((a) => a.id === id)!
      return true
    })
    if (!admitted) return
    const admissionPlan = this.store.plan(plan.id)!
    const admissionOwner = admissionPlan.owner
    this.store.record(plan.id, task.id, "CONTEXT_RESOLVED", {
      attemptID: id,
      packet: policy.packet,
      ...(persona ? { persona } : {}),
    })
    if (input.workspaceMode === "shared") {
      const current = this.store.plan(plan.id)
      if (current?.state !== "running" || current.owner !== admissionOwner) return
      await this.prepareWorker(plan, attempt, fence)
      return
    }
    const effect = this.effect(plan.id, task.id, id, "worktree", { workspace, base }, fence)
    try {
      const actual = await this.host.worktree({ directory: workspace, base })
      if ((await gitAsync(actual, ["rev-parse", "HEAD"])) !== base)
        throw new Error("Host worktree did not use the admitted starting revision")
      this.store.fenced(this.owner, fence, (db) =>
        db.query("UPDATE runner_attempts SET workspace=? WHERE id=?").run(actual, id),
      )
      attempt.workspace = actual
      this.receipt(effect, { workspace: actual, base }, fence)
    } catch (error) {
      this.uncertain(effect, error, fence)
      return
    }
    const current = this.store.plan(plan.id)
    if (current?.state !== "running" || current.owner !== admissionOwner) return
    await this.prepareWorker(plan, attempt, fence)
  }
  /** Resumes must obey the same checkout/scope admission as fresh dispatch. */
  private preparationAllowed(attempt: AttemptRow) {
    const scope = this.store.effectiveReservationScope(attempt.task_id)
    if (
      this.store
        .activeAdoptions()
        .some(
          (adoption) =>
            attempt.workspace === this.directory ||
            scopePatternsConflict(scope, this.store.effectiveReservationScope(adoption.task_id)),
        )
    )
      return false
    for (const other of this.store.activeProjectAttempts()) {
      if (other.id === attempt.id || !["preparing", "running", "verifying"].includes(other.state))
        continue
      const promptIntended = this.store
        .effects(other.plan_id)
        .some(
          (effect) =>
            effect.attempt_id === other.id &&
            effect.kind === "prompt" &&
            JSON.parse(effect.payload).messageID === other.message_id &&
            effect.state !== "failed",
        )
      // Stable priority prevents two unsent, conflicting reservations waiting
      // on each other. A prompt that may already be admitted always wins.
      if (
        other.state === "preparing" &&
        !promptIntended &&
        (other.started_at > attempt.started_at ||
          (other.started_at === attempt.started_at && other.id > attempt.id))
      )
        continue
      if (
        attempt.workspace === this.directory ||
        other.workspace === this.directory ||
        scopePatternsConflict(scope, this.store.effectiveReservationScope(other.task_id))
      )
        return false
    }
    return true
  }

  private async promptAdmissionAllowed(planID: string, attempt: AttemptRow) {
    const plan = this.store.plan(planID)
    const currentAttempt = this.store
      .attempts(planID)
      .find((candidate) => candidate.id === attempt.id)
    if (
      plan?.state !== "running" ||
      currentAttempt?.state !== "preparing" ||
      !this.preparationAllowed(currentAttempt)
    )
      return false
    const recovery = this.startupRecoveryAuthorization(plan, currentAttempt)
    if (recovery && !this.startupRecoveryAuthorityCurrent(plan, currentAttempt, recovery))
      return false

    const input = PlanInput.parse(JSON.parse(plan.body))
    const taskNode = this.store
      .nodes(planID)
      .find((node) => node.task_id === currentAttempt.task_id)
    if (!taskNode) return false
    const taskPrerequisites = this.taskDependencyIDs(input, taskNode)
    if (taskPrerequisites.length) {
      const proof = await this.taskDependencyIntegration(
        plan,
        input,
        taskNode,
        currentAttempt.base_commit,
      )
      if (proof.status !== "ready" || proof.baseline !== currentAttempt.base_commit) return false
      try {
        const treeHead = await gitAsync(currentAttempt.workspace, ["rev-parse", "HEAD"])
        if (!isCommitID(treeHead) || !isCommitID(currentAttempt.base_commit)) return false
        await gitAsync(currentAttempt.workspace, [
          "merge-base",
          "--is-ancestor",
          currentAttempt.base_commit,
          treeHead,
        ])
        const taskChanges = await changedPaths(currentAttempt.workspace, currentAttempt.base_commit)
        const inputLineage = new Set([currentAttempt.message_id])
        let inputID = currentAttempt.message_id
        const resumes = this.store.atomic((db) =>
          db
            .query<{ payload: string }, [string, string]>(
              `SELECT payload FROM runner_transitions
               WHERE plan_id=? AND task_id=? AND event='ATTEMPT_RESUMED' ORDER BY id DESC`,
            )
            .all(planID, currentAttempt.task_id),
        )
        for (const { payload } of resumes) {
          const resume = JSON.parse(payload) as {
            attemptID?: unknown
            messageID?: unknown
            previousMessageID?: unknown
          }
          if (resume.attemptID !== currentAttempt.id || resume.messageID !== inputID) continue
          if (
            typeof resume.previousMessageID !== "string" ||
            inputLineage.has(resume.previousMessageID)
          )
            break
          inputID = resume.previousMessageID
          inputLineage.add(inputID)
        }
        const admittedPrompt = this.store.effects(planID).some((effect) => {
          if (
            effect.attempt_id !== currentAttempt.id ||
            effect.kind !== "prompt" ||
            effect.state !== "completed"
          )
            return false
          const payload = JSON.parse(effect.payload) as {
            sessionID?: unknown
            workspace?: unknown
            messageID?: unknown
          }
          return (
            payload.sessionID === currentAttempt.session_id &&
            payload.workspace === currentAttempt.workspace &&
            typeof payload.messageID === "string" &&
            inputLineage.has(payload.messageID)
          )
        })
        if ((treeHead !== currentAttempt.base_commit || taskChanges.length > 0) && !admittedPrompt)
          return false
        if (
          protectedPaths(taskChanges, this.store.effectiveScope(currentAttempt.task_id)).length >
            0 ||
          (await gitAsync(currentAttempt.workspace, ["ls-files", "-u", "-z"]))
        )
          return false
      } catch {
        return false
      }
    }

    const prerequisites = input.afterPlans ?? []
    if (!prerequisites.length) return true

    try {
      // The reservation base is immutable prerequisite proof. A later HEAD is
      // acceptable only as scoped progress from a prompt already admitted to this attempt.
      const baseline = currentAttempt.base_commit
      const head = await gitAsync(currentAttempt.workspace, ["rev-parse", "HEAD"])
      if (!isCommitID(baseline) || !isCommitID(head)) return false
      const retainedPrompt = this.store.effects(planID).some((effect) => {
        if (
          effect.attempt_id !== currentAttempt.id ||
          effect.kind !== "prompt" ||
          effect.state !== "completed"
        )
          return false
        const payload = JSON.parse(effect.payload) as {
          sessionID?: unknown
          workspace?: unknown
          messageID?: unknown
        }
        return (
          payload.sessionID === currentAttempt.session_id &&
          payload.workspace === currentAttempt.workspace &&
          typeof payload.messageID === "string"
        )
      })
      const changed = await changedPaths(currentAttempt.workspace, baseline)
      if ((head !== baseline || changed.length > 0) && !retainedPrompt) return false
      await gitAsync(currentAttempt.workspace, ["merge-base", "--is-ancestor", baseline, head])
      if (await gitAsync(currentAttempt.workspace, ["ls-files", "-u", "-z"])) return false
      if (protectedPaths(changed, this.store.effectiveScope(currentAttempt.task_id)).length)
        return false
      return (await this.integratedPrerequisiteBaseline(prerequisites, baseline)) === baseline
    } catch {
      return false
    }
  }

  private observeUsage(attempt: AttemptRow, session: HostSession, fence: number) {
    if (session.staleActive)
      this.store.fenced(this.owner, fence, () =>
        this.store.recordOnce(attempt.plan_id, attempt.task_id, "HOST_ACTIVE_STALE", {
          attemptID: attempt.id,
          sessionID: session.id,
          cause: session.staleActive!.cause,
        }),
      )
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query(
          `UPDATE runner_attempts SET
          token_count=CASE WHEN ? IS NULL THEN token_count ELSE MAX(COALESCE(token_count,?),?) END,
          cost=CASE WHEN ? IS NULL THEN cost ELSE MAX(COALESCE(cost,?),?) END,
          tool_count=MAX(tool_count,?) WHERE id=?`,
        )
        .run(
          session.tokens,
          session.tokens,
          session.tokens,
          session.cost,
          session.cost,
          session.cost,
          session.tools,
          attempt.id,
        ),
    )
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
  private static readonly staleAttemptWindowMs = 60_000
  private readonly staleAttemptProbes = new Map<string, { since: number; probed: number }>()
  private async settleStaleAttempts(fence: number) {
    for (const attempt of this.store.activeProjectAttempts()) {
      const plan = this.store.plan(attempt.plan_id)
      if (!plan) continue
      const latest = this.store
        .attempts(plan.id)
        .filter((item) => item.task_id === attempt.task_id)
        .at(-1)
      if (latest?.id !== attempt.id) continue
      // The Architect is finishing this task itself. Its attempt has no native session, so absence
      // says nothing about it: only accept, a plan cancellation, or the abandonment hold ends it.
      if (isTakeoverAttempt(attempt.policy)) continue
      if (
        this.store
          .effects(plan.id)
          .some(
            (effect) =>
              effect.attempt_id === attempt.id && ["intended", "uncertain"].includes(effect.state),
          )
      )
        continue
      const node = this.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)
      let target: "accepted" | "failed" | "cancelled" | undefined
      let cause: string
      if (node && ["accepted", "incorporated"].includes(node.state)) {
        if (!["running", "verifying"].includes(attempt.state)) continue
        target = "accepted"
        cause = "node-already-accepted"
      } else if (
        ["running", "verifying"].includes(attempt.state) &&
        ["blocked", "cancelled", "failed", "exhausted"].includes(plan.state)
      ) {
        // Give the ordinary worker observation time to settle the attempt first, then probe the
        // host at most once per window so a held plan costs no extra read on every tick.
        const now = this.now()
        const seen = this.staleAttemptProbes.get(attempt.id)
        if (seen === undefined) this.staleAttemptProbes.set(attempt.id, { since: now, probed: now })
        if (seen === undefined || now - seen.probed < TaskRuntime.staleAttemptWindowMs) continue
        seen.probed = now
        const session = attempt.session_id ? await this.host.session(attempt.session_id) : null
        if (
          session &&
          (!session.archived ||
            session.busy ||
            session.pendingInput ||
            (session.pendingPermissions ?? 0) > 0 ||
            (session.pendingForms ?? 0) > 0 ||
            session.observationUnstable ||
            (session.runningShells ?? 0) > 0 ||
            (session.activeChildren ?? 0) > 0)
        )
          continue
        target = plan.state === "blocked" ? "failed" : "cancelled"
        cause = session ? "session-archived-and-quiet" : "session-absent"
      } else continue
      this.store.fenced(this.owner, fence, (db) => {
        if (this.store.plan(plan.id)?.version !== plan.version) return
        const changed = db
          .query(
            `UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,?),artifact=COALESCE(artifact,?)
             WHERE id=? AND state=?`,
          )
          .run(target!, node?.artifact ?? null, attempt.id, attempt.state).changes
        if (changed !== 1) return
        this.store.record(plan.id, attempt.task_id, "ATTEMPT_STALE_SETTLED", {
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace: attempt.workspace,
          from: attempt.state,
          to: target,
          planState: plan.state,
          nodeState: node?.state ?? null,
          cause,
        })
      })
    }
  }

  private failMissingWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    observation?: WorkerObservationFence,
  ) {
    this.store.fenced(this.owner, fence, () => {
      if (observation && !this.workerObservationCurrent(observation)) return
      const currentPlan = this.store.plan(plan.id)
      const latest = this.store
        .attempts(plan.id)
        .filter((item) => item.task_id === attempt.task_id)
        .at(-1)
      const node = this.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)
      if (
        !currentPlan ||
        !["running", "blocked"].includes(currentPlan.state) ||
        latest?.id !== attempt.id ||
        latest.message_id !== attempt.message_id ||
        latest.state !== attempt.state ||
        node?.state !== attempt.state ||
        this.store
          .effects(plan.id)
          .some(
            (effect) =>
              effect.attempt_id === attempt.id && ["intended", "uncertain"].includes(effect.state),
          )
      )
        return
      this.failAttempt(currentPlan, latest, "Owned worker session definitively missing")
      this.store.record(plan.id, attempt.task_id, "WORKER_SESSION_ABSENT", {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        observedAt: this.now(),
        action: "fail",
        retainedWorkPreserved: true,
      })
    })
  }

  /**
   * A turn that streams nothing for the whole window is stuck: interrupt it once
   * so the ordinary interrupted-worker path (auto-resume, hold) takes over.
   * Background shells and child sessions count as progress.
   */
  private async interruptStalledWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    fence: number,
  ) {
    if (this.workerNoProgressWindowMs <= 0) return
    const fingerprint = JSON.stringify([
      session.tokens,
      session.activityAt,
      session.idleAt,
      session.runningShells ?? 0,
      session.activeChildren ?? 0,
    ])
    const now = this.now()
    const seen = this.workerProgress.get(session.id)
    if (
      !seen ||
      seen.fingerprint !== fingerprint ||
      (session.runningShells ?? 0) > 0 ||
      (session.activeChildren ?? 0) > 0
    ) {
      this.workerProgress.set(session.id, { fingerprint, since: now })
      return
    }
    if (now - seen.since < this.workerNoProgressWindowMs) return
    const payload = {
      attemptID: attempt.id,
      sessionID: session.id,
      activityAt: session.activityAt ?? null,
      windowMs: this.workerNoProgressWindowMs,
    }
    const prior = this.store.latestTransition<typeof payload>(
      plan.id,
      attempt.task_id,
      "WORKER_NO_PROGRESS_INTERRUPT",
    )
    if (prior && JSON.stringify(prior) === JSON.stringify(payload)) return
    await this.host.interrupt(session.id)
    this.store.fenced(this.owner, fence, () =>
      this.store.record(plan.id, attempt.task_id, "WORKER_NO_PROGRESS_INTERRUPT", payload),
    )
  }

  private async advanceAttempt(plan: PlanRow, attempt: AttemptRow, fence: number) {
    if (attempt.state === "preparing") {
      await this.prepareWorker(plan, attempt, fence)
      return
    }
    if (!new Set(["running", "blocked"]).has(plan.state)) return
    const observation = this.workerObservationFence(plan, attempt)
    if (!observation) return
    const session = await this.observeAdvancedSession(plan, attempt, fence, observation)
    if (!session) return
    const ctx: AdvanceContext = { plan, attempt, fence, observation, session }
    if (await this.holdWorkerWaits(ctx)) return
    if (await this.settleIdleWorker(ctx)) return
    await this.finishWorkerTurn(ctx)
  }

  /** The worker's session as the runtime now sees it, or undefined when the pass should stop. */
  private async observeAdvancedSession(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    observation: WorkerObservationFence,
  ): Promise<HostSession | undefined> {
    let session = await this.host.session(attempt.session_id)
    if (session) this.observeUsage(attempt, session, fence)
    if (!this.workerObservationCurrent(observation)) return undefined
    if (!session) {
      this.failMissingWorker(plan, attempt, fence, observation)
      return undefined
    }
    if (
      plan.state === "blocked" &&
      this.approvalWaitReason(plan.reason) &&
      session.pendingPermissions === 0 &&
      session.pendingForms === 0 &&
      session.pendingInput === false &&
      !session.observationUnstable &&
      session.outcome === undefined
    ) {
      const detailed = await this.host.session(attempt.session_id, { messages: true })
      if (detailed) this.observeUsage(attempt, detailed, fence)
      if (!this.workerObservationCurrent(observation)) return undefined
      if (!detailed) return undefined
      session = detailed
    }
    return session
  }

  /** The turn belongs to an earlier continuation input, not the one this attempt is waiting on. */
  private staleContinuationTurn(attempt: AttemptRow, session: HostSession) {
    return Boolean(
      session.turn &&
      !this.matchesWorkerInput(attempt, session.turn.inputID) &&
      this.isPriorContinuationInput(attempt, session.turn.inputID),
    )
  }

  /** The plan is already held on this exact terminal worker observation. */
  private terminalHoldUnchanged(plan: PlanRow, attempt: AttemptRow, session: HostSession) {
    const previousHold = this.store.latestTransition<{ workerObservation?: TerminalWorkerHold }>(
      plan.id,
      null,
      "BLOCKED",
    )?.workerObservation
    const unchanged =
      (session.outcome === "failed" || session.outcome === "succeeded") &&
      (session.outcome === "succeeded" ||
        (typeof session.idleAt === "number" && Number.isFinite(session.idleAt))) &&
      previousHold?.kind === "terminal-worker-observation" &&
      previousHold.attemptID === attempt.id &&
      previousHold.sessionID === session.id &&
      previousHold.workspace === attempt.workspace &&
      previousHold.outcome === session.outcome &&
      previousHold.idleAt === session.idleAt &&
      (!session.turn ||
        (previousHold.inputID === session.turn.inputID &&
          previousHold.turnState === session.turn.state))
    return { previousHold, unchanged }
  }

  /** Holds the plan while the worker waits on approvals, input or background work. True when held. */
  private async holdWorkerWaits(ctx: AdvanceContext): Promise<boolean> {
    const { plan, attempt, fence, observation, session } = ctx
    if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0) {
      this.holdApprovalObservation(plan, attempt, session, observation, fence)
      return true
    }
    if (
      plan.state === "blocked" &&
      this.approvalWaitReason(plan.reason) &&
      session.outcome === undefined
    ) {
      this.resumeTransientObservationWait(plan, attempt, session, observation, fence, true)
      return true
    }
    if (this.staleContinuationTurn(attempt, session)) return true
    if (session.busy) await this.interruptStalledWorker(plan, attempt, session, fence)
    else this.workerProgress.delete(session.id)
    const backgroundReason = this.backgroundBlockReason(session)
    const { previousHold, unchanged } = this.terminalHoldUnchanged(plan, attempt, session)
    if (
      !session.busy &&
      !session.pendingInput &&
      !session.observationUnstable &&
      backgroundReason &&
      session.outcome !== "interrupted" &&
      ((session.outcome !== "failed" && session.outcome !== "succeeded") ||
        unchanged ||
        session.archived ||
        session.outcome === "succeeded")
    ) {
      this.hold(
        plan,
        backgroundReason,
        ["audit", "reconcile", "cancel"],
        unchanged ? previousHold : undefined,
        observation,
      )
      this.backgroundWait(plan, attempt, session, backgroundReason, fence)
      return true
    }
    return false
  }

  /**
   * An idle worker with an outcome is read again with its messages before the outcome is trusted.
   * True when the pass is settled (held, failed or still unstable); false to go on to the outcome.
   */
  private async settleIdleWorker(ctx: AdvanceContext): Promise<boolean> {
    const { plan, attempt, fence, observation } = ctx
    if (
      !ctx.session.busy &&
      !ctx.session.pendingInput &&
      !ctx.session.observationUnstable &&
      ctx.session.outcome
    ) {
      const detailed = await this.host.session(attempt.session_id, { messages: true })
      if (detailed) this.observeUsage(attempt, detailed, fence)
      if (!this.workerObservationCurrent(observation)) return true
      if (!detailed) {
        this.failMissingWorker(plan, attempt, fence, observation)
        return true
      }
      ctx.session = detailed
      const session = detailed
      if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0) {
        this.holdApprovalObservation(plan, attempt, session, observation, fence)
        return true
      }
      if (session.busy || session.pendingInput || session.observationUnstable) return true
      if (this.staleContinuationTurn(attempt, session)) return true
      const detailedBackgroundReason = this.backgroundBlockReason(session)
      if (session.outcome === "interrupted") {
        await this.holdInterruptedWorker(ctx, detailedBackgroundReason)
        return true
      }
      if (detailedBackgroundReason) {
        this.holdDetailedBackground(ctx, detailedBackgroundReason)
        return true
      }
    }
    const { session } = ctx
    return Boolean(
      session.busy || session.pendingInput || session.observationUnstable || !session.outcome,
    )
  }

  private async holdInterruptedWorker(ctx: AdvanceContext, backgroundReason: string | undefined) {
    const { plan, attempt, fence, observation, session } = ctx
    this.workerEvent(plan, attempt, "WORKER_STOPPED", fence, "interrupted", session.turn?.inputID)
    const reason = backgroundReason
      ? `Worker execution was interrupted; ${backgroundReason}`
      : "Worker execution was interrupted; the runtime could not resume it"
    if (backgroundReason) this.backgroundWait(plan, attempt, session, backgroundReason, fence)
    this.hold(
      plan,
      reason,
      ["audit", "reconcile", "cancel"],
      this.terminalWorkerObservation(attempt, session),
      observation,
    )
    if (!backgroundReason) await this.autoResumeInterruptedWorker(plan.id, attempt.id)
  }

  /** A worker that ended (or is idle) while background work it started is still running. */
  private holdDetailedBackground(ctx: AdvanceContext, backgroundReason: string) {
    const { plan, attempt, fence, observation, session } = ctx
    if (session.outcome === "failed" || session.outcome === "succeeded") {
      this.workerEvent(
        plan,
        attempt,
        "WORKER_STOPPED",
        fence,
        session.outcome,
        session.turn?.inputID,
      )
      this.backgroundWait(plan, attempt, session, backgroundReason, fence)
      this.hold(
        plan,
        `Worker execution ${session.outcome === "failed" ? "failed" : "completed"}; ${backgroundReason}`,
        ["audit", "reconcile", "cancel"],
        this.terminalWorkerObservation(attempt, session),
        observation,
      )
      return
    }
    this.hold(plan, backgroundReason, ["audit", "reconcile", "cancel"], undefined, observation)
    this.backgroundWait(plan, attempt, session, backgroundReason, fence)
  }

  /** The worker is idle with an outcome: fail, hold, or move the attempt on to verification. */
  private async finishWorkerTurn(ctx: AdvanceContext) {
    const { attempt, fence, session } = ctx
    if (this.resumeTransientObservationWait(ctx.plan, attempt, session, ctx.observation, fence)) {
      ctx.plan = this.store.plan(ctx.plan.id)!
      ctx.observation = this.workerObservationFence(ctx.plan, attempt) ?? ctx.observation
    }
    const { plan, observation } = ctx
    if (
      session.outcome === "succeeded" &&
      (!session.turn ||
        !this.matchesWorkerInput(attempt, session.turn.inputID) ||
        session.turn.state !== "completed")
    ) {
      this.settleUnconfirmedSuccess(plan, attempt, session, observation)
      return
    }
    this.workerEvent(plan, attempt, "WORKER_STOPPED", fence, session.outcome, session.turn?.inputID)
    if (session.outcome !== "succeeded") {
      if (session.outcome === "interrupted") {
        this.hold(
          plan,
          "Worker execution was interrupted; the runtime could not resume it",
          ["audit", "reconcile", "resume", "cancel"],
          this.terminalWorkerObservation(attempt, session),
          observation,
        )
        await this.autoResumeInterruptedWorker(plan.id, attempt.id)
        return
      }
      this.failAttempt(
        plan,
        attempt,
        `Worker ${session.outcome}`,
        session.outcome === "failed" ? this.terminalWorkerObservation(attempt, session) : undefined,
      )
      return
    }
    const task = this.store.repository.get(attempt.task_id)!
    if (attempt.state === "running") {
      this.store.move(plan.id, task.id, "VERIFY")
      this.store.atomic((db) =>
        db
          .query(
            "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'verifying') WHERE id=?",
          )
          .run(attempt.id),
      )
    }
    await this.verify(plan, attempt, task.proposal, fence)
  }

  /** The worker reported success without a completed response to the assigned input. */
  private settleUnconfirmedSuccess(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    observation: WorkerObservationFence,
  ) {
    if (
      session.turn &&
      this.matchesWorkerInput(attempt, session.turn.inputID) &&
      session.turn.state === "pending"
    )
      return
    // A completed turn for a different input is a follow-up the Architect can bind
    // (reconcile); say so and advertise it.
    if (session.turn && !this.matchesWorkerInput(attempt, session.turn.inputID)) {
      this.hold(
        plan,
        "Native worker success does not match a completed response to the current assigned input",
        ["audit", "reconcile", "retry", "cancel"],
        undefined,
        observation,
      )
      return
    }
    // The worker went idle without a completed response to its assigned input:
    // an observable failure of the attempt, retried through the normal path.
    this.failAttempt(
      plan,
      attempt,
      "Worker went idle without a completed response to the assigned input",
    )
  }

  /**
   * An interrupted worker resumes from its live state; nobody has to command it.
   * Bounded per attempt so a worker that keeps being interrupted surfaces in the hold.
   */
  private async autoResumeInterruptedWorker(planID: string, attemptID: string) {
    if (!this.autoResumeInterrupted) return
    const plan = this.store.plan(planID)
    const attempt = this.store.attempts(planID).find((candidate) => candidate.id === attemptID)
    if (!plan || plan.state !== "blocked" || !attempt) return
    const prior = this.store.activity(planID, attempt.task_id).filter(
      (event) =>
        event.event === "WORKER_AUTO_RESUMED" &&
        (() => {
          try {
            return (JSON.parse(event.payload) as { attemptID?: unknown }).attemptID === attempt.id
          } catch {
            return false
          }
        })(),
    ).length
    if (prior >= 3 || !this.validArchitect(await this.host.session(plan.owner))) return
    this.store.record(planID, attempt.task_id, "WORKER_AUTO_RESUMED", {
      attemptID: attempt.id,
      messageID: attempt.message_id,
    })
    try {
      await this.command(
        {
          requestID: `auto-resume:${attempt.id}:${attempt.message_id}`,
          planID,
          action: "resume",
          taskID: attempt.task_id,
          attemptID: attempt.id,
          reason: "The worker was interrupted; the runtime resumes it from its live state",
        },
        plan.owner,
      )
    } catch {
      // The hold stays and advertises resume; the next observation tries again within the bound.
    }
  }

  private async prepareVerificationCandidate(
    plan: PlanRow,
    attempt: AttemptRow,
    proposal: TaskProposal,
    fence: number,
  ): Promise<"ready" | "prepared" | "pending" | "held"> {
    if (!needsMechanicalQualityPreparation(proposal.verification.map((check) => check.command)))
      return "ready"
    const scope = this.store.effectiveWriteScope(attempt.task_id)
    const paths = await changedPaths(attempt.workspace, attempt.base_commit)
    if (protectedPaths(paths, this.store.effectiveScope(attempt.task_id)).length) return "ready"
    const formatterExtensions = new Set([
      ".css",
      ".htm",
      ".html",
      ".js",
      ".jsx",
      ".json",
      ".json5",
      ".jsonc",
      ".md",
      ".mdx",
      ".mjs",
      ".mts",
      ".ts",
      ".tsx",
      ".yaml",
      ".yml",
    ])
    const lintExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx", ".cts"])
    const formatPaths: string[] = []
    const lintPaths: string[] = []
    for (const path of paths) {
      let info: ReturnType<typeof lstatSync>
      try {
        info = lstatSync(join(attempt.workspace, path))
      } catch {
        continue
      }
      if (!info.isFile() || info.isSymbolicLink()) continue
      const extension = extname(path).toLowerCase()
      if (formatterExtensions.has(extension)) formatPaths.push(path)
      if (lintExtensions.has(extension)) lintPaths.push(path)
    }
    if (!formatPaths.length && !lintPaths.length) return "ready"
    // A write-scope overlap is a warning only: parallel work stays allowed.
    if (!this.preparationAllowed(attempt))
      this.store.recordOnce(plan.id, attempt.task_id, "SCOPE_OVERLAP_WARNING", {
        attemptID: attempt.id,
        phase: "mechanical-preparation",
      })
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const commands = [
      ...(formatPaths.length ? [`bun fmt ${formatPaths.map(quote).join(" ")}`] : []),
      ...(lintPaths.length ? [`bun lint --fix ${lintPaths.map(quote).join(" ")}`] : []),
      ...(formatPaths.length && lintPaths.length
        ? [`bun fmt ${formatPaths.map(quote).join(" ")}`]
        : []),
    ]
    const command = commands.join(" && ")
    const check = verificationCheckWithDefaults(
      { id: "mechanical-preparation", command },
      this.verificationTimeoutDefaults,
    )
    const inputFingerprint = await workingTreeIdentity(attempt.workspace, attempt.base_commit)
    const shared = attempt.workspace === this.directory
    const sharedDirty = shared && (await changedPaths(attempt.workspace)).length > 0
    const environmentIdentity = verificationEnvironmentIdentity()
    const repairID = this.retainedRepairGeneration(plan.id, attempt.task_id)
    const payload = {
      workspace: attempt.workspace,
      baseCommit: attempt.base_commit,
      inputFingerprint,
      scope,
      paths,
      formatPaths,
      lintPaths,
      command,
      check,
      environmentIdentity,
      messageID: attempt.message_id,
      ...(repairID ? { repairID } : {}),
      planVersion: plan.version,
      receiptPath: join(
        this.dataDirectory,
        "receipts",
        attempt.id,
        `mechanical-preparation-${inputFingerprint}.json`,
      ),
    }
    const existing = this.store.effects(plan.id).findLast((effect) => {
      if (effect.attempt_id !== attempt.id || effect.kind !== "mechanical-fix") return false
      if (effectSuperseded(effect)) return false
      const recorded = JSON.parse(effect.payload)
      if (
        recorded.messageID !== attempt.message_id ||
        (recorded.repairID ?? undefined) !== repairID
      )
        return false
      // A clean shared checkout can contain a newly committed correction.
      // Preserve old receipts and prepare the new candidate independently.
      if (shared && !sharedDirty && effect.state === "completed") {
        const receipt = (JSON.parse(effect.receipt ?? "{}") as { check?: CheckReceipt }).check
        if (
          receipt?.preparation &&
          recorded.inputFingerprint !== inputFingerprint &&
          receipt.preparation.resultingFingerprint !== inputFingerprint
        )
          return false
      }
      return true
    })
    if (existing) {
      let recorded: typeof payload
      try {
        recorded = JSON.parse(existing.payload) as typeof payload
      } catch {
        this.hold(
          plan,
          "Mechanical candidate preparation journal is unreadable; no check was replayed",
        )
        return "held"
      }
      if (
        recorded.baseCommit !== payload.baseCommit ||
        recorded.workspace !== payload.workspace ||
        recorded.command !== payload.command ||
        JSON.stringify(recorded.scope) !== JSON.stringify(scope) ||
        recorded.messageID !== attempt.message_id ||
        recorded.repairID !== payload.repairID
      ) {
        this.hold(
          plan,
          "Mechanical candidate preparation inputs changed; the original activity was not replayed",
        )
        return "held"
      }
      if (existing.state !== "completed") {
        const activity = this.checkActivity(existing.id, {
          effectID: existing.id,
          payload: existing.payload,
        })
        if (activity?.state === "running") return "pending"
        this.hold(plan, "Mechanical candidate preparation is uncertain and was not replayed")
        return "held"
      }
      let receipt: CheckReceipt | undefined
      try {
        receipt = (JSON.parse(existing.receipt ?? "{}") as { check?: CheckReceipt }).check
      } catch {
        receipt = undefined
      }
      if (
        !receipt?.preparation ||
        receipt.id !== check.id ||
        receipt.command !== check.command ||
        receipt.artifact !== attempt.base_commit ||
        receipt.inputIdentity !== recorded.inputFingerprint ||
        receipt.environmentIdentity !== recorded.environmentIdentity ||
        receipt.preparation.inputFingerprint !== recorded.inputFingerprint ||
        receipt.preparation.resultingFingerprint !==
          (await workingTreeIdentity(attempt.workspace, attempt.base_commit))
      ) {
        this.hold(
          plan,
          "Mechanical candidate changed after its authorized fix receipt; no stale artifact was accepted",
        )
        return "held"
      }
      if (!checkSucceeded(receipt)) {
        this.hold(
          plan,
          `Mechanical candidate preparation failed (${receipt.command}, exit ${receipt.exitCode ?? "unknown"}); the original attempt was preserved without a worker repair`,
          ["reconcile", "resume", "audit", "cancel"],
        )
        return "held"
      }
      return "prepared"
    }
    if (sharedDirty) {
      this.hold(
        plan,
        "Commit task edits before verification; shared checkout has uncommitted changes",
      )
      return "held"
    }
    const effect = this.effect(
      plan.id,
      attempt.task_id,
      attempt.id,
      "mechanical-fix",
      payload,
      fence,
    )
    this.startCheckActivity({
      id: effect.id,
      identity: { effectID: effect.id, payload: effect.payload },
      metadata: {
        kind: "effect",
        projectDirectory: this.directory,
        planID: plan.id,
        taskID: attempt.task_id,
        attemptID: attempt.id,
        effectID: effect.id,
      },
      run: async (signal) => {
        const receipt = await runCheck(
          attempt.workspace,
          attempt.base_commit,
          check,
          payload.receiptPath,
          {
            signal,
            inputIdentity: inputFingerprint,
            environmentIdentity,
          },
        )
        const preparation = {
          inputFingerprint,
          resultingFingerprint: await workingTreeIdentity(attempt.workspace, attempt.base_commit),
          paths,
          scope,
        }
        const result = { ...receipt, preparation }
        await writeCheckReceipt(payload.receiptPath, result)
        return result
      },
    })
    return "pending"
  }

  /** True while the attempt is still the one this verification pass was started for. */
  private verificationCurrentGuard(
    plan: PlanRow,
    attempt: AttemptRow,
    repairID: string | undefined,
  ) {
    return () => {
      const currentPlan = this.store.plan(plan.id)
      const currentAttempt = this.store
        .attempts(plan.id)
        .find((candidate) => candidate.id === attempt.id)
      const currentNode = this.store
        .nodes(plan.id)
        .find((candidate) => candidate.task_id === attempt.task_id)
      return Boolean(
        currentPlan &&
        ["running", "blocked"].includes(currentPlan.state) &&
        currentAttempt?.state === "verifying" &&
        currentAttempt.message_id === attempt.message_id &&
        currentNode?.state === "verifying" &&
        this.retainedRepairGeneration(plan.id, attempt.task_id) === repairID,
      )
    }
  }

  private taskVerificationTarget(
    plan: PlanRow,
    attempt: AttemptRow,
    check: TaskProposal["verification"][number],
    artifact: string,
  ) {
    return this.verificationTarget(
      plan,
      "task",
      check,
      artifact,
      attempt.task_id,
      this.store.repository.get(attempt.task_id)?.revision ?? null,
      attempt.id,
    )
  }

  /** A blocked plan whose verification deadline waits on the task's continuation does not verify yet. */
  private verificationAwaitsTaskContinuation(
    plan: PlanRow,
    attempt: AttemptRow,
    proposal: TaskProposal,
  ) {
    const current = this.store.plan(plan.id)
    return Boolean(
      current?.state === "blocked" &&
      attempt.artifact &&
      proposal.verification.some((check) => {
        const target = this.taskVerificationTarget(current, attempt, check, attempt.artifact!)
        return this.deadlineAwaitingTaskContinuation(
          current,
          target,
          this.verificationDeadline(target),
        )
      }),
    )
  }

  /** Whether a verify effect already ran this exact candidate, so a retained fix may be kept. */
  private candidateAlreadyChecked(
    plan: PlanRow,
    attempt: AttemptRow,
    proposal: TaskProposal,
    head: string,
    repairID: string | undefined,
  ) {
    return this.store.effects(plan.id).some((effect) => {
      if (
        effect.attempt_id !== attempt.id ||
        effect.state !== "completed" ||
        !effect.kind.startsWith("verify:")
      )
        return false
      const payload = JSON.parse(effect.payload)
      const recordedCheck =
        isRecord(payload) && payload.authoredCheck !== undefined
          ? payload.authoredCheck
          : isRecord(payload)
            ? payload.check
            : undefined
      return (
        payload.artifact === head &&
        payload.workspace === attempt.workspace &&
        proposal.verification.some((check) =>
          sameVerificationCheckIdentity(check, recordedCheck),
        ) &&
        (payload.repairID ?? undefined) === repairID
      )
    })
  }

  /** Commits the attempt's workspace as the candidate artifact; undefined when verification must stop. */
  private async commitVerificationCandidate(
    plan: PlanRow,
    attempt: AttemptRow,
    proposal: TaskProposal,
    preparation: "ready" | "prepared",
    repairID: string | undefined,
    fence: number,
    verificationCurrent: () => boolean,
  ): Promise<Awaited<ReturnType<typeof commitArtifact>> | undefined> {
    try {
      const head = await gitAsync(attempt.workspace, ["rev-parse", "HEAD"])
      const checkedCandidate = this.candidateAlreadyChecked(plan, attempt, proposal, head, repairID)
      const retainFixes =
        (preparation === "prepared" || checkedCandidate) && this.preparationAllowed(attempt)
      const artifact = await commitArtifact(
        attempt.workspace,
        attempt.base_commit,
        this.store.effectiveScope(attempt.task_id),
        attempt.workspace !== this.directory || retainFixes,
        attempt.workspace !== this.directory
          ? await gitAsync(this.directory, ["rev-parse", "HEAD"])
          : undefined,
      )
      if (!verificationCurrent()) return undefined
      // Publish the private snapshot before starting checks. Recreating
      // commit-tree on each tick changes its identity
      // and can strand an otherwise valid receipt (or supersede worker edits).
      if ((attempt.workspace !== this.directory || retainFixes) && artifact.commit !== head)
        await gitAsync(attempt.workspace, ["update-ref", "HEAD", artifact.commit, head])
      return artifact
    } catch (error) {
      if (!verificationCurrent()) return undefined
      try {
        this.progress.recordAttemptOutcome(
          attempt.id,
          error instanceof ArtifactScopeViolation ? "artifact-scope-violation" : "artifact-error",
          errorText(error),
        )
      } catch {
        // The task state machine remains authoritative if annotation storage is unavailable.
      }
      if (error instanceof ArtifactScopeViolation) {
        this.store.fenced(this.owner, fence, () => {
          this.store.record(plan.id, attempt.task_id, "SCOPE_DECISION_REQUIRED", {
            attemptID: attempt.id,
            workspace: attempt.workspace,
            baseCommit: attempt.base_commit,
            kind: "protected",
            paths: error.paths,
            reason: error.message,
          })
          this.hold(plan, error.message, ["amend-scope", "audit", "reconcile", "cancel"])
        })
        return undefined
      }
      this.failAttempt(plan, attempt, errorText(error))
      return undefined
    }
  }

  /** Records the candidate artifact on the attempt and its task node. */
  private recordAttemptArtifact(plan: PlanRow, attempt: AttemptRow, commit: string, fence: number) {
    this.store.fenced(this.owner, fence, (db) => {
      db.query("UPDATE runner_attempts SET artifact=? WHERE id=?").run(commit, attempt.id)
      db.query("UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=?").run(
        commit,
        plan.id,
        attempt.task_id,
      )
    })
  }

  /** The newest non-superseded verify effect that covers this exact candidate and check. */
  private knownVerifyEffect(
    plan: PlanRow,
    attempt: AttemptRow,
    check: TaskProposal["verification"][number],
    artifact: { commit: string; identity: string },
    effectiveCheck: TaskProposal["verification"][number],
    repairID: string | undefined,
    verificationEpoch: number,
  ) {
    return this.store
      .effects(plan.id)
      .toReversed()
      .find((e) => {
        if (e.attempt_id !== attempt.id || e.kind !== `verify:${check.id}`) return false
        if (effectSuperseded(e)) return false
        const payload = JSON.parse(e.payload) as {
          artifact?: unknown
          identity?: unknown
          workspace?: unknown
          repairID?: unknown
          verificationEpoch?: number
          check?: unknown
          authoredCheck?: unknown
        }
        // A resume replaces interrupted checks. Preserve completed checks
        // for the same candidate, attempt, command, and repair generation.
        const passed =
          e.state === "completed" && e.receipt
            ? (JSON.parse(e.receipt) as { check?: CheckReceipt }).check
            : undefined
        return (
          payload.artifact === artifact.commit &&
          payload.identity === artifact.identity &&
          payload.workspace === attempt.workspace &&
          (payload.repairID ?? undefined) === repairID &&
          ((payload.verificationEpoch ?? 0) === verificationEpoch ||
            (passed && checkSucceeded(passed))) &&
          sameVerificationCheckIdentity(payload.check, effectiveCheck)
        )
      })
  }

  /** An unfinished earlier effect for the check: wait while it runs, otherwise hold as uncertain. */
  private holdUncertainVerifyEffect(
    plan: PlanRow,
    attempt: AttemptRow,
    check: TaskProposal["verification"][number],
    artifact: { commit: string; identity: string },
    known: EffectRow,
  ) {
    const activityIdentity = { effectID: known.id, payload: known.payload }
    const activity = this.checkActivity(known.id, activityIdentity)
    if (activity?.state === "running" || activity?.state === "completed") return
    const actual = actualCheckResultFromEffect(known)
    const matches = Boolean(
      actual &&
      actual.id === check.id &&
      actual.command === check.command &&
      actual.cwd === attempt.workspace &&
      actual.artifact === artifact.commit &&
      actual.inputIdentity === artifact.identity,
    )
    const reason =
      matches && actual && !checkResourcesSettled(actual)
        ? `Verification ${check.id} completed with exit ${actual.exitCode ?? "unknown"} and timedOut=${actual.timedOut}; subprocess cleanup remains uncertain: ${actual.processCleanup?.detail ?? "termination was not confirmed"}`
        : `Verification ${check.id} has an uncertain receipt and was not replayed`
    this.hold(plan, reason, ["reconcile", "resume", "audit", "cancel"])
  }

  /** Journals the verify effect and starts its check; the receipt arrives on a later tick. */
  private startVerifyEffect(
    plan: PlanRow,
    attempt: AttemptRow,
    check: TaskProposal["verification"][number],
    effectiveCheck: TaskProposal["verification"][number],
    deadline: VerificationDeadline,
    artifact: { commit: string; identity: string },
    known: EffectRow | undefined,
    repairID: string | undefined,
    verificationEpoch: number,
    fence: number,
  ) {
    const receiptPath = join(
      this.dataDirectory,
      "receipts",
      attempt.id,
      `${check.id}-${artifact.commit}${repairID ? `-${repairID}` : ""}${verificationEpoch ? `-resume-${verificationEpoch}` : ""}${known ? `-${known.id}` : ""}.json`,
    )
    const effect = this.effect(
      plan.id,
      attempt.task_id,
      attempt.id,
      `verify:${check.id}`,
      {
        check: effectiveCheck,
        authoredCheck: check,
        verificationDeadline: verificationReceiptDeadline(deadline),
        workspace: attempt.workspace,
        artifact: artifact.commit,
        identity: artifact.identity,
        receiptPath,
        ...(known ? { previousCheckID: known.id } : {}),
        ...(verificationEpoch ? { verificationEpoch } : {}),
        ...(repairID ? { repairID } : {}),
      },
      fence,
    )
    try {
      const activityIdentity = { effectID: effect.id, payload: effect.payload }
      this.startCheckActivity({
        id: effect.id,
        identity: activityIdentity,
        metadata: {
          kind: "effect",
          projectDirectory: this.directory,
          planID: plan.id,
          effectID: effect.id,
          taskID: attempt.task_id,
          attemptID: attempt.id,
          receiptPath,
        },
        run: (signal) =>
          this.runVerificationCheck(
            attempt.workspace,
            artifact.commit,
            check,
            deadline,
            receiptPath,
            {
              signal,
            },
          ),
      })
    } catch (error) {
      try {
        this.progress.recordVerificationError(attempt.id, effect.id, check.id, error)
      } catch {
        // The runner effect remains authoritative if annotation storage fails.
      }
      this.uncertain(effect, error, fence)
    }
  }

  /**
   * Walks the authored checks in order. Returns every check's receipt once they all completed;
   * undefined when a check was started, is still running, or the plan was held or stopped.
   */
  private async collectCheckReceipts(
    plan: PlanRow,
    attempt: AttemptRow,
    proposal: TaskProposal,
    artifact: { commit: string; identity: string },
    repairID: string | undefined,
    fence: number,
  ): Promise<CheckReceipt[] | undefined> {
    const verificationEpoch =
      this.store.latestTransition<{ verificationEpoch: number }>(
        plan.id,
        attempt.task_id,
        "VERIFICATION_RESUMED",
      )?.verificationEpoch ?? 0
    const receipts: CheckReceipt[] = []
    for (const check of proposal.verification) {
      if (!["running", "blocked"].includes(this.store.plan(plan.id)!.state)) return undefined
      const deadline = this.verificationDeadline(
        this.taskVerificationTarget(plan, attempt, check, artifact.commit),
      )
      const effectiveCheck = effectiveVerificationCheck(check, deadline)
      const known = this.knownVerifyEffect(
        plan,
        attempt,
        check,
        artifact,
        effectiveCheck,
        repairID,
        verificationEpoch,
      )
      if (
        !known &&
        this.store.plan(plan.id)?.state === "blocked" &&
        this.deadlineAwaitingTaskContinuation(
          plan,
          this.taskVerificationTarget(plan, attempt, check, artifact.commit),
          deadline,
        )
      )
        return undefined
      if (known && known.state !== "completed") {
        this.holdUncertainVerifyEffect(plan, attempt, check, artifact, known)
        return undefined
      }
      if (known?.state === "completed") {
        receipts.push(JSON.parse(known.receipt!).check)
        continue
      }
      this.startVerifyEffect(
        plan,
        attempt,
        check,
        effectiveCheck,
        deadline,
        artifact,
        known,
        repairID,
        verificationEpoch,
        fence,
      )
      return undefined
    }
    return receipts
  }

  /**
   * Folds automatic fixes the checks made into the delivered artifact. Returns the artifact to
   * accept, or undefined when verification must stop (held, superseded, or re-run on the new commit).
   */
  private async captureAutomaticFixes(
    plan: PlanRow,
    attempt: AttemptRow,
    artifact: Awaited<ReturnType<typeof commitArtifact>>,
    fence: number,
    verificationCurrent: () => boolean,
  ): Promise<Awaited<ReturnType<typeof commitArtifact>> | undefined> {
    try {
      // Capture automatic fixes in the delivered source; cleanliness is not a pass/fail condition.
      if (await artifactUnchanged(attempt.workspace, artifact.commit)) return artifact
      const previousHead = await gitAsync(attempt.workspace, ["rev-parse", "HEAD"])
      const updated = await commitArtifact(
        attempt.workspace,
        attempt.base_commit,
        this.store.effectiveScope(attempt.task_id),
        true,
        attempt.workspace !== this.directory
          ? await gitAsync(this.directory, ["rev-parse", "HEAD"])
          : undefined,
      )
      if (!verificationCurrent()) return undefined
      if (updated.commit !== previousHead)
        await gitAsync(attempt.workspace, ["update-ref", "HEAD", updated.commit, previousHead])
      this.recordAttemptArtifact(plan, attempt, updated.commit, fence)
      return updated.commit !== previousHead ? undefined : updated
    } catch (error) {
      this.hold(plan, errorText(error))
      return undefined
    }
  }

  private acceptVerifiedAttempt(
    plan: PlanRow,
    attempt: AttemptRow,
    artifact: Awaited<ReturnType<typeof commitArtifact>>,
    receipts: CheckReceipt[],
    review: FallowReviewResult | undefined,
    repairID: string | undefined,
    fence: number,
    verificationCurrent: () => boolean,
    scope: ScopeReport,
  ) {
    this.store.fenced(this.owner, fence, (db) => {
      if (!verificationCurrent()) return
      db.query(
        "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'accepted') WHERE id=?",
      ).run(attempt.id)
      this.store.move(plan.id, attempt.task_id, "ACCEPT")
      this.store.record(plan.id, attempt.task_id, "ARTIFACT_ACCEPTED", {
        ...artifact,
        ...(repairID ? { sourceGeneration: repairID } : {}),
      })
      this.outcome(
        plan.id,
        {
          status: "task-accepted",
          taskID: attempt.task_id,
          attemptID: attempt.id,
          artifact: artifact.commit,
          evidence: receipts.map((r) => r.id),
          ...fallowAcceptance(review, this.fallowDispositions(attempt, review)),
          ...(scopeReportEmpty(scope) ? {} : { scope: boundedScopeReport(scope) }),
        },
        true,
      )
    })
    this.startAuditorReport(attempt, "follow-up")
    try {
      this.progress.recordAttemptOutcome(attempt.id, "accepted")
    } catch {
      // Progress facts never grant or revoke acceptance.
    }
  }

  /**
   * After the one repair: what became of each finding the first audit reported, read from the
   * audit that just ran. Absent on a first attempt, or when either audit was unavailable.
   */
  private fallowDispositions(
    attempt: AttemptRow,
    review: FallowReviewResult | undefined,
  ): FallowDisposition[] | undefined {
    if (!review?.package || !JSON.parse(attempt.policy).repairAttempt) return undefined
    const previous = this.store
      .attempts(attempt.plan_id)
      .filter((a) => a.task_id === attempt.task_id && a.number < attempt.number)
      .at(-1)
    if (!previous) return undefined
    const first = this.store.read((db) =>
      db
        .query<{ body: string }, [string, string, string]>(
          "SELECT body FROM runner_evidence WHERE attempt_id=? AND kind='verification' AND json_extract(body,'$.id') IN (?,?) ORDER BY rowid DESC LIMIT 1",
        )
        .get(previous.id, FALLOW_CHECK_ID, LEGACY_FALLOW_CHECK_ID),
    )
    const before = first ? (JSON.parse(first.body) as CheckReceipt).fallow?.package : undefined
    return before ? dispositionsAfterRepair(before, review.package) : undefined
  }

  private async verify(plan: PlanRow, attempt: AttemptRow, proposal: TaskProposal, fence: number) {
    const repairID = this.retainedRepairGeneration(plan.id, attempt.task_id)
    const verificationCurrent = this.verificationCurrentGuard(plan, attempt, repairID)
    if (!verificationCurrent()) return
    if (this.verificationAwaitsTaskContinuation(plan, attempt, proposal)) return
    const preparation = await this.prepareVerificationCandidate(plan, attempt, proposal, fence)
    if (preparation === "pending" || preparation === "held") return
    let artifact = await this.commitVerificationCandidate(
      plan,
      attempt,
      proposal,
      preparation,
      repairID,
      fence,
      verificationCurrent,
    )
    if (!artifact) return
    const scope = await this.reviewScope(plan, attempt, artifact)
    this.recordAttemptArtifact(plan, attempt, artifact.commit, fence)
    await this.stampIdentity(true)
    try {
      this.progress.recordArtifact(attempt.id, artifact.commit)
    } catch {
      // Artifact acceptance and its runner receipt remain independent of commentary.
    }
    const receipts = await this.collectCheckReceipts(
      plan,
      attempt,
      proposal,
      artifact,
      repairID,
      fence,
    )
    if (!receipts) return
    const failures = receipts.filter((r) => !checkSucceeded(r))
    const held = failures.find(
      (r) => r.timedOut || r.exitCode === 126 || r.exitCode === 127 || !checkResourcesSettled(r),
    )
    if (held) {
      this.hold(plan, checkFailureReason(held), ["reconcile", "resume", "audit", "cancel"])
      return
    }
    const review = await this.fallowReviewResult(plan, attempt, artifact, repairID, fence)
    if (review === "pending") return
    if (this.decideVerification(plan, attempt, failures, review, scope)) return
    // No repair is left to carry the divergence, so the Architect decides it before acceptance.
    if (scope.divergences.length) return this.holdScopeDivergence(plan, attempt, scope, fence)
    artifact = await this.captureAutomaticFixes(plan, attempt, artifact, fence, verificationCurrent)
    if (!artifact) return
    const missing = await this.missingEvidence(attempt.workspace, proposal.acceptance, receipts)
    if (missing.length) {
      this.hold(plan, `Required evidence missing: ${missing.join(", ")}`)
      return
    }
    this.acceptVerifiedAttempt(
      plan,
      attempt,
      artifact,
      receipts,
      review,
      repairID,
      fence,
      verificationCurrent,
      scope,
    )
  }
  /**
   * One decision for the authored checks and the Fallow review. Returns true when the attempt was
   * settled (repair or fail). Findings alone repair while a repair attempt remains and are
   * otherwise left to acceptance; they never fail an attempt or raise a hold.
   */
  private decideVerification(
    plan: PlanRow,
    attempt: AttemptRow,
    failures: CheckReceipt[],
    review: FallowReviewResult | undefined,
    scope: ScopeReport,
  ): boolean {
    if (review?.status === "unavailable")
      this.store.recordOnce(plan.id, attempt.task_id, "FALLOW_UNAVAILABLE", {
        attemptID: attempt.id,
        reason: review.reason ?? "Fallow audit unavailable",
      })
    const reviewed = review?.package
    const reasons = failures.map(checkFailureReason)
    const repairs = failures.length > 0 || this.repairAvailable(attempt)
    if (reviewed && needsRepair(reviewed) && repairs) reasons.push(fallowReasonText(reviewed))
    // A divergence never spends the repair by itself: it rides only when checks or the audit already send the work back.
    if (scope.divergences.length && reasons.length)
      reasons.push(
        `Scope divergence: ${scope.divergences.length} change(s) outside the task's scope`,
      )
    if (!reasons.length) return false
    this.failAttempt(plan, attempt, reasons.join("; "))
    return true
  }

  /**
   * Classifies every changed path against the task's scope, records the report for the repair and
   * the acceptance notice, and measures the size signal. Cached per candidate and scope.
   */
  private async reviewScope(
    plan: PlanRow,
    attempt: AttemptRow,
    artifact: { commit: string; scopeBase: string },
  ): Promise<ScopeReport> {
    const model = this.store.effectiveScope(attempt.task_id)
    const key = `${attempt.id}:${artifact.commit}:${fingerprint(model)}`
    const cached = this.scopeReports.get(key)
    if (cached) return cached
    const base = await this.taskScopeBase(attempt, artifact)
    const changes = await collectScopeChanges(attempt.workspace, base, artifact.commit)
    const report = buildScopeReport({
      attemptID: attempt.id,
      model,
      classified: classifyChanges(changes, model),
      owners: this.scopeOwners(plan, attempt.task_id),
      amendmentReasons: this.store
        .activity(plan.id, attempt.task_id)
        .filter((event) => event.event === "SCOPE_AMENDED")
        .map((event) => String(JSON.parse(event.payload).reason ?? "")),
      warnings: await sizeWarnings(attempt.workspace, base, artifact.commit, changes),
    })
    if (this.scopeReports.size >= 64) this.scopeReports.clear()
    this.scopeReports.set(key, report)
    if (!scopeReportEmpty(report))
      this.store.recordOnce(plan.id, attempt.task_id, "SCOPE_REPORTED", report)
    return report
  }

  /**
   * Where the task's own change is measured from. A repair starts from the previous attempt's
   * artifact, so its candidate base already holds the first attempt's divergence; the review must
   * see the whole task change, from the first attempt's base.
   */
  private async taskScopeBase(
    attempt: AttemptRow,
    artifact: { commit: string; scopeBase: string },
  ): Promise<string> {
    const chain = this.taskChainBase(attempt)
    if (chain === attempt.base_commit) return artifact.scopeBase
    try {
      return await reviewedScopeBase(
        attempt.workspace,
        chain,
        artifact.commit,
        attempt.workspace !== this.directory
          ? await gitAsync(this.directory, ["rev-parse", "HEAD"])
          : undefined,
      )
    } catch {
      return chain
    }
  }

  /** Other unfinished tasks and their reserved scopes, to show where a divergence could collide. */
  private scopeOwners(plan: PlanRow, taskID: string): ScopeOwner[] {
    const finished = new Set(["accepted", "incorporated", "cancelled", "failed", "exhausted"])
    const ids = new Set<string>()
    for (const node of this.store.nodes(plan.id))
      if (node.task_id !== taskID && !finished.has(node.state)) ids.add(node.task_id)
    for (const active of this.store.activeProjectAttempts())
      if (active.task_id !== taskID) ids.add(active.task_id)
    return [...ids].map((id) => ({
      taskID: id,
      patterns: this.store.effectiveReservationScope(id),
    }))
  }

  /** The worker's own final message, quoted as its stated reason; undefined when it gave none. */
  private async workerFinalMessage(attempt: AttemptRow): Promise<string | undefined> {
    try {
      const worker = await this.host.session(attempt.session_id, { messages: true })
      const last = worker?.messages.findLast(
        (message) =>
          message.id !== attempt.message_id && message.type !== "synthetic" && message.text.trim(),
      )
      return last?.text
    } catch {
      return undefined
    }
  }

  /** The Architect decides: amend-scope to accept it with a reason, retained-repair, or cancel. */
  private async holdScopeDivergence(
    plan: PlanRow,
    attempt: AttemptRow,
    report: ScopeReport,
    fence: number,
  ) {
    const reason = divergenceReason(report, await this.workerFinalMessage(attempt))
    this.store.fenced(this.owner, fence, () => {
      this.store.recordOnce(plan.id, attempt.task_id, "SCOPE_DECISION_REQUIRED", {
        attemptID: attempt.id,
        workspace: attempt.workspace,
        baseCommit: attempt.base_commit,
        kind: "divergence",
        paths: report.divergences.map((item) => item.path),
        divergences: report.divergences,
        reason,
      })
      this.hold(plan, reason, ["amend-scope", "retained-repair", "reconcile", "cancel"])
    })
  }

  /** The Fallow review's result for this candidate; "pending" while it is journaled or running. */
  private async fallowReviewResult(
    plan: PlanRow,
    attempt: AttemptRow,
    artifact: { commit: string; identity: string },
    repairID: string | undefined,
    fence: number,
  ): Promise<FallowReviewResult | "pending" | undefined> {
    if (!this.fallowReviewEnabled) return undefined
    const verificationEpoch =
      this.store.latestTransition<{ verificationEpoch: number }>(
        plan.id,
        attempt.task_id,
        "VERIFICATION_RESUMED",
      )?.verificationEpoch ?? 0
    const known = this.store
      .effects(plan.id)
      .toReversed()
      .find((e) => {
        if (
          e.attempt_id !== attempt.id ||
          !isFallowEffectKind(e.kind, FALLOW_EFFECT_KIND) ||
          effectSuperseded(e)
        )
          return false
        const payload = JSON.parse(e.payload) as Record<string, unknown>
        return (
          payload.artifact === artifact.commit &&
          payload.identity === artifact.identity &&
          payload.workspace === attempt.workspace &&
          (payload.repairID ?? undefined) === repairID &&
          (e.state === "completed" || (payload.verificationEpoch ?? 0) === verificationEpoch)
        )
      })
    if (known?.state === "completed") return actualCheckResultFromEffect(known)?.fallow
    if (known) {
      const activity = this.checkActivity(known.id, { effectID: known.id, payload: known.payload })
      if (activity?.state === "running" || activity?.state === "completed") return "pending"
      // The review never holds a task: a lost run is an unavailable review.
      return unavailableFallowResult("Fallow audit did not complete")
    }
    const receiptPath = join(
      this.dataDirectory,
      "receipts",
      attempt.id,
      `${FALLOW_CHECK_ID}-${artifact.commit}${repairID ? `-${repairID}` : ""}${verificationEpoch ? `-resume-${verificationEpoch}` : ""}.json`,
    )
    const effect = this.effect(
      plan.id,
      attempt.task_id,
      attempt.id,
      FALLOW_EFFECT_KIND,
      {
        check: { id: FALLOW_CHECK_ID, command: FALLOW_CHECK_COMMAND },
        workspace: attempt.workspace,
        artifact: artifact.commit,
        identity: artifact.identity,
        receiptPath,
        ...(verificationEpoch ? { verificationEpoch } : {}),
        ...(repairID ? { repairID } : {}),
      },
      fence,
    )
    this.startCheckActivity({
      id: effect.id,
      identity: { effectID: effect.id, payload: effect.payload },
      metadata: {
        kind: "effect",
        projectDirectory: this.directory,
        planID: plan.id,
        effectID: effect.id,
        taskID: attempt.task_id,
        attemptID: attempt.id,
        receiptPath,
      },
      run: (signal) => this.runFallowReview(attempt, artifact, receiptPath, signal),
    })
    return "pending"
  }

  private async runFallowReview(
    attempt: AttemptRow,
    artifact: { commit: string; identity: string },
    receiptPath: string,
    signal: AbortSignal,
  ): Promise<CheckReceipt> {
    const startedAt = Date.now()
    const result = await this.fallowReviewRun({
      workspace: attempt.workspace,
      baseCommit: this.taskChainBase(attempt),
      artifact: artifact.commit,
      repository: this.store.repository,
      signal,
    }).catch((error: unknown) => unavailableFallowResult(errorText(error)))
    const receipt = fallowCheckReceipt({
      id: FALLOW_CHECK_ID,
      workspace: attempt.workspace,
      artifact: artifact.commit,
      inputIdentity: artifact.identity,
      environmentIdentity: verificationEnvironmentIdentity(),
      startedAt,
      endedAt: Date.now(),
      result,
    })
    await writeCheckReceipt(receiptPath, receipt)
    return receipt
  }

  /**
   * An Auditor attempt's durable Fallow report, started in the background: the baseline when the
   * attempt is dispatched, the follow-up when its verification passes. Best effort: a failure is
   * already recorded in the audit history and never touches the attempt. The request ID makes a
   * restart replay the stored run instead of scanning again.
   */
  private startAuditorReport(attempt: AttemptRow, phase: "baseline" | "follow-up") {
    if (workerAgent(JSON.parse(attempt.policy).agent) !== "auditor") return
    const requestID = `runtime-${phase === "baseline" ? "baseline" : "follow-up"}:${attempt.id}`
    if (this.startedAuditorReports.has(requestID)) return
    this.startedAuditorReports.add(requestID)
    void this.auditorReportRun({
      requestID,
      phase,
      workspace: attempt.workspace,
      sessionID: attempt.session_id,
      repository: this.store.repository,
    }).catch(() => undefined)
  }

  /**
   * The Fallow review of the combined artifact: "pending" while journaled or running, undefined
   * when review is off. It is advisory: a lost or failed run reads as unavailable, never a hold.
   */
  private async planFallowReview(
    plan: PlanRow,
    ctx: PlanFallowContext,
    fence: number,
  ): Promise<FallowReviewResult | "pending" | undefined> {
    if (!this.fallowReviewEnabled) return undefined
    const known = this.store
      .effects(plan.id)
      .toReversed()
      .find((e) => {
        if (!isFallowEffectKind(e.kind, FALLOW_PLAN_EFFECT_KIND) || effectSuperseded(e))
          return false
        const payload = JSON.parse(e.payload) as Record<string, unknown>
        return (
          payload.artifact === ctx.artifact &&
          payload.workspace === ctx.workspace &&
          (payload.sourceGeneration ?? undefined) === ctx.sourceGeneration &&
          (e.state === "completed" || (payload.verificationEpoch ?? 0) === ctx.verificationEpoch)
        )
      })
    if (known?.state === "completed")
      return this.recordPlanFallowOutcome(plan, actualCheckResultFromEffect(known)?.fallow)
    if (known) {
      const activity = this.checkActivity(known.id, { effectID: known.id, payload: known.payload })
      if (activity?.state === "running" || activity?.state === "completed") return "pending"
      return this.recordPlanFallowOutcome(
        plan,
        unavailableFallowResult("Fallow plan audit did not complete"),
      )
    }
    const receiptPath = join(
      this.dataDirectory,
      "receipts",
      plan.id,
      `${FALLOW_CHECK_ID}-${ctx.artifact}${ctx.sourceGeneration ? `-${ctx.sourceGeneration}` : ""}${ctx.verificationEpoch ? `-${ctx.verificationEpoch}` : ""}.json`,
    )
    const effect = this.effect(
      plan.id,
      null,
      null,
      FALLOW_PLAN_EFFECT_KIND,
      {
        check: { id: FALLOW_CHECK_ID, command: FALLOW_CHECK_COMMAND },
        workspace: ctx.workspace,
        artifact: ctx.artifact,
        identity: ctx.artifact,
        receiptPath,
        ...(ctx.sourceGeneration ? { sourceGeneration: ctx.sourceGeneration } : {}),
        ...(ctx.verificationEpoch ? { verificationEpoch: ctx.verificationEpoch } : {}),
      },
      fence,
    )
    this.startCheckActivity({
      id: effect.id,
      identity: { effectID: effect.id, payload: effect.payload },
      metadata: {
        kind: "effect",
        projectDirectory: this.directory,
        planID: plan.id,
        effectID: effect.id,
        receiptPath,
      },
      run: (signal) => this.runPlanFallowReview(plan, ctx, receiptPath, signal),
    })
    return "pending"
  }

  /** Records the plan-level `FALLOW_UNAVAILABLE` once and passes the result through. */
  private recordPlanFallowOutcome(
    plan: PlanRow,
    review: FallowReviewResult | undefined,
  ): FallowReviewResult | undefined {
    if (review?.status === "unavailable")
      this.store.recordOnce(plan.id, null, "FALLOW_UNAVAILABLE", {
        reason: review.reason ?? "Fallow audit unavailable",
      })
    return review
  }

  private async runPlanFallowReview(
    plan: PlanRow,
    ctx: PlanFallowContext,
    receiptPath: string,
    signal: AbortSignal,
  ): Promise<CheckReceipt> {
    const startedAt = Date.now()
    const result = await this.fallowPlanReviewRun({
      workspace: ctx.workspace,
      baseCommit: ctx.baseCommit,
      artifact: ctx.artifact,
      repository: this.store.repository,
      signal,
    })
      .then((review) => attributeFindingsToTasks(ctx.workspace, this.planTaskDiffs(plan), review))
      .catch((error: unknown) => unavailableFallowResult(errorText(error)))
    const receipt = fallowCheckReceipt({
      id: FALLOW_CHECK_ID,
      workspace: ctx.workspace,
      artifact: ctx.artifact,
      inputIdentity: ctx.artifact,
      environmentIdentity: verificationEnvironmentIdentity(),
      startedAt,
      endedAt: Date.now(),
      result,
      advisory: true,
    })
    await writeCheckReceipt(receiptPath, receipt)
    return receipt
  }

  /** Each integrated task's own change: its accepted artifact measured from its chain base. */
  private planTaskDiffs(plan: PlanRow): PlanTaskDiff[] {
    const attempts = this.store.attempts(plan.id)
    return this.store.nodes(plan.id).flatMap((node) => {
      const attempt = attempts.findLast(
        (candidate) => candidate.task_id === node.task_id && candidate.artifact === node.artifact,
      )
      return node.artifact && attempt
        ? [{ taskID: node.task_id, base: this.taskChainBase(attempt), artifact: node.artifact }]
        : []
    })
  }

  /**
   * The commit a task's own change is measured from: the `base_commit` of the first attempt in
   * this attempt's continuation chain. A repair or resume starts from the previous attempt's
   * artifact (`dispatch()` sets `base` to it), so its own `base_commit` already contains the
   * task's earlier work. A retry from a new baseline (`base_commit` is not the previous artifact)
   * starts a new chain, so integrated work from others is never attributed to the task.
   */
  private taskChainBase(attempt: AttemptRow): string {
    const earlier = this.store
      .attempts(attempt.plan_id)
      .filter(
        (candidate) => candidate.task_id === attempt.task_id && candidate.number < attempt.number,
      )
      .sort((left, right) => right.number - left.number)
    let base = attempt.base_commit
    for (const previous of earlier) {
      if (previous.artifact !== base) break
      base = previous.base_commit
    }
    return base
  }

  /** True while this attempt, if it fails, moves its task to REPAIR rather than FAIL. */
  private repairAvailable(attempt: AttemptRow): boolean {
    const task = this.store.repository.get(attempt.task_id)!
    const node = this.store.nodes(attempt.plan_id).find((n) => n.task_id === task.id)!
    return (
      node.state === "verifying" &&
      (task.proposal.limits?.maxRepairAttempts ?? 1) > 0 &&
      !JSON.parse(attempt.policy).repairAttempt &&
      !this.retainedRepairForAttempt(attempt)
    )
  }

  private async missingEvidence(
    workspace: string,
    assertions: TaskProposal["acceptance"],
    receipts: CheckReceipt[],
  ) {
    const missing: string[] = []
    for (const assertion of assertions)
      for (const evidence of assertion.evidence) {
        if (
          evidence.kind === "verification" &&
          !receipts.some((r) => r.id === evidence.verificationID && checkSucceeded(r))
        )
          missing.push(assertion.id)
        if (evidence.kind === "artifact" && !(await artifactExists(workspace, evidence.reference)))
          missing.push(`${assertion.id}:${evidence.reference}`)
      }
    return missing
  }

  /** Failing check output from the previous attempt, so a repair attempt sees every defect. */
  private repairFailureBrief(attempt: AttemptRow): string {
    if (!JSON.parse(attempt.policy).repairAttempt) return ""
    const previous = this.store
      .attempts(attempt.plan_id)
      .filter((a) => a.task_id === attempt.task_id && a.number < attempt.number)
      .at(-1)
    if (!previous) return ""
    const fenced = (label: string, text: string) => {
      if (!text.trim()) return ""
      let fence = "```"
      for (const match of text.matchAll(/`+/g))
        if (match[0].length >= fence.length) fence = "`".repeat(match[0].length + 1)
      return `\n${label}:\n${fence}\n${text}\n${fence}`
    }
    const sections = this.store
      .read((db) =>
        db
          .query<{ body: string }, [string]>(
            "SELECT body FROM runner_evidence WHERE attempt_id=? AND kind='verification' ORDER BY rowid",
          )
          .all(previous.id),
      )
      .map((row) => JSON.parse(row.body) as CheckReceipt)
      .filter((receipt) => !checkSucceeded(receipt))
      .map(
        (receipt) =>
          `- ${receipt.id}: \`${receipt.command}\` exit ${receipt.exitCode ?? "unknown"}${fenced("stdout", receipt.stdout)}${fenced("stderr", receipt.stderr)}`,
      )
    const reported = this.store.latestTransition<ScopeReport>(
      attempt.plan_id,
      attempt.task_id,
      "SCOPE_REPORTED",
    )
    const sentBack = this.store.latestTransition<{ attemptID: string; reason: string }>(
      attempt.plan_id,
      attempt.task_id,
      "SCOPE_SENT_BACK",
    )
    const scope =
      reported?.attemptID === previous.id
        ? [
            scopeRepairText(reported),
            sentBack?.attemptID === previous.id ? `Architect: ${sentBack.reason}` : "",
          ]
            .filter(Boolean)
            .join("\n\n")
        : ""
    const checks = sections.length
      ? `\n\nThe previous attempt failed verification. Fix every failing check:\n${sections.join("\n")}`
      : ""
    return `${checks}${scope ? `\n\n${scope}` : ""}`
  }
  private failAttempt(
    plan: PlanRow,
    attempt: AttemptRow,
    reason: string,
    workerObservation?: TerminalWorkerHold,
  ) {
    if (isTakeoverAttempt(attempt.policy))
      return this.returnTakeoverToArchitect(plan, attempt, reason)
    const task = this.store.repository.get(attempt.task_id)!
    this.store.atomic((db) => {
      db.query(
        "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'failed') WHERE id=?",
      ).run(attempt.id)
      if (this.repairAvailable(attempt)) this.store.move(plan.id, task.id, "REPAIR", reason)
      else this.store.move(plan.id, task.id, "FAIL", reason)
    })
    try {
      this.progress.recordAttemptOutcome(attempt.id, "failed", reason)
    } catch {
      // Runtime transitions remain authoritative if annotation storage is unavailable.
    }
    if (this.store.execution(task.id)?.state === "failed")
      this.hold(plan, reason, ["audit", "reconcile", "cancel"], workerObservation)
  }
  /**
   * The Architect's own result failed verification. It is not a worker to repair or retry: the
   * same attempt goes back to the Architect (attempt and task back to running through their
   * machines) and the plan holds with the failing checks and Fallow findings in its reason,
   * advertising takeover-submit and cancel. The hold reaches the recovery bundle if unanswered.
   */
  private returnTakeoverToArchitect(plan: PlanRow, attempt: AttemptRow, reason: string) {
    this.store.atomic((db) => {
      const current = this.store.attempts(plan.id).find((item) => item.id === attempt.id)!
      if (current.state === "verifying") {
        db.query(
          "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'preparing') WHERE id=?",
        ).run(attempt.id)
        db.query(
          "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'running'),artifact=NULL WHERE id=?",
        ).run(attempt.id)
      }
      const node = this.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)!
      if (node.state === "verifying") this.store.move(plan.id, attempt.task_id, "RESUME", reason)
      this.store.record(plan.id, attempt.task_id, "TAKEOVER_VERIFY_FAILED", {
        attemptID: attempt.id,
        reason,
      })
    })
    try {
      this.progress.recordAttemptOutcome(attempt.id, "failed", reason)
    } catch {
      // Runtime transitions remain authoritative if annotation storage is unavailable.
    }
    this.hold(plan, `Takeover verification failed: ${reason}`, ["takeover-submit", "cancel"])
  }

  private async finish(plan: PlanRow, fence: number) {
    if (this.store.plan(plan.id)?.state !== "running") return
    const verificationPlanVersion = this.store.plan(plan.id)!.version
    const sourceGeneration = this.retainedRepairGeneration(plan.id)
    const input = PlanInput.parse(JSON.parse(plan.body))
    const reconcileTransition = this.store.latestTransition<Record<string, unknown>>(
      plan.id,
      null,
      "RECONCILE_REQUESTED",
    )
    const verificationEpoch =
      typeof reconcileTransition?.verificationEpoch === "number"
        ? reconcileTransition.verificationEpoch
        : 0
    const nodes = this.store.nodes(plan.id)
    const branches = input.integrationOrder.flatMap((taskID) => {
      const node = nodes.find((candidate) => candidate.task_id === taskID)
      return node?.artifact ? [node.artifact] : []
    })
    if (branches.length !== input.integrationOrder.length) {
      this.hold(plan, "An accepted task artifact is missing from the integration order")
      return
    }
    const acceptedNodesCurrent = () => {
      const currentPlan = this.store.plan(plan.id)
      const currentNodes = this.store.nodes(plan.id)
      return Boolean(
        currentPlan?.state === "running" &&
        currentPlan.version === verificationPlanVersion &&
        this.retainedRepairGeneration(plan.id) === sourceGeneration &&
        input.integrationOrder.every((taskID) => {
          const previous = nodes.find((node) => node.task_id === taskID)
          const currentNode = currentNodes.find((node) => node.task_id === taskID)
          return Boolean(
            previous?.artifact &&
            ["accepted", "incorporated"].includes(previous.state) &&
            currentNode?.artifact === previous.artifact &&
            ["accepted", "incorporated"].includes(currentNode.state),
          )
        }),
      )
    }
    let artifact = ""
    const acceptedInputsCurrent = () => acceptedNodesCurrent()
    try {
      artifact = await canonicalCombinedArtifact(
        this.directory,
        await combineArtifacts(this.directory, input.baseCommit, branches),
        [],
      )
    } catch (error) {
      if (!acceptedNodesCurrent()) return
      this.hold(plan, `Combined artifact conflict: ${errorText(error)}`)
      return
    }
    if (!acceptedNodesCurrent()) return
    const attempts = this.store.attempts(plan.id)
    const shared =
      JSON.parse(plan.body).workspaceMode === undefined
        ? attempts.at(-1)?.workspace === this.directory
        : input.workspaceMode === "shared"
    let workspace = this.directory
    if (!shared || !(await artifactUnchanged(this.directory, artifact))) {
      const existing = this.store
        .effects(plan.id)
        .find(
          (effect) =>
            effect.kind === "graph-worktree" &&
            effect.state === "completed" &&
            JSON.parse(effect.payload).base === artifact,
        )
      const matchingAttempt = attempts.find(
        (attempt) => attempt.state === "accepted" && attempt.artifact === artifact,
      )
      if (existing) workspace = JSON.parse(existing.receipt!).workspace
      else if (
        matchingAttempt &&
        existsSync(matchingAttempt.workspace) &&
        (await artifactUnchanged(matchingAttempt.workspace, artifact))
      )
        workspace = matchingAttempt.workspace
      else {
        const proposed = canonicalProjectWorktreePath(this.directory, crypto.randomUUID())
        const effect = this.effect(
          plan.id,
          null,
          null,
          "graph-worktree",
          { workspace: proposed, base: artifact },
          fence,
        )
        try {
          const actual = await this.host.worktree({ directory: proposed, base: artifact })
          if ((await gitAsync(actual, ["rev-parse", "HEAD"])) !== artifact)
            throw new Error("Combined worktree did not use the accepted artifact")
          this.receipt(effect, { workspace: actual, base: artifact }, fence)
          workspace = actual
        } catch (error) {
          this.uncertain(effect, error, fence)
          return
        }
      }
    }
    // Explicit reconciliation may follow a conclusive verifier/environment
    // failure. Keep prior effects and give the requested check run its own ID;
    // never replay uncertain effects or silently retry on ordinary ticks.
    const receipts: CheckReceipt[] = []
    for (const check of input.verification) {
      const deadline = this.verificationDeadline(
        this.verificationTarget(plan, "combined", check, artifact, null, null, null),
      )
      const effectiveCheck = effectiveVerificationCheck(check, deadline)
      if (!acceptedInputsCurrent()) return
      const existing = this.store.effects(plan.id).find((e) => {
        if (e.kind !== `graph-verify:${check.id}`) return false
        if (effectSuperseded(e)) return false
        try {
          const payload = JSON.parse(e.payload) as {
            artifact?: unknown
            workspace?: unknown
            sourceGeneration?: unknown
            verificationEpoch?: number
            check?: unknown
          }
          const previous =
            e.state === "completed" && e.receipt
              ? (JSON.parse(e.receipt) as { check?: CheckReceipt }).check
              : undefined
          return (
            payload.artifact === artifact &&
            payload.workspace === workspace &&
            (payload.sourceGeneration ?? undefined) === sourceGeneration &&
            ((payload.verificationEpoch ?? 0) === verificationEpoch ||
              (previous !== undefined && checkSucceeded(previous))) &&
            sameVerificationCheckIdentity(payload.check, effectiveCheck)
          )
        } catch {
          return false
        }
      })
      if (existing && existing.state !== "completed") {
        const activityIdentity = { effectID: existing.id, payload: existing.payload }
        const activity = this.checkActivity(existing.id, activityIdentity)
        if (activity?.state === "running" || activity?.state === "completed") return
        const actual = actualCheckResultFromEffect(existing)
        const reason =
          actual && !checkResourcesSettled(actual)
            ? `Combined verification ${check.id} completed with exit ${actual.exitCode ?? "unknown"} and timedOut=${actual.timedOut}; subprocess cleanup remains uncertain: ${actual.processCleanup?.detail ?? "termination was not confirmed"}`
            : `Combined verification ${check.id} has an uncertain receipt and was not replayed`
        this.hold(plan, reason, ["reconcile", "resume", "audit", "cancel"])
        return
      }
      if (existing?.state === "completed") {
        receipts.push(JSON.parse(existing.receipt!).check)
        continue
      }
      const receiptPath = join(
        this.dataDirectory,
        "receipts",
        plan.id,
        `${check.id}-${artifact}${sourceGeneration ? `-${sourceGeneration}` : ""}${verificationEpoch ? `-${verificationEpoch}` : ""}.json`,
      )
      const effect = this.effect(
        plan.id,
        null,
        null,
        `graph-verify:${check.id}`,
        {
          workspace,
          artifact,
          identity: artifact,
          check: effectiveCheck,
          authoredCheck: check,
          verificationDeadline: verificationReceiptDeadline(deadline),
          receiptPath,
          ...(sourceGeneration ? { sourceGeneration } : {}),
          ...(verificationEpoch ? { verificationEpoch } : {}),
        },
        fence,
      )
      try {
        this.startCheckActivity({
          id: effect.id,
          identity: { effectID: effect.id, payload: effect.payload },
          metadata: {
            kind: "effect",
            projectDirectory: this.directory,
            planID: plan.id,
            effectID: effect.id,
            receiptPath,
          },
          run: (signal) =>
            this.runVerificationCheck(workspace, artifact, check, deadline, receiptPath, {
              signal,
            }),
        })
        return
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    if (receipts.some((r) => !checkSucceeded(r))) {
      // An Architect's accepted takeover result is corrected by the Architect: it resubmits.
      const takenOver = this.store
        .attempts(plan.id)
        .some((attempt) => attempt.state === "accepted" && isTakeoverAttempt(attempt.policy))
      this.hold(
        plan,
        "Combined artifact verification failed",
        takenOver ? ["takeover-submit", "audit", "reconcile", "cancel"] : undefined,
      )
      return
    }
    const planFallow = await this.planFallowReview(
      plan,
      { workspace, artifact, baseCommit: input.baseCommit, sourceGeneration, verificationEpoch },
      fence,
    )
    if (planFallow === "pending") return
    if (!(await artifactUnchanged(workspace, artifact))) {
      this.hold(plan, "Combined candidate changed after verification")
      return
    }
    const missing = await this.missingEvidence(workspace, input.acceptance, receipts)
    if (missing.length) {
      this.hold(plan, `Combined artifact evidence missing: ${missing.join(", ")}`)
      return
    }
    this.store.fenced(this.owner, fence, (db) => {
      if (!acceptedInputsCurrent()) return
      db.query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'accepted'),artifact=?,version=version+1 WHERE id=?",
      ).run(artifact, plan.id)
      this.store.record(plan.id, null, "PLAN_ACCEPTED", {
        artifact,
        checks: receipts,
        ...fallowAcceptance(planFallow),
      })
      this.outcome(
        plan.id,
        {
          status: "accepted",
          artifact,
          evidence: receipts,
          taskIDs: input.integrationOrder,
          ...fallowAcceptance(planFallow),
        },
        true,
      )
    })
  }
  private async reconcileEffect(effect: EffectRow, fence: number) {
    const payload = JSON.parse(effect.payload)
    try {
      if (await this.reconcileEffectByKind(effect, payload, fence)) return
      if (isRerunnableEffect(effect.kind)) {
        this.supersedeEffect(effect, "No receipt was recorded; the check re-runs", fence)
        this.tickRequested = true
        return
      }
      if (effect.state !== "uncertain")
        this.uncertain(
          effect,
          "No conclusive host/artifact receipt; effect was not repeated",
          fence,
        )
    } catch (error) {
      if (effect.state !== "uncertain") this.uncertain(effect, error, fence)
    }
  }

  /** True when the effect's kind settled it; false leaves the generic no-receipt handling to run. */
  private async reconcileEffectByKind(
    effect: EffectRow,
    payload: any,
    fence: number,
  ): Promise<boolean> {
    if (effect.kind === "scope-instruction")
      return this.reconcileScopeInstruction(effect, payload as WorkerInstruction, fence)
    if (effect.kind === "session") return this.reconcileSessionEffect(effect, payload, fence)
    if (effect.kind === "prompt") return this.reconcilePromptEffect(effect, payload, fence)
    if (WORKTREE_EFFECT_KINDS.includes(effect.kind))
      return this.reconcileWorktreeEffect(effect, payload, fence)
    if (
      effect.kind === "mechanical-fix" ||
      effect.kind.startsWith("verify:") ||
      effect.kind.startsWith("graph-verify:")
    )
      return this.reconcileCheckEffect(effect, payload, fence)
    return false
  }

  private async reconcileScopeInstruction(
    effect: EffectRow,
    update: WorkerInstruction,
    fence: number,
  ): Promise<boolean> {
    const attempt = this.store
      .attempts(effect.plan_id)
      .find((item) => item.id === effect.attempt_id)
    const plan = this.store.plan(effect.plan_id)!
    if (
      !attempt ||
      attempt.task_id !== effect.task_id ||
      update.attemptID !== attempt.id ||
      update.sessionID !== attempt.session_id ||
      update.directory !== attempt.workspace ||
      update.projectID !== this.projectID
    )
      throw new Error("Scope instruction no longer matches its owned attempt")
    if (
      plan.state === "cancelling" ||
      terminal.has(plan.state) ||
      !["preparing", "running", "verifying"].includes(attempt.state)
    ) {
      this.receipt(
        effect,
        {
          skipped: true,
          reason: "Attempt no longer executing",
          sessionID: update.sessionID,
          key: update.key,
        },
        fence,
      )
      return true
    }
    await this.host.updateInstruction(update)
    this.receipt(
      effect,
      {
        sessionID: update.sessionID,
        key: update.key,
        nativeEntryConfirmed: true,
        modelConsumption: "unknown",
      },
      fence,
    )
    return true
  }

  private async reconcileSessionEffect(
    effect: EffectRow,
    payload: any,
    fence: number,
  ): Promise<boolean> {
    const session = await this.host.session(payload.sessionID)
    if (!session) return false
    this.receipt(effect, { sessionID: session.id, reconciled: true }, fence)
    return true
  }

  private async reconcilePromptEffect(
    effect: EffectRow,
    payload: any,
    fence: number,
  ): Promise<boolean> {
    const session = await this.host.session(payload.sessionID, { messages: true })
    if (session?.messages.some((m) => m.id === payload.messageID)) {
      this.receipt(
        effect,
        {
          messageID: payload.messageID,
          reconciled: true,
        },
        fence,
      )
      return true
    }
    // These adapter guards throw before ctx.session.prompt. Record the
    // conclusive non-dispatch so reconciliation can retry the same worker.
    if (
      !session?.messages.some((m) => m.id === payload.messageID) &&
      [
        "Worker session is not in its assigned worktree",
        "Worker prompt target is not the exact assigned session and route",
      ].includes(JSON.parse(effect.receipt ?? "{}").error)
    ) {
      this.store.fenced(this.owner, fence, (db) => {
        db.query(
          "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed'),receipt=? WHERE id=?",
        ).run(
          JSON.stringify({
            notSent: true,
            reason: "Native prompt guard prevented dispatch",
          }),
          effect.id,
        )
        db.query("UPDATE runner_attempts SET message_id=? WHERE id=?").run(
          messageID(),
          effect.attempt_id!,
        )
        this.store.record(effect.plan_id, effect.task_id, "PROMPT_NOT_DISPATCHED", {
          effectID: effect.id,
          continuation: "new durable message after native prompt guard",
        })
      })
      return true
    }
    return false
  }

  private async reconcileWorktreeEffect(
    effect: EffectRow,
    payload: any,
    fence: number,
  ): Promise<boolean> {
    const nativeFailure =
      effect.kind === "worktree" || effect.kind === "worktree-recovery"
        ? nativeWorktreeFailureFromReceipt(effect.receipt)
        : undefined
    const startupRecoveryReason = startupWorktreeRecoveryReason(effect, nativeFailure)
    const nativeWorktrees = await this.host.worktrees()
    // A typed native failure is affirmative terminal evidence, not a lost
    // success response. It can never be promoted to a ready workspace.
    if (nativeFailure) return true
    const candidates = await worktreeReconcileCandidates(effect, payload, nativeWorktrees)
    if (candidates.length !== 1) return false
    const workspace = candidates[0]!
    if (effect.attempt_id)
      this.store.fenced(this.owner, fence, (db) =>
        db
          .query("UPDATE runner_attempts SET workspace=? WHERE id=?")
          .run(workspace, effect.attempt_id!),
      )
    this.receipt(effect, { workspace, base: payload.base, reconciled: true }, fence)
    if (effect.kind.startsWith("adoption-") && typeof payload.adoptionID === "string")
      this.store.setAdoptionWorkspace(
        payload.adoptionID,
        effect.kind === "adoption-task-worktree" ? "task" : "combined",
        workspace,
        { owner: this.owner, value: fence },
      )
    if (startupRecoveryReason && effect.attempt_id)
      this.resumeStartupRecovery(effect, fence, workspace, startupRecoveryReason)
    return true
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

  /** Drops the in-memory activity record of a check the reconciler has now settled. */
  private forgetCheckActivity(effect: EffectRow, activityIdentity: unknown) {
    forgetVerificationActivity(
      verificationActivityKey(this.store.repository.path, effect.id),
      fingerprint(activityIdentity),
    )
  }

  /** Settles a check effect from its in-memory activity and the receipt the subprocess left. */
  private async reconcileCheckEffect(
    effect: EffectRow,
    payload: any,
    fence: number,
  ): Promise<boolean> {
    const activityIdentity = { effectID: effect.id, payload: effect.payload }
    const activity = this.checkActivity(effect.id, activityIdentity)
    if (activity?.state === "running") return true
    const check = readCheckReceipt(payload)
    if (check && (await this.checkReceiptMatchesEffect(effect, payload, check)))
      return this.settleMatchedCheck(effect, check, fence, activityIdentity)
    return this.settleFailedCheckActivity(effect, activity, fence, activityIdentity)
  }

  private async checkReceiptMatchesEffect(
    effect: EffectRow,
    payload: any,
    check: CheckReceipt,
  ): Promise<boolean> {
    if (effect.kind !== "mechanical-fix")
      return (
        check.id === payload.check.id &&
        check.artifact === payload.artifact &&
        check.cwd === payload.workspace &&
        check.command === payload.check.command &&
        check.inputIdentity === payload.identity
      )
    const preparation = check.preparation
    const scope = this.store.effectiveWriteScope(effect.task_id!)
    return (
      check.id === payload.check.id &&
      check.command === payload.command &&
      check.cwd === payload.workspace &&
      check.artifact === payload.baseCommit &&
      check.inputIdentity === payload.inputFingerprint &&
      check.environmentIdentity === payload.environmentIdentity &&
      preparation !== undefined &&
      preparation.inputFingerprint === payload.inputFingerprint &&
      JSON.stringify(preparation.paths) === JSON.stringify(payload.paths) &&
      JSON.stringify(preparation.scope) === JSON.stringify(payload.scope) &&
      JSON.stringify(scope) === JSON.stringify(payload.scope) &&
      preparation.resultingFingerprint ===
        (await workingTreeIdentity(payload.workspace, payload.baseCommit)) &&
      !protectedPaths(preparation.paths, this.store.effectiveScope(effect.task_id!)).length
    )
  }

  private settleMatchedCheck(
    effect: EffectRow,
    check: CheckReceipt,
    fence: number,
    activityIdentity: unknown,
  ): boolean {
    const mechanical = effect.kind === "mechanical-fix"
    if (check.aborted) {
      this.uncertain(effect, "Verification was interrupted before completion", fence, { check })
      this.forgetCheckActivity(effect, activityIdentity)
      return true
    }
    if (effect.kind.startsWith("verify:") && effect.attempt_id && effect.task_id)
      this.recordVerificationEvidence(effect, check)
    if (!checkResourcesSettled(check)) {
      this.uncertain(
        effect,
        unsettledCheckError(mechanical ? "Mechanical" : "Verification", check),
        fence,
        { check },
      )
      if (!mechanical) this.forgetCheckActivity(effect, activityIdentity)
      return true
    }
    this.receipt(effect, { check, reconciled: true }, fence)
    this.tickRequested = true
    this.forgetCheckActivity(effect, activityIdentity)
    return true
  }

  private recordVerificationEvidence(effect: EffectRow, check: CheckReceipt) {
    try {
      this.progress.recordVerification(effect.attempt_id!, effect.id, check)
    } catch {
      // The runner receipt remains authoritative if progress annotation fails.
    }
    this.store.atomic((db) =>
      db
        .query(
          "INSERT OR IGNORE INTO runner_evidence(id,plan_id,task_id,attempt_id,assertion_id,kind,artifact,body,created_at) VALUES(?,?,?,?,NULL,'verification',?,?,?)",
        )
        .run(
          effect.id,
          effect.plan_id,
          effect.task_id,
          effect.attempt_id,
          check.artifact,
          JSON.stringify(check),
          Date.now(),
        ),
    )
  }

  /** A check whose activity failed without a matching receipt is uncertain; anything else falls through. */
  private settleFailedCheckActivity(
    effect: EffectRow,
    activity: VerificationActivity<CheckReceipt> | undefined,
    fence: number,
    activityIdentity: unknown,
  ): boolean {
    if (activity?.state !== "failed") return false
    this.uncertain(effect, activity.error, fence)
    this.forgetCheckActivity(effect, activityIdentity)
    return true
  }
}

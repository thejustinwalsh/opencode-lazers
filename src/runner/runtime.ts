import { sameNativeModel } from "./model-route.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { isWorkerAgent, workerAgent } from "./worker-agent.ts"
import type { Database } from "bun:sqlite"
import {
  evaluatePrerequisiteIntegration,
  type PrerequisiteIntegrationRow,
} from "./prerequisite-proof.ts"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { dirname, extname, join, relative, resolve, sep } from "node:path"
import { SessionMessage } from "@opencode/schema/session-message"
import { fingerprint } from "../identity.ts"
import {
  effectiveVerificationCheck,
  verificationCommandFingerprint,
  verificationDeadline as resolveVerificationDeadline,
  verificationCheckWithDefaults,
  verificationReceiptDeadline,
  verificationTimeoutDefaults,
  VerificationTimeoutAmendmentSchema,
} from "./verification-timeout.ts"
import type {
  VerificationDeadline,
  VerificationTimeoutAmendment,
  VerificationTimeoutTarget,
  VerificationTimeoutDefaults,
} from "./verification-timeout.ts"
import type { TaskProposal } from "../task.ts"
import {
  artifactExists,
  ArtifactScopeViolation,
  artifactUnchanged,
  commitIsAncestor,
  changedPaths,
  checkResourcesSettled,
  combineArtifacts,
  commitArtifact,
  git,
  gitAsync,
  reviewedScopeBase,
  runDeclaredCheck,
  runCheck,
  scopeViolations,
  scopePatternsConflict,
  verificationEnvironmentIdentity,
  workingTreeIdentity,
  writeCheckReceipt,
} from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import { checkSucceeded, checkFailureReason } from "./checks.ts"
import { needsMechanicalQualityPreparation } from "./quality-failure.ts"
import type {
  HostSession,
  NativeCleanupSettlement,
  RunnerHost,
  WorkerInstruction,
  WorktreeLocationRetirement,
} from "./host.ts"
import {
  ArchitectContinuityInput,
  CommandInput,
  ModelPolicy,
  PlanInput,
  WorkerPersona,
} from "./schema.ts"
import type { CommandInput as PlanCommand } from "./schema.ts"
import type {
  PlanRow,
  NodeRow,
  AttemptRow,
  EffectRow,
  OutboxRow,
  AdoptionRow,
  AdoptionCheckRow,
  ArchitectRenewalRow,
  ProgressRow,
} from "./store.ts"
import { appendOutboxReceipt, appendRunnerEffectReceipt, RunnerStore } from "./store.ts"
import { outcomeText } from "./outcome.ts"
import { isOwnedOutcomeTranscript, isOwnedQueuedOutcome, parseOutcomeOwnership } from "./inbox.ts"
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
import { canonicalProjectWorktreePath } from "./workspace-location.ts"
import {
  matchesReviewInputAlias,
  observeReviewInput,
  parseReviewInputAlias,
  reviewMetadata,
} from "./review-input.ts"
import type { ReviewInputBinding, ReviewInputEvidence } from "./review-input.ts"
import {
  sourceGuardInstalled,
  samePhysicalWorkspace,
  sourceQuarantine,
  sourceQuarantineVerificationBinding,
  sourceQuarantineVerificationBindingMatches,
  sourceReservationExcluded,
  sourceReviewBinding,
} from "./source-quarantine.ts"
import type { SourceQuarantine, SourceReviewBinding } from "./source-quarantine.ts"
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
  activateRetainedVerificationResources,
  authorizeRetainedVerificationCheckRetry,
  beginRetainedVerificationCheck,
  completeRetainedVerificationCheck,
  createRetainedVerification,
  ensureRetainedVerificationTables,
  hasRetainedVerificationEvidence,
  latestRetainedVerificationGeneration,
  markRetainedVerificationCheckUncertain,
  recordRetainedVerificationEvidence,
  registerRetainedVerificationResources,
  retainedVerification,
  retainedVerificationChecks,
  retainedVerificationsForPlan,
  retainedVerificationsForProject,
  saveRetainedVerification,
  setRetainedVerificationCheckCleanup,
  setRetainedVerificationWorkspace,
  settleRetainedVerificationResources,
  updateRetainedVerificationResourceIdentity,
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
import type {
  RetainedVerification,
  RetainedVerificationCheck,
} from "./retained-verification/schema.ts"
import {
  createRetainedCheckContext,
  observeRetainedCheckContext,
  observeRetainedCheckIsolationWitness,
  removeRetainedCheckContext,
  removeRetainedCheckContextFromWitness,
  removeRetainedCheckSetupResources,
  retainedCheckIsolationWitness,
  retainedTemporaryDirectoryAliasPath,
  RetainedSetupProcessTreeUncertainError,
  retainedVerificationEnvironmentIdentity,
} from "./retained-verification/isolation.ts"
import type {
  RetainedCheckSetupLink,
  RetainedCheckSetupResource,
  RetainedDependencyInstaller,
} from "./retained-verification/isolation.ts"
import { ProbeRepository } from "../verification/probe/store.ts"
import { ResourceRepository } from "../verification/resources/store.ts"
import { retainedVerificationProbeBasis } from "./retained-verification/probe.ts"
import {
  retainedProcedurePlan,
  retainedProjectIdentity,
} from "./retained-verification/procedure.ts"

const terminal = new Set([
  "accepted",
  "failed",
  "cancelled",
  "exhausted",
  "incorporated",
  "integrated",
  "cleanup-blocked",
])
const messageID = () => `msg_${crypto.randomUUID().replaceAll("-", "")}`
const sessionID = () => `ses_${crypto.randomUUID().replaceAll("-", "")}`
const taskStartRequestID = (taskID: string) => `task-start:${taskID}:1`
const isCommitID = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const verificationTimingFields = new Set(["timeoutMs", "inactivityTimeoutMs", "hardTimeoutMs"])
const verificationCheckIdentity = (check: unknown): unknown =>
  isRecord(check)
    ? Object.fromEntries(
        Object.entries(check).filter(([key]) => !verificationTimingFields.has(key)),
      )
    : check
const sameVerificationCheckIdentity = (left: unknown, right: unknown): boolean =>
  fingerprint(verificationCheckIdentity(left)) === fingerprint(verificationCheckIdentity(right))

type CleanupRecoveryAuthorization = {
  schemaVersion: 1
  projectDirectory: string
  planID: string
  planRevision: number
  planArtifact: string | null
  taskID: string
  taskRevision: number
  attemptID: string
  artifact: string
  workspace: string
  sourceEffectID: string
  sessionID: string
  assignedMessageID: string
  owner: string
  ownerEpoch: number
  targetBranch: string
  requestID: string
  reason: string
}

function actualCheckResultFromEffect(effect: EffectRow): CheckReceipt | undefined {
  if (!effect.receipt) return undefined
  try {
    const envelope: unknown = JSON.parse(effect.receipt)
    if (!isRecord(envelope)) return undefined
    if (isRecord(envelope.check)) return envelope.check as unknown as CheckReceipt
    if (isRecord(envelope.result) && isRecord(envelope.result.check))
      return envelope.result.check as unknown as CheckReceipt
    return undefined
  } catch {
    return undefined
  }
}

function interruptedCheckResourcesSettled(receipt: CheckReceipt): boolean {
  return Boolean(
    receipt.processCleanup &&
    !receipt.phases?.some((phase) => !phase.processCleanup) &&
    checkResourcesSettled(receipt),
  )
}

type CombinedVerificationContinuationEffect = {
  id: string
  payloadFingerprint: string
  receiptFingerprint: string
}

type CombinedVerificationContinuationBinding = {
  schema: "lazers-combined-verification-continuation/v1"
  requestID: string
  projectDirectory: string
  projectID: string
  planID: string
  owner: string
  ownerEpoch: number
  planRevision: number
  expectedPlanVersion: number
  resumedPlanVersion: number
  planBodyFingerprint: string
  acceptedArtifacts: Array<{ taskID: string; taskRevision: number; artifact: string }>
  artifact: string
  workspace: string
  sourceGeneration: string | null
  verificationEpoch: number
  interruptedEffects: CombinedVerificationContinuationEffect[]
  settledTimeouts?: CombinedVerificationContinuationEffect[]
}

type CombinedVerificationContinuation = CombinedVerificationContinuationBinding & {
  inputFingerprint: string
}

type PreparedVerificationDeadlineExtension = {
  target: VerificationTimeoutTarget
  deadline: VerificationDeadline
  effectiveInactivityTimeoutMs: number
  effectiveHardTimeoutMs: number
  ownerEpoch: number
  sourceEffect?: {
    id: string
    payloadFingerprint: string
    receiptFingerprint: string
  }
  retained?: {
    operation: RetainedVerification
    check: RetainedVerificationCheck
    receipt: CheckReceipt
    resources: Array<{ resource_name: string; canonical_path: string; state: string }>
  }
}

function requestedVerificationTimeouts(
  command: PlanCommand,
  deadline: VerificationDeadline,
): { inactivityTimeoutMs: number; hardTimeoutMs: number } {
  const inactivityTimeoutMs = command.inactivityTimeoutMs ?? deadline.effectiveInactivityTimeoutMs
  const hardTimeoutMs =
    command.hardTimeoutMs ?? command.timeoutMs ?? deadline.effectiveHardTimeoutMs
  if (
    inactivityTimeoutMs < deadline.effectiveInactivityTimeoutMs ||
    hardTimeoutMs < deadline.effectiveHardTimeoutMs ||
    (inactivityTimeoutMs === deadline.effectiveInactivityTimeoutMs &&
      hardTimeoutMs === deadline.effectiveHardTimeoutMs)
  )
    throw new Error(
      "Verification deadline extension must be strictly larger than at least one effective timeout",
    )
  if (inactivityTimeoutMs > hardTimeoutMs)
    throw new Error("Verification inactivity allowance cannot exceed its hard backstop")
  return { inactivityTimeoutMs, hardTimeoutMs }
}

function parseCombinedVerificationContinuation(
  value: unknown,
): CombinedVerificationContinuation | undefined {
  if (
    !isRecord(value) ||
    value.schema !== "lazers-combined-verification-continuation/v1" ||
    typeof value.requestID !== "string" ||
    typeof value.projectDirectory !== "string" ||
    typeof value.projectID !== "string" ||
    typeof value.planID !== "string" ||
    typeof value.owner !== "string" ||
    !Number.isSafeInteger(value.ownerEpoch) ||
    !Number.isSafeInteger(value.planRevision) ||
    !Number.isSafeInteger(value.expectedPlanVersion) ||
    !Number.isSafeInteger(value.resumedPlanVersion) ||
    typeof value.planBodyFingerprint !== "string" ||
    !Array.isArray(value.acceptedArtifacts) ||
    !value.acceptedArtifacts.every(
      (item) =>
        isRecord(item) &&
        typeof item.taskID === "string" &&
        Number.isSafeInteger(item.taskRevision) &&
        typeof item.artifact === "string",
    ) ||
    typeof value.artifact !== "string" ||
    typeof value.workspace !== "string" ||
    (value.sourceGeneration !== null && typeof value.sourceGeneration !== "string") ||
    !Number.isSafeInteger(value.verificationEpoch) ||
    !Array.isArray(value.interruptedEffects) ||
    !value.interruptedEffects.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.payloadFingerprint === "string" &&
        typeof item.receiptFingerprint === "string",
    ) ||
    (value.settledTimeouts !== undefined &&
      (!Array.isArray(value.settledTimeouts) ||
        !value.settledTimeouts.every(
          (item) =>
            isRecord(item) &&
            typeof item.id === "string" &&
            typeof item.payloadFingerprint === "string" &&
            typeof item.receiptFingerprint === "string",
        ))) ||
    typeof value.inputFingerprint !== "string"
  )
    return undefined
  return value as unknown as CombinedVerificationContinuation
}

function combinedVerificationContinuationFingerprint(
  binding: CombinedVerificationContinuationBinding,
) {
  return fingerprint(binding)
}

/** Activity completion means a receipt exists, not that its process tree is idle. */
function checkSettlementProblem(activity: VerificationActivity): string | undefined {
  if (activity.state === "failed") return errorText(activity.error)
  if (activity.state !== "completed") return "Verification is still running"
  if (activity.metadata.kind === "retained-advance") return undefined
  const receipt = activity.result as CheckReceipt | undefined
  if (!receipt) return "Verification has no final receipt"
  if (!checkResourcesSettled(receipt))
    return `Command exited ${receipt.exitCode ?? "unknown"} with timedOut=${receipt.timedOut}; subprocess cleanup remains uncertain: ${receipt.processCleanup?.detail ?? "process-tree settlement was not confirmed"}`
  return undefined
}
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
const errorText = (error: unknown) =>
  error instanceof Error ? error.message || String(error) : String(error)
function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false
    throw error
  }
}
export const DEFAULT_ARCHITECT_IDLE_WINDOW_MS = 30 * 60 * 1000
// Recheck external/native facts periodically, but don't repeat full safety
// observations on every ordinary scheduler tick when durable facts are stable.
const WORKTREE_CLEANUP_FALLBACK_MS = 60_000

export type TaskRuntimeOptions = {
  architectIdleWindowMs?: number
  verificationTimeoutDefaults?: VerificationTimeoutDefaults
  now?: () => number
  architectPromptHook?: boolean
  requestTick?: () => Promise<void>
  wakeScheduler?: () => void
  retainedDependencyInstaller?: RetainedDependencyInstaller
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
  ownerEpoch: number
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
  ownerEpoch: number
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
  ownerEpoch: number
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
  ownerEpoch: number
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
  "outcome",
  "turn",
  "background",
  "assigned-input",
  "turn-input",
  "background-count",
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

export function architectIdleWindowMs(value: unknown): number {
  if (value === undefined) return DEFAULT_ARCHITECT_IDLE_WINDOW_MS
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("architectIdleWindowMs must be a positive integer number of milliseconds")
  return value
}

export class TaskRuntime {
  readonly owner = crypto.randomUUID()
  readonly progress: ProgressRecorder
  private running = false
  private stopped = false
  private tickRequested = false
  private tickPromise: Promise<void> | undefined
  private readonly idleWaiters: (() => void)[] = []
  private readonly renewalLocks = new Map<string, Promise<void>>()
  private readonly sourceNoticeReconciliationLocks = new Set<string>()
  private readonly retainedVerificationAborts = new Map<string, AbortController>()
  private readonly retainedVerificationRuns = new Map<string, Promise<void>>()
  private readonly terminalRetainedVerificationCleanupChecks = new Map<
    string,
    { generation: number; updatedAt: number; checkedAt: number }
  >()
  private readonly now: () => number
  private readonly architectIdleWindowMs: number
  private readonly verificationTimeoutDefaults: VerificationTimeoutDefaults
  private readonly architectPromptHook: boolean
  private readonly requestTick: () => Promise<void>
  private readonly wakeScheduler: (() => void) | undefined
  private readonly retainedDependencyInstaller: RetainedDependencyInstaller | undefined
  private readonly modelMappingResolver: ModelMappingResolver
  private readonly sourceEpochs = new Map<string, number>()
  private sourceResyncPending = false
  constructor(
    readonly store: RunnerStore,
    readonly host: RunnerHost,
    readonly projectID: string,
    progress?: ProgressRecorder,
    options: TaskRuntimeOptions = {},
  ) {
    this.progress = progress ?? new ProgressRecorder(store, projectID)
    this.now = options.now ?? Date.now
    this.architectIdleWindowMs = architectIdleWindowMs(options.architectIdleWindowMs)
    this.verificationTimeoutDefaults = verificationTimeoutDefaults(
      options.verificationTimeoutDefaults,
    )
    this.architectPromptHook = options.architectPromptHook ?? false
    this.requestTick = options.requestTick ?? (() => this.tick())
    this.wakeScheduler = options.wakeScheduler
    this.retainedDependencyInstaller = options.retainedDependencyInstaller
    this.modelMappingResolver = new ModelMappingResolver(new ModelMappingStore(store.repository))
    for (const id of store.architectSourceSessionIDs()) this.sourceEpochs.set(id, 0)
  }
  get directory() {
    return this.store.repository.projectDirectory
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
    writeCheckReceipt(receiptPath, annotated)
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

  private async finalizeRetainedVerificationCancellation(operationID: string): Promise<void> {
    this.retainedVerificationAborts.get(operationID)?.abort()
    const activities = await abortVerificationActivities(
      (activity) =>
        activity.metadata.projectDirectory === this.directory &&
        ["retained", "retained-advance"].includes(String(activity.metadata.kind)) &&
        activity.metadata.operationID === operationID,
    )
    await this.retainedVerificationRuns.get(operationID)?.catch(() => undefined)
    for (const activity of activities)
      if (activity.metadata.kind === "retained")
        await this.settleCancelledRetainedActivity(activity)
    await this.recoverCancelledRetainedChecks(operationID)
    const uncertain = activities.find((activity) => checkSettlementProblem(activity))
    const problem = uncertain
      ? checkSettlementProblem(uncertain)
      : this.retainedCheckSettlementProblem(operationID)
    if (problem) throw new Error(`Retained verification cancellation remains uncertain: ${problem}`)
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
          this.adoptionCheckReceiptMatches(receipt, row, check)
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
        generation: operation.generation,
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
      !Number.isSafeInteger(metadata.generation) ||
      (metadata.phase !== "task" && metadata.phase !== "combined") ||
      typeof metadata.checkID !== "string" ||
      typeof metadata.workspace !== "string" ||
      typeof metadata.artifact !== "string" ||
      typeof metadata.contextPath !== "string"
    )
      return
    const operationID = metadata.operationID
    const phase = metadata.phase
    const checkID = metadata.checkID
    const generation = metadata.generation as number
    const operation = this.store.atomic((db) => retainedVerification(db, operationID))
    const row = this.store.atomic((db) =>
      retainedVerificationChecks(db, operationID, phase).find(
        (candidate) => candidate.checkID === checkID,
      ),
    )
    if (!operation || operation.generation !== generation || !row) return
    const identity = {
      operationID,
      generation,
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
          row.workspace === this.retainedVerificationIsolatedWorkspace(operation, phase) &&
          row.artifact === (phase === "task" ? operation.artifact : operation.combinedArtifact) &&
          observeRetainedCheckIsolationWitness(
            row.contextPath,
            activity ? metadata.isolation : receipt.isolation,
            {
              operationID,
              generation,
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
          ) &&
          this.retainedVerificationCheckReceipt(
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
      this.completeRetainedCheck(operation, phase, checkID, receipt)
      if (checkResourcesSettled(receipt))
        await this.cleanupRetainedCheckResources(
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
            generation,
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
        `retained:${operationID}:${generation}:${phase}:${checkID}`,
      ),
      fingerprint(identity),
    )
  }

  private retainedVerificationWorkspacePath(operationID: string, phase: "task" | "combined") {
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

  private adoptionInputFingerprint(input: {
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
  }) {
    const task = this.store.repository.get(input.taskID)
    if (!task) throw new Error("Adoption task is missing")
    return fingerprint({
      projectID: this.projectID,
      planID: input.plan.id,
      planRevision: input.plan.revision,
      planVersion: input.originalPlanVersion,
      planBody: input.plan.body,
      owner: input.plan.owner,
      taskID: input.taskID,
      taskRevision: input.taskRevision,
      taskProposal: task.proposal,
      attemptID: input.attemptID,
      nodeState: input.nodeState,
      attemptState: input.attemptState,
      oldArtifact: input.oldArtifact,
      descendantCommit: input.descendantCommit,
      targetBranch: input.targetBranch,
      landingHead: input.landingHead,
      reviewedBaseline: input.reviewedBaseline,
      candidateTree: input.candidateTree,
      combinedArtifact: input.combinedArtifact,
      effectiveWriteScope: this.store.effectiveWriteScope(input.taskID),
      reason: input.reason,
      environmentIdentity: input.environmentIdentity,
    })
  }

  private currentAdoptionInputFingerprint(plan: PlanRow, adoption: AdoptionRow) {
    return this.adoptionInputFingerprint({
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
    })
  }

  private conflictingActiveAttempt(taskID: string): AttemptRow | undefined {
    const scope = this.store.effectiveWriteScope(taskID)
    return this.store
      .activeProjectAttempts()
      .find(
        (attempt) =>
          ["preparing", "running", "verifying"].includes(attempt.state) &&
          (attempt.workspace === this.directory ||
            scopePatternsConflict(scope, this.store.effectiveWriteScope(attempt.task_id))),
      )
  }

  private reviewedAdoptionBaseline(targetBranch: string, oldArtifact: string, candidate: string) {
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
    const firstParent = git(this.directory, ["rev-list", "--first-parent", candidate])
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
        git(this.directory, ["merge-base", "--is-ancestor", oldArtifact, payload.head])
        git(this.directory, ["merge-base", "--is-ancestor", payload.artifact, payload.head])
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
    const reviewed = this.reviewedAdoptionBaseline(branch, attempt.base_commit, artifact)
    const base = await reviewedScopeBase(this.directory, attempt.base_commit, artifact, reviewed)
    const paths = git(this.directory, ["diff", "--name-only", "--no-renames", "-z", base, artifact])
      .split("\0")
      .filter(Boolean)
    return scopeViolations(paths, this.store.effectiveWriteScope(attempt.task_id))
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
      !this.backgroundBlockReason(worker, attempt, true)
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
    if (
      caller !== plan.owner ||
      !this.validArchitect(ownerSession) ||
      ownerSession.id !== plan.owner
    )
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
    const scopes = this.store.effectiveWriteScope(command.taskID)
    if (
      this.store
        .activeAdoptions()
        .some((adoption) =>
          scopePatternsConflict(scopes, this.store.effectiveWriteScope(adoption.task_id)),
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

    const branch = git(this.directory, ["branch", "--show-current"])
    const head = git(this.directory, ["rev-parse", "HEAD"])
    if (branch !== command.targetBranch || command.descendantCommit !== head)
      throw new Error("Reviewed descendant must be the exact current HEAD of targetBranch")
    if (
      (await gitAsync(this.directory, ["status", "--porcelain", "--untracked-files=all"])) ||
      git(this.directory, ["ls-files", "-u", "-z"])
    )
      throw new Error("Dirty or unmerged candidate checkout cannot be adopted")
    const oldArtifact = git(this.directory, ["rev-parse", `${command.artifact}^{commit}`])
    const descendantCommit = git(this.directory, [
      "rev-parse",
      `${command.descendantCommit}^{commit}`,
    ])
    if (oldArtifact !== command.artifact || descendantCommit !== command.descendantCommit)
      throw new Error("Adoption artifacts must be exact full commit identities")
    if (oldArtifact === descendantCommit)
      throw new Error("Reviewed candidate must be a strict descendant of the old artifact")
    git(this.directory, ["merge-base", "--is-ancestor", oldArtifact, descendantCommit])
    const reviewedBaseline = this.reviewedAdoptionBaseline(branch, oldArtifact, descendantCommit)
    const violations = await this.adoptionArtifactScopeViolations(latest, oldArtifact, branch)
    if (violations.length)
      throw new Error(
        `Worker artifact contains changes outside the task's authorized scope: ${violations.slice(0, 20).join(", ")}`,
      )
    const candidateTree = git(this.directory, ["rev-parse", `${descendantCommit}^{tree}`])
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
      repair.owner !== plan.owner ||
      repair.ownerEpoch !== this.store.planControlEpoch(plan.id) ||
      repair.sessionID !== attempt.session_id ||
      repair.workspace !== attempt.workspace ||
      sourceQuarantine(this.store, attempt.id)
    )
      return false
    try {
      const route = ModelPolicy.parse(JSON.parse(attempt.policy).model)
      const repairRoute = ModelPolicy.parse(repair.route)
      const planRoute = plan.model ? ModelPolicy.parse(JSON.parse(plan.model)) : undefined
      if (!this.sameModel(route, repairRoute) || !this.sameModel(route, planRoute)) return false
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
      if (
        worker?.background?.state === "observed" &&
        (worker.background.count !== 0 || worker.background.inputID !== attempt.message_id)
      )
        throw new Error("Retained repair has unresolved background work or input lineage")
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
          occupiesDestination(candidate.taskWorkspace) ||
          occupiesDestination(candidate.combinedWorkspace),
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
    if (
      caller !== plan.owner ||
      !this.validArchitect(ownerSession) ||
      ownerSession.id !== plan.owner ||
      command.projectID !== this.projectID
    )
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
      task.provenance.projectID !== this.projectID ||
      task.provenance.projectDirectory !== this.directory ||
      this.store.repository.taskDisposition(task.id)
    )
      throw new Error(
        "Retained verification must name the current task revision and latest original attempt",
      )
    const stoppedPlan = ["blocked", "accepted", "cleanup-blocked"].includes(plan.state)
    const quarantine = sourceQuarantine(this.store, attempt.id)
    const sourceQuarantineBinding = quarantine
      ? sourceQuarantineVerificationBinding(this.store, {
          planID: plan.id,
          owner: caller,
          attempt,
          artifact: command.artifact,
        })
      : undefined
    if (quarantine && !sourceQuarantineBinding)
      throw new Error(
        "Retained verification requires the exact sealed source-quarantined verifying candidate",
      )
    if (!stoppedPlan && plan.state !== "running")
      throw new Error("Retained verification requires a stopped or accepted plan")
    if (plan.state === "running" && !sourceQuarantineBinding)
      throw new Error(
        "Running-plan retained verification requires the exact sealed source-quarantined verifying candidate",
      )
    if (sourceQuarantineBinding && node.state !== "verifying")
      throw new Error("Sealed source-quarantined verification requires the exact verifying task")
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
      realpathSync(git(attempt.workspace, ["rev-parse", "--show-toplevel"])) !== originalWorkspace
    )
      throw new Error("Original attempt workspace is not a canonical repository checkout")
    if (originalWorkspace !== realpathSync(this.directory)) {
      const worktrees = await this.host.worktrees()
      if (!worktrees.some((workspace) => samePhysicalWorkspace(workspace, originalWorkspace)))
        throw new Error(
          "Original attempt checkout is not positively owned by the native worktree adapter",
        )
    }
    if (git(attempt.workspace, ["rev-parse", `${command.artifact}^{commit}`]) !== command.artifact)
      throw new Error(
        "Candidate must be an exact committed Git identity in the original attempt repository",
      )
    if (
      (attempt.artifact === null || repairingCandidate) &&
      git(attempt.workspace, ["rev-parse", "HEAD"]) !== command.artifact
    )
      throw new Error(
        "Unrecorded candidate must be the exact committed HEAD of the original attempt",
      )
    if (repairBinding) {
      if (!commitIsAncestor(attempt.workspace, repairBinding.previousArtifact, command.artifact))
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
    if (!commitIsAncestor(attempt.workspace, attempt.base_commit, command.artifact))
      throw new Error("Candidate is not based on the original attempt's committed baseline")
    const changed = git(attempt.workspace, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      attempt.base_commit,
      command.artifact,
    ])
      .split("\0")
      .filter(Boolean)
    const violations = scopeViolations(changed, this.store.effectiveWriteScope(task.id))
    if (violations.length)
      throw new Error(
        `Retained candidate contains out-of-scope changes: ${violations.slice(0, 20).join(", ")}`,
      )

    const nodes = this.store.nodes(plan.id)
    const branches = input.integrationOrder.map((taskID) => {
      if (taskID === task.id) return command.artifact!
      const other = nodes.find((item) => item.task_id === taskID)
      return other?.artifact && ["accepted", "incorporated"].includes(other.state)
        ? other.artifact
        : null
    })
    let combinedArtifact: string | null = null
    if (branches.every((branch): branch is string => branch !== null)) {
      try {
        combinedArtifact = await combineArtifacts(this.directory, input.baseCommit, branches)
      } catch {
        // Task acceptance is independent; the ordinary plan-ready integration
        // path will report a combined artifact conflict after this task passes.
      }
    }
    const generation = this.store.atomic((db) => {
      ensureRetainedVerificationTables(db)
      return latestRetainedVerificationGeneration(db, this.directory, plan.id, task.id) + 1
    })
    const environmentIdentity = retainedVerificationEnvironmentIdentity()
    const inputFingerprint = fingerprint({
      projectID: this.projectID,
      projectDirectory: this.directory,
      planID: plan.id,
      planRevision: plan.revision,
      planVersion: plan.version,
      planBody: plan.body,
      owner: caller,
      ownerEpoch: this.store.planControlEpoch(plan.id),
      taskID: task.id,
      taskRevision: task.revision,
      taskProposal: task.proposal,
      attemptID: attempt.id,
      originalSessionID: attempt.session_id,
      originalMessageID: attempt.message_id,
      originalWorkspace,
      candidate: command.artifact,
      ...(repairBinding ? { repair: repairBinding } : {}),
      combinedArtifact,
      effectiveWriteScope: this.store.effectiveWriteScope(task.id),
      verification: { task: task.proposal.verification, combined: input.verification },
      acceptance: { task: task.proposal.acceptance, combined: input.acceptance },
      sourceQuarantine: sourceQuarantineBinding ?? null,
      environmentIdentity,
      reason: command.reason,
    })
    const seed = {
      schemaVersion: 1 as const,
      id,
      generation,
      projectID: this.projectID,
      projectDirectory: this.directory,
      planID: plan.id,
      planRevision: plan.revision,
      planVersion: plan.version,
      owner: caller,
      ownerEpoch: this.store.planControlEpoch(plan.id),
      taskID: task.id,
      taskRevision: task.revision,
      attemptID: attempt.id,
      originalSessionID: attempt.session_id,
      originalMessageID: attempt.message_id,
      originalWorkspace: originalWorkspace,
      artifact: command.artifact,
      ...(sourceQuarantineBinding ? { sourceQuarantine: sourceQuarantineBinding } : {}),
      ...(repairBinding ? { repair: repairBinding } : {}),
      combinedArtifact,
      combinedInputFingerprint: combinedArtifact ? inputFingerprint : null,
      taskWorkspace,
      taskWorkspaceState: null,
      combinedWorkspace: combinedArtifact
        ? this.retainedVerificationWorkspacePath(id, "combined")
        : null,
      combinedWorkspaceState: null,
      inputFingerprint,
      environmentIdentity,
      reason: command.reason,
      state: "pending" as const,
      holdReason: null,
      cleanupState: "pending" as const,
      createdAt: this.now(),
      updatedAt: this.now(),
    }
    return seed
  }

  private hasSettledVerificationTimeout(plan: PlanRow, attempt: AttemptRow) {
    if (plan.state !== "blocked" || !attempt.artifact) return false
    return this.store.effects(plan.id).some((effect) => {
      if (
        effect.attempt_id !== attempt.id ||
        !effect.kind.startsWith("verify:") ||
        effect.state !== "completed" ||
        !effect.receipt
      )
        return false
      const { check } = JSON.parse(effect.receipt) as { check?: CheckReceipt }
      return Boolean(
        check?.timedOut &&
        check.cwd === attempt.workspace &&
        check.artifact === attempt.artifact &&
        interruptedCheckResourcesSettled(check) &&
        plan.reason === checkFailureReason(check),
      )
    })
  }

  private hasSettledHumanEvidenceHold(plan: PlanRow, attempt: AttemptRow): boolean {
    const artifact = attempt.artifact
    if (
      plan.state !== "blocked" ||
      !artifact ||
      !plan.reason?.startsWith("Required evidence missing:")
    )
      return false
    const proposal = this.store.repository.get(attempt.task_id)?.proposal
    if (!proposal) return false
    const effects = this.store.effects(plan.id).filter((effect) => effect.attempt_id === attempt.id)
    if (effects.some((effect) => ["intended", "uncertain"].includes(effect.state))) return false
    const repairID: string | undefined = this.retainedRepairGeneration(plan.id, attempt.task_id)
    const receipts: CheckReceipt[] = []
    for (const check of proposal.verification) {
      const effect: EffectRow | undefined = effects.findLast((item): boolean => {
        if (item.kind !== `verify:${check.id}`) return false
        const payload = JSON.parse(item.payload)
        return (
          payload.artifact === artifact &&
          (payload.repairID ?? undefined) === repairID &&
          sameVerificationCheckIdentity(payload.check, check)
        )
      })
      const receipt: CheckReceipt | undefined =
        effect?.state === "completed" && effect.receipt
          ? (JSON.parse(effect.receipt) as { check?: CheckReceipt }).check
          : undefined
      if (
        !receipt ||
        receipt.id !== check.id ||
        receipt.cwd !== attempt.workspace ||
        receipt.artifact !== artifact ||
        receipt.command !== check.command ||
        !checkSucceeded(receipt) ||
        !checkResourcesSettled(receipt)
      )
        return false
      receipts.push(receipt)
    }
    const missing = this.missingEvidence(
      plan.id,
      attempt.task_id,
      artifact,
      attempt.workspace,
      proposal.acceptance,
      receipts,
      undefined,
      repairID,
    )
    return (
      missing.length > 0 &&
      missing.every((item) => item.endsWith(":human")) &&
      plan.reason === `Required evidence missing: ${missing.join(", ")}`
    )
  }

  private cancelledRetainedTimeoutMatchesHold(
    operation: RetainedVerification,
    timeoutReason: string,
  ): boolean {
    const events = this.store.activity(operation.planID, operation.taskID).flatMap((event) => {
      if (!event.payload) return []
      try {
        const payload: unknown = JSON.parse(event.payload)
        return isRecord(payload) &&
          payload.operationID === operation.id &&
          payload.generation === operation.generation
          ? [{ ...event, payload }]
          : []
      } catch {
        return []
      }
    })
    const cancelled = events.findLast((event) => event.event === "RETAINED_VERIFICATION_CANCELLED")
    if (
      !cancelled ||
      cancelled.payload.source !== "owner-command" ||
      cancelled.payload.previousState !== "held" ||
      cancelled.payload.previousHoldReason !== timeoutReason ||
      cancelled.payload.reason !== operation.holdReason
    )
      return false
    const held = events.findLast(
      (event) => event.event === "RETAINED_VERIFICATION_HELD" && event.id < cancelled.id,
    )
    if (!held || held.payload.reason !== timeoutReason) return false
    const laterStateChanges = events.filter(
      (event) =>
        event.id > held.id &&
        event.id < cancelled.id &&
        [
          "RETAINED_VERIFICATION_HELD",
          "RETAINED_VERIFICATION_CANCELLED",
          "RETAINED_TASK_CANDIDATE_ACCEPTED",
        ].includes(event.event),
    )
    return laterStateChanges.length === 0
  }

  private async prepareRetainedVerificationDeadlineContinuation(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    input: ReturnType<typeof PlanInput.parse>,
  ): Promise<PreparedVerificationDeadlineExtension> {
    if (
      !command.retainedVerificationID ||
      !command.retainedGeneration ||
      !command.taskID ||
      !command.taskRevision ||
      !command.attemptID ||
      !command.verificationPhase ||
      !command.checkID
    )
      throw new Error(
        "Retained timing continuation requires exact operation, generation and candidate bindings",
      )
    const operation = this.store.atomic((db) =>
      retainedVerification(db, command.retainedVerificationID!),
    )
    const task = this.store.repository.get(command.taskID)
    const attempt = this.store
      .attempts(plan.id)
      .filter((candidate) => candidate.task_id === command.taskID)
      .at(-1)
    const node = this.store.nodes(plan.id).find((candidate) => candidate.task_id === command.taskID)
    if (
      !operation ||
      operation.generation !== command.retainedGeneration ||
      !["held", "cancelled"].includes(operation.state) ||
      operation.planID !== plan.id ||
      operation.projectID !== this.projectID ||
      operation.projectDirectory !== this.directory ||
      operation.planRevision !== plan.revision ||
      plan.owner !== caller ||
      operation.taskID !== command.taskID ||
      operation.taskRevision !== command.taskRevision ||
      operation.attemptID !== command.attemptID ||
      !task ||
      !node ||
      !attempt ||
      attempt.id !== operation.attemptID ||
      task.revision !== operation.taskRevision ||
      input.nodes.find((entry) => entry.taskID === task.id)?.revision !== task.revision ||
      task.provenance.projectID !== this.projectID ||
      task.provenance.projectDirectory !== this.directory ||
      this.store.repository.taskDisposition(task.id) !== undefined ||
      attempt.session_id !== operation.originalSessionID ||
      attempt.message_id !== operation.originalMessageID ||
      realpathSync(attempt.workspace) !== operation.originalWorkspace ||
      !["running", "blocked", "accepted", "cleanup-blocked"].includes(plan.state) ||
      (operation.sourceQuarantine
        ? !this.sourceQuarantinePlanVersionCurrent(operation, plan)
        : operation.planVersion !== plan.version)
    )
      throw new Error(
        "Retained check timing continuation no longer matches the current owner and candidate",
      )
    if (
      operation.repair &&
      (!this.retainedRepairCandidateCurrent(plan, attempt, operation.repair) ||
        ![operation.repair.previousArtifact, operation.artifact].includes(
          attempt.artifact ?? operation.artifact,
        ))
    )
      throw new Error("Retained repaired candidate authority changed before continuation")
    const phase = command.verificationPhase
    if (
      operation.sourceQuarantine &&
      (attempt.state !== "verifying" ||
        (phase === "task"
          ? node.state !== "verifying"
          : node.state !== "accepted" || !this.retainedTaskCandidateAccepted(operation)) ||
        !sourceQuarantineVerificationBindingMatches(this.store, {
          planID: plan.id,
          owner: caller,
          attempt,
          artifact: operation.artifact,
          expected: operation.sourceQuarantine,
        }))
    )
      throw new Error("Retained source-quarantine binding changed before continuation")

    const phaseArtifact = phase === "task" ? operation.artifact : operation.combinedArtifact
    const phaseWorkspace = this.retainedVerificationIsolatedWorkspace(operation, phase)
    const phaseWorkspaceState =
      phase === "task" ? operation.taskWorkspaceState : operation.combinedWorkspaceState
    const nativeWorkspaces = phaseWorkspace ? await this.host.worktrees() : []
    const gitWorkspaces = phaseWorkspace
      ? git(this.directory, ["worktree", "list", "--porcelain"])
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => resolve(line.slice("worktree ".length)))
      : []
    if (
      !phaseArtifact ||
      command.artifact !== phaseArtifact ||
      !phaseWorkspace ||
      phaseWorkspaceState !== "owned" ||
      !existsSync(phaseWorkspace) ||
      !nativeWorkspaces.some((workspace) => samePhysicalWorkspace(workspace, phaseWorkspace)) ||
      !gitWorkspaces.some((workspace) => samePhysicalWorkspace(workspace, phaseWorkspace)) ||
      git(phaseWorkspace, ["rev-parse", "HEAD"]) !== phaseArtifact ||
      !artifactUnchanged(phaseWorkspace, phaseArtifact)
    )
      throw new Error(
        "Retained timing continuation requires the unchanged exact candidate workspace",
      )
    if (phase === "combined") {
      if (!this.retainedTaskCandidateAccepted(operation))
        throw new Error("Combined-check continuation requires the original task acceptance")
      const artifacts = this.acceptedCombinedArtifacts(plan, input, operation)
      const currentCombinedArtifact = await combineArtifacts(
        this.directory,
        input.baseCommit,
        artifacts.map((item) => item.artifact),
      )
      if (currentCombinedArtifact !== operation.combinedArtifact)
        throw new Error("Retained combined candidate no longer matches its accepted task artifacts")
    } else if (this.retainedTaskCandidateAccepted(operation)) {
      throw new Error("An accepted retained task candidate cannot restart its task checks")
    }

    const checks = phase === "task" ? task.proposal.verification : input.verification
    const authoredCheck = checks.find((check) => check.id === command.checkID)
    if (!authoredCheck)
      throw new Error("Retained timing continuation does not name a declared phase check")
    const check = this.store.atomic((db) =>
      retainedVerificationChecks(db, operation.id, phase).find(
        (candidate) => candidate.checkID === authoredCheck.id,
      ),
    )
    if (
      !check ||
      check.state !== "completed" ||
      check.cleanupState !== "complete" ||
      check.workspace !== phaseWorkspace ||
      check.artifact !== phaseArtifact ||
      !check.receipt
    )
      throw new Error("Retained timing continuation requires the exact completed check receipt")
    let previousCheck: unknown
    try {
      previousCheck = JSON.parse(check.checkJSON) as unknown
    } catch {
      previousCheck = undefined
    }
    if (
      !isRecord(previousCheck) ||
      previousCheck.id !== authoredCheck.id ||
      previousCheck.command !== authoredCheck.command
    )
      throw new Error("Retained timing continuation does not match the current declared command")
    let rawReceipt: unknown
    try {
      rawReceipt = JSON.parse(check.receipt) as unknown
    } catch {
      rawReceipt = undefined
    }
    const receipt = this.retainedVerificationCheckReceipt(
      rawReceipt,
      operation,
      phase,
      authoredCheck,
      phaseWorkspace,
      phaseArtifact,
      check.environmentIdentity,
    )
    const exactTimeoutHold = receipt
      ? operation.state === "held"
        ? operation.holdReason === checkFailureReason(receipt)
        : this.cancelledRetainedTimeoutMatchesHold(operation, checkFailureReason(receipt))
      : false
    if (
      !receipt ||
      receipt.environmentIdentity !== check.environmentIdentity ||
      !receipt.timedOut ||
      receipt.aborted === true ||
      !["inactivity", "hard-backstop", undefined, null].includes(receipt.stopCause) ||
      !checkResourcesSettled(receipt) ||
      !exactTimeoutHold
    )
      throw new Error(
        "Retained check is not the exact settled timeout failure holding this operation",
      )
    const resources = this.store.atomic((db) =>
      db
        .query<
          { resource_name: string; canonical_path: string; state: string },
          [string, string, string]
        >(
          `SELECT resource_name,canonical_path,state FROM runner_retained_verification_resources
           WHERE operation_id=? AND phase=? AND check_id=? ORDER BY resource_name`,
        )
        .all(operation.id, phase, authoredCheck.id),
    )
    const outstandingResources = this.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            `SELECT COUNT(*) AS count FROM runner_retained_verification_resources
           WHERE operation_id=? AND state<>'removed'`,
          )
          .get(operation.id)?.count ?? 0,
    )
    if (
      !resources.length ||
      resources.some((resource) => resource.state !== "removed") ||
      outstandingResources !== 0
    )
      throw new Error("Retained check resource obligations are not conclusively settled")
    if (
      verificationActivitiesForDatabase(this.store.repository.path).some(
        (activity) =>
          activity.metadata.operationID === operation.id && activity.state === "running",
      )
    )
      throw new Error("A live retained check activity prevents timing continuation")
    if (
      this.store
        .atomic((db) => activeRetainedVerifications(db, this.directory, plan.id))
        .some((candidate) => candidate.id !== operation.id)
    )
      throw new Error("A different retained verification authority prevents timing continuation")

    const target: VerificationTimeoutTarget = {
      ...this.verificationTarget(
        plan,
        phase,
        authoredCheck,
        phaseArtifact,
        phase === "task" ? operation.taskID : null,
        phase === "task" ? operation.taskRevision : null,
        phase === "task" ? operation.attemptID : null,
      ),
      retainedVerificationID: operation.id,
      retainedGeneration: operation.generation,
      retainedTaskID: operation.taskID,
      retainedTaskRevision: operation.taskRevision,
      retainedAttemptID: operation.attemptID,
    }
    const deadline = this.verificationDeadline(target)
    const requested = requestedVerificationTimeouts(command, deadline)
    return {
      target,
      deadline,
      effectiveInactivityTimeoutMs: requested.inactivityTimeoutMs,
      effectiveHardTimeoutMs: requested.hardTimeoutMs,
      ownerEpoch: this.store.planControlEpoch(plan.id),
      retained: { operation, check, receipt, resources },
    }
  }

  private async prepareVerificationDeadlineExtension(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ): Promise<PreparedVerificationDeadlineExtension> {
    if (
      command.action !== "extend-verification-deadline" ||
      !command.projectID ||
      !command.planRevision ||
      !command.verificationPhase ||
      !command.checkID ||
      (command.timeoutMs === undefined &&
        command.inactivityTimeoutMs === undefined &&
        command.hardTimeoutMs === undefined) ||
      !command.artifact ||
      !command.reason?.trim()
    )
      throw new Error("Verification deadline extension requires every exact check binding")
    if (
      caller !== plan.owner ||
      !this.validArchitect(ownerSession) ||
      ownerSession.id !== plan.owner ||
      ownerSession.projectID !== this.projectID ||
      command.projectID !== this.projectID
    )
      throw new Error("Verification deadline extension requires the current same-project Architect")
    const retainedContinuation = command.retainedVerificationID !== undefined
    if (
      plan.revision !== command.planRevision ||
      (!retainedContinuation && (plan.state !== "blocked" || plan.artifact !== null)) ||
      (retainedContinuation &&
        !["running", "blocked", "accepted", "cleanup-blocked"].includes(plan.state))
    )
      throw new Error("Verification deadline extension requires the exact stopped plan revision")
    if (this.store.activeAdoptions(plan.id).length)
      throw new Error("An active descendant adoption prevents verification deadline extension")
    if (
      this.store
        .atomic((db) => activeRetainedVerifications(db, this.directory, plan.id))
        .some((operation) => operation.id !== command.retainedVerificationID)
    )
      throw new Error("An active retained verification prevents verification deadline extension")
    if (
      verificationActivitiesForDatabase(this.store.repository.path).some(
        (activity) => activity.metadata.planID === plan.id && activity.state === "running",
      )
    )
      throw new Error("A live verification activity prevents verification deadline extension")
    const effects = this.store.effects(plan.id)
    if (
      !retainedContinuation &&
      effects.some((effect) => ["intended", "uncertain"].includes(effect.state))
    )
      throw new Error("Unresolved effects prevent verification deadline extension")

    const input = PlanInput.parse(JSON.parse(plan.body))
    if (retainedContinuation)
      return this.prepareRetainedVerificationDeadlineContinuation(plan, command, caller, input)
    let target: VerificationTimeoutTarget
    let authoredCheck: TaskProposal["verification"][number] | undefined
    let taskWorkspace: string | undefined
    let attempt: AttemptRow | undefined
    if (command.verificationPhase === "task") {
      if (!command.taskID || !command.taskRevision || !command.attemptID)
        throw new Error("Task-check deadline extension requires an exact task attempt")
      const task = this.store.repository.get(command.taskID)
      const node = this.store
        .nodes(plan.id)
        .find((candidate) => candidate.task_id === command.taskID)
      attempt = this.store
        .attempts(plan.id)
        .filter((candidate) => candidate.task_id === command.taskID)
        .at(-1)
      if (
        !task ||
        !node ||
        !attempt ||
        attempt.id !== command.attemptID ||
        attempt.state !== "verifying" ||
        node.state !== "verifying" ||
        task.revision !== command.taskRevision ||
        input.nodes.find((candidate) => candidate.taskID === task.id)?.revision !== task.revision ||
        task.provenance.projectID !== this.projectID ||
        task.provenance.projectDirectory !== this.directory ||
        this.store.repository.taskDisposition(task.id) !== undefined ||
        attempt.artifact !== command.artifact ||
        node.artifact !== command.artifact ||
        !existsSync(attempt.workspace) ||
        git(attempt.workspace, ["rev-parse", "HEAD"]) !== command.artifact ||
        !artifactUnchanged(attempt.workspace, command.artifact)
      )
        throw new Error(
          "Task, latest attempt or unchanged candidate no longer matches the extension",
        )
      taskWorkspace = attempt.workspace
      authoredCheck = task.proposal.verification.find(
        (candidate) => candidate.id === command.checkID,
      )
      if (!authoredCheck) throw new Error("Deadline extension does not name a declared task check")
      target = this.verificationTarget(
        plan,
        "task",
        authoredCheck,
        command.artifact,
        task.id,
        task.revision,
        attempt.id,
      )
    } else {
      if (command.taskID !== undefined || command.taskRevision !== undefined || command.attemptID)
        throw new Error("Combined deadline extension cannot target a task attempt")
      const acceptedArtifacts = this.acceptedCombinedArtifacts(plan, input)
      const artifact = await combineArtifacts(
        this.directory,
        input.baseCommit,
        acceptedArtifacts.map((item) => item.artifact),
      )
      if (artifact !== command.artifact)
        throw new Error(
          "Combined deadline extension candidate is no longer the exact accepted result",
        )
      authoredCheck = input.verification.find((candidate) => candidate.id === command.checkID)
      if (!authoredCheck)
        throw new Error("Deadline extension does not name a declared combined check")
      target = this.verificationTarget(plan, "combined", authoredCheck, artifact, null, null, null)
    }

    const deadline = this.verificationDeadline(target)
    const requested = requestedVerificationTimeouts(command, deadline)
    const prefix = target.phase === "task" ? "verify:" : "graph-verify:"
    const taskID = target.taskID
    const attemptID = target.attemptID
    const source = effects.toReversed().find((effect) => {
      if (
        effect.kind !== `${prefix}${target.checkID}` ||
        effect.task_id !== taskID ||
        effect.attempt_id !== attemptID
      )
        return false
      try {
        const payload: unknown = JSON.parse(effect.payload)
        return Boolean(
          isRecord(payload) &&
          payload.artifact === target.artifact &&
          payload.identity &&
          typeof payload.workspace === "string" &&
          isRecord(payload.check) &&
          payload.check.id === target.checkID &&
          payload.check.command === target.command,
        )
      } catch {
        return false
      }
    })
    if (!source || source.state !== "completed" || !source.receipt)
      throw new Error(
        "Deadline extension requires a conclusive settled timeout receipt for this check",
      )
    const payload = JSON.parse(source.payload) as {
      artifact?: unknown
      identity?: unknown
      workspace?: unknown
      check?: {
        id?: unknown
        command?: unknown
        timeoutMs?: unknown
        inactivityTimeoutMs?: unknown
        hardTimeoutMs?: unknown
      }
      verificationDeadline?: {
        authoredTimeoutMs?: unknown
        effectiveTimeoutMs?: unknown
        effectiveInactivityTimeoutMs?: unknown
        effectiveHardTimeoutMs?: unknown
        amendmentID?: unknown
        policyRevision?: unknown
      }
    }
    const actual = actualCheckResultFromEffect(source)
    const recordedEffectiveHard =
      payload.verificationDeadline?.effectiveHardTimeoutMs ??
      payload.verificationDeadline?.effectiveTimeoutMs ??
      payload.check?.hardTimeoutMs ??
      payload.check?.timeoutMs
    const recordedEffectiveInactivity =
      payload.verificationDeadline?.effectiveInactivityTimeoutMs ??
      payload.check?.inactivityTimeoutMs ??
      deadline.effectiveInactivityTimeoutMs
    if (
      !authoredCheck ||
      payload.check?.timeoutMs !== recordedEffectiveHard ||
      (payload.check?.hardTimeoutMs !== undefined &&
        payload.check.hardTimeoutMs !== recordedEffectiveHard) ||
      (payload.verificationDeadline !== undefined &&
        ((payload.verificationDeadline.authoredTimeoutMs ?? null) !==
          (authoredCheck.timeoutMs ?? null) ||
          !Number.isSafeInteger(payload.verificationDeadline.effectiveTimeoutMs) ||
          !Number.isSafeInteger(payload.verificationDeadline.policyRevision))) ||
      typeof payload.check?.timeoutMs !== "number" ||
      payload.check.timeoutMs > deadline.effectiveHardTimeoutMs ||
      typeof recordedEffectiveInactivity !== "number" ||
      recordedEffectiveInactivity > deadline.effectiveInactivityTimeoutMs ||
      (payload.check.inactivityTimeoutMs !== undefined &&
        payload.check.inactivityTimeoutMs !== recordedEffectiveInactivity) ||
      !actual ||
      !actual.timedOut ||
      actual.id !== target.checkID ||
      actual.command !== target.command ||
      actual.cwd !== payload.workspace ||
      actual.artifact !== target.artifact ||
      actual.inputIdentity !== payload.identity ||
      !interruptedCheckResourcesSettled(actual) ||
      (target.phase === "task" && plan.reason !== checkFailureReason(actual)) ||
      (target.phase === "combined" && plan.reason !== "Combined artifact verification failed")
    )
      throw new Error(
        "The exact candidate check is not a current, conclusively settled deadline failure",
      )
    const workspace = payload.workspace!
    if (
      (target.phase === "task" && workspace !== taskWorkspace) ||
      !existsSync(workspace) ||
      git(workspace, ["rev-parse", "HEAD"]) !== target.artifact ||
      !artifactUnchanged(workspace, target.artifact)
    )
      throw new Error(
        "The stopped verification workspace no longer contains the unchanged candidate",
      )
    return {
      target,
      deadline,
      effectiveInactivityTimeoutMs: requested.inactivityTimeoutMs,
      effectiveHardTimeoutMs: requested.hardTimeoutMs,
      ownerEpoch: this.store.planControlEpoch(plan.id),
      sourceEffect: {
        id: source.id,
        payloadFingerprint: fingerprint(source.payload),
        receiptFingerprint: fingerprint(source.receipt),
      },
    }
  }

  private assertVerificationDeadlineExtensionCurrent(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    prepared: PreparedVerificationDeadlineExtension,
  ): void {
    const retained = prepared.retained
    const requested = requestedVerificationTimeouts(command, prepared.deadline)
    if (
      plan.owner !== caller ||
      plan.version !== command.expectedVersion ||
      plan.revision !== prepared.target.planRevision ||
      (retained
        ? !["running", "blocked", "accepted", "cleanup-blocked"].includes(plan.state)
        : plan.state !== "blocked" || plan.artifact !== null) ||
      command.projectID !== prepared.target.projectID ||
      command.planRevision !== prepared.target.planRevision ||
      command.verificationPhase !== prepared.target.phase ||
      command.taskID !== (retained?.operation.taskID ?? prepared.target.taskID ?? undefined) ||
      command.taskRevision !==
        (retained?.operation.taskRevision ?? prepared.target.taskRevision ?? undefined) ||
      command.attemptID !==
        (retained?.operation.attemptID ?? prepared.target.attemptID ?? undefined) ||
      command.artifact !== prepared.target.artifact ||
      command.checkID !== prepared.target.checkID ||
      command.retainedVerificationID !== (retained?.operation.id ?? undefined) ||
      command.retainedGeneration !== (retained?.operation.generation ?? undefined) ||
      requested.inactivityTimeoutMs !== prepared.effectiveInactivityTimeoutMs ||
      requested.hardTimeoutMs !== prepared.effectiveHardTimeoutMs ||
      this.store.planControlEpoch(plan.id) !== prepared.ownerEpoch
    )
      throw new Error("Verification deadline owner or plan authorization changed before admission")
    if (retained) {
      const currentOperation = this.store.atomic((db) =>
        retainedVerification(db, retained.operation.id),
      )
      const currentCheck = this.store.atomic((db) =>
        retainedVerificationChecks(db, retained.operation.id, prepared.target.phase).find(
          (check) => check.checkID === prepared.target.checkID,
        ),
      )
      if (
        !currentOperation ||
        fingerprint(currentOperation) !== fingerprint(retained.operation) ||
        !currentCheck ||
        fingerprint(currentCheck) !== fingerprint(retained.check)
      )
        throw new Error("The retained settled check changed before timing continuation")
      const outstandingResources = this.store.atomic(
        (db) =>
          db
            .query<{ count: number }, [string]>(
              `SELECT COUNT(*) AS count FROM runner_retained_verification_resources
             WHERE operation_id=? AND state<>'removed'`,
            )
            .get(retained.operation.id)?.count ?? 0,
      )
      if (outstandingResources !== 0)
        throw new Error("A retained resource obligation changed before timing continuation")
    } else if (prepared.sourceEffect) {
      const current = this.store
        .effects(plan.id)
        .find((effect) => effect.id === prepared.sourceEffect!.id)
      if (
        !current ||
        current.state !== "completed" ||
        fingerprint(current.payload) !== prepared.sourceEffect.payloadFingerprint ||
        fingerprint(current.receipt) !== prepared.sourceEffect.receiptFingerprint
      )
        throw new Error("The settled timeout receipt changed before deadline extension")
    }
    const deadline = this.verificationDeadline(prepared.target)
    if (
      deadline.effectiveInactivityTimeoutMs !== prepared.deadline.effectiveInactivityTimeoutMs ||
      deadline.effectiveHardTimeoutMs !== prepared.deadline.effectiveHardTimeoutMs ||
      deadline.policyRevision !== prepared.deadline.policyRevision
    )
      throw new Error("Verification deadline amendment history changed before admission")
  }

  private settledExtendedTaskTimeouts(plan: PlanRow, attempt: AttemptRow): EffectRow[] {
    if (plan.state !== "blocked" || attempt.state !== "verifying" || !attempt.artifact) return []
    const task = this.store.repository.get(attempt.task_id)
    const input = PlanInput.parse(JSON.parse(plan.body))
    if (!task || input.nodes.find((node) => node.taskID === task.id)?.revision !== task.revision)
      return []
    const effects = this.store.effects(plan.id)
    const matches: EffectRow[] = []
    for (const check of task.proposal.verification) {
      const target = this.verificationTarget(
        plan,
        "task",
        check,
        attempt.artifact,
        task.id,
        task.revision,
        attempt.id,
      )
      const deadline = this.verificationDeadline(target)
      if (!deadline.amendmentID) continue
      const effect = effects.toReversed().find((candidate) => {
        if (
          candidate.kind !== `verify:${check.id}` ||
          candidate.task_id !== task.id ||
          candidate.attempt_id !== attempt.id
        )
          return false
        try {
          const payload: unknown = JSON.parse(candidate.payload)
          return Boolean(
            isRecord(payload) &&
            payload.artifact === attempt.artifact &&
            payload.workspace === attempt.workspace &&
            isRecord(payload.check) &&
            payload.check.id === check.id &&
            payload.check.command === check.command,
          )
        } catch {
          return false
        }
      })
      const receipt = effect && actualCheckResultFromEffect(effect)
      if (
        effect?.state === "completed" &&
        receipt?.timedOut === true &&
        receipt.id === check.id &&
        receipt.command === check.command &&
        receipt.cwd === attempt.workspace &&
        receipt.artifact === attempt.artifact &&
        interruptedCheckResourcesSettled(receipt) &&
        plan.reason === checkFailureReason(receipt)
      )
        matches.push(effect)
    }
    return matches
  }

  private settledExtendedCombinedTimeouts(
    plan: PlanRow,
    input: ReturnType<typeof PlanInput.parse>,
    artifact: string,
    sourceGeneration: string | undefined,
  ): EffectRow[] {
    if (plan.state !== "blocked" || plan.artifact !== null) return []
    const effects = this.store.effects(plan.id)
    const matches: EffectRow[] = []
    for (const check of input.verification) {
      const target = this.verificationTarget(plan, "combined", check, artifact, null, null, null)
      const deadline = this.verificationDeadline(target)
      if (!deadline.amendmentID) continue
      const effect = effects.toReversed().find((candidate) => {
        if (
          candidate.kind !== `graph-verify:${check.id}` ||
          candidate.task_id !== null ||
          candidate.attempt_id !== null
        )
          return false
        try {
          const payload: unknown = JSON.parse(candidate.payload)
          return Boolean(
            isRecord(payload) &&
            payload.artifact === artifact &&
            payload.identity === artifact &&
            (payload.sourceGeneration ?? undefined) === sourceGeneration &&
            isRecord(payload.check) &&
            payload.check.id === check.id &&
            payload.check.command === check.command,
          )
        } catch {
          return false
        }
      })
      const receipt = effect && actualCheckResultFromEffect(effect)
      if (
        effect?.state === "completed" &&
        receipt?.timedOut === true &&
        receipt.id === check.id &&
        receipt.command === check.command &&
        receipt.artifact === artifact &&
        receipt.inputIdentity === artifact &&
        interruptedCheckResourcesSettled(receipt) &&
        plan.reason === "Combined artifact verification failed"
      )
        matches.push(effect)
    }
    return matches
  }

  private quarantineTarget(plan: PlanRow, command: PlanCommand) {
    if (!command.attemptID || !command.reason)
      throw new Error("Source quarantine requires attemptID and reason")
    const attempt = this.store.attempts(plan.id).find((row) => row.id === command.attemptID)
    if (
      !attempt ||
      !["running", "verifying"].includes(attempt.state) ||
      !["running", "blocked"].includes(plan.state) ||
      attempt.workspace === this.directory ||
      JSON.parse(plan.body).workspaceMode === "shared"
    )
      throw new Error(
        "Source quarantine requires an isolated retained running or verifying attempt",
      )
    if (
      attempt.state === "verifying" &&
      !this.hasSettledVerificationTimeout(plan, attempt) &&
      !this.hasSettledHumanEvidenceHold(plan, attempt) &&
      !this.store
        .effects(plan.id)
        .some(
          (effect) =>
            effect.attempt_id === attempt.id &&
            effect.state === "uncertain" &&
            effect.kind.startsWith("verify:"),
        )
    )
      throw new Error(
        "Source quarantine requires a retained uncertain check, settled timeout, or settled human evidence hold",
      )
    if (!this.host.archiveRetainedWorker || !this.host.ensureSourceGuard)
      throw new Error("The native worker source guard and archive control must be installed")
    return attempt
  }

  private sourceWorkerWait(
    attempt: Pick<
      AttemptRow,
      "id" | "task_id" | "policy" | "session_id" | "workspace" | "state" | "message_id"
    >,
    session: HostSession | null | undefined,
    requireCompletedForeground = true,
    review?: SourceReviewBinding,
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
        session.turn.inputID !== (review?.inputID ?? attempt.message_id))
    )
      return "Retained running attempt requires its current input's completed foreground execution"
    if (review && requireCompletedForeground) {
      const inputs = session.messages.filter((message) => message.id === review.inputID)
      const metadata =
        inputs.length === 1
          ? reviewMetadata(inputs[0]!, { taskID: attempt.task_id, attemptID: attempt.id })
          : undefined
      const model = ModelPolicy.parse(JSON.parse(attempt.policy).model)
      if (metadata?.requestID !== review.requestID || !sameNativeModel(session.model, model))
        return "Retained review input metadata or admitted route changed"
    }
    return undefined
  }

  private sameModel(left: ModelPolicy | undefined, right: ModelPolicy | undefined) {
    return sameNativeModel(left, right)
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
      background: worker.background ?? null,
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
      (worker.parentID !== plan.owner &&
        (typeof worker.parentID !== "string" ||
          !this.store.hasPlanOwnerTransfer(
            plan.id,
            worker.parentID,
            plan.owner,
            attempt.started_at,
          ))) ||
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
    attempt: AttemptRow,
    worker: HostSession | null | undefined,
    inputID: string | undefined,
    assignedMessageID: string,
  ) {
    const background = worker?.background
    if (!background || background.state !== "observed")
      return "Retained repair requires a fresh native idle/background observation"
    if (background.count !== 0)
      return "Known background work must finish before the retained repair can continue"
    const executionStart = background.executionStartSequence
    const eventSequence = background.eventSequence
    const terminalSequence = background.terminalSequence
    if (
      !inputID ||
      background.inputID !== inputID ||
      worker?.turn?.inputID !== inputID ||
      background.projectDirectory !== this.directory ||
      background.projectID !== this.projectID ||
      background.attemptID !== attempt.id ||
      background.sessionID !== attempt.session_id ||
      background.workspace !== attempt.workspace ||
      background.assignedMessageID !== assignedMessageID ||
      !Number.isFinite(background.observedAt) ||
      typeof executionStart !== "number" ||
      !Number.isSafeInteger(executionStart) ||
      executionStart < 0 ||
      typeof eventSequence !== "number" ||
      !Number.isSafeInteger(eventSequence) ||
      eventSequence < executionStart ||
      typeof terminalSequence !== "number" ||
      !Number.isSafeInteger(terminalSequence) ||
      terminalSequence <= eventSequence ||
      typeof background.terminalEventID !== "string" ||
      !background.terminalEventID ||
      typeof background.terminalMessageID !== "string" ||
      !background.terminalMessageID
    )
      return "Retained repair idle evidence does not bind the exact current native input and assignment"
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
    if (
      caller !== plan.owner ||
      !this.validArchitect(ownerSession) ||
      ownerSession.id !== plan.owner ||
      ownerSession.projectID !== this.projectID
    )
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
      task.provenance.projectID !== this.projectID ||
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
    const repairOwner = repair?.owner
    const repairOwnerEpoch = repair?.ownerEpoch
    const repairRoute = ModelPolicy.safeParse(repair?.route)
    const policy = (() => {
      try {
        return JSON.parse(attempt.policy) as { workspaceMode?: unknown; model?: unknown }
      } catch {
        return undefined
      }
    })()
    const attemptRoute = ModelPolicy.safeParse(policy?.model)
    const planRoute = plan.model ? ModelPolicy.safeParse(JSON.parse(plan.model)) : undefined
    const artifact = repair?.artifact
    if (
      !repairTransition ||
      typeof operationID !== "string" ||
      typeof repairMessageID !== "string" ||
      typeof previousMessageID !== "string" ||
      repair?.attemptID !== attempt.id ||
      repairTransition.task_id !== task.id ||
      repairOwner !== plan.owner ||
      repairOwnerEpoch !== this.store.planControlEpoch(plan.id) ||
      !Number.isSafeInteger(repairOwnerEpoch) ||
      typeof repair?.sessionID !== "string" ||
      repair.sessionID !== attempt.session_id ||
      repair.workspace !== attempt.workspace ||
      artifact !== attempt.artifact ||
      node.artifact !== null ||
      !isCommitID(artifact) ||
      !attemptRoute.success ||
      !planRoute?.success ||
      !repairRoute.success ||
      policy?.workspaceMode !== "isolated" ||
      !this.sameModel(attemptRoute.data, planRoute.data) ||
      !this.sameModel(attemptRoute.data, repairRoute.data) ||
      this.store.latestTransition(plan.id, task.id, "TASK_INTEGRATION_RECORDED") ||
      sourceQuarantine(this.store, attempt.id)
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
      realpathSync(git(attempt.workspace, ["rev-parse", "--show-toplevel"])) !==
        realpathSync(attempt.workspace) ||
      git(attempt.workspace, ["rev-parse", `${artifact}^{commit}`]) !== artifact ||
      !commitIsAncestor(
        attempt.workspace,
        artifact,
        git(attempt.workspace, ["rev-parse", "HEAD"]),
      ) ||
      !isCommitID(attempt.base_commit) ||
      !commitIsAncestor(attempt.workspace, attempt.base_commit, artifact) ||
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
    const route = attemptRoute.data
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
      plan: { state: "blocked", owner: plan.owner, model: plan.model, artifact: null },
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
      backgroundInputMatches:
        confirmedWorker.background?.state === "observed" &&
        confirmedWorker.background.inputID === repairMessageID,
      stopObservation: stopped,
      planHoldObservation: priorHold,
      retainedSession: sessionReceipt,
      retainedPrompt: repairPromptReceipt,
      hasUnresolvedEffects: unresolved,
      reservationAvailable: this.preparationAllowed(attempt),
    } satisfies TerminalWorkerContinuationFacts)
    if (continuationProblem) throw new Error(continuationProblem)
    if (
      this.store.plan(plan.id)?.version !== plan.version ||
      this.store.planControlEpoch(plan.id) !== repairOwnerEpoch
    )
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
      ownerEpoch: repairOwnerEpoch as number,
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
      currentPlan.owner === recovery.owner &&
      currentPlan.reason === RETAINED_REPAIR_FENCE_FAILURE_REASON &&
      this.store.planControlEpoch(plan.id) === recovery.ownerEpoch &&
      currentAttempt?.state === "cancelled" &&
      currentAttempt.message_id === recovery.failedMessageID &&
      currentAttempt.session_id === attempt.session_id &&
      currentAttempt.workspace === attempt.workspace &&
      currentAttempt.base_commit === attempt.base_commit &&
      currentAttempt.policy === attempt.policy &&
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
      !sourceQuarantine(this.store, attempt.id) &&
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
    const accepted = this.store.latestTransition<{ operationID?: string }>(
      plan.id,
      attempt.task_id,
      "RETAINED_TASK_CANDIDATE_ACCEPTED",
    )
    const operationID = accepted?.operationID
    if (!operationID) return false
    const operation = this.store.atomic((db) => retainedVerification(db, operationID))
    return Boolean(
      operation &&
      operation.projectDirectory === this.directory &&
      operation.projectID === this.projectID &&
      operation.planID === plan.id &&
      operation.taskID === attempt.task_id &&
      operation.taskRevision === taskRevision &&
      operation.attemptID === attempt.id &&
      operation.artifact === attempt.artifact &&
      operation.originalSessionID === attempt.session_id &&
      operation.originalMessageID === attempt.message_id &&
      this.retainedTaskCandidateAccepted(operation),
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
    if (
      caller !== plan.owner ||
      !this.validArchitect(ownerSession) ||
      ownerSession.id !== plan.owner
    )
      throw new Error("Retained repair requires the current same-project Architect owner")
    const ownerEpoch = this.store.planControlEpoch(plan.id)
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
      task.provenance.projectID !== this.projectID ||
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

    let policy: { workspaceMode?: unknown; model?: unknown }
    try {
      policy = JSON.parse(attempt.policy) as typeof policy
    } catch {
      throw new Error("Retained attempt policy is unavailable")
    }
    const attemptModel = ModelPolicy.safeParse(policy.model)
    const planModel = plan.model ? ModelPolicy.safeParse(JSON.parse(plan.model)) : undefined
    if (
      attempt.workspace === this.directory ||
      policy.workspaceMode !== "isolated" ||
      !attemptModel.success ||
      !planModel?.success ||
      !this.sameModel(attemptModel.data, planModel.data)
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
    if (
      sessionEffect?.state !== "completed" ||
      originalPrompt?.state !== "completed" ||
      sourceQuarantine(this.store, attempt.id)
    )
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
      realpathSync(git(attempt.workspace, ["rev-parse", "--show-toplevel"])) !==
        realpathSync(attempt.workspace)
    )
      throw new Error("Retained repair requires the exact native-owned isolated worktree")
    const workspaceHead = git(attempt.workspace, ["rev-parse", "HEAD"])
    if (
      git(attempt.workspace, ["rev-parse", `${command.artifact}^{commit}`]) !== command.artifact ||
      workspaceHead !== command.artifact
    )
      throw new Error("Retained repair artifact is missing or not the workspace HEAD")
    const sourceHead = git(this.directory, ["rev-parse", "HEAD"])
    if (commitIsAncestor(this.directory, command.artifact, sourceHead))
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
    const backgroundProblem = this.retainedRepairBackgroundProblem(
      attempt,
      observed,
      nativeInputID,
      previousMessageID,
    )
    if (!nativeInputID || !this.matchesWorkerInput(attempt, nativeInputID))
      throw new Error("Retained repair requires the exact captured successful native input")
    const problem = this.retainedRepairWorkerProblem(
      plan,
      attempt,
      observed,
      nativeInputID,
      attemptModel.data,
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
      attemptModel.data,
    )
    const confirmedBackgroundProblem = this.retainedRepairBackgroundProblem(
      attempt,
      confirmed,
      nativeInputID,
      previousMessageID,
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
    if (
      this.store.plan(plan.id)?.version !== command.expectedVersion ||
      this.store.planControlEpoch(plan.id) !== ownerEpoch
    )
      throw new Error("Retained repair plan changed during native observation")
    return {
      taskID: task.id,
      attemptID: attempt.id,
      artifact: command.artifact,
      previousMessageID,
      nativeInputID,
      messageID: messageID(),
      operationID: crypto.randomUUID(),
      owner: caller,
      ownerEpoch,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      model: attemptModel.data,
      workerObservation: this.retainedRepairObservation(confirmed),
    }
  }

  private async prepareReviewInputReconciliation(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ): Promise<{ binding: ReviewInputBinding; evidence: ReviewInputEvidence } | undefined> {
    if (command.reviewInputID === undefined || command.action === "quarantine-source")
      return undefined
    if (command.action !== "reconcile" || !command.taskID || !command.attemptID)
      throw new Error("Review input reconciliation requires reconcile, taskID and attemptID")
    if (
      caller !== plan.owner ||
      !this.validArchitect(ownerSession) ||
      ownerSession.id !== plan.owner
    )
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
      task.provenance.projectID !== this.projectID ||
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
      expectedPlanVersion: command.expectedVersion,
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
          decision.data.route.providerID === route.data.providerID &&
          decision.data.route.id === route.data.id &&
          decision.data.route.variant === route.data.variant
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
      backgroundInputMatches: Boolean(
        attempt &&
        worker?.background?.state === "observed" &&
        this.matchesWorkerInput(attempt, worker.background.inputID),
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
      const ownerEpoch = db
        .query<{ epoch: number }, [string]>(
          `SELECT COALESCE(MAX(id),0) AS epoch FROM runner_transitions
           WHERE plan_id=? AND task_id IS NULL AND event IN (
             'OWNER_REASSIGNED','OWNER_CONTINUED','OWNER_CONTINUATION_ROLLED_BACK','CANCEL_REQUESTED'
           )`,
        )
        .get(plan.id)!.epoch
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
        currentPlan.owner !== authorization.owner ||
        currentPlan.version < authorization.planVersion ||
        currentPlan.revision !== authorization.planRevision ||
        ownerEpoch !== authorization.ownerEpoch ||
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
      plan.owner !== expectedPlan.owner ||
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

    const gitWorktrees = git(this.directory, ["worktree", "list", "--porcelain"])
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
      typeof authorization.ownerEpoch !== "number" ||
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
      current.owner === authorization.owner &&
      current.version >= authorization.planVersion &&
      this.store.planControlEpoch(plan.id) === authorization.ownerEpoch &&
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
        const head = git(attempt.workspace, ["rev-parse", "HEAD"])
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
      const gitWorktrees = git(this.directory, ["worktree", "list", "--porcelain"])
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
        git(actual, ["rev-parse", "HEAD"]) !== attempt.base_commit
      )
        throw new Error("Recovered native worktree did not match the reserved workspace and source")
      return this.completeStartupRecovery(plan, attempt, operation, authorization, actual, fence)
    } catch (error) {
      this.uncertain(operation, error, fence)
      return false
    }
  }

  private acceptedCombinedArtifacts(
    plan: PlanRow,
    input: ReturnType<typeof PlanInput.parse>,
    retained?: RetainedVerification,
  ): CombinedVerificationContinuation["acceptedArtifacts"] {
    const nodes = this.store.nodes(plan.id)
    const attempts = this.store.attempts(plan.id)
    return input.integrationOrder.map((taskID) => {
      const specification = input.nodes.find((node) => node.taskID === taskID)
      const node = nodes.find((candidate) => candidate.task_id === taskID)
      const task = this.store.repository.get(taskID)
      const attempt = attempts.filter((candidate) => candidate.task_id === taskID).at(-1)
      const retainedCandidateAccepted = Boolean(
        retained &&
        retained.taskID === taskID &&
        retained.taskRevision === task?.revision &&
        retained.attemptID === attempt?.id &&
        retained.artifact === node?.artifact &&
        this.retainedTaskCandidateAccepted(retained) &&
        attempt?.artifact === retained.artifact &&
        attempt.state === (retained.sourceQuarantine ? "verifying" : "accepted"),
      )
      if (
        !specification ||
        !node ||
        !["accepted", "incorporated"].includes(node.state) ||
        !node.artifact ||
        !isCommitID(node.artifact) ||
        !task ||
        task.revision !== specification.revision ||
        task.provenance.projectID !== this.projectID ||
        task.provenance.projectDirectory !== this.directory ||
        this.store.repository.taskDisposition(taskID) !== undefined ||
        !attempt ||
        (!retainedCandidateAccepted &&
          (attempt.state !== "accepted" || attempt.artifact !== node.artifact)) ||
        git(this.directory, ["rev-parse", `${node.artifact}^{commit}`]) !== node.artifact
      )
        throw new Error(
          "Combined continuation requires every current plan task to retain its accepted artifact",
        )
      return { taskID, taskRevision: task.revision, artifact: node.artifact }
    })
  }

  private interruptedCombinedVerificationEffects(
    plan: PlanRow,
    input: ReturnType<typeof PlanInput.parse>,
    artifact: string,
    sourceGeneration: string | undefined,
  ) {
    const checks = new Map(input.verification.map((check) => [check.id, check]))
    return this.store.effects(plan.id).filter((effect) => {
      if (
        effect.state !== "uncertain" ||
        effect.task_id !== null ||
        effect.attempt_id !== null ||
        !effect.kind.startsWith("graph-verify:")
      )
        return false
      const check = checks.get(effect.kind.slice("graph-verify:".length))
      const receipt = actualCheckResultFromEffect(effect)
      if (!check || !receipt) return false
      try {
        const payload: unknown = JSON.parse(effect.payload)
        return Boolean(
          isRecord(payload) &&
          payload.artifact === artifact &&
          payload.identity === artifact &&
          typeof payload.workspace === "string" &&
          (payload.sourceGeneration ?? undefined) === sourceGeneration &&
          fingerprint(payload.authoredCheck ?? payload.check) === fingerprint(check) &&
          receipt.id === check.id &&
          receipt.command === check.command &&
          receipt.cwd === payload.workspace &&
          receipt.artifact === artifact &&
          receipt.inputIdentity === artifact &&
          receipt.aborted === true &&
          interruptedCheckResourcesSettled(receipt),
        )
      } catch {
        return false
      }
    })
  }

  private async prepareCombinedVerificationResume(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ): Promise<CombinedVerificationContinuation> {
    if (
      !command.reason?.trim() ||
      command.attemptID !== undefined ||
      command.workspaceMode !== undefined ||
      command.baseCommit !== undefined
    )
      throw new Error("Plan-level verification resume requires only a reason, not task controls")
    if (
      caller !== plan.owner ||
      !this.validArchitect(ownerSession) ||
      ownerSession.id !== plan.owner
    )
      throw new Error("Combined verification resume requires the current same-project Architect")
    if (plan.state !== "blocked" || plan.artifact !== null)
      throw new Error("Combined verification resume requires a blocked, unaccepted plan")

    const input = PlanInput.parse(JSON.parse(plan.body))
    const acceptedArtifacts = this.acceptedCombinedArtifacts(plan, input)
    const artifact = await combineArtifacts(
      this.directory,
      input.baseCommit,
      acceptedArtifacts.map((item) => item.artifact),
    )
    const sourceGeneration = this.retainedRepairGeneration(plan.id) ?? null
    const effects = this.store.effects(plan.id)
    const interrupted = this.interruptedCombinedVerificationEffects(
      plan,
      input,
      artifact,
      sourceGeneration ?? undefined,
    ).toSorted((left, right) => left.id.localeCompare(right.id))
    const settledTimeouts = this.settledExtendedCombinedTimeouts(
      plan,
      input,
      artifact,
      sourceGeneration ?? undefined,
    ).toSorted((left, right) => left.id.localeCompare(right.id))
    if (!interrupted.length && !settledTimeouts.length)
      throw new Error(
        "No conclusively settled interrupted or extended combined verification can be resumed",
      )
    const interruptedIDs = new Set(interrupted.map((effect) => effect.id))
    if (
      effects.some(
        (effect) =>
          ["intended", "uncertain"].includes(effect.state) && !interruptedIDs.has(effect.id),
      )
    )
      throw new Error("Reconcile unrelated unresolved effects before combined verification resume")
    if (
      verificationActivitiesForDatabase(this.store.repository.path).some(
        (activity) => activity.metadata.planID === plan.id && activity.state === "running",
      )
    )
      throw new Error("A live verification activity prevents combined verification resume")
    if (
      this.store.atomic((db) => activeRetainedVerifications(db, this.directory, plan.id).length > 0)
    )
      throw new Error("An unresolved retained verification prevents combined verification resume")

    const workspaces = new Set(
      [...interrupted, ...settledTimeouts].map(
        (effect) => (JSON.parse(effect.payload) as { workspace: string }).workspace,
      ),
    )
    if (workspaces.size !== 1)
      throw new Error("Interrupted combined checks do not share one candidate")
    const workspace = [...workspaces][0]!
    if (
      !existsSync(workspace) ||
      git(workspace, ["rev-parse", "HEAD"]) !== artifact ||
      !artifactUnchanged(workspace, artifact)
    )
      throw new Error("Interrupted combined verification candidate changed; preserve it for review")

    const ownerEpoch = this.store.planControlEpoch(plan.id)
    const binding: CombinedVerificationContinuationBinding = {
      schema: "lazers-combined-verification-continuation/v1",
      requestID: command.requestID,
      projectDirectory: this.directory,
      projectID: this.projectID,
      planID: plan.id,
      owner: plan.owner,
      ownerEpoch,
      planRevision: plan.revision,
      expectedPlanVersion: command.expectedVersion,
      resumedPlanVersion: plan.version + 1,
      planBodyFingerprint: fingerprint(plan.body),
      acceptedArtifacts,
      artifact,
      workspace,
      sourceGeneration,
      verificationEpoch: plan.version + 1,
      interruptedEffects: interrupted.map((effect) => ({
        id: effect.id,
        payloadFingerprint: fingerprint(effect.payload),
        receiptFingerprint: fingerprint(effect.receipt),
      })),
      ...(settledTimeouts.length
        ? {
            settledTimeouts: settledTimeouts.map((effect) => ({
              id: effect.id,
              payloadFingerprint: fingerprint(effect.payload),
              receiptFingerprint: fingerprint(effect.receipt),
            })),
          }
        : {}),
    }
    const inputFingerprint = combinedVerificationContinuationFingerprint(binding)

    const currentOwner = await this.host.session(caller)
    const currentPlan = this.store.plan(plan.id)
    if (
      !this.validArchitect(currentOwner) ||
      currentOwner.id !== plan.owner ||
      !currentPlan ||
      currentPlan.version !== plan.version ||
      currentPlan.revision !== plan.revision ||
      currentPlan.body !== plan.body ||
      currentPlan.owner !== plan.owner ||
      this.store.planControlEpoch(plan.id) !== ownerEpoch ||
      fingerprint(
        this.acceptedCombinedArtifacts(currentPlan, PlanInput.parse(JSON.parse(currentPlan.body))),
      ) !== fingerprint(acceptedArtifacts) ||
      (this.retainedRepairGeneration(plan.id) ?? null) !== sourceGeneration
    )
      throw new Error("Combined verification owner, plan or candidate changed during admission")
    const currentSettledTimeouts = this.settledExtendedCombinedTimeouts(
      currentPlan!,
      PlanInput.parse(JSON.parse(currentPlan!.body)),
      artifact,
      sourceGeneration ?? undefined,
    ).toSorted((left, right) => left.id.localeCompare(right.id))
    const timeoutFingerprint = (items: EffectRow[]) =>
      fingerprint(
        items.map((effect) => ({
          id: effect.id,
          payloadFingerprint: fingerprint(effect.payload),
          receiptFingerprint: fingerprint(effect.receipt),
        })),
      )
    if (timeoutFingerprint(currentSettledTimeouts) !== timeoutFingerprint(settledTimeouts))
      throw new Error("Combined verification timeout receipt changed during admission")
    if (
      verificationActivitiesForDatabase(this.store.repository.path).some(
        (activity) => activity.metadata.planID === plan.id && activity.state === "running",
      )
    )
      throw new Error("A live verification activity prevents combined verification resume")

    return { ...binding, inputFingerprint }
  }

  async command(input: unknown, caller: string): Promise<unknown> {
    const command = CommandInput.parse(input)
    const prior = this.store.priorCommand<unknown>(command.requestID, { command, caller })
    if (prior !== undefined) {
      if (command.action === "cancel-retained-verification" && command.retainedVerificationID)
        await this.finalizeRetainedVerificationCancellation(command.retainedVerificationID)
      return prior
    }
    // Resolve host facts before the transaction, then recheck durable versions within it.
    const old = this.store.plan(command.planID)
    if (!old) throw new Error("Plan not found")
    // Reject stale/foreign requests before any asynchronous owner recovery effect.
    // Receipts above remain bound to the ORIGINAL command and caller, even when
    // a valid owner is durably continued to a different native session.
    if (old.version !== command.expectedVersion)
      throw new Error(`Stale plan version; current ${old.version}`)
    if (caller !== old.owner && !["audit", "reassign"].includes(command.action))
      throw new Error("Only the plan owner may change execution")
    let continuedOwner: string | undefined
    const configuredWorker =
      command.action === "run" && !JSON.parse(old.body).workerModel
        ? await this.host.workerModel?.(workerAgent(JSON.parse(old.body).workerAgent))
        : undefined
    const target = command.action === "reassign" ? command.targetSessionID : old.owner
    let ownerSession: HostSession | null | undefined
    if (
      [
        "run",
        "pause",
        "unpause",
        "reassign",
        "reconcile",
        "reconcile-source-notices",
        "resume",
        "retry",
        "adopt-descendant",
        "quarantine-source",
        "settle-startup",
        "retained-repair",
        "verify-retained",
        "cancel-retained-verification",
        "extend-verification-deadline",
        "recover-cleanup",
      ].includes(command.action) ||
      (command.action === "human-evidence" && command.retainedVerificationID !== undefined)
    ) {
      if (!target) throw new Error("Target session required")
      ownerSession = await this.host.session(target)
    }
    let terminalContinuation:
      | {
          attemptID: string
          messageID: string
          inputID: string
          worker: HostSession
        }
      | undefined
    let terminalRepairContinuation:
      { operationID: string; owner: string; ownerEpoch: number } | undefined
    let retainedRepairRecovery: RetainedRepairRecoverySeed | undefined
    let combinedVerificationResume: CombinedVerificationContinuation | undefined
    if (command.action === "resume" && command.taskID) {
      const attempt = this.store
        .attempts(old.id)
        .filter((candidate) => candidate.task_id === command.taskID)
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
        attempt?.state === "verifying" &&
        (this.interruptedChecksFor(old, attempt).length > 0 ||
          this.settledExtendedTaskTimeouts(old, attempt).length > 0),
      )
      if (
        !interruptedVerification &&
        (attempt?.state === "running" || attempt?.state === "verifying" || terminalNativeFailure)
      ) {
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
        terminalContinuation = {
          attemptID: attempt.id,
          messageID: attempt.message_id,
          inputID: worker!.turn!.inputID!,
          worker: worker!,
        }
        const latestRepair = this.store.latestRetainedRepair<{ attemptID?: unknown }>(
          old.id,
          attempt.task_id,
        )
        if (latestRepair?.attemptID === attempt.id) {
          const repair = this.retainedRepairForAttempt(attempt)
          if (
            !repair ||
            repair.messageID !== attempt.message_id ||
            repair.owner !== caller ||
            repair.ownerEpoch !== this.store.planControlEpoch(old.id)
          )
            throw new Error(
              "Retained repair continuation is missing its current owner/control authorization",
            )
          terminalRepairContinuation = {
            operationID: repair.operationID,
            owner: repair.owner,
            ownerEpoch: repair.ownerEpoch,
          }
        }
      }
      if (
        !terminalContinuation &&
        attempt?.state === "cancelled" &&
        this.store.nodes(old.id).find((candidate) => candidate.task_id === attempt.task_id)
          ?.state === "cancelled" &&
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
    }
    if (command.action === "resume" && !command.taskID)
      combinedVerificationResume = await this.prepareCombinedVerificationResume(
        old,
        command,
        caller,
        ownerSession,
      )
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
    const verificationDeadlineExtension =
      command.action === "extend-verification-deadline"
        ? await this.prepareVerificationDeadlineExtension(old, command, caller, ownerSession)
        : undefined
    if (verificationDeadlineExtension) {
      const confirmedOwner = await this.host.session(caller)
      const confirmedPlan = this.store.plan(old.id)
      if (
        !confirmedPlan ||
        !this.validArchitect(confirmedOwner) ||
        confirmedOwner.id !== old.owner ||
        confirmedOwner.projectID !== this.projectID
      )
        throw new Error("Verification deadline owner changed during admission")
      this.assertVerificationDeadlineExtensionCurrent(
        confirmedPlan,
        command,
        caller,
        verificationDeadlineExtension,
      )
      ownerSession = confirmedOwner
    }
    let quarantineAttempt: AttemptRow | undefined
    let quarantineReview: SourceReviewBinding | undefined
    if (command.action === "quarantine-source") {
      if (!this.validArchitect(ownerSession)) throw new Error("Active Architect owner required")
      quarantineAttempt = this.quarantineTarget(old, command)
      const worker = await this.host.session(
        quarantineAttempt.session_id,
        quarantineAttempt.state === "running" ? { messages: true } : undefined,
      )
      if (command.reviewInputID !== undefined) {
        if (command.taskID !== quarantineAttempt.task_id || quarantineAttempt.state !== "running")
          throw new Error("Source review must name the exact retained running task attempt")
        const inputs =
          worker?.messages.filter((message) => message.id === command.reviewInputID) ?? []
        const metadata =
          inputs.length === 1
            ? reviewMetadata(inputs[0]!, {
                taskID: quarantineAttempt.task_id,
                attemptID: quarantineAttempt.id,
              })
            : undefined
        if (!metadata) throw new Error("Exact tagged retained review input is unavailable")
        quarantineReview = { inputID: command.reviewInputID, requestID: metadata.requestID }
      }
      const wait = this.sourceWorkerWait(quarantineAttempt, worker, true, quarantineReview)
      if (wait) throw new Error(wait)
      const worktrees = await this.host.worktrees()
      if (
        !worktrees.includes(quarantineAttempt.workspace) ||
        realpathSync(quarantineAttempt.workspace) === realpathSync(this.directory)
      )
        throw new Error("Retained source must be a separate native-owned worktree")
      await this.host.ensureSourceGuard!({
        directory: quarantineAttempt.workspace,
        projectID: this.projectID,
      })
      const [currentOwner, currentWorker] = await Promise.all([
        this.host.session(caller),
        this.host.session(
          quarantineAttempt.session_id,
          quarantineAttempt.state === "running" ? { messages: true } : undefined,
        ),
      ])
      if (!this.validArchitect(currentOwner) || currentOwner.id !== old.owner)
        throw new Error("Source quarantine owner session changed during admission")
      const currentWait = this.sourceWorkerWait(
        quarantineAttempt,
        currentWorker,
        true,
        quarantineReview,
      )
      if (currentWait) throw new Error(currentWait)
    }
    const retainedRepair =
      command.action === "retained-repair"
        ? await this.prepareRetainedRepair(old, command, caller, ownerSession)
        : undefined
    const reviewInput = await this.prepareReviewInputReconciliation(
      old,
      command,
      caller,
      ownerSession,
    )
    const sourceNoticeReconciliation =
      command.action === "reconcile-source-notices"
        ? await this.reconcileArchitectSourceNotices(old, command, caller, ownerSession)
        : undefined
    let startupSettlement:
      | {
          attempt: AttemptRow
          effect: EffectRow
          failure: StartupWorktreeFailureEvidence
          evidence: StartupAbsenceEvidence
        }
      | undefined
    if (command.action === "settle-startup") {
      if (
        !command.taskID ||
        !command.attemptID ||
        !command.reason ||
        !ownerSession ||
        !this.validArchitect(ownerSession) ||
        ownerSession.id !== old.owner
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
      this.assertStartupSettlementCurrent(
        old,
        candidate.attempt,
        candidate.effect,
        candidate.failure,
      )
      startupSettlement = { ...candidate, evidence }
    }

    if (retainedVerificationSeed) {
      const [currentOwner, currentPlan] = await Promise.all([
        this.host.session(caller),
        Promise.resolve(this.store.plan(old.id)),
      ])
      if (
        !this.validArchitect(currentOwner) ||
        currentOwner.id !== old.owner ||
        currentPlan?.owner !== retainedVerificationSeed.owner ||
        currentPlan.version !== retainedVerificationSeed.planVersion ||
        currentPlan.revision !== retainedVerificationSeed.planRevision ||
        this.store.planControlEpoch(old.id) !== retainedVerificationSeed.ownerEpoch
      )
        throw new Error(
          "Retained verification owner or plan authorization changed before reservation",
        )
      const observeOwner = async () => {
        ownerSession = await this.host.session(caller)
        if (!this.validArchitect(ownerSession) || ownerSession.id !== old.owner)
          throw new Error("Retained verification owner changed during final native admission")
      }
      if (retainedVerificationSeed.repair) {
        const latest = this.store
          .attempts(old.id)
          .find((a) => a.id === retainedVerificationSeed.attemptID)
        if (!latest) throw new Error("Retained repair attempt disappeared before reservation")
        await this.observeRetainedRepairCandidate(
          currentPlan,
          latest,
          retainedVerificationSeed.repair,
          observeOwner,
        )
      } else await observeOwner()
    }

    if (retainedRepair) {
      const attempt = this.store
        .attempts(old.id)
        .find((candidate) => candidate.id === retainedRepair.attemptID)
      if (
        !attempt ||
        this.store.plan(old.id)?.version !== command.expectedVersion ||
        this.store.planControlEpoch(old.id) !== retainedRepair.ownerEpoch
      )
        throw new Error("Retained repair plan or attempt changed before final native revalidation")
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
        attempt,
        observedWorker,
        retainedRepair.nativeInputID,
        retainedRepair.previousMessageID,
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
        attempt,
        confirmedWorker,
        retainedRepair.nativeInputID,
        retainedRepair.previousMessageID,
      )
      if (
        confirmedProblem ||
        confirmedBackgroundProblem ||
        !confirmedWorker ||
        this.retainedRepairObservation(confirmedWorker) !== retainedRepair.workerObservation ||
        this.store.plan(old.id)?.version !== command.expectedVersion ||
        this.store.planControlEpoch(old.id) !== retainedRepair.ownerEpoch ||
        !this.preparationAllowed(attempt)
      )
        throw new Error(
          confirmedProblem ??
            confirmedBackgroundProblem ??
            "Retained repair authorization changed during final admission",
        )
    }
    if (retainedRepairRecovery) {
      const currentOwner = await this.host.session(caller)
      const recoveryAttempt = this.store
        .attempts(old.id)
        .find((candidate) => candidate.id === retainedRepairRecovery!.attemptID)
      const currentWorker = await this.host.session(retainedRepairRecovery.worker.id, {
        messages: true,
      })
      if (
        !recoveryAttempt ||
        !this.validArchitect(currentOwner) ||
        currentOwner.id !== retainedRepairRecovery.owner ||
        !currentWorker ||
        this.retainedRepairObservation(currentWorker) !==
          retainedRepairRecovery.workerObservation ||
        currentWorker.messages.some(
          (message) => message.id === retainedRepairRecovery.failedMessageID,
        ) ||
        !this.retainedRepairRecoveryCurrent(old, recoveryAttempt, retainedRepairRecovery)
      )
        throw new Error("Retained repair recovery changed during final native revalidation")
    }
    let humanCombinedArtifact: string | undefined
    if (
      command.action === "human-evidence" &&
      !command.taskID &&
      !command.retainedVerificationID &&
      !command.adoptionID
    ) {
      const input = PlanInput.parse(JSON.parse(old.body))
      const nodes = this.store.nodes(old.id)
      const ordered = input.integrationOrder.map((id) => nodes.find((node) => node.task_id === id))
      if (ordered.some((node) => node?.state !== "accepted" || !node.artifact))
        throw new Error("Plan evidence requires all accepted task artifacts")
      humanCombinedArtifact = await combineArtifacts(
        this.directory,
        input.baseCommit,
        ordered.map((node) => node!.artifact!),
      )
    }
    // Native cleanup observations are sampled outside the command transaction,
    // then published only if the recorded plan version is still current.
    const cleanupDiagnostics =
      command.action === "audit" ? await this.cleanupAuditDiagnostics(old) : undefined
    const result = this.store.command(command.requestID, { command, caller }, (db) => {
      const plan = this.store.plan(command.planID)!
      if (plan.version !== command.expectedVersion)
        throw new Error(`Stale plan version; current ${plan.version}`)
      if (caller !== plan.owner && !["audit", "reassign"].includes(command.action))
        throw new Error("Only the plan owner may change execution")
      // Commit owner adoption with the original request receipt. If native
      // creation succeeds but this command fails, exact replay can recover it
      // without granting an old owner authority over a reassigned plan.
      if (continuedOwner) this.store.updatePlanOwner(plan.id, plan.owner, continuedOwner)
      const activeAdoptions = this.store.activeAdoptions(plan.id)
      if (
        activeAdoptions.length &&
        ![
          "adopt-descendant",
          "human-evidence",
          "cancel",
          "audit",
          "reconcile-source-notices",
        ].includes(command.action)
      )
        throw new Error(
          "A descendant adoption is pending; only its evidence or cancellation is allowed",
        )
      if (command.action === "quarantine-source") {
        const attempt = this.quarantineTarget(plan, command)
        if (!sourceGuardInstalled(this.store, attempt.workspace))
          throw new Error("Native worker source guard is not installed")
        if (
          !quarantineAttempt ||
          attempt.message_id !== quarantineAttempt.message_id ||
          attempt.session_id !== quarantineAttempt.session_id ||
          attempt.workspace !== quarantineAttempt.workspace
        )
          throw new Error("Retained worker changed during source quarantine admission")
        const existing = sourceQuarantine(this.store, attempt.id)
        if (
          existing &&
          (existing.session_id !== attempt.session_id ||
            existing.assigned_message_id !== attempt.message_id ||
            existing.workspace !== attempt.workspace)
        )
          throw new Error("Existing source quarantine belongs to a different worker assignment")
        if (existing?.phase === "sealed")
          return { status: "source-quarantined", attemptID: attempt.id, version: plan.version }
        const at = Date.now()
        db.query(
          `INSERT INTO runner_source_quarantines
          (attempt_id,plan_id,session_id,assigned_message_id,requested_owner,workspace,request_id,reason,phase,hold_reason,review_input_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'pending',NULL,?,?,?)
          ON CONFLICT(attempt_id) DO UPDATE SET requested_owner=excluded.requested_owner,
            request_id=excluded.request_id,reason=excluded.reason,hold_reason=NULL,
            review_input_json=excluded.review_input_json,updated_at=excluded.updated_at`,
        ).run(
          attempt.id,
          plan.id,
          attempt.session_id,
          attempt.message_id,
          plan.owner,
          attempt.workspace,
          command.requestID,
          command.reason!,
          quarantineReview ? JSON.stringify(quarantineReview) : null,
          at,
          at,
        )
        db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(plan.id)
        this.store.record(plan.id, attempt.task_id, "SOURCE_QUARANTINE_REQUESTED", {
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace: attempt.workspace,
          requestID: command.requestID,
          reason: command.reason,
          ...(quarantineReview ? { reviewInput: quarantineReview } : {}),
          ...(existing ? { supersedesRequestID: existing.request_id } : {}),
          resourceHoldsRetained: true,
        })
        return {
          status: "quarantining-source",
          attemptID: attempt.id,
          version: this.store.plan(plan.id)!.version,
        }
      }
      if (command.action === "retained-repair") {
        if (!retainedRepair || !ownerSession || !this.validArchitect(ownerSession))
          throw new Error("Retained repair requires the current same-project Architect owner")
        if (caller !== plan.owner || ownerSession.id !== plan.owner)
          throw new Error("Retained repair owner changed before admission")
        if (
          caller !== retainedRepair.owner ||
          plan.owner !== retainedRepair.owner ||
          this.store.planControlEpoch(plan.id) !== retainedRepair.ownerEpoch
        )
          throw new Error("Retained repair owner/control authorization changed before admission")
        if (!new Set(["running", "accepted", "blocked"]).has(plan.state))
          throw new Error(
            "Retained repair requires a running, accepted or blocked, unintegrated plan",
          )
        const input = PlanInput.parse(JSON.parse(plan.body))
        const task = this.store.repository.get(retainedRepair.taskID)
        const node = this.store
          .nodes(plan.id)
          .find((item) => item.task_id === retainedRepair.taskID)
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
          task.provenance.projectID !== this.projectID ||
          task.provenance.projectDirectory !== this.directory ||
          this.store.repository.taskDisposition(task.id)
        )
          throw new Error(
            "Retained task, attempt, artifact, or assignment changed before admission",
          )
        const policy = JSON.parse(attempt.policy) as { workspaceMode?: unknown; model?: unknown }
        const route = ModelPolicy.safeParse(policy.model)
        const planRoute = plan.model ? ModelPolicy.safeParse(JSON.parse(plan.model)) : undefined
        if (
          policy.workspaceMode !== "isolated" ||
          !route.success ||
          !planRoute?.success ||
          !this.sameModel(route.data, retainedRepair.model) ||
          !this.sameModel(planRoute.data, retainedRepair.model)
        )
          throw new Error("Retained task execution route changed before admission")
        if (
          this.store.latestTransition(plan.id, task.id, "TASK_INTEGRATION_RECORDED") ||
          commitIsAncestor(
            this.directory,
            retainedRepair.artifact,
            git(this.directory, ["rev-parse", "HEAD"]),
          )
        )
          throw new Error("Source-landed task work cannot be repaired in its retained workspace")
        if (
          this.store
            .effects(plan.id)
            .some((effect) => ["intended", "uncertain"].includes(effect.state)) ||
          sourceQuarantine(this.store, attempt.id)
        )
          throw new Error("Uncertain effects or source quarantine prevent retained repair")
        this.assertNoDispatchedDependents(plan, task.id, input)
        if (
          !existsSync(attempt.workspace) ||
          git(attempt.workspace, ["rev-parse", "HEAD"]) !== retainedRepair.artifact ||
          !this.preparationAllowed(attempt) ||
          this.store
            .activeProjectAttempts()
            .some(
              (other) =>
                other.id !== attempt.id &&
                samePhysicalWorkspace(other.workspace, attempt.workspace),
            )
        )
          throw new Error(
            "Retained artifact or effective scope reservation changed before admission",
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
          .run(plan.id, command.expectedVersion + 1).changes
        if (cleared !== 1 || updatedAttempt !== 1 || updatedPlan !== 1)
          throw new Error("Retained repair authorization changed during atomic admission")
        this.store.record(plan.id, task.id, "RETAINED_REPAIR_REQUESTED", {
          operationID: retainedRepair.operationID,
          requestID: command.requestID,
          owner: caller,
          ownerEpoch: retainedRepair.ownerEpoch,
          expectedVersion: command.expectedVersion,
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
      if (command.action === "extend-verification-deadline") {
        const prepared = verificationDeadlineExtension
        if (
          !prepared ||
          !ownerSession ||
          !this.validArchitect(ownerSession) ||
          ownerSession.id !== plan.owner ||
          ownerSession.projectID !== this.projectID
        )
          throw new Error("Verification deadline extension requires the current Architect owner")
        this.assertVerificationDeadlineExtensionCurrent(plan, command, caller, prepared)
        if (
          this.store.activeAdoptions(plan.id).length ||
          activeRetainedVerifications(db, this.directory, plan.id).some(
            (operation) => operation.id !== prepared.retained?.operation.id,
          ) ||
          (!prepared.retained &&
            this.store
              .effects(plan.id)
              .some((effect) => ["intended", "uncertain"].includes(effect.state))) ||
          verificationActivitiesForDatabase(this.store.repository.path).some(
            (activity) => activity.metadata.planID === plan.id && activity.state === "running",
          )
        )
          throw new Error("An active or uncertain check/resource prevents deadline extension")
        const changed = db
          .query(
            `UPDATE runner_plans SET version=version+1
             WHERE id=? AND project_directory=? AND owner=? AND version=? AND revision=?
               AND state=? AND artifact IS ?`,
          )
          .run(
            plan.id,
            this.directory,
            caller,
            command.expectedVersion,
            prepared.target.planRevision,
            plan.state,
            plan.artifact,
          ).changes
        if (changed !== 1)
          throw new Error("Verification deadline plan changed during owner authorization")
        const nextPlan = this.store.plan(plan.id)!
        const amendmentID = crypto.randomUUID()
        const amendment = VerificationTimeoutAmendmentSchema.parse({
          schemaVersion: 1,
          amendmentID,
          policyRevision: prepared.deadline.policyRevision + 1,
          requestID: command.requestID,
          projectID: this.projectID,
          projectDirectory: this.directory,
          planID: plan.id,
          planRevision: plan.revision,
          planVersion: nextPlan.version,
          owner: caller,
          ownerEpoch: prepared.ownerEpoch,
          phase: prepared.target.phase,
          taskID: prepared.target.taskID,
          taskRevision: prepared.target.taskRevision,
          attemptID: prepared.target.attemptID,
          artifact: prepared.target.artifact,
          checkID: prepared.target.checkID,
          commandFingerprint: verificationCommandFingerprint(prepared.target.command),
          authoredTimeoutMs: prepared.deadline.authoredTimeoutMs,
          previousTimeoutMs: prepared.deadline.effectiveTimeoutMs,
          effectiveTimeoutMs: prepared.effectiveHardTimeoutMs,
          timingPolicyVersion: 2,
          authoredInactivityTimeoutMs: prepared.deadline.authoredInactivityTimeoutMs,
          authoredHardTimeoutMs: prepared.deadline.authoredHardTimeoutMs,
          defaultInactivityTimeoutMs: prepared.deadline.defaultInactivityTimeoutMs,
          defaultHardTimeoutMs: prepared.deadline.defaultHardTimeoutMs,
          previousInactivityTimeoutMs: prepared.deadline.effectiveInactivityTimeoutMs,
          effectiveInactivityTimeoutMs: prepared.effectiveInactivityTimeoutMs,
          previousHardTimeoutMs: prepared.deadline.effectiveHardTimeoutMs,
          effectiveHardTimeoutMs: prepared.effectiveHardTimeoutMs,
          ...(prepared.retained
            ? {
                retainedVerificationID: prepared.retained.operation.id,
                retainedGeneration: prepared.retained.operation.generation,
                retainedTaskID: prepared.retained.operation.taskID,
                retainedTaskRevision: prepared.retained.operation.taskRevision,
                retainedAttemptID: prepared.retained.operation.attemptID,
              }
            : {}),
          reason: command.reason!.trim(),
          createdAt: this.now(),
        }) satisfies VerificationTimeoutAmendment
        this.store.record(plan.id, amendment.taskID, "VERIFICATION_DEADLINE_EXTENDED", amendment)
        if (prepared.retained) {
          const { operation, check, receipt, resources } = prepared.retained
          const current = retainedVerification(db, operation.id)
          if (
            !current ||
            current.generation !== operation.generation ||
            !["held", "cancelled"].includes(current.state) ||
            current.planVersion !== operation.planVersion
          )
            throw new Error("Held retained verification changed before explicit continuation")
          this.store.record(
            plan.id,
            operation.taskID,
            "RETAINED_VERIFICATION_CHECK_RETRY_AUTHORIZED",
            {
              requestID: command.requestID,
              owner: caller,
              ownerEpoch: prepared.ownerEpoch,
              priorOwner: operation.owner,
              priorOwnerEpoch: operation.ownerEpoch,
              planRevision: operation.planRevision,
              operationID: operation.id,
              generation: operation.generation,
              taskID: operation.taskID,
              taskRevision: operation.taskRevision,
              attemptID: operation.attemptID,
              phase: prepared.target.phase,
              checkID: prepared.target.checkID,
              candidateArtifact: prepared.target.artifact,
              commandFingerprint: verificationCommandFingerprint(prepared.target.command),
              amendmentID: amendment.amendmentID,
              priorReceipt: receipt,
              priorReceiptFingerprint: fingerprint(check.receipt),
              priorCheckFingerprint: fingerprint(check.checkJSON),
              priorCheck: JSON.parse(check.checkJSON) as unknown,
              priorReceiptPath: check.receiptPath,
              priorResources: resources,
              reason: amendment.reason,
            },
          )
          const reactivated: RetainedVerification = {
            ...current,
            planVersion: nextPlan.version,
            owner: caller,
            ownerEpoch: prepared.ownerEpoch,
            state: prepared.target.phase === "task" ? "task-checks" : "combined-checks",
            holdReason: null,
            updatedAt: this.now(),
          }
          saveRetainedVerification(db, reactivated)
          authorizeRetainedVerificationCheckRetry(db, {
            operationID: operation.id,
            phase: prepared.target.phase,
            checkID: prepared.target.checkID,
            receiptFingerprint: fingerprint(check.receipt),
          })
        }
        return {
          status: prepared.retained
            ? "retained-verification-check-continued"
            : "verification-deadline-extended",
          planID: plan.id,
          phase: amendment.phase,
          taskID: amendment.taskID,
          attemptID: amendment.attemptID,
          artifact: amendment.artifact,
          checkID: amendment.checkID,
          authoredTimeoutMs: amendment.authoredTimeoutMs,
          previousTimeoutMs: amendment.previousTimeoutMs,
          effectiveTimeoutMs: amendment.effectiveTimeoutMs,
          previousInactivityTimeoutMs: amendment.previousInactivityTimeoutMs,
          effectiveInactivityTimeoutMs: amendment.effectiveInactivityTimeoutMs,
          previousHardTimeoutMs: amendment.previousHardTimeoutMs,
          effectiveHardTimeoutMs: amendment.effectiveHardTimeoutMs,
          amendmentID: amendment.amendmentID,
          policyRevision: amendment.policyRevision,
          reason: amendment.reason,
          version: nextPlan.version,
        }
      }
      if (command.action === "amend-scope") {
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
              !writers.every((writer) =>
                sourceReservationExcluded(this.store, other, {
                  mode: writer.workspace === this.directory ? "shared" : "isolated",
                  workspace: writer.workspace,
                }),
              ) &&
              scopePatternsConflict(writeScope, this.store.effectiveWriteScope(other.task_id))
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
        return {
          status: "scope-amended",
          version: plan.version + 1,
          writeScope,
          instructionUpdates,
        }
      }
      if (command.action === "reconcile-source-notices") {
        if (!sourceNoticeReconciliation || !command.sourceSessionID)
          throw new Error("Source notice reconciliation was not prepared")
        if (plan.owner !== caller || plan.version !== command.expectedVersion)
          throw new Error("Source notice reconciliation owner or version changed")
        return sourceNoticeReconciliation
      }
      if (command.action === "adopt-descendant") {
        if (!adoptionSeed || !ownerSession || !this.validArchitect(ownerSession))
          throw new Error("Descendant adoption requires the current same-project Architect owner")
        if (ownerSession.id !== plan.owner || caller !== plan.owner)
          throw new Error("Descendant adoption owner changed")
        const adoptionID = crypto.randomUUID()
        const adoption = this.store.createAdoption({
          id: adoptionID,
          planID: plan.id,
          taskID: adoptionSeed.taskID,
          writeScope: this.store.effectiveWriteScope(adoptionSeed.taskID),
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
      if (command.action === "verify-retained") {
        const seed = retainedVerificationSeed
        if (!seed || !ownerSession || !this.validArchitect(ownerSession))
          throw new Error("Retained verification requires the current same-project Architect owner")
        if (
          ownerSession.id !== plan.owner ||
          caller !== plan.owner ||
          plan.version !== seed.planVersion ||
          plan.revision !== seed.planRevision ||
          this.store.planControlEpoch(plan.id) !== seed.ownerEpoch ||
          command.projectID !== this.projectID ||
          command.taskID !== seed.taskID ||
          command.taskRevision !== seed.taskRevision ||
          command.attemptID !== seed.attemptID ||
          command.artifact !== seed.artifact
        )
          throw new Error(
            "Retained verification authorization or candidate changed before reservation",
          )
        const taskRow = db
          .query<{ project_directory: string; body: string }, [string, string]>(
            "SELECT project_directory,body FROM tasks WHERE project_directory=? AND id=?",
          )
          .get(this.directory, seed.taskID)
        const reservedTask = taskRow ? this.store.repository.get(seed.taskID) : undefined
        const latestAttempt = this.store
          .attempts(plan.id)
          .filter((attempt) => attempt.task_id === seed.taskID)
          .at(-1)
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
        const sourceQuarantineCurrent = Boolean(
          seed.sourceQuarantine &&
          ["running", "blocked", "accepted", "cleanup-blocked"].includes(plan.state) &&
          latestAttempt &&
          latestAttempt.state === "verifying" &&
          nodeRow?.state === "verifying" &&
          sourceQuarantineVerificationBindingMatches(this.store, {
            planID: plan.id,
            owner: seed.owner,
            attempt: latestAttempt,
            artifact: seed.artifact,
            expected: seed.sourceQuarantine,
          }),
        )
        if (
          (seed.sourceQuarantine
            ? !sourceQuarantineCurrent
            : !["blocked", "accepted", "cleanup-blocked"].includes(plan.state)) ||
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
              git(seed.originalWorkspace, ["rev-parse", "HEAD"]) !== seed.artifact
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
          holdReason: null,
          cleanupState: "pending",
          createdAt: this.now(),
          updatedAt: this.now(),
        })
        this.store.record(plan.id, operation.taskID, "RETAINED_VERIFICATION_REQUESTED", {
          operationID: operation.id,
          generation: operation.generation,
          taskRevision: operation.taskRevision,
          attemptID: operation.attemptID,
          artifact: operation.artifact,
          combinedArtifact: operation.combinedArtifact,
          owner: operation.owner,
          ownerEpoch: operation.ownerEpoch,
          requestID: command.requestID,
          oldExecutionAndResourceHoldsPreserved: true,
        })
        return {
          status: "retained-verification-requested",
          operationID: operation.id,
          generation: operation.generation,
          taskID: operation.taskID,
          attemptID: operation.attemptID,
          artifact: operation.artifact,
          combinedArtifact: operation.combinedArtifact,
          retainedVerification: { operationID: operation.id, generation: operation.generation },
          probeBasis: {
            task: retainedVerificationProbeBasis(operation, "task"),
            ...(operation.combinedArtifact
              ? { combined: retainedVerificationProbeBasis(operation, "combined") }
              : {}),
          },
          version: plan.version,
        }
      }
      if (command.action === "cancel-retained-verification") {
        if (!command.retainedVerificationID || !ownerSession || !this.validArchitect(ownerSession))
          throw new Error("Retained verification cancellation requires the current Architect owner")
        if (ownerSession.id !== plan.owner || caller !== plan.owner)
          throw new Error("Retained verification cancellation owner changed")
        const operation = retainedVerification(db, command.retainedVerificationID)
        if (
          !operation ||
          operation.planID !== plan.id ||
          operation.projectDirectory !== this.directory ||
          ![
            "pending",
            "task-checks",
            "combined-checks",
            "waiting-human",
            "waiting-human-combined",
            "task-accepted",
            "held",
          ].includes(operation.state)
        )
          throw new Error("Cancellation must name a current retained verification generation")
        const cancelled: RetainedVerification = {
          ...operation,
          state: "cancelled",
          holdReason: command.reason ?? "Cancelled by the current Architect owner",
          updatedAt: this.now(),
        }
        saveRetainedVerification(db, cancelled)
        db.query(
          `UPDATE runner_retained_verification_resources SET state=lz_runner_transition('resource',state,'uncertain'),updated_at=?
           WHERE operation_id=? AND state IN ('creating','active')`,
        ).run(this.now(), operation.id)
        this.retainedVerificationAborts.get(operation.id)?.abort()
        this.store.record(plan.id, operation.taskID, "RETAINED_VERIFICATION_CANCELLED", {
          operationID: operation.id,
          generation: operation.generation,
          source: "owner-command",
          previousState: operation.state,
          previousHoldReason: operation.holdReason,
          reason: cancelled.holdReason,
          oldExecutionAndResourceHoldsPreserved: true,
        })
        return {
          status: "retained-verification-cancelled",
          operationID: operation.id,
          generation: operation.generation,
          version: plan.version,
        }
      }
      if (command.action === "recover-cleanup") {
        if (
          !this.validArchitect(ownerSession) ||
          ownerSession.id !== plan.owner ||
          caller !== plan.owner
        )
          throw new Error("Cleanup recovery requires the current Architect owner")
        if (plan.state !== "cleanup-blocked")
          throw new Error("Cleanup recovery is available only for an existing cleanup hold")
        if (!command.taskID || !command.attemptID || !command.artifact || !command.targetBranch)
          throw new Error("Cleanup recovery requires the exact accepted task and attempt")
        const node = this.store.nodes(plan.id).find((item) => item.task_id === command.taskID)
        const proposal = PlanInput.parse(JSON.parse(plan.body))
        const proposedNode = proposal.nodes.find((item) => item.taskID === command.taskID)
        const task = this.store.repository.get(command.taskID)
        const attempts = this.store
          .attempts(plan.id)
          .filter((candidate) => candidate.task_id === command.taskID)
        const attempt = attempts.at(-1)
        if (
          !node ||
          node.state !== "accepted" ||
          node.artifact !== command.artifact ||
          !proposedNode ||
          !task ||
          task.revision !== proposedNode.revision ||
          task.provenance.projectID !== this.projectID ||
          task.provenance.projectDirectory !== this.directory ||
          !attempt ||
          attempt.id !== command.attemptID ||
          attempt.state !== "accepted" ||
          attempt.artifact !== command.artifact
        )
          throw new Error("Cleanup recovery task, accepted artifact or latest attempt changed")
        const sourceEffect = this.store.effects(plan.id).find((effect) => {
          if (
            !["worktree", "worktree-recovery"].includes(effect.kind) ||
            effect.state !== "completed" ||
            effect.attempt_id !== attempt.id
          )
            return false
          try {
            return JSON.parse(effect.receipt ?? "{}").workspace === attempt.workspace
          } catch {
            return false
          }
        })
        if (!sourceEffect || attempt.workspace === this.directory || !existsSync(attempt.workspace))
          throw new Error(
            "Exact owned attempt worktree is unavailable; preserve it for reconciliation",
          )
        const taskIntegration = this.store.latestTransition<{
          artifact?: string
          branch?: string
        }>(plan.id, command.taskID, "TASK_INTEGRATION_RECORDED")
        const planIntegration = this.store.latestTransition<{
          artifact?: string
          branch?: string
        }>(plan.id, null, "INTEGRATION_RECORDED")
        const integrated =
          (taskIntegration?.artifact === command.artifact &&
            taskIntegration.branch === command.targetBranch) ||
          (planIntegration?.artifact === plan.artifact &&
            planIntegration.branch === command.targetBranch)
        if (!integrated)
          throw new Error("Cleanup recovery requires a durable matching source integration record")
        if (git(this.directory, ["branch", "--show-current"]) !== command.targetBranch)
          throw new Error("The current checkout is not the recorded integration target branch")
        git(this.directory, ["merge-base", "--is-ancestor", command.artifact, "HEAD"])
        if (git(attempt.workspace, ["status", "--porcelain"]))
          throw new Error(`Accepted attempt worktree is dirty; preserve ${attempt.workspace}`)

        const ownerEpoch = this.store.planControlEpoch(plan.id)
        this.store.record(plan.id, command.taskID, "WORKTREE_CLEANUP_RECOVERY_AUTHORIZED", {
          schemaVersion: 1,
          projectDirectory: this.directory,
          planID: plan.id,
          planRevision: plan.revision,
          planArtifact: plan.artifact,
          taskID: command.taskID,
          taskRevision: proposedNode.revision,
          attemptID: attempt.id,
          artifact: command.artifact,
          workspace: attempt.workspace,
          sourceEffectID: sourceEffect.id,
          sessionID: attempt.session_id,
          assignedMessageID: attempt.message_id,
          owner: caller,
          ownerEpoch,
          targetBranch: command.targetBranch,
          requestID: command.requestID,
          reason: command.reason ?? "Owner-authorized native cleanup recovery",
        } satisfies CleanupRecoveryAuthorization)
        const changed = db
          .query(
            `UPDATE runner_plans SET version=version+1
             WHERE id=? AND project_directory=? AND owner=? AND version=? AND state='cleanup-blocked'`,
          )
          .run(plan.id, this.directory, caller, command.expectedVersion).changes
        if (changed !== 1)
          throw new Error("Cleanup recovery plan changed during owner authorization")
        return {
          status: "cleanup-recovery-requested",
          taskID: attempt.task_id,
          attemptID: attempt.id,
          workspace: attempt.workspace,
          version: this.store.plan(plan.id)!.version,
        }
      }
      if (command.action === "integrated") {
        if (command.taskID) {
          const node = this.store.nodes(plan.id).find((item) => item.task_id === command.taskID)
          if (node?.state !== "accepted" || !node.artifact)
            throw new Error("Only an accepted task result can be recorded as integrated")
          if (command.artifact !== node.artifact || !command.targetBranch || !command.reason)
            throw new Error("Record the accepted task artifact, reviewed targetBranch and reason")
          if (git(this.directory, ["branch", "--show-current"]) !== command.targetBranch)
            throw new Error("The current checkout is not the reviewed target branch")
          git(this.directory, ["merge-base", "--is-ancestor", node.artifact, "HEAD"])
          const head = git(this.directory, ["rev-parse", "HEAD"])
          this.store.record(plan.id, node.task_id, "TASK_INTEGRATION_RECORDED", {
            artifact: node.artifact,
            branch: command.targetBranch,
            head,
            reason: command.reason,
          })
          db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(plan.id)
          // A task source landing is not combined acceptance. Keep its artifact
          // and workspace available to dependencies until normal plan cleanup.
          return { status: "task-integration-recorded", version: plan.version + 1, head }
        }
        if (!["accepted", "cleanup-blocked"].includes(plan.state) || !plan.artifact)
          throw new Error("Only an accepted result can be integrated")
        if (command.artifact !== plan.artifact || !command.targetBranch || !command.reason)
          throw new Error("Record the accepted artifact, reviewed targetBranch and reason")
        if (git(this.directory, ["branch", "--show-current"]) !== command.targetBranch)
          throw new Error("The current checkout is not the reviewed target branch")
        git(this.directory, ["merge-base", "--is-ancestor", plan.artifact, "HEAD"])
        this.store.record(plan.id, null, "INTEGRATION_RECORDED", {
          artifact: plan.artifact,
          branch: command.targetBranch,
          head: git(this.directory, ["rev-parse", "HEAD"]),
          reason: command.reason,
        })
        db.query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'cleaning'),reason=NULL,version=version+1 WHERE id=?",
        ).run(plan.id)
        return { status: "cleanup-requested", version: this.store.plan(plan.id)!.version }
      }
      if (command.action === "pause" || command.action === "unpause") {
        if (!this.validArchitect(ownerSession) || ownerSession.id !== plan.owner)
          throw new Error("Pause controls require the current Architect")
        if (terminal.has(plan.state) || ["cancelling", "cleaning"].includes(plan.state))
          throw new Error("Plan has ended")
        const untilPlans = command.resumeAfterPlans ?? []
        if (command.action === "pause") this.store.validatePlanDependencies(untilPlans, plan.id)
        this.store.setDispatchPause(
          plan.id,
          command.action === "pause"
            ? { reason: command.reason ?? "Paused by Architect", untilPlans }
            : null,
          { caller, reason: command.reason },
        )
        return {
          status: command.action === "pause" ? "paused" : "unpaused",
          version: this.store.plan(plan.id)!.version,
        }
      }
      if (command.action === "schedule") {
        if (terminal.has(plan.state) || plan.state === "cancelling" || plan.state === "cleaning")
          throw new Error("Plan has ended")
        if (!command.reason) throw new Error("Scheduling changes require a reason")
        const attempts = this.store.attempts(plan.id)
        if (
          attempts.length &&
          (command.afterPlans !== undefined ||
            command.baseCommit !== undefined ||
            command.workspaceMode !== undefined)
        )
          throw new Error("Only priority may change after execution has started")
        const updated = PlanInput.parse({
          ...JSON.parse(plan.body),
          ...(command.priority !== undefined ? { priority: command.priority } : {}),
          ...(command.afterPlans !== undefined ? { afterPlans: command.afterPlans } : {}),
          ...(command.baseCommit !== undefined ? { baseCommit: command.baseCommit } : {}),
          ...(command.workspaceMode !== undefined ? { workspaceMode: command.workspaceMode } : {}),
        })
        this.store.validatePlanDependencies(updated.afterPlans ?? [], plan.id)
        if (command.baseCommit)
          git(this.directory, ["merge-base", "--is-ancestor", command.baseCommit, "HEAD"])
        this.store.revisePlan(plan, updated, "SCHEDULE_UPDATED", {
          caller,
          reason: command.reason,
          priority: updated.priority ?? 0,
          afterPlans: updated.afterPlans ?? [],
          baseCommit: updated.baseCommit,
        })
        return { status: "scheduled", version: this.store.plan(plan.id)!.version }
      }
      if (command.action === "audit")
        return {
          status: "audited",
          ...this.store.audit(),
          version: plan.version,
          ...(cleanupDiagnostics ? { cleanupDiagnostics } : {}),
        }
      if (command.action === "settle-startup") {
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
        if (settledEffect !== 1)
          throw new Error("Original startup effect changed before settlement")
        const reason =
          "Startup worktree failure evidence was settled after all reserved resources were confirmed absent; explicit resume is required"
        const changed = db
          .query(
            `UPDATE runner_plans SET reason=?,version=version+1
             WHERE id=? AND project_directory=? AND owner=? AND version=? AND state='blocked'`,
          )
          .run(
            reason,
            plan.id,
            this.store.repository.projectDirectory,
            caller,
            command.expectedVersion,
          ).changes
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
      if (command.action === "reassign") {
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
      if (command.action === "cancel") {
        if (terminal.has(plan.state)) throw new Error("Plan has ended")
        this.store.cancelAdoptions(plan.id, "Cancellation requested")
        for (const operation of activeRetainedVerifications(db, this.directory, plan.id)) {
          saveRetainedVerification(db, {
            ...operation,
            state: "cancelled",
            holdReason: "Plan cancellation requested",
            updatedAt: this.now(),
          })
          db.query(
            `UPDATE runner_retained_verification_resources SET state=lz_runner_transition('resource',state,'uncertain'),updated_at=?
             WHERE operation_id=? AND state IN ('creating','active')`,
          ).run(this.now(), operation.id)
          this.retainedVerificationAborts.get(operation.id)?.abort()
          this.store.record(plan.id, operation.taskID, "RETAINED_VERIFICATION_CANCELLED", {
            operationID: operation.id,
            generation: operation.generation,
            source: "plan-cancellation",
            previousState: operation.state,
            previousHoldReason: operation.holdReason,
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
      if (command.action === "human-evidence") {
        if (!command.assertionID || !command.artifact || !command.reason)
          throw new Error("Human evidence requires assertion, exact artifact and decision")
        if (command.retainedVerificationID) {
          if (!ownerSession || !this.validArchitect(ownerSession) || ownerSession.id !== plan.owner)
            throw new Error(
              "Retained verification evidence requires the current same-project Architect",
            )
          const operation = retainedVerification(db, command.retainedVerificationID)
          if (
            !operation ||
            operation.planID !== plan.id ||
            operation.owner !== caller ||
            operation.ownerEpoch !== this.store.planControlEpoch(plan.id) ||
            operation.planVersion !== plan.version ||
            operation.planRevision !== plan.revision ||
            ![
              "pending",
              "task-checks",
              "combined-checks",
              "waiting-human",
              "waiting-human-combined",
            ].includes(operation.state)
          )
            throw new Error("Human evidence must name the current retained verification generation")
          const taskEvidence = command.taskID === operation.taskID
          if (command.taskID && !taskEvidence)
            throw new Error("Retained task evidence must name its exact task")
          const assertions = taskEvidence
            ? (this.store.repository.get(operation.taskID)?.proposal.acceptance ?? [])
            : PlanInput.parse(JSON.parse(plan.body)).acceptance
          const artifact = taskEvidence ? operation.artifact : operation.combinedArtifact
          const assertion = assertions.find((item) => item.id === command.assertionID)
          if (
            !artifact ||
            command.artifact !== artifact ||
            !assertion?.evidence.some((item) => item.kind === "human")
          )
            throw new Error(
              "Human evidence does not bind to the retained assertion, phase and exact candidate",
            )
          recordRetainedVerificationEvidence(db, {
            id: crypto.randomUUID(),
            operationID: operation.id,
            generation: operation.generation,
            phase: taskEvidence ? "task" : "combined",
            taskID: taskEvidence ? operation.taskID : null,
            assertionID: assertion.id,
            artifact,
            body: JSON.stringify({ decision: command.reason, caller }),
            createdAt: this.now(),
          })
          this.store.record(
            plan.id,
            command.taskID ?? null,
            "RETAINED_VERIFICATION_HUMAN_EVIDENCE",
            {
              operationID: operation.id,
              generation: operation.generation,
              assertionID: assertion.id,
              artifact,
              phase: taskEvidence ? "task" : "combined",
            },
          )
          return { status: "recorded", operationID: operation.id, generation: operation.generation }
        }
        if (command.adoptionID) {
          const adoption = this.store.adoption(command.adoptionID)
          if (
            !adoption ||
            adoption.plan_id !== plan.id ||
            adoption.owner !== caller ||
            !["pending", "task-checks", "combined-checks", "waiting-human"].includes(adoption.state)
          )
            throw new Error("Human evidence must name a current pending descendant adoption")
          const taskEvidence = command.taskID === adoption.task_id
          if (command.taskID && !taskEvidence)
            throw new Error("Adoption task evidence must name its exact task")
          const assertions = taskEvidence
            ? (this.store.repository.get(adoption.task_id)?.proposal.acceptance ?? [])
            : PlanInput.parse(JSON.parse(plan.body)).acceptance
          const artifact = taskEvidence ? adoption.descendant_commit : adoption.combined_artifact
          const assertion = assertions.find((item) => item.id === command.assertionID)
          if (command.artifact !== artifact || !assertion?.evidence.some((e) => e.kind === "human"))
            throw new Error("Human evidence does not bind to the adoption assertion/artifact")
          this.store.recordAdoptionEvidence({
            id: crypto.randomUUID(),
            adoptionID: adoption.id,
            taskID: taskEvidence ? adoption.task_id : null,
            phase: taskEvidence ? "task" : "combined",
            assertionID: assertion.id,
            artifact,
            body: { decision: command.reason, caller },
          })
          this.store.record(plan.id, command.taskID ?? null, "DESCENDANT_ADOPTION_HUMAN_EVIDENCE", {
            adoptionID: adoption.id,
            assertionID: assertion.id,
            artifact,
          })
          return { status: "recorded", version: this.store.plan(plan.id)!.version }
        }
        const nodes = this.store.nodes(plan.id)
        let assertions: TaskProposal["acceptance"]
        let artifact: string | null
        if (command.taskID) {
          artifact = nodes.find((node) => node.task_id === command.taskID)?.artifact ?? null
          assertions = this.store.repository.get(command.taskID)?.proposal.acceptance ?? []
        } else {
          const input = PlanInput.parse(JSON.parse(plan.body))
          const ordered = input.integrationOrder.map((id) =>
            nodes.find((node) => node.task_id === id),
          )
          if (ordered.some((node) => node?.state !== "accepted" || !node.artifact))
            throw new Error("Plan evidence requires all accepted task artifacts")
          artifact = humanCombinedArtifact ?? null
          assertions = input.acceptance
        }
        const assertion = assertions.find((item) => item.id === command.assertionID)
        if (artifact !== command.artifact || !assertion?.evidence.some((e) => e.kind === "human"))
          throw new Error("Human evidence does not bind to the current assertion/artifact")
        const sourceGeneration = command.taskID
          ? this.retainedRepairGeneration(plan.id, command.taskID)
          : this.retainedRepairGeneration(plan.id)
        db.query("INSERT INTO runner_evidence VALUES(?,?,?,?,?,'human',?,?,?)").run(
          crypto.randomUUID(),
          plan.id,
          command.taskID ?? null,
          null,
          assertion.id,
          command.artifact,
          JSON.stringify({
            decision: command.reason,
            caller,
            ...(sourceGeneration ? { sourceGeneration } : {}),
          }),
          Date.now(),
        )
        this.store.record(plan.id, command.taskID ?? null, "HUMAN_EVIDENCE", {
          assertionID: assertion.id,
          artifact: command.artifact,
        })
        return { status: "recorded", version: this.store.plan(plan.id)!.version }
      }
      if (command.action === "resume" || command.action === "retry") {
        const retry = command.action === "retry"
        if (!ownerSession || ownerSession.archived) throw new Error("Owner unavailable")
        if (!command.taskID) {
          if (retry || !combinedVerificationResume || !command.reason?.trim())
            throw new Error("Resume requires an exact task attempt or a settled combined check")
          if (
            plan.state !== "blocked" ||
            plan.artifact !== null ||
            plan.owner !== caller ||
            ownerSession.id !== plan.owner ||
            !this.validArchitect(ownerSession) ||
            plan.version !== combinedVerificationResume.expectedPlanVersion ||
            plan.revision !== combinedVerificationResume.planRevision ||
            this.store.planControlEpoch(plan.id) !== combinedVerificationResume.ownerEpoch
          )
            throw new Error("Combined verification owner or plan authorization changed")

          const input = PlanInput.parse(JSON.parse(plan.body))
          const acceptedArtifacts = this.acceptedCombinedArtifacts(plan, input)
          const sourceGeneration = this.retainedRepairGeneration(plan.id) ?? null
          const { inputFingerprint, ...bindingData } = combinedVerificationResume
          const currentBinding: CombinedVerificationContinuationBinding = {
            ...bindingData,
            owner: plan.owner,
            ownerEpoch: this.store.planControlEpoch(plan.id),
            planRevision: plan.revision,
            expectedPlanVersion: command.expectedVersion,
            resumedPlanVersion: plan.version + 1,
            planBodyFingerprint: fingerprint(plan.body),
            acceptedArtifacts,
            artifact: combinedVerificationResume.artifact,
            workspace: combinedVerificationResume.workspace,
            sourceGeneration,
            verificationEpoch: plan.version + 1,
            interruptedEffects: combinedVerificationResume.interruptedEffects,
          }
          if (
            combinedVerificationContinuationFingerprint(currentBinding) !== inputFingerprint ||
            combinedVerificationContinuationFingerprint(bindingData) !== inputFingerprint
          )
            throw new Error("Combined verification continuation inputs changed before reservation")

          const effects = this.store.effects(plan.id)
          const interrupted = this.interruptedCombinedVerificationEffects(
            plan,
            input,
            currentBinding.artifact,
            sourceGeneration ?? undefined,
          ).toSorted((left, right) => left.id.localeCompare(right.id))
          const expectedEffects = currentBinding.interruptedEffects
          const settledTimeouts = this.settledExtendedCombinedTimeouts(
            plan,
            input,
            currentBinding.artifact,
            sourceGeneration ?? undefined,
          ).toSorted((left, right) => left.id.localeCompare(right.id))
          const timeoutBindings = settledTimeouts.map((effect) => ({
            id: effect.id,
            payloadFingerprint: fingerprint(effect.payload),
            receiptFingerprint: fingerprint(effect.receipt),
          }))
          if (
            fingerprint(
              interrupted.map((effect) => ({
                id: effect.id,
                payloadFingerprint: fingerprint(effect.payload),
                receiptFingerprint: fingerprint(effect.receipt),
              })),
            ) !== fingerprint(expectedEffects) ||
            fingerprint(timeoutBindings) !== fingerprint(currentBinding.settledTimeouts ?? []) ||
            effects.some(
              (effect) =>
                ["intended", "uncertain"].includes(effect.state) &&
                !expectedEffects.some((expected) => expected.id === effect.id),
            )
          )
            throw new Error("Combined verification effects changed; reconcile them before resuming")
          if (
            verificationActivitiesForDatabase(this.store.repository.path).some(
              (activity) => activity.metadata.planID === plan.id && activity.state === "running",
            )
          )
            throw new Error("A live verification activity prevents combined verification resume")
          if (
            activeRetainedVerifications(db, this.directory, plan.id).length > 0 ||
            this.store.activeAdoptions(plan.id).length > 0
          )
            throw new Error(
              "An unresolved verification or adoption prevents combined verification resume",
            )
          if (
            !existsSync(currentBinding.workspace) ||
            git(currentBinding.workspace, ["rev-parse", "HEAD"]) !== currentBinding.artifact ||
            !artifactUnchanged(currentBinding.workspace, currentBinding.artifact)
          )
            throw new Error(
              "Interrupted combined verification candidate changed before reservation",
            )

          for (const expected of expectedEffects) {
            const current = interrupted.find((effect) => effect.id === expected.id)
            if (!current)
              throw new Error(
                "Interrupted combined verification receipt changed before reservation",
              )
            const changed = db
              .query(
                `UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed')
                 WHERE id=? AND plan_id=? AND task_id IS NULL AND attempt_id IS NULL
                   AND state='uncertain' AND payload=? AND receipt=?`,
              )
              .run(expected.id, plan.id, current.payload, current.receipt).changes
            if (changed !== 1)
              throw new Error(
                "Interrupted combined verification receipt changed before reservation",
              )
          }
          const changedPlan = db
            .query(
              `UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1
               WHERE id=? AND owner=? AND version=? AND state='blocked' AND artifact IS NULL`,
            )
            .run(plan.id, caller, command.expectedVersion).changes
          if (changedPlan !== 1)
            throw new Error("Combined verification plan changed before reservation")
          const resumed = this.store.plan(plan.id)!
          if (resumed.version !== currentBinding.verificationEpoch)
            throw new Error("Combined verification epoch changed before reservation")
          this.store.record(plan.id, null, "RECONCILE_REQUESTED", {
            caller,
            verificationEpoch: resumed.version,
            continuation: "interrupted-combined-verification",
            combinedVerificationContinuation: combinedVerificationResume,
          })
          return {
            status: "combined-verification-resumed",
            planID: plan.id,
            artifact: currentBinding.artifact,
            interruptedEffectIDs: expectedEffects.map((effect) => effect.id),
            verificationEpoch: resumed.version,
            version: resumed.version,
          }
        }
        if (!command.taskID || !command.reason) throw new Error("Resume requires taskID and reason")
        const node = this.store.nodes(plan.id).find((n) => n.task_id === command.taskID)
        const attempt = this.store
          .attempts(plan.id)
          .filter((a) => a.task_id === command.taskID)
          .at(-1)
        if (command.attemptID && command.attemptID !== attempt?.id)
          throw new Error("Command attemptID does not match the exact latest task attempt")
        if (retainedRepairRecovery) {
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
            ownerSession?.id !== plan.owner ||
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
              ownerEpoch: retainedRepairRecovery.ownerEpoch,
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
        if (!retry && node?.state === "verifying" && attempt?.state === "verifying") {
          const interrupted = [
            ...this.interruptedChecksFor(plan, attempt),
            ...this.settledExtendedTaskTimeouts(plan, attempt),
          ].filter(
            (effect, index, effects) =>
              effects.findIndex((candidate) => candidate.id === effect.id) === index,
          )
          if (interrupted.length) {
            if (
              plan.state !== "blocked" ||
              !this.validArchitect(ownerSession) ||
              command.attemptID !== attempt.id ||
              command.workspaceMode !== undefined ||
              command.baseCommit !== undefined
            )
              throw new Error(
                "Interrupted verification resume requires its exact preserved attempt",
              )
            const interruptedIDs = new Set(interrupted.map((effect) => effect.id))
            if (
              this.store
                .effects(plan.id)
                .some(
                  (effect) =>
                    ["intended", "uncertain"].includes(effect.state) &&
                    !interruptedIDs.has(effect.id),
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
        }
        const continuingTerminalWorker = Boolean(
          !retry &&
          terminalContinuation &&
          attempt?.id === terminalContinuation.attemptID &&
          attempt.message_id === terminalContinuation.messageID,
        )
        if (continuingTerminalWorker) {
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
                currentRepair.operationID !== terminalRepairContinuation.operationID ||
                currentRepair.owner !== terminalRepairContinuation.owner ||
                currentRepair.ownerEpoch !== terminalRepairContinuation.ownerEpoch)) ||
            (terminalRepairContinuation && latestRepair?.attemptID !== attempt!.id)
          )
            throw new Error("Retained repair continuation authority changed before reservation")
        }
        if (retry && node?.state === "cancelled" && !attempt) {
          if (
            !["blocked", "cancelled", "failed", "running"].includes(plan.state) ||
            plan.artifact !== null
          )
            throw new Error("Only an admitted, nonintegrated plan can requeue an unstarted task")
          if (ownerSession.id !== plan.owner || ownerSession.projectID !== this.projectID)
            throw new Error("Foreign owner session")
          if (
            this.store
              .effects(plan.id)
              .some((effect) => ["intended", "uncertain"].includes(effect.state))
          )
            throw new Error("Reconcile uncertain effects first")

          const input = PlanInput.parse(JSON.parse(plan.body))
          if (command.baseCommit !== undefined && command.baseCommit !== input.baseCommit) {
            if (this.store.attempts(plan.id).length)
              throw new Error("A plan with prior attempts cannot change its unstarted baseline")
            const baseCommit = git(this.directory, ["rev-parse", `${command.baseCommit}^{commit}`])
            if (baseCommit !== command.baseCommit)
              throw new Error("An explicit baseline must identify a commit")
            git(this.directory, ["merge-base", "--is-ancestor", input.baseCommit, baseCommit])
            git(this.directory, ["merge-base", "--is-ancestor", baseCommit, "HEAD"])
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
          this.store
            .effects(plan.id)
            .some((effect) => ["intended", "uncertain"].includes(effect.state))
        )
          throw new Error("Reconcile uncertain effects first")

        const settledStartupEffect = attempt
          ? this.settledStartupEffect(plan.id, attempt)
          : undefined
        if (settledStartupEffect) {
          const settlement = startupFailureSettlementFromReceipt(settledStartupEffect.receipt)
          if (
            retry ||
            !command.attemptID ||
            command.attemptID !== attempt!.id ||
            attempt!.state !== "preparing" ||
            plan.state !== "blocked" ||
            !this.validArchitect(ownerSession) ||
            ownerSession.id !== plan.owner ||
            caller !== plan.owner ||
            !settlement
          )
            throw new Error(
              "Startup recovery requires explicit resume of the exact settled attempt",
            )
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
            ownerEpoch: this.store.planControlEpoch(plan.id),
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
        ) {
          const source = command.baseCommit ?? git(this.directory, ["rev-parse", "HEAD"])
          git(this.directory, ["merge-base", "--is-ancestor", source, "HEAD"])
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
          if (retry && command.baseCommit !== undefined) selectedBaseline = source
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
          ...(continuingTerminalWorker
            ? {
                previousMessageID: terminalContinuation!.messageID,
                messageID: resumedMessageID,
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
                  ownerEpoch: terminalRepairContinuation.ownerEpoch,
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
      if (command.action === "reconcile") {
        if (!ownerSession || ownerSession.archived) throw new Error("Owner unavailable")
        if (!reviewInput) {
          const quarantined = this.quarantinedVerification(plan)
          if (quarantined) return quarantined
        }
        let existingReviewInput = false
        if (reviewInput) {
          const { binding, evidence } = reviewInput
          if (
            caller !== plan.owner ||
            !this.validArchitect(ownerSession) ||
            ownerSession.id !== binding.ownerSessionID ||
            binding.planID !== plan.id ||
            binding.expectedPlanVersion !== command.expectedVersion ||
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
        if (this.store.effects(plan.id).some((e) => ["intended", "uncertain"].includes(e.state)))
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
      if (plan.state !== "draft" && plan.state !== "blocked")
        throw new Error("Execution already requested or ended")
      if (this.store.attempts(plan.id).length)
        throw new Error(
          "Existing execution must be reconciled; admission cannot replace its policy",
        )
      if (!ownerSession || ownerSession.archived)
        return this.hold(plan, "Owner is missing or archived")
      if (ownerSession.projectID !== this.projectID) throw new Error("Foreign owner session")
      if (command.action === "run" && ownerSession.agent !== "architect")
        throw new Error("Only an Architect session can own execution")
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
          git(this.directory, ["rev-parse", `${proposal.baseCommit}^{commit}`]) !==
          proposal.baseCommit
        )
          throw new Error("Base mismatch")
      } catch (error) {
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
    })
    if (
      (command.action === "run" && result.status === "running") ||
      (command.action === "reconcile" && result.status === "reconciling") ||
      (command.action === "retained-repair" && result.status === "retained-repair-requested") ||
      (command.action === "quarantine-source" && result.status === "quarantining-source") ||
      (command.action === "extend-verification-deadline" &&
        result.status === "retained-verification-check-continued")
    )
      this.wakeScheduler?.()
    if (command.action === "cancel-retained-verification" && command.retainedVerificationID)
      await this.finalizeRetainedVerificationCancellation(command.retainedVerificationID)
    if (
      command.action === "verify-retained" ||
      command.action === "cancel-retained-verification" ||
      (command.action === "extend-verification-deadline" &&
        result.status === "retained-verification-check-continued") ||
      command.action === "recover-cleanup" ||
      command.action === "pause" ||
      command.action === "unpause" ||
      (command.action === "human-evidence" && command.retainedVerificationID !== undefined)
    )
      await this.requestTick()
    if (command.action === "reassign" || continuedOwner) this.refreshArchitectSourceOwners()
    return result
  }

  submitPlan(input: unknown, owner: string) {
    return this.store.submit(input, owner, this.verificationTimeoutDefaults)
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

    if (plan.state === "draft")
      await this.command(
        {
          requestID: `task-start-run:${task.id}:1`,
          planID: plan.id,
          expectedVersion: plan.version,
          action: "run",
        },
        plan.owner,
      )
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
          ...(continuation.model ? { model: JSON.parse(continuation.model) } : {}),
          title: `LAZERS · continue ${plan.id.slice(0, 8)}`,
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
    const changed = this.store.atomic(() => {
      if (!this.store.updatePlanOwner(plan.id, plan.owner, sessionID)) return false
      // Persist the replacement's wake with ownership so a restart cannot split them.
      this.wakeRecoveredArchitect(plan.id)
      return true
    })
    if (changed) this.refreshArchitectSourceOwners()
  }

  private wakeRecoveredArchitect(planID: string) {
    const plan = this.store.plan(planID)!
    if (!["blocked", "accepted", "cleanup-blocked"].includes(plan.state)) return
    const pending = this.store.atomic((db) =>
      db
        .query<{ id: string }, [string]>(
          "SELECT id FROM runner_outbox WHERE plan_id=? AND state IN ('pending','sending','uncertain','admitted','delivered') LIMIT 1",
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

  observeArchitectSourceEvent(sessionID?: string) {
    if (!sessionID) this.sourceResyncPending = true
    if (!sessionID)
      for (const id of this.store.architectSourceSessionIDs())
        if (!this.sourceEpochs.has(id)) this.sourceEpochs.set(id, 0)
    const ids = sessionID ? [sessionID] : [...this.sourceEpochs.keys()]
    for (const id of ids) {
      if (!this.sourceEpochs.has(id)) continue
      this.sourceEpochs.set(id, this.sourceEpochs.get(id)! + 1)
      this.store.invalidateArchitectSource(id, this.now())
    }
    if (!sessionID) this.sourceResyncPending = false
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
    await this.ensureArchitectSourceChangeNotices(renewal, result)
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

  private async ensureArchitectSourceChangeNotices(
    renewal: ArchitectRenewalRow,
    result: {
      hasJournal: boolean
      changedInputs: Array<{ id: string; type: string; disposition: string }>
      changedResults: Array<{ id: string; revision: number; state: string }>
    },
  ) {
    const source = this.store.architectSource(renewal.previous_session_id)
    if (!source || source.state !== "active" || !result.hasJournal) return
    if (result.changedInputs.length || result.changedResults.length) {
      const targets = this.store.architectSourceNoticeTargets(source.session_id)
      const rows = this.store.architectCurrentSourceChangeNoticeRows(source.session_id)
      for (const target of targets) {
        const current = rows.find((row) => row.session_id === target.owner)
        if (!current || !["admitted", "delivered", "uncertain", "unknown"].includes(current.state))
          continue
        const ownership = this.ownership(current)
        if (
          !ownership ||
          ownership.lazersProjectID !== this.projectID ||
          ownership.lazersProjectDirectory !== this.directory ||
          ownership.lazersStatus !== "architect-source-change"
        )
          continue
        try {
          const observation = await this.outcomeObservation(current, target.owner, ownership)
          const state =
            observation === "queued"
              ? "admitted"
              : observation === "consumed"
                ? "consumed"
                : "unknown"
          this.store.recordArchitectSourceChangeObservation({
            outboxID: current.id,
            expectedState: current.state,
            state,
            receipt: {
              kind: "source-change-native-observation",
              sourceSessionID: source.session_id,
              disposition:
                observation === "queued"
                  ? "queued-native-input"
                  : observation === "consumed"
                    ? "native-transcript-consumed"
                    : observation === "missing"
                      ? "ambiguous-native-absence"
                      : "native-identity-conflict",
            },
            event:
              observation === "consumed"
                ? "ARCHITECT_SOURCE_CHANGE_CONSUMED"
                : observation === "queued"
                  ? "ARCHITECT_SOURCE_CHANGE_QUEUED"
                  : "ARCHITECT_SOURCE_CHANGE_UNCERTAIN",
          })
        } catch (error) {
          this.store.recordArchitectSourceChangeObservation({
            outboxID: current.id,
            expectedState: current.state,
            state: current.state === "unknown" ? "unknown" : "admitted",
            receipt: {
              kind: "source-change-native-observation-unavailable",
              sourceSessionID: source.session_id,
              error: errorText(error),
            },
            event: "ARCHITECT_SOURCE_CHANGE_OBSERVATION_UNAVAILABLE",
          })
        }
      }
    }
    const targets = this.store.architectSourceNoticeTargets(source.session_id)
    const representative = targets[0]
    const plan = representative ? this.store.plan(representative.planID) : undefined
    if (!representative || !plan) return
    this.store.ensureArchitectSourceChangeNotices({
      planID: representative.planID,
      sourceSessionID: source.session_id,
      expectedOwner: representative.owner,
      expectedPlanVersion: plan.version,
      projectID: this.projectID,
    })
  }

  private ensureCurrentArchitectSourceChangeNotices(sourceSessionID: string) {
    const source = this.store.architectSource(sourceSessionID)
    if (!source || source.state === "preparing") return
    for (const target of this.store.architectSourceNoticeTargets(sourceSessionID)) {
      const plan = this.store.plan(target.planID)
      if (!plan || plan.owner !== target.owner) continue
      try {
        this.store.ensureArchitectSourceChangeNotices({
          planID: target.planID,
          sourceSessionID,
          expectedOwner: target.owner,
          expectedPlanVersion: plan.version,
          projectID: this.projectID,
        })
      } catch {
        // A later source scan or explicit reconciliation will retry with fresh ownership facts.
      }
    }
  }

  /** Ownership changes rebind reference-only notices without rescanning retired history. */
  private refreshArchitectSourceOwners() {
    for (const source of this.store.architectSourceSessionIDs())
      this.ensureCurrentArchitectSourceChangeNotices(source)
  }

  private async reconcileArchitectSourceNotices(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ) {
    const sourceSessionID = command.sourceSessionID
    if (!sourceSessionID) throw new Error("Source notice reconciliation requires sourceSessionID")
    const lock = `${plan.id}:${sourceSessionID}`
    if (this.sourceNoticeReconciliationLocks.has(lock))
      return {
        status: "deferred" as const,
        reason: "Source notice reconciliation is already in progress for this plan and source",
        sourceSessionID,
        legacyNoticeCount: 0,
        results: [],
      }
    this.sourceNoticeReconciliationLocks.add(lock)
    try {
      return await this.reconcileArchitectSourceNoticesLocked(plan, command, caller, ownerSession)
    } finally {
      this.sourceNoticeReconciliationLocks.delete(lock)
    }
  }

  private async reconcileArchitectSourceNoticesLocked(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ) {
    const sourceSessionID = command.sourceSessionID
    if (
      !sourceSessionID ||
      caller !== plan.owner ||
      !this.validArchitect(ownerSession) ||
      ownerSession.id !== plan.owner
    )
      throw new Error("Source notice reconciliation requires the current active Architect owner")
    const legacyPage = this.store.architectLegacySourceNoticePage(sourceSessionID, 20)
    if (!legacyPage.total)
      return {
        status: "no-legacy-notices" as const,
        sourceSessionID,
        legacyNoticeCount: 0,
        results: [],
      }
    const legacyRows = legacyPage.rows
    const remainingLegacyNoticeCount = legacyPage.total - legacyRows.length

    const ensured = this.store.ensureArchitectSourceChangeNotices({
      planID: plan.id,
      sourceSessionID,
      expectedOwner: plan.owner,
      expectedPlanVersion: command.expectedVersion,
      projectID: this.projectID,
    })
    if (!ensured.targets.length || ensured.notices.length !== ensured.targets.length)
      return {
        status: "deferred" as const,
        reason: "No complete current-owner source-change pointer coverage is available",
        sourceSessionID,
        legacyNoticeCount: legacyPage.total,
        replacementNoticeIDs: ensured.notices.map((notice) => notice.id),
        results: [],
      }

    const targetFingerprint = fingerprint(
      ensured.targets.map((target) => ({
        owner: target.owner,
        planID: target.planID,
        planIDs: target.planIDs,
      })),
    )
    const refreshedRows = this.store.architectSourceChangeNoticeRowsByIDs(
      sourceSessionID,
      ensured.notices,
    )
    const refreshedByID = new Map(refreshedRows.map((row) => [row.id, row]))
    for (const notice of ensured.notices) {
      const replacement = refreshedByID.get(notice.id)
      if (!replacement || replacement.session_id !== notice.sessionID) {
        return {
          status: "deferred" as const,
          reason: "Current source-change pointer is not present in the durable outbox",
          sourceSessionID,
          legacyNoticeCount: legacyPage.total,
          replacementNoticeIDs: ensured.notices.map((item) => item.id),
          results: [],
        }
      }
      const ownership = this.ownership(replacement)
      if (
        !ownership ||
        ownership.lazersProjectID !== this.projectID ||
        ownership.lazersProjectDirectory !== this.directory ||
        ownership.lazersSessionID !== notice.sessionID ||
        ownership.lazersStatus !== "architect-source-change"
      )
        return {
          status: "deferred" as const,
          reason: "Current source-change pointer lacks exact native ownership metadata",
          sourceSessionID,
          legacyNoticeCount: legacyPage.total,
          replacementNoticeIDs: ensured.notices.map((item) => item.id),
          results: [],
        }
      let observation: "queued" | "consumed" | "missing" | "unowned"
      try {
        observation = await this.outcomeObservation(replacement, notice.sessionID, ownership)
      } catch (error) {
        return {
          status: "deferred" as const,
          reason: `Current source-change pointer observation unavailable: ${errorText(error)}`,
          sourceSessionID,
          legacyNoticeCount: legacyPage.total,
          replacementNoticeIDs: ensured.notices.map((item) => item.id),
          results: [],
        }
      }
      const observedState =
        observation === "queued" ? "admitted" : observation === "consumed" ? "consumed" : "unknown"
      if (observation === "queued" || observation === "consumed")
        this.store.recordArchitectSourceChangeObservation({
          outboxID: replacement.id,
          expectedState: replacement.state,
          state: observedState,
          receipt: {
            kind: "source-change-native-coverage-observed",
            sourceSessionID,
            disposition:
              observation === "queued" ? "queued-native-input" : "native-transcript-consumed",
          },
          event:
            observation === "queued"
              ? "ARCHITECT_SOURCE_CHANGE_QUEUED"
              : "ARCHITECT_SOURCE_CHANGE_CONSUMED",
        })
      else
        return {
          status: "deferred" as const,
          reason:
            observation === "missing"
              ? "Current source-change pointer is absent from both inbox and transcript; legacy notices remain untouched"
              : "Current source-change pointer identity is not positively owned; legacy notices remain untouched",
          sourceSessionID,
          legacyNoticeCount: legacyPage.total,
          replacementNoticeIDs: ensured.notices.map((item) => item.id),
          results: [],
        }
    }

    const context = this.store.architectSourceNoticeContext({
      planID: plan.id,
      sourceSessionID,
      expectedOwner: plan.owner,
      expectedPlanVersion: command.expectedVersion,
    })
    if (
      !context ||
      fingerprint(
        context.targets.map((target) => ({
          owner: target.owner,
          planID: target.planID,
          planIDs: target.planIDs,
        })),
      ) !== targetFingerprint
    ) {
      this.ensureCurrentArchitectSourceChangeNotices(sourceSessionID)
      return {
        status: "deferred" as const,
        reason: "Current plan owners changed during replacement-coverage observation",
        sourceSessionID,
        legacyNoticeCount: legacyPage.total,
        replacementNoticeIDs: ensured.notices.map((notice) => notice.id),
        results: [],
      }
    }

    const results: Array<{ outboxID: string; state: string; disposition: string }> = []
    for (const legacy of legacyRows) {
      const claimID = crypto.randomUUID()
      const claim = this.store.beginArchitectSourceNoticeReconciliation({
        planID: plan.id,
        sourceSessionID,
        expectedOwner: plan.owner,
        expectedPlanVersion: command.expectedVersion,
        projectID: this.projectID,
        outboxID: legacy.id,
        requestID: command.requestID,
        claimID,
      })
      if (claim.status !== "claimed") {
        const state = claim.status === "terminal" ? claim.row.state : claim.status
        results.push({ outboxID: legacy.id, state, disposition: claim.status })
        continue
      }
      const row = claim.row
      const ownership = this.ownership(row)
      if (!ownership) {
        this.store.finishArchitectSourceNoticeReconciliation({
          outboxID: row.id,
          claimID,
          state: "unknown",
          receipt: { kind: "source-notice-ownership-lost-before-observation" },
          event: "ARCHITECT_SOURCE_NOTICE_OWNERSHIP_UNKNOWN",
        })
        results.push({ outboxID: row.id, state: "unknown", disposition: "ownership-unavailable" })
        continue
      }
      if (!this.store.architectSourceNoticeClaimCurrent(row.id, claimID)) {
        results.push({ outboxID: row.id, state: "reconciling", disposition: "claim-lost" })
        continue
      }
      if (legacy.state === "pending") {
        const latest = this.store.architectSourceNoticeContext({
          planID: plan.id,
          sourceSessionID,
          expectedOwner: plan.owner,
          expectedPlanVersion: command.expectedVersion,
        })
        if (
          !latest ||
          fingerprint(
            latest.targets.map((target) => ({
              owner: target.owner,
              planID: target.planID,
              planIDs: target.planIDs,
            })),
          ) !== targetFingerprint
        ) {
          this.store.finishArchitectSourceNoticeReconciliation({
            outboxID: row.id,
            claimID,
            state: "reconciling",
            receipt: { kind: "source-notice-owner-changed-before-admission-suppression" },
            event: "ARCHITECT_SOURCE_NOTICE_RECONCILIATION_DEFERRED",
          })
          results.push({ outboxID: row.id, state: "reconciling", disposition: "owner-changed" })
          continue
        }
        this.store.finishArchitectSourceNoticeReconciliation({
          outboxID: row.id,
          claimID,
          state: "superseded",
          receipt: {
            kind: "source-notice-superseded-before-native-admission",
            replacementOutboxIDs: ensured.notices.map((notice) => notice.id),
          },
          event: "ARCHITECT_SOURCE_NOTICE_SUPERSEDED",
        })
        results.push({ outboxID: row.id, state: "superseded", disposition: "never-admitted" })
        continue
      }

      let observation: "queued" | "consumed" | "missing" | "unowned"
      try {
        observation = await this.outcomeObservation(row, row.session_id, ownership)
      } catch (error) {
        this.store.finishArchitectSourceNoticeReconciliation({
          outboxID: row.id,
          claimID,
          state: "reconciling",
          receipt: { kind: "source-notice-observation-unavailable", error: errorText(error) },
          event: "ARCHITECT_SOURCE_NOTICE_RECONCILIATION_DEFERRED",
        })
        results.push({
          outboxID: row.id,
          state: "reconciling",
          disposition: "observation-unavailable",
        })
        continue
      }
      if (observation === "consumed") {
        this.store.finishArchitectSourceNoticeReconciliation({
          outboxID: row.id,
          claimID,
          state: "consumed",
          receipt: { kind: "source-notice-transcript-consumption-observed" },
          event: "ARCHITECT_SOURCE_NOTICE_CONSUMED",
        })
        results.push({ outboxID: row.id, state: "consumed", disposition: "already-consumed" })
        continue
      }
      if (observation === "missing" || observation === "unowned") {
        this.store.finishArchitectSourceNoticeReconciliation({
          outboxID: row.id,
          claimID,
          state: "unknown",
          receipt: {
            kind:
              observation === "missing"
                ? "source-notice-absence-ambiguous"
                : "source-notice-native-identity-conflict",
          },
          event: "ARCHITECT_SOURCE_NOTICE_RECONCILIATION_UNCERTAIN",
        })
        results.push({ outboxID: row.id, state: "unknown", disposition: observation })
        continue
      }

      const beforeCancellation = this.store.architectSourceNoticeContext({
        planID: plan.id,
        sourceSessionID,
        expectedOwner: plan.owner,
        expectedPlanVersion: command.expectedVersion,
      })
      if (
        !beforeCancellation ||
        fingerprint(
          beforeCancellation.targets.map((target) => ({
            owner: target.owner,
            planID: target.planID,
            planIDs: target.planIDs,
          })),
        ) !== targetFingerprint
      ) {
        this.ensureCurrentArchitectSourceChangeNotices(sourceSessionID)
        this.store.finishArchitectSourceNoticeReconciliation({
          outboxID: row.id,
          claimID,
          state: "reconciling",
          receipt: { kind: "source-notice-owner-changed-before-native-cancellation" },
          event: "ARCHITECT_SOURCE_NOTICE_RECONCILIATION_DEFERRED",
        })
        results.push({ outboxID: row.id, state: "reconciling", disposition: "owner-changed" })
        continue
      }
      if (!this.host.cancelOutcome) {
        this.store.finishArchitectSourceNoticeReconciliation({
          outboxID: row.id,
          claimID,
          state: "reconciling",
          receipt: { kind: "source-notice-native-cancellation-unavailable" },
          event: "ARCHITECT_SOURCE_NOTICE_RECONCILIATION_DEFERRED",
        })
        results.push({
          outboxID: row.id,
          state: "reconciling",
          disposition: "cancellation-unavailable",
        })
        continue
      }
      if (!this.store.architectSourceNoticeClaimCurrent(row.id, claimID)) {
        results.push({ outboxID: row.id, state: "reconciling", disposition: "claim-lost" })
        continue
      }
      try {
        await this.host.cancelOutcome({
          sessionID: row.session_id,
          inboxID: row.message_id,
          ownership,
        })
      } catch (error) {
        let afterFailure: "queued" | "consumed" | "missing" | "unowned"
        try {
          afterFailure = await this.outcomeObservation(row, row.session_id, ownership)
        } catch (observationError) {
          this.store.finishArchitectSourceNoticeReconciliation({
            outboxID: row.id,
            claimID,
            state: "reconciling",
            receipt: {
              kind: "source-notice-cancellation-and-readback-unavailable",
              cancellationError: errorText(error),
              observationError: errorText(observationError),
            },
            event: "ARCHITECT_SOURCE_NOTICE_RECONCILIATION_DEFERRED",
          })
          results.push({
            outboxID: row.id,
            state: "reconciling",
            disposition: "readback-unavailable",
          })
          continue
        }
        const nextState =
          afterFailure === "consumed"
            ? "consumed"
            : afterFailure === "queued"
              ? "reconciling"
              : "unknown"
        this.store.finishArchitectSourceNoticeReconciliation({
          outboxID: row.id,
          claimID,
          state: nextState,
          receipt: {
            kind:
              afterFailure === "consumed"
                ? "source-notice-cancellation-raced-with-consumption"
                : afterFailure === "queued"
                  ? "source-notice-cancellation-failed-still-queued"
                  : "source-notice-cancellation-absence-ambiguous",
            cancellationError: errorText(error),
            readback: afterFailure,
          },
          event:
            afterFailure === "consumed"
              ? "ARCHITECT_SOURCE_NOTICE_CANCEL_RACED_WITH_CONSUMPTION"
              : "ARCHITECT_SOURCE_NOTICE_RECONCILIATION_UNCERTAIN",
        })
        results.push({
          outboxID: row.id,
          state: nextState,
          disposition: `cancel-failed-${afterFailure}`,
        })
        continue
      }

      this.store.finishArchitectSourceNoticeReconciliation({
        outboxID: row.id,
        claimID,
        state: "reconciling",
        receipt: { kind: "source-notice-native-cancellation-call-returned" },
        event: "ARCHITECT_SOURCE_NOTICE_CANCEL_RETURNED",
      })
      let afterCancellation: "queued" | "consumed" | "missing" | "unowned"
      try {
        afterCancellation = await this.outcomeObservation(row, row.session_id, ownership)
      } catch (error) {
        this.store.finishArchitectSourceNoticeReconciliation({
          outboxID: row.id,
          claimID,
          state: "reconciling",
          receipt: {
            kind: "source-notice-cancellation-readback-unavailable",
            error: errorText(error),
          },
          event: "ARCHITECT_SOURCE_NOTICE_RECONCILIATION_DEFERRED",
        })
        results.push({
          outboxID: row.id,
          state: "reconciling",
          disposition: "readback-unavailable",
        })
        continue
      }
      const ownerAfterCancellation = this.store.architectSourceNoticeContext({
        planID: plan.id,
        sourceSessionID,
        expectedOwner: plan.owner,
        expectedPlanVersion: command.expectedVersion,
      })
      if (
        !ownerAfterCancellation ||
        fingerprint(
          ownerAfterCancellation.targets.map((target) => ({
            owner: target.owner,
            planID: target.planID,
            planIDs: target.planIDs,
          })),
        ) !== targetFingerprint
      )
        this.ensureCurrentArchitectSourceChangeNotices(sourceSessionID)
      const finalState =
        afterCancellation === "missing"
          ? "superseded"
          : afterCancellation === "consumed"
            ? "consumed"
            : afterCancellation === "unowned"
              ? "unknown"
              : "reconciling"
      this.store.finishArchitectSourceNoticeReconciliation({
        outboxID: row.id,
        claimID,
        state: finalState,
        receipt: {
          kind:
            afterCancellation === "missing"
              ? "source-notice-cancellation-confirmed-by-native-readback"
              : afterCancellation === "consumed"
                ? "source-notice-cancellation-raced-with-consumption"
                : afterCancellation === "queued"
                  ? "source-notice-still-queued-after-cancellation"
                  : "source-notice-identity-changed-after-cancellation",
          readback: afterCancellation,
        },
        event:
          afterCancellation === "missing"
            ? "ARCHITECT_SOURCE_NOTICE_CANCELLED"
            : afterCancellation === "consumed"
              ? "ARCHITECT_SOURCE_NOTICE_CANCEL_RACED_WITH_CONSUMPTION"
              : "ARCHITECT_SOURCE_NOTICE_RECONCILIATION_UNCERTAIN",
      })
      results.push({
        outboxID: row.id,
        state: finalState,
        disposition:
          afterCancellation === "missing"
            ? "cancelled-and-read-back-absent"
            : afterCancellation === "consumed"
              ? "consumption-observed-after-cancel"
              : afterCancellation,
      })
    }
    const unresolved = results.some((result) => !["superseded", "consumed"].includes(result.state))
    return {
      status:
        unresolved || remainingLegacyNoticeCount > 0
          ? ("deferred" as const)
          : ("reconciled" as const),
      sourceSessionID,
      sourceRevision: ensured.sourceRevision,
      replacementNoticeIDs: ensured.notices.map((notice) => notice.id),
      legacyNoticeCount: legacyPage.total,
      remainingLegacyNoticeCount,
      processedLegacyNoticeCount: legacyRows.length,
      results,
    }
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

  private async reconcileArchitectSources(fence: number) {
    if (!this.host.architectInputPage) return
    for (const source of this.store.architectSources()) {
      const renewal = this.store.architectRenewal(source.renewal_id)
      if (!renewal) continue
      try {
        await this.inspectArchitectSourcePage(renewal, fence)
      } catch (error) {
        this.renewalEvent(
          renewal,
          "ARCHITECT_SOURCE_SCAN_FAILED",
          { renewalID: renewal.id, sourceSessionID: source.session_id, error: errorText(error) },
          fence,
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
      if (changed) this.refreshArchitectSourceOwners()
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
    const text = outcomeText(JSON.stringify(payload))
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

  private async considerArchitectRenewal(plan: PlanRow, owner: HostSession, fence: number) {
    if (
      !this.architectPromptHook ||
      !this.host.updateSession ||
      !this.host.architectInputPage ||
      owner.idleAt === undefined ||
      owner.busy ||
      !owner.model ||
      this.now() - owner.idleAt < this.architectIdleWindowMs
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
      model: JSON.stringify(owner.model),
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
            throw new Error("Native Architect renewal ID belongs to another session or route")
          // A checkpoint is only safe to transfer after its complete current history
          // sweep has been journaled and checked for uncovered user input.
          await this.inspectArchitectSourceSweep(renewal, fence)
          renewal = this.store.architectRenewal(renewal.id)!
          if (renewal.state !== "creating") return
          let successor = await this.host.session(renewal.successor_session_id)
          if (successor && !this.renewalSuccessorMatches(successor, renewal))
            throw new Error("Native Architect renewal ID belongs to another session or route")
          if (!successor) {
            const planIDs = this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id)
            await this.host
              .createArchitect({
                id: renewal.successor_session_id,
                directory: renewal.directory,
                model: JSON.parse(renewal.model),
                title: `LAZERS · ${knownLabel ?? this.renewalLabel(renewal)}`.slice(0, 120),
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
            predecessor?.idleAt === undefined ||
            this.now() - predecessor.idleAt < this.architectIdleWindowMs
          if (!this.validArchitect(predecessor) || predecessor.busy || tooRecent) {
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
          predecessorBeforeArchive.idleAt === undefined ||
          this.now() - predecessorBeforeArchive.idleAt < this.architectIdleWindowMs
        ) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_DEFERRED",
            "Predecessor became busy or recent before archival",
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
        } else this.refreshArchitectSourceOwners()
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
    if (this.store.rollbackArchitectRenewal(this.owner, fence, renewal.id, state, error))
      this.refreshArchitectSourceOwners()
  }

  private hold(
    plan: PlanRow,
    reason: string,
    allowedActions = ["audit", "reconcile", "cancel"],
    workerObservation?: TerminalWorkerHold,
  ) {
    this.store.atomic((db) => {
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
      if (!observationChanged && !changedReason) return
      db.query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'blocked'),reason=?,version=version+1 WHERE id=?",
      ).run(reason, plan.id)
      this.store.record(plan.id, null, "BLOCKED", {
        reason,
        ...(workerObservation ? { workerObservation } : {}),
      })
      this.outcome(plan.id, { status: "blocked", reason, allowedActions }, true)
    })
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
      background:
        worker.background ??
        ({
          state: "unknown",
          source: "experimental.idle",
          reason: "Native idle background observation is unavailable",
        } as const),
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
    const id = fingerprint({ planID, taskID, attemptID, kind, payload })
    return this.store.fenced(this.owner, fence, (db) => {
      const existing = db
        .query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE id=?")
        .get(id)
      if (existing) throw new Error(`Existing ${kind} effect must be reconciled, never replayed`)
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
        this.holdAdoption(plan, payload.adoptionID, reason, "pending", fence)
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

  private async advanceSourceQuarantines(fence: number) {
    const quarantines = this.store.atomic((db) =>
      db
        .query<SourceQuarantine, [string]>(
          `SELECT q.* FROM runner_source_quarantines q
         JOIN runner_plans p ON p.id=q.plan_id
         JOIN runner_attempts a ON a.id=q.attempt_id
         WHERE p.project_directory=? AND a.state IN ('running','verifying')
         ORDER BY q.created_at`,
        )
        .all(this.directory),
    )
    for (const quarantine of quarantines) {
      if (
        quarantine.phase === "sealed" &&
        quarantine.hold_reason === null &&
        sourceGuardInstalled(this.store, quarantine.workspace)
      ) {
        try {
          sourceReviewBinding(quarantine)
          continue
        } catch {
          // Invalid stored bindings remain held even with a healthy source guard.
        }
      }
      const wait = (reason: string) =>
        this.store.fenced(this.owner, fence, (db) => {
          const changed = db
            .query(
              `UPDATE runner_source_quarantines SET hold_reason=?,updated_at=?
             WHERE attempt_id=? AND request_id=? AND phase=? AND hold_reason IS NOT ?`,
            )
            .run(
              reason,
              Date.now(),
              quarantine.attempt_id,
              quarantine.request_id,
              quarantine.phase,
              reason,
            ).changes
          if (changed)
            this.store.record(quarantine.plan_id, null, "SOURCE_QUARANTINE_WAIT", {
              attemptID: quarantine.attempt_id,
              reason,
              resourceHoldsRetained: true,
            })
        })
      const current = () => {
        const row = sourceQuarantine(this.store, quarantine.attempt_id)
        const plan = this.store.plan(quarantine.plan_id)
        const attempt = this.store
          .attempts(quarantine.plan_id)
          .find((item) => item.id === quarantine.attempt_id)
        if (
          !row ||
          row.phase !== quarantine.phase ||
          row.request_id !== quarantine.request_id ||
          row.review_input_json !== quarantine.review_input_json ||
          !plan ||
          (row.phase === "pending" && plan.owner !== quarantine.requested_owner) ||
          !attempt ||
          !["running", "verifying"].includes(attempt.state) ||
          attempt.session_id !== quarantine.session_id ||
          attempt.message_id !== quarantine.assigned_message_id ||
          attempt.workspace !== quarantine.workspace
        )
          throw new Error("Retained source quarantine authority or assignment changed")
        return attempt
      }
      const guarded = () => {
        const attempt = current()
        if (!sourceGuardInstalled(this.store, quarantine.workspace))
          throw new Error("Native worker source guard is not installed")
        return attempt
      }
      try {
        const attempt = this.store.fenced(this.owner, fence, current)
        const review = sourceReviewBinding(quarantine)
        const pending = quarantine.phase === "pending"
        const readOptions = pending && attempt.state === "running" ? { messages: true } : undefined
        let worker = await this.host.session(quarantine.session_id, readOptions)
        let reason = this.sourceWorkerWait(attempt, worker, pending, review)
        if (reason) {
          wait(reason)
          continue
        }
        if (!this.host.ensureSourceGuard)
          throw new Error("Native source guard activation is unavailable")
        await this.host.ensureSourceGuard({
          directory: quarantine.workspace,
          projectID: this.projectID,
        })
        this.store.fenced(this.owner, fence, guarded)
        if (quarantine.phase === "pending" && !worker!.archived) {
          if (!this.host.archiveRetainedWorker)
            throw new Error("Native archive control is unavailable")
          await this.host.archiveRetainedWorker({
            sessionID: quarantine.session_id,
            attemptID: attempt.id,
            planID: attempt.plan_id,
            requestID: quarantine.request_id,
            projectID: this.projectID,
            directory: quarantine.workspace,
            assignedMessageID: quarantine.assigned_message_id,
            ...(review ? { reviewInput: review } : {}),
          })
        }
        worker = await this.host.session(quarantine.session_id, readOptions)
        reason = this.sourceWorkerWait(attempt, worker, pending, review)
        if (reason || (quarantine.phase === "pending" && !worker?.archived)) {
          wait(reason ?? "Native archive has not been observed")
          continue
        }
        this.store.fenced(this.owner, fence, (db) => {
          guarded()
          db.query(
            `UPDATE runner_source_quarantines SET phase=lz_runner_transition('quarantine',phase,'sealed'),hold_reason=NULL,updated_at=?
             WHERE attempt_id=? AND request_id=? AND phase=?`,
          ).run(Date.now(), quarantine.attempt_id, quarantine.request_id, quarantine.phase)
          this.store.record(
            quarantine.plan_id,
            attempt.task_id,
            quarantine.phase === "pending"
              ? "SOURCE_QUARANTINE_SEALED"
              : "SOURCE_QUARANTINE_GUARD_RESTORED",
            {
              attemptID: attempt.id,
              sessionID: attempt.session_id,
              workspace: attempt.workspace,
              requestID: quarantine.request_id,
              resourceHoldsRetained: true,
            },
          )
        })
      } catch (error) {
        wait(errorText(error))
      }
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
    const current = this.runTick()
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
    try {
      await run()
    } catch (error) {
      this.store.fenced(this.owner, fence, () => {
        if (!this.store.plan(planID)) return
        this.store.recordOnce(planID, null, `PLAN_${phase.toUpperCase()}_FAILED`, {
          error: safeText(errorText(error), privacyStats()),
        })
      })
    }
  }

  private settleSupersededRetainedVerification(
    plan: PlanRow,
    operation: RetainedVerification,
    fence: number,
  ): boolean {
    if (plan.state !== "running" || operation.state !== "held" || operation.repair) return false
    return this.store.fenced(this.owner, fence, (db) => {
      const current = this.store.plan(plan.id)
      const saved = retainedVerification(db, operation.id)
      if (
        current?.version !== plan.version ||
        saved?.state !== "held" ||
        saved.generation !== operation.generation
      )
        return false
      const attempt = this.store.attempts(plan.id).find((item) => item.id === operation.attemptID)
      const resumed = this.store.latestTransition<{
        attemptID?: string
        previousMessageID?: string
        messageID?: string
      }>(plan.id, operation.taskID, "ATTEMPT_RESUMED")
      if (
        !attempt ||
        attempt.state !== "preparing" ||
        attempt.task_id !== operation.taskID ||
        attempt.session_id !== operation.originalSessionID ||
        attempt.workspace !== operation.originalWorkspace ||
        resumed?.attemptID !== attempt.id ||
        resumed.previousMessageID !== operation.originalMessageID ||
        resumed.messageID !== attempt.message_id ||
        resumed.messageID === operation.originalMessageID ||
        this.retainedCheckSettlementProblem(operation.id)
      )
        return false
      const reason = "Superseded by the authorized continuation of the same worker"
      saveRetainedVerification(db, {
        ...saved,
        state: "cancelled",
        holdReason: reason,
        updatedAt: this.now(),
      })
      this.store.record(plan.id, operation.taskID, "RETAINED_VERIFICATION_CANCELLED", {
        operationID: operation.id,
        generation: operation.generation,
        source: "worker-continuation",
        previousState: saved.state,
        previousHoldReason: saved.holdReason,
        reason,
        oldExecutionAndResourceHoldsPreserved: true,
      })
      return true
    })
  }

  private async requestQueueReview(
    waits: { planID: string; prerequisitePlanIDs?: string[]; reservationTaskIDs?: string[] }[],
    fence: number,
  ) {
    const current = () =>
      waits.filter(
        ({ planID }) =>
          this.store.plan(planID)?.state === "running" && !this.store.dispatchPause(planID),
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
    if (prior && !["admitted", "consumed", "unknown", "superseded"].includes(prior.state)) return
    const checking = () =>
      verificationActivitiesForDatabase(this.store.repository.path).some(
        (activity) =>
          activity.metadata.projectDirectory === this.directory && activity.state === "running",
      )
    if (checking()) return
    const active = this.store.activeProjectAttempts()
    for (const attempt of active) {
      if (sourceReservationExcluded(this.store, attempt, { mode: "isolated" })) continue
      const session = await this.host.session(attempt.session_id)
      if (
        session?.busy ||
        session?.pendingInput ||
        session?.observationUnstable ||
        (session?.background?.state === "observed" && session.background.count > 0)
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

    let observation: Awaited<ReturnType<TaskRuntime["outcomeObservation"]>> | undefined
    if (prior?.state === "admitted") {
      // The existing delivery path retargets admitted notices when the owner changes.
      if (prior.session_id !== owner || !this.validArchitect(architect)) return
      observation = await this.outcomeObservation(prior, owner, this.ownership(prior))
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
      if (
        prior?.state === "admitted" &&
        !this.outcomeState(
          prior,
          ["admitted"],
          observation === "consumed" ? "consumed" : "unknown",
          { kind: "queue-review-reobserved", observation },
          "QUEUE_REVIEW_DELIVERY_OBSERVED",
          fence,
        )
      )
        return
      const requestedAt = this.now()
      this.store.record(anchor.planID, null, event, { ...review, requestedAt })
      this.outcome(anchor.planID, { status: "queue-review", ...review, requestedAt }, true)
    })
  }

  private async runTick() {
    this.running = true
    let heartbeat: ReturnType<typeof sharedScheduler.register> | undefined
    try {
      const fence = this.store.claim(this.owner)
      if (fence === null) return
      if (this.sourceResyncPending) this.observeArchitectSourceEvent()
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
      for (const renewal of this.store.architectRenewalsNeedingRecovery()) {
        try {
          await this.continueArchitectRenewal(renewal, fence)
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
      await this.reconcileArchitectSources(fence)
      await this.advanceSourceQuarantines(fence)
      const retainedOperations = this.store.atomic((db) =>
        activeRetainedVerifications(db, this.directory),
      )
      for (const operation of retainedOperations) {
        if (operation.state === "held" || this.retainedVerificationRuns.has(operation.id)) continue
        const id = `retained-advance:${operation.id}:${operation.generation}`
        const key = verificationActivityKey(this.store.repository.path, id)
        const identity = fingerprint({
          operationID: operation.id,
          generation: operation.generation,
        })
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
            generation: operation.generation,
          },
          run: async (signal) => {
            try {
              await this.advanceRetainedVerification(operation, fence, signal)
            } catch (error) {
              if (!signal.aborted)
                await this.holdRetainedVerification(operation, errorText(error), fence)
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
      const terminalCleanupPlanIDs = this.store.terminalCleanupPlanIDs()
      const waits: Parameters<TaskRuntime["requestQueueReview"]>[0] = []
      for (const candidate of this.store.runnablePlans(terminal)) {
        await this.reconcilePlan(candidate.id, fence, "step", async () => {
          let plan = candidate
          if (plan.state === "draft" && !this.taskStartID(plan)) return
          if (plan.state === "draft") {
            const taskID = this.taskStartID(plan)!
            await this.command(
              {
                requestID: `task-start-run:${taskID}:1`,
                planID: plan.id,
                expectedVersion: plan.version,
                action: "run",
              },
              plan.owner,
            )
            plan = this.store.plan(plan.id)!
          }
          const retained = this.store.atomic((db) =>
            retainedVerificationsForPlan(db, this.directory, plan.id),
          )
          if (
            plan.state !== "cancelling" &&
            retained.some(
              (operation) =>
                !["cancelled", "task-accepted"].includes(operation.state) &&
                !this.retainedTaskCandidateAccepted(operation) &&
                !this.settleSupersededRetainedVerification(plan, operation, fence),
            )
          )
            return
          const wait = await this.step(plan, fence)
          if (wait) waits.push(wait)
        })
        if (heartbeatFailed) throw heartbeatError
      }
      for (const planID of terminalCleanupPlanIDs) {
        await this.reconcilePlan(planID, fence, "cleanup", async () => {
          const plan = this.store.plan(planID)
          if (!plan || !["cleanup-blocked", "cancelled"].includes(plan.state)) return
          if (!this.pendingOwnedWorktreeCleanup(plan)) return
          if (plan.state === "cleanup-blocked") {
            if (!(await this.worktreeCleanupFactsChanged(plan))) return
            await this.cleanupWorktrees(plan, fence)
          } else if (await this.worktreeCleanupFactsChanged(plan))
            await this.cleanupWorktrees(plan, fence, "cancellation")
        })
        if (heartbeatFailed) throw heartbeatError
      }
      await this.reconcileTerminalRetainedVerifications(fence)
      if (waits.length)
        await this.reconcilePlan(waits[0]!.planID, fence, "step", () =>
          this.requestQueueReview(waits, fence),
        )
      for (const operation of retainedOperations) {
        if (operation.state !== "held") continue
        await this.reconcilePlan(operation.planID, fence, "delivery", () =>
          this.notifyHeldRetainedVerification(operation.id, fence),
        )
      }
      await this.deliver(fence)
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

  private reconcileCancelledDependencies(planID: string, fence: number) {
    return this.store.fenced(this.owner, fence, (db) => {
      const plan = this.store.plan(planID)!
      if (!["running", "blocked"].includes(plan.state)) return plan
      type Saved = {
        roots: string[]
        nodes: Array<{ taskID: string; version: number; reason: string }>
        planHold: { previousState: string; previousReason: string | null; reason: string } | null
      }
      const previous = this.store.latestTransition<Saved>(
        planID,
        null,
        "DEPENDENCY_CANCELLATION",
      ) ?? { roots: [], nodes: [], planHold: null }
      const cancelledPlans = this.store.cancelledDependencyPlans(planID)
      const cancelledNodes = this.store.cancelledDependencyNodes(planID)
      const roots = [
        ...new Set([
          ...cancelledPlans.map((item) => item.reference),
          ...cancelledNodes.map((item) => item.reference),
        ]),
      ].sort()
      const reason = roots.length
        ? `Prerequisite cancelled: ${roots.join(", ")}`
        : "Cancelled prerequisite resolved"
      const nodes: Saved["nodes"] = []
      for (const node of this.store.nodes(planID)) {
        const saved = previous.nodes.find((item) => item.taskID === node.task_id)
        const owned =
          node.state === "blocked" &&
          node.version === saved?.version &&
          node.reason === saved.reason
        const affected =
          cancelledPlans.length > 0 || cancelledNodes.some((item) => item.taskID === node.task_id)
        if (affected && (["queued", "ready"].includes(node.state) || owned)) {
          if (owned && node.reason === reason) nodes.push(saved!)
          else {
            if (owned) this.store.move(planID, node.task_id, "RECONCILE")
            this.store.move(planID, node.task_id, "BLOCK", reason)
            const blocked = this.store.nodes(planID).find((item) => item.task_id === node.task_id)!
            nodes.push({ taskID: node.task_id, version: blocked.version, reason })
          }
        } else if (owned && !affected) this.store.move(planID, node.task_id, "RECONCILE")
      }
      let planHold = previous.planHold
      const ownsHold = planHold && plan.state === "blocked" && plan.reason === planHold.reason
      if (cancelledPlans.length && (plan.state === "running" || ownsHold)) {
        planHold = {
          previousState: planHold?.previousState ?? plan.state,
          previousReason: planHold
            ? planHold.previousReason === planHold.reason
              ? null
              : planHold.previousReason
            : plan.reason,
          reason,
        }
        if (plan.state !== "blocked" || plan.reason !== reason)
          db.query(
            "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'blocked'),reason=?,version=version+1 WHERE id=?",
          ).run(reason, planID)
      } else if (!cancelledPlans.length && ownsHold) {
        db.query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,?),reason=?,version=version+1 WHERE id=?",
        ).run(planHold!.previousState, planHold!.previousReason, planID)
        planHold = null
      } else if (!ownsHold) planHold = null
      const next: Saved = { roots, nodes, planHold }
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        this.store.record(planID, null, "DEPENDENCY_CANCELLATION", next)
        this.outcome(
          planID,
          {
            status: roots.length ? "blocked" : "dependency-resolved",
            reason,
            cancelledPrerequisites: roots,
            blockedTaskIDs: nodes.map((node) => node.taskID),
            allowedActions: ["schedule", "reconcile", "cancel"],
          },
          true,
        )
      }
      return this.store.plan(planID)!
    })
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
      const activities = await this.cancelCheckActivities(plan.id)
      await this.reconcileCancelledCheckActivities(plan, activities, fence)
      const cancelledOperations = this.store.atomic((db) =>
        retainedVerificationsForPlan(db, this.directory, plan!.id).filter(
          (operation) => operation.state === "cancelled",
        ),
      )
      for (const operation of cancelledOperations)
        await this.recoverCancelledRetainedChecks(operation.id)
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
        await this.cancelWorkers(plan, fence, false)
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
      await this.cancelWorkers(plan, fence)
      const pending = this.store
        .effects(plan.id)
        .find((e) => ["intended", "uncertain"].includes(e.state))
      if (pending) await this.reconcileEffect(pending, fence)
      return
    }
    const planRenewal = this.store.architectRenewalForPlan(plan.id)
    if (
      planRenewal &&
      ["creating", "archiving", "recovering-input", "rolling-back"].includes(planRenewal.state)
    ) {
      await this.continueArchitectRenewal(planRenewal, fence)
      return
    }
    if (plan.state === "cleaning") {
      await this.cleanupWorktrees(plan, fence)
      return
    }
    const adoption = this.store.activeAdoptions(plan.id)[0]
    if (adoption) {
      await this.advanceAdoption(plan, adoption, fence)
      return
    }
    const owner = await this.host.session(plan.owner)
    if (this.validArchitect(owner)) {
      const renewal = this.store.architectRenewalForSource(owner.id)
      if (
        renewal &&
        ["creating", "archiving", "recovering-input", "rolling-back"].includes(renewal.state)
      ) {
        await this.continueArchitectRenewal(renewal, fence)
        return
      }
      if (await this.considerArchitectRenewal(plan, owner, fence)) return
    }
    if (!this.validArchitect(owner)) {
      await this.ensureArchitectOwner(plan, owner)
      plan = this.store.plan(plan.id)!
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
            expectedVersion: plan.version,
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
      await this.reconcileEffect(pending, fence)
      return
    }
    const active = this.store
      .attempts(plan.id)
      .filter((a) => ["preparing", "running", "verifying"].includes(a.state))
    if (active.length) {
      await Promise.all(
        active.map((attempt) => {
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
          return this.advanceAttempt(this.store.plan(plan!.id)!, attempt, fence)
        }),
      )
      plan = this.store.plan(plan.id)!
      if (plan.state === "cancelling") {
        await this.cancelWorkers(plan, fence)
        return
      }
    }
    if (plan.state === "blocked") return

    let rawInput = JSON.parse(plan.body)
    let input = PlanInput.parse(rawInput)
    const prerequisites = input.afterPlans ?? []
    const prerequisiteBaseline = prerequisites.length
      ? this.integratedPrerequisiteBaseline(prerequisites)
      : undefined
    if (prerequisites.length && !prerequisiteBaseline) {
      if (
        !this.store.dispatchPause(plan.id) &&
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
    const occupied = this.store.dispatchReservations(input.workspaceMode)
    let pause = this.store.dispatchPause(plan.id)
    if (pause?.untilPlans.length && this.integratedPrerequisiteBaseline(pause.untilPlans)) {
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
    const ready = nodes.filter(
      (node) =>
        !pause &&
        ["queued", "ready"].includes(node.state) &&
        this.store.execution(node.task_id)!.waitingOn.length === 0,
    )
    const selected: NodeRow[] = []
    if (input.workspaceMode === "shared") {
      // A shared checkout is a single-writer resource, including across plans.
      if (occupied.length === 0 && ready[0]) selected.push(ready[0])
    } else if (!occupied.some((entry) => entry.shared)) {
      for (const node of ready) {
        const scope = this.store.effectiveWriteScope(node.task_id)
        if (occupied.some((entry) => scopePatternsConflict(entry.scopes, scope))) continue
        selected.push(node)
        occupied.push({ taskID: node.task_id, shared: false, scopes: scope })
      }
    }
    if (selected.length) {
      await Promise.all(
        selected.map(async (node) => {
          try {
            await this.dispatch(plan!, node, fence)
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
      if (!pause && nodes.some((node) => ["queued", "ready"].includes(node.state)))
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
      await this.finish(plan, fence)
      return
    }
    if (ready.length && occupied.length) {
      const reservationTaskIDs = occupied
        .filter(
          (entry) =>
            input.workspaceMode === "shared" ||
            entry.shared ||
            ready.some((node) =>
              scopePatternsConflict(entry.scopes, this.store.effectiveWriteScope(node.task_id)),
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
    for (const attempt of active) {
      let session = await this.host.session(attempt.session_id)
      if (!session) {
        if (!this.cancelMissingWorker(plan, attempt, fence)) waiting = true
        continue
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
      const backgroundReason = this.backgroundBlockReason(session, attempt)
      const knownBackgroundWork =
        session.background?.state === "observed" && session.background.count > 0
      if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0)
        this.approvalWait(plan, attempt, session, fence)
      if (session.busy) {
        await this.host.interrupt(attempt.session_id)
        if (backgroundReason)
          this.backgroundWait(
            plan,
            attempt,
            session,
            backgroundReason,
            fence,
            knownBackgroundWork ? "WORKER_BACKGROUND_WAIT" : "WORKER_BACKGROUND_UNKNOWN",
          )
        waiting = true
        continue
      }
      if (
        session.pendingInput ||
        session.observationUnstable ||
        (session.pendingPermissions ?? 0) > 0 ||
        (session.pendingForms ?? 0) > 0
      ) {
        waiting = true
        continue
      }
      if (knownBackgroundWork) {
        this.backgroundWait(plan, attempt, session, backgroundReason!, fence)
        waiting = true
        continue
      }
      if (backgroundReason)
        this.backgroundWait(
          plan,
          attempt,
          session,
          backgroundReason,
          fence,
          "WORKER_BACKGROUND_UNKNOWN",
        )
      session = await this.host.session(attempt.session_id, { messages: true })
      if (!session) {
        if (!this.cancelMissingWorker(plan, attempt, fence)) waiting = true
        continue
      }
      this.observeUsage(attempt, session, fence)
      if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0)
        this.approvalWait(plan, attempt, session, fence)
      if (
        session.busy ||
        session.pendingInput ||
        session.observationUnstable ||
        (session.pendingPermissions ?? 0) > 0 ||
        (session.pendingForms ?? 0) > 0
      ) {
        if (session.busy) await this.host.interrupt(attempt.session_id)
        waiting = true
        continue
      }
      const detailedBackgroundReason = this.backgroundBlockReason(session, attempt, true)
      const detailedKnownBackgroundWork =
        session.background?.state === "observed" && session.background.count > 0
      if (detailedKnownBackgroundWork) {
        this.backgroundWait(plan, attempt, session, detailedBackgroundReason!, fence)
        waiting = true
        continue
      }
      if (detailedBackgroundReason)
        this.backgroundWait(
          plan,
          attempt,
          session,
          detailedBackgroundReason,
          fence,
          "WORKER_BACKGROUND_UNKNOWN",
        )
      if (
        promptCompleted &&
        (!session.turn ||
          !this.matchesWorkerInput(attempt, session.turn.inputID) ||
          (session.turn.state !== "completed" && session.turn.state !== "interrupted"))
      ) {
        waiting = true
        continue
      }
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
      if (
        this.store
          .effects(plan.id)
          .some(
            (effect) =>
              effect.attempt_id === attempt.id && ["intended", "uncertain"].includes(effect.state),
          )
      ) {
        waiting = true
        continue
      }
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
    if (
      !allowPlanSettlement ||
      waiting ||
      this.store.effects(plan.id).some((effect) => ["intended", "uncertain"].includes(effect.state))
    )
      return
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'cancelled'),version=version+1 WHERE id=?",
        )
        .run(plan.id),
    )
    this.outcome(plan.id, { status: "cancelled" }, true)
  }

  private cancelMissingWorker(plan: PlanRow, attempt: AttemptRow, fence: number): boolean {
    return this.store.fenced(this.owner, fence, () => {
      const currentPlan = this.store.plan(plan.id)
      const current = this.store
        .attempts(plan.id)
        .filter((candidate) => candidate.task_id === attempt.task_id)
        .at(-1)
      if (
        currentPlan?.owner !== plan.owner ||
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

  private isPriorContinuationBackground(
    attempt: AttemptRow,
    background: HostSession["background"],
    currentInputID: string | null | undefined,
  ) {
    const assignedInputID = currentInputID === undefined ? attempt.message_id : currentInputID
    if (!assignedInputID || !this.matchesWorkerInput(attempt, assignedInputID)) return false
    if (background?.state === "observed")
      return (
        background.inputID !== assignedInputID &&
        this.isPriorContinuationInput(attempt, background.inputID)
      )
    if (background?.state !== "unknown") return false
    const previous = this.store.latestTransition<{
      attemptID?: string
      inputID?: string
      background?: HostSession["background"]
    }>(attempt.plan_id, attempt.task_id, "WORKER_BACKGROUND_UNKNOWN")
    return (
      previous?.attemptID === attempt.id &&
      previous.inputID !== assignedInputID &&
      this.isPriorContinuationInput(attempt, previous.inputID) &&
      JSON.stringify(previous.background) === JSON.stringify(background)
    )
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
    if (!session.outcome) return fail("outcome", "outcome-absent")
    pass("outcome")
    if (!session.turn) return fail("turn", "turn-absent")
    if (session.turn.state === "pending") return fail("turn", "turn-pending")
    if (session.turn.state !== "completed" && session.turn.state !== "interrupted")
      return fail("turn", "turn-unknown")
    pass("turn")
    if (this.isPriorContinuationBackground(attempt, session.background, session.turn.inputID)) {
      // Reflect the existing cleanup exception without reclassifying old input as current.
      stages.push({ stage: "background", status: "passed", code: "prior-continuation-background" })
      for (const stage of cleanupObservationStages.slice(
        cleanupObservationStages.indexOf("background") + 1,
      ))
        stages.push({ stage, status: "not-evaluated" })
      return { binding, firstBlocker: null, stages }
    }
    if (!session.background) return fail("background", "background-absent")
    if (session.background.state === "unknown") return fail("background", "background-unknown")
    pass("background")
    if (!this.matchesWorkerInput(attempt, session.background.inputID))
      return fail("assigned-input", "assigned-input-mismatch")
    pass("assigned-input")
    if (session.turn.inputID !== session.background.inputID)
      return fail("turn-input", "turn-input-mismatch")
    pass("turn-input")
    if (session.background.count > 0) return fail("background-count", "positive-background-count")
    pass("background-count")
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

  private backgroundBlockReason(
    session: HostSession,
    attempt: AttemptRow,
    requireTurnLineage = false,
  ): string | undefined {
    const background = session.background
    if (!background) return "Native idle background observation is unknown"
    if (background.state === "unknown")
      return `Native idle background observation is unknown: ${background.reason}`
    if (
      !this.matchesWorkerInput(attempt, background.inputID) ||
      (requireTurnLineage && session.turn?.inputID !== background.inputID)
    )
      return "Native idle background observation does not match the current worker input lineage"
    if (background.count > 0) {
      const kinds = Object.entries(background.kinds)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${count} ${kind}`)
        .join(", ")
      return `Worker has ${background.count} known background job(s) in the last experimental.idle report${kinds ? ` (${kinds})` : ""}`
    }
    return undefined
  }

  private approvalWait(plan: PlanRow, attempt: AttemptRow, session: HostSession, fence: number) {
    const pendingPermissions = session.pendingPermissions ?? 0
    const pendingForms = session.pendingForms ?? 0
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
      return
    this.store.fenced(this.owner, fence, () =>
      this.store.record(plan.id, attempt.task_id, "WORKER_APPROVAL_WAIT", {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        directory: session.directory,
        pendingPermissions,
        pendingForms,
        observedAt: Date.now(),
      }),
    )
  }

  private resumeTransientObservationWait(plan: PlanRow, fence: number) {
    const current = this.store.plan(plan.id)
    const reason = current?.reason
    const observationReason = reason?.replace(/^Worker execution (?:failed|completed); /, "")
    const backgroundWait =
      observationReason?.startsWith("Native idle background observation") ||
      /^Worker has \d+ known background job\(s\)/.test(observationReason ?? "")
    const approvalWait =
      reason?.startsWith("Worker at ") &&
      reason.includes("pending permission request(s)") &&
      reason.includes("pending form(s)")
    if (current?.state !== "blocked" || !reason || (!backgroundWait && !approvalWait)) return
    this.store.fenced(this.owner, fence, (db) => {
      const changed =
        db
          .query(
            "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason=?",
          )
          .run(plan.id, reason).changes === 1
      if (changed)
        this.store.record(plan.id, null, "WORKER_OBSERVATION_SETTLED", {
          previousReason: reason,
          observation: approvalWait ? "worker-approvals" : "experimental.idle-background",
        })
    })
  }

  private backgroundWait(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    reason: string,
    fence: number,
    event: "WORKER_BACKGROUND_WAIT" | "WORKER_BACKGROUND_UNKNOWN" = "WORKER_BACKGROUND_WAIT",
  ) {
    const background = session.background ?? {
      state: "unknown" as const,
      source: "experimental.idle" as const,
      reason: "Native idle background observation is unavailable",
    }
    const inputID =
      session.turn?.inputID ?? (background.state === "observed" ? background.inputID : undefined)
    const previous = this.store.latestTransition<{
      attemptID?: string
      inputID?: string
      background?: HostSession["background"]
    }>(plan.id, attempt.task_id, event)
    if (
      previous?.attemptID === attempt.id &&
      previous.inputID === inputID &&
      JSON.stringify(previous.background) === JSON.stringify(background)
    )
      return
    this.store.fenced(this.owner, fence, () =>
      this.store.record(plan.id, attempt.task_id, event, {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        ...(inputID ? { inputID } : {}),
        reason,
        background,
      }),
    )
  }

  private async dependencySource(plan: PlanRow, input: PlanInput, node: NodeRow): Promise<string> {
    const dependencies = new Map<string, string[]>()
    for (const edge of input.dependencies) {
      const predecessors = dependencies.get(edge.successor) ?? []
      predecessors.push(edge.prerequisite)
      dependencies.set(edge.successor, predecessors)
    }
    const ancestors = new Set<string>()
    const visit = (taskID: string) => {
      for (const prerequisite of dependencies.get(taskID) ?? [])
        if (!ancestors.has(prerequisite)) {
          ancestors.add(prerequisite)
          visit(prerequisite)
        }
    }
    visit(node.task_id)
    if (!ancestors.size) return input.baseCommit
    const byTask = new Map(
      this.store.nodes(plan.id).map((candidate) => [candidate.task_id, candidate]),
    )
    const attempts = this.store.attempts(plan.id)
    const order = new Map(input.integrationOrder.map((taskID, index) => [taskID, index]))
    const artifacts = [...ancestors]
      .map((taskID) => ({ taskID, node: byTask.get(taskID) }))
      .filter((entry) => entry.node?.state === "accepted")
      .sort((a, b) => order.get(a.taskID)! - order.get(b.taskID)!)
      .map(
        ({ taskID, node: predecessor }) =>
          attempts
            .filter((attempt) => attempt.task_id === taskID && attempt.state === "accepted")
            .at(-1)?.artifact ?? predecessor!.artifact,
      )
    if (artifacts.length !== ancestors.size || artifacts.some((artifact) => !artifact))
      throw new Error("Accepted dependency artifact is missing")
    return combineArtifacts(this.directory, input.baseCommit, artifacts as string[])
  }

  private integratedPrerequisiteBaseline(
    prerequisites: string[],
    candidateBaseline?: string,
  ): string | undefined {
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
      git,
      candidateBaseline,
    )
  }

  private async dispatch(plan: PlanRow, node: NodeRow, fence: number) {
    const dispatchEpoch = this.store.planControlEpoch(plan.id)
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
    const base =
      selectedBaseline ??
      attempts.at(-1)?.artifact ??
      (input.workspaceMode === "shared"
        ? git(this.directory, ["rev-parse", "HEAD"])
        : await this.dependencySource(plan, input, node))
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
        this.store.dispatchPause(plan.id) !== undefined ||
        current.owner !== plan.owner ||
        current.revision !== plan.revision ||
        current.body !== plan.body ||
        this.store.planControlEpoch(plan.id) !== dispatchEpoch ||
        currentNode?.state !== node.state
      )
        return false
      if (
        this.store
          .activeAdoptions()
          .some((adoption) =>
            scopePatternsConflict(
              this.store.effectiveWriteScope(task.id),
              this.store.effectiveWriteScope(adoption.task_id),
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
    const admissionEpoch = this.store.planControlEpoch(plan.id)
    this.store.record(plan.id, task.id, "CONTEXT_RESOLVED", {
      attemptID: id,
      packet: policy.packet,
      ...(persona ? { persona } : {}),
    })
    if (input.workspaceMode === "shared") {
      const current = this.store.plan(plan.id)
      if (
        current?.state !== "running" ||
        current.owner !== admissionOwner ||
        this.store.planControlEpoch(plan.id) !== admissionEpoch
      )
        return
      await this.prepareWorker(plan, attempt, fence)
      return
    }
    const effect = this.effect(plan.id, task.id, id, "worktree", { workspace, base }, fence)
    try {
      const actual = await this.host.worktree({ directory: workspace, base })
      if (git(actual, ["rev-parse", "HEAD"]) !== base)
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
    if (
      current?.state !== "running" ||
      current.owner !== admissionOwner ||
      this.store.planControlEpoch(plan.id) !== admissionEpoch
    )
      return
    await this.prepareWorker(plan, attempt, fence)
  }
  /** Resumes must obey the same checkout/scope admission as fresh dispatch. */
  private preparationAllowed(attempt: AttemptRow) {
    if (sourceQuarantine(this.store, attempt.id)) return false
    const scope = this.store.effectiveWriteScope(attempt.task_id)
    if (
      this.store
        .activeAdoptions()
        .some(
          (adoption) =>
            attempt.workspace === this.directory ||
            scopePatternsConflict(scope, this.store.effectiveWriteScope(adoption.task_id)),
        )
    )
      return false
    for (const other of this.store.activeProjectAttempts()) {
      if (other.id === attempt.id || !["preparing", "running", "verifying"].includes(other.state))
        continue
      // Physical ownership is stronger than logical scope disjointness.
      if (
        sourceQuarantine(this.store, other.id) &&
        samePhysicalWorkspace(attempt.workspace, other.workspace)
      )
        return false
      if (
        sourceReservationExcluded(this.store, other, {
          mode: attempt.workspace === this.directory ? "shared" : "isolated",
          workspace: attempt.workspace,
        })
      )
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
        scopePatternsConflict(scope, this.store.effectiveWriteScope(other.task_id))
      )
        return false
    }
    return true
  }

  private promptAdmissionAllowed(
    planID: string,
    attempt: AttemptRow,
    authority: { owner: string; ownerEpoch: number },
  ) {
    const plan = this.store.plan(planID)
    const currentAttempt = this.store
      .attempts(planID)
      .find((candidate) => candidate.id === attempt.id)
    if (
      plan?.state !== "running" ||
      plan.owner !== authority.owner ||
      this.store.planControlEpoch(planID) !== authority.ownerEpoch ||
      currentAttempt?.state !== "preparing" ||
      !this.preparationAllowed(currentAttempt)
    )
      return false
    const recovery = this.startupRecoveryAuthorization(plan, currentAttempt)
    if (recovery && !this.startupRecoveryAuthorityCurrent(plan, currentAttempt, recovery))
      return false

    const prerequisites = PlanInput.parse(JSON.parse(plan.body)).afterPlans ?? []
    if (!prerequisites.length) return true

    try {
      // The reservation base is immutable prerequisite proof. A later HEAD is
      // acceptable only as scoped progress from a prompt already admitted to this attempt.
      const baseline = currentAttempt.base_commit
      const head = git(currentAttempt.workspace, ["rev-parse", "HEAD"])
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
      const changed = changedPaths(currentAttempt.workspace, baseline)
      if ((head !== baseline || changed.length > 0) && !retainedPrompt) return false
      git(currentAttempt.workspace, ["merge-base", "--is-ancestor", baseline, head])
      if (git(currentAttempt.workspace, ["ls-files", "-u", "-z"])) return false
      if (scopeViolations(changed, this.store.effectiveWriteScope(currentAttempt.task_id)).length)
        return false
      return this.integratedPrerequisiteBaseline(prerequisites, baseline) === baseline
    } catch {
      return false
    }
  }

  private observeUsage(attempt: AttemptRow, session: HostSession, fence: number) {
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
      ownerEpoch?: unknown
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
      !Number.isSafeInteger(repair.ownerEpoch) ||
      (repair.ownerEpoch as number) < 0 ||
      typeof repair.sessionID !== "string" ||
      typeof repair.workspace !== "string" ||
      typeof repair.defect !== "string" ||
      repair.attemptID !== attempt.id ||
      repair.sessionID !== attempt.session_id ||
      repair.workspace !== attempt.workspace ||
      !ModelPolicy.safeParse(repair.route).success
    )
      return undefined
    const plan = this.store.plan(attempt.plan_id)
    if (
      !plan ||
      plan.owner !== repair.owner ||
      this.store.planControlEpoch(attempt.plan_id) !== repair.ownerEpoch
    )
      return undefined
    const repairRoute = ModelPolicy.safeParse(repair.route)
    let attemptRoute: ReturnType<typeof ModelPolicy.safeParse> | undefined
    let planRoute: ReturnType<typeof ModelPolicy.safeParse> | undefined
    try {
      attemptRoute = ModelPolicy.safeParse(
        (JSON.parse(attempt.policy) as { model?: unknown }).model,
      )
      planRoute = plan.model ? ModelPolicy.safeParse(JSON.parse(plan.model)) : undefined
    } catch {
      return undefined
    }
    if (
      !repairRoute.success ||
      !attemptRoute?.success ||
      !planRoute?.success ||
      !this.sameModel(repairRoute.data, attemptRoute.data) ||
      !this.sameModel(repairRoute.data, planRoute.data)
    )
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
      const background = isRecord(captured.background) ? captured.background : undefined
      const boundBackground = background as HostSession["background"]
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
        this.retainedRepairBackgroundProblem(
          attempt,
          {
            id: attempt.session_id,
            projectID: this.projectID,
            directory: attempt.workspace,
            metadata: { lazersAttemptID: attempt.id },
            busy: false,
            pendingInput: false,
            pendingPermissions: 0,
            pendingForms: 0,
            turn: { inputID: admissionInputID, state: "completed" },
            background: boundBackground,
            archived: false,
            tokens: null,
            tools: 0,
            cost: null,
            messages: [],
          },
          admissionInputID,
          admissionAssignmentID,
        )
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
            recovery.owner !== repair.owner ||
            recovery.ownerEpoch !== repair.ownerEpoch ||
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
      ownerEpoch: repair.ownerEpoch as number,
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
      ownerEpoch: repair.ownerEpoch as number,
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
        latestPlan.owner === repair.owner &&
        plan.owner === repair.owner &&
        this.store.planControlEpoch(plan.id) === repair.ownerEpoch &&
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
    const backgroundProblem =
      observed?.background?.state === "observed"
        ? this.retainedRepairBackgroundProblem(
            attempt,
            observed,
            expectedInputID,
            repair.nativeAssignmentID,
          )
        : undefined
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
    const confirmedBackgroundProblem =
      confirmed?.background?.state === "observed"
        ? this.retainedRepairBackgroundProblem(
            attempt,
            confirmed,
            expectedInputID,
            repair.nativeAssignmentID,
          )
        : undefined
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

  private async prepareWorker(plan: PlanRow, attempt: AttemptRow, fence: number) {
    const admissionPlan = this.store.plan(plan.id)
    if (!admissionPlan || admissionPlan.state !== "running" || admissionPlan.owner !== plan.owner)
      return
    const authority = {
      owner: admissionPlan.owner,
      ownerEpoch: this.store.planControlEpoch(plan.id),
    }
    if (!(await this.startupWorkspaceReady(admissionPlan, attempt, fence))) return
    if (!this.promptAdmissionAllowed(plan.id, attempt, authority)) return
    const retainedRepair = this.retainedRepairForAttempt(attempt)
    const latestRepair = this.store.latestRetainedRepair<{ attemptID?: unknown }>(
      plan.id,
      attempt.task_id,
    )
    if (latestRepair?.attemptID === attempt.id && !retainedRepair) {
      this.hold(plan, "Retained repair is missing a valid owner/control authorization fence")
      return
    }
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
      if (!this.promptAdmissionAllowed(plan.id, attempt, authority)) return
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
          title: `LAZERS · ${this.store.repository.get(attempt.task_id)!.proposal.objective.slice(0, 100)}`,
          attemptID: attempt.id,
        })
        this.receipt(effect, { sessionID: attempt.session_id }, fence)
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    if (!this.promptAdmissionAllowed(plan.id, attempt, authority)) return
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
      if (!this.promptAdmissionAllowed(plan.id, attempt, authority)) return
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
            : `Implement task ${attempt.task_id} in ${attempt.workspace}. Fetch the task and source bundle once with lz-get-task before editing. Follow your assigned worker role, use the task's code-grounded guidance, and finish with a commit and concise results. If continuing an earlier attempt, preserve its progress in this assigned workspace.${personaGuidance}`,
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
    if (!this.promptAdmissionAllowed(plan.id, attempt, authority)) return
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

  private async isolateStoppedWorkerSource(
    plan: PlanRow,
    attempt: AttemptRow,
    worker: HostSession,
  ) {
    if (
      plan.state !== "blocked" ||
      (attempt.state !== "running" &&
        !(
          attempt.state === "verifying" &&
          (this.hasSettledVerificationTimeout(plan, attempt) ||
            this.hasSettledHumanEvidenceHold(plan, attempt))
        )) ||
      attempt.workspace === this.directory ||
      !this.host.ensureSourceGuard ||
      !this.host.archiveRetainedWorker ||
      sourceQuarantine(this.store, attempt.id) ||
      worker.busy ||
      worker.pendingInput !== false ||
      worker.observationUnstable ||
      worker.pendingPermissions !== 0 ||
      worker.pendingForms !== 0 ||
      worker.outcome !== "succeeded"
    )
      return
    const scope = this.store.effectiveWriteScope(attempt.task_id)
    const hasContender = Iterator.from(this.store.runnablePlans(terminal)).some((candidate) => {
      if (
        candidate.id === plan.id ||
        candidate.state !== "running" ||
        this.store.dispatchPause(candidate.id)
      )
        return false
      const input = PlanInput.parse(JSON.parse(candidate.body))
      return (
        input.workspaceMode === "isolated" &&
        this.store
          .nodes(candidate.id)
          .some(
            (node) =>
              ["queued", "ready"].includes(node.state) &&
              this.store.execution(node.task_id)?.waitingOn.length === 0 &&
              scopePatternsConflict(scope, this.store.effectiveWriteScope(node.task_id)),
          ) &&
        (!input.afterPlans?.length || !!this.integratedPrerequisiteBaseline(input.afterPlans))
      )
    })
    if (!hasContender) return
    const detailed = worker.turn
      ? worker
      : await this.host.session(attempt.session_id, { messages: true })
    const inputID = detailed?.turn?.inputID
    if (!inputID || !this.matchesWorkerInput(attempt, inputID)) return
    const reviewInput = inputID === attempt.message_id ? undefined : inputID
    if (!reviewInput && this.sourceWorkerWait(attempt, detailed)) return
    await this.command(
      {
        requestID: `isolate-stopped-source:${attempt.id}:${attempt.message_id}`,
        action: "quarantine-source",
        planID: plan.id,
        expectedVersion: plan.version,
        taskID: attempt.task_id,
        attemptID: attempt.id,
        ...(reviewInput && attempt.state === "running" ? { reviewInputID: reviewInput } : {}),
        reason:
          "Completed foreground; preserve the isolated checkout and release its source reservation",
      },
      plan.owner,
    )
  }

  private failMissingWorker(plan: PlanRow, attempt: AttemptRow, fence: number) {
    this.store.fenced(this.owner, fence, () => {
      const currentPlan = this.store.plan(plan.id)
      const latest = this.store
        .attempts(plan.id)
        .filter((item) => item.task_id === attempt.task_id)
        .at(-1)
      const node = this.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)
      if (
        !currentPlan ||
        currentPlan.owner !== plan.owner ||
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

  private quarantinedVerification(plan: PlanRow) {
    const attempt = this.store
      .attempts(plan.id)
      .find(
        (candidate) =>
          candidate.state === "verifying" &&
          sourceQuarantine(this.store, candidate.id)?.phase === "sealed",
      )
    if (!attempt) return
    const node = this.store
      .nodes(plan.id)
      .find((candidate) => candidate.task_id === attempt.task_id)
    if (node?.state !== "verifying") return
    const retained = this.store.atomic((db) =>
      activeRetainedVerifications(db, this.directory, plan.id).find(
        (operation) =>
          operation.attemptID === attempt.id &&
          operation.artifact === attempt.artifact &&
          operation.sourceQuarantine !== undefined &&
          operation.state !== "held",
      ),
    )
    if (retained && this.retainedVerificationLive(retained.id, retained.generation)) return
    return this.hold(
      plan,
      "The verifying worker's checkout is quarantined. Run verify-retained on its candidate in an isolated checkout.",
      ["verify-retained", "audit", "cancel"],
    )
  }

  private async advanceAttempt(plan: PlanRow, attempt: AttemptRow, fence: number) {
    // Quarantined source is retained for isolated verification, not ordinary
    // worker execution or mechanical edits in its original checkout.
    if (sourceQuarantine(this.store, attempt.id)) {
      if (plan.state === "running" && attempt.state === "verifying")
        this.quarantinedVerification(plan)
      return
    }
    if (attempt.state === "preparing") {
      await this.prepareWorker(plan, attempt, fence)
      return
    }
    let session = await this.host.session(attempt.session_id)
    if (!["running", "blocked"].includes(this.store.plan(plan.id)!.state)) {
      if (session) this.observeUsage(attempt, session, fence)
      return
    }
    if (!session) {
      this.failMissingWorker(plan, attempt, fence)
      return
    }
    const task = this.store.repository.get(attempt.task_id)!
    this.observeUsage(attempt, session, fence)
    if (!["running", "blocked"].includes(this.store.plan(plan.id)!.state)) return
    if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0) {
      this.approvalWait(plan, attempt, session, fence)
      this.hold(
        plan,
        `Worker at ${session.directory} has ${session.pendingPermissions ?? 0} pending permission request(s) and ${session.pendingForms ?? 0} pending form(s)`,
        ["audit", "reconcile", "cancel"],
      )
      return
    }
    if (
      session.turn &&
      !this.matchesWorkerInput(attempt, session.turn.inputID) &&
      this.isPriorContinuationInput(attempt, session.turn.inputID)
    )
      return
    const priorBackground = this.isPriorContinuationBackground(
      attempt,
      session.background,
      session.turn?.inputID,
    )
    const backgroundReason = this.backgroundBlockReason(session, attempt)
    const previousHold = this.store.latestTransition<{ workerObservation?: TerminalWorkerHold }>(
      plan.id,
      null,
      "BLOCKED",
    )?.workerObservation
    const unchangedTerminal =
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
          previousHold.turnState === session.turn.state)) &&
      JSON.stringify(previousHold.background) === JSON.stringify(session.background)
    if (
      !session.busy &&
      !session.pendingInput &&
      !session.observationUnstable &&
      backgroundReason &&
      session.outcome !== "interrupted" &&
      ((session.outcome !== "failed" && session.outcome !== "succeeded") ||
        unchangedTerminal ||
        session.archived ||
        (session.outcome === "succeeded" &&
          session.background?.state === "observed" &&
          session.background.count > 0))
    ) {
      if (!priorBackground) {
        this.hold(
          plan,
          backgroundReason,
          ["audit", "reconcile", "cancel"],
          unchangedTerminal ? previousHold : undefined,
        )
        this.backgroundWait(plan, attempt, session, backgroundReason, fence)
        if (unchangedTerminal && session.background?.state === "unknown")
          await this.isolateStoppedWorkerSource(this.store.plan(plan.id)!, attempt, session)
      }
      return
    }
    if (!session.busy && !session.pendingInput && !session.observationUnstable && session.outcome) {
      const detailed = await this.host.session(attempt.session_id, { messages: true })
      if (!["running", "blocked"].includes(this.store.plan(plan.id)!.state)) {
        if (detailed) this.observeUsage(attempt, detailed, fence)
        return
      }
      if (!detailed) {
        this.failMissingWorker(plan, attempt, fence)
        return
      }
      session = detailed
      this.observeUsage(attempt, session, fence)
      if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0) {
        this.approvalWait(plan, attempt, session, fence)
        this.hold(
          plan,
          `Worker at ${session.directory} has ${session.pendingPermissions ?? 0} pending permission request(s) and ${session.pendingForms ?? 0} pending form(s)`,
          ["audit", "reconcile", "cancel"],
        )
        return
      }
      if (session.busy || session.pendingInput || session.observationUnstable) return
      if (
        session.turn &&
        !this.matchesWorkerInput(attempt, session.turn.inputID) &&
        this.isPriorContinuationInput(attempt, session.turn.inputID)
      )
        return
      const priorBackground = this.isPriorContinuationBackground(
        attempt,
        session.background,
        session.turn?.inputID,
      )
      const detailedBackgroundReason = this.backgroundBlockReason(session, attempt, true)
      if (session.outcome === "interrupted") {
        this.workerEvent(
          plan,
          attempt,
          "WORKER_STOPPED",
          fence,
          "interrupted",
          session.turn?.inputID,
        )
        const reason = detailedBackgroundReason
          ? `Worker execution was interrupted; ${detailedBackgroundReason}`
          : "Worker execution was interrupted; explicit reconciliation or cancellation is required"
        if (detailedBackgroundReason)
          this.backgroundWait(
            plan,
            attempt,
            session,
            detailedBackgroundReason,
            fence,
            session.background?.state === "unknown" || !session.background
              ? "WORKER_BACKGROUND_UNKNOWN"
              : "WORKER_BACKGROUND_WAIT",
          )
        this.hold(
          plan,
          reason,
          ["audit", "reconcile", "cancel"],
          this.terminalWorkerObservation(attempt, session),
        )
        return
      }
      if (detailedBackgroundReason) {
        if (session.outcome === "failed" || session.outcome === "succeeded") {
          this.workerEvent(
            plan,
            attempt,
            "WORKER_STOPPED",
            fence,
            session.outcome,
            session.turn?.inputID,
          )
          this.backgroundWait(
            plan,
            attempt,
            session,
            detailedBackgroundReason,
            fence,
            session.background?.state === "unknown" || !session.background
              ? "WORKER_BACKGROUND_UNKNOWN"
              : "WORKER_BACKGROUND_WAIT",
          )
          this.hold(
            plan,
            `Worker execution ${session.outcome === "failed" ? "failed" : "completed"}; ${detailedBackgroundReason}`,
            ["audit", "reconcile", "cancel"],
            this.terminalWorkerObservation(attempt, session),
          )
          if (session.background?.state === "unknown")
            await this.isolateStoppedWorkerSource(this.store.plan(plan.id)!, attempt, session)
          return
        }
        if (priorBackground && !session.outcome) return
        this.hold(plan, detailedBackgroundReason, ["audit", "reconcile", "cancel"])
        this.backgroundWait(plan, attempt, session, detailedBackgroundReason, fence)
        return
      }
    }
    if (session.busy || session.pendingInput || session.observationUnstable || !session.outcome)
      return
    this.resumeTransientObservationWait(plan, fence)
    if (
      session.outcome === "succeeded" &&
      (!session.turn ||
        !this.matchesWorkerInput(attempt, session.turn.inputID) ||
        session.turn.state !== "completed")
    ) {
      if (
        session.turn &&
        this.matchesWorkerInput(attempt, session.turn.inputID) &&
        session.turn.state === "pending"
      )
        return
      this.hold(
        plan,
        "Native worker success does not match a completed response to the current assigned input",
        ["audit", "reconcile", "cancel"],
      )
      return
    }
    this.workerEvent(plan, attempt, "WORKER_STOPPED", fence, session.outcome, session.turn?.inputID)
    if (session.outcome !== "succeeded") {
      if (session.outcome === "interrupted") {
        this.hold(
          plan,
          "Worker execution was interrupted; explicit reconciliation or cancellation is required",
          ["audit", "reconcile", "cancel"],
          this.terminalWorkerObservation(attempt, session),
        )
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
    const current = this.store.plan(plan.id)
    const retained = this.store.attempts(plan.id).find((item) => item.id === attempt.id)
    if (current?.state === "blocked" && retained?.state === "verifying")
      await this.isolateStoppedWorkerSource(current, retained, session)
  }

  private prepareVerificationCandidate(
    plan: PlanRow,
    attempt: AttemptRow,
    proposal: TaskProposal,
    fence: number,
  ): "ready" | "prepared" | "pending" | "held" {
    if (!needsMechanicalQualityPreparation(proposal.verification.map((check) => check.command)))
      return "ready"
    const scope = this.store.effectiveWriteScope(attempt.task_id)
    const paths = changedPaths(attempt.workspace, attempt.base_commit)
    if (scopeViolations(paths, scope).length) return "ready"
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
    if (!this.preparationAllowed(attempt)) {
      this.hold(
        plan,
        "Mechanical candidate preparation is blocked by an active scope reservation or source quarantine; no files were changed",
      )
      return "held"
    }
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
    const inputFingerprint = workingTreeIdentity(attempt.workspace, attempt.base_commit)
    const shared = attempt.workspace === this.directory
    const sharedDirty = shared && changedPaths(attempt.workspace).length > 0
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
      controlEpoch: this.store.planControlEpoch(plan.id),
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
        recorded.repairID !== payload.repairID ||
        recorded.controlEpoch !== payload.controlEpoch
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
          workingTreeIdentity(attempt.workspace, attempt.base_commit)
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
          resultingFingerprint: workingTreeIdentity(attempt.workspace, attempt.base_commit),
          paths,
          scope,
        }
        const result = { ...receipt, preparation }
        writeCheckReceipt(payload.receiptPath, result)
        return result
      },
    })
    return "pending"
  }

  private async verify(plan: PlanRow, attempt: AttemptRow, proposal: TaskProposal, fence: number) {
    const repairID = this.retainedRepairGeneration(plan.id, attempt.task_id)
    const verificationCurrent = () => {
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
    if (!verificationCurrent()) return
    const currentPlanBeforeVerification = this.store.plan(plan.id)
    if (
      currentPlanBeforeVerification?.state === "blocked" &&
      attempt.artifact &&
      proposal.verification.some((check) => {
        const target = this.verificationTarget(
          currentPlanBeforeVerification,
          "task",
          check,
          attempt.artifact!,
          attempt.task_id,
          this.store.repository.get(attempt.task_id)?.revision ?? null,
          attempt.id,
        )
        return this.deadlineAwaitingTaskContinuation(
          currentPlanBeforeVerification,
          target,
          this.verificationDeadline(target),
        )
      })
    )
      return
    const preparation = this.prepareVerificationCandidate(plan, attempt, proposal, fence)
    if (preparation === "pending" || preparation === "held") return
    let artifact: Awaited<ReturnType<typeof commitArtifact>>
    try {
      const head = git(attempt.workspace, ["rev-parse", "HEAD"])
      const checkedCandidate = this.store.effects(plan.id).some((effect) => {
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
      const retainFixes =
        (preparation === "prepared" || checkedCandidate) && this.preparationAllowed(attempt)
      artifact = await commitArtifact(
        attempt.workspace,
        attempt.base_commit,
        this.store.effectiveWriteScope(attempt.task_id),
        attempt.workspace !== this.directory || retainFixes,
        attempt.workspace !== this.directory
          ? git(this.directory, ["rev-parse", "HEAD"])
          : undefined,
      )
      if (!verificationCurrent()) return
      // Publish the private snapshot before starting checks. Recreating
      // commit-tree on each tick changes its identity
      // and can strand an otherwise valid receipt (or supersede worker edits).
      if ((attempt.workspace !== this.directory || retainFixes) && artifact.commit !== head)
        git(attempt.workspace, ["update-ref", "HEAD", artifact.commit, head])
    } catch (error) {
      if (!verificationCurrent()) return
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
            paths: error.paths,
            reason: error.message,
          })
          this.hold(plan, error.message, ["amend-scope", "audit", "reconcile", "cancel"])
        })
        return
      }
      this.failAttempt(plan, attempt, errorText(error))
      return
    }
    this.store.fenced(this.owner, fence, (db) => {
      db.query("UPDATE runner_attempts SET artifact=? WHERE id=?").run(artifact.commit, attempt.id)
      db.query("UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=?").run(
        artifact.commit,
        plan.id,
        attempt.task_id,
      )
    })
    try {
      this.progress.recordArtifact(attempt.id, artifact.commit)
    } catch {
      // Artifact acceptance and its runner receipt remain independent of commentary.
    }
    const verificationEpoch =
      this.store.latestTransition<{ verificationEpoch: number }>(
        plan.id,
        attempt.task_id,
        "VERIFICATION_RESUMED",
      )?.verificationEpoch ?? 0
    const receipts: CheckReceipt[] = []
    for (const check of proposal.verification) {
      if (!["running", "blocked"].includes(this.store.plan(plan.id)!.state)) return
      const deadline = this.verificationDeadline(
        this.verificationTarget(
          plan,
          "task",
          check,
          artifact.commit,
          attempt.task_id,
          this.store.repository.get(attempt.task_id)?.revision ?? null,
          attempt.id,
        ),
      )
      const effectiveCheck = effectiveVerificationCheck(check, deadline)
      const known = this.store
        .effects(plan.id)
        .toReversed()
        .find((e) => {
          if (e.attempt_id !== attempt.id || e.kind !== `verify:${check.id}`) return false
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
      if (
        !known &&
        this.store.plan(plan.id)?.state === "blocked" &&
        this.deadlineAwaitingTaskContinuation(
          plan,
          this.verificationTarget(
            plan,
            "task",
            check,
            artifact.commit,
            attempt.task_id,
            this.store.repository.get(attempt.task_id)?.revision ?? null,
            attempt.id,
          ),
          deadline,
        )
      )
        return
      if (known && known.state !== "completed") {
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
        return
      }
      if (known?.state === "completed") {
        receipts.push(JSON.parse(known.receipt!).check)
        continue
      }
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
              { signal },
            ),
        })
        return
      } catch (error) {
        try {
          this.progress.recordVerificationError(attempt.id, effect.id, check.id, error)
        } catch {
          // The runner effect remains authoritative if annotation storage fails.
        }
        this.uncertain(effect, error, fence)
        return
      }
    }
    const failure = receipts.find((r) => !checkSucceeded(r))
    if (failure) {
      if (
        failure.timedOut ||
        failure.exitCode === 126 ||
        failure.exitCode === 127 ||
        !checkResourcesSettled(failure)
      ) {
        this.hold(plan, checkFailureReason(failure), ["reconcile", "resume", "audit", "cancel"])
        return
      }
      this.failAttempt(plan, attempt, checkFailureReason(failure))
      return
    }
    try {
      // Capture automatic fixes in the delivered source; cleanliness is not a pass/fail condition.
      if (!artifactUnchanged(attempt.workspace, artifact.commit)) {
        const previousHead = git(attempt.workspace, ["rev-parse", "HEAD"])
        artifact = await commitArtifact(
          attempt.workspace,
          attempt.base_commit,
          this.store.effectiveWriteScope(attempt.task_id),
          true,
          attempt.workspace !== this.directory
            ? git(this.directory, ["rev-parse", "HEAD"])
            : undefined,
        )
        if (!verificationCurrent()) return
        if (artifact.commit !== previousHead)
          git(attempt.workspace, ["update-ref", "HEAD", artifact.commit, previousHead])
        this.store.fenced(this.owner, fence, (db) => {
          db.query("UPDATE runner_attempts SET artifact=? WHERE id=?").run(
            artifact.commit,
            attempt.id,
          )
          db.query("UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=?").run(
            artifact.commit,
            plan.id,
            attempt.task_id,
          )
        })
        if (artifact.commit !== previousHead) return
      }
    } catch (error) {
      this.hold(plan, errorText(error))
      return
    }
    const missing = this.missingEvidence(
      plan.id,
      attempt.task_id,
      artifact.commit,
      attempt.workspace,
      proposal.acceptance,
      receipts,
      undefined,
      repairID,
    )
    if (missing.length) {
      this.hold(plan, `Required evidence missing: ${missing.join(", ")}`)
      return
    }
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
        },
        true,
      )
    })
    try {
      this.progress.recordAttemptOutcome(attempt.id, "accepted")
    } catch {
      // Progress facts never grant or revoke acceptance.
    }
  }
  private missingEvidence(
    planID: string,
    taskID: string | null,
    artifact: string,
    workspace: string,
    assertions: TaskProposal["acceptance"],
    receipts: CheckReceipt[],
    adoptionID?: string,
    sourceGeneration?: string,
  ) {
    const missing: string[] = []
    for (const assertion of assertions)
      for (const evidence of assertion.evidence) {
        if (
          evidence.kind === "verification" &&
          !receipts.some((r) => r.id === evidence.verificationID && checkSucceeded(r))
        )
          missing.push(assertion.id)
        if (evidence.kind === "artifact" && !artifactExists(workspace, evidence.reference))
          missing.push(`${assertion.id}:${evidence.reference}`)
        if (evidence.kind === "human") {
          const found = adoptionID
            ? this.store.hasAdoptionEvidence(
                adoptionID,
                taskID === null ? "combined" : "task",
                taskID,
                assertion.id,
                artifact,
              )
            : this.store.atomic((db) => {
                const rows = db
                  .query<{ body: string }, [string, string | null, string, string]>(
                    "SELECT body FROM runner_evidence WHERE plan_id=? AND task_id IS ? AND kind='human' AND assertion_id=? AND artifact=?",
                  )
                  .all(planID, taskID, assertion.id, artifact)
                return rows.some((row) => {
                  try {
                    return (
                      ((JSON.parse(row.body) as { sourceGeneration?: unknown }).sourceGeneration ??
                        undefined) === sourceGeneration
                    )
                  } catch {
                    return false
                  }
                })
              })
          if (!found) missing.push(`${assertion.id}:human`)
        }
      }
    return missing
  }

  private sourceQuarantinePlanVersionCurrent(
    operation: RetainedVerification,
    plan: PlanRow,
    database?: Database,
  ): boolean {
    if (!operation.sourceQuarantine) return false
    if (plan.version === operation.planVersion)
      return ["running", "blocked", "accepted", "cleanup-blocked"].includes(plan.state)
    if (plan.state !== "blocked" || plan.version !== operation.planVersion + 1) return false

    const supportedBlock = (db: Database) => {
      const requests = db
        .query<{ id: number; payload: string }, [string, string]>(
          `SELECT id,payload FROM runner_transitions
           WHERE plan_id=? AND task_id=? AND event='RETAINED_VERIFICATION_REQUESTED'
           ORDER BY id DESC`,
        )
        .all(plan.id, operation.taskID)
      const request = requests.find((row) => {
        try {
          const payload = JSON.parse(row.payload) as { operationID?: unknown; generation?: unknown }
          return payload.operationID === operation.id && payload.generation === operation.generation
        } catch {
          return false
        }
      })
      if (!request) return false

      const blocked = db
        .query<{ id: number; version: number; payload: string }, [string]>(
          `SELECT id,version,payload FROM runner_transitions
           WHERE plan_id=? AND task_id IS NULL AND event='BLOCKED' ORDER BY id DESC LIMIT 1`,
        )
        .get(plan.id)
      if (!blocked || blocked.id <= request.id || blocked.version !== plan.version) return false
      try {
        return (JSON.parse(blocked.payload) as { reason?: unknown }).reason === plan.reason
      } catch {
        return false
      }
    }

    return database ? supportedBlock(database) : this.store.atomic(supportedBlock)
  }

  private retainedVerificationLive(operationID: string, generation: number): boolean {
    try {
      const current = this.store.atomic((db) => retainedVerification(db, operationID))
      if (
        !current ||
        current.generation !== generation ||
        ![
          "pending",
          "task-checks",
          "combined-checks",
          "waiting-human",
          "waiting-human-combined",
          "task-accepted",
        ].includes(current.state)
      )
        return false
      const plan = this.store.plan(current.planID)
      const task = this.store.repository.get(current.taskID)
      const latestAttempt = this.store
        .attempts(current.planID)
        .filter((attempt) => attempt.task_id === current.taskID)
        .at(-1)
      const combinedPhase =
        current.state === "combined-checks" || current.state === "waiting-human-combined"
      const deferredTaskPhase = current.state === "task-accepted"
      const sourceQuarantineCurrent = Boolean(
        current.sourceQuarantine &&
        ["running", "blocked", "accepted", "cleanup-blocked"].includes(plan?.state ?? "") &&
        latestAttempt?.state === "verifying" &&
        latestAttempt.artifact === current.artifact &&
        sourceQuarantineVerificationBindingMatches(this.store, {
          planID: current.planID,
          owner: current.owner,
          attempt: latestAttempt,
          artifact: current.artifact,
          expected: current.sourceQuarantine,
        }),
      )
      const planIsCurrent = current.sourceQuarantine
        ? Boolean(
            sourceQuarantineCurrent &&
            plan &&
            (deferredTaskPhase || this.sourceQuarantinePlanVersionCurrent(current, plan)),
          )
        : Boolean(
            ["blocked", "accepted", "cleanup-blocked"].includes(plan?.state ?? "") ||
            ((combinedPhase || deferredTaskPhase) && plan?.state === "running") ||
            (deferredTaskPhase && plan?.state === "blocked"),
          )
      const planVersionCurrent = Boolean(
        plan &&
        (deferredTaskPhase ||
          (current.sourceQuarantine
            ? this.sourceQuarantinePlanVersionCurrent(current, plan)
            : plan.version === current.planVersion)),
      )
      return Boolean(
        plan &&
        planIsCurrent &&
        plan.owner === current.owner &&
        plan.revision === current.planRevision &&
        planVersionCurrent &&
        this.store.planControlEpoch(plan.id) === current.ownerEpoch &&
        task &&
        task.revision === current.taskRevision &&
        task.provenance.projectID === this.projectID &&
        task.provenance.projectDirectory === this.directory &&
        !this.store.repository.taskDisposition(current.taskID) &&
        latestAttempt?.id === current.attemptID &&
        latestAttempt.session_id === current.originalSessionID &&
        latestAttempt.message_id === current.originalMessageID &&
        (!current.repair ||
          (this.retainedRepairCandidateCurrent(plan, latestAttempt, current.repair) &&
            (latestAttempt.artifact === current.repair.previousArtifact ||
              latestAttempt.artifact === current.artifact))) &&
        realpathSync(latestAttempt.workspace) === current.originalWorkspace,
      )
    } catch {
      return false
    }
  }

  private retainedTaskCandidateAccepted(operation: RetainedVerification): boolean {
    const accepted = this.store.latestTransition<{
      operationID?: string
      generation?: number
      artifact?: string
    }>(operation.planID, operation.taskID, "RETAINED_TASK_CANDIDATE_ACCEPTED")
    return Boolean(
      accepted?.operationID === operation.id &&
      accepted.generation === operation.generation &&
      accepted.artifact === operation.artifact,
    )
  }

  private retainedCombinedGatePending(operation: RetainedVerification): boolean {
    return Boolean(
      ["task-accepted", "combined-checks", "waiting-human-combined"].includes(operation.state) ||
      (operation.state === "held" && this.retainedTaskCandidateAccepted(operation)),
    )
  }

  private retainedVerificationInputFingerprint(
    operation: RetainedVerification,
    phase: "task" | "combined",
  ): string {
    return phase === "task"
      ? operation.inputFingerprint
      : (operation.combinedInputFingerprint ?? operation.inputFingerprint)
  }

  private async retainedWorkspaceUnchanged(
    workspace: string,
    artifact: string,
    ownedDependencyLink?: { path: string; target: string } | null,
  ): Promise<boolean> {
    try {
      const workspaceRoot = realpathSync(workspace)
      let status = await gitAsync(workspace, ["status", "--porcelain", "--untracked-files=all"])
      if (ownedDependencyLink) {
        if (
          ownedDependencyLink.path !== join(workspaceRoot, "node_modules") ||
          !lstatSync(ownedDependencyLink.path).isSymbolicLink() ||
          realpathSync(ownedDependencyLink.path) !== ownedDependencyLink.target
        )
          return false
        status = status
          .split("\n")
          .filter((line) => line !== "?? node_modules")
          .join("\n")
      }
      return (
        realpathSync(git(workspace, ["rev-parse", "--show-toplevel"])) === workspaceRoot &&
        git(workspace, ["rev-parse", "HEAD"]) === artifact &&
        !status &&
        !git(workspace, ["ls-files", "-u", "-z"])
      )
    } catch {
      return false
    }
  }

  private retainedProbeResourcesAreIsolated(
    operation: RetainedVerification,
    workspace: string,
    resources: ReturnType<ResourceRepository["resourcesForRun"]>,
  ): boolean {
    if (resources.length === 0) return false
    const canonicalPath = (value: string) => {
      const absolute = resolve(value)
      try {
        return (existsSync(absolute) ? realpathSync(absolute) : absolute).toLocaleLowerCase()
      } catch {
        return absolute.toLocaleLowerCase()
      }
    }
    const workspaces = [
      operation.originalWorkspace,
      workspace,
      this.store.repository.path,
      process.env.HOME,
      process.env.XDG_CONFIG_HOME,
      process.env.XDG_DATA_HOME,
      process.env.XDG_CACHE_HOME,
      process.env.XDG_STATE_HOME,
      process.env.LAZERS_VERIFICATION_SQLITE,
    ]
      .filter((path): path is string => Boolean(path))
      .map(canonicalPath)
    const overlaps = (left: string, right: string) => {
      const path = canonicalPath(left)
      const parent = canonicalPath(right)
      const rel = relative(parent, path)
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
    }
    const currentRunID = resources[0]!.runID
    if (resources.some((resource) => resource.runID !== currentRunID)) return false
    const priorOwnedResources = this.store.atomic((db) => {
      const table = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='owned_resources'",
        )
        .get()
      if (!table) return []
      return db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM owned_resources WHERE project_directory=?",
        )
        .all(operation.projectDirectory)
        .flatMap(({ payload }) => {
          try {
            const resource = JSON.parse(payload) as {
              runID?: unknown
              resourceKey?: unknown
              state?: unknown
            }
            if (resource.runID === currentRunID || resource.state === "removed") return []
            if (
              typeof resource.resourceKey !== "string" ||
              !resource.resourceKey.startsWith("filesystem:")
            )
              return [null]
            const path = resource.resourceKey.slice("filesystem:".length)
            return path.startsWith("/") ? [path] : [null]
          } catch {
            return [null]
          }
        })
    })
    if (priorOwnedResources.some((path) => path === null)) return false
    const retainedCheckPaths = this.store.atomic((db) =>
      db
        .query<{ canonical_path: string }, [string, string, number]>(
          `SELECT canonical_path FROM runner_retained_verification_resources
           WHERE project_directory=? AND operation_id=? AND generation=?`,
        )
        .all(operation.projectDirectory, operation.id, operation.generation)
        .map((row) => row.canonical_path),
    )
    const currentPaths = resources.map((resource) => {
      if (!resource.resourceKey.startsWith("filesystem:")) return false
      const resourcePath = resource.resourceKey.slice("filesystem:".length)
      if (!resourcePath.startsWith("/")) return false
      return canonicalPath(resourcePath)
    })
    if (currentPaths.some((path) => path === false)) return false
    const allCurrentPaths = currentPaths as string[]
    const distinct = allCurrentPaths.every((path, index) =>
      allCurrentPaths
        .slice(index + 1)
        .every((other) => !overlaps(path, other) && !overlaps(other, path)),
    )
    const externalPaths = [...priorOwnedResources, ...retainedCheckPaths].filter(
      (path): path is string => path !== null,
    )
    return (
      distinct &&
      allCurrentPaths.every((path) =>
        [...workspaces, ...externalPaths].every(
          (blocked) => !overlaps(path, blocked) && !overlaps(blocked, path),
        ),
      )
    )
  }

  private retainedVerificationIsolatedWorkspace(
    operation: RetainedVerification,
    phase: "task" | "combined",
  ): string | undefined {
    return phase === "task"
      ? (operation.taskWorkspace ?? undefined)
      : (operation.combinedWorkspace ?? undefined)
  }

  private notifyHeldRetainedVerification(operationID: string, fence: number) {
    this.store.fenced(this.owner, fence, (db) => {
      const operation = retainedVerification(db, operationID)
      if (operation?.state !== "held") return
      const plan = this.store.plan(operation.planID)
      if (!plan || ["cancelling", "cancelled", "integrated"].includes(plan.state)) return
      const alreadyNotified = db
        .query<{ id: string }, [string, string, string]>(
          `SELECT id FROM runner_outbox WHERE plan_id=?
           AND (session_id=? OR state IN ('pending','sending','uncertain','admitted','delivered'))
           AND json_extract(payload,'$.status')='retained-verification-held'
           AND json_extract(payload,'$.operationID')=?
           AND state NOT IN ('unknown','superseded') LIMIT 1`,
        )
        .get(plan.id, plan.owner, operation.id)
      if (alreadyNotified) return
      this.outcome(
        plan.id,
        {
          status: "retained-verification-held",
          operationID: operation.id,
          generation: operation.generation,
          taskID: operation.taskID,
          attemptID: operation.attemptID,
          artifact: operation.artifact,
          reason: safeText(
            operation.holdReason ?? "Retained verification requires review",
            privacyStats(),
          ),
        },
        true,
      )
    })
  }

  private async holdRetainedVerification(
    initial: RetainedVerification,
    reason: string,
    fence: number,
  ): Promise<void> {
    this.store.fenced(this.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      if (
        !current ||
        current.generation !== initial.generation ||
        ![
          "pending",
          "task-checks",
          "combined-checks",
          "waiting-human",
          "waiting-human-combined",
          "task-accepted",
        ].includes(current.state)
      )
        return
      if (current.state === "held" && current.holdReason === reason) return
      const updated: RetainedVerification = {
        ...current,
        state: "held",
        holdReason: reason,
        updatedAt: this.now(),
      }
      saveRetainedVerification(db, updated)
      this.store.record(current.planID, current.taskID, "RETAINED_VERIFICATION_HELD", {
        operationID: current.id,
        generation: current.generation,
        reason,
        originalAttemptPreserved: true,
      })
    })
  }

  private async setRetainedVerificationState(
    initial: RetainedVerification,
    state: RetainedVerification["state"],
    reason: string | null,
    fence: number,
  ): Promise<RetainedVerification | undefined> {
    return this.store.fenced(this.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      if (
        !current ||
        current.generation !== initial.generation ||
        ![
          "pending",
          "task-checks",
          "combined-checks",
          "waiting-human",
          "waiting-human-combined",
        ].includes(current.state)
      )
        return undefined
      if (current.state === state && current.holdReason === reason) return current
      const updated: RetainedVerification = {
        ...current,
        state,
        holdReason: reason,
        updatedAt: this.now(),
      }
      saveRetainedVerification(db, updated)
      return updated
    })
  }

  private async ensureRetainedVerificationWorkspace(
    initial: RetainedVerification,
    phase: "task" | "combined",
    artifact: string,
    fence: number,
  ): Promise<string | undefined> {
    if (!this.retainedVerificationLive(initial.id, initial.generation)) return undefined
    const field = phase === "task" ? initial.taskWorkspace : initial.combinedWorkspace
    const fieldState =
      phase === "task" ? initial.taskWorkspaceState : initial.combinedWorkspaceState
    const proposed = this.retainedVerificationWorkspacePath(initial.id, phase)
    const workspace = field ?? proposed
    const native = await this.host.worktrees()
    const candidates =
      fieldState === "reserved" || fieldState === "uncertain"
        ? startupWorktreeCandidates(workspace)
        : [workspace]
    const present = native.find((item) =>
      candidates.some((candidate) => samePhysicalWorkspace(item, candidate)),
    )
    if (present) {
      let mismatches: string[]
      try {
        const actual = realpathSync(present)
        const topLevel = realpathSync(git(actual, ["rev-parse", "--show-toplevel"]))
        const head = git(actual, ["rev-parse", "HEAD"])
        const status = await gitAsync(actual, ["status", "--porcelain", "--untracked-files=all"])
        const conflicts = git(actual, ["ls-files", "-u", "-z"])
        const pendingCheck = this.store.atomic((db) =>
          retainedVerificationChecks(db, initial.id, phase).find(
            (check) => check.workspace === actual && check.artifact === artifact,
          ),
        )
        const pendingActivity = pendingCheck
          ? this.checkActivity(
              `retained:${initial.id}:${initial.generation}:${phase}:${pendingCheck.checkID}`,
              {
                operationID: initial.id,
                generation: initial.generation,
                phase,
                checkID: pendingCheck.checkID,
                inputFingerprint: pendingCheck.inputFingerprint,
                workspace: pendingCheck.workspace,
                artifact: pendingCheck.artifact,
                contextPath: pendingCheck.contextPath,
              },
            )
          : undefined
        const checkOwnsCheckoutChanges = Boolean(
          pendingCheck &&
          (pendingActivity || pendingCheck.receipt || existsSync(pendingCheck.receiptPath)),
        )
        mismatches = [
          ...(actual !== realpathSync(present) ? ["noncanonical-path"] : []),
          ...(realpathSync(dirname(actual)) !== realpathSync(dirname(workspace))
            ? ["unexpected-parent"]
            : []),
          ...(samePhysicalWorkspace(actual, initial.originalWorkspace)
            ? ["original-workspace"]
            : []),
          ...(samePhysicalWorkspace(actual, this.directory) ? ["project-workspace"] : []),
          ...(topLevel !== actual ? ["repository-root"] : []),
          ...(head !== artifact ? ["candidate-identity"] : []),
          ...(status && !checkOwnsCheckoutChanges ? ["dirty-checkout"] : []),
          ...(conflicts ? ["unmerged-files"] : []),
        ]
        if (mismatches.length === 0) {
          const updated = this.store.fenced(this.owner, fence, (db) => {
            const current = retainedVerification(db, initial.id)
            if (
              !current ||
              current.generation !== initial.generation ||
              ![
                "pending",
                "task-checks",
                "combined-checks",
                "waiting-human",
                "waiting-human-combined",
              ].includes(current.state)
            )
              return undefined
            const saved = setRetainedVerificationWorkspace(db, current, phase, actual, "owned")
            this.store.record(
              current.planID,
              current.taskID,
              "RETAINED_VERIFICATION_WORKSPACE_OWNED",
              {
                operationID: current.id,
                generation: current.generation,
                phase,
                workspace: actual,
                artifact,
                recovered: fieldState === "reserved" || fieldState === "uncertain",
              },
            )
            return saved
          })
          return updated ? actual : undefined
        }
      } catch (error) {
        await this.holdRetainedVerification(
          initial,
          `Retained ${phase} verification checkout ownership or candidate is uncertain: ${errorText(error)}`,
          fence,
        )
        return undefined
      }
      await this.holdRetainedVerification(
        initial,
        `Retained ${phase} verification checkout exists but its canonical owner or candidate identity is not proven${mismatches.length ? ` (${mismatches.join(", ")})` : ""}`,
        fence,
      )
      return undefined
    }
    const unregisteredPath = candidates.find((candidate) => existsSync(candidate))
    if (unregisteredPath) {
      await this.holdRetainedVerification(
        initial,
        `Retained ${phase} verification checkout path exists without native worktree ownership; preserve ${unregisteredPath}`,
        fence,
      )
      return undefined
    }
    if (fieldState !== null) {
      await this.holdRetainedVerification(
        initial,
        `Retained ${phase} verification checkout creation outcome is uncertain; it will not be replayed`,
        fence,
      )
      return undefined
    }
    const reserved = this.store.fenced(this.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      if (
        !current ||
        current.generation !== initial.generation ||
        ![
          "pending",
          "task-checks",
          "combined-checks",
          "waiting-human",
          "waiting-human-combined",
        ].includes(current.state)
      )
        return undefined
      const saved = setRetainedVerificationWorkspace(db, current, phase, workspace, "reserved")
      this.store.record(
        current.planID,
        current.taskID,
        "RETAINED_VERIFICATION_WORKSPACE_RESERVED",
        {
          operationID: current.id,
          generation: current.generation,
          phase,
          workspace,
          artifact,
        },
      )
      return saved
    })
    if (!reserved || !this.retainedVerificationLive(initial.id, initial.generation))
      return undefined
    let returnedWorkspace: string | undefined
    try {
      mkdirSync(dirname(workspace), { recursive: true, mode: 0o700 })
      returnedWorkspace = await this.host.worktree({ directory: workspace, base: artifact })
      const actual = realpathSync(returnedWorkspace)
      const canonical = realpathSync(actual)
      const currentNative = await this.host.worktrees()
      if (
        !currentNative.some((item) => samePhysicalWorkspace(item, canonical)) ||
        realpathSync(dirname(canonical)) !== realpathSync(dirname(workspace)) ||
        samePhysicalWorkspace(canonical, initial.originalWorkspace) ||
        samePhysicalWorkspace(canonical, this.directory) ||
        realpathSync(git(canonical, ["rev-parse", "--show-toplevel"])) !== canonical ||
        git(canonical, ["rev-parse", "HEAD"]) !== artifact ||
        (await gitAsync(canonical, ["status", "--porcelain", "--untracked-files=all"])) ||
        git(canonical, ["ls-files", "-u", "-z"])
      )
        throw new Error(
          "Native worktree is not a distinct clean canonical checkout of the exact candidate",
        )
      if (!this.retainedVerificationLive(initial.id, initial.generation)) {
        await this.holdRetainedVerification(
          initial,
          "Retained verification authority changed during checkout creation",
          fence,
        )
        return undefined
      }
      this.store.fenced(this.owner, fence, (db) => {
        const current = retainedVerification(db, initial.id)
        if (
          !current ||
          current.generation !== initial.generation ||
          ![
            "pending",
            "task-checks",
            "combined-checks",
            "waiting-human",
            "waiting-human-combined",
          ].includes(current.state)
        )
          return
        setRetainedVerificationWorkspace(db, current, phase, canonical, "owned")
        this.store.record(current.planID, current.taskID, "RETAINED_VERIFICATION_WORKSPACE_OWNED", {
          operationID: current.id,
          generation: current.generation,
          phase,
          workspace: canonical,
          artifact,
          recovered: false,
        })
      })
      return this.retainedVerificationLive(initial.id, initial.generation) ? canonical : undefined
    } catch (error) {
      this.store.fenced(this.owner, fence, (db) => {
        const current = retainedVerification(db, initial.id)
        if (!current || current.generation !== initial.generation) return
        setRetainedVerificationWorkspace(
          db,
          current,
          phase,
          returnedWorkspace ?? workspace,
          "uncertain",
        )
      })
      await this.holdRetainedVerification(
        initial,
        `Retained ${phase} verification checkout creation is uncertain: ${errorText(error)}`,
        fence,
      )
      return undefined
    }
  }

  private retainedVerificationCheckReceipt(
    raw: unknown,
    operation: RetainedVerification,
    phase: "task" | "combined",
    check: TaskProposal["verification"][number],
    workspace: string,
    artifact: string,
    _environmentIdentity: string,
  ): CheckReceipt | undefined {
    if (!isRecord(raw) || !isRecord(raw.isolation)) return undefined
    const receipt = raw as unknown as CheckReceipt
    const witness = raw.isolation
    if (
      receipt.id !== check.id ||
      receipt.command !== check.command ||
      receipt.cwd !== workspace ||
      receipt.artifact !== artifact ||
      receipt.inputIdentity !== artifact ||
      witness.schemaVersion !== 1 ||
      witness.operationID !== operation.id ||
      witness.generation !== operation.generation ||
      witness.phase !== phase ||
      witness.checkID !== check.id ||
      witness.originalWorkspace !== operation.originalWorkspace ||
      witness.candidateWorkspace !== workspace ||
      witness.taskDatabase !== realpathSync(this.store.repository.path)
    )
      return undefined
    return receipt
  }

  private completeRetainedCheck(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    receipt: CheckReceipt,
  ): boolean {
    return this.store.atomic((db) => {
      if (!completeRetainedVerificationCheck(db, operation.id, phase, checkID, receipt))
        return false
      // Persist the result and event together. Receipt recovery, normal ticks,
      // stop and cancellation may all observe the same final subprocess result.
      this.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_CHECK_COMPLETED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          checkID,
          artifact: receipt.artifact,
          workspace: receipt.cwd,
          environmentIdentity: receipt.environmentIdentity,
          exitCode: receipt.exitCode,
          timedOut: receipt.timedOut,
          passed: checkSucceeded(receipt),
          processCleanup: receipt.processCleanup,
          cancelled: operation.state === "cancelled",
        },
      )
      return true
    })
  }

  private async runRetainedVerificationChecks(
    initial: RetainedVerification,
    phase: "task" | "combined",
    checks: TaskProposal["verification"],
    workspace: string,
    artifact: string,
    fence: number,
    parentSignal?: AbortSignal,
  ): Promise<CheckReceipt[] | undefined> {
    const results: CheckReceipt[] = []
    for (const check of checks) {
      if (parentSignal?.aborted || !this.retainedVerificationLive(initial.id, initial.generation))
        return undefined
      const plan = this.store.plan(initial.planID)
      if (!plan || plan.revision !== initial.planRevision)
        throw new Error("Retained verification plan revision changed")
      const target: VerificationTimeoutTarget = {
        ...this.verificationTarget(
          plan,
          phase,
          check,
          artifact,
          phase === "task" ? initial.taskID : null,
          phase === "task" ? initial.taskRevision : null,
          phase === "task" ? initial.attemptID : null,
        ),
        retainedVerificationID: initial.id,
        retainedGeneration: initial.generation,
        retainedTaskID: initial.taskID,
        retainedTaskRevision: initial.taskRevision,
        retainedAttemptID: initial.attemptID,
      }
      const deadline = this.verificationDeadline(target)
      const effectiveCheck = effectiveVerificationCheck(check, deadline)
      const procedure = retainedProcedurePlan(check.command)
      if (procedure.status !== "supported") {
        await this.holdRetainedVerification(
          initial,
          `Verification ${check.id} ${procedure.reason}; required resources are not bound to the retained context`,
          fence,
        )
        return undefined
      }
      const existing = this.store.atomic((db) =>
        retainedVerificationChecks(db, initial.id, phase).find((row) => row.checkID === check.id),
      )
      const activityID = `retained:${initial.id}:${initial.generation}:${phase}:${check.id}`
      if (existing?.state === "retry-authorized") {
        let previousCheck: unknown
        let previousReceipt: unknown
        try {
          previousCheck = JSON.parse(existing.checkJSON) as unknown
          previousReceipt = existing.receipt ? (JSON.parse(existing.receipt) as unknown) : undefined
        } catch {
          previousCheck = undefined
          previousReceipt = undefined
        }
        const authorization = this.store.latestTransition<{
          requestID?: unknown
          owner?: unknown
          ownerEpoch?: unknown
          planRevision?: unknown
          operationID?: unknown
          generation?: unknown
          taskID?: unknown
          taskRevision?: unknown
          attemptID?: unknown
          phase?: unknown
          checkID?: unknown
          candidateArtifact?: unknown
          commandFingerprint?: unknown
          amendmentID?: unknown
          priorReceiptFingerprint?: unknown
          priorCheckFingerprint?: unknown
          reason?: unknown
        }>(initial.planID, initial.taskID, "RETAINED_VERIFICATION_CHECK_RETRY_AUTHORIZED")
        const retryResources = this.store.atomic((db) =>
          db
            .query<{ state: string }, [string, string, string]>(
              `SELECT state FROM runner_retained_verification_resources
               WHERE operation_id=? AND phase=? AND check_id=?`,
            )
            .all(initial.id, phase, check.id),
        )
        const previousBoundReceipt =
          isRecord(previousCheck) && previousReceipt
            ? this.retainedVerificationCheckReceipt(
                previousReceipt,
                initial,
                phase,
                previousCheck as TaskProposal["verification"][number],
                workspace,
                artifact,
                existing.environmentIdentity,
              )
            : undefined
        if (
          !deadline.amendmentID ||
          existing.cleanupState !== "complete" ||
          existing.artifact !== artifact ||
          existing.workspace !== workspace ||
          !isRecord(previousCheck) ||
          previousCheck.id !== check.id ||
          previousCheck.command !== check.command ||
          !previousBoundReceipt?.timedOut ||
          !checkResourcesSettled(previousBoundReceipt) ||
          authorization?.owner !== initial.owner ||
          authorization.ownerEpoch !== initial.ownerEpoch ||
          authorization.planRevision !== initial.planRevision ||
          authorization?.operationID !== initial.id ||
          authorization.generation !== initial.generation ||
          authorization.taskID !== initial.taskID ||
          authorization.taskRevision !== initial.taskRevision ||
          authorization.attemptID !== initial.attemptID ||
          authorization.phase !== phase ||
          authorization.checkID !== check.id ||
          authorization.candidateArtifact !== artifact ||
          authorization.commandFingerprint !== verificationCommandFingerprint(check.command) ||
          authorization.amendmentID !== deadline.amendmentID ||
          authorization.priorReceiptFingerprint !== fingerprint(existing.receipt) ||
          authorization.priorCheckFingerprint !== fingerprint(existing.checkJSON) ||
          retryResources.length === 0 ||
          retryResources.some((resource) => resource.state !== "removed")
        ) {
          await this.holdRetainedVerification(
            initial,
            `Explicit retained timing continuation ${phase}:${check.id} lost its settled retry binding`,
            fence,
          )
          return undefined
        }
      }
      if (existing && existing.state !== "retry-authorized") {
        const activityIdentity = {
          operationID: initial.id,
          generation: initial.generation,
          phase,
          checkID: check.id,
          inputFingerprint: existing.inputFingerprint,
          workspace: existing.workspace,
          artifact: existing.artifact,
          contextPath: existing.contextPath,
        }
        let savedReceipt: unknown
        try {
          if (existing.receipt) savedReceipt = JSON.parse(existing.receipt) as unknown
          else if (existsSync(existing.receiptPath))
            savedReceipt = JSON.parse(readFileSync(existing.receiptPath, "utf8")) as unknown
        } catch {
          savedReceipt = undefined
        }
        if (
          existing.artifact !== artifact ||
          existing.workspace !== workspace ||
          !sameVerificationCheckIdentity(JSON.parse(existing.checkJSON), effectiveCheck)
        ) {
          await this.holdRetainedVerification(
            initial,
            `Retained check ${phase}:${check.id} no longer matches its recorded command or workspace`,
            fence,
          )
          return undefined
        }
        if (existing.state === "completed" && existing.receipt) {
          const receipt = this.retainedVerificationCheckReceipt(
            JSON.parse(existing.receipt),
            initial,
            phase,
            effectiveCheck,
            workspace,
            artifact,
            existing.environmentIdentity,
          )
          if (receipt) {
            results.push(receipt)
            forgetVerificationActivity(
              verificationActivityKey(this.store.repository.path, activityID),
              fingerprint(activityIdentity),
            )
            this.retainedVerificationAborts.delete(initial.id)
            if (!checkResourcesSettled(receipt)) {
              this.store.atomic((db) =>
                settleRetainedVerificationResources(
                  db,
                  initial.id,
                  phase,
                  check.id,
                  "uncertain",
                  this.now(),
                ),
              )
              await this.holdRetainedVerification(
                initial,
                `Retained verification ${phase}:${check.id} completed with exit ${receipt.exitCode ?? "unknown"} and timedOut=${receipt.timedOut}, but subprocess cleanup is uncertain: ${receipt.processCleanup?.detail ?? "termination was not confirmed"}`,
                fence,
              )
              return undefined
            }
            if (existing.cleanupState !== "complete")
              await this.cleanupRetainedCheckResources(
                initial,
                phase,
                check.id,
                existing.contextPath,
                receipt.isolation,
                fence,
              )
            continue
          }
          await this.holdRetainedVerification(
            initial,
            `Retained verification receipt ${phase}:${check.id} is not operation-bound`,
            fence,
          )
          return undefined
        }
        if (existing.state === "intended" && existsSync(existing.receiptPath)) {
          let recovered: CheckReceipt | undefined
          try {
            const onDisk = savedReceipt
            if (
              observeRetainedCheckIsolationWitness(
                existing.contextPath,
                isRecord(onDisk) ? onDisk.isolation : undefined,
                {
                  operationID: initial.id,
                  generation: initial.generation,
                  phase,
                  checkID: check.id,
                  originalWorkspace: initial.originalWorkspace,
                  candidateWorkspace: workspace,
                  taskDatabase: this.store.repository.path,
                  projectDirectory: this.directory,
                  candidateArtifact: artifact,
                  projectIdentity: retainedProjectIdentity(this.directory, workspace, artifact),
                  procedurePlan: procedure.plan,
                },
              )
            )
              recovered = this.retainedVerificationCheckReceipt(
                onDisk,
                initial,
                phase,
                effectiveCheck,
                workspace,
                artifact,
                existing.environmentIdentity,
              )
          } catch {
            recovered = undefined
          }
          if (recovered) {
            const saved = this.store.atomic((db) => {
              const current = retainedVerification(db, initial.id)
              if (
                !current ||
                current.generation !== initial.generation ||
                ![
                  "pending",
                  "task-checks",
                  "combined-checks",
                  "waiting-human",
                  "waiting-human-combined",
                ].includes(current.state)
              )
                return false
              return this.completeRetainedCheck(current, phase, check.id, recovered)
            })
            if (!saved) return undefined
            results.push(recovered)
            forgetVerificationActivity(
              verificationActivityKey(this.store.repository.path, activityID),
              fingerprint(activityIdentity),
            )
            this.retainedVerificationAborts.delete(initial.id)
            if (!checkResourcesSettled(recovered)) {
              this.store.atomic((db) =>
                settleRetainedVerificationResources(
                  db,
                  initial.id,
                  phase,
                  check.id,
                  "uncertain",
                  this.now(),
                ),
              )
              await this.holdRetainedVerification(
                initial,
                `Retained verification ${phase}:${check.id} completed with exit ${recovered.exitCode ?? "unknown"} and timedOut=${recovered.timedOut}, but subprocess cleanup is uncertain: ${recovered.processCleanup?.detail ?? "termination was not confirmed"}`,
                fence,
              )
              return undefined
            }
            await this.cleanupRetainedCheckResources(
              initial,
              phase,
              check.id,
              existing.contextPath,
              recovered.isolation,
              fence,
            )
            continue
          }
        }
        const activity = this.checkActivity(activityID, activityIdentity)
        if (activity?.state === "running") return undefined
        this.store.atomic((db) =>
          markRetainedVerificationCheckUncertain(
            db,
            initial.id,
            phase,
            check.id,
            "A retained check intent has no conclusive isolated receipt; it will not be replayed",
          ),
        )
        await this.holdRetainedVerification(
          initial,
          activity?.state === "failed"
            ? `Retained verification check ${phase}:${check.id} is uncertain: ${errorText(activity.error)}`
            : `Retained verification check ${phase}:${check.id} is uncertain and was not replayed`,
          fence,
        )
        forgetVerificationActivity(
          verificationActivityKey(this.store.repository.path, activityID),
          fingerprint(activityIdentity),
        )
        return undefined
      }

      if (
        await this.reconcileInterruptedRetainedCheckSetup(initial, phase, check, workspace, fence)
      )
        return undefined

      const prior = this.store.atomic((db) => {
        const active = db
          .query<{ canonical_path: string }, [string]>(
            `SELECT canonical_path FROM runner_retained_verification_resources
             WHERE project_directory=? AND state IN ('creating','active','uncertain')`,
          )
          .all(this.directory)
        const legacy = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='owned_resources'",
          )
          .get()
        if (legacy) {
          const outstanding = db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM owned_resources WHERE project_directory=? AND json_extract(payload,'$.state') NOT IN ('removed')",
            )
            .get(this.directory)?.count
          if (outstanding)
            throw new Error(
              "An existing owned external resource has no canonical path witness; retained verification cannot prove non-overlap",
            )
        }
        return active.map((row) => row.canonical_path)
      })
      const controller = new AbortController()
      const runSignal = parentSignal
        ? AbortSignal.any([controller.signal, parentSignal])
        : controller.signal
      this.retainedVerificationAborts.set(initial.id, controller)
      const rootDirectory = join(this.dataDirectory, "retained-verification-resources")
      let setupResource: RetainedCheckSetupResource | undefined
      let setupDependencyLink: RetainedCheckSetupLink | undefined
      let setupTemporaryDirectoryLink: RetainedCheckSetupLink | undefined
      let context: Awaited<ReturnType<typeof createRetainedCheckContext>>
      try {
        mkdirSync(rootDirectory, { recursive: true, mode: 0o700 })
        context = await createRetainedCheckContext({
          rootDirectory,
          operationID: initial.id,
          generation: initial.generation,
          phase,
          checkID: check.id,
          originalWorkspace: initial.originalWorkspace,
          candidateWorkspace: workspace,
          taskDatabase: this.store.repository.path,
          projectDirectory: this.directory,
          candidateArtifact: artifact,
          priorResourcePaths: prior,
          procedurePlan: procedure.plan,
          signal: runSignal,
          dependencyInstaller: this.retainedDependencyInstaller,
          onSetupPathReserved: (path) => {
            setupResource = { path, realPath: path, device: -1, inode: -1 }
            this.store.atomic((db) =>
              registerRetainedVerificationResources(db, this.directory, {
                operationID: initial.id,
                generation: initial.generation,
                phase,
                checkID: check.id,
                resources: [{ name: "setup-root", realPath: path, device: -1, inode: -1 }],
                state: "creating",
                now: this.now(),
              }),
            )
          },
          onSetupPathCreated: (resource) => {
            setupResource = resource
            const updated = this.store.atomic((db) =>
              updateRetainedVerificationResourceIdentity(db, {
                operationID: initial.id,
                phase,
                checkID: check.id,
                resourceName: "setup-root",
                realPath: resource.realPath,
                device: resource.device,
                inode: resource.inode,
                now: this.now(),
              }),
            )
            if (!updated)
              throw new Error("Retained verification setup-root ownership reservation changed")
          },
          onResourcesCreated: (resources) =>
            this.store.atomic((db) =>
              registerRetainedVerificationResources(db, this.directory, {
                operationID: initial.id,
                generation: initial.generation,
                phase,
                checkID: check.id,
                resources,
                state: "creating",
                now: this.now(),
              }),
            ),
          onDependencyLinkReserved: (link) => {
            setupDependencyLink = link
            this.store.atomic((db) =>
              registerRetainedVerificationResources(db, this.directory, {
                operationID: initial.id,
                generation: initial.generation,
                phase,
                checkID: check.id,
                resources: [
                  { name: "dependency-link", realPath: link.path, device: -1, inode: -1 },
                ],
                state: "creating",
                now: this.now(),
              }),
            )
          },
          onDependencyLink: (link) => {
            setupDependencyLink = link
            const updated = this.store.atomic((db) =>
              updateRetainedVerificationResourceIdentity(db, {
                operationID: initial.id,
                phase,
                checkID: check.id,
                resourceName: "dependency-link",
                realPath: link.path,
                device: link.device,
                inode: link.inode,
                now: this.now(),
              }),
            )
            if (!updated)
              throw new Error("Retained verification dependency-link ownership reservation changed")
          },
          onTemporaryDirectoryLinkReserved: (link) => {
            setupTemporaryDirectoryLink = link
            this.store.atomic((db) =>
              registerRetainedVerificationResources(db, this.directory, {
                operationID: initial.id,
                generation: initial.generation,
                phase,
                checkID: check.id,
                resources: [
                  {
                    name: "tmp-alias",
                    realPath: link.path,
                    device: -1,
                    inode: -1,
                  },
                ],
                state: "creating",
                now: this.now(),
              }),
            )
          },
          onTemporaryDirectoryLink: (link) => {
            setupTemporaryDirectoryLink = link
            const updated = this.store.atomic((db) =>
              updateRetainedVerificationResourceIdentity(db, {
                operationID: initial.id,
                phase,
                checkID: check.id,
                resourceName: "tmp-alias",
                realPath: link.path,
                device: link.device,
                inode: link.inode,
                now: this.now(),
              }),
            )
            if (!updated)
              throw new Error("Retained verification temporary-link ownership reservation changed")
          },
        })
        if (!observeRetainedCheckContext(context))
          throw new Error("Fresh verification resources do not have a readable ownership witness")
        this.store.atomic((db) =>
          activateRetainedVerificationResources(db, initial.id, phase, check.id, this.now()),
        )
      } catch (error) {
        const cleaned =
          error instanceof RetainedSetupProcessTreeUncertainError
            ? this.markRetainedCheckSetupUncertain(initial, phase, check.id, errorText(error))
            : this.cleanupRetainedCheckSetup(
                initial,
                phase,
                check.id,
                rootDirectory,
                workspace,
                setupResource,
                setupDependencyLink,
                setupTemporaryDirectoryLink,
              )
        this.retainedVerificationAborts.delete(initial.id)
        if (runSignal.aborted || !this.retainedVerificationLive(initial.id, initial.generation))
          return undefined
        await this.holdRetainedVerification(
          initial,
          cleaned
            ? errorText(error)
            : `${errorText(error)}; partial setup cleanup could not be proven and remains uncertain`,
          fence,
        )
        return undefined
      }
      const retryReceiptSuffix =
        existing?.state === "retry-authorized" ? `-amendment-${deadline.amendmentID}` : ""
      const receiptPath = join(
        this.dataDirectory,
        "receipts",
        "retained-verification",
        initial.id,
        `${initial.generation}-${phase}-${check.id}${retryReceiptSuffix}.json`,
      )
      const inputFingerprint = fingerprint({
        operationID: initial.id,
        generation: initial.generation,
        operationInputFingerprint: this.retainedVerificationInputFingerprint(initial, phase),
        phase,
        check: effectiveCheck,
        authoredCheck: check,
        verificationDeadline: verificationReceiptDeadline(deadline),
        workspace,
        artifact,
        contextIdentity: context.identity,
        environmentIdentity: context.environmentIdentity,
      })
      let checkRow: ReturnType<typeof beginRetainedVerificationCheck>
      try {
        checkRow = this.store.atomic((db) =>
          beginRetainedVerificationCheck(db, {
            operationID: initial.id,
            phase,
            checkID: check.id,
            check: effectiveCheck,
            workspace,
            artifact,
            inputFingerprint,
            environmentIdentity: context.environmentIdentity,
            receiptPath,
            contextPath: context.directory,
            createdAt: this.now(),
          }),
        )
      } catch (error) {
        try {
          removeRetainedCheckContext(context)
          this.store.atomic((db) =>
            settleRetainedVerificationResources(
              db,
              initial.id,
              phase,
              check.id,
              "removed",
              this.now(),
            ),
          )
        } catch {
          this.store.atomic((db) =>
            settleRetainedVerificationResources(
              db,
              initial.id,
              phase,
              check.id,
              "uncertain",
              this.now(),
            ),
          )
        }
        this.retainedVerificationAborts.delete(initial.id)
        await this.holdRetainedVerification(initial, errorText(error), fence)
        return undefined
      }
      if (!this.retainedVerificationLive(initial.id, initial.generation)) {
        await this.cleanupRetainedCheckResources(
          initial,
          phase,
          check.id,
          context.directory,
          retainedCheckIsolationWitness(context),
          fence,
        )
        this.retainedVerificationAborts.delete(initial.id)
        return undefined
      }
      try {
        const activityIdentity = {
          operationID: initial.id,
          generation: initial.generation,
          phase,
          checkID: check.id,
          inputFingerprint: checkRow.inputFingerprint,
          workspace: checkRow.workspace,
          artifact: checkRow.artifact,
          contextPath: checkRow.contextPath,
        }
        this.startCheckActivity({
          id: activityID,
          identity: activityIdentity,
          signal: runSignal,
          metadata: {
            kind: "retained",
            projectDirectory: this.directory,
            planID: initial.planID,
            taskID: initial.taskID,
            attemptID: initial.attemptID,
            operationID: initial.id,
            generation: initial.generation,
            phase,
            checkID: check.id,
            workspace,
            artifact,
            contextPath: context.directory,
            isolation: retainedCheckIsolationWitness(context),
          },
          run: (signal) =>
            this.runVerificationCheck(workspace, artifact, check, deadline, receiptPath, {
              environment: context.environment,
              environmentIdentity: context.environmentIdentity,
              ownedUntrackedPaths: context.dependencyLink ? ["node_modules"] : [],
              isolation: retainedCheckIsolationWitness(context),
              signal,
            }),
        })
        return undefined
      } catch (error) {
        this.store.atomic((db) =>
          markRetainedVerificationCheckUncertain(db, initial.id, phase, check.id, errorText(error)),
        )
        await this.cleanupRetainedCheckResources(
          initial,
          phase,
          check.id,
          context.directory,
          retainedCheckIsolationWitness(context),
          fence,
        )
        await this.holdRetainedVerification(
          initial,
          `Retained verification check ${phase}:${check.id} is uncertain: ${errorText(error)}`,
          fence,
        )
        return undefined
      }
    }
    return results
  }

  private async cleanupRetainedCheckResources(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    contextPath: string,
    witness: unknown,
    fence: number,
  ): Promise<void> {
    try {
      const stored = this.store.atomic((db) =>
        retainedVerificationChecks(db, operation.id, phase).find(
          (check) => check.checkID === checkID,
        ),
      )
      if (!stored)
        throw new Error("Retained check resource ownership has no durable procedure record")
      const check = JSON.parse(stored.checkJSON) as TaskProposal["verification"][number]
      const procedure = retainedProcedurePlan(check.command)
      if (procedure.status !== "supported")
        throw new Error("Retained check procedure binding is no longer supported")
      const expected = {
        operationID: operation.id,
        generation: operation.generation,
        phase,
        checkID,
        originalWorkspace: operation.originalWorkspace,
        candidateWorkspace: this.retainedVerificationIsolatedWorkspace(operation, phase) ?? "",
        taskDatabase: this.store.repository.path,
        projectDirectory: this.directory,
        candidateArtifact: stored.artifact,
        projectIdentity: retainedProjectIdentity(
          this.directory,
          this.retainedVerificationIsolatedWorkspace(operation, phase) ?? "",
          stored.artifact,
        ),
        procedurePlan: procedure.plan,
      }
      removeRetainedCheckContextFromWitness(contextPath, witness, expected)
      this.store.atomic((db) => {
        setRetainedVerificationCheckCleanup(db, operation.id, phase, checkID, "complete")
        settleRetainedVerificationResources(db, operation.id, phase, checkID, "removed", this.now())
      })
      this.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_CONTEXT_CLEANED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          checkID,
          contextPath,
          cleanupState: "complete",
        },
      )
    } catch (error) {
      this.store.atomic((db) => {
        setRetainedVerificationCheckCleanup(db, operation.id, phase, checkID, "failed")
        settleRetainedVerificationResources(
          db,
          operation.id,
          phase,
          checkID,
          "uncertain",
          this.now(),
        )
      })
      this.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_CONTEXT_CLEANUP_FAILED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          checkID,
          contextPath,
          cleanupState: "failed",
          reason: errorText(error),
          forcedDeletion: false,
        },
      )
      void fence
    }
  }

  private markRetainedCheckSetupUncertain(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    reason: string,
  ): false {
    this.store.atomic((db) =>
      settleRetainedVerificationResources(
        db,
        operation.id,
        phase,
        checkID,
        "uncertain",
        this.now(),
      ),
    )
    this.store.record(
      operation.planID,
      operation.taskID,
      "RETAINED_VERIFICATION_SETUP_CLEANUP_FAILED",
      {
        operationID: operation.id,
        generation: operation.generation,
        phase,
        checkID,
        reason,
        cleanupState: "failed",
        forcedDeletion: false,
      },
    )
    return false
  }

  private cleanupRetainedCheckSetup(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    rootDirectory: string,
    candidateWorkspace: string,
    resource: RetainedCheckSetupResource | undefined,
    dependencyLink: RetainedCheckSetupLink | undefined,
    temporaryDirectoryLink: RetainedCheckSetupLink | undefined,
  ): boolean {
    try {
      const persisted = this.store.atomic((db) =>
        db
          .query<
            {
              resource_name: string
              canonical_path: string
              device: number
              inode: number
              state: string
            },
            [string, string, string]
          >(
            `SELECT resource_name,canonical_path,device,inode,state
             FROM runner_retained_verification_resources
             WHERE operation_id=? AND phase=? AND check_id=? ORDER BY resource_name`,
          )
          .all(operation.id, phase, checkID),
      )
      const expectedSetupPath = join(
        realpathSync(rootDirectory),
        `retained-${operation.id}-${operation.generation}-${phase}-${checkID}`,
      )
      const root = persisted.find((item) => item.resource_name === "setup-root")
      resource ??= root
        ? {
            path: root.canonical_path,
            realPath: root.canonical_path,
            device: root.device,
            inode: root.inode,
          }
        : undefined
      if (!resource) {
        if (persisted.length || pathEntryExists(expectedSetupPath))
          throw new Error("Partial verification setup has no durable setup-root ownership witness")
        return true
      }
      if (resource.path !== expectedSetupPath)
        throw new Error("Verification setup path does not match its reserved operation identity")
      const persistedDependencyLink = persisted.find(
        (item) => item.resource_name === "dependency-link",
      )
      dependencyLink ??= persistedDependencyLink
        ? {
            path: persistedDependencyLink.canonical_path,
            target: join(resource.path, "dependencies"),
            device: persistedDependencyLink.device,
            inode: persistedDependencyLink.inode,
          }
        : undefined
      const persistedTemporaryLink = persisted.find((item) => item.resource_name === "tmp-alias")
      temporaryDirectoryLink ??= persistedTemporaryLink
        ? {
            path: persistedTemporaryLink.canonical_path,
            target: join(resource.path, "tmp"),
            device: persistedTemporaryLink.device,
            inode: persistedTemporaryLink.inode,
          }
        : undefined
      if (!temporaryDirectoryLink) {
        const aliasPath = retainedTemporaryDirectoryAliasPath({
          operationID: operation.id,
          generation: operation.generation,
          phase,
          checkID,
        })
        if (aliasPath && pathEntryExists(aliasPath))
          temporaryDirectoryLink = {
            path: aliasPath,
            target: join(resource.path, "tmp"),
            device: -1,
            inode: -1,
          }
      }
      removeRetainedCheckSetupResources({
        rootDirectory,
        resource,
        candidateWorkspace,
        ...(dependencyLink ? { dependencyLink } : {}),
        ...(temporaryDirectoryLink ? { temporaryDirectoryLink } : {}),
      })
      this.store.atomic((db) =>
        settleRetainedVerificationResources(
          db,
          operation.id,
          phase,
          checkID,
          "removed",
          this.now(),
        ),
      )
      this.store.record(operation.planID, operation.taskID, "RETAINED_VERIFICATION_SETUP_CLEANED", {
        operationID: operation.id,
        generation: operation.generation,
        phase,
        checkID,
        contextPath: resource.path,
        cleanupState: "complete",
      })
      return true
    } catch (error) {
      this.store.atomic((db) =>
        settleRetainedVerificationResources(
          db,
          operation.id,
          phase,
          checkID,
          "uncertain",
          this.now(),
        ),
      )
      this.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_SETUP_CLEANUP_FAILED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          checkID,
          contextPath: resource?.path ?? null,
          reason: errorText(error),
          cleanupState: "failed",
          forcedDeletion: false,
        },
      )
      return false
    }
  }

  private retainedEvidenceMissing(
    operation: RetainedVerification,
    phase: "task" | "combined",
    assertions: TaskProposal["acceptance"],
    workspace: string,
    artifact: string,
    receipts: CheckReceipt[],
  ): string[] {
    const missing: string[] = []
    const probes = new ProbeRepository(this.store.repository)
    const resources = new ResourceRepository(this.store.repository)
    const target =
      phase === "task"
        ? ({ kind: "task", taskID: operation.taskID } as const)
        : ({ kind: "combined-candidate", planID: operation.planID } as const)
    const probeDefinition = probes.definitionForTarget(target)
    const probeRuns = probeDefinition ? probes.runsForAttempt(operation.attemptID) : []
    const basis = retainedVerificationProbeBasis(operation, phase)
    const currentInputs = basis.inputs
    const currentEnvironment = basis.environment
    for (const assertion of assertions) {
      for (const evidence of assertion.evidence) {
        if (
          evidence.kind === "verification" &&
          !receipts.some(
            (receipt) =>
              receipt.id === evidence.verificationID &&
              receipt.artifact === artifact &&
              receipt.inputIdentity === artifact &&
              receipt.exitCode === 0 &&
              !receipt.timedOut,
          )
        )
          missing.push(`${assertion.id}:verification`)
        if (evidence.kind === "artifact" && !artifactExists(workspace, evidence.reference))
          missing.push(`${assertion.id}:${evidence.reference}`)
        if (
          evidence.kind === "human" &&
          !this.store.atomic((db) =>
            hasRetainedVerificationEvidence(db, {
              operationID: operation.id,
              generation: operation.generation,
              phase,
              taskID: phase === "task" ? operation.taskID : null,
              assertionID: assertion.id,
              artifact,
            }),
          )
        )
          missing.push(`${assertion.id}:human`)
      }
      const scenarios =
        probeDefinition?.scenarios.filter((scenario) =>
          scenario.acceptanceIDs.includes(assertion.id),
        ) ?? []
      for (const scenario of scenarios) {
        const passed = probeRuns.some((run) => {
          if (
            run.attemptID !== operation.attemptID ||
            run.sessionID !== operation.originalSessionID ||
            run.producer.sessionID !== operation.owner ||
            run.producer.agent !== "architect" ||
            fingerprint(run.target) !== fingerprint(target) ||
            run.definitionID !== probeDefinition!.definitionID ||
            run.definitionRevision !== probeDefinition!.revision ||
            run.scenarioID !== scenario.id ||
            run.candidate.revision !== artifact ||
            run.candidate.workspace !== workspace ||
            fingerprint(run.procedure) !== fingerprint(scenario.procedure) ||
            fingerprint(run.inputs) !== fingerprint(currentInputs) ||
            fingerprint(run.environment) !== fingerprint(currentEnvironment)
          )
            return false
          try {
            const ownership = resources.resourcesForRun(run.runID)
            const execution = resources.execution(run.runID)
            if (
              ownership.length === 0 ||
              execution?.phase !== "finished" ||
              !this.retainedProbeResourcesAreIsolated(operation, workspace, ownership) ||
              ownership.some(
                (resource) =>
                  resource.runID !== run.runID ||
                  resource.owner.projectDirectory !== operation.projectDirectory ||
                  resource.owner.planID !== operation.planID ||
                  resource.owner.taskID !== operation.taskID ||
                  resource.owner.attemptID !== operation.attemptID ||
                  resource.owner.sessionID !== operation.originalSessionID ||
                  fingerprint(resource.owner.producer) !== fingerprint(run.producer) ||
                  fingerprint(resource.owner.candidate) !== fingerprint(run.candidate) ||
                  fingerprint(resource.owner.environment) !== fingerprint(run.environment),
              )
            )
              return false
            const eligibility = probes.eligibility(run.runID, {
              candidate: { revision: artifact, workspace },
              procedure: scenario.procedure,
              inputs: currentInputs,
              environment: currentEnvironment,
            })
            return eligibility.eligible && eligibility.satisfied
          } catch {
            return false
          }
        })
        if (!passed) missing.push(`${assertion.id}:probe:${scenario.id}`)
      }
    }
    return missing
  }

  private async removeRetainedVerificationWorkspace(
    operation: RetainedVerification,
    phase: "task" | "combined",
    fence: number,
  ): Promise<"complete" | "failed" | "pending"> {
    const workspace = this.retainedVerificationIsolatedWorkspace(operation, phase)
    const state = phase === "task" ? operation.taskWorkspaceState : operation.combinedWorkspaceState
    if (!workspace) return "complete"
    if (!state) return "pending"
    const artifact = phase === "task" ? operation.artifact : operation.combinedArtifact
    if (!artifact) return "pending"
    let recordedWorkspace = workspace
    try {
      const checks = this.store.atomic((db) => retainedVerificationChecks(db, operation.id, phase))
      for (const check of checks) {
        if (check.state !== "completed" || !check.receipt)
          throw new Error("Retained check activity is not conclusively complete")
        const receipt = JSON.parse(check.receipt) as CheckReceipt
        if (!checkResourcesSettled(receipt))
          throw new Error("Retained check process cleanup remains uncertain")
        if (check.cleanupState !== "complete") {
          const resourcesCleaned = this.cleanupRetainedCheckSetup(
            operation,
            phase,
            check.checkID,
            this.dataDirectory,
            workspace,
            undefined,
            undefined,
            undefined,
          )
          if (resourcesCleaned)
            await this.cleanupRetainedCheckResources(
              operation,
              phase,
              check.checkID,
              check.contextPath,
              receipt.isolation,
              fence,
            )
        }
      }
      const remainingResources = this.store.atomic((db) =>
        db
          .query<{ state: string }, [string, string]>(
            "SELECT state FROM runner_retained_verification_resources WHERE operation_id=? AND phase=?",
          )
          .all(operation.id, phase)
          .some((resource) => resource.state !== "removed"),
      )
      const checkCleanupPending = this.store.atomic((db) =>
        retainedVerificationChecks(db, operation.id, phase).some(
          (check) => check.cleanupState !== "complete",
        ),
      )
      if (remainingResources || checkCleanupPending)
        throw new Error("Retained verification check resources remain unsettled")

      const candidates =
        state === "reserved" || state === "uncertain"
          ? startupWorktreeCandidates(workspace)
          : [workspace]
      const native = await this.host.worktrees()
      const matches = native.filter((item) =>
        candidates.some((candidate) => resolve(item) === resolve(candidate)),
      )
      if (matches.length > 1)
        throw new Error("Multiple native worktrees match the retained workspace reservation")
      const owned = matches[0]
      if (!owned) {
        const existing = candidates.filter((candidate) => existsSync(candidate))
        const gitWorktrees = git(this.directory, ["worktree", "list", "--porcelain"])
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => resolve(line.slice("worktree ".length)))
        const registered = candidates.filter((candidate) =>
          gitWorktrees.includes(resolve(candidate)),
        )
        if (existing.length > 1 || registered.length > 1)
          throw new Error(
            "Multiple retained workspace paths exist; preserve them for reconciliation",
          )
        if (existing.length && !registered.length)
          throw new Error("Retained checkout exists without native ownership; preserve it")
        if (registered.length) {
          recordedWorkspace = registered[0]!
          const removalIntent = this.store.fenced(this.owner, fence, (db) => {
            const current = retainedVerification(db, operation.id)
            if (!current || current.generation !== operation.generation) return false
            setRetainedVerificationWorkspace(db, current, phase, recordedWorkspace, "owned")
            this.store.record(
              operation.planID,
              operation.taskID,
              "RETAINED_VERIFICATION_WORKSPACE_REMOVAL_INTENDED",
              {
                operationID: operation.id,
                generation: operation.generation,
                phase,
                workspace: recordedWorkspace,
              },
            )
            return true
          })
          if (!removalIntent) return "pending"
          await this.host.removeWorktree(recordedWorkspace)
        }
        const nativeAfterAbsent = await this.host.worktrees()
        const gitAfterAbsent = git(this.directory, ["worktree", "list", "--porcelain"])
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => resolve(line.slice("worktree ".length)))
        if (
          nativeAfterAbsent.some((item) =>
            candidates.some((candidate) => resolve(item) === resolve(candidate)),
          ) ||
          gitAfterAbsent.some((item) =>
            candidates.some((candidate) => resolve(item) === resolve(candidate)),
          ) ||
          candidates.some((candidate) => existsSync(candidate))
        )
          throw new Error("Retained native workspace removal is not confirmed absent")
      } else {
        recordedWorkspace = owned
        if (
          realpathSync(dirname(owned)) !== realpathSync(dirname(workspace)) ||
          samePhysicalWorkspace(owned, operation.originalWorkspace) ||
          samePhysicalWorkspace(owned, this.directory) ||
          realpathSync(git(owned, ["rev-parse", "--show-toplevel"])) !== realpathSync(owned) ||
          git(owned, ["rev-parse", "HEAD"]) !== artifact ||
          git(owned, ["status", "--porcelain", "--untracked-files=all"]) ||
          git(owned, ["ls-files", "-u", "-z"])
        )
          throw new Error("Retained checkout identity or clean state changed; preserve it")
        const removalIntent = this.store.fenced(this.owner, fence, (db) => {
          const current = retainedVerification(db, operation.id)
          if (!current || current.generation !== operation.generation) return false
          setRetainedVerificationWorkspace(db, current, phase, owned, "owned")
          this.store.record(
            operation.planID,
            operation.taskID,
            "RETAINED_VERIFICATION_WORKSPACE_REMOVAL_INTENDED",
            {
              operationID: operation.id,
              generation: operation.generation,
              phase,
              workspace: owned,
            },
          )
          return true
        })
        if (!removalIntent) return "pending"
        await this.host.removeWorktree(owned)
      }
      const currentNative = await this.host.worktrees()
      const currentGit = git(this.directory, ["worktree", "list", "--porcelain"])
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => resolve(line.slice("worktree ".length)))
      if (
        candidates.some((candidate) => existsSync(candidate)) ||
        currentGit.some((item) =>
          candidates.some((candidate) => resolve(item) === resolve(candidate)),
        ) ||
        currentNative.some((item) =>
          candidates.some((candidate) => resolve(item) === resolve(candidate)),
        )
      )
        throw new Error("Native adapter did not confirm retained checkout removal")
      const retired = await this.host.retireWorktreeLocation?.(recordedWorkspace)
      if (retired !== undefined && retired !== "evicted" && retired !== "not-loaded")
        throw new Error(`Native checkout location retirement is ${retired}`)
      this.store.fenced(this.owner, fence, (db) => {
        const current = retainedVerification(db, operation.id)
        if (current?.generation === operation.generation)
          setRetainedVerificationWorkspace(db, current, phase, recordedWorkspace, "removed")
      })
      this.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_WORKSPACE_CLEANED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          workspace: recordedWorkspace,
          cleanupState: "complete",
          forcedDeletion: false,
        },
      )
      return "complete"
    } catch (error) {
      this.store.fenced(this.owner, fence, (db) => {
        const current = retainedVerification(db, operation.id)
        if (current?.generation === operation.generation)
          setRetainedVerificationWorkspace(db, current, phase, recordedWorkspace, "uncertain")
      })
      this.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_WORKSPACE_CLEANUP_FAILED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          workspace: recordedWorkspace,
          cleanupState: "failed",
          reason: errorText(error),
          forcedDeletion: false,
        },
      )
      return "failed"
    }
  }

  private async reconcileTerminalRetainedVerifications(fence: number): Promise<void> {
    const terminalOperations = this.store
      .atomic((db) => retainedVerificationsForProject(db, this.directory))
      .filter((operation) => ["accepted", "failed", "cancelled"].includes(operation.state))
    const terminalIDs = new Set(terminalOperations.map((operation) => operation.id))
    for (const operationID of this.terminalRetainedVerificationCleanupChecks.keys())
      if (!terminalIDs.has(operationID))
        this.terminalRetainedVerificationCleanupChecks.delete(operationID)
    const checkedAt = this.now()
    const operations = terminalOperations.filter((operation) => {
      if (!this.terminalRetainedVerificationCleanupRecordedComplete(operation)) return true
      const previous = this.terminalRetainedVerificationCleanupChecks.get(operation.id)
      if (
        !previous ||
        previous.generation !== operation.generation ||
        previous.updatedAt !== operation.updatedAt
      )
        return true
      const elapsed = checkedAt - previous.checkedAt
      return elapsed < 0 || elapsed >= WORKTREE_CLEANUP_FALLBACK_MS
    })
    if (!operations.length) return

    let native: string[]
    let gitWorktrees: string[]
    try {
      native = await this.host.worktrees()
      gitWorktrees = git(this.directory, ["worktree", "list", "--porcelain"])
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => resolve(line.slice("worktree ".length)))
    } catch {
      for (const operation of operations) {
        const current = this.store.atomic((db) => retainedVerification(db, operation.id))
        if (
          current?.generation === operation.generation &&
          current.updatedAt === operation.updatedAt &&
          this.terminalRetainedVerificationCleanupRecordedComplete(current)
        )
          this.terminalRetainedVerificationCleanupChecks.set(operation.id, {
            generation: current.generation,
            updatedAt: current.updatedAt,
            checkedAt,
          })
      }
      return
    }

    for (const original of operations) {
      let operation = this.store.atomic((db) => retainedVerification(db, original.id))
      if (
        !operation ||
        operation.generation !== original.generation ||
        !["accepted", "failed", "cancelled"].includes(operation.state)
      )
        continue
      if (operation.state === "cancelled") {
        try {
          await this.recoverCancelledRetainedChecks(operation.id)
        } catch {
          // Keep the terminal operation and its native resources discoverable.
        }
        operation = this.store.atomic((db) => retainedVerification(db, original.id))
        if (!operation || operation.generation !== original.generation) continue
      }

      let cleanupComplete = true
      const workspaceResults = new Map<"task" | "combined", "complete" | "failed" | "pending">()
      for (const phase of ["task", "combined"] as const) {
        const workspace = this.retainedVerificationIsolatedWorkspace(operation, phase)
        const workspaceState =
          phase === "task" ? operation.taskWorkspaceState : operation.combinedWorkspaceState
        const checks = this.store.atomic((db) =>
          retainedVerificationChecks(db, operation!.id, phase),
        )
        let checksSettled = true
        for (const check of checks) {
          if (check.state !== "completed" || !check.receipt) {
            checksSettled = false
            break
          }
          let receipt: CheckReceipt
          try {
            receipt = JSON.parse(check.receipt) as CheckReceipt
          } catch {
            checksSettled = false
            break
          }
          if (!checkResourcesSettled(receipt)) {
            checksSettled = false
            break
          }
          const resourcePending = this.store.atomic((db) =>
            db
              .query<{ state: string }, [string, string, string]>(
                "SELECT state FROM runner_retained_verification_resources WHERE operation_id=? AND phase=? AND check_id=?",
              )
              .all(operation!.id, phase, check.checkID)
              .some((resource) => resource.state !== "removed"),
          )
          if (check.cleanupState !== "complete" || resourcePending) {
            const setupClean = this.cleanupRetainedCheckSetup(
              operation,
              phase,
              check.checkID,
              this.dataDirectory,
              workspace ?? check.workspace,
              undefined,
              undefined,
              undefined,
            )
            if (setupClean)
              await this.cleanupRetainedCheckResources(
                operation,
                phase,
                check.checkID,
                check.contextPath,
                receipt.isolation,
                fence,
              )
          }
        }
        const refreshedChecks = this.store.atomic((db) =>
          retainedVerificationChecks(db, operation!.id, phase),
        )
        const remainingResources = this.store.atomic((db) =>
          db
            .query<{ state: string }, [string, string]>(
              "SELECT state FROM runner_retained_verification_resources WHERE operation_id=? AND phase=?",
            )
            .all(operation!.id, phase)
            .some((resource) => resource.state !== "removed"),
        )
        checksSettled &&= refreshedChecks.every(
          (check) =>
            check.state === "completed" &&
            Boolean(check.receipt) &&
            check.cleanupState === "complete",
        )
        checksSettled &&= !remainingResources

        const candidates =
          workspace && (workspaceState === "reserved" || workspaceState === "uncertain")
            ? startupWorktreeCandidates(workspace)
            : workspace
              ? [workspace]
              : []
        const inventoryHasWorkspace = candidates.some(
          (candidate) =>
            native.some((entry) => resolve(entry) === resolve(candidate)) ||
            gitWorktrees.includes(resolve(candidate)) ||
            existsSync(candidate),
        )
        const workspaceNeedsCleanup = Boolean(
          workspace && (workspaceState !== "removed" || inventoryHasWorkspace),
        )
        if (!checksSettled) {
          if (workspaceNeedsCleanup) {
            workspaceResults.set(phase, "pending")
            cleanupComplete = false
          }
          if (refreshedChecks.length || remainingResources) cleanupComplete = false
          continue
        }
        if (workspaceNeedsCleanup) {
          const result = await this.removeRetainedVerificationWorkspace(operation, phase, fence)
          workspaceResults.set(phase, result)
          if (result !== "complete") cleanupComplete = false
        } else if (workspaceState !== null && workspaceState !== "removed") {
          workspaceResults.set(phase, "pending")
          cleanupComplete = false
        }
      }

      const refreshed = this.store.atomic((db) => retainedVerification(db, operation!.id))
      if (!refreshed || refreshed.generation !== operation.generation) continue
      const taskResult = workspaceResults.get("task")
      const combinedResult = workspaceResults.get("combined")
      const workspaceUnresolved = [
        [refreshed.taskWorkspace, refreshed.taskWorkspaceState, taskResult],
        [refreshed.combinedWorkspace, refreshed.combinedWorkspaceState, combinedResult],
      ].some(
        ([workspace, state, result]) =>
          Boolean(workspace) && (state !== "removed" || (result && result !== "complete")),
      )
      cleanupComplete &&= !workspaceUnresolved
      const cleanupState = cleanupComplete ? "complete" : "failed"
      if (refreshed.cleanupState !== cleanupState) {
        this.store.fenced(this.owner, fence, (db) => {
          const current = retainedVerification(db, refreshed.id)
          if (!current || current.generation !== refreshed.generation) return
          saveRetainedVerification(db, {
            ...current,
            cleanupState,
            updatedAt: this.now(),
          })
          this.store.record(
            current.planID,
            current.taskID,
            cleanupComplete
              ? "RETAINED_VERIFICATION_TERMINAL_CLEANUP_COMPLETED"
              : "RETAINED_VERIFICATION_TERMINAL_CLEANUP_PENDING",
            {
              operationID: current.id,
              generation: current.generation,
              workspaces: {
                task: current.taskWorkspaceState,
                combined: current.combinedWorkspaceState,
              },
              results: Object.fromEntries(workspaceResults),
            },
          )
        })
      }
      const current = this.store.atomic((db) => retainedVerification(db, refreshed.id))
      if (
        cleanupComplete &&
        current?.generation === refreshed.generation &&
        ["accepted", "failed", "cancelled"].includes(current.state) &&
        this.terminalRetainedVerificationCleanupRecordedComplete(current)
      )
        this.terminalRetainedVerificationCleanupChecks.set(current.id, {
          generation: current.generation,
          updatedAt: current.updatedAt,
          checkedAt: this.now(),
        })
      else this.terminalRetainedVerificationCleanupChecks.delete(refreshed.id)
    }
  }

  private terminalRetainedVerificationCleanupRecordedComplete(operation: RetainedVerification) {
    const workspaceSettled = (workspace: string | null, state: string | null) =>
      workspace === null ? state === null : state === "removed"
    return (
      operation.cleanupState === "complete" &&
      workspaceSettled(operation.taskWorkspace, operation.taskWorkspaceState) &&
      workspaceSettled(operation.combinedWorkspace, operation.combinedWorkspaceState)
    )
  }

  private async reconcileInterruptedRetainedCheckSetup(
    operation: RetainedVerification,
    phase: "task" | "combined",
    check: TaskProposal["verification"][number],
    candidateWorkspace: string,
    fence: number,
  ): Promise<boolean> {
    const existingCheck = this.store.atomic((db) =>
      retainedVerificationChecks(db, operation.id, phase).some((item) => item.checkID === check.id),
    )
    if (existingCheck) return false
    const resources = this.store.atomic((db) =>
      db
        .query<
          {
            resource_name: string
            canonical_path: string
            device: number
            inode: number
            state: string
          },
          [string, string, string]
        >(
          `SELECT resource_name,canonical_path,device,inode,state
           FROM runner_retained_verification_resources
           WHERE operation_id=? AND phase=? AND check_id=? ORDER BY resource_name`,
        )
        .all(operation.id, phase, check.id),
    )
    if (!resources.length) return false
    // A restarted runtime has no completed installer/termination observation.
    // Ownership identifies resources; it does not establish that their writer stopped.
    const reason = `Interrupted retained verification setup ${phase}:${check.id} has unknown installer activity in ${candidateWorkspace}; preserve its resources`
    this.markRetainedCheckSetupUncertain(operation, phase, check.id, reason)
    await this.holdRetainedVerification(operation, reason, fence)
    return true
  }

  private async acceptRetainedTaskCandidate(
    initial: RetainedVerification,
    workspace: string,
    receipts: CheckReceipt[],
    fence: number,
  ): Promise<RetainedVerification | undefined> {
    const observeOwner = async () => {
      const owner = await this.host.session(initial.owner)
      if (!this.validArchitect(owner) || owner.id !== initial.owner)
        throw new Error("Retained verification owner changed before task acceptance")
    }
    try {
      if (initial.repair) {
        const plan = this.store.plan(initial.planID)
        const attempt = this.store.attempts(initial.planID).find((a) => a.id === initial.attemptID)
        if (!plan || !attempt) throw new Error("Retained repair binding disappeared")
        await this.observeRetainedRepairCandidate(plan, attempt, initial.repair, observeOwner)
      } else await observeOwner()
    } catch (error) {
      await this.holdRetainedVerification(initial, errorText(error), fence)
      return undefined
    }
    if (!(await this.retainedWorkspaceUnchanged(workspace, initial.artifact))) {
      await this.holdRetainedVerification(
        initial,
        "Retained task candidate changed after its task checks",
        fence,
      )
      return undefined
    }

    const plan = this.store.plan(initial.planID)
    const input = plan ? PlanInput.parse(JSON.parse(plan.body)) : undefined
    const nodes = this.store.nodes(initial.planID)
    const node = nodes.find((candidate) => candidate.task_id === initial.taskID)
    const attempt = this.store
      .attempts(initial.planID)
      .filter((candidate) => candidate.task_id === initial.taskID)
      .at(-1)
    const targetFailureOwnsBlock = Boolean(
      plan?.state === "blocked" &&
      node?.state === "failed" &&
      attempt?.state === "failed" &&
      plan.reason !== null &&
      (plan.reason === node.reason ||
        plan.reason === `Task ${node.task_id}: ${node.reason ?? node.state}`),
    )
    const retainedEvidenceHoldOwnsBlock = Boolean(
      plan?.state === "blocked" &&
      node?.state === "verifying" &&
      attempt?.state === "verifying" &&
      plan.reason?.startsWith("Required evidence missing:"),
    )
    const otherNodesReady = Boolean(
      input?.integrationOrder.every((taskID) => {
        if (taskID === initial.taskID) return true
        const other = nodes.find((candidate) => candidate.task_id === taskID)
        return Boolean(other?.artifact && ["accepted", "incorporated"].includes(other.state))
      }),
    )
    const canContinueCombined = Boolean(
      initial.combinedArtifact &&
      otherNodesReady &&
      (plan?.state === "accepted" || plan?.state === "cleanup-blocked" || targetFailureOwnsBlock),
    )
    return this.store.fenced(this.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      const currentPlan = this.store.plan(initial.planID)
      const currentTask = this.store.repository.get(initial.taskID)
      const latestAttempt = this.store
        .attempts(initial.planID)
        .filter((candidate) => candidate.task_id === initial.taskID)
        .at(-1)
      const currentNode = this.store
        .nodes(initial.planID)
        .find((candidate) => candidate.task_id === initial.taskID)
      const sourceQuarantineCurrent = Boolean(
        current?.sourceQuarantine &&
        ["running", "blocked", "accepted", "cleanup-blocked"].includes(currentPlan?.state ?? "") &&
        latestAttempt?.state === "verifying" &&
        latestAttempt.artifact === initial.artifact &&
        currentNode?.state === "verifying" &&
        sourceQuarantineVerificationBindingMatches(this.store, {
          planID: initial.planID,
          owner: initial.owner,
          attempt: latestAttempt,
          artifact: initial.artifact,
          expected: current.sourceQuarantine,
        }),
      )
      if (
        !current ||
        current.generation !== initial.generation ||
        !["task-checks", "waiting-human"].includes(current.state) ||
        !currentPlan ||
        (current.sourceQuarantine
          ? !this.sourceQuarantinePlanVersionCurrent(current, currentPlan, db)
          : currentPlan.version !== initial.planVersion) ||
        currentPlan.revision !== initial.planRevision ||
        currentPlan.owner !== initial.owner ||
        this.store.planControlEpoch(currentPlan.id) !== initial.ownerEpoch ||
        (current.sourceQuarantine
          ? !sourceQuarantineCurrent
          : !["blocked", "accepted", "cleanup-blocked"].includes(currentPlan.state)) ||
        !currentTask ||
        currentTask.revision !== initial.taskRevision ||
        currentTask.provenance.projectID !== this.projectID ||
        currentTask.provenance.projectDirectory !== this.directory ||
        this.store.repository.taskDisposition(initial.taskID) !== undefined ||
        latestAttempt?.id !== initial.attemptID ||
        latestAttempt.session_id !== initial.originalSessionID ||
        latestAttempt.message_id !== initial.originalMessageID ||
        realpathSync(latestAttempt.workspace) !== initial.originalWorkspace ||
        !currentNode ||
        !["accepted", "blocked", "failed", "verifying", "running", "ready"].includes(
          currentNode.state,
        ) ||
        (currentNode.artifact !== null && currentNode.artifact !== initial.artifact) ||
        (initial.repair &&
          (latestAttempt.artifact !== initial.repair.previousArtifact ||
            !this.retainedRepairCandidateCurrent(currentPlan, latestAttempt, initial.repair)))
      )
        return undefined

      let expectedPlanVersion = currentPlan.version
      // Quarantined source has no idle or cleanup proof; accept only its task node.
      if (!current.sourceQuarantine)
        db.query(
          "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'accepted'),artifact=? WHERE id=? AND state IN ('running','verifying')",
        ).run(initial.artifact, initial.attemptID)
      if (currentNode.state !== "accepted") {
        db.query(
          "UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=? AND state=?",
        ).run(initial.artifact, initial.planID, initial.taskID, currentNode.state)
        this.store.move(initial.planID, initial.taskID, "RETAINED_ACCEPT")
        expectedPlanVersion += 1
      }

      let resumedForDependencies = false
      if (
        currentPlan.state === "blocked" &&
        (targetFailureOwnsBlock || retainedEvidenceHoldOwnsBlock) &&
        currentPlan.reason !== null
      ) {
        const resumed = db
          .query(
            `UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1
             WHERE id=? AND state='blocked' AND reason=? AND version=?`,
          )
          .run(initial.planID, currentPlan.reason, expectedPlanVersion).changes
        if (resumed !== 1) throw new Error("Plan changed before retained task dependency release")
        expectedPlanVersion += 1
        resumedForDependencies = true
      }

      const allNodesReady = this.store
        .nodes(initial.planID)
        .every((candidate) =>
          input!.integrationOrder.includes(candidate.task_id)
            ? candidate.task_id === initial.taskID ||
              (Boolean(candidate.artifact) &&
                ["accepted", "incorporated"].includes(candidate.state))
            : false,
        )
      const runCombined = Boolean(
        canContinueCombined &&
        current.combinedArtifact &&
        allNodesReady &&
        ["running", "accepted", "cleanup-blocked"].includes(this.store.plan(initial.planID)!.state),
      )
      const updated: RetainedVerification = {
        ...current,
        state: runCombined ? "combined-checks" : "task-accepted",
        holdReason: null,
        ...(runCombined
          ? {
              planVersion: expectedPlanVersion,
              combinedWorkspace:
                current.combinedWorkspace ??
                this.retainedVerificationWorkspacePath(current.id, "combined"),
            }
          : {}),
        updatedAt: this.now(),
      }
      saveRetainedVerification(db, updated)
      this.store.record(initial.planID, initial.taskID, "RETAINED_TASK_CANDIDATE_ACCEPTED", {
        operationID: initial.id,
        generation: initial.generation,
        taskRevision: initial.taskRevision,
        attemptID: initial.attemptID,
        artifact: initial.artifact,
        taskChecks: receipts,
        combinedVerification: runCombined ? "ready" : "deferred-until-plan-readiness",
        resumedForDependencies,
        cleanupState: updated.cleanupState,
        originalAttemptPreserved: true,
        originalSessionMessageRouteUsagePreserved: true,
        oldExecutionAndResourceHoldsPreserved: true,
      })
      if (resumedForDependencies)
        this.store.record(initial.planID, null, "RETAINED_TASK_RELEASED_DEPENDENCIES", {
          operationID: initial.id,
          generation: initial.generation,
          taskID: initial.taskID,
          artifact: initial.artifact,
          reason: "The exact retained task failure was resolved by ordinary task evidence",
          normalDependencyAndReservationGatesPreserved: true,
        })
      this.outcome(
        initial.planID,
        {
          status: "task-accepted",
          taskID: initial.taskID,
          attemptID: initial.attemptID,
          artifact: initial.artifact,
          retainedVerificationID: initial.id,
          generation: initial.generation,
          evidence: receipts.map((receipt) => receipt.id),
          cleanupState: updated.cleanupState,
          resumedForDependencies,
        },
        true,
      )
      return updated
    })
  }

  private async advanceRetainedVerification(
    initial: RetainedVerification,
    fence: number,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) return
    let operation = this.store.atomic((db) => retainedVerification(db, initial.id))
    if (
      !operation ||
      operation.generation !== initial.generation ||
      ["accepted", "failed", "cancelled", "held"].includes(operation.state)
    )
      return
    const plan = this.store.plan(operation.planID)
    if (!plan) return
    let owner: HostSession | null | undefined
    try {
      owner = await this.host.session(operation.owner)
      const combinedPhase =
        operation.state === "combined-checks" || operation.state === "waiting-human-combined"
      const deferredTaskPhase = operation.state === "task-accepted"
      if (
        !this.validArchitect(owner) ||
        owner.id !== plan.owner ||
        operation.owner !== plan.owner ||
        operation.ownerEpoch !== this.store.planControlEpoch(plan.id) ||
        operation.planRevision !== plan.revision ||
        (!deferredTaskPhase &&
          (operation.sourceQuarantine
            ? !this.sourceQuarantinePlanVersionCurrent(operation, plan)
            : operation.planVersion !== plan.version)) ||
        !(
          ["blocked", "accepted", "cleanup-blocked"].includes(plan.state) ||
          ((combinedPhase || deferredTaskPhase || operation.sourceQuarantine !== undefined) &&
            plan.state === "running")
        )
      )
        throw new Error("Retained verification owner, plan version or execution authority changed")
      if (!this.retainedVerificationLive(operation.id, operation.generation))
        throw new Error("Retained verification task or attempt authority changed")
      if (operation.repair && !this.retainedTaskCandidateAccepted(operation)) {
        const attemptID = operation.attemptID
        const attempt = this.store.attempts(plan.id).find((a) => a.id === attemptID)
        if (!attempt) throw new Error("Retained repair attempt disappeared")
        await this.observeRetainedRepairCandidate(plan, attempt, operation.repair)
      }
    } catch (error) {
      await this.holdRetainedVerification(operation, errorText(error), fence)
      return
    }
    const input = PlanInput.parse(JSON.parse(plan.body))
    const task = this.store.repository.get(operation.taskID)
    if (!task) {
      await this.holdRetainedVerification(
        operation,
        "Retained task specification is unavailable",
        fence,
      )
      return
    }
    if (operation.state === "pending" || operation.state === "task-checks") {
      for (const check of task.proposal.verification)
        if (
          await this.reconcileInterruptedRetainedCheckSetup(
            operation,
            "task",
            check,
            operation.taskWorkspace ?? "",
            fence,
          )
        )
          return
    }
    if (operation.state === "combined-checks")
      for (const check of input.verification)
        if (
          await this.reconcileInterruptedRetainedCheckSetup(
            operation,
            "combined",
            check,
            operation.combinedWorkspace ?? "",
            fence,
          )
        )
          return
    if (operation.state === "pending" || operation.state === "task-checks") {
      const workspace = await this.ensureRetainedVerificationWorkspace(
        operation,
        "task",
        operation.artifact,
        fence,
      )
      if (!workspace) return
      const refreshed = this.store.atomic((db) => retainedVerification(db, initial.id))
      if (!refreshed || refreshed.generation !== initial.generation) return
      operation = refreshed
      if (operation.state === "pending") {
        const updated = await this.setRetainedVerificationState(
          operation,
          "task-checks",
          null,
          fence,
        )
        if (!updated) return
        operation = updated
      }
      const taskReceipts = await this.runRetainedVerificationChecks(
        operation,
        "task",
        task.proposal.verification,
        workspace,
        operation.artifact,
        fence,
        signal,
      )
      if (!taskReceipts || !this.retainedVerificationLive(operation.id, operation.generation))
        return
      const failed = taskReceipts.find(
        (receipt) => !checkSucceeded(receipt) || receipt.inputIdentity !== initial.artifact,
      )
      if (failed) {
        await this.holdRetainedVerification(operation, checkFailureReason(failed), fence)
        return
      }
      const missing = this.retainedEvidenceMissing(
        operation,
        "task",
        task.proposal.acceptance,
        workspace,
        operation.artifact,
        taskReceipts,
      )
      if (missing.length) {
        const externallySuppliedOnly = missing.every(
          (item) => item.endsWith(":human") || item.includes(":probe:"),
        )
        await this.setRetainedVerificationState(
          operation,
          externallySuppliedOnly ? "waiting-human" : "held",
          `Required retained task evidence missing: ${missing.join(", ")}`,
          fence,
        )
        return
      }
      const accepted = await this.acceptRetainedTaskCandidate(
        operation,
        workspace,
        taskReceipts,
        fence,
      )
      if (!accepted || accepted.state === "task-accepted") return
      operation = accepted
    }
    if (operation.state === "waiting-human") {
      const taskWorkspace = this.retainedVerificationIsolatedWorkspace(operation, "task")
      if (!taskWorkspace) return
      const taskReceipts = this.store.atomic((db) =>
        retainedVerificationChecks(db, initial.id, "task")
          .filter((row) => row.state === "completed" && row.receipt)
          .map((row) => JSON.parse(row.receipt!) as CheckReceipt),
      )
      const missing = this.retainedEvidenceMissing(
        operation,
        "task",
        task.proposal.acceptance,
        taskWorkspace,
        operation.artifact,
        taskReceipts,
      )
      if (missing.length) return
      const accepted = await this.acceptRetainedTaskCandidate(
        operation,
        taskWorkspace,
        taskReceipts,
        fence,
      )
      if (!accepted || accepted.state === "task-accepted") return
      operation = accepted
    }
    if (operation.state === "waiting-human-combined") {
      const updated = await this.setRetainedVerificationState(
        operation,
        "combined-checks",
        null,
        fence,
      )
      if (!updated) return
      operation = updated
    }
    if (operation.state === "task-accepted") {
      const deferredOperation = operation
      if (plan.state !== "running") return
      const nodes = this.store.nodes(deferredOperation.planID)
      const byTask = new Map(nodes.map((node) => [node.task_id, node]))
      const allNodesReady = input.integrationOrder.every((taskID) => {
        const node = byTask.get(taskID)
        return Boolean(
          node?.artifact &&
          ["accepted", "incorporated"].includes(node.state) &&
          (taskID !== deferredOperation.taskID || node.artifact === deferredOperation.artifact),
        )
      })
      if (!allNodesReady) return
      let combinedArtifact: string
      try {
        combinedArtifact = await combineArtifacts(
          this.directory,
          input.baseCommit,
          input.integrationOrder.map((taskID) => byTask.get(taskID)!.artifact!),
        )
      } catch (error) {
        await this.holdRetainedVerification(
          deferredOperation,
          `Combined artifact conflict: ${errorText(error)}`,
          fence,
        )
        return
      }
      const acceptedArtifacts = input.integrationOrder.map((taskID) => ({
        taskID,
        artifact: byTask.get(taskID)!.artifact!,
      }))
      const combinedInputFingerprint = fingerprint({
        operationInputFingerprint: deferredOperation.inputFingerprint,
        planID: plan.id,
        planRevision: plan.revision,
        planVersion: plan.version,
        planBody: plan.body,
        taskID: deferredOperation.taskID,
        taskArtifact: deferredOperation.artifact,
        acceptedArtifacts,
        combinedArtifact,
        verification: input.verification,
        acceptance: input.acceptance,
        environmentIdentity: deferredOperation.environmentIdentity,
      })
      const promoted = this.store.fenced(this.owner, fence, (db) => {
        const current = retainedVerification(db, deferredOperation.id)
        const currentPlan = this.store.plan(deferredOperation.planID)
        const currentNodes = this.store.nodes(deferredOperation.planID)
        const currentByTask = new Map(currentNodes.map((node) => [node.task_id, node]))
        const currentAttempt = this.store
          .attempts(deferredOperation.planID)
          .find((attempt) => attempt.id === deferredOperation.attemptID)
        const sourceAuthorityCurrent = Boolean(
          !current?.sourceQuarantine ||
          (currentPlan?.state === "running" &&
            currentAttempt?.state === "verifying" &&
            currentAttempt.artifact === deferredOperation.artifact &&
            sourceQuarantineVerificationBindingMatches(this.store, {
              planID: deferredOperation.planID,
              owner: deferredOperation.owner,
              attempt: currentAttempt,
              artifact: deferredOperation.artifact,
              expected: current.sourceQuarantine,
            })),
        )
        if (
          !current ||
          current.generation !== deferredOperation.generation ||
          current.state !== "task-accepted" ||
          !currentPlan ||
          currentPlan.state !== "running" ||
          currentPlan.version !== plan.version ||
          currentPlan.revision !== deferredOperation.planRevision ||
          currentPlan.owner !== deferredOperation.owner ||
          this.store.planControlEpoch(currentPlan.id) !== deferredOperation.ownerEpoch ||
          !sourceAuthorityCurrent ||
          !input.integrationOrder.every((taskID) => {
            const before = byTask.get(taskID)
            const after = currentByTask.get(taskID)
            return Boolean(
              before?.artifact &&
              after?.artifact === before.artifact &&
              ["accepted", "incorporated"].includes(before.state) &&
              ["accepted", "incorporated"].includes(after.state),
            )
          }) ||
          currentByTask.get(deferredOperation.taskID)?.artifact !== deferredOperation.artifact
        )
          return undefined
        const updated: RetainedVerification = {
          ...current,
          state: "combined-checks",
          planVersion: currentPlan.version,
          combinedArtifact,
          combinedInputFingerprint,
          combinedWorkspace:
            current.combinedWorkspace ??
            this.retainedVerificationWorkspacePath(current.id, "combined"),
          holdReason: null,
          updatedAt: this.now(),
        }
        saveRetainedVerification(db, updated)
        this.store.record(
          deferredOperation.planID,
          deferredOperation.taskID,
          "RETAINED_TASK_PLAN_READY_FOR_COMBINED_VERIFICATION",
          {
            operationID: deferredOperation.id,
            generation: deferredOperation.generation,
            artifact: deferredOperation.artifact,
            combinedArtifact,
            acceptedArtifacts,
            planVersion: currentPlan.version,
          },
        )
        return updated
      })
      if (!promoted) return
      operation = promoted
    }
    if (operation.state !== "combined-checks") return
    const combinedArtifact = operation.combinedArtifact
    if (!combinedArtifact) {
      await this.holdRetainedVerification(
        operation,
        "Combined retained verification has no ready plan artifact",
        fence,
      )
      return
    }
    const combinedWorkspace = await this.ensureRetainedVerificationWorkspace(
      operation,
      "combined",
      combinedArtifact,
      fence,
    )
    if (!combinedWorkspace) return
    const refreshed = this.store.atomic((db) => retainedVerification(db, initial.id))
    if (
      !refreshed ||
      refreshed.generation !== initial.generation ||
      refreshed.state !== "combined-checks" ||
      refreshed.combinedArtifact !== combinedArtifact
    )
      return
    operation = refreshed
    const combinedReceipts = await this.runRetainedVerificationChecks(
      operation,
      "combined",
      input.verification,
      combinedWorkspace,
      combinedArtifact,
      fence,
      signal,
    )
    if (!combinedReceipts || !this.retainedVerificationLive(operation.id, operation.generation))
      return
    const failed = combinedReceipts.find(
      (receipt) => !checkSucceeded(receipt) || receipt.inputIdentity !== combinedArtifact,
    )
    if (failed) {
      await this.holdRetainedVerification(operation, checkFailureReason(failed), fence)
      return
    }
    const missing = this.retainedEvidenceMissing(
      operation,
      "combined",
      input.acceptance,
      combinedWorkspace,
      combinedArtifact,
      combinedReceipts,
    )
    if (missing.length) {
      const externallySuppliedOnly = missing.every(
        (item) => item.endsWith(":human") || item.includes(":probe:"),
      )
      await this.setRetainedVerificationState(
        operation,
        externallySuppliedOnly ? "waiting-human-combined" : "held",
        `Required retained combined evidence missing: ${missing.join(", ")}`,
        fence,
      )
      return
    }
    if (
      !(await this.retainedWorkspaceUnchanged(combinedWorkspace, combinedArtifact)) ||
      !(await this.retainedWorkspaceUnchanged(
        this.retainedVerificationIsolatedWorkspace(operation, "task")!,
        operation.artifact,
      ))
    ) {
      await this.holdRetainedVerification(
        operation,
        "Retained candidate changed after verification",
        fence,
      )
      return
    }
    const taskReceiptsForAcceptance = this.store.atomic((db) =>
      retainedVerificationChecks(db, operation.id, "task").flatMap((row) => {
        if (row.state !== "completed" || !row.receipt) return []
        try {
          return [JSON.parse(row.receipt) as CheckReceipt]
        } catch {
          return []
        }
      }),
    )
    const contextCleanup = this.store.atomic((db) =>
      retainedVerificationChecks(db, operation.id).every((row) => row.cleanupState === "complete"),
    )
    const taskCleanup = await this.removeRetainedVerificationWorkspace(operation, "task", fence)
    const combinedCleanup = await this.removeRetainedVerificationWorkspace(
      operation,
      "combined",
      fence,
    )
    const cleanupState =
      taskCleanup === "complete" && combinedCleanup === "complete" && contextCleanup
        ? "complete"
        : "failed"
    this.store.fenced(this.owner, fence, (db) => {
      const current = retainedVerification(db, operation.id)
      const currentPlan = this.store.plan(operation.planID)
      const currentTask = this.store.repository.get(operation.taskID)
      const latestAttempt = this.store
        .attempts(operation.planID)
        .filter((attempt) => attempt.task_id === operation.taskID)
        .at(-1)
      const currentNode = this.store
        .nodes(operation.planID)
        .find((node) => node.task_id === operation.taskID)
      const sourceAuthorityCurrent = Boolean(
        !current?.sourceQuarantine ||
        (["running", "blocked", "accepted", "cleanup-blocked"].includes(currentPlan?.state ?? "") &&
          latestAttempt?.state === "verifying" &&
          latestAttempt.artifact === operation.artifact &&
          latestAttempt.session_id === operation.originalSessionID &&
          latestAttempt.message_id === operation.originalMessageID &&
          realpathSync(latestAttempt.workspace) === operation.originalWorkspace &&
          sourceQuarantineVerificationBindingMatches(this.store, {
            planID: operation.planID,
            owner: operation.owner,
            attempt: latestAttempt,
            artifact: operation.artifact,
            expected: current.sourceQuarantine,
          })),
      )
      if (
        !current ||
        current.generation !== operation.generation ||
        ![
          "pending",
          "task-checks",
          "combined-checks",
          "waiting-human",
          "waiting-human-combined",
        ].includes(current.state) ||
        !currentPlan ||
        (current.sourceQuarantine
          ? !this.sourceQuarantinePlanVersionCurrent(current, currentPlan, db)
          : currentPlan.version !== operation.planVersion) ||
        currentPlan.revision !== operation.planRevision ||
        currentPlan.owner !== operation.owner ||
        this.store.planControlEpoch(currentPlan.id) !== operation.ownerEpoch ||
        !sourceAuthorityCurrent ||
        !currentTask ||
        currentTask.revision !== operation.taskRevision ||
        latestAttempt?.id !== operation.attemptID ||
        !currentNode ||
        !["accepted", "blocked", "failed", "verifying", "running", "ready"].includes(
          currentNode.state,
        )
      )
        return
      let expectedPlanVersion = currentPlan.version
      if (currentNode.state === "accepted") {
        if (currentNode.artifact !== operation.artifact)
          db.query(
            "UPDATE runner_nodes SET artifact=?,version=version+1 WHERE plan_id=? AND task_id=? AND state='accepted'",
          ).run(operation.artifact, operation.planID, operation.taskID)
      } else {
        db.query(
          "UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=? AND state=?",
        ).run(operation.artifact, operation.planID, operation.taskID, currentNode.state)
        this.store.move(operation.planID, operation.taskID, "RETAINED_ACCEPT")
        expectedPlanVersion += 1
      }
      const updatedOperation: RetainedVerification = {
        ...current,
        state: "accepted",
        holdReason: null,
        cleanupState,
        taskWorkspaceState: taskCleanup === "complete" ? "removed" : "uncertain",
        combinedWorkspaceState: combinedCleanup === "complete" ? "removed" : "uncertain",
        updatedAt: this.now(),
      }
      saveRetainedVerification(db, updatedOperation)
      const planAcceptance = db
        .query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'accepted'),artifact=?,version=version+1 WHERE id=? AND version=?",
        )
        .run(combinedArtifact, operation.planID, expectedPlanVersion)
      if (planAcceptance.changes !== 1)
        throw new Error("Plan changed before retained candidate acceptance")
      this.store.record(operation.planID, operation.taskID, "RETAINED_CANDIDATE_ACCEPTED", {
        operationID: operation.id,
        generation: operation.generation,
        taskRevision: operation.taskRevision,
        attemptID: operation.attemptID,
        artifact: operation.artifact,
        combinedArtifact,
        taskChecks: taskReceiptsForAcceptance,
        combinedChecks: combinedReceipts,
        originalAttemptStatePreserved: true,
        originalSessionMessageRouteUsagePreserved: true,
        cleanupState,
        resourceHoldsPreserved: true,
      })
      this.store.record(operation.planID, null, "PLAN_ACCEPTED", {
        artifact: combinedArtifact,
        taskArtifact: operation.artifact,
        retainedVerificationID: operation.id,
        generation: operation.generation,
        checks: combinedReceipts,
        cleanupState,
      })
      this.outcome(
        operation.planID,
        {
          status: "accepted",
          artifact: combinedArtifact,
          taskID: operation.taskID,
          taskArtifact: operation.artifact,
          attemptID: operation.attemptID,
          retainedVerificationID: operation.id,
          generation: operation.generation,
          evidence: combinedReceipts,
          cleanupState,
        },
        true,
      )
    })
  }

  private adoptionIsLive(adoptionID: string): boolean {
    const adoption = this.store.adoption(adoptionID)
    const plan = adoption ? this.store.plan(adoption.plan_id) : undefined
    return Boolean(
      adoption &&
      plan?.state === "blocked" &&
      ["pending", "task-checks", "combined-checks", "waiting-human"].includes(adoption.state),
    )
  }

  private holdAdoption(
    plan: PlanRow,
    adoptionID: string,
    reason: string,
    state: "pending" | "waiting-human" | "held" = "held",
    fence: number,
  ) {
    this.store.fenced(this.owner, fence, () => {
      const current = this.store.adoption(adoptionID)
      const currentPlan = this.store.plan(plan.id)
      if (
        !current ||
        !currentPlan ||
        currentPlan.state === "cancelling" ||
        currentPlan.state === "cancelled" ||
        !["pending", "task-checks", "combined-checks", "waiting-human"].includes(current.state)
      )
        return
      if (
        current.state === state &&
        current.hold_reason === reason &&
        currentPlan.reason === reason
      )
        return
      if (
        !this.store.setAdoptionState(current.id, state, reason, { owner: this.owner, value: fence })
      )
        return
      const changed = this.store.atomic(
        (db) =>
          db
            .query(
              "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'blocked'),reason=?,version=version+1 WHERE id=? AND state='blocked' AND reason IS NOT ?",
            )
            .run(reason, plan.id, reason).changes,
      )
      this.store.record(
        plan.id,
        current.task_id,
        state === "waiting-human"
          ? "DESCENDANT_ADOPTION_WAITING_HUMAN"
          : "DESCENDANT_ADOPTION_HELD",
        { adoptionID, reason, state, planVersionChanged: changed === 1 },
      )
    })
  }

  private async validateAdoption(planID: string, adoption: AdoptionRow) {
    const plan = this.store.plan(planID)
    if (!plan || plan.state !== "blocked") throw new Error("Adoption plan is no longer blocked")
    if (plan.owner !== adoption.owner) throw new Error("Descendant adoption owner changed")
    const owner = await this.host.session(plan.owner)
    if (!this.validArchitect(owner) || owner.id !== adoption.owner)
      throw new Error("Descendant adoption owner is missing, stale, or foreign")
    const input = PlanInput.parse(JSON.parse(plan.body))
    const task = this.store.repository.get(adoption.task_id)
    const node = this.store
      .nodes(plan.id)
      .find((candidate) => candidate.task_id === adoption.task_id)
    const attempt = this.store
      .attempts(plan.id)
      .filter((candidate) => candidate.task_id === adoption.task_id)
      .at(-1)
    if (
      !task ||
      !node ||
      !attempt ||
      task.revision !== adoption.task_revision ||
      node.state !== adoption.node_state ||
      node.artifact !== adoption.old_artifact ||
      attempt.id !== adoption.attempt_id ||
      attempt.state !== adoption.attempt_state ||
      attempt.artifact !== adoption.old_artifact
    )
      throw new Error("Task revision, latest attempt, or old artifact changed during adoption")
    if (
      this.store
        .nodes(plan.id)
        .some(
          (candidate) =>
            candidate.task_id !== adoption.task_id &&
            !["accepted", "incorporated"].includes(candidate.state),
        )
    )
      throw new Error("Combined adoption inputs are no longer fully accepted")
    if (this.conflictingActiveAttempt(adoption.task_id))
      throw new Error("A conflicting worker prevents descendant adoption")
    if (
      this.store
        .effects(plan.id)
        .some(
          (effect) =>
            !effect.kind.startsWith("adoption-") &&
            ["intended", "uncertain"].includes(effect.state),
        )
    )
      throw new Error("An uncertain prior effect prevents descendant adoption")
    const competing = this.store.activeAdoptions().filter((item) => item.id !== adoption.id)
    if (
      competing.some((item) =>
        scopePatternsConflict(
          this.store.effectiveWriteScope(adoption.task_id),
          this.store.effectiveWriteScope(item.task_id),
        ),
      )
    )
      throw new Error("A conflicting descendant reservation became active")
    const worker = await this.host.session(attempt.session_id, { messages: true })
    if (
      !worker ||
      worker.id !== attempt.session_id ||
      worker.projectID !== this.projectID ||
      worker.directory !== attempt.workspace ||
      !isWorkerAgent(worker.agent) ||
      worker.archived ||
      worker.metadata?.lazersAttemptID !== attempt.id ||
      !this.adoptionWorkerIdle(attempt, worker)
    )
      throw new Error("Latest worker activity or control state is not conclusively idle")
    const currentAttempt = this.store
      .attempts(plan.id)
      .filter((candidate) => candidate.task_id === adoption.task_id)
      .at(-1)
    const currentPlan = this.store.plan(plan.id)
    if (
      !currentAttempt ||
      currentAttempt.id !== attempt.id ||
      currentAttempt.state !== adoption.attempt_state ||
      currentAttempt.artifact !== adoption.old_artifact ||
      currentAttempt.session_id !== attempt.session_id ||
      currentAttempt.workspace !== attempt.workspace
    )
      throw new Error("Latest task attempt changed during adoption verification")
    if (
      !currentPlan ||
      this.currentAdoptionInputFingerprint(currentPlan, adoption) !== adoption.input_fingerprint
    )
      throw new Error("Task, plan, or authorized scope changed during adoption verification")
    const branch = git(this.directory, ["branch", "--show-current"])
    const head = git(this.directory, ["rev-parse", "HEAD"])
    if (branch !== adoption.target_branch || head !== adoption.landing_head)
      throw new Error("Reviewed landing branch or HEAD changed during adoption")
    if (
      (await gitAsync(this.directory, ["status", "--porcelain", "--untracked-files=all"])) ||
      git(this.directory, ["ls-files", "-u", "-z"])
    )
      throw new Error("Dirty or unmerged candidate checkout cannot publish adoption")
    const candidate = git(this.directory, ["rev-parse", `${adoption.descendant_commit}^{commit}`])
    const oldArtifact = git(this.directory, ["rev-parse", `${adoption.old_artifact}^{commit}`])
    if (
      candidate !== adoption.descendant_commit ||
      oldArtifact !== adoption.old_artifact ||
      git(this.directory, ["rev-parse", `${candidate}^{tree}`]) !== adoption.candidate_tree ||
      git(this.directory, ["write-tree"]) !== adoption.candidate_tree
    )
      throw new Error("Candidate or index no longer matches the reviewed adoption inputs")
    git(this.directory, ["merge-base", "--is-ancestor", oldArtifact, candidate])
    const reviewedBaseline = this.reviewedAdoptionBaseline(
      adoption.target_branch,
      oldArtifact,
      candidate,
    )
    if (reviewedBaseline !== adoption.reviewed_baseline)
      throw new Error("Reviewed adoption baseline changed during adoption")
    const violations = await this.adoptionArtifactScopeViolations(
      attempt,
      oldArtifact,
      adoption.target_branch,
    )
    if (violations.length)
      throw new Error(
        `Candidate contains out-of-scope changes: ${violations.slice(0, 20).join(", ")}`,
      )
    const branches = input.integrationOrder.map((taskID) => {
      if (taskID === adoption.task_id) return candidate
      const other = this.store.nodes(plan.id).find((item) => item.task_id === taskID)
      if (!other?.artifact || !["accepted", "incorporated"].includes(other.state))
        throw new Error("Combined adoption requires every other accepted artifact")
      return other.artifact
    })
    const combinedArtifact = await combineArtifacts(this.directory, input.baseCommit, branches)
    if (combinedArtifact !== adoption.combined_artifact)
      throw new Error("Combined artifact inputs changed during adoption")
    return { plan, input, task, node, attempt }
  }

  private async ensureAdoptionWorkspace(
    plan: PlanRow,
    adoption: AdoptionRow,
    phase: "task" | "combined",
    base: string,
    fence: number,
  ): Promise<string | undefined> {
    const kind = phase === "task" ? "adoption-task-worktree" : "adoption-combined-worktree"
    const workspaceField = phase === "task" ? adoption.task_workspace : adoption.combined_workspace
    const existing = this.store.effects(plan.id).find((effect) => {
      if (effect.kind !== kind) return false
      try {
        return JSON.parse(effect.payload).adoptionID === adoption.id
      } catch {
        return false
      }
    })
    if (existing) {
      if (existing.state !== "completed") {
        await this.reconcileEffect(existing, fence)
        return undefined
      }
      const workspace = workspaceField ?? JSON.parse(existing.receipt!).workspace
      if (!existsSync(workspace) || git(workspace, ["rev-parse", "HEAD"]) !== base)
        throw new Error(`Owned adoption worktree changed; preserve ${workspace}`)
      if (git(workspace, ["ls-files", "-u", "-z"]))
        throw new Error(`Owned adoption worktree has unmerged paths; preserve ${workspace}`)
      if (await gitAsync(workspace, ["status", "--porcelain", "--untracked-files=all"])) {
        const declaredChecks =
          phase === "task"
            ? this.store.repository.get(adoption.task_id)?.proposal.verification
            : PlanInput.parse(JSON.parse(plan.body)).verification
        const rows = this.store.adoptionChecks(adoption.id, phase)
        const exactReceiptExists = (check: TaskProposal["verification"][number]) => {
          const row = rows.find((candidate) => candidate.check_id === check.id)
          if (!row) return false
          const receiptPath = join(
            this.dataDirectory,
            "receipts",
            "adoptions",
            adoption.id,
            `${phase}-${check.id}.json`,
          )
          if (
            !this.adoptionCheckInputMatches(adoption, phase, check, row, workspace, base) ||
            row.receipt_path !== receiptPath ||
            row.check_id !== check.id
          )
            return false
          try {
            const receipt =
              row.state === "completed" && row.receipt
                ? (JSON.parse(row.receipt) as CheckReceipt)
                : existsSync(row.receipt_path)
                  ? (JSON.parse(readFileSync(row.receipt_path, "utf8")) as CheckReceipt)
                  : undefined
            return Boolean(receipt && this.adoptionCheckReceiptMatches(receipt, row, check))
          } catch {
            return false
          }
        }
        const allChecksHaveReceipts = Boolean(
          declaredChecks?.length &&
          declaredChecks.length === rows.length &&
          declaredChecks.every(exactReceiptExists),
        )
        const checkIsRunning = rows.some((row) => {
          const check = declaredChecks?.find((candidate) => candidate.id === row.check_id)
          if (!check) return false
          const activityIdentity = {
            adoptionID: adoption.id,
            phase,
            checkID: check.id,
            inputFingerprint: row.input_fingerprint,
            workspace: row.workspace,
            artifact: row.artifact,
            receiptPath: row.receipt_path,
          }
          return (
            this.checkActivity(`adoption:${adoption.id}:${phase}:${check.id}`, activityIdentity)
              ?.state === "running"
          )
        })
        if (checkIsRunning && !allChecksHaveReceipts) return undefined
        if (!allChecksHaveReceipts)
          throw new Error(`Owned adoption worktree changed; preserve ${workspace}`)
      }
      return workspace
    }
    if (!this.adoptionIsLive(adoption.id)) return undefined
    const workspace = canonicalProjectWorktreePath(
      this.directory,
      `adoption-${adoption.id}-${phase}`,
    )
    const effect = this.effect(
      plan.id,
      phase === "task" ? adoption.task_id : null,
      null,
      kind,
      { adoptionID: adoption.id, workspace, base },
      fence,
    )
    if (!this.adoptionIsLive(adoption.id)) {
      this.store.fenced(this.owner, fence, (db) =>
        db
          .query(
            "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed'),receipt=? WHERE id=? AND state='intended'",
          )
          .run(
            JSON.stringify({
              notSent: true,
              reason: "Adoption was cancelled before worktree creation",
            }),
            effect.id,
          ),
      )
      return undefined
    }
    try {
      const actual = await this.host.worktree({ directory: workspace, base })
      if (
        actual === this.directory ||
        git(actual, ["rev-parse", "HEAD"]) !== base ||
        (await gitAsync(actual, ["status", "--porcelain", "--untracked-files=all"])) ||
        git(actual, ["ls-files", "-u", "-z"])
      )
        throw new Error("Adoption worktree is not a clean exact-candidate checkout")
      this.receipt(effect, { workspace: actual, base }, fence)
      this.store.setAdoptionWorkspace(adoption.id, phase, actual, {
        owner: this.owner,
        value: fence,
      })
      return this.adoptionIsLive(adoption.id) ? actual : undefined
    } catch (error) {
      this.store.fenced(this.owner, fence, (db) =>
        db
          .query(
            "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'uncertain'),receipt=? WHERE id=?",
          )
          .run(JSON.stringify({ error: errorText(error) }), effect.id),
      )
      this.holdAdoption(
        plan,
        adoption.id,
        `Recovery uncertain for ${kind} ${effect.id}: ${errorText(error)}`,
        "pending",
        fence,
      )
      return undefined
    }
  }

  private adoptionCheckReceiptMatches(
    receipt: CheckReceipt,
    row: AdoptionCheckRow,
    check: TaskProposal["verification"][number],
  ): boolean {
    return (
      receipt.id === check.id &&
      receipt.command === check.command &&
      receipt.cwd === row.workspace &&
      receipt.artifact === row.artifact &&
      receipt.inputIdentity === row.artifact &&
      receipt.environmentIdentity === row.environment_identity
    )
  }

  private adoptionCheckInputMatches(
    adoption: AdoptionRow,
    phase: "task" | "combined",
    check: TaskProposal["verification"][number],
    row: AdoptionCheckRow,
    workspace: string,
    artifact: string,
  ): boolean {
    try {
      const recordedCheck = JSON.parse(row.check_json) as unknown
      // 309cfc6 fingerprints predate the separate authoredCheck field.
      const identity = {
        adoptionID: adoption.id,
        adoptionInputFingerprint: adoption.input_fingerprint,
        phase,
        check: recordedCheck,
        workspace,
        artifact,
        environmentIdentity: row.environment_identity,
      }
      const legacyInputFingerprint = fingerprint(identity)
      const currentInputFingerprint = fingerprint({
        ...identity,
        authoredCheck: check,
      })
      return (
        row.check_id === check.id &&
        row.workspace === workspace &&
        row.artifact === artifact &&
        sameVerificationCheckIdentity(recordedCheck, check) &&
        (row.input_fingerprint === legacyInputFingerprint ||
          row.input_fingerprint === currentInputFingerprint)
      )
    } catch {
      return false
    }
  }

  private async runAdoptionChecks(
    plan: PlanRow,
    adoption: AdoptionRow,
    phase: "task" | "combined",
    checks: TaskProposal["verification"],
    workspace: string,
    artifact: string,
    fence: number,
  ): Promise<CheckReceipt[] | undefined> {
    const receipts: CheckReceipt[] = []
    for (const check of checks) {
      if (!this.adoptionIsLive(adoption.id)) return undefined
      const effectiveCheck = verificationCheckWithDefaults(check, this.verificationTimeoutDefaults)
      const row = this.store
        .adoptionChecks(adoption.id, phase)
        .find((item) => item.check_id === check.id)
      const environmentIdentity = row?.environment_identity ?? verificationEnvironmentIdentity()
      const inputFingerprint = fingerprint({
        adoptionID: adoption.id,
        adoptionInputFingerprint: adoption.input_fingerprint,
        phase,
        authoredCheck: check,
        check: effectiveCheck,
        workspace,
        artifact,
        environmentIdentity,
      })
      const receiptPath = join(
        this.dataDirectory,
        "receipts",
        "adoptions",
        adoption.id,
        `${phase}-${check.id}.json`,
      )
      const activityID = `adoption:${adoption.id}:${phase}:${check.id}`
      if (row) {
        const activityIdentity = {
          adoptionID: adoption.id,
          phase,
          checkID: check.id,
          inputFingerprint: row.input_fingerprint,
          workspace: row.workspace,
          artifact: row.artifact,
          receiptPath: row.receipt_path,
        }
        if (
          row.workspace !== workspace ||
          row.artifact !== artifact ||
          !this.adoptionCheckInputMatches(adoption, phase, check, row, workspace, artifact) ||
          row.receipt_path !== receiptPath
        ) {
          this.holdAdoption(
            plan,
            adoption.id,
            `Adoption check ${phase}:${check.id} no longer matches its recorded command or workspace`,
            "held",
            fence,
          )
          return undefined
        }
        let previous: CheckReceipt | undefined
        try {
          if (row.state === "completed" && row.receipt)
            previous = JSON.parse(row.receipt) as CheckReceipt
          else if (existsSync(row.receipt_path))
            previous = JSON.parse(readFileSync(row.receipt_path, "utf8")) as CheckReceipt
        } catch {
          previous = undefined
        }
        if (previous && this.adoptionCheckReceiptMatches(previous, row, effectiveCheck)) {
          if (row.state !== "completed") {
            this.store.completeAdoptionCheck(adoption.id, phase, check.id, previous, {
              owner: this.owner,
              value: fence,
            })
          }
          forgetVerificationActivity(
            verificationActivityKey(this.store.repository.path, activityID),
            fingerprint(activityIdentity),
          )
          receipts.push(previous)
          if (!checkResourcesSettled(previous)) {
            this.holdAdoption(
              plan,
              adoption.id,
              `Adoption verification ${phase}:${check.id} completed with exit ${previous.exitCode ?? "unknown"} and timedOut=${previous.timedOut}, but subprocess cleanup is uncertain: ${previous.processCleanup?.detail ?? "termination was not confirmed"}`,
              "held",
              fence,
            )
            return undefined
          }
          if (!this.adoptionIsLive(adoption.id)) return undefined
          continue
        }
        const activity = this.checkActivity(activityID, activityIdentity)
        if (activity?.state === "running") return undefined
        if (row.state !== "completed")
          this.store.markAdoptionCheckUncertain(
            adoption.id,
            phase,
            check.id,
            activity?.state === "failed"
              ? `Verification subprocess did not settle conclusively: ${errorText(activity.error)}`
              : "No conclusive operation-bound check receipt; check was not repeated",
            { owner: this.owner, value: fence },
          )
        this.holdAdoption(
          plan,
          adoption.id,
          `Uncertain adoption check ${phase}:${check.id}; evidence was not replayed`,
          "pending",
          fence,
        )
        forgetVerificationActivity(
          verificationActivityKey(this.store.repository.path, activityID),
          fingerprint(activityIdentity),
        )
        return undefined
      }
      const candidateClean =
        existsSync(workspace) &&
        git(workspace, ["rev-parse", "HEAD"]) === artifact &&
        !(await gitAsync(workspace, ["status", "--porcelain", "--untracked-files=all"])) &&
        !git(workspace, ["ls-files", "-u", "-z"])
      if (!candidateClean) {
        this.holdAdoption(
          plan,
          adoption.id,
          `Adoption verification workspace is dirty or not the exact ${phase} artifact`,
          "held",
          fence,
        )
        return undefined
      }
      const checkRow = this.store.beginAdoptionCheck({
        adoptionID: adoption.id,
        phase,
        checkID: check.id,
        check: effectiveCheck,
        workspace,
        artifact,
        inputFingerprint,
        environmentIdentity,
        receiptPath,
        fence: { owner: this.owner, value: fence },
      })
      if (!this.adoptionIsLive(adoption.id)) return undefined
      try {
        const activityIdentity = {
          adoptionID: adoption.id,
          phase,
          checkID: check.id,
          inputFingerprint: checkRow.input_fingerprint,
          workspace: checkRow.workspace,
          artifact: checkRow.artifact,
          receiptPath: checkRow.receipt_path,
        }
        this.startCheckActivity({
          id: activityID,
          identity: activityIdentity,
          metadata: {
            kind: "adoption",
            projectDirectory: this.directory,
            planID: plan.id,
            activityID,
            adoptionID: adoption.id,
            phase,
            checkID: check.id,
          },
          run: (signal) =>
            runDeclaredCheck(workspace, artifact, effectiveCheck, receiptPath, { signal }),
        })
        return undefined
      } catch (error) {
        this.store.markAdoptionCheckUncertain(adoption.id, phase, check.id, errorText(error), {
          owner: this.owner,
          value: fence,
        })
        this.holdAdoption(
          plan,
          adoption.id,
          `Uncertain adoption check ${phase}:${check.id}: ${errorText(error)}`,
          "pending",
          fence,
        )
        return undefined
      }
    }
    return receipts
  }

  private async advanceAdoption(plan: PlanRow, initial: AdoptionRow, fence: number) {
    let adoption = this.store.adoption(initial.id)
    if (!adoption || !this.adoptionIsLive(adoption.id)) return
    let context: Awaited<ReturnType<TaskRuntime["validateAdoption"]>>
    try {
      context = await this.validateAdoption(plan.id, adoption)
    } catch (error) {
      this.holdAdoption(plan, adoption.id, errorText(error), "held", fence)
      return
    }
    if (!this.adoptionIsLive(adoption.id)) return
    const taskWorkspace = await this.ensureAdoptionWorkspace(
      plan,
      adoption,
      "task",
      adoption.descendant_commit,
      fence,
    )
    if (!taskWorkspace || !this.adoptionIsLive(adoption.id)) return
    this.store.setAdoptionState(adoption.id, "task-checks", null, {
      owner: this.owner,
      value: fence,
    })
    adoption = this.store.adoption(adoption.id)!
    const taskReceipts = await this.runAdoptionChecks(
      plan,
      adoption,
      "task",
      context.task.proposal.verification,
      taskWorkspace,
      adoption.descendant_commit,
      fence,
    )
    if (!taskReceipts || !this.adoptionIsLive(adoption.id)) return
    if (!artifactUnchanged(taskWorkspace, adoption.descendant_commit)) {
      this.holdAdoption(
        plan,
        adoption.id,
        "Adopted task candidate changed after its checks; authorize retained repair before capturing fixes",
        "held",
        fence,
      )
      return
    }
    if (
      taskReceipts.some(
        (receipt) =>
          !checkSucceeded(receipt) || receipt.inputIdentity !== adoption!.descendant_commit,
      )
    ) {
      this.holdAdoption(plan, adoption.id, "Task verification command failed", "held", fence)
      return
    }
    try {
      context = await this.validateAdoption(plan.id, adoption)
    } catch (error) {
      this.holdAdoption(plan, adoption.id, errorText(error), "held", fence)
      return
    }
    const combinedWorkspace = await this.ensureAdoptionWorkspace(
      plan,
      adoption,
      "combined",
      adoption.combined_artifact,
      fence,
    )
    if (!combinedWorkspace || !this.adoptionIsLive(adoption.id)) return
    this.store.setAdoptionState(adoption.id, "combined-checks", null, {
      owner: this.owner,
      value: fence,
    })
    adoption = this.store.adoption(adoption.id)!
    const combinedReceipts = await this.runAdoptionChecks(
      plan,
      adoption,
      "combined",
      context.input.verification,
      combinedWorkspace,
      adoption.combined_artifact,
      fence,
    )
    if (!combinedReceipts || !this.adoptionIsLive(adoption.id)) return
    if (!artifactUnchanged(combinedWorkspace, adoption.combined_artifact)) {
      this.holdAdoption(
        plan,
        adoption.id,
        "Adopted combined candidate changed after its checks; authorize retained repair before capturing fixes",
        "held",
        fence,
      )
      return
    }
    if (
      combinedReceipts.some(
        (receipt) =>
          !checkSucceeded(receipt) || receipt.inputIdentity !== adoption!.combined_artifact,
      )
    ) {
      this.holdAdoption(plan, adoption.id, "Combined verification command failed", "held", fence)
      return
    }
    try {
      context = await this.validateAdoption(plan.id, adoption)
    } catch (error) {
      this.holdAdoption(plan, adoption.id, errorText(error), "held", fence)
      return
    }
    const taskMissing = this.missingEvidence(
      plan.id,
      adoption.task_id,
      adoption.descendant_commit,
      taskWorkspace,
      context.task.proposal.acceptance,
      taskReceipts,
      adoption.id,
    )
    const combinedMissing = this.missingEvidence(
      plan.id,
      null,
      adoption.combined_artifact,
      combinedWorkspace,
      context.input.acceptance,
      combinedReceipts,
      adoption.id,
    )
    const missing = [
      ...taskMissing.map((item) => `task:${item}`),
      ...combinedMissing.map((item) => `combined:${item}`),
    ]
    if (missing.length) {
      const humanOnly = [...taskMissing, ...combinedMissing].every((item) =>
        item.endsWith(":human"),
      )
      this.holdAdoption(
        plan,
        adoption.id,
        `Required adoption evidence missing: ${missing.join(", ")}`,
        humanOnly ? "waiting-human" : "held",
        fence,
      )
      return
    }
    try {
      context = await this.validateAdoption(plan.id, adoption)
    } catch (error) {
      this.holdAdoption(plan, adoption.id, errorText(error), "held", fence)
      return
    }
    const publicationStatus = await gitAsync(this.directory, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ])
    this.store.fenced(this.owner, fence, (db) => {
      const current = this.store.adoption(adoption!.id)
      const currentPlan = this.store.plan(plan.id)
      const currentNode = this.store
        .nodes(plan.id)
        .find((node) => node.task_id === adoption!.task_id)
      const currentAttempt = db
        .query<
          Pick<AttemptRow, "id" | "state" | "artifact" | "session_id" | "workspace">,
          [string, string]
        >(
          `SELECT id,state,artifact,session_id,workspace FROM runner_attempts
           WHERE plan_id=? AND task_id=? ORDER BY number DESC LIMIT 1`,
        )
        .get(plan.id, adoption!.task_id)
      if (
        !current ||
        !currentPlan ||
        currentPlan.state !== "blocked" ||
        currentPlan.version !== context.plan.version ||
        currentPlan.owner !== context.plan.owner ||
        !["pending", "task-checks", "combined-checks", "waiting-human"].includes(current.state) ||
        !currentNode ||
        currentNode.state !== adoption!.node_state ||
        currentNode.artifact !== adoption!.old_artifact
      )
        return
      if (
        !currentAttempt ||
        currentAttempt.id !== adoption!.attempt_id ||
        currentAttempt.state !== adoption!.attempt_state ||
        currentAttempt.artifact !== adoption!.old_artifact ||
        currentAttempt.session_id !== context.attempt.session_id ||
        currentAttempt.workspace !== context.attempt.workspace
      ) {
        const reason = "Latest task attempt changed during adoption publication"
        const held = db
          .query(
            `UPDATE runner_adoptions SET state=lz_runner_transition('adoption',state,'held'),hold_reason=?,updated_at=?
             WHERE id=? AND state IN ('pending','task-checks','combined-checks','waiting-human')`,
          )
          .run(reason, Date.now(), adoption!.id).changes
        if (!held) return
        db.query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'blocked'),reason=?,version=version+1 WHERE id=? AND state='blocked'",
        ).run(reason, plan.id)
        this.store.record(plan.id, adoption!.task_id, "DESCENDANT_ADOPTION_HELD", {
          adoptionID: adoption!.id,
          reason,
          attemptID: currentAttempt?.id ?? null,
          attemptState: currentAttempt?.state ?? null,
        })
        return
      }
      if (
        git(this.directory, ["branch", "--show-current"]) !== adoption!.target_branch ||
        git(this.directory, ["rev-parse", "HEAD"]) !== adoption!.landing_head ||
        publicationStatus
      )
        return
      const activeWorker = this.conflictingActiveAttempt(adoption!.task_id)
      if (activeWorker) {
        const reason = "A conflicting worker prevents descendant adoption publication"
        const held = db
          .query(
            `UPDATE runner_adoptions SET state=lz_runner_transition('adoption',state,'held'),hold_reason=?,updated_at=?
             WHERE id=? AND state IN ('pending','task-checks','combined-checks','waiting-human')`,
          )
          .run(reason, Date.now(), adoption!.id).changes
        if (!held) return
        db.query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'blocked'),reason=?,version=version+1 WHERE id=? AND state='blocked'",
        ).run(reason, plan.id)
        this.store.record(plan.id, adoption!.task_id, "DESCENDANT_ADOPTION_HELD", {
          adoptionID: adoption!.id,
          reason,
          activeAttemptID: activeWorker.id,
        })
        return
      }
      if (currentNode.state === "accepted") {
        db.query(
          "UPDATE runner_nodes SET artifact=?,version=version+1 WHERE plan_id=? AND task_id=? AND state='accepted' AND artifact=?",
        ).run(adoption!.descendant_commit, plan.id, adoption!.task_id, adoption!.old_artifact)
      } else {
        db.query(
          "UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=? AND state=? AND artifact=?",
        ).run(
          adoption!.descendant_commit,
          plan.id,
          adoption!.task_id,
          adoption!.node_state,
          adoption!.old_artifact,
        )
        this.store.move(plan.id, adoption!.task_id, "ADOPT_ACCEPT")
      }
      this.store.record(plan.id, adoption!.task_id, "DESCENDANT_ADOPTED", {
        adoptionID: adoption!.id,
        attemptID: adoption!.attempt_id,
        oldArtifact: adoption!.old_artifact,
        descendantCommit: adoption!.descendant_commit,
        targetBranch: adoption!.target_branch,
        landingHead: adoption!.landing_head,
        reason: adoption!.reason,
        taskChecks: taskReceipts,
        combinedChecks: combinedReceipts,
      })
      const changed = db
        .query(
          `UPDATE runner_adoptions SET state=lz_runner_transition('adoption',state,'accepted'),hold_reason=NULL,updated_at=?
           WHERE id=? AND state IN ('pending','task-checks','combined-checks','waiting-human')`,
        )
        .run(Date.now(), adoption!.id).changes
      if (!changed) return
      db.query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'accepted'),reason=NULL,artifact=?,version=version+1 WHERE id=? AND state='blocked'",
      ).run(adoption!.combined_artifact, plan.id)
      this.store.record(plan.id, null, "PLAN_ACCEPTED", {
        artifact: adoption!.combined_artifact,
        checks: combinedReceipts,
        adoptionID: adoption!.id,
        taskArtifact: adoption!.descendant_commit,
      })
      this.outcome(
        plan.id,
        {
          status: "accepted",
          artifact: adoption!.combined_artifact,
          evidence: combinedReceipts,
          taskIDs: context.input.integrationOrder,
          adoptionID: adoption!.id,
        },
        true,
      )
    })
  }

  private failAttempt(
    plan: PlanRow,
    attempt: AttemptRow,
    reason: string,
    workerObservation?: TerminalWorkerHold,
  ) {
    const task = this.store.repository.get(attempt.task_id)!
    const node = this.store.nodes(plan.id).find((n) => n.task_id === task.id)!
    this.store.atomic((db) => {
      db.query(
        "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'failed') WHERE id=?",
      ).run(attempt.id)
      if (
        node.state === "verifying" &&
        (task.proposal.limits?.maxRepairAttempts ?? 1) > 0 &&
        !JSON.parse(attempt.policy).repairAttempt &&
        !this.retainedRepairForAttempt(attempt)
      )
        this.store.move(plan.id, task.id, "REPAIR", reason)
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
  private async finish(plan: PlanRow, fence: number) {
    if (this.store.plan(plan.id)?.state !== "running") return
    if (
      this.store.atomic((db) =>
        retainedVerificationsForPlan(db, this.directory, plan.id).some((operation) =>
          this.retainedCombinedGatePending(operation),
        ),
      )
    )
      return
    const verificationPlanVersion = this.store.plan(plan.id)!.version
    const sourceGeneration = this.retainedRepairGeneration(plan.id)
    const input = PlanInput.parse(JSON.parse(plan.body))
    const reconcileTransition = this.store.latestTransition<Record<string, unknown>>(
      plan.id,
      null,
      "RECONCILE_REQUESTED",
    )
    const requestedContinuation = reconcileTransition?.combinedVerificationContinuation
    const continuation = parseCombinedVerificationContinuation(requestedContinuation)
    if (requestedContinuation !== undefined && !continuation) {
      this.hold(plan, "Combined verification continuation binding is invalid")
      return
    }
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
    const continuationInputsCurrent = (candidateArtifact: string) => {
      if (!continuation) return true
      const currentPlan = this.store.plan(plan.id)
      if (
        !currentPlan ||
        currentPlan.state !== "running" ||
        currentPlan.version !== continuation.resumedPlanVersion ||
        currentPlan.owner !== continuation.owner ||
        currentPlan.revision !== continuation.planRevision ||
        fingerprint(currentPlan.body) !== continuation.planBodyFingerprint ||
        this.store.planControlEpoch(plan.id) !== continuation.ownerEpoch ||
        continuation.projectDirectory !== this.directory ||
        continuation.projectID !== this.projectID ||
        continuation.planID !== plan.id ||
        continuation.verificationEpoch !== verificationEpoch ||
        continuation.artifact !== candidateArtifact ||
        continuation.sourceGeneration !== (this.retainedRepairGeneration(plan.id) ?? null)
      )
        return false
      try {
        const acceptedArtifacts = this.acceptedCombinedArtifacts(
          currentPlan,
          PlanInput.parse(JSON.parse(currentPlan.body)),
        )
        const interruptedEffects = continuation.interruptedEffects.every((expected) => {
          const effect = this.store
            .effects(plan.id)
            .find((candidate) => candidate.id === expected.id)
          return Boolean(
            effect?.state === "failed" &&
            fingerprint(effect.payload) === expected.payloadFingerprint &&
            fingerprint(effect.receipt) === expected.receiptFingerprint,
          )
        })
        const settledTimeouts = (continuation.settledTimeouts ?? []).every((expected) => {
          const effect = this.store
            .effects(plan.id)
            .find((candidate) => candidate.id === expected.id)
          return Boolean(
            effect?.state === "completed" &&
            fingerprint(effect.payload) === expected.payloadFingerprint &&
            fingerprint(effect.receipt) === expected.receiptFingerprint,
          )
        })
        const { inputFingerprint: _inputFingerprint, ...bindingData } = continuation
        const currentBinding: CombinedVerificationContinuationBinding = {
          ...bindingData,
          owner: currentPlan.owner,
          ownerEpoch: this.store.planControlEpoch(plan.id),
          planRevision: currentPlan.revision,
          resumedPlanVersion: currentPlan.version,
          planBodyFingerprint: fingerprint(currentPlan.body),
          acceptedArtifacts,
          artifact: candidateArtifact,
          sourceGeneration: this.retainedRepairGeneration(plan.id) ?? null,
        }
        return Boolean(
          interruptedEffects &&
          settledTimeouts &&
          fingerprint(currentBinding) === continuation.inputFingerprint &&
          existsSync(continuation.workspace) &&
          git(continuation.workspace, ["rev-parse", "HEAD"]) === candidateArtifact &&
          artifactUnchanged(continuation.workspace, candidateArtifact),
        )
      } catch {
        return false
      }
    }
    const continuationEffectsCurrent = (candidateArtifact: string) => {
      if (!continuation) return true
      const checks = new Map(input.verification.map((check) => [check.id, check]))
      const unresolvedEffectIDs = new Set<string>()
      for (const effect of this.store.effects(plan.id)) {
        if (
          !(["intended", "uncertain"] as const).includes(effect.state as "intended" | "uncertain")
        )
          continue
        if (
          effect.task_id !== null ||
          effect.attempt_id !== null ||
          !effect.kind.startsWith("graph-verify:")
        )
          return false
        const check = checks.get(effect.kind.slice("graph-verify:".length))
        if (!check) return false
        try {
          const payload: unknown = JSON.parse(effect.payload)
          const deadline = this.verificationDeadline(
            this.verificationTarget(plan, "combined", check, candidateArtifact, null, null, null),
          )
          if (
            !isRecord(payload) ||
            payload.artifact !== candidateArtifact ||
            payload.identity !== candidateArtifact ||
            payload.workspace !== continuation.workspace ||
            (payload.sourceGeneration ?? undefined) !==
              (continuation.sourceGeneration ?? undefined) ||
            payload.verificationEpoch !== continuation.verificationEpoch ||
            payload.combinedContinuationFingerprint !== continuation.inputFingerprint ||
            fingerprint(payload.authoredCheck ?? payload.check) !== fingerprint(check) ||
            fingerprint(payload.check) !== fingerprint(effectiveVerificationCheck(check, deadline))
          )
            return false
          unresolvedEffectIDs.add(effect.id)
        } catch {
          return false
        }
      }
      if (
        verificationActivitiesForDatabase(this.store.repository.path).some(
          (activity) =>
            activity.metadata.planID === plan.id &&
            activity.state === "running" &&
            (typeof activity.metadata.effectID !== "string" ||
              !unresolvedEffectIDs.has(activity.metadata.effectID)),
        ) ||
        this.store.atomic(
          (db) => activeRetainedVerifications(db, this.directory, plan.id).length > 0,
        ) ||
        this.store.activeAdoptions(plan.id).length > 0
      )
        return false
      return true
    }
    const acceptedInputsCurrent = () =>
      acceptedNodesCurrent() &&
      (!continuation ||
        (continuationInputsCurrent(artifact) && continuationEffectsCurrent(artifact)))
    try {
      artifact = await combineArtifacts(this.directory, input.baseCommit, branches)
    } catch (error) {
      if (!acceptedNodesCurrent()) return
      this.hold(plan, `Combined artifact conflict: ${errorText(error)}`)
      return
    }
    if (!acceptedNodesCurrent()) return
    if (
      continuation &&
      (!continuationInputsCurrent(artifact) || !continuationEffectsCurrent(artifact))
    ) {
      if (this.store.plan(plan.id)?.state === "running")
        this.hold(
          plan,
          "Combined verification continuation inputs or unresolved effects changed; preserve the candidate",
        )
      return
    }
    if (!acceptedInputsCurrent()) {
      if (continuation && this.store.plan(plan.id)?.state === "running")
        this.hold(
          plan,
          "Combined verification continuation inputs or unresolved effects changed; preserve the candidate",
        )
      return
    }
    const attempts = this.store.attempts(plan.id)
    const shared =
      JSON.parse(plan.body).workspaceMode === undefined
        ? attempts.at(-1)?.workspace === this.directory
        : input.workspaceMode === "shared"
    let workspace = continuation?.workspace ?? this.directory
    if (continuation) {
      if (
        !existsSync(workspace) ||
        git(workspace, ["rev-parse", "HEAD"]) !== artifact ||
        !artifactUnchanged(workspace, artifact)
      ) {
        this.hold(plan, "Interrupted combined verification candidate changed; preserve it")
        return
      }
    } else if (!shared || !artifactUnchanged(this.directory, artifact)) {
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
        artifactUnchanged(matchingAttempt.workspace, artifact)
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
          if (git(actual, ["rev-parse", "HEAD"]) !== artifact)
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
      if (!acceptedInputsCurrent()) {
        if (continuation && this.store.plan(plan.id)?.state === "running")
          this.hold(
            plan,
            "Combined verification continuation inputs or unresolved effects changed; preserve the candidate",
          )
        return
      }
      const existing = this.store.effects(plan.id).find((e) => {
        if (e.kind !== `graph-verify:${check.id}`) return false
        try {
          const payload = JSON.parse(e.payload) as {
            artifact?: unknown
            workspace?: unknown
            sourceGeneration?: unknown
            verificationEpoch?: number
            combinedContinuationFingerprint?: unknown
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
            (continuation
              ? payload.combinedContinuationFingerprint === continuation.inputFingerprint ||
                (previous !== undefined && payload.combinedContinuationFingerprint === undefined)
              : payload.combinedContinuationFingerprint === undefined) &&
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
          ...(continuation
            ? { combinedContinuationFingerprint: continuation.inputFingerprint }
            : {}),
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
      this.hold(plan, "Combined artifact verification failed")
      return
    }
    if (!artifactUnchanged(workspace, artifact)) {
      this.hold(plan, "Combined candidate changed after verification")
      return
    }
    const missing = this.missingEvidence(
      plan.id,
      null,
      artifact,
      workspace,
      input.acceptance,
      receipts,
      undefined,
      sourceGeneration,
    )
    if (missing.length) {
      this.hold(plan, `Combined artifact evidence missing: ${missing.join(", ")}`)
      return
    }
    if (!acceptedInputsCurrent()) {
      if (continuation && this.store.plan(plan.id)?.state === "running")
        this.hold(
          plan,
          "Combined verification continuation inputs or unresolved effects changed; preserve the candidate",
        )
      return
    }
    this.store.fenced(this.owner, fence, (db) => {
      if (!acceptedInputsCurrent()) return
      db.query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'accepted'),artifact=?,version=version+1 WHERE id=?",
      ).run(artifact, plan.id)
      this.store.record(plan.id, null, "PLAN_ACCEPTED", { artifact, checks: receipts })
      this.outcome(
        plan.id,
        { status: "accepted", artifact, evidence: receipts, taskIDs: input.integrationOrder },
        true,
      )
    })
  }
  private assertAdoptionWorkspaceQuiescent(
    plan: PlanRow,
    effect: EffectRow,
    workspace: string,
    allowCancelled = false,
  ) {
    const payload = JSON.parse(effect.payload) as { adoptionID?: unknown }
    if (typeof payload.adoptionID !== "string")
      throw new Error("Adoption worktree ownership is missing; preserve the workspace")
    const adoption = this.store.adoption(payload.adoptionID)
    const phase = effect.kind === "adoption-task-worktree" ? "task" : "combined"
    const expectedWorkspace =
      phase === "task" ? adoption?.task_workspace : adoption?.combined_workspace
    if (
      !adoption ||
      adoption.plan_id !== plan.id ||
      (adoption.state !== "accepted" && !(allowCancelled && adoption.state === "cancelled")) ||
      expectedWorkspace !== workspace
    )
      throw new Error("Adoption worktree is not owned by an accepted adoption; preserve it")
    const task = this.store.repository.get(adoption.task_id)
    const checks =
      phase === "task"
        ? task?.proposal.verification
        : PlanInput.parse(JSON.parse(plan.body)).verification
    if (!checks) throw new Error("Adoption check procedure is missing; preserve the workspace")
    const rows = this.store.adoptionChecks(adoption.id, phase)
    if (rows.length !== checks.length)
      throw new Error("Adoption worktree has no complete receipt for every check; preserve it")
    const artifact = phase === "task" ? adoption.descendant_commit : adoption.combined_artifact
    for (const check of checks) {
      const row = rows.find((item) => item.check_id === check.id)
      let receipt: CheckReceipt | undefined
      try {
        if (row?.receipt) receipt = JSON.parse(row.receipt) as CheckReceipt
      } catch {
        receipt = undefined
      }
      if (
        !row ||
        row.state !== "completed" ||
        !this.adoptionCheckInputMatches(adoption, phase, check, row, workspace, artifact) ||
        !receipt ||
        !this.adoptionCheckReceiptMatches(receipt, row, check)
      )
        throw new Error(
          "Adoption worktree check activity is not conclusively complete; preserve it",
        )
    }
  }

  private assertGraphWorkspaceQuiescent(plan: PlanRow, workspace: string, allowCancelled = false) {
    const source = this.store.effects(plan.id).find((effect) => {
      if (effect.kind !== "graph-worktree" || effect.state !== "completed") return false
      try {
        return JSON.parse(effect.receipt ?? "{}").workspace === workspace
      } catch {
        return false
      }
    })
    let sourceArtifact: unknown
    try {
      sourceArtifact = JSON.parse(source?.receipt ?? "{}").base
    } catch {
      sourceArtifact = undefined
    }
    const artifact = plan.artifact ?? (allowCancelled ? sourceArtifact : undefined)
    if (typeof artifact !== "string")
      throw new Error("Combined artifact is missing; preserve the workspace")
    const checks = PlanInput.parse(JSON.parse(plan.body)).verification
    const effects = this.store.effects(plan.id)
    for (const check of checks) {
      const matches = effects.filter((effect) => {
        if (effect.kind !== `graph-verify:${check.id}`) return false
        try {
          const payload = JSON.parse(effect.payload) as { workspace?: unknown; artifact?: unknown }
          return payload.workspace === workspace && payload.artifact === artifact
        } catch {
          return false
        }
      })
      const effect = matches.at(-1)
      let receipt: CheckReceipt | undefined
      let payload: { check?: unknown } | undefined
      try {
        if (effect) {
          payload = JSON.parse(effect.payload) as typeof payload
          const body = JSON.parse(effect.receipt ?? "{}") as { check?: CheckReceipt }
          receipt = body.check
        }
      } catch {
        receipt = undefined
      }
      if (
        !effect ||
        effect.state !== "completed" ||
        !sameVerificationCheckIdentity(payload?.check, check) ||
        !receipt ||
        receipt.id !== check.id ||
        receipt.command !== check.command ||
        receipt.cwd !== workspace ||
        receipt.artifact !== artifact ||
        receipt.inputIdentity !== artifact
      )
        throw new Error(
          "Combined worktree check activity is not conclusively complete; preserve it",
        )
    }
  }

  private async assertWorktreeQuiescent(
    plan: PlanRow,
    effect: EffectRow,
    workspace: string,
    allowCancelled = false,
  ): Promise<NativeCleanupSettlement | undefined> {
    if (effect.kind.startsWith("adoption-")) {
      if (this.store.attempts(plan.id).some((attempt) => attempt.workspace === workspace))
        throw new Error("Adoption worktree unexpectedly has an attempt owner; preserve it")
      this.assertAdoptionWorkspaceQuiescent(plan, effect, workspace, allowCancelled)
      return undefined
    }
    if (effect.kind === "graph-worktree") {
      if (this.store.attempts(plan.id).some((attempt) => attempt.workspace === workspace))
        throw new Error("Combined worktree unexpectedly has an attempt owner; preserve it")
      this.assertGraphWorkspaceQuiescent(plan, workspace, allowCancelled)
      return undefined
    }
    const attempts = this.store
      .attempts(plan.id)
      .filter((attempt) => attempt.workspace === workspace)
    if (!attempts.length)
      throw new Error("Owned worktree has no matching attempt; preserve it for reconciliation")
    let recoverySettlement: NativeCleanupSettlement | undefined
    for (const attempt of attempts) {
      const session = await this.host.session(attempt.session_id, { messages: true })
      // RunnerHost null is authoritative native not-found. Current session and
      // background uncertainty still fail closed below; a missing historical
      // worker cannot keep its already-merged checkout forever.
      if (!session) {
        if (this.cleanupRecoveryAuthorization(plan, attempt, effect, workspace))
          throw new Error(
            "Native worker session is unavailable for cleanup recovery; preserve the worktree and reconcile the session binding",
          )
        continue
      }
      const backgroundReason = this.backgroundBlockReason(session, attempt, true)
      let settlement: NativeCleanupSettlement | undefined
      const authorization = this.cleanupRecoveryAuthorization(plan, attempt, effect, workspace)
      if (authorization) {
        if (!this.host.cleanupSettlement)
          throw new Error(
            "Fresh native cleanup settlement is unsupported by this host; preserve the worktree and wait for a new experimental.idle observation",
          )
        const settlementRequestedAt = Date.now()
        settlement = await this.host.cleanupSettlement({
          projectID: this.projectID,
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace: attempt.workspace,
          assignedMessageID: attempt.message_id,
        })
        if (
          settlement.schemaVersion !== 1 ||
          settlement.projectID !== this.projectID ||
          settlement.attemptID !== attempt.id ||
          settlement.sessionID !== attempt.session_id ||
          settlement.workspace !== attempt.workspace ||
          settlement.assignedMessageID !== attempt.message_id ||
          settlement.inputID !== attempt.message_id ||
          settlement.observedAt < settlementRequestedAt - 1_000 ||
          settlement.observedAt > this.now() + 1_000 ||
          settlement.inventory.activeSession !== false ||
          settlement.inventory.activeDescendants !== 0 ||
          settlement.inventory.pendingInput !== false ||
          settlement.inventory.pendingPermissions !== 0 ||
          settlement.inventory.pendingForms !== 0 ||
          settlement.inventory.runningShells !== 0 ||
          settlement.idleReport.source !== "experimental.idle" ||
          !Number.isFinite(settlement.idleReport.observedAt) ||
          settlement.idleReport.observedAt > settlement.observedAt ||
          settlement.idleReport.inputID !== attempt.message_id ||
          !Number.isSafeInteger(settlement.idleReport.executionStartSequence) ||
          settlement.idleReport.executionStartSequence < 0 ||
          !Number.isSafeInteger(settlement.idleReport.eventSequence) ||
          settlement.idleReport.eventSequence < settlement.idleReport.executionStartSequence ||
          settlement.idleReport.count !== 0 ||
          settlement.idleReport.kinds.shell !== 0 ||
          settlement.idleReport.kinds.subagent !== 0 ||
          settlement.idleReport.kinds.image !== 0 ||
          !Number.isSafeInteger(settlement.terminal.previousEventSequence) ||
          settlement.terminal.previousEventSequence !== settlement.idleReport.eventSequence ||
          settlement.terminal.sequence <= settlement.idleReport.eventSequence ||
          !Number.isSafeInteger(settlement.terminal.sequence) ||
          settlement.terminal.sequence < 0 ||
          !settlement.terminal.eventID ||
          !settlement.terminal.messageID
        )
          throw new Error(
            "Fresh native cleanup settlement did not match the held worker assignment",
          )
        let terminalMessageID: string | undefined
        try {
          terminalMessageID = SessionMessage.ID.fromEvent(settlement.terminal.eventID)
        } catch {
          terminalMessageID = undefined
        }
        if (terminalMessageID !== settlement.terminal.messageID)
          throw new Error("Fresh native cleanup terminal event/message binding is invalid")
        recoverySettlement = settlement
      }
      const blockers: string[] = []
      if (session.id !== attempt.session_id) blockers.push("session identity changed")
      if (session.projectID !== this.projectID) blockers.push("project identity changed")
      if (session.directory !== workspace) blockers.push("worker location changed")
      if (!isWorkerAgent(session.agent)) blockers.push("session is no longer an implementor")
      if (session.metadata?.lazersAttemptID !== attempt.id)
        blockers.push("attempt ownership changed")
      if (session.busy !== false) blockers.push("worker execution is active or unknown")
      if (session.pendingInput === true) blockers.push("worker has pending input")
      if (session.observationUnstable) blockers.push("native worker observation is unstable")
      if ((session.pendingPermissions ?? 0) !== 0)
        blockers.push("worker has pending permission requests")
      if ((session.pendingForms ?? 0) !== 0) blockers.push("worker has pending forms")
      if (!session.outcome) blockers.push("worker outcome is unknown")
      if (settlement && session.turn?.inputID && session.turn.inputID !== settlement.inputID)
        blockers.push("native settlement input does not match the current worker turn")
      if (!["completed", "interrupted"].includes(session.turn?.state ?? "unknown"))
        blockers.push("worker turn is not conclusively terminal")
      if (
        backgroundReason &&
        !settlement &&
        !this.isPriorContinuationBackground(attempt, session.background, session.turn?.inputID)
      )
        blockers.push(backgroundReason)
      if (blockers.length)
        throw new Error(
          `Owned worktree worker is not conclusively idle; preserve it: ${blockers.join("; ")}`,
        )
    }
    return recoverySettlement
  }

  private cleanupRecoveryAuthorization(
    plan: PlanRow,
    attempt: AttemptRow,
    source: EffectRow,
    workspace: string,
  ): CleanupRecoveryAuthorization | undefined {
    const authorization = this.store.latestTransition<CleanupRecoveryAuthorization>(
      plan.id,
      attempt.task_id,
      "WORKTREE_CLEANUP_RECOVERY_AUTHORIZED",
    )
    if (!authorization) return undefined
    const node = this.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)
    const proposal = PlanInput.parse(JSON.parse(plan.body))
    const proposedNode = proposal.nodes.find((item) => item.taskID === attempt.task_id)
    const task = this.store.repository.get(attempt.task_id)
    const latestAttempt = this.store
      .attempts(plan.id)
      .filter((candidate) => candidate.task_id === attempt.task_id)
      .at(-1)
    const taskIntegration = this.store.latestTransition<{ artifact?: string; branch?: string }>(
      plan.id,
      attempt.task_id,
      "TASK_INTEGRATION_RECORDED",
    )
    const planIntegration = this.store.latestTransition<{ artifact?: string; branch?: string }>(
      plan.id,
      null,
      "INTEGRATION_RECORDED",
    )
    const integrationStillRecorded =
      (taskIntegration?.artifact === attempt.artifact &&
        taskIntegration.branch === authorization.targetBranch) ||
      (planIntegration?.artifact === plan.artifact &&
        planIntegration.branch === authorization.targetBranch)
    const valid =
      authorization.schemaVersion === 1 &&
      authorization.projectDirectory === this.directory &&
      authorization.planID === plan.id &&
      authorization.planRevision === plan.revision &&
      authorization.planArtifact === plan.artifact &&
      authorization.taskID === attempt.task_id &&
      authorization.taskRevision === proposedNode?.revision &&
      authorization.attemptID === attempt.id &&
      authorization.artifact === attempt.artifact &&
      authorization.workspace === workspace &&
      authorization.workspace === attempt.workspace &&
      authorization.sourceEffectID === source.id &&
      authorization.sessionID === attempt.session_id &&
      authorization.assignedMessageID === attempt.message_id &&
      authorization.owner === plan.owner &&
      authorization.ownerEpoch === this.store.planControlEpoch(plan.id) &&
      authorization.requestID.length > 0 &&
      authorization.reason.trim().length > 0 &&
      ["worktree", "worktree-recovery"].includes(source.kind) &&
      source.state === "completed" &&
      source.attempt_id === attempt.id &&
      node?.state === "accepted" &&
      node.artifact === attempt.artifact &&
      attempt.state === "accepted" &&
      latestAttempt?.id === attempt.id &&
      task?.revision === proposedNode?.revision &&
      task.provenance.projectID === this.projectID &&
      task.provenance.projectDirectory === this.directory &&
      integrationStillRecorded &&
      this.store.repository.taskDisposition(attempt.task_id) === undefined
    if (!valid)
      throw new Error(
        "Cleanup recovery authorization is stale or no longer matches the accepted attempt; preserve the worktree and have the current owner revalidate before retrying recover-cleanup",
      )
    try {
      if (git(this.directory, ["branch", "--show-current"]) !== authorization.targetBranch)
        throw new Error("current checkout is not the recorded integration branch")
      git(this.directory, ["merge-base", "--is-ancestor", authorization.artifact, "HEAD"])
    } catch (error) {
      throw new Error(
        `Cleanup recovery integration evidence is no longer valid (${errorText(error)}); preserve the worktree and have the current owner revalidate before retrying recover-cleanup`,
        { cause: error },
      )
    }
    return authorization
  }

  private appendCleanupSettlement(
    effect: EffectRow,
    authorization: CleanupRecoveryAuthorization,
    settlement: NativeCleanupSettlement,
    fence: number,
  ) {
    this.store.fenced(this.owner, fence, (db) => {
      const current = db
        .query<{ state: string; receipt: string | null }, [string, string]>(
          "SELECT state,receipt FROM runner_effects WHERE id=? AND plan_id=?",
        )
        .get(effect.id, effect.plan_id)
      if (!current || !["held", "intended", "uncertain"].includes(current.state))
        throw new Error("Native cleanup effect changed before settlement evidence was recorded")
      const receipt = appendRunnerEffectReceipt(current.receipt, {
        schema: "lazers-native-cleanup-settlement/v1",
        authorization: {
          requestID: authorization.requestID,
          owner: authorization.owner,
          ownerEpoch: authorization.ownerEpoch,
          taskID: authorization.taskID,
          attemptID: authorization.attemptID,
          artifact: authorization.artifact,
          workspace: authorization.workspace,
        },
        settlement,
      })
      const changed = db
        .query(
          "UPDATE runner_effects SET receipt=? WHERE id=? AND plan_id=? AND state IN ('held','intended','uncertain')",
        )
        .run(receipt, effect.id, effect.plan_id).changes
      if (changed !== 1)
        throw new Error("Native cleanup settlement evidence lost its durable effect row")
      this.store.record(effect.plan_id, effect.task_id, "WORKTREE_CLEANUP_SETTLEMENT_OBSERVED", {
        effectID: effect.id,
        requestID: authorization.requestID,
        attemptID: authorization.attemptID,
        sessionID: authorization.sessionID,
        workspace: authorization.workspace,
        terminalSequence: settlement.terminal.sequence,
        terminalEventID: settlement.terminal.eventID,
        observedAt: settlement.observedAt,
      })
    })
  }

  private completeWorktreeRemoval(effect: EffectRow, receipt: unknown, fence: number) {
    this.store.fenced(this.owner, fence, (db) => {
      const current = db
        .query<{ state: string; receipt: string | null }, [string, string]>(
          "SELECT state,receipt FROM runner_effects WHERE id=? AND plan_id=?",
        )
        .get(effect.id, effect.plan_id)
      if (!current || !["intended", "uncertain"].includes(current.state))
        throw new Error("Native cleanup effect changed before removal completion was recorded")
      const completion = {
        schema: "lazers-worktree-cleanup-completion/v1",
        ...(isRecord(receipt) ? receipt : { result: receipt }),
      }
      const appended = JSON.parse(appendRunnerEffectReceipt(current.receipt, completion)) as Record<
        string,
        unknown
      >
      const next = JSON.stringify({
        ...appended,
        ...(isRecord(receipt) ? receipt : { result: receipt }),
      })
      const changed = db
        .query(
          "UPDATE runner_effects SET state='completed',receipt=? WHERE id=? AND plan_id=? AND state IN ('intended','uncertain')",
        )
        .run(next, effect.id, effect.plan_id).changes
      if (changed !== 1) throw new Error("Native cleanup completion lost its durable effect row")
      this.store.record(effect.plan_id, effect.task_id, "EFFECT_COMPLETED", {
        effectID: effect.id,
        kind: effect.kind,
      })
    })
  }

  private abandonCleanupEffect(effect: EffectRow, fence: number) {
    this.store.fenced(this.owner, fence, (db) => {
      const plan = db
        .query<{ state: string }, [string]>("SELECT state FROM runner_plans WHERE id=?")
        .get(effect.plan_id)
      if (plan?.state === "cleaning") return
      const changed = db
        .query(
          "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed'),receipt=? WHERE id=? AND state IN ('intended','uncertain')",
        )
        .run(
          JSON.stringify({ notSent: true, reason: "Cleanup was superseded before removal" }),
          effect.id,
        ).changes
      if (changed)
        this.store.record(effect.plan_id, null, "EFFECT_NOT_SENT", {
          effectID: effect.id,
          kind: effect.kind,
          reason: "Cleanup was superseded before removal",
        })
    })
  }
  private async retireCleanedWorktreeLocation(
    plan: PlanRow,
    workspace: string,
    cleanupCurrent: () => boolean,
  ) {
    const retire = this.host.retireWorktreeLocation
    if (!retire) return "unsupported"
    const target = resolve(workspace)
    if (target === resolve(this.directory)) return "shared-checkout"
    if (!cleanupCurrent()) return "superseded"
    if (this.store.activeProjectAttempts().some((attempt) => resolve(attempt.workspace) === target))
      return "reserved-by-other-attempt"
    try {
      const native = await this.host.worktrees()
      if (!cleanupCurrent()) return "superseded"
      if (native.some((directory) => resolve(directory) === target))
        return "native-resource-present"
      const gitWorktrees = git(this.directory, ["worktree", "list", "--porcelain"])
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => resolve(line.slice("worktree ".length)))
      if (gitWorktrees.includes(target)) return "git-resource-present"
      try {
        lstatSync(target)
        return "filesystem-resource-present"
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") return "unavailable"
      }
      if (!cleanupCurrent()) return "superseded"
      const result: WorktreeLocationRetirement = await retire.call(this.host, target)
      return cleanupCurrent() ? result : "superseded"
    } catch {
      return "unavailable"
    }
  }
  private pendingOwnedWorktreeCleanup(plan: PlanRow): boolean {
    const creationKinds = new Set([
      "worktree",
      "worktree-recovery",
      "graph-worktree",
      "adoption-task-worktree",
      "adoption-combined-worktree",
    ])
    const effects = this.store.effects(plan.id)
    return effects.some((effect) => {
      if (!creationKinds.has(effect.kind) || effect.state !== "completed" || !effect.receipt)
        return false
      try {
        const workspace = JSON.parse(effect.receipt).workspace
        return (
          typeof workspace === "string" &&
          !effects.some(
            (candidate) =>
              candidate.kind === "worktree-remove" &&
              JSON.parse(candidate.payload).workspace === workspace &&
              candidate.state === "completed",
          )
        )
      } catch {
        return false
      }
    })
  }

  private worktreeCleanupRetryFacts(plan: PlanRow, source: EffectRow, workspace: string): string {
    const target = resolve(workspace)
    const effects = this.store
      .effects(plan.id)
      .filter((effect) => effect.kind !== "worktree-remove")
    const attempts = this.store
      .attempts(plan.id)
      .filter((attempt) => resolve(attempt.workspace) === target)
    const sessions = attempts.map((attempt) => ({
      sessionID: attempt.session_id,
      assignment: this.progress.assignmentForSession(attempt.session_id) ?? null,
    }))
    const idleRevisions = this.store.atomic((db) => {
      if (!attempts.length) return []
      const sessionIDs = attempts.map((attempt) => attempt.session_id)
      try {
        const rows = db
          .query<{ session_id: string; revision: number }, [string, ...string[]]>(
            `SELECT session_id,revision FROM runner_native_idle
             WHERE project_directory=? AND session_id IN (${sessionIDs.map(() => "?").join(",")})
             ORDER BY session_id`,
          )
          .all(this.directory, ...sessionIDs)
        const revisions = new Map(rows.map((row) => [row.session_id, row.revision]))
        return sessionIDs.map((sessionID) => [sessionID, revisions.get(sessionID) ?? null])
      } catch {
        // Old databases or unavailable native-idle storage rely on the bounded native fallback.
        return null
      }
    })
    const owners = this.store.atomic((db) =>
      db
        .query<
          { plan_id: string; id: string; task_id: string; session_id: string; state: string },
          [string, string]
        >(
          `SELECT plan_id,id,task_id,session_id,state FROM runner_attempts
           WHERE project_directory=? AND workspace=? ORDER BY plan_id,id`,
        )
        .all(this.directory, workspace),
    )
    const cleanupRecoveryAuthorizations = this.store.atomic((db) => {
      const attemptIDs = new Set(attempts.map((attempt) => attempt.id))
      return db
        .query<{ task_id: string | null; payload: string }, [string]>(
          `SELECT task_id,payload FROM runner_transitions
           WHERE plan_id=? AND event='WORKTREE_CLEANUP_RECOVERY_AUTHORIZED' ORDER BY id`,
        )
        .all(plan.id)
        .filter((row) => {
          try {
            return attemptIDs.has(JSON.parse(row.payload).attemptID)
          } catch {
            return true
          }
        })
    })
    let adoptionFacts: unknown = null
    try {
      const payload = JSON.parse(source.payload) as { adoptionID?: unknown }
      if (typeof payload.adoptionID === "string") {
        const adoption = this.store.adoption(payload.adoptionID)
        adoptionFacts = {
          id: adoption?.id ?? null,
          state: adoption?.state ?? null,
          taskWorkspace: adoption?.task_workspace ?? null,
          combinedWorkspace: adoption?.combined_workspace ?? null,
          checks: (["task", "combined"] as const).flatMap((phase) =>
            this.store.adoptionChecks(payload.adoptionID as string, phase).map((check) => ({
              phase,
              checkID: check.check_id,
              state: check.state,
              receipt: check.receipt ? fingerprint(check.receipt) : null,
            })),
          ),
        }
      }
    } catch {
      adoptionFacts = { unavailable: true }
    }

    return fingerprint({
      plan: { id: plan.id, revision: plan.revision, owner: plan.owner, artifact: plan.artifact },
      workspace: target,
      workspaceExists: existsSync(workspace),
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        taskID: attempt.task_id,
        state: attempt.state,
        messageID: attempt.message_id,
        sessionID: attempt.session_id,
        artifact: attempt.artifact,
      })),
      sessions,
      idleRevisions,
      owners,
      cleanupRecoveryAuthorizations,
      adoptionFacts,
      source: {
        kind: source.kind,
        payload: fingerprint(source.payload),
        receipt: source.receipt ? fingerprint(source.receipt) : null,
      },
      effects: effects.map((effect) => ({
        id: effect.id,
        kind: effect.kind,
        state: effect.state,
        payload: fingerprint(effect.payload),
        receipt: effect.receipt ? fingerprint(effect.receipt) : null,
      })),
    })
  }

  private async worktreeCleanupFactsChanged(plan: PlanRow): Promise<boolean> {
    const creationKinds = new Set([
      "worktree",
      "worktree-recovery",
      "graph-worktree",
      "adoption-task-worktree",
      "adoption-combined-worktree",
    ])
    const effects = this.store.effects(plan.id)
    for (const source of effects) {
      if (!creationKinds.has(source.kind) || source.state !== "completed" || !source.receipt)
        continue
      let workspace: string | undefined
      try {
        workspace = JSON.parse(source.receipt).workspace
      } catch {
        continue
      }
      if (typeof workspace !== "string") continue
      const removal = effects.find(
        (effect) =>
          effect.kind === "worktree-remove" && JSON.parse(effect.payload).workspace === workspace,
      )
      if (!removal) return true
      if (removal.state === "completed") continue
      let previousFacts: unknown
      let previousCheckedAt: unknown
      try {
        const receipt = JSON.parse(removal.receipt ?? "{}") as {
          retryFacts?: unknown
          retryCheckedAt?: unknown
        }
        previousFacts = receipt.retryFacts
        previousCheckedAt = receipt.retryCheckedAt
      } catch {
        previousFacts = undefined
      }
      if (typeof previousCheckedAt !== "number") return true
      let currentFacts: string | undefined
      try {
        currentFacts = this.worktreeCleanupRetryFacts(plan, source, workspace)
      } catch {
        // A local signal read failure never authorizes cleanup; the bounded native fallback retries.
      }
      if (currentFacts !== undefined && currentFacts !== previousFacts) return true
      const elapsed = this.now() - previousCheckedAt
      if (elapsed < 0 || elapsed >= WORKTREE_CLEANUP_FALLBACK_MS) return true
    }
    return false
  }

  private async cleanupWorktrees(
    plan: PlanRow,
    fence: number,
    mode: "integration" | "cancellation" = "integration",
  ) {
    // A fallback probe is not a lifecycle change. Keep an existing hold until
    // its reason changes or native cleanup completes.
    const cleanupCurrent = () => {
      const state = this.store.plan(plan.id)?.state
      return mode === "integration"
        ? state === "cleaning" || state === "cleanup-blocked"
        : state === "cancelled"
    }
    if (!cleanupCurrent()) return
    const owned = [
      ...new Set(
        this.store
          .effects(plan.id)
          .filter(
            (effect) =>
              [
                "worktree",
                "worktree-recovery",
                "graph-worktree",
                "adoption-task-worktree",
                "adoption-combined-worktree",
              ].includes(effect.kind) && effect.state === "completed",
          )
          .map((effect) => JSON.parse(effect.receipt!).workspace as string),
      ),
    ]
    for (const workspace of owned) {
      if (workspace === this.directory) throw new Error("Refusing to remove the shared checkout")
      const previous = this.store
        .effects(plan.id)
        .find(
          (entry) =>
            entry.kind === "worktree-remove" && JSON.parse(entry.payload).workspace === workspace,
        )
      const effect =
        previous ?? this.effect(plan.id, null, null, "worktree-remove", { workspace }, fence)
      if (effect.state === "completed") continue
      let removalStarted = false
      const beginCleanup = () => {
        if (!removalStarted && effect.state === "held")
          this.store.fenced(this.owner, fence, (db) =>
            db
              .query(
                "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'intended') WHERE id=? AND state='held'",
              )
              .run(effect.id),
          )
        removalStarted = true
      }
      let retryFacts: string | undefined
      let sourceEffectForCleanup: EffectRow | undefined
      try {
        const sourceEffect = this.store.effects(plan.id).find((entry) => {
          if (
            ![
              "worktree",
              "worktree-recovery",
              "graph-worktree",
              "adoption-task-worktree",
              "adoption-combined-worktree",
            ].includes(entry.kind) ||
            entry.state !== "completed"
          )
            return false
          try {
            return JSON.parse(entry.receipt ?? "{}").workspace === workspace
          } catch {
            return false
          }
        })
        sourceEffectForCleanup = sourceEffect
        if (!sourceEffect)
          throw new Error("Owned worktree has no completed creation receipt; preserve it")
        try {
          retryFacts = this.worktreeCleanupRetryFacts(plan, sourceEffect, workspace)
        } catch {
          retryFacts = fingerprint({
            planID: plan.id,
            sourceID: sourceEffect.id,
            workspace: resolve(workspace),
            workspaceExists: existsSync(workspace),
            retryFactsUnavailable: true,
          })
        }
        const listed = await this.host.worktrees()
        if (!cleanupCurrent()) {
          this.abandonCleanupEffect(effect, fence)
          return
        }
        const target = resolve(workspace)
        const listedWorkspace = listed.some((entry) => resolve(entry) === target)
        const gitWorktrees = git(this.directory, ["worktree", "list", "--porcelain"])
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => resolve(line.slice("worktree ".length)))
        const gitRegistered = gitWorktrees.includes(target)
        if (listedWorkspace && existsSync(workspace)) {
          const initialSettlement = await this.assertWorktreeQuiescent(
            plan,
            sourceEffect,
            workspace,
            mode === "cancellation",
          )
          if (!cleanupCurrent()) {
            this.abandonCleanupEffect(effect, fence)
            return
          }
          if (await gitAsync(workspace, ["status", "--porcelain"]))
            throw new Error(`Owned worktree is dirty; preserve ${workspace}`)
          if (!cleanupCurrent()) {
            this.abandonCleanupEffect(effect, fence)
            return
          }
          const head = git(workspace, ["rev-parse", "HEAD"])
          try {
            git(this.directory, ["merge-base", "--is-ancestor", head, "HEAD"])
          } catch {
            throw new Error(`Owned worktree has unmerged commits; preserve ${workspace}`)
          }
          const finalSettlement = await this.assertWorktreeQuiescent(
            plan,
            sourceEffect,
            workspace,
            mode === "cancellation",
          )
          if (!cleanupCurrent()) {
            this.abandonCleanupEffect(effect, fence)
            return
          }
          if (
            initialSettlement &&
            finalSettlement &&
            fingerprint({ ...initialSettlement, observedAt: 0 }) !==
              fingerprint({ ...finalSettlement, observedAt: 0 })
          )
            throw new Error(
              "Native cleanup settlement changed before removal; preserve the worktree",
            )
          if (await gitAsync(workspace, ["status", "--porcelain"]))
            throw new Error(`Owned worktree became dirty before removal; preserve ${workspace}`)
          const finalHead = git(workspace, ["rev-parse", "HEAD"])
          try {
            git(this.directory, ["merge-base", "--is-ancestor", finalHead, "HEAD"])
          } catch {
            throw new Error(`Owned worktree has unmerged commits; preserve ${workspace}`)
          }
          const finalNative = await this.host.worktrees()
          if (!cleanupCurrent()) {
            this.abandonCleanupEffect(effect, fence)
            return
          }
          const finalGitWorktrees = git(this.directory, ["worktree", "list", "--porcelain"])
            .split(/\r?\n/)
            .filter((line) => line.startsWith("worktree "))
            .map((line) => resolve(line.slice("worktree ".length)))
          if (
            !finalNative.some((entry) => resolve(entry) === target) ||
            !finalGitWorktrees.includes(target)
          )
            throw new Error("Exact owned worktree registration changed before removal; preserve it")
          const settlement = finalSettlement ?? initialSettlement
          if (settlement) {
            const attempt = this.store
              .attempts(plan.id)
              .find((candidate) => candidate.id === sourceEffect.attempt_id)
            const authorization = attempt
              ? this.cleanupRecoveryAuthorization(plan, attempt, sourceEffect, workspace)
              : undefined
            if (!authorization)
              throw new Error("Cleanup recovery authorization changed before evidence was recorded")
            this.appendCleanupSettlement(effect, authorization, settlement, fence)
          }
          if (!cleanupCurrent()) return
          beginCleanup()
          await this.host.removeWorktree(workspace)
        } else if (listedWorkspace || gitRegistered) {
          // A disappeared directory can still have a native/Git registration.
          // Ask the recorded native strategy to retire that exact owned path;
          // never substitute filesystem deletion or force removal.
          await this.assertWorktreeQuiescent(plan, sourceEffect, workspace, mode === "cancellation")
          beginCleanup()
          await this.host.removeWorktree(workspace)
        } else if (existsSync(workspace))
          throw new Error(
            "Owned directory is not registered with OpenCode; preserve it for reconciliation",
          )
        const remainingNative = await this.host.worktrees()
        const remainingGit = git(this.directory, ["worktree", "list", "--porcelain"])
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => resolve(line.slice("worktree ".length)))
        if (
          remainingNative.some((entry) => resolve(entry) === target) ||
          remainingGit.includes(target) ||
          existsSync(workspace)
        )
          throw new Error(`Native worktree removal is not confirmed absent: ${workspace}`)
        if (this.host.retireWorktreeLocation) beginCleanup()
        const cacheRetirement = await this.retireCleanedWorktreeLocation(
          plan,
          workspace,
          cleanupCurrent,
        )
        if (!cleanupCurrent()) return
        if (!(["unsupported", "not-loaded", "evicted"] as string[]).includes(cacheRetirement))
          throw new Error(`Native worktree location retirement is ${cacheRetirement}`)
        this.completeWorktreeRemoval(
          effect,
          { workspace, removed: true, native: true, cacheRetirement },
          fence,
        )
        if (!cleanupCurrent()) return
      } catch (error) {
        const reason = errorText(error)
        if (!retryFacts && sourceEffectForCleanup) {
          try {
            retryFacts = this.worktreeCleanupRetryFacts(plan, sourceEffectForCleanup, workspace)
          } catch {
            retryFacts = fingerprint({
              planID: plan.id,
              sourceID: sourceEffectForCleanup.id,
              workspace: resolve(workspace),
              workspaceExists: existsSync(workspace),
              retryFactsUnavailable: true,
            })
          }
        }
        if (!cleanupCurrent() && !removalStarted) {
          this.abandonCleanupEffect(effect, fence)
          return
        }
        let blocked = false
        this.store.fenced(this.owner, fence, (db) => {
          const held = !removalStarted && (!previous || previous.state === "held")
          const current = db
            .query<{ receipt: string | null }, [string]>(
              "SELECT receipt FROM runner_effects WHERE id=? AND state IN ('held','intended','uncertain')",
            )
            .get(effect.id)
          if (!current)
            throw new Error("Native cleanup effect changed before uncertainty was recorded")
          let previousError: string | undefined
          try {
            const previous = JSON.parse(current.receipt ?? "{}") as unknown
            if (isRecord(previous) && typeof previous.error === "string")
              previousError = previous.error
          } catch {
            // Keep malformed legacy receipt bytes in the append-only history below.
          }
          const checkedAt = this.now()
          const appended = JSON.parse(
            appendRunnerEffectReceipt(current.receipt, {
              schema: "lazers-worktree-cleanup-observation/v1",
              error: reason,
              ...(held ? { notSent: true } : {}),
              ...(retryFacts ? { retryFacts } : {}),
              retryCheckedAt: checkedAt,
            }),
          ) as Record<string, unknown>
          const receipt = JSON.stringify({
            ...appended,
            error: previousError ?? reason,
            ...(held ? { notSent: true } : {}),
            ...(retryFacts ? { retryFacts } : {}),
            retryCheckedAt: checkedAt,
          })
          const recorded = db
            .query(
              "UPDATE runner_effects SET state=lz_runner_transition('effect',state,?),receipt=? WHERE id=? AND state IN ('held','intended','uncertain')",
            )
            .run(held ? "held" : "uncertain", receipt, effect.id).changes
          if (recorded !== 1)
            throw new Error("Native cleanup uncertainty lost its durable effect row")
          blocked =
            db
              .query(
                mode === "integration"
                  ? "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'cleanup-blocked'),reason=?,version=version+1 WHERE id=? AND state IN ('cleaning','cleanup-blocked') AND (state<>'cleanup-blocked' OR reason IS NOT ?)"
                  : "UPDATE runner_plans SET reason=?,version=version+1 WHERE id=? AND state='cancelled' AND (reason IS NULL OR reason<>?)",
              )
              .run(reason, plan.id, reason).changes === 1
          if (blocked)
            this.store.record(
              plan.id,
              null,
              mode === "integration" ? "CLEANUP_BLOCKED" : "CANCELLATION_CLEANUP_HELD",
              { workspace, reason },
            )
        })
        if (!blocked) return
        if (mode === "integration")
          this.outcome(
            plan.id,
            {
              status: "cleanup-blocked",
              reason,
              artifact: plan.artifact,
              allowedActions: ["integrated", "recover-cleanup"],
            },
            true,
          )
        return
      }
    }
    if (mode === "cancellation") {
      this.store.fenced(this.owner, fence, (db) => {
        db.query(
          "UPDATE runner_plans SET reason=NULL,version=version+1 WHERE id=? AND state='cancelled'",
        ).run(plan.id)
        this.store.record(plan.id, null, "CANCELLED_WORKTREES_RECONCILED", { directories: owned })
      })
      return
    }
    let integrated = false
    this.store.fenced(this.owner, fence, (db) => {
      integrated =
        db
          .query(
            "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'integrated'),reason=NULL,version=version+1 WHERE id=? AND state IN ('cleaning','cleanup-blocked')",
          )
          .run(plan.id).changes === 1
      if (integrated)
        this.store.record(plan.id, null, "WORKTREES_RECONCILED", {
          directories: owned,
          artifact: plan.artifact,
        })
    })
    if (!integrated) return
    this.outcome(
      plan.id,
      { status: "integrated", artifact: plan.artifact, worktreesRemoved: owned },
      false,
    )
  }
  private async reconcileEffect(effect: EffectRow, fence: number) {
    const payload = JSON.parse(effect.payload)
    try {
      if (effect.kind === "scope-instruction") {
        const update = payload as WorkerInstruction
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
          return
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
        return
      } else if (effect.kind === "session") {
        const session = await this.host.session(payload.sessionID)
        if (session) {
          this.receipt(effect, { sessionID: session.id, reconciled: true }, fence)
          return
        }
      } else if (effect.kind === "prompt") {
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
          return
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
          return
        }
      } else if (
        [
          "worktree",
          "worktree-recovery",
          "graph-worktree",
          "adoption-task-worktree",
          "adoption-combined-worktree",
        ].includes(effect.kind)
      ) {
        const nativeFailure =
          effect.kind === "worktree" || effect.kind === "worktree-recovery"
            ? nativeWorktreeFailureFromReceipt(effect.receipt)
            : undefined
        const startupRecoveryReason = (() => {
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
        })()
        const nativeWorktrees = await this.host.worktrees()
        // A typed native failure is affirmative terminal evidence, not a lost
        // success response. It can never be promoted to a ready workspace.
        if (nativeFailure) return
        const possibleCandidates = nativeWorktrees
          .filter((directory) =>
            effect.kind === "worktree-recovery"
              ? directory === payload.workspace
              : isStartupWorktreeCandidate(payload.workspace, directory),
          )
          .filter(
            (directory) =>
              existsSync(directory) && git(directory, ["rev-parse", "HEAD"]) === payload.base,
          )
        const candidates: string[] = []
        for (const directory of possibleCandidates) {
          if (
            effect.kind.startsWith("adoption-") &&
            (await gitAsync(directory, ["status", "--porcelain", "--untracked-files=all"]))
          )
            continue
          candidates.push(directory)
        }
        if (candidates.length === 1) {
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
          if (startupRecoveryReason && effect.attempt_id) {
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
                  plan?.owner === authorization.owner &&
                  plan.version >= authorization.planVersion &&
                  this.store.planControlEpoch(plan.id) === authorization.ownerEpoch &&
                  operation.recoveryID === authorization.recoveryID &&
                  operation.sourceEffectID === authorization.sourceEffectID,
                )
              } catch {
                recoveryBinding = false
              }
            }
            if (
              plan?.state === "blocked" &&
              plan.reason === startupRecoveryReason &&
              attempt?.state === "preparing" &&
              recoveryBinding
            ) {
              this.store.fenced(this.owner, fence, (db) => {
                const changed =
                  db
                    .query(
                      "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason=?",
                    )
                    .run(plan.id, startupRecoveryReason).changes === 1
                if (!changed) return
                if (effect.kind === "worktree-recovery" && authorization)
                  this.store.record(
                    plan.id,
                    attempt!.task_id,
                    "STARTUP_RECOVERY_OPERATION_RESUMED",
                    {
                      effectID: effect.id,
                      sourceEffectID: authorization.sourceEffectID,
                      recoveryID: authorization.recoveryID,
                      attemptID: effect.attempt_id,
                      workspace,
                      planVersion: plan.version + 2,
                    },
                  )
                else
                  this.store.record(plan.id, null, "WORKTREE_RECOVERY_RESUMED", {
                    effectID: effect.id,
                    attemptID: effect.attempt_id,
                    workspace,
                  })
              })
            }
          }
          return
        }
      } else if (effect.kind === "mechanical-fix") {
        const activityIdentity = { effectID: effect.id, payload: effect.payload }
        const activity = this.checkActivity(effect.id, activityIdentity)
        if (activity?.state === "running") return
        if (existsSync(payload.receiptPath)) {
          const check = JSON.parse(readFileSync(payload.receiptPath, "utf8")) as CheckReceipt
          const preparation = check.preparation
          const scope = this.store.effectiveWriteScope(effect.task_id!)
          if (
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
              workingTreeIdentity(payload.workspace, payload.baseCommit) &&
            !scopeViolations(preparation.paths, scope).length
          ) {
            if (check.aborted) {
              this.uncertain(effect, "Verification was interrupted before completion", fence, {
                check,
              })
              forgetVerificationActivity(
                verificationActivityKey(this.store.repository.path, effect.id),
                fingerprint(activityIdentity),
              )
              return
            }
            if (!checkResourcesSettled(check)) {
              this.uncertain(
                effect,
                new Error(
                  `Mechanical command exited ${check.exitCode ?? "unknown"} with timedOut=${check.timedOut}, but subprocess cleanup is uncertain: ${check.processCleanup?.detail ?? "termination was not confirmed"}`,
                ),
                fence,
                { check },
              )
              return
            }
            this.receipt(effect, { check, reconciled: true }, fence)
            forgetVerificationActivity(
              verificationActivityKey(this.store.repository.path, effect.id),
              fingerprint(activityIdentity),
            )
            this.tickRequested = true
            return
          }
        }
        if (activity?.state === "failed") {
          this.uncertain(effect, activity.error, fence)
          forgetVerificationActivity(
            verificationActivityKey(this.store.repository.path, effect.id),
            fingerprint(activityIdentity),
          )
          return
        }
      } else if (effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:")) {
        const activityIdentity = { effectID: effect.id, payload: effect.payload }
        const activity = this.checkActivity(effect.id, activityIdentity)
        if (activity?.state === "running") return
        if (existsSync(payload.receiptPath)) {
          const check = JSON.parse(readFileSync(payload.receiptPath, "utf8")) as CheckReceipt
          if (
            check.id === payload.check.id &&
            check.artifact === payload.artifact &&
            check.cwd === payload.workspace &&
            check.command === payload.check.command &&
            check.inputIdentity === payload.identity
          ) {
            if (check.aborted) {
              this.uncertain(effect, "Verification was interrupted before completion", fence, {
                check,
              })
              forgetVerificationActivity(
                verificationActivityKey(this.store.repository.path, effect.id),
                fingerprint(activityIdentity),
              )
              return
            }
            if (effect.kind.startsWith("verify:") && effect.attempt_id && effect.task_id) {
              try {
                this.progress.recordVerification(effect.attempt_id, effect.id, check)
              } catch {
                // The runner receipt remains authoritative if progress annotation fails.
              }
              this.store.atomic((db) =>
                db
                  .query(
                    "INSERT OR IGNORE INTO runner_evidence VALUES(?,?,?,?,NULL,'verification',?,?,?)",
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
            if (!checkResourcesSettled(check)) {
              this.uncertain(
                effect,
                new Error(
                  `Verification command exited ${check.exitCode ?? "unknown"} with timedOut=${check.timedOut}, but subprocess cleanup is uncertain: ${check.processCleanup?.detail ?? "termination was not confirmed"}`,
                ),
                fence,
                { check },
              )
              forgetVerificationActivity(
                verificationActivityKey(this.store.repository.path, effect.id),
                fingerprint(activityIdentity),
              )
              return
            }
            this.receipt(effect, { check, reconciled: true }, fence)
            this.tickRequested = true
            forgetVerificationActivity(
              verificationActivityKey(this.store.repository.path, effect.id),
              fingerprint(activityIdentity),
            )
            return
          }
        }
        if (activity?.state === "failed") {
          this.uncertain(effect, activity.error, fence)
          forgetVerificationActivity(
            verificationActivityKey(this.store.repository.path, effect.id),
            fingerprint(activityIdentity),
          )
          return
        }
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
  private ownership(message: OutboxRow): OutcomeOwnership | undefined {
    const ownership = parseOutcomeOwnership(message.metadata ? JSON.parse(message.metadata) : null)
    if (
      !ownership ||
      ownership.lazersOutboxID !== message.id ||
      ownership.lazersPlanID !== message.plan_id ||
      ownership.lazersMessageID !== message.message_id ||
      ownership.lazersSessionID !== message.session_id
    )
      return undefined
    return ownership
  }

  private createOwnership(message: OutboxRow, sessionID: string): OutcomeOwnership {
    const payload = JSON.parse(message.payload) as { status?: unknown; version?: unknown }
    return {
      lazersKind: "runner-outcome",
      lazersProjectID: this.projectID,
      lazersProjectDirectory: this.directory,
      lazersPlanID: message.plan_id,
      lazersOutboxID: message.id,
      lazersMessageID: message.message_id,
      lazersSessionID: sessionID,
      lazersStatus: typeof payload.status === "string" ? payload.status : "update",
      lazersVersion: typeof payload.version === "number" ? payload.version : 0,
    }
  }

  private outcomeState(
    message: OutboxRow,
    expected: string[],
    state: string,
    receipt: unknown,
    event: string,
    fence: number,
  ) {
    return this.store.fenced(this.owner, fence, (db) => {
      const placeholders = expected.map(() => "?").join(",")
      const current = db
        .query<{ state: string; receipt: string | null }, [string]>(
          "SELECT state,receipt FROM runner_outbox WHERE id=?",
        )
        .get(message.id)
      if (!current || !expected.includes(current.state)) return false
      const nextReceipt = appendOutboxReceipt(current.receipt, receipt)
      const changed = db
        .query(
          `UPDATE runner_outbox SET state=lz_runner_transition('outbox',state,?),receipt=? WHERE id=? AND state=? AND state IN (${placeholders})`,
        )
        .run(state, nextReceipt, message.id, current.state, ...expected).changes
      if (changed) {
        this.store.record(message.plan_id, null, event, {
          outboxID: message.id,
          messageID: message.message_id,
          from: current.state,
          to: state,
          receipt,
        })
        this.store.repository.changed()
      }
      return changed === 1
    })
  }

  private async outcomeObservation(
    message: OutboxRow,
    sessionID: string,
    ownership?: OutcomeOwnership,
  ): Promise<"queued" | "consumed" | "missing" | "unowned"> {
    // Older injected hosts used by recovery fixtures do not have the pinned
    // inbox API. They can still prove an exact transcript ID, but cannot prove
    // that an absent message was cancelled or consumed.
    if (!this.host.outcomeInbox) {
      const target = await this.host.session(sessionID, { messages: true })
      const transcript = target?.messages.find((item) => item.id === message.message_id)
      if (!transcript) return "missing"
      if (ownership) return isOwnedOutcomeTranscript(transcript, ownership) ? "consumed" : "unowned"
      return transcript.type === "synthetic" ? "consumed" : "unowned"
    }
    const inbox = await this.host.outcomeInbox(sessionID)
    const entry = inbox.find((item) => item.id === message.message_id)
    if (entry) {
      if (ownership && isOwnedQueuedOutcome(entry, ownership)) return "queued"
      return "unowned"
    }
    const target = await this.host.session(sessionID, { messages: true })
    const transcript = target?.messages.find((item) => item.id === message.message_id)
    if (!transcript) return "missing"
    if (ownership) return isOwnedOutcomeTranscript(transcript, ownership) ? "consumed" : "unowned"
    return transcript.type === "synthetic" ? "consumed" : "unowned"
  }

  private async supersedeOutcome(
    message: OutboxRow,
    latest: OutboxRow,
    plan: PlanRow,
    fence: number,
  ) {
    if (message.state === "unknown") return true
    if (message.state === "pending") {
      this.outcomeState(
        message,
        ["pending"],
        "superseded",
        { kind: "superseded-before-native-admission", byOutboxID: latest.id },
        "OUTCOME_SUPERSEDED",
        fence,
      )
      return true
    }
    if (!["sending", "uncertain", "admitted", "unknown", "delivered"].includes(message.state))
      return true

    const ownership = this.ownership(message)
    if (
      !ownership ||
      message.session_id !== latest.session_id ||
      message.session_id !== plan.owner
    ) {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "supersession-ownership-unavailable", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }

    const target = await this.host.session(message.session_id)
    if (!this.validArchitect(target) || target.id !== plan.owner) return true
    let observation: "queued" | "consumed" | "missing" | "unowned"
    try {
      observation = await this.outcomeObservation(message, target.id, ownership)
    } catch (error) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        {
          kind: "supersession-observation-unavailable",
          byOutboxID: latest.id,
          error: errorText(error),
        },
        "OUTCOME_SUPERSESSION_UNCERTAIN",
        fence,
      )
      return false
    }
    if (observation === "consumed") {
      this.outcomeState(
        message,
        [message.state],
        "consumed",
        { kind: "transcript-observed", byOutboxID: latest.id },
        "OUTCOME_CONSUMED",
        fence,
      )
      return true
    }
    if (observation === "unowned") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "supersession-input-identity-conflict", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }
    if (observation === "missing") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "unknown-consumption", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }

    if (!this.host.cancelOutcome) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        { kind: "native-cancellation-unavailable", byOutboxID: latest.id },
        "OUTCOME_CANCEL_UNCERTAIN",
        fence,
      )
      return false
    }

    try {
      await this.host.cancelOutcome({
        sessionID: target.id,
        inboxID: message.message_id,
        ownership,
      })
    } catch (error) {
      let afterFailure: "queued" | "consumed" | "missing" | "unowned"
      try {
        afterFailure = await this.outcomeObservation(message, target.id, ownership)
      } catch (observationError) {
        this.outcomeState(
          message,
          [message.state],
          message.state,
          {
            kind: "cancellation-outcome-unobservable",
            byOutboxID: latest.id,
            error: errorText(error),
            observationError: errorText(observationError),
          },
          "OUTCOME_CANCEL_UNCERTAIN",
          fence,
        )
        return false
      }
      if (afterFailure === "consumed") {
        this.outcomeState(
          message,
          [message.state],
          "consumed",
          { kind: "cancel-raced-with-consumption", byOutboxID: latest.id, error: errorText(error) },
          "OUTCOME_CANCEL_RACED_WITH_CONSUMPTION",
          fence,
        )
        return true
      }
      if (afterFailure === "queued") {
        this.outcomeState(
          message,
          [message.state],
          message.state,
          {
            kind: "cancellation-failed-still-queued",
            byOutboxID: latest.id,
            error: errorText(error),
          },
          "OUTCOME_CANCEL_UNCERTAIN",
          fence,
        )
        return false
      }
      if (afterFailure === "missing")
        this.outcomeState(
          message,
          [message.state],
          "unknown",
          {
            kind: "cancel-race-consumption-unknown",
            byOutboxID: latest.id,
            error: errorText(error),
          },
          "OUTCOME_CONSUMPTION_UNKNOWN",
          fence,
        )
      if (afterFailure === "unowned") {
        this.outcomeState(
          message,
          [message.state],
          message.state,
          { kind: "cancellation-not-confirmed-unowned-input", byOutboxID: latest.id },
          "OUTCOME_CANCEL_UNCERTAIN",
          fence,
        )
        return false
      }
      return true
    }

    let afterCancellation: "queued" | "consumed" | "missing" | "unowned"
    try {
      afterCancellation = await this.outcomeObservation(message, target.id, ownership)
    } catch (error) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        {
          kind: "cancellation-confirmation-unavailable",
          byOutboxID: latest.id,
          error: errorText(error),
        },
        "OUTCOME_CANCEL_UNCERTAIN",
        fence,
      )
      return false
    }
    if (afterCancellation === "consumed") {
      this.outcomeState(
        message,
        [message.state],
        "consumed",
        { kind: "consumption-observed-after-cancel", byOutboxID: latest.id },
        "OUTCOME_CANCEL_RACED_WITH_CONSUMPTION",
        fence,
      )
      return true
    }
    if (afterCancellation === "queued") {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        { kind: "cancel-returned-but-outcome-still-queued", byOutboxID: latest.id },
        "OUTCOME_CANCEL_UNCERTAIN",
        fence,
      )
      return false
    }
    if (afterCancellation === "unowned") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "cancel-returned-with-identity-conflict", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }

    this.outcomeState(
      message,
      [message.state],
      "superseded",
      { kind: "native-cancellation-confirmed", inboxID: message.message_id, byOutboxID: latest.id },
      "OUTCOME_SUPERSEDED",
      fence,
    )
    return true
  }

  private async deliverCurrent(
    message: OutboxRow,
    fence: number,
    admittedTargets: Map<string, HostSession>,
  ) {
    if (["consumed", "superseded", "unknown"].includes(message.state)) return
    let plan = this.store.plan(message.plan_id)
    if (!plan) return
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(message.payload) as Record<string, unknown>
    } catch {
      return
    }
    if (payload.status === "retained-verification-held") {
      const operationID = payload.operationID
      const operation =
        typeof operationID === "string"
          ? this.store.atomic((db) => retainedVerification(db, operationID))
          : undefined
      if (
        operation?.state !== "held" ||
        operation.planID !== plan.id ||
        ["cancelling", "cancelled", "integrated"].includes(plan.state)
      ) {
        if (message.state === "pending")
          this.outcomeState(
            message,
            ["pending"],
            "superseded",
            { kind: "retained-verification-hold-cleared" },
            "OUTCOME_SUPERSEDED",
            fence,
          )
        return
      }
    }
    if (payload.status === "architect-source-change") {
      const sourceSessionID = payload.sourceSessionID
      if (typeof sourceSessionID !== "string") return
      const context = this.store.architectSourceNoticeContext({
        planID: plan.id,
        sourceSessionID,
        expectedOwner: plan.owner,
        expectedPlanVersion: plan.version,
      })
      const currentTarget = context?.targets.find(
        (target) => target.owner === message.session_id && target.planIDs.includes(message.plan_id),
      )
      if (!currentTarget) {
        const replacementTarget = context?.targets[0]
        const replacementPlan = replacementTarget
          ? this.store.plan(replacementTarget.planID)
          : undefined
        if (replacementTarget && replacementPlan)
          this.store.ensureArchitectSourceChangeNotices({
            planID: replacementTarget.planID,
            sourceSessionID,
            expectedOwner: replacementTarget.owner,
            expectedPlanVersion: replacementPlan.version,
            projectID: this.projectID,
          })
        if (message.state === "pending") {
          this.outcomeState(
            message,
            ["pending"],
            "superseded",
            { kind: "source-change-target-no-longer-current", sourceSessionID },
            "ARCHITECT_SOURCE_CHANGE_SUPERSEDED",
            fence,
          )
          return
        }
      }
    }
    // Share only the no-op observation for already-admitted, same-owner rows in
    // this delivery group. Never reuse it for admission, cancellation or retarget.
    let target =
      message.state === "admitted" && message.session_id === plan.owner
        ? (admittedTargets.get(message.session_id) ?? (await this.host.session(message.session_id)))
        : await this.host.session(message.session_id)
    plan = this.store.plan(message.plan_id)
    if (!plan) return
    if (message.state === "admitted" && this.validArchitect(target) && target.id === plan.owner) {
      admittedTargets.set(target.id, target)
      return
    }
    // Any path that can mutate native/durable delivery invalidates this group's
    // observations; the next admitted row obtains a fresh host observation.
    admittedTargets.clear()
    if (!this.validArchitect(target) || target.id !== plan.owner) {
      // Admitted is not consumed. Prove consumption in the original session
      // before transferring an otherwise-current notice to its replacement.
      const priorOwnership = this.ownership(message)
      let priorObservation: string
      try {
        priorObservation = await this.outcomeObservation(
          message,
          message.session_id,
          priorOwnership,
        )
      } catch (error) {
        priorObservation = `unavailable: ${errorText(error)}`
      }
      if (priorObservation === "consumed") {
        this.outcomeState(
          message,
          [message.state],
          "consumed",
          { kind: "transcript-observed-before-owner-transfer" },
          "OUTCOME_CONSUMED",
          fence,
        )
        this.wakeRecoveredArchitect(plan.id)
        return
      }
      let safeToRetarget = message.state === "pending"
      if (!safeToRetarget && priorObservation === "queued" && this.host.cancelOutcome) {
        try {
          const originalOwnership =
            priorOwnership ?? this.createOwnership(message, message.session_id)
          await this.host.cancelOutcome({
            sessionID: message.session_id,
            inboxID: message.message_id,
            ownership: originalOwnership,
          })
          const afterCancellation = await this.outcomeObservation(
            message,
            message.session_id,
            originalOwnership,
          )
          if (afterCancellation === "consumed") {
            this.outcomeState(
              message,
              [message.state],
              "consumed",
              { kind: "cancellation-raced-with-consumption" },
              "OUTCOME_CANCEL_RACED_WITH_CONSUMPTION",
              fence,
            )
            this.wakeRecoveredArchitect(plan.id)
            return
          }
          safeToRetarget = afterCancellation === "missing"
          if (safeToRetarget) priorObservation = "cancelled-confirmed-by-inbox-and-history-readback"
        } catch (error) {
          priorObservation = `cancellation-unconfirmed: ${errorText(error)}`
        }
      }
      if (!safeToRetarget) {
        this.outcomeState(
          message,
          [message.state],
          priorObservation === "missing" || priorObservation === "unowned"
            ? "unknown"
            : message.state,
          {
            kind: "owner-changed-with-original-delivery-unresolved",
            priorSessionID: message.session_id,
            priorMessageID: message.message_id,
            priorObservation,
          },
          "OUTCOME_OWNER_TRANSFER_UNCERTAIN",
          fence,
        )
        this.wakeRecoveredArchitect(plan.id)
        return
      }
      const owner = await this.ensureArchitectOwner(plan, target)
      // Native message IDs are global. Never reuse an admitted/uncertain ID in
      // another session; persist the replacement identity before host admission.
      const replacementID = messageID()
      const nextOwnership = {
        ...(priorOwnership ?? this.createOwnership(message, message.session_id)),
        lazersSessionID: owner.id,
        lazersMessageID: replacementID,
      }
      if (
        !this.store.retargetOutbox({
          id: message.id,
          expectedState: message.state,
          sessionID: owner.id,
          messageID: replacementID,
          metadata: JSON.stringify(nextOwnership),
          receipt: {
            kind: "owner-retargeted-current-outcome",
            fromSessionID: message.session_id,
            toSessionID: owner.id,
            previousMessageID: message.message_id,
            replacementMessageID: replacementID,
            priorOwnership: priorOwnership ?? null,
            priorObservation,
            priorDeliveryState: message.state,
          },
        })
      )
        return
      message = {
        ...message,
        state: "pending",
        session_id: owner.id,
        message_id: replacementID,
        metadata: JSON.stringify(nextOwnership),
      }
      target = owner
    }
    if (!this.validArchitect(target)) return
    if (message.state === "admitted") return

    if (payload.status === "architect-source-change") {
      const sourceSessionID = payload.sourceSessionID
      const current =
        typeof sourceSessionID === "string"
          ? this.store.architectSourceNoticeContext({
              planID: message.plan_id,
              sourceSessionID,
              expectedOwner: plan.owner,
              expectedPlanVersion: plan.version,
            })
          : null
      if (
        !current?.targets.some(
          (entry) => entry.owner === message.session_id && entry.planIDs.includes(message.plan_id),
        )
      )
        return
    }

    const ownership = this.ownership(message)
    let observation: "queued" | "consumed" | "missing" | "unowned"
    try {
      observation = await this.outcomeObservation(message, target.id, ownership)
    } catch (error) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        { kind: "native-observation-unavailable", error: errorText(error) },
        "OUTCOME_OBSERVATION_UNAVAILABLE",
        fence,
      )
      return
    }
    if (observation === "queued") {
      this.outcomeState(
        message,
        [message.state],
        "admitted",
        { kind: "native-inbox-observed", consumption: "unknown" },
        "OUTCOME_HOST_ADMITTED",
        fence,
      )
      return
    }
    if (observation === "consumed") {
      this.outcomeState(
        message,
        [message.state],
        "consumed",
        { kind: "transcript-observed" },
        "OUTCOME_CONSUMED",
        fence,
      )
      return
    }
    if (observation === "unowned") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "native-input-identity-conflict" },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return
    }
    if (
      !this.outcomeState(
        message,
        ["pending", "sending", "uncertain", "delivered"],
        "sending",
        { kind: "native-admission-in-progress" },
        "OUTCOME_SEND_STARTED",
        fence,
      )
    )
      return
    try {
      await this.host.notify({
        sessionID: target.id,
        id: message.message_id,
        text: outcomeText(message.payload),
        resume: Boolean(message.resume),
        ...(ownership ? { metadata: ownership } : {}),
      })
      this.outcomeState(
        message,
        ["sending"],
        "admitted",
        { kind: "host-admitted", consumption: "unknown", sessionID: target.id },
        "OUTCOME_HOST_ADMITTED",
        fence,
      )
    } catch (error) {
      this.outcomeState(
        message,
        ["pending", "sending", "uncertain", "delivered"],
        "uncertain",
        { kind: "native-delivery-uncertain", error: errorText(error) },
        "OUTCOME_DELIVERY_UNCERTAIN",
        fence,
      )
    }
  }

  private async deliver(fence: number) {
    const messages = this.store.outboxForDelivery(this.directory)
    const groups = new Map<string, OutboxRow[]>()
    for (const message of messages) {
      const group = groups.get(message.plan_id) ?? []
      group.push(message)
      groups.set(message.plan_id, group)
    }
    for (const group of groups.values()) {
      const ordered = group.toSorted((a, b) => a.version - b.version || a.sequence - b.sequence)
      if (this.store.architectRenewalBlocksDelivery(ordered[0]!.plan_id)) continue
      const plan = this.store.plan(ordered[0]!.plan_id)
      if (!plan) continue
      await this.reconcilePlan(plan.id, fence, "delivery", async () => {
        const ready = new Map<string, boolean>()
        const current = new Map<string, OutboxRow>()
        for (const [index, message] of ordered.entries()) {
          const older = JSON.parse(message.payload)
          // Once all task artifacts are accepted the next actionable outcome is
          // the combined result. Async checks must not publish a redundant task
          // handoff merely because that result requires another tick.
          if (
            older.status === "task-accepted" &&
            plan.state === "running" &&
            this.store.nodes(plan.id).every((node) => node.state === "accepted")
          )
            continue
          const replacement =
            older.status === "architect-handoff" ||
            older.status === "architect-source-reference" ||
            older.status === "architect-source-change" ||
            older.status === "queue-review" ||
            older.status === "retained-verification-held"
              ? undefined
              : ordered.slice(index + 1).findLast((candidate) => {
                  const next = JSON.parse(candidate.payload)
                  if (
                    next.status === "architect-handoff" ||
                    next.status === "architect-source-reference" ||
                    next.status === "architect-source-change" ||
                    next.status === "queue-review" ||
                    next.status === "retained-verification-held"
                  )
                    return false
                  // Current outcomes include the whole accepted-artifact review set.
                  // Legacy partial notices cannot suppress a different actionable result.
                  if (older.status === "task-accepted")
                    return (
                      (Array.isArray(next.reviewableTasks) &&
                        next.reviewableTasks.some(
                          (task: { taskID?: string; artifact?: string }) =>
                            task.taskID === older.taskID && task.artifact === older.artifact,
                        )) ||
                      (next.status === "task-accepted" &&
                        next.taskID === older.taskID &&
                        next.artifact === older.artifact) ||
                      (["accepted", "integrated"].includes(next.status) &&
                        typeof next.artifact === "string")
                    )
                  return next.status !== "task-accepted" || Boolean(next.currentPlan)
                })
          if (replacement) {
            const ok = await this.supersedeOutcome(message, replacement, plan, fence)
            ready.set(replacement.id, (ready.get(replacement.id) ?? true) && ok)
          } else current.set(message.id, message)
        }
        const admittedTargets = new Map<string, HostSession>()
        for (const message of current.values())
          if (ready.get(message.id) !== false)
            await this.deliverCurrent(message, fence, admittedTargets)
      })
    }
  }
}

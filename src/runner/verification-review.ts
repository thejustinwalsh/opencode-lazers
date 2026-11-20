import { actualCheckResultFromEffect, errorText, effectSuperseded } from "./runtime-helpers.ts"
import { isTakeoverAttempt } from "../recovery/detector.ts"
import { workerAgent } from "./worker-agent.ts"
import { join } from "node:path"
import { fingerprint } from "../identity.ts"
import { type TaskProposal } from "../task.ts"
import {
  artifactExists,
  checkResourcesSettled,
  gitAsync,
  reviewedScopeBase,
  verificationEnvironmentIdentity,
  writeCheckReceipt,
} from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import {
  buildScopeReport,
  classifyChanges,
  divergenceReason,
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
  fallowCheckReceipt,
  isFallowEffectKind,
  fallowReasonText,
  unavailableFallowResult,
} from "./fallow-check.ts"
import type { FallowReviewResult } from "../audit/review.ts"
import { needsRepair } from "../audit/audit-findings.ts"
import { attributeFindingsToTasks, type PlanTaskDiff } from "../audit/task-attribution.ts"
import { checkSucceeded, checkFailureReason } from "./checks.ts"
import type { PlanRow } from "./store.ts"
import type { TerminalWorkerHold } from "./interrupted-continuation.ts"
import type { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"
import type { CheckActivities } from "./check-activities.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"
import type { TaskRuntime } from "./runtime.ts"
import type { VerificationCandidate } from "./verification-candidate.ts"
import type { AttemptRow } from "./store.ts"
import type { FallowReview } from "./fallow-check.ts"
import type { AuditorReport } from "./auditor-report.ts"
import type { PlanFallowContext, RetainedRepairRecord } from "./runtime-helpers.ts"
import { auditIsOff } from "../projects/profile-runtime.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `VerificationReview` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type VerificationReviewDeps = {
  hold: RuntimeJournal["hold"]
  effect: RuntimeJournal["effect"]
  checkActivity: CheckActivities["checkActivity"]
  startCheckActivity: CheckActivities["startCheckActivity"]
  acceptVerifiedAttempt: VerificationCandidate["acceptVerifiedAttempt"]
  captureAutomaticFixes: VerificationCandidate["captureAutomaticFixes"]
  collectCheckReceipts: VerificationCandidate["collectCheckReceipts"]
  commitVerificationCandidate: VerificationCandidate["commitVerificationCandidate"]
  prepareVerificationCandidate: VerificationCandidate["prepareVerificationCandidate"]
  recordAttemptArtifact: VerificationCandidate["recordAttemptArtifact"]
  verificationAwaitsTaskContinuation: VerificationCandidate["verificationAwaitsTaskContinuation"]
  verificationCurrentGuard: VerificationCandidate["verificationCurrentGuard"]
  retainedRepairGeneration: (planID: string, taskID?: string) => string | undefined
  retainedRepairForAttempt: (attempt: AttemptRow) => RetainedRepairRecord | undefined
  stampIdentity: TaskRuntime["stampIdentity"]
  fallowReviewEnabled: boolean
  delegatedAgentCapacity: DelegatedAgentCapacity
  fallowReviewRun: FallowReview
  fallowPlanReviewRun: FallowReview
  auditorReportRun: AuditorReport
}

/**
 * Verification decision and review: `verify` and its decision, the scope review, the Fallow and
 * Auditor reviews, repair availability and failure, and returning a takeover to the Architect.
 * Owns the scope reports, the started Auditor reports and the three review runners. Moved out of
 * `TaskRuntime` without rewriting; the private aliases below keep the member bodies identical.
 */
export class VerificationReview {
  private readonly hold: VerificationReviewDeps["hold"]
  private readonly effect: VerificationReviewDeps["effect"]
  private readonly checkActivity: VerificationReviewDeps["checkActivity"]
  private readonly startCheckActivity: VerificationReviewDeps["startCheckActivity"]
  private readonly acceptVerifiedAttempt: VerificationReviewDeps["acceptVerifiedAttempt"]
  private readonly captureAutomaticFixes: VerificationReviewDeps["captureAutomaticFixes"]
  private readonly collectCheckReceipts: VerificationReviewDeps["collectCheckReceipts"]
  private readonly commitVerificationCandidate: VerificationReviewDeps["commitVerificationCandidate"]
  private readonly prepareVerificationCandidate: VerificationReviewDeps["prepareVerificationCandidate"]
  private readonly recordAttemptArtifact: VerificationReviewDeps["recordAttemptArtifact"]
  private readonly verificationAwaitsTaskContinuation: VerificationReviewDeps["verificationAwaitsTaskContinuation"]
  private readonly verificationCurrentGuard: VerificationReviewDeps["verificationCurrentGuard"]
  private readonly retainedRepairGeneration: VerificationReviewDeps["retainedRepairGeneration"]
  private readonly retainedRepairForAttempt: VerificationReviewDeps["retainedRepairForAttempt"]
  private readonly stampIdentity: VerificationReviewDeps["stampIdentity"]
  private readonly fallowReviewEnabled: VerificationReviewDeps["fallowReviewEnabled"]
  private readonly delegatedAgentCapacity: VerificationReviewDeps["delegatedAgentCapacity"]
  private readonly fallowReviewRun: VerificationReviewDeps["fallowReviewRun"]
  private readonly fallowPlanReviewRun: VerificationReviewDeps["fallowPlanReviewRun"]
  private readonly auditorReportRun: VerificationReviewDeps["auditorReportRun"]

  constructor(
    private readonly core: RuntimeCore,
    deps: VerificationReviewDeps,
  ) {
    this.hold = (...args) => deps.hold(...args)
    this.effect = (...args) => deps.effect(...args)
    this.checkActivity = (...args) => deps.checkActivity(...args)
    this.startCheckActivity = (...args) => deps.startCheckActivity(...args)
    this.acceptVerifiedAttempt = (...args) => deps.acceptVerifiedAttempt(...args)
    this.captureAutomaticFixes = (...args) => deps.captureAutomaticFixes(...args)
    this.collectCheckReceipts = (...args) => deps.collectCheckReceipts(...args)
    this.commitVerificationCandidate = (...args) => deps.commitVerificationCandidate(...args)
    this.prepareVerificationCandidate = (...args) => deps.prepareVerificationCandidate(...args)
    this.recordAttemptArtifact = (...args) => deps.recordAttemptArtifact(...args)
    this.verificationAwaitsTaskContinuation = (...args) =>
      deps.verificationAwaitsTaskContinuation(...args)
    this.verificationCurrentGuard = (...args) => deps.verificationCurrentGuard(...args)
    this.retainedRepairGeneration = (...args) => deps.retainedRepairGeneration(...args)
    this.retainedRepairForAttempt = (...args) => deps.retainedRepairForAttempt(...args)
    this.stampIdentity = (...args) => deps.stampIdentity(...args)
    this.fallowReviewEnabled = deps.fallowReviewEnabled
    this.delegatedAgentCapacity = deps.delegatedAgentCapacity
    this.fallowReviewRun = deps.fallowReviewRun
    this.fallowPlanReviewRun = deps.fallowPlanReviewRun
    this.auditorReportRun = deps.auditorReportRun
  }

  private get progress() {
    return this.core.progress
  }

  private get owner() {
    return this.core.owner
  }

  private get host() {
    return this.core.host
  }

  private get directory() {
    return this.core.directory
  }

  private get dataDirectory() {
    return this.core.dataDirectory
  }

  private get store() {
    return this.core.store
  }

  private readonly scopeReports = new Map<string, ScopeReport>()
  private readonly startedAuditorReports = new Set<string>()
  async verify(plan: PlanRow, attempt: AttemptRow, proposal: TaskProposal, fence: number) {
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
  decideVerification(
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
  async reviewScope(
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
        .activityEvents(plan.id, attempt.task_id, { events: ["SCOPE_AMENDED"] })
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
  async taskScopeBase(
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
  scopeOwners(plan: PlanRow, taskID: string): ScopeOwner[] {
    const finished = new Set(["accepted", "incorporated", "cancelled", "failed", "exhausted"])
    const ids = new Set<string>()
    // Every unfinished plan of the project: a queued task has reserved its scope with no attempt yet.
    for (const other of this.store.plans())
      if (!["integrated", "cancelled"].includes(other.state))
        for (const node of this.store.nodes(other.id))
          if (node.task_id !== taskID && !finished.has(node.state)) ids.add(node.task_id)
    for (const active of this.store.activeProjectAttempts())
      if (active.task_id !== taskID) ids.add(active.task_id)
    return [...ids].map((id) => ({
      taskID: id,
      patterns: this.store.effectiveReservationScope(id),
    }))
  }
  /** The worker's own final message, quoted as its stated reason; undefined when it gave none. */
  async workerFinalMessage(attempt: AttemptRow): Promise<string | undefined> {
    try {
      const worker = await this.host.session(attempt.session_id, { messages: true })
      if (!worker) return undefined
      // The current turn's replies. Its input is not the worker's own words.
      const last = worker.messages.findLast(
        (message) =>
          message.id !== attempt.message_id &&
          message.id !== worker.turn?.inputID &&
          message.type !== "synthetic" &&
          message.text.trim(),
      )
      if (last) return last.text
      // The turn said nothing in words: one assistant-only page reaches the reply before it.
      return await this.host.earlierAssistantText?.(attempt.session_id, worker.turnAssistants ?? 0)
    } catch {
      return undefined
    }
  }
  /** The Architect decides: amend-scope to accept it with a reason, retained-repair, or cancel. */
  async holdScopeDivergence(
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
  async fallowReviewResult(
    plan: PlanRow,
    attempt: AttemptRow,
    artifact: { commit: string; identity: string },
    repairID: string | undefined,
    fence: number,
  ): Promise<FallowReviewResult | "pending" | undefined> {
    if (
      !this.fallowReviewEnabled ||
      auditIsOff(this.store.repository, this.store.repository.projectDirectory)
    )
      return undefined
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
  async runFallowReview(
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
  startAuditorReport(attempt: AttemptRow, phase: "baseline" | "follow-up") {
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
  async planFallowReview(
    plan: PlanRow,
    ctx: PlanFallowContext,
    fence: number,
  ): Promise<FallowReviewResult | "pending" | undefined> {
    if (
      !this.fallowReviewEnabled ||
      auditIsOff(this.store.repository, this.store.repository.projectDirectory)
    )
      return undefined
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
  recordPlanFallowOutcome(
    plan: PlanRow,
    review: FallowReviewResult | undefined,
  ): FallowReviewResult | undefined {
    if (review?.status === "unavailable")
      this.store.recordOnce(plan.id, null, "FALLOW_UNAVAILABLE", {
        reason: review.reason ?? "Fallow audit unavailable",
      })
    return review
  }
  async runPlanFallowReview(
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
  planTaskDiffs(plan: PlanRow): PlanTaskDiff[] {
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
  taskChainBase(attempt: AttemptRow): string {
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
  repairAvailable(attempt: AttemptRow): boolean {
    const task = this.store.repository.get(attempt.task_id)!
    const node = this.store.nodes(attempt.plan_id).find((n) => n.task_id === task.id)!
    return (
      node.state === "verifying" &&
      (task.proposal.limits?.maxRepairAttempts ?? 1) > 0 &&
      !JSON.parse(attempt.policy).repairAttempt &&
      !this.retainedRepairForAttempt(attempt)
    )
  }
  async missingEvidence(
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
  repairFailureBrief(attempt: AttemptRow): string {
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
  failAttempt(
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
  returnTakeoverToArchitect(plan: PlanRow, attempt: AttemptRow, reason: string) {
    this.store.atomic((db) => {
      const current = this.store.attempts(plan.id).find((item) => item.id === attempt.id)!
      if (current.state === "verifying") {
        db.query(
          "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'preparing') WHERE id=?",
        ).run(attempt.id)
        db.query(
          "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'running'),artifact=NULL WHERE id=?",
        ).run(attempt.id)
        // Back with the Architect, the task holds its slot again (released while verifying).
        this.delegatedAgentCapacity.holdTaskSlotInTransaction(
          db,
          { planID: plan.id, taskID: attempt.task_id, attemptNumber: attempt.number },
          attempt.id,
        )
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
}

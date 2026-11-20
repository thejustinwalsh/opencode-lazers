import {
  effectSuperseded,
  fallowAcceptance,
  isRecord,
  sameVerificationCheckIdentity,
  actualCheckResultFromEffect,
  errorText,
} from "./runtime-helpers.ts"
import { lstatSync } from "node:fs"
import { extname, join } from "node:path"
import {
  effectiveVerificationCheck,
  verificationCheckWithDefaults,
  verificationReceiptDeadline,
} from "./verification-timeout.ts"
import type { VerificationDeadline } from "./verification-timeout.ts"
import { LEGACY_FALLOW_CHECK_ID, type TaskProposal } from "../task.ts"
import {
  ArtifactScopeViolation,
  artifactUnchanged,
  changedPaths,
  checkResourcesSettled,
  commitArtifact,
  gitAsync,
  runCheck,
  verificationEnvironmentIdentity,
  workingTreeIdentity,
  writeCheckReceipt,
} from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import { protectedPaths, scopeReportEmpty, type ScopeReport } from "./scope.ts"
import { FALLOW_CHECK_ID } from "./fallow-check.ts"
import type { FallowReviewResult } from "../audit/review.ts"
import type { FallowDisposition } from "../audit/contract.ts"
import { dispositionsAfterRepair } from "../audit/fallow-dispositions.ts"
import { checkSucceeded } from "./checks.ts"
import { needsMechanicalQualityPreparation } from "./quality-failure.ts"
import type { EffectRow } from "./store.ts"
import type { AuditorReport } from "./auditor-report.ts"
import type { CheckActivities } from "./check-activities.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"
import type { AttemptRow, PlanRow } from "./store.ts"
import type { VerificationTimeoutDefaults } from "./verification-timeout.ts"
import type { RuntimeCore } from "./runtime-core.ts"

type AuditorPhase = Parameters<AuditorReport>[0] extends { phase: infer P } ? P : never

/** What `VerificationCandidate` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type VerificationCandidateDeps = {
  hold: RuntimeJournal["hold"]
  effect: RuntimeJournal["effect"]
  outcome: RuntimeJournal["outcome"]
  uncertain: RuntimeJournal["uncertain"]
  checkActivity: CheckActivities["checkActivity"]
  startCheckActivity: CheckActivities["startCheckActivity"]
  verificationDeadline: CheckActivities["verificationDeadline"]
  deadlineAwaitingTaskContinuation: CheckActivities["deadlineAwaitingTaskContinuation"]
  verificationTarget: CheckActivities["verificationTarget"]
  runVerificationCheck: CheckActivities["runVerificationCheck"]
  preparationAllowed: (attempt: AttemptRow) => boolean
  retainedRepairGeneration: (planID: string, taskID?: string) => string | undefined
  failAttempt: (plan: PlanRow, attempt: AttemptRow, reason: string) => unknown
  startAuditorReport: (attempt: AttemptRow, phase: AuditorPhase) => void
  verificationTimeoutDefaults: VerificationTimeoutDefaults
}

/**
 * The verification candidate and its checks: preparing the candidate, the check effects and
 * receipts, automatic fixes, and accepting a verified attempt. Moved out of `TaskRuntime` without
 * rewriting; the private aliases below keep the member bodies identical to what they were.
 */
export class VerificationCandidate {
  private readonly hold: VerificationCandidateDeps["hold"]
  private readonly effect: VerificationCandidateDeps["effect"]
  private readonly outcome: VerificationCandidateDeps["outcome"]
  private readonly uncertain: VerificationCandidateDeps["uncertain"]
  private readonly checkActivity: VerificationCandidateDeps["checkActivity"]
  private readonly startCheckActivity: VerificationCandidateDeps["startCheckActivity"]
  private readonly verificationDeadline: VerificationCandidateDeps["verificationDeadline"]
  private readonly deadlineAwaitingTaskContinuation: VerificationCandidateDeps["deadlineAwaitingTaskContinuation"]
  private readonly verificationTarget: VerificationCandidateDeps["verificationTarget"]
  private readonly runVerificationCheck: VerificationCandidateDeps["runVerificationCheck"]
  private readonly preparationAllowed: VerificationCandidateDeps["preparationAllowed"]
  private readonly retainedRepairGeneration: VerificationCandidateDeps["retainedRepairGeneration"]
  private readonly failAttempt: VerificationCandidateDeps["failAttempt"]
  private readonly startAuditorReport: VerificationCandidateDeps["startAuditorReport"]
  private readonly verificationTimeoutDefaults: VerificationCandidateDeps["verificationTimeoutDefaults"]

  constructor(
    private readonly core: RuntimeCore,
    deps: VerificationCandidateDeps,
  ) {
    this.hold = (...args) => deps.hold(...args)
    this.effect = (...args) => deps.effect(...args)
    this.outcome = (...args) => deps.outcome(...args)
    this.uncertain = (...args) => deps.uncertain(...args)
    this.checkActivity = (...args) => deps.checkActivity(...args)
    this.startCheckActivity = (...args) => deps.startCheckActivity(...args)
    this.verificationDeadline = (...args) => deps.verificationDeadline(...args)
    this.deadlineAwaitingTaskContinuation = (...args) =>
      deps.deadlineAwaitingTaskContinuation(...args)
    this.verificationTarget = (...args) => deps.verificationTarget(...args)
    this.runVerificationCheck = (...args) => deps.runVerificationCheck(...args)
    this.preparationAllowed = (...args) => deps.preparationAllowed(...args)
    this.retainedRepairGeneration = (...args) => deps.retainedRepairGeneration(...args)
    this.failAttempt = (...args) => deps.failAttempt(...args)
    this.startAuditorReport = (...args) => deps.startAuditorReport(...args)
    this.verificationTimeoutDefaults = deps.verificationTimeoutDefaults
  }

  private get store() {
    return this.core.store
  }

  private get directory() {
    return this.core.directory
  }

  private get dataDirectory() {
    return this.core.dataDirectory
  }

  private get owner() {
    return this.core.owner
  }

  private get progress() {
    return this.core.progress
  }

  async prepareVerificationCandidate(
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
  verificationCurrentGuard(plan: PlanRow, attempt: AttemptRow, repairID: string | undefined) {
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
  taskVerificationTarget(
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
  verificationAwaitsTaskContinuation(plan: PlanRow, attempt: AttemptRow, proposal: TaskProposal) {
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
  candidateAlreadyChecked(
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
  async commitVerificationCandidate(
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
  recordAttemptArtifact(plan: PlanRow, attempt: AttemptRow, commit: string, fence: number) {
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
  knownVerifyEffect(
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
  holdUncertainVerifyEffect(
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
  startVerifyEffect(
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
  async collectCheckReceipts(
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
  async captureAutomaticFixes(
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
  acceptVerifiedAttempt(
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
  fallowDispositions(
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

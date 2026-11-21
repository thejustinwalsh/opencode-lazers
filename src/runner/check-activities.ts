import { errorText, summarizeCheckReceipt } from "./runtime-helpers.ts"
import { existsSync, readFileSync } from "node:fs"
import { fingerprint } from "../identity.ts"
import {
  effectiveVerificationCheck,
  verificationDeadline as resolveVerificationDeadline,
  verificationReceiptDeadline,
} from "./verification-timeout.ts"
import type { VerificationDeadline, VerificationTimeoutTarget } from "./verification-timeout.ts"
import { type TaskProposal } from "../task.ts"
import { checkResourcesSettled, runDeclaredCheck, writeCheckReceipt } from "./artifacts.ts"
import type { RunnerCheckReceipt } from "./artifacts.ts"
import type { PlanRow } from "./store.ts"
import {
  markRetainedVerificationCheckUncertain,
  retainedVerification,
  retainedVerificationChecks,
  settleRetainedVerificationResources,
} from "./retained-verification/store.ts"
import {
  abortVerificationActivities,
  canonicalVerificationDatabasePath,
  forgetVerificationActivity,
  startVerificationActivity,
  verificationActivity,
  verificationActivityKey,
} from "./verification-activities.ts"
import type { VerificationActivity } from "./verification-activities.ts"
import { observeRetainedCheckIsolationWitness } from "./retained-verification/isolation.ts"
import {
  retainedProcedurePlan,
  retainedProjectIdentity,
} from "./retained-verification/procedure.ts"
import type { AdoptionExecution } from "./adoption-execution.ts"
import type { RetainedVerificationExecution } from "./retained-verification-execution.ts"
import type { CheckRunProfile } from "../projects/profile-runtime.ts"
import type { RuntimeCore } from "./runtime-core.ts"
import type { EffectRow } from "./store.ts"
import type { VerificationTimeoutDefaults } from "./verification-timeout.ts"

/** What the check activities read from the coordinator; calls into siblings are lazy. */
export type CheckActivitiesDeps = {
  requestTick: () => Promise<void>
  verificationTimeoutDefaults: VerificationTimeoutDefaults
  retainedVerificationAborts: Map<string, AbortController>
  retainedVerificationExecution: () => RetainedVerificationExecution
  adoptionExecution: () => AdoptionExecution
  reconcileEffect: (effect: EffectRow, fence: number) => Promise<void>
  /** The profile a check run uses: the pinned revision when given, else the active one. */
  checkProfile: (revisionID?: number) => CheckRunProfile | undefined
}

/**
 * The check-activity infrastructure: starting and finding verification activities, their
 * deadlines and targets, and settling the retained checks a cancellation left behind. Moved
 * out of `TaskRuntime` without rewriting; the private aliases below keep the member bodies
 * identical to what they were.
 */
export class CheckActivities {
  private readonly requestTick: () => Promise<void>
  private readonly verificationTimeoutDefaults: VerificationTimeoutDefaults
  private readonly retainedVerificationAborts: Map<string, AbortController>
  private readonly reconcileEffect: CheckActivitiesDeps["reconcileEffect"]
  private readonly checkProfile: CheckActivitiesDeps["checkProfile"]
  private readonly adoptionExecution: {
    adoptionCheckReceiptMatches: AdoptionExecution["adoptionCheckReceiptMatches"]
  }
  private readonly retainedVerificationExecution: {
    retainedVerificationIsolatedWorkspace: RetainedVerificationExecution["retainedVerificationIsolatedWorkspace"]
    retainedVerificationCheckReceipt: RetainedVerificationExecution["retainedVerificationCheckReceipt"]
    completeRetainedCheck: RetainedVerificationExecution["completeRetainedCheck"]
    cleanupRetainedCheckResources: RetainedVerificationExecution["cleanupRetainedCheckResources"]
  }

  constructor(
    private readonly core: RuntimeCore,
    deps: CheckActivitiesDeps,
  ) {
    this.requestTick = () => deps.requestTick()
    this.verificationTimeoutDefaults = deps.verificationTimeoutDefaults
    this.retainedVerificationAborts = deps.retainedVerificationAborts
    this.reconcileEffect = (...args) => deps.reconcileEffect(...args)
    this.checkProfile = (...args) => deps.checkProfile(...args)
    this.adoptionExecution = {
      adoptionCheckReceiptMatches: (...args) =>
        deps.adoptionExecution().adoptionCheckReceiptMatches(...args),
    }
    this.retainedVerificationExecution = {
      retainedVerificationIsolatedWorkspace: (...args) =>
        deps.retainedVerificationExecution().retainedVerificationIsolatedWorkspace(...args),
      retainedVerificationCheckReceipt: (...args) =>
        deps.retainedVerificationExecution().retainedVerificationCheckReceipt(...args),
      completeRetainedCheck: (...args) =>
        deps.retainedVerificationExecution().completeRetainedCheck(...args),
      cleanupRetainedCheckResources: (...args) =>
        deps.retainedVerificationExecution().cleanupRetainedCheckResources(...args),
    }
  }

  private get store() {
    return this.core.store
  }

  private get owner() {
    return this.core.owner
  }

  private get projectID() {
    return this.core.projectID
  }

  private get directory() {
    return this.core.directory
  }

  private get now() {
    return this.core.now
  }

  startCheckActivity(input: {
    id: string
    identity: unknown
    metadata: Record<string, unknown>
    signal?: AbortSignal
    run(signal: AbortSignal): Promise<RunnerCheckReceipt>
  }): { activity: VerificationActivity<RunnerCheckReceipt>; created: boolean } {
    return startVerificationActivity({
      databasePath: this.store.repository.path,
      key: verificationActivityKey(this.store.repository.path, input.id),
      identity: fingerprint(input.identity),
      owner: this.owner,
      metadata: input.metadata,
      ...(input.signal ? { signal: input.signal } : {}),
      run: input.run,
      summarize: summarizeCheckReceipt,
      onSettled: () => {
        void this.requestTick().catch(() => undefined)
      },
    })
  }
  checkActivity(
    id: string,
    identity: unknown,
  ): VerificationActivity<RunnerCheckReceipt> | undefined {
    return verificationActivity(
      verificationActivityKey(this.store.repository.path, id),
      fingerprint(identity),
    )
  }
  verificationDeadline(target: VerificationTimeoutTarget): VerificationDeadline {
    return resolveVerificationDeadline(
      this.store.verificationTimeoutAmendments(target.planID),
      target,
    )
  }
  deadlineAwaitingTaskContinuation(
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
  verificationTarget(
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
  async runVerificationCheck(
    workspace: string,
    artifact: string,
    check: TaskProposal["verification"][number],
    deadline: VerificationDeadline,
    receiptPath: string,
    options?: Parameters<typeof runDeclaredCheck>[4] & { profileRevisionID?: number },
  ): Promise<RunnerCheckReceipt> {
    // A verify effect pins the revision it started with; every other run reads the active one.
    const { profileRevisionID, ...runOptions } = options ?? {}
    const profile = runOptions.profile ?? this.checkProfile(profileRevisionID)
    const receipt = await runDeclaredCheck(
      workspace,
      artifact,
      effectiveVerificationCheck(check, deadline),
      receiptPath,
      options === undefined && !profile
        ? undefined
        : { ...runOptions, ...(profile ? { profile } : {}) },
    )
    const annotated = {
      ...receipt,
      verificationDeadline: verificationReceiptDeadline(deadline),
    }
    await writeCheckReceipt(receiptPath, annotated)
    return annotated
  }
  async cancelCheckActivities(planID: string): Promise<VerificationActivity[]> {
    return abortVerificationActivities(
      (activity) =>
        activity.metadata.databasePath ===
          canonicalVerificationDatabasePath(this.store.repository.path) &&
        activity.metadata.projectDirectory === this.directory &&
        activity.metadata.planID === planID,
    )
  }
  retainedCheckSettlementProblem(operationID: string): string | undefined {
    return this.store.atomic((db) => {
      for (const check of retainedVerificationChecks(db, operationID)) {
        if (check.state !== "completed" || !check.receipt)
          return "Retained check has no conclusive final receipt"
        try {
          const receipt = JSON.parse(check.receipt) as RunnerCheckReceipt
          if (!checkResourcesSettled(receipt))
            return `Command exited ${receipt.exitCode ?? "unknown"} with timedOut=${receipt.timedOut}; subprocess cleanup remains uncertain`
        } catch {
          return "Retained check settlement receipt is unreadable"
        }
      }
      return undefined
    })
  }
  async reconcileCancelledCheckActivities(
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
        let receipt: RunnerCheckReceipt | undefined
        try {
          if (existsSync(row.receipt_path))
            receipt = JSON.parse(readFileSync(row.receipt_path, "utf8")) as RunnerCheckReceipt
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
  async settleCancelledRetainedActivity(activity: VerificationActivity): Promise<void> {
    await this.settleCancelledRetainedReceipt(activity.metadata, activity)
  }
  async recoverCancelledRetainedChecks(operationID: string): Promise<void> {
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
  async settleCancelledRetainedReceipt(
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
    let receipt: RunnerCheckReceipt | undefined
    try {
      if (existsSync(row.receiptPath))
        receipt = JSON.parse(readFileSync(row.receiptPath, "utf8")) as RunnerCheckReceipt
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
}

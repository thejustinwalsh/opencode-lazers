import { existsSync, readFileSync } from "node:fs"
import { gitAsync } from "./artifacts.ts"
import { isStartupWorktreeCandidate } from "./startup-recovery.ts"
import { terminalPlanStates as terminal } from "./plan-control.ts"
import { errorText, messageID, isRerunnableEffect } from "./runtime-helpers.ts"
import { fingerprint } from "../identity.ts"
import { checkResourcesSettled } from "./artifacts.ts"
import type { RunnerCheckReceipt } from "./artifacts.ts"
import { protectedPaths } from "./scope.ts"
import type { WorkerInstruction } from "./host.ts"
import { hostMessageByID } from "./host-reads.ts"
import { nativeWorktreeFailureFromReceipt } from "./startup-recovery.ts"
import { forgetVerificationActivity, verificationActivityKey } from "./verification-activities.ts"
import type { CheckActivities } from "./check-activities.ts"
import type { EffectRow } from "./store.ts"
import type { RetickRequest } from "./runtime-core.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `EffectReconciliation` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type EffectReconciliationDeps = {
  supersedeEffect: RuntimeJournal["supersedeEffect"]
  uncertain: RuntimeJournal["uncertain"]
  receipt: RuntimeJournal["receipt"]
  checkActivity: CheckActivities["checkActivity"]
  resumeStartupRecovery: (
    effect: EffectRow,
    fence: number,
    workspace: string,
    startupRecoveryReason: string,
  ) => void
  requestRetick: RetickRequest
}

/**
 * Effect reconciliation: replaying or settling an effect left intended or uncertain, by kind, and
 * settling a matched check. Moved out of `TaskRuntime` without rewriting, except that the two
 * `this.requestRetick()` writes became `this.requestRetick()`; the private aliases below keep
 * the member bodies identical to what they were.
 */
export class EffectReconciliation {
  private readonly supersedeEffect: EffectReconciliationDeps["supersedeEffect"]
  private readonly uncertain: EffectReconciliationDeps["uncertain"]
  private readonly receipt: EffectReconciliationDeps["receipt"]
  private readonly checkActivity: EffectReconciliationDeps["checkActivity"]
  private readonly resumeStartupRecovery: EffectReconciliationDeps["resumeStartupRecovery"]
  private readonly requestRetick: EffectReconciliationDeps["requestRetick"]

  constructor(
    private readonly core: RuntimeCore,
    deps: EffectReconciliationDeps,
  ) {
    this.supersedeEffect = (...args) => deps.supersedeEffect(...args)
    this.uncertain = (...args) => deps.uncertain(...args)
    this.receipt = (...args) => deps.receipt(...args)
    this.checkActivity = (...args) => deps.checkActivity(...args)
    this.resumeStartupRecovery = (...args) => deps.resumeStartupRecovery(...args)
    this.requestRetick = deps.requestRetick
  }

  private get store() {
    return this.core.store
  }

  private get host() {
    return this.core.host
  }

  private get owner() {
    return this.core.owner
  }

  private get projectID() {
    return this.core.projectID
  }

  private get progress() {
    return this.core.progress
  }

  async reconcileEffect(effect: EffectRow, fence: number) {
    const payload = JSON.parse(effect.payload)
    try {
      if (await this.reconcileEffectByKind(effect, payload, fence)) return
      if (isRerunnableEffect(effect.kind)) {
        // A check reads its candidate: without a settled receipt it simply runs again.
        this.forgetCheckActivity(effect, { effectID: effect.id, payload: effect.payload })
        this.supersedeEffect(effect, "No settled receipt was recorded; the check re-runs", fence)
        this.requestRetick()
        return
      }
      if (effect.state !== "uncertain")
        this.uncertain(
          effect,
          "No conclusive host/artifact receipt; effect was not repeated",
          fence,
        )
    } catch (error) {
      if (isRerunnableEffect(effect.kind)) {
        this.supersedeEffect(effect, `The check re-runs: ${errorText(error)}`, fence)
        this.requestRetick()
      } else if (effect.state !== "uncertain") this.uncertain(effect, error, fence)
    }
  }
  /** True when the effect's kind settled it; false leaves the generic no-receipt handling to run. */
  async reconcileEffectByKind(effect: EffectRow, payload: any, fence: number): Promise<boolean> {
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
  async reconcileScopeInstruction(
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
  async reconcileSessionEffect(effect: EffectRow, payload: any, fence: number): Promise<boolean> {
    const session = await this.host.session(payload.sessionID)
    if (!session) return false
    this.receipt(effect, { sessionID: session.id, reconciled: true }, fence)
    return true
  }
  async reconcilePromptEffect(effect: EffectRow, payload: any, fence: number): Promise<boolean> {
    // One point read answers both checks below.
    const delivered = await hostMessageByID(this.host, payload.sessionID, payload.messageID)
    if (delivered) {
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
  async reconcileWorktreeEffect(effect: EffectRow, payload: any, fence: number): Promise<boolean> {
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
  /** Drops the in-memory activity record of a check the reconciler has now settled. */
  forgetCheckActivity(effect: EffectRow, activityIdentity: unknown) {
    forgetVerificationActivity(
      verificationActivityKey(this.store.repository.path, effect.id),
      fingerprint(activityIdentity),
    )
  }
  /** Settles a check effect from its in-memory activity and the receipt the subprocess left. */
  async reconcileCheckEffect(effect: EffectRow, payload: any, fence: number): Promise<boolean> {
    const activityIdentity = { effectID: effect.id, payload: effect.payload }
    const activity = this.checkActivity(effect.id, activityIdentity)
    if (activity?.state === "running") return true
    const check = readCheckReceipt(payload)
    if (check && (await this.checkReceiptMatchesEffect(effect, payload, check)))
      return this.settleMatchedCheck(effect, check, fence, activityIdentity)
    return false
  }
  async checkReceiptMatchesEffect(
    effect: EffectRow,
    payload: any,
    check: RunnerCheckReceipt,
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
      !protectedPaths(preparation.paths, this.store.effectiveScope(effect.task_id!)).length
    )
  }
  /** A completed, settled receipt completes the effect; an aborted or unsettled one does not. */
  settleMatchedCheck(
    effect: EffectRow,
    check: RunnerCheckReceipt,
    fence: number,
    activityIdentity: unknown,
  ): boolean {
    if (check.aborted || !checkResourcesSettled(check)) return false
    if (effect.kind.startsWith("verify:") && effect.attempt_id && effect.task_id)
      this.recordVerificationEvidence(effect, check)
    this.receipt(effect, { check, reconciled: true }, fence)
    this.requestRetick()
    this.forgetCheckActivity(effect, activityIdentity)
    return true
  }
  recordVerificationEvidence(effect: EffectRow, check: RunnerCheckReceipt) {
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
function readCheckReceipt(payload: { receiptPath: string }): RunnerCheckReceipt | undefined {
  return existsSync(payload.receiptPath)
    ? (JSON.parse(readFileSync(payload.receiptPath, "utf8")) as RunnerCheckReceipt)
    : undefined
}

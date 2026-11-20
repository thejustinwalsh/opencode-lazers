import {
  sameVerificationCheckIdentity,
  actualCheckResultFromEffect,
  errorText,
  effectSuperseded,
  fallowAcceptance,
} from "./runtime-helpers.ts"
import { isTakeoverAttempt } from "../recovery/detector.ts"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { effectiveVerificationCheck, verificationReceiptDeadline } from "./verification-timeout.ts"
import {
  artifactUnchanged,
  checkResourcesSettled,
  canonicalCombinedArtifact,
  combineArtifacts,
  gitAsync,
} from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import { checkSucceeded } from "./checks.ts"
import { PlanInput } from "./schema.ts"
import type { PlanRow } from "./store.ts"
import { canonicalProjectWorktreePath } from "./workspace-location.ts"
import type { CheckActivities } from "./check-activities.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"
import type { VerificationReview } from "./verification-review.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `PlanFinish` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type PlanFinishDeps = {
  effect: RuntimeJournal["effect"]
  hold: RuntimeJournal["hold"]
  outcome: RuntimeJournal["outcome"]
  receipt: RuntimeJournal["receipt"]
  uncertain: RuntimeJournal["uncertain"]
  checkActivity: CheckActivities["checkActivity"]
  startCheckActivity: CheckActivities["startCheckActivity"]
  runVerificationCheck: CheckActivities["runVerificationCheck"]
  verificationDeadline: CheckActivities["verificationDeadline"]
  verificationTarget: CheckActivities["verificationTarget"]
  missingEvidence: VerificationReview["missingEvidence"]
  planFallowReview: VerificationReview["planFallowReview"]
  retainedRepairGeneration: (planID: string, taskID?: string) => string | undefined
}

/**
 * Plan finish: the combined plan check and graph verification, the plan Fallow review, and the
 * transition to accepted. Moved out of `TaskRuntime` without rewriting; the private aliases below
 * keep the member body identical to what it was.
 */
export class PlanFinish {
  private readonly effect: PlanFinishDeps["effect"]
  private readonly hold: PlanFinishDeps["hold"]
  private readonly outcome: PlanFinishDeps["outcome"]
  private readonly receipt: PlanFinishDeps["receipt"]
  private readonly uncertain: PlanFinishDeps["uncertain"]
  private readonly checkActivity: PlanFinishDeps["checkActivity"]
  private readonly startCheckActivity: PlanFinishDeps["startCheckActivity"]
  private readonly runVerificationCheck: PlanFinishDeps["runVerificationCheck"]
  private readonly verificationDeadline: PlanFinishDeps["verificationDeadline"]
  private readonly verificationTarget: PlanFinishDeps["verificationTarget"]
  private readonly missingEvidence: PlanFinishDeps["missingEvidence"]
  private readonly planFallowReview: PlanFinishDeps["planFallowReview"]
  private readonly retainedRepairGeneration: PlanFinishDeps["retainedRepairGeneration"]

  constructor(
    private readonly core: RuntimeCore,
    deps: PlanFinishDeps,
  ) {
    this.checkActivity = (...args) => deps.checkActivity(...args)
    this.effect = (...args) => deps.effect(...args)
    this.hold = (...args) => deps.hold(...args)
    this.missingEvidence = (...args) => deps.missingEvidence(...args)
    this.outcome = (...args) => deps.outcome(...args)
    this.planFallowReview = (...args) => deps.planFallowReview(...args)
    this.receipt = (...args) => deps.receipt(...args)
    this.retainedRepairGeneration = (...args) => deps.retainedRepairGeneration(...args)
    this.runVerificationCheck = (...args) => deps.runVerificationCheck(...args)
    this.startCheckActivity = (...args) => deps.startCheckActivity(...args)
    this.uncertain = (...args) => deps.uncertain(...args)
    this.verificationDeadline = (...args) => deps.verificationDeadline(...args)
    this.verificationTarget = (...args) => deps.verificationTarget(...args)
  }

  private get host() {
    return this.core.host
  }

  private get owner() {
    return this.core.owner
  }

  private get directory() {
    return this.core.directory
  }

  private get store() {
    return this.core.store
  }

  private get dataDirectory() {
    return this.core.dataDirectory
  }

  async finish(plan: PlanRow, fence: number) {
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
}

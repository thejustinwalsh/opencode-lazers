import type { Database } from "bun:sqlite"
import { terminalPlanStates as terminal } from "./plan-control.ts"
import { GitObservations, ObservationRequired } from "./git-observations.ts"
import { errorText } from "./runtime-helpers.ts"
import type { CommandContext } from "./runtime-helpers.ts"

import { isTakeoverAttempt } from "../recovery/detector.ts"

import { existsSync } from "node:fs"

import { ModelPolicy, PlanInput } from "./schema.ts"
import type { PlanRow, AttemptRow } from "./store.ts"
import {
  activeRetainedVerifications,
  saveRetainedVerification,
} from "./retained-verification/store.ts"
import type { Dispatch } from "./dispatch.ts"
import type { RetainedRepairPreparation } from "./retained-repair-preparation.ts"
import type { RetainedRepairRecords } from "./retained-repair-records.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { TakeoverExecution } from "./takeover.ts"
import type { RetickRequest } from "./runtime-core.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `CommandsControl` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type CommandsControlDeps = {
  hold: RuntimeJournal["hold"]
  resolveTaskDispatchRoute: Dispatch["resolveTaskDispatchRoute"]
  assertNoDispatchedDependents: RetainedRepairPreparation["assertNoDispatchedDependents"]
  requestRetick: RetickRequest
  takeovers: TakeoverExecution
  retainedVerificationAborts: Map<string, AbortController>
  parseTransitionPayload: RetainedRepairRecords["parseTransitionPayload"]
  validArchitect: ArchitectOwnership["validArchitect"]
}

/**
 * Run, cancel, reassign and takeover commands: the handlers that start, stop or hand over work. Each
 * runs inside `store.command`, so none awaits. Moved out of `TaskRuntime` without rewriting, except that
 * the one `this.requestRetick()` became `this.requestRetick()`; the private aliases below keep the
 * member bodies identical to what they were.
 */
export class CommandsControl {
  private readonly hold: CommandsControlDeps["hold"]
  private readonly resolveTaskDispatchRoute: CommandsControlDeps["resolveTaskDispatchRoute"]
  private readonly assertNoDispatchedDependents: CommandsControlDeps["assertNoDispatchedDependents"]
  private readonly requestRetick: CommandsControlDeps["requestRetick"]
  private readonly takeovers: CommandsControlDeps["takeovers"]
  private readonly retainedVerificationAborts: CommandsControlDeps["retainedVerificationAborts"]
  private readonly parseTransitionPayload: CommandsControlDeps["parseTransitionPayload"]
  private readonly validArchitect: CommandsControlDeps["validArchitect"]

  constructor(
    private readonly core: RuntimeCore,
    deps: CommandsControlDeps,
  ) {
    this.hold = (...args) => deps.hold(...args)
    this.resolveTaskDispatchRoute = (...args) => deps.resolveTaskDispatchRoute(...args)
    this.assertNoDispatchedDependents = (...args) => deps.assertNoDispatchedDependents(...args)
    this.requestRetick = deps.requestRetick
    this.takeovers = deps.takeovers
    this.retainedVerificationAborts = deps.retainedVerificationAborts
    this.parseTransitionPayload = deps.parseTransitionPayload
    this.validArchitect = deps.validArchitect
  }

  private get directory() {
    return this.core.directory
  }

  private get now() {
    return this.core.now
  }

  private get projectID() {
    return this.core.projectID
  }

  private get store() {
    return this.core.store
  }

  private get host() {
    return this.core.host
  }

  commandReassign(db: Database, ctx: CommandContext, plan: PlanRow) {
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
  commandTakeoverSubmit(ctx: CommandContext, plan: PlanRow) {
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
      this.store.activityCount(plan.id, attempt.task_id, {
        events: ["TAKEOVER_SUBMITTED"],
        payload: { attemptID: attempt.id },
      }) + 1
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
    this.requestRetick()
    return { status: "takeover-submitted", attemptID: attempt.id, version: plan.version }
  }
  /** The retained-repair boundaries, for the Architect's own accepted takeover result. */
  assertTakeoverReopenable(plan: PlanRow, attempt: AttemptRow, obs: GitObservations) {
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
  async holdAbandonedTakeover(plan: PlanRow, attempt: AttemptRow) {
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
  commandCancel(db: Database, ctx: CommandContext, plan: PlanRow) {
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
  commandRun(db: Database, ctx: CommandContext, plan: PlanRow) {
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
}

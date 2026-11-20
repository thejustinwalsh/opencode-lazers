import type { Database } from "bun:sqlite"
import { terminalPlanStates as terminal } from "./plan-control.ts"
import { isRerunnableEffect } from "./runtime-helpers.ts"
import type { CommandContext } from "./runtime-helpers.ts"
import { fingerprint } from "../identity.ts"
import { scopePatternsConflict } from "./artifacts.ts"
import { classifyChanges } from "./scope.ts"
import type { WorkerInstruction } from "./host.ts"
import type { PlanRow } from "./store.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { VerificationReview } from "./verification-review.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `CommandsScope` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type CommandsScopeDeps = {
  repairAvailable: VerificationReview["repairAvailable"]
  validArchitect: ArchitectOwnership["validArchitect"]
}

/**
 * Scope commands: amending the write scope, and the divergence decisions (send back, continue). Each
 * handler runs inside `store.command`, so none awaits. Moved out of `TaskRuntime` without rewriting; the
 * private aliases below keep the member bodies identical to what they were.
 */
export class CommandsScope {
  private readonly repairAvailable: CommandsScopeDeps["repairAvailable"]
  private readonly validArchitect: CommandsScopeDeps["validArchitect"]

  constructor(
    private readonly core: RuntimeCore,
    deps: CommandsScopeDeps,
  ) {
    this.repairAvailable = (...args) => deps.repairAvailable(...args)
    this.validArchitect = deps.validArchitect
  }

  private get projectID() {
    return this.core.projectID
  }

  private get store() {
    return this.core.store
  }

  commandAmendScope(db: Database, ctx: CommandContext, plan: PlanRow) {
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
  divergenceHold(plan: PlanRow, taskID: string | undefined) {
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
  commandSendBackDivergence(db: Database, ctx: CommandContext, plan: PlanRow) {
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
  continueAfterDivergenceDecision(
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
}

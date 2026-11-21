import {
  actualCheckResultFromEffect,
  checkSettlementProblem,
  errorText,
} from "./runtime-helpers.ts"
import { isTakeoverAttempt } from "../recovery/detector.ts"
import { checkResourcesSettled, scopePatternsConflict } from "./artifacts.ts"
import { PlanInput } from "./schema.ts"
import type { PlanRow, NodeRow, AttemptRow } from "./store.ts"
import { selectSchedulingCandidates } from "./scheduling-selection.ts"
import type { SchedulingReservation } from "./scheduling-selection.ts"
import { retainedVerificationsForPlan } from "./retained-verification/store.ts"
import type { AttemptAdvance } from "./attempt-advance.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { CheckActivities } from "./check-activities.ts"
import type { Cancellation } from "./cancellation.ts"
import type { TaskRuntime } from "./runtime.ts"
import type { ArchitectRenewal } from "./architect-renewal.ts"
import type { Dispatch } from "./dispatch.ts"
import type { PlanFinish } from "./plan-finish.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"
import type { CommandsControl } from "./commands-control.ts"
import type { EffectReconciliation } from "./effect-reconciliation.ts"
import type { RetainedRepairRecords } from "./retained-repair-records.ts"
import type { StartupSettlement } from "./startup-settlement.ts"
import type { VerificationReview } from "./verification-review.ts"
import type { AdoptionExecution } from "./adoption-execution.ts"
import type { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"
import type { TakeoverExecution } from "./takeover.ts"
import type { WorktreeCleanup } from "./worktree-cleanup.ts"
import type { RetickRequest } from "./runtime-core.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `PlanStep` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type PlanStepDeps = {
  advanceAttempt: AttemptAdvance["advanceAttempt"]
  architectRoute: ArchitectOwnership["architectRoute"]
  recordArchitectRoute: ArchitectOwnership["recordArchitectRoute"]
  ensureArchitectOwner: ArchitectOwnership["ensureArchitectOwner"]
  cancelCheckActivities: CheckActivities["cancelCheckActivities"]
  reconcileCancelledCheckActivities: CheckActivities["reconcileCancelledCheckActivities"]
  recoverCancelledRetainedChecks: CheckActivities["recoverCancelledRetainedChecks"]
  cancelReservedAttempt: Cancellation["cancelReservedAttempt"]
  cancelWorkers: Cancellation["cancelWorkers"]
  command: TaskRuntime["command"]
  continueArchitectRenewal: ArchitectRenewal["continueArchitectRenewal"]
  dispatch: Dispatch["dispatch"]
  integratedPrerequisiteBaseline: Dispatch["integratedPrerequisiteBaseline"]
  preparationAllowed: Dispatch["preparationAllowed"]
  taskDependencyIDs: Dispatch["taskDependencyIDs"]
  taskDependencyIntegration: Dispatch["taskDependencyIntegration"]
  finish: PlanFinish["finish"]
  hold: RuntimeJournal["hold"]
  outcome: RuntimeJournal["outcome"]
  holdAbandonedTakeover: CommandsControl["holdAbandonedTakeover"]
  reconcileEffect: EffectReconciliation["reconcileEffect"]
  retainedRepairForAttempt: RetainedRepairRecords["retainedRepairForAttempt"]
  settledStartupEffect: StartupSettlement["settledStartupEffect"]
  verify: VerificationReview["verify"]
  requestRetick: RetickRequest
  adoptionExecution: AdoptionExecution
  takeovers: TakeoverExecution
  worktreeCleanup: WorktreeCleanup
  delegatedAgentCapacity: DelegatedAgentCapacity
  validArchitect: ArchitectOwnership["validArchitect"]
  timed: <T>(name: string, run: () => Promise<T>) => Promise<T>
}

/**
 * One scheduler step for a plan: reconciling cancelled dependencies, then walking the plan's tasks and
 * attempts through dispatch, advance, verification, finish and Architect renewal, in the order the tick
 * expects. Moved out of `TaskRuntime` without rewriting, except that each `this.requestRetick()`
 * became `this.requestRetick()`; the private aliases below keep the member bodies identical.
 */
export class PlanStep {
  private readonly advanceAttempt: PlanStepDeps["advanceAttempt"]
  private readonly architectRoute: PlanStepDeps["architectRoute"]
  private readonly recordArchitectRoute: PlanStepDeps["recordArchitectRoute"]
  private readonly ensureArchitectOwner: PlanStepDeps["ensureArchitectOwner"]
  private readonly cancelCheckActivities: PlanStepDeps["cancelCheckActivities"]
  private readonly reconcileCancelledCheckActivities: PlanStepDeps["reconcileCancelledCheckActivities"]
  private readonly recoverCancelledRetainedChecks: PlanStepDeps["recoverCancelledRetainedChecks"]
  private readonly cancelReservedAttempt: PlanStepDeps["cancelReservedAttempt"]
  private readonly cancelWorkers: PlanStepDeps["cancelWorkers"]
  private readonly command: PlanStepDeps["command"]
  private readonly continueArchitectRenewal: PlanStepDeps["continueArchitectRenewal"]
  private readonly dispatch: PlanStepDeps["dispatch"]
  private readonly integratedPrerequisiteBaseline: PlanStepDeps["integratedPrerequisiteBaseline"]
  private readonly preparationAllowed: PlanStepDeps["preparationAllowed"]
  private readonly taskDependencyIDs: PlanStepDeps["taskDependencyIDs"]
  private readonly taskDependencyIntegration: PlanStepDeps["taskDependencyIntegration"]
  private readonly finish: PlanStepDeps["finish"]
  private readonly hold: PlanStepDeps["hold"]
  private readonly outcome: PlanStepDeps["outcome"]
  private readonly holdAbandonedTakeover: PlanStepDeps["holdAbandonedTakeover"]
  private readonly reconcileEffect: PlanStepDeps["reconcileEffect"]
  private readonly retainedRepairForAttempt: PlanStepDeps["retainedRepairForAttempt"]
  private readonly settledStartupEffect: PlanStepDeps["settledStartupEffect"]
  private readonly verify: PlanStepDeps["verify"]
  private readonly requestRetick: PlanStepDeps["requestRetick"]
  private readonly adoptionExecution: PlanStepDeps["adoptionExecution"]
  private readonly takeovers: PlanStepDeps["takeovers"]
  private readonly worktreeCleanup: PlanStepDeps["worktreeCleanup"]
  private readonly delegatedAgentCapacity: PlanStepDeps["delegatedAgentCapacity"]
  private readonly validArchitect: PlanStepDeps["validArchitect"]
  private readonly timed: PlanStepDeps["timed"]

  constructor(
    private readonly core: RuntimeCore,
    deps: PlanStepDeps,
  ) {
    this.advanceAttempt = (...args) => deps.advanceAttempt(...args)
    this.architectRoute = (...args) => deps.architectRoute(...args)
    this.recordArchitectRoute = (...args) => deps.recordArchitectRoute(...args)
    this.ensureArchitectOwner = (...args) => deps.ensureArchitectOwner(...args)
    this.cancelCheckActivities = (...args) => deps.cancelCheckActivities(...args)
    this.reconcileCancelledCheckActivities = (...args) =>
      deps.reconcileCancelledCheckActivities(...args)
    this.recoverCancelledRetainedChecks = (...args) => deps.recoverCancelledRetainedChecks(...args)
    this.cancelReservedAttempt = (...args) => deps.cancelReservedAttempt(...args)
    this.cancelWorkers = (...args) => deps.cancelWorkers(...args)
    this.command = (...args) => deps.command(...args)
    this.continueArchitectRenewal = (...args) => deps.continueArchitectRenewal(...args)
    this.dispatch = (...args) => deps.dispatch(...args)
    this.integratedPrerequisiteBaseline = (...args) => deps.integratedPrerequisiteBaseline(...args)
    this.preparationAllowed = (...args) => deps.preparationAllowed(...args)
    this.taskDependencyIDs = (...args) => deps.taskDependencyIDs(...args)
    this.taskDependencyIntegration = (...args) => deps.taskDependencyIntegration(...args)
    this.finish = (...args) => deps.finish(...args)
    this.hold = (...args) => deps.hold(...args)
    this.outcome = (...args) => deps.outcome(...args)
    this.holdAbandonedTakeover = (...args) => deps.holdAbandonedTakeover(...args)
    this.reconcileEffect = (...args) => deps.reconcileEffect(...args)
    this.retainedRepairForAttempt = (...args) => deps.retainedRepairForAttempt(...args)
    this.settledStartupEffect = (...args) => deps.settledStartupEffect(...args)
    this.verify = (...args) => deps.verify(...args)
    this.requestRetick = deps.requestRetick
    this.adoptionExecution = deps.adoptionExecution
    this.takeovers = deps.takeovers
    this.worktreeCleanup = deps.worktreeCleanup
    this.delegatedAgentCapacity = deps.delegatedAgentCapacity
    this.validArchitect = deps.validArchitect
    this.timed = deps.timed
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

  /**
   * A cancelled prerequisite drops its dependency edge and notifies the
   * Architect; dependents are never held on it. The dropped edge is recorded
   * in a plan revision. A hold left by an earlier version is released through
   * the task and plan machines.
   */
  reconcileCancelledDependencies(planID: string, fence: number) {
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
  releaseLegacyDependencyHold(planID: string) {
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
  interruptedChecksFor(plan: PlanRow, attempt: AttemptRow) {
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
  async step(initialPlan: PlanRow, fence: number) {
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
      // Only a check process still running fences terminal settlement. A finished check whose
      // receipt or subprocess cleanup is uncertain keeps its resources as durable
      // cleanup-pending rows for the terminal cleanup retry; it no longer holds the plan.
      const running = activities.find((activity) => activity.state === "running")
      if (running) {
        // Continue cancellation of other owned workers without declaring idle.
        await this.timed("step:cancelWorkers", () => this.cancelWorkers(plan!, fence, false))
        const reason = `Verification cancellation settlement is uncertain: ${checkSettlementProblem(running)}`
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
    // The newest renewal's state decides; the row (with its continuity) is loaded only when live.
    const planHead = contactPaused ? undefined : this.store.architectRenewalHeadForPlan(plan.id)
    const planRenewal =
      planHead &&
      ["creating", "archiving", "recovering-input", "rolling-back"].includes(planHead.state)
        ? this.store.architectRenewal(planHead.id)
        : undefined
    if (planRenewal) {
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
      const sourceHead = this.store.architectRenewalHeadForSource(owner.id)
      const renewal =
        sourceHead &&
        ["creating", "archiving", "recovering-input", "rolling-back"].includes(sourceHead.state)
          ? this.store.architectRenewal(sourceHead.id)
          : undefined
      if (renewal) {
        await this.timed("step:continueArchitectRenewal", () =>
          this.continueArchitectRenewal(renewal, fence),
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
        this.requestRetick()
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
        this.requestRetick()
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
}

import type { RetainedRepairRecoverySeed } from "./runtime-helpers.ts"
import { sameModelSnapshot } from "./model-route.ts"

import type { HostSession } from "./host.ts"
import { ModelPolicy, PlanInput } from "./schema.ts"
import type { CommandInput as PlanCommand } from "./schema.ts"
import type { PlanRow, AttemptRow, EffectRow } from "./store.ts"
import type { RetainedRepairPreparation } from "./retained-repair-preparation.ts"
import { terminalWorkerContinuationProblem as checkTerminalWorkerContinuation } from "./interrupted-continuation.ts"
import { DispatchRouteDecisionSchema } from "../models/dispatch-resolution.ts"
import type { CommandContext } from "./runtime-helpers.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { Dispatch } from "./dispatch.ts"
import type { RetainedRepairRecords } from "./retained-repair-records.ts"
import type { WorkerObservation } from "./worker-observation.ts"
import type { RuntimeCore } from "./runtime-core.ts"
import { terminalWorkerHoldForContinuation } from "./terminal-worker-hold.ts"

/** What `ContinuationPreparation` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type ContinuationPreparationDeps = {
  matchesWorkerInput: WorkerObservation["matchesWorkerInput"]
  interruptedChecksFor: (plan: PlanRow, attempt: AttemptRow) => EffectRow[]
  prepareRetainedRepairRecovery: RetainedRepairPreparation["prepareRetainedRepairRecovery"]
  preparationAllowed: Dispatch["preparationAllowed"]
  retainedRepairForAttempt: RetainedRepairRecords["retainedRepairForAttempt"]
  validArchitect: ArchitectOwnership["validArchitect"]
}

/**
 * Continuation preparation: why a terminal worker cannot continue, and the resume, terminal and
 * combined-verification continuation checks the commands run. Moved out of `TaskRuntime` without
 * rewriting; the private aliases below keep the member bodies identical to what they were.
 */
export class ContinuationPreparation {
  private readonly matchesWorkerInput: ContinuationPreparationDeps["matchesWorkerInput"]
  private readonly interruptedChecksFor: ContinuationPreparationDeps["interruptedChecksFor"]
  private readonly prepareRetainedRepairRecovery: ContinuationPreparationDeps["prepareRetainedRepairRecovery"]
  private readonly preparationAllowed: ContinuationPreparationDeps["preparationAllowed"]
  private readonly retainedRepairForAttempt: ContinuationPreparationDeps["retainedRepairForAttempt"]
  private readonly validArchitect: ContinuationPreparationDeps["validArchitect"]

  constructor(
    private readonly core: RuntimeCore,
    deps: ContinuationPreparationDeps,
  ) {
    this.matchesWorkerInput = (...args) => deps.matchesWorkerInput(...args)
    this.interruptedChecksFor = (...args) => deps.interruptedChecksFor(...args)
    this.prepareRetainedRepairRecovery = (...args) => deps.prepareRetainedRepairRecovery(...args)
    this.preparationAllowed = (...args) => deps.preparationAllowed(...args)
    this.retainedRepairForAttempt = (...args) => deps.retainedRepairForAttempt(...args)
    this.validArchitect = deps.validArchitect
  }

  private get projectID() {
    return this.core.projectID
  }

  private get directory() {
    return this.core.directory
  }

  private get host() {
    return this.core.host
  }

  private get store() {
    return this.core.store
  }

  terminalWorkerContinuationProblem(
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
    const planHoldObservation = terminalWorkerHoldForContinuation(
      this.store,
      plan,
      node,
      attempt,
      worker?.turn?.inputID,
      this.matchesWorkerInput,
    )
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
  /**
   * `resume` without a task re-runs the combined check on the current
   * candidate. It needs a live Architect and a blocked, unaccepted plan; no
   * earlier receipt, fingerprint or deadline has to match.
   */
  assertCombinedVerificationResume(
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
  /** Resume of a task: the worker continuation or retained-repair recovery its latest attempt allows. */
  async prepareResumeContinuation(
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
  async prepareTerminalContinuation(
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
  assertTerminalContinuation(ctx: CommandContext, plan: PlanRow, attempt: AttemptRow | undefined) {
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
}

import type { RetainedRepairRecoverySeed, RetainedRepairSeed } from "./runtime-helpers.ts"
import { messageID, isCommitID } from "./runtime-helpers.ts"
import { sameModelSnapshot } from "./model-route.ts"
import { existsSync, realpathSync } from "node:fs"
import { commitIsAncestor, gitAsync } from "./artifacts.ts"
import type { HostSession } from "./host.ts"
import { ModelPolicy, PlanInput } from "./schema.ts"
import type { CommandInput as PlanCommand } from "./schema.ts"
import { PlanMovedDuringCommand } from "./plan-commands.ts"
import type { PlanRow, AttemptRow } from "./store.ts"
import {
  RETAINED_REPAIR_FENCE_FAILURE_REASON,
  terminalWorkerContinuationProblem as checkTerminalWorkerContinuation,
} from "./interrupted-continuation.ts"
import type {
  TerminalWorkerHold,
  TerminalWorkerContinuationFacts,
} from "./interrupted-continuation.ts"
import { samePhysicalWorkspace } from "./workspace-location.ts"
import { observeReviewInput } from "./review-input.ts"
import type { ReviewInputBinding, ReviewInputEvidence } from "./review-input.ts"
import { retainedVerificationsForPlan } from "./retained-verification/store.ts"
import { sameProject } from "../project-key.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { Dispatch } from "./dispatch.ts"
import type { RetainedRepairRecords } from "./retained-repair-records.ts"
import type { WorkerObservation } from "./worker-observation.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `RetainedRepairPreparation` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type RetainedRepairPreparationDeps = {
  transitionHistory: RetainedRepairRecords["transitionHistory"]
  retainedAttemptModel: RetainedRepairRecords["retainedAttemptModel"]
  retainedRepairObservation: RetainedRepairRecords["retainedRepairObservation"]
  retainedRepairWorkerProblem: RetainedRepairRecords["retainedRepairWorkerProblem"]
  retainedRepairBackgroundProblem: RetainedRepairRecords["retainedRepairBackgroundProblem"]
  retainedRepairForAttempt: RetainedRepairRecords["retainedRepairForAttempt"]
  preparationAllowed: Dispatch["preparationAllowed"]
  matchesWorkerInput: WorkerObservation["matchesWorkerInput"]
  parseTransitionPayload: RetainedRepairRecords["parseTransitionPayload"]
  validArchitect: ArchitectOwnership["validArchitect"]
}

/**
 * Retained repair preparation: preparing a retained repair and its recovery, whether a recovery is
 * still current, the dependent-task checks, and review-input reconciliation. Moved out of `TaskRuntime`
 * without rewriting; the private aliases below keep the member bodies identical to what they were.
 */
export class RetainedRepairPreparation {
  private readonly transitionHistory: RetainedRepairPreparationDeps["transitionHistory"]
  private readonly retainedAttemptModel: RetainedRepairPreparationDeps["retainedAttemptModel"]
  private readonly retainedRepairObservation: RetainedRepairPreparationDeps["retainedRepairObservation"]
  private readonly retainedRepairWorkerProblem: RetainedRepairPreparationDeps["retainedRepairWorkerProblem"]
  private readonly retainedRepairBackgroundProblem: RetainedRepairPreparationDeps["retainedRepairBackgroundProblem"]
  private readonly retainedRepairForAttempt: RetainedRepairPreparationDeps["retainedRepairForAttempt"]
  private readonly preparationAllowed: RetainedRepairPreparationDeps["preparationAllowed"]
  private readonly matchesWorkerInput: RetainedRepairPreparationDeps["matchesWorkerInput"]
  private readonly parseTransitionPayload: RetainedRepairPreparationDeps["parseTransitionPayload"]
  private readonly validArchitect: RetainedRepairPreparationDeps["validArchitect"]

  constructor(
    private readonly core: RuntimeCore,
    deps: RetainedRepairPreparationDeps,
  ) {
    this.transitionHistory = (...args) => deps.transitionHistory(...args)
    this.retainedAttemptModel = (...args) => deps.retainedAttemptModel(...args)
    this.retainedRepairObservation = (...args) => deps.retainedRepairObservation(...args)
    this.retainedRepairWorkerProblem = (...args) => deps.retainedRepairWorkerProblem(...args)
    this.retainedRepairBackgroundProblem = (...args) =>
      deps.retainedRepairBackgroundProblem(...args)
    this.retainedRepairForAttempt = (...args) => deps.retainedRepairForAttempt(...args)
    this.preparationAllowed = (...args) => deps.preparationAllowed(...args)
    this.matchesWorkerInput = (...args) => deps.matchesWorkerInput(...args)
    this.parseTransitionPayload = deps.parseTransitionPayload
    this.validArchitect = deps.validArchitect
  }

  private get host() {
    return this.core.host
  }

  private get store() {
    return this.core.store
  }

  private get projectID() {
    return this.core.projectID
  }

  private get directory() {
    return this.core.directory
  }

  async prepareRetainedRepairRecovery(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
    attempt: AttemptRow,
  ): Promise<RetainedRepairRecoverySeed> {
    if (!command.taskID || !command.attemptID || !command.reason)
      throw new Error("Retained repair recovery requires the exact task, attempt and reason")
    if (!this.validArchitect(ownerSession) || ownerSession.projectID !== this.projectID)
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
      !sameProject(task.provenance.projectID, this.projectID) ||
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
    const repairRoute = ModelPolicy.safeParse(repair?.route)
    const policy = (() => {
      try {
        return JSON.parse(attempt.policy) as { workspaceMode?: unknown; model?: unknown }
      } catch {
        return undefined
      }
    })()
    const attemptRoute = this.retainedAttemptModel(plan, attempt)
    const artifact = repair?.artifact
    if (
      !repairTransition ||
      typeof operationID !== "string" ||
      typeof repairMessageID !== "string" ||
      typeof previousMessageID !== "string" ||
      repair?.attemptID !== attempt.id ||
      repairTransition.task_id !== task.id ||
      typeof repair?.sessionID !== "string" ||
      repair.sessionID !== attempt.session_id ||
      repair.workspace !== attempt.workspace ||
      artifact !== attempt.artifact ||
      node.artifact !== null ||
      !isCommitID(artifact) ||
      !attemptRoute ||
      !repairRoute.success ||
      policy?.workspaceMode !== "isolated" ||
      !sameModelSnapshot(attemptRoute, repairRoute.data) ||
      this.store.latestTransition(plan.id, task.id, "TASK_INTEGRATION_RECORDED")
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
      realpathSync(await gitAsync(attempt.workspace, ["rev-parse", "--show-toplevel"])) !==
        realpathSync(attempt.workspace) ||
      (await gitAsync(attempt.workspace, ["rev-parse", `${artifact}^{commit}`])) !== artifact ||
      !(await commitIsAncestor(
        attempt.workspace,
        artifact,
        await gitAsync(attempt.workspace, ["rev-parse", "HEAD"]),
      )) ||
      !isCommitID(attempt.base_commit) ||
      !(await commitIsAncestor(attempt.workspace, attempt.base_commit, artifact)) ||
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
    // Owner first, then one worker read: the freshest observation is the one that is validated.
    const currentOwner = await freshOwner()
    const confirmedWorker = await this.host.session(attempt.session_id, { messages: true })
    const route = attemptRoute
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
      !confirmedWorker ||
      confirmedWorker.messages.some((message) => message.id === attempt.message_id)
    )
      throw new Error(problem ?? "Retained repair recovery worker changed during revalidation")

    const historicalAttempt = { ...attempt, state: "running" as const, message_id: repairMessageID }
    const continuationProblem = checkTerminalWorkerContinuation({
      plan: { state: "blocked", owner: plan.owner, model: JSON.stringify(route), artifact: null },
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
      stopObservation: stopped,
      planHoldObservation: priorHold,
      retainedSession: sessionReceipt,
      retainedPrompt: repairPromptReceipt,
      hasUnresolvedEffects: unresolved,
      reservationAvailable: this.preparationAllowed(attempt),
    } satisfies TerminalWorkerContinuationFacts)
    if (continuationProblem) throw new Error(continuationProblem)
    if (this.store.plan(plan.id)?.version !== plan.version)
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
  retainedRepairRecoveryCurrent(
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
    const currentRepair = currentAttempt ? this.retainedRepairForAttempt(currentAttempt) : undefined
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
      currentPlan.reason === RETAINED_REPAIR_FENCE_FAILURE_REASON &&
      currentAttempt?.state === "cancelled" &&
      currentAttempt.message_id === recovery.failedMessageID &&
      currentAttempt.session_id === attempt.session_id &&
      currentAttempt.workspace === attempt.workspace &&
      currentAttempt.base_commit === attempt.base_commit &&
      currentAttempt.policy === attempt.policy &&
      currentRepair?.operationID === recovery.operationID &&
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
      this.preparationAllowed(attempt),
    )
  }
  assertNoDispatchedDependents(plan: PlanRow, taskID: string, input: PlanInput) {
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
  retainedRepairAttemptAccepted(plan: PlanRow, attempt: AttemptRow, taskRevision: number) {
    if (attempt.state === "accepted") return true
    if (attempt.state !== "failed") return false
    return this.store
      .atomic((db) => retainedVerificationsForPlan(db, this.directory, plan.id))
      .some(
        (operation) =>
          operation.state === "accepted" &&
          operation.projectID === this.projectID &&
          operation.taskID === attempt.task_id &&
          operation.taskRevision === taskRevision &&
          operation.attemptID === attempt.id &&
          operation.artifact === attempt.artifact &&
          operation.originalSessionID === attempt.session_id &&
          operation.originalMessageID === attempt.message_id,
      )
  }
  async prepareRetainedRepair(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ): Promise<RetainedRepairSeed> {
    if (!command.taskID || !command.attemptID || !command.artifact || !command.reason?.trim())
      throw new Error(
        "Retained repair requires taskID, attemptID, exact artifact and concrete defect reason",
      )
    if (!this.validArchitect(ownerSession))
      throw new Error("Retained repair requires the current same-project Architect owner")
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
      !sameProject(task.provenance.projectID, this.projectID) ||
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

    let policy: { workspaceMode?: unknown }
    try {
      policy = JSON.parse(attempt.policy) as typeof policy
    } catch {
      throw new Error("Retained attempt policy is unavailable")
    }
    const attemptModel = this.retainedAttemptModel(plan, attempt)
    if (
      attempt.workspace === this.directory ||
      policy.workspaceMode !== "isolated" ||
      !attemptModel
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
    if (sessionEffect?.state !== "completed" || originalPrompt?.state !== "completed")
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
      realpathSync(await gitAsync(attempt.workspace, ["rev-parse", "--show-toplevel"])) !==
        realpathSync(attempt.workspace)
    )
      throw new Error("Retained repair requires the exact native-owned isolated worktree")
    const workspaceHead = await gitAsync(attempt.workspace, ["rev-parse", "HEAD"])
    if (
      (await gitAsync(attempt.workspace, ["rev-parse", `${command.artifact}^{commit}`])) !==
        command.artifact ||
      workspaceHead !== command.artifact
    )
      throw new Error("Retained repair artifact is missing or not the workspace HEAD")
    const sourceHead = await gitAsync(this.directory, ["rev-parse", "HEAD"])
    if (await commitIsAncestor(this.directory, command.artifact, sourceHead))
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
    // Owner first, then one worker read: the freshest observation is the one that is validated.
    const currentOwner = await this.host.session(plan.owner)
    if (!this.validArchitect(currentOwner) || currentOwner.id !== caller)
      throw new Error("Retained repair owner changed during native observation")
    const observed = await this.host.session(attempt.session_id, { messages: true })
    const nativeInputID = observed?.turn?.inputID ?? undefined
    const backgroundProblem = this.retainedRepairBackgroundProblem(observed, nativeInputID)
    if (!nativeInputID || !this.matchesWorkerInput(attempt, nativeInputID))
      throw new Error("Retained repair requires the exact captured successful native input")
    const problem = this.retainedRepairWorkerProblem(
      plan,
      attempt,
      observed,
      nativeInputID,
      attemptModel,
    )
    if (backgroundProblem || problem || !observed)
      throw new Error(
        backgroundProblem ??
          problem ??
          "Retained worker input or ownership changed during repair admission",
      )
    if (this.store.plan(plan.id)?.version !== plan.version) throw new PlanMovedDuringCommand()
    return {
      taskID: task.id,
      attemptID: attempt.id,
      artifact: command.artifact,
      previousMessageID,
      nativeInputID,
      messageID: messageID(),
      operationID: crypto.randomUUID(),
      owner: caller,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      model: attemptModel,
      workerObservation: this.retainedRepairObservation(observed),
    }
  }
  async prepareReviewInputReconciliation(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ): Promise<{ binding: ReviewInputBinding; evidence: ReviewInputEvidence } | undefined> {
    if (command.reviewInputID === undefined) return undefined
    if (command.action !== "reconcile" || !command.taskID || !command.attemptID)
      throw new Error("Review input reconciliation requires reconcile, taskID and attemptID")
    if (!this.validArchitect(ownerSession))
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
      !sameProject(task.provenance.projectID, this.projectID) ||
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
      expectedPlanVersion: plan.version,
      model,
    }
    // Owner liveness first, then one worker read, so the evidence is the freshest state. The
    // transaction below separately fences durable reassignment/version/attempt races.
    const currentOwner = await this.host.session(plan.owner)
    if (!this.validArchitect(currentOwner) || currentOwner.id !== caller)
      throw new Error("Review input reconciliation owner is no longer current and active")
    const worker = await this.host.session(latest.session_id, { messages: true })
    if (!worker) throw new Error("Exact review-input worker session is unavailable")
    const evidence = observeReviewInput(worker, binding)
    return { binding, evidence }
  }
}

import { isRecord } from "./runtime-helpers.ts"
import type { RetainedRepairRecord } from "./runtime-helpers.ts"
import { sameModelSnapshot, sameNativeModel } from "./model-route.ts"
import { isWorkerAgent } from "./worker-agent.ts"
import { fingerprint } from "../identity.ts"
import type { HostSession } from "./host.ts"
import { ModelPolicy, PlanInput } from "./schema.ts"
import type { PlanRow, AttemptRow } from "./store.ts"
import {
  resolveRetainedRepairInputLineage,
  RETAINED_REPAIR_FENCE_FAILURE_REASON,
} from "./interrupted-continuation.ts"
import type { RetainedRepairContinuationTransition } from "./interrupted-continuation.ts"
import { DispatchRouteDecisionSchema } from "../models/dispatch-resolution.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { Dispatch } from "./dispatch.ts"
import type { WorkerObservation } from "./worker-observation.ts"
import type { RunnerTransitionRecord } from "./runtime-helpers.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** The transition events retained-repair lineage and recovery checks read. */
export const RETAINED_REPAIR_EVENTS = [
  "RETAINED_REPAIR_REQUESTED",
  "ATTEMPT_RESUMED",
  "WORKER_STOPPED",
  "BLOCKED",
  "CANCEL",
  "CANCEL_REQUESTED",
] as const
/** Transitions per read when the history is walked; a page size, not a limit. */
const TRANSITION_PAGE = 500

/** What `RetainedRepairRecords` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type RetainedRepairRecordsDeps = {
  validArchitect: ArchitectOwnership["validArchitect"]
  preparationAllowed: Dispatch["preparationAllowed"]
  backgroundBlockReason: WorkerObservation["backgroundBlockReason"]
}

/**
 * The retained-repair records: the stored repair for an attempt, its generation and prompt check,
 * the transition history it reads, and the model comparison helpers. Moved out of `TaskRuntime`
 * without rewriting; the private aliases below keep the member bodies identical to what they were.
 */
export class RetainedRepairRecords {
  private readonly validArchitect: RetainedRepairRecordsDeps["validArchitect"]
  private readonly preparationAllowed: RetainedRepairRecordsDeps["preparationAllowed"]
  private readonly backgroundBlockReason: RetainedRepairRecordsDeps["backgroundBlockReason"]

  constructor(
    private readonly core: RuntimeCore,
    deps: RetainedRepairRecordsDeps,
  ) {
    this.validArchitect = deps.validArchitect
    this.backgroundBlockReason = (...args) => deps.backgroundBlockReason(...args)
    this.preparationAllowed = (...args) => deps.preparationAllowed(...args)
  }

  private get store() {
    return this.core.store
  }

  private get projectID() {
    return this.core.projectID
  }

  private get host() {
    return this.core.host
  }

  sameModel(left: ModelPolicy | undefined, right: ModelPolicy | undefined) {
    return sameNativeModel(left, right)
  }
  retainedAttemptPlanModelMatches(plan: PlanRow, model: ModelPolicy) {
    try {
      const planModel = plan.model ? ModelPolicy.safeParse(JSON.parse(plan.model)) : undefined
      return Boolean(planModel?.success && sameModelSnapshot(model, planModel.data))
    } catch {
      return false
    }
  }
  retainedAttemptDecisionModel(
    plan: PlanRow,
    model: ModelPolicy,
    routeDecision: unknown,
  ): ModelPolicy | undefined {
    const decision = DispatchRouteDecisionSchema.safeParse(routeDecision)
    if (
      !decision.success ||
      decision.data.status !== "resolved" ||
      !sameModelSnapshot(model, decision.data.route)
    )
      return undefined
    if (
      decision.data.source === "explicit-plan-selection" &&
      !this.retainedAttemptPlanModelMatches(plan, model)
    )
      return undefined
    return model
  }
  retainedAttemptModel(plan: PlanRow, attempt: AttemptRow): ModelPolicy | undefined {
    try {
      const policy = JSON.parse(attempt.policy) as {
        model?: unknown
        routeDecision?: unknown
      }
      const model = ModelPolicy.safeParse(policy.model)
      if (!model.success) return undefined
      if (policy.routeDecision === undefined)
        return this.retainedAttemptPlanModelMatches(plan, model.data) ? model.data : undefined
      return this.retainedAttemptDecisionModel(plan, model.data, policy.routeDecision)
    } catch {
      return undefined
    }
  }
  retainedRepairObservation(worker: HostSession) {
    return JSON.stringify({
      id: worker.id,
      parentID: worker.parentID ?? null,
      projectID: worker.projectID,
      directory: worker.directory,
      agent: worker.agent,
      archived: worker.archived,
      attemptID: worker.metadata?.lazersAttemptID,
      model: worker.model ?? null,
      busy: worker.busy,
      pendingInput: worker.pendingInput,
      pendingPermissions: worker.pendingPermissions,
      pendingForms: worker.pendingForms,
      observationUnstable: worker.observationUnstable ?? false,
      outcome: worker.outcome ?? null,
      turn: worker.turn ?? null,
      runningShells: worker.runningShells ?? 0,
      activeChildren: worker.activeChildren ?? 0,
      idleAt: worker.idleAt ?? null,
      messages: worker.messages.map((message) => ({ id: message.id, type: message.type ?? null })),
    })
  }
  retainedRepairWorkerProblem(
    plan: PlanRow,
    attempt: AttemptRow,
    worker: HostSession | null | undefined,
    expectedInputID: string,
    model: ModelPolicy,
    expectedOutcome: "succeeded" | "interrupted" | "failed" = "succeeded",
  ) {
    if (
      !worker ||
      worker.id !== attempt.session_id ||
      worker.projectID !== this.projectID ||
      worker.directory !== attempt.workspace ||
      !isWorkerAgent(worker.agent) ||
      worker.archived ||
      worker.metadata?.lazersAttemptID !== attempt.id ||
      !this.sameModel(worker.model, model)
    )
      return "Retained repair worker identity, location, or route changed"
    if (
      worker.busy !== false ||
      worker.pendingInput !== false ||
      worker.observationUnstable ||
      worker.pendingPermissions !== 0 ||
      worker.pendingForms !== 0
    )
      return "Retained repair worker has active foreground or pending executable controls"
    const expectedTurnState = expectedOutcome === "interrupted" ? "interrupted" : "completed"
    if (
      worker.outcome !== expectedOutcome ||
      worker.turn?.state !== expectedTurnState ||
      worker.turn.inputID !== expectedInputID
    )
      return expectedOutcome === "interrupted"
        ? "Retained repair worker's exact interrupted input is no longer its current turn"
        : "Retained repair worker's accepted input is no longer its completed current turn"
    return undefined
  }
  retainedRepairBackgroundProblem(
    worker: HostSession | null | undefined,
    inputID: string | undefined,
  ) {
    if (!worker) return "Retained repair worker session is unavailable"
    const reason = this.backgroundBlockReason(worker)
    if (reason) return `${reason}; it must finish before the retained repair can continue`
    if (!inputID || worker.turn?.inputID !== inputID)
      return "Retained repair worker's current turn is not the repaired input"
    return undefined
  }
  /**
   * The transitions retained repair reads for one task of a plan: the repair, resume, stop, hold,
   * cancel and cancel-request events of that task or of the plan as a whole, in id order. Read a
   * page at a time; no other event of the plan's history is loaded.
   */
  transitionHistory(planID: string, taskID: string): RunnerTransitionRecord[] {
    const events = RETAINED_REPAIR_EVENTS.map(() => "?").join(",")
    const found: RunnerTransitionRecord[] = []
    let after = 0
    for (;;) {
      const page = this.store.read((db) =>
        db
          .query<RunnerTransitionRecord, (string | number)[]>(
            `SELECT id,task_id,event,payload FROM runner_transitions
             WHERE plan_id=? AND (task_id=? OR task_id IS NULL) AND event IN (${events}) AND id>?
             ORDER BY id LIMIT ${TRANSITION_PAGE}`,
          )
          .all(planID, taskID, ...RETAINED_REPAIR_EVENTS, after),
      )
      found.push(...page)
      if (page.length < TRANSITION_PAGE) return found
      after = page.at(-1)!.id
    }
  }
  parseTransitionPayload<T>(transition: RunnerTransitionRecord | undefined): T | undefined {
    if (!transition) return undefined
    try {
      return JSON.parse(transition.payload) as T
    } catch {
      return undefined
    }
  }
  retainedRepairForAttempt(attempt: AttemptRow): RetainedRepairRecord | undefined {
    const repair = this.store.latestRetainedRepair<{
      operationID?: unknown
      attemptID?: unknown
      previousMessageID?: unknown
      nativeInputID?: unknown
      nativeAssignmentID?: unknown
      messageID?: unknown
      owner?: unknown
      sessionID?: unknown
      workspace?: unknown
      route?: unknown
      defect?: unknown
      workerObservation?: unknown
    }>(attempt.plan_id, attempt.task_id)
    if (
      !repair ||
      typeof repair.operationID !== "string" ||
      !repair.operationID ||
      typeof repair.attemptID !== "string" ||
      typeof repair.previousMessageID !== "string" ||
      !repair.previousMessageID ||
      typeof repair.messageID !== "string" ||
      !repair.messageID ||
      typeof repair.owner !== "string" ||
      !repair.owner.trim() ||
      typeof repair.sessionID !== "string" ||
      typeof repair.workspace !== "string" ||
      typeof repair.defect !== "string" ||
      repair.attemptID !== attempt.id ||
      repair.sessionID !== attempt.session_id ||
      repair.workspace !== attempt.workspace ||
      repair.route === undefined
    )
      return undefined
    const plan = this.store.plan(attempt.plan_id)
    if (!plan || plan.owner !== repair.owner) return undefined
    const repairRoute = ModelPolicy.safeParse(repair.route)
    const attemptRoute = this.retainedAttemptModel(plan, attempt)
    if (!repairRoute.success || !attemptRoute || !sameModelSnapshot(repairRoute.data, attemptRoute))
      return undefined
    const admissionInputID =
      typeof repair.nativeInputID === "string" ? repair.nativeInputID : repair.previousMessageID
    const admissionAssignmentID =
      typeof repair.nativeAssignmentID === "string"
        ? repair.nativeAssignmentID
        : repair.previousMessageID
    if (typeof repair.nativeInputID === "string") {
      if (typeof repair.workerObservation !== "string") return undefined
      let captured: unknown
      try {
        captured = JSON.parse(repair.workerObservation) as unknown
      } catch {
        return undefined
      }
      if (!isRecord(captured)) return undefined
      const turn = isRecord(captured.turn) ? captured.turn : undefined
      if (
        captured.id !== attempt.session_id ||
        captured.projectID !== this.projectID ||
        captured.directory !== attempt.workspace ||
        captured.attemptID !== attempt.id ||
        captured.busy !== false ||
        captured.pendingInput !== false ||
        captured.observationUnstable !== false ||
        captured.pendingPermissions !== 0 ||
        captured.pendingForms !== 0 ||
        captured.archived !== false ||
        captured.outcome !== "succeeded" ||
        turn?.inputID !== admissionInputID ||
        turn?.state !== "completed" ||
        Number(captured.runningShells ?? 0) !== 0 ||
        Number(captured.activeChildren ?? 0) !== 0
      )
        return undefined
    }
    const history = this.transitionHistory(attempt.plan_id, attempt.task_id)
    const repairTransition = history
      .filter(
        (entry) => entry.task_id === attempt.task_id && entry.event === "RETAINED_REPAIR_REQUESTED",
      )
      .at(-1)
    const transitions: RetainedRepairContinuationTransition[] = history
      .filter((entry) => entry.task_id === attempt.task_id && entry.event === "ATTEMPT_RESUMED")
      .flatMap((entry) => {
        const receipt = this.parseTransitionPayload<RetainedRepairContinuationTransition>(entry)
        if (!receipt) return []
        const recovery = isRecord(receipt.retainedRepairRecovery)
          ? receipt.retainedRepairRecovery
          : undefined
        if (recovery) {
          const failedResumeID = recovery.failedResumeTransitionID
          const blockedID = recovery.blockedTransitionID
          const cancelledID = recovery.cancelledTransitionID
          const failedResumeTransition = history.find(
            (candidate) => candidate.id === failedResumeID,
          )
          const blockedTransition = history.find((candidate) => candidate.id === blockedID)
          const cancelledTransition = history.find((candidate) => candidate.id === cancelledID)
          const failedResume =
            this.parseTransitionPayload<Record<string, unknown>>(failedResumeTransition)
          const blocked = this.parseTransitionPayload<{
            reason?: unknown
            workerObservation?: unknown
          }>(blockedTransition)
          const cancelled = this.parseTransitionPayload<{
            from?: unknown
            to?: unknown
            reason?: unknown
          }>(cancelledTransition)
          if (
            recovery.schema !== "lazers-retained-repair-recovery/v1" ||
            recovery.operationID !== repair.operationID ||
            recovery.interruptedInputID !== repair.messageID ||
            !repairTransition ||
            !Number.isSafeInteger(failedResumeID) ||
            !Number.isSafeInteger(blockedID) ||
            !Number.isSafeInteger(cancelledID) ||
            failedResumeTransition?.event !== "ATTEMPT_RESUMED" ||
            failedResumeTransition.task_id !== attempt.task_id ||
            blockedTransition?.event !== "BLOCKED" ||
            blockedTransition.task_id !== null ||
            cancelledTransition?.event !== "CANCEL" ||
            cancelledTransition.task_id !== attempt.task_id ||
            failedResumeTransition.id <= repairTransition.id ||
            blockedTransition.id <= failedResumeTransition.id ||
            cancelledTransition.id <= blockedTransition.id ||
            failedResume?.attemptID !== attempt.id ||
            failedResume.previousMessageID !== repair.messageID ||
            failedResume.messageID !== recovery.failedMessageID ||
            failedResume.terminalInputID !== repair.messageID ||
            failedResume.interruptedInputID !== repair.messageID ||
            failedResume.terminalOutcome !== "interrupted" ||
            failedResume.retainedRepairContinuation !== undefined ||
            failedResume.retainedRepairRecovery !== undefined ||
            blocked?.reason !== RETAINED_REPAIR_FENCE_FAILURE_REASON ||
            blocked.workerObservation !== undefined ||
            cancelled?.from !== "running" ||
            cancelled.to !== "cancelled" ||
            cancelled.reason !== null ||
            history.some(
              (candidate) =>
                candidate.task_id === null &&
                candidate.event === "CANCEL_REQUESTED" &&
                repairTransition &&
                candidate.id > repairTransition.id &&
                candidate.id < cancelledTransition.id,
            )
          )
            return []
        }
        return [receipt]
      })
    const lineage = resolveRetainedRepairInputLineage({
      operationID: repair.operationID,
      attemptID: attempt.id,
      originalMessageID: repair.messageID,
      assignedMessageID: attempt.message_id,
      owner: repair.owner,
      allowLegacyReceipt: true,
      transitions,
    })
    if (lineage.status === "invalid") return undefined
    const currentContinuation =
      lineage.status === "continued"
        ? transitions.findLast((candidate) => candidate.messageID === attempt.message_id)
        : undefined
    const nativeAssignmentID =
      lineage.status === "continued"
        ? currentContinuation?.previousMessageID
        : admissionAssignmentID
    if (typeof nativeAssignmentID !== "string" || !nativeAssignmentID) return undefined
    return {
      operationID: repair.operationID,
      attemptID: repair.attemptID,
      previousMessageID: repair.previousMessageID,
      repairMessageID: repair.messageID,
      messageID: attempt.message_id,
      nativeInputID: lineage.status === "continued" ? lineage.nativeInputID : admissionInputID,
      nativeAssignmentID,
      admissionInputID,
      admissionAssignmentID,
      continued: lineage.status === "continued",
      ...(lineage.status === "continued" ? { terminalOutcome: lineage.terminalOutcome } : {}),
      owner: repair.owner,
      sessionID: repair.sessionID,
      workspace: repair.workspace,
      route: repair.route,
      defect: repair.defect,
    }
  }
  retainedRepairGeneration(planID: string, taskID?: string) {
    const repairForTask = (candidateTaskID: string) => {
      const repair = this.store.latestRetainedRepair<{
        operationID?: unknown
      }>(planID, candidateTaskID)
      // Once a repair supersedes acceptance evidence, keep that invalidation
      // across later attempts; only a newer repair creates a new generation.
      return typeof repair?.operationID === "string" ? repair.operationID : undefined
    }
    if (taskID !== undefined) return repairForTask(taskID)

    const plan = this.store.plan(planID)
    if (!plan) return undefined
    const input = PlanInput.parse(JSON.parse(plan.body))
    const nodes = this.store.nodes(planID)
    const generations = input.integrationOrder.flatMap((candidateTaskID) => {
      const node = nodes.find((candidate) => candidate.task_id === candidateTaskID)
      if (!node || !["accepted", "incorporated"].includes(node.state)) return []
      const attempt = this.store
        .attempts(planID)
        .filter((candidate) => candidate.task_id === candidateTaskID)
        .at(-1)
      if (!attempt || attempt.state !== "accepted" || attempt.artifact !== node.artifact) return []
      const operationID = repairForTask(candidateTaskID)
      return operationID ? [[candidateTaskID, operationID]] : []
    })
    return generations.length ? fingerprint({ planID, generations }) : undefined
  }
  async retainedRepairPromptCurrent(
    plan: PlanRow,
    attempt: AttemptRow,
    repair: RetainedRepairRecord,
  ) {
    const current = () => {
      const latestPlan = this.store.plan(plan.id)
      const latestAttempt = this.store.attempts(plan.id).find((item) => item.id === attempt.id)
      const latestNode = this.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)
      const latestRepair = this.retainedRepairForAttempt(attempt)
      return Boolean(
        latestPlan?.state === "running" &&
        latestAttempt?.state === "preparing" &&
        latestAttempt.message_id === attempt.message_id &&
        latestAttempt.session_id === attempt.session_id &&
        latestAttempt.workspace === attempt.workspace &&
        latestNode?.state === (repair.continued ? "running" : "ready") &&
        latestRepair?.operationID === repair.operationID &&
        latestRepair?.messageID === repair.messageID &&
        latestRepair?.nativeInputID === repair.nativeInputID &&
        latestRepair?.continued === repair.continued,
      )
    }
    if (!this.host.waitForSession || !current()) return false
    const model = ModelPolicy.safeParse(repair.route)
    if (!model.success) return false
    await this.host.waitForSession(attempt.session_id)
    // Owner first, then one worker read: the freshest observation is the one that is validated.
    const owner = await this.host.session(repair.owner)
    if (!this.validArchitect(owner) || owner.id !== repair.owner || !current()) return false
    const observed = await this.host.session(attempt.session_id, { messages: true })
    const expectedInputID = repair.nativeInputID
    const expectedOutcome = repair.continued ? repair.terminalOutcome! : "succeeded"
    const backgroundProblem = this.retainedRepairBackgroundProblem(observed, expectedInputID)
    if (
      backgroundProblem ||
      this.retainedRepairWorkerProblem(
        plan,
        attempt,
        observed,
        expectedInputID,
        model.data,
        expectedOutcome,
      ) ||
      observed?.messages.some((message) => message.id === attempt.message_id) ||
      !observed ||
      !current()
    )
      return false
    return this.preparationAllowed(attempt)
  }
}

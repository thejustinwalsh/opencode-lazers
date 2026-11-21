import type { WorkerObservationFence } from "./runtime-helpers.ts"
import { isWorkerAgent } from "./worker-agent.ts"
import type { HostSession } from "./host.ts"
import { ModelPolicy } from "./schema.ts"
import type { PlanRow, AttemptRow } from "./store.ts"
import { matchesReviewInputAlias, parseReviewInputAlias } from "./review-input.ts"

import type { RuntimeCore } from "./runtime-core.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"

/** What worker observation reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type WorkerObservationDeps = {
  sameModel: (left: ModelPolicy | undefined, right: ModelPolicy | undefined) => boolean
  journal: { hold: RuntimeJournal["hold"] }
}

/**
 * What the runner knows about a worker's session between ticks: start and stop events, input
 * matching, approval and background waits, and the fence that proves an observation is still
 * current. Moved out of `TaskRuntime` without rewriting; the private aliases below keep the
 * member bodies identical to what they were.
 */
export class WorkerObservation {
  private readonly sameModel: WorkerObservationDeps["sameModel"]
  private readonly hold: RuntimeJournal["hold"]

  constructor(
    private readonly core: RuntimeCore,
    deps: WorkerObservationDeps,
  ) {
    this.sameModel = (...args) => deps.sameModel(...args)
    this.hold = (...args) => deps.journal.hold(...args)
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

  private get progress() {
    return this.core.progress
  }

  workerEvent(
    plan: PlanRow,
    attempt: AttemptRow,
    event: "WORKER_STARTED" | "WORKER_STOPPED",
    fence: number,
    outcome?: HostSession["outcome"] | "cancelled",
    inputID?: string | null,
  ) {
    const previous = this.store.latestTransition<{
      attemptID?: string
      outcome?: HostSession["outcome"] | "cancelled"
      inputID?: string
    }>(plan.id, attempt.task_id, event)
    if (
      previous?.attemptID === attempt.id &&
      (event === "WORKER_STARTED" || (previous.outcome === outcome && previous.inputID === inputID))
    )
      return
    this.store.fenced(this.owner, fence, () =>
      this.store.record(plan.id, attempt.task_id, event, {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        observedAt: Date.now(),
        ...(outcome ? { outcome } : {}),
        ...(inputID ? { inputID } : {}),
      }),
    )
  }

  matchesWorkerInput(attempt: AttemptRow, inputID: string | null | undefined): boolean {
    if (
      this.progress.matchesAssignedInput(
        attempt.id,
        attempt.session_id,
        attempt.message_id,
        inputID,
      )
    )
      return true
    if (!inputID) return false

    const plan = this.store.plan(attempt.plan_id)
    const latest = this.store
      .attempts(attempt.plan_id)
      .filter((candidate) => candidate.task_id === attempt.task_id)
      .at(-1)
    if (
      !plan ||
      !latest ||
      latest.id !== attempt.id ||
      latest.session_id !== attempt.session_id ||
      latest.workspace !== attempt.workspace ||
      latest.message_id !== attempt.message_id
    )
      return false

    // Newest alias first, one row at a time: the walk stops at the first match.
    return this.store.atomic((db) => {
      const aliases = db
        .query<{ id: number; payload: string }, [string, string]>(
          `SELECT id,payload FROM runner_transitions
           WHERE plan_id=? AND task_id=? AND event='WORKER_REVIEW_INPUT_RECONCILED'
           ORDER BY id DESC`,
        )
        .iterate(attempt.plan_id, attempt.task_id)
      for (const row of aliases) {
        let alias: ReturnType<typeof parseReviewInputAlias>
        try {
          alias = parseReviewInputAlias(JSON.parse(row.payload))
        } catch {
          alias = undefined
        }
        if (
          alias &&
          matchesReviewInputAlias(alias, {
            projectDirectory: this.directory,
            projectID: this.projectID,
            planID: attempt.plan_id,
            taskID: attempt.task_id,
            attemptID: attempt.id,
            sessionID: attempt.session_id,
            workspace: attempt.workspace,
            assignedMessageID: attempt.message_id,
            reviewInputID: inputID,
          })
        )
          return true
      }
      return false
    })
  }

  isPriorContinuationInput(attempt: AttemptRow, inputID: string | null | undefined) {
    if (!inputID) return false
    return this.store.hasActivity(attempt.plan_id, attempt.task_id, {
      events: ["ATTEMPT_RESUMED"],
      payload: { attemptID: attempt.id },
      payloadAny: {
        previousMessageID: inputID,
        interruptedInputID: inputID,
        terminalInputID: inputID,
      },
    })
  }

  /**
   * Live idle check: a worker with a running shell in its worktree or an
   * active child session is not idle. The counts are read from the host at
   * observation time; there is no report to wait for.
   */
  backgroundBlockReason(session: HostSession): string | undefined {
    const shells = session.runningShells ?? 0
    const children = session.activeChildren ?? 0
    if (shells === 0 && children === 0) return undefined
    return `Worker has ${shells} running shell(s) and ${children} active child session(s)`
  }

  approvalWait(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    fence: number,
    observation?: WorkerObservationFence,
  ) {
    const pendingPermissions = session.pendingPermissions ?? 0
    const pendingForms = session.pendingForms ?? 0
    return this.store.fenced(this.owner, fence, () => {
      if (observation && !this.workerObservationCurrent(observation)) return false
      const previous = this.store.latestTransition<{
        attemptID?: string
        pendingPermissions?: number
        pendingForms?: number
      }>(plan.id, attempt.task_id, "WORKER_APPROVAL_WAIT")
      if (
        previous?.attemptID === attempt.id &&
        previous.pendingPermissions === pendingPermissions &&
        previous.pendingForms === pendingForms
      )
        return false
      this.store.record(plan.id, attempt.task_id, "WORKER_APPROVAL_WAIT", {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        directory: session.directory,
        pendingPermissions,
        pendingForms,
        observedAt: Date.now(),
      })
      return true
    })
  }

  holdApprovalObservation(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    observation: WorkerObservationFence,
    fence: number,
  ) {
    return this.store.fenced(this.owner, fence, () => {
      if (!this.workerObservationCurrent(observation)) return false
      this.approvalWait(plan, attempt, session, fence, observation)
      this.hold(
        plan,
        `Worker at ${session.directory} has ${session.pendingPermissions ?? 0} pending permission request(s) and ${session.pendingForms ?? 0} pending form(s)`,
        ["audit", "reconcile", "cancel"],
        undefined,
        observation,
      )
      return true
    })
  }

  private reconcileRequestID(planID: string) {
    return this.store.read(
      (db) =>
        db
          .query<{ id: number }, [string]>(
            `SELECT COALESCE(MAX(id),0) AS id FROM runner_transitions
             WHERE plan_id=? AND task_id IS NULL AND event='RECONCILE_REQUESTED'`,
          )
          .get(planID)!.id,
    )
  }

  workerObservationFence(plan: PlanRow, attempt: AttemptRow): WorkerObservationFence | undefined {
    const currentPlan = this.store.plan(plan.id)
    const currentAttempt = this.store
      .attempts(plan.id)
      .filter((candidate) => candidate.task_id === attempt.task_id)
      .at(-1)
    const node = this.store
      .nodes(plan.id)
      .find((candidate) => candidate.task_id === attempt.task_id)
    if (
      !currentPlan ||
      currentPlan.version !== plan.version ||
      currentPlan.state !== plan.state ||
      !currentAttempt ||
      currentAttempt.id !== attempt.id ||
      currentAttempt.state !== attempt.state ||
      currentAttempt.session_id !== attempt.session_id ||
      currentAttempt.workspace !== attempt.workspace ||
      currentAttempt.message_id !== attempt.message_id ||
      currentAttempt.policy !== attempt.policy ||
      !node
    )
      return undefined
    return {
      planID: plan.id,
      planVersion: plan.version,
      planState: plan.state,
      owner: plan.owner,
      reconcileRequestID: this.reconcileRequestID(plan.id),
      taskID: attempt.task_id,
      attemptID: attempt.id,
      attemptState: attempt.state,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      messageID: attempt.message_id,
      policy: attempt.policy,
      nodeState: node.state,
      nodeVersion: node.version,
    }
  }

  workerObservationCurrent(observation: WorkerObservationFence) {
    const plan = this.store.plan(observation.planID)
    const attempt = this.store
      .attempts(observation.planID)
      .filter((candidate) => candidate.task_id === observation.taskID)
      .at(-1)
    const node = this.store
      .nodes(observation.planID)
      .find((candidate) => candidate.task_id === observation.taskID)
    return Boolean(
      plan &&
      plan.version === observation.planVersion &&
      plan.state === observation.planState &&
      this.reconcileRequestID(observation.planID) === observation.reconcileRequestID &&
      attempt?.id === observation.attemptID &&
      attempt.state === observation.attemptState &&
      attempt.session_id === observation.sessionID &&
      attempt.workspace === observation.workspace &&
      attempt.message_id === observation.messageID &&
      attempt.policy === observation.policy &&
      node?.state === observation.nodeState &&
      node.version === observation.nodeVersion,
    )
  }

  approvalWaitReason(reason: string | null | undefined) {
    return Boolean(
      reason?.startsWith("Worker at ") &&
      reason.includes("pending permission request(s)") &&
      reason.includes("pending form(s)"),
    )
  }

  private conclusiveApprovalClear(attempt: AttemptRow, session: HostSession) {
    if (
      session.id !== attempt.session_id ||
      session.projectID !== this.projectID ||
      session.directory !== attempt.workspace ||
      !isWorkerAgent(session.agent) ||
      session.archived ||
      session.metadata?.lazersAttemptID !== attempt.id ||
      session.pendingInput !== false ||
      session.pendingPermissions !== 0 ||
      session.pendingForms !== 0 ||
      session.observationUnstable ||
      !session.turn ||
      !this.matchesWorkerInput(attempt, session.turn.inputID)
    )
      return false
    try {
      const policy = ModelPolicy.safeParse(JSON.parse(attempt.policy).model)
      return policy.success && this.sameModel(session.model, policy.data)
    } catch {
      return false
    }
  }

  resumeTransientObservationWait(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    observation: WorkerObservationFence,
    fence: number,
    allowNonterminal = false,
  ) {
    const current = this.store.plan(plan.id)
    const reason = current?.reason
    const observationReason = reason?.replace(/^Worker execution (?:failed|completed); /, "")
    // Legacy holds named the retired experimental.idle report; they clear the same way.
    const backgroundWait =
      observationReason?.startsWith("Native idle background observation") ||
      /^Worker has \d+ known background job\(s\)/.test(observationReason ?? "") ||
      /^Worker has \d+ running shell\(s\) and \d+ active child session\(s\)/.test(
        observationReason ?? "",
      )
    const approvalWait = this.approvalWaitReason(reason)
    if (current?.state !== "blocked" || !reason || (!backgroundWait && !approvalWait)) return
    if (approvalWait && !this.conclusiveApprovalClear(attempt, session)) return false
    if (
      allowNonterminal
        ? !approvalWait || session.outcome !== undefined
        : session.busy || session.pendingInput || session.observationUnstable || !session.outcome
    )
      return false
    return this.store.fenced(this.owner, fence, (db) => {
      if (!this.workerObservationCurrent(observation)) return false
      const current = db
        .query<{ state: string; reason: string | null; version: number; owner: string }, [string]>(
          "SELECT state,reason,version,owner FROM runner_plans WHERE id=?",
        )
        .get(plan.id)
      if (
        current?.state !== "blocked" ||
        current.reason !== reason ||
        current.version !== observation.planVersion
      )
        return false
      const changed =
        db
          .query(
            "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason=? AND version=? AND owner=?",
          )
          .run(plan.id, reason, observation.planVersion, observation.owner).changes === 1
      if (changed)
        this.store.record(plan.id, null, "WORKER_OBSERVATION_SETTLED", {
          previousReason: reason,
          observation: approvalWait ? "worker-approvals" : "live-idle-check",
        })
      return changed
    })
  }

  backgroundWait(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    reason: string,
    fence: number,
  ) {
    const background = {
      runningShells: session.runningShells ?? 0,
      activeChildren: session.activeChildren ?? 0,
    }
    const previous = this.store.latestTransition<{
      attemptID?: string
      background?: typeof background
    }>(plan.id, attempt.task_id, "WORKER_BACKGROUND_WAIT")
    if (
      previous?.attemptID === attempt.id &&
      JSON.stringify(previous.background) === JSON.stringify(background)
    )
      return
    this.store.fenced(this.owner, fence, () =>
      this.store.record(plan.id, attempt.task_id, "WORKER_BACKGROUND_WAIT", {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        reason,
        background,
      }),
    )
  }
}

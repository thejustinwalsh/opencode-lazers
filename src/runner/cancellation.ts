import { terminalPlanStates as terminal } from "./plan-control.ts"
import type { HostSession } from "./host.ts"
import type { PlanRow, AttemptRow } from "./store.ts"
import type { RuntimeCore } from "./runtime-core.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"
import type { WorkerObservation } from "./worker-observation.ts"
import type { Dispatch } from "./dispatch.ts"

/** What cancellation reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type CancellationDeps = {
  cancelIdleWaitMs: number
  observeUsage: Dispatch["observeUsage"]
  journal: {
    outcome: RuntimeJournal["outcome"]
    supersedeEffect: RuntimeJournal["supersedeEffect"]
  }
  workerObservation: {
    workerEvent: WorkerObservation["workerEvent"]
    matchesWorkerInput: WorkerObservation["matchesWorkerInput"]
    backgroundBlockReason: WorkerObservation["backgroundBlockReason"]
    approvalWait: WorkerObservation["approvalWait"]
    backgroundWait: WorkerObservation["backgroundWait"]
  }
}

/**
 * Cancelling a plan's workers: stopping or interrupting each attempt, waiting for the worker to
 * go idle, and settling the cancelled attempt and plan. Moved out of `TaskRuntime` without
 * rewriting; the private aliases below keep the member bodies identical to what they were.
 */
export class Cancellation {
  private readonly cancelIdleWaitMs: number
  private readonly observeUsage: Dispatch["observeUsage"]
  private readonly outcome: RuntimeJournal["outcome"]
  private readonly supersedeEffect: RuntimeJournal["supersedeEffect"]
  private readonly workerEvent: WorkerObservation["workerEvent"]
  private readonly matchesWorkerInput: WorkerObservation["matchesWorkerInput"]
  private readonly backgroundBlockReason: WorkerObservation["backgroundBlockReason"]
  private readonly approvalWait: WorkerObservation["approvalWait"]
  private readonly backgroundWait: WorkerObservation["backgroundWait"]

  constructor(
    private readonly core: RuntimeCore,
    deps: CancellationDeps,
  ) {
    this.cancelIdleWaitMs = deps.cancelIdleWaitMs
    this.observeUsage = (...args) => deps.observeUsage(...args)
    this.outcome = (...args) => deps.journal.outcome(...args)
    this.supersedeEffect = (...args) => deps.journal.supersedeEffect(...args)
    this.workerEvent = (...args) => deps.workerObservation.workerEvent(...args)
    this.matchesWorkerInput = (...args) => deps.workerObservation.matchesWorkerInput(...args)
    this.backgroundBlockReason = (...args) => deps.workerObservation.backgroundBlockReason(...args)
    this.approvalWait = (...args) => deps.workerObservation.approvalWait(...args)
    this.backgroundWait = (...args) => deps.workerObservation.backgroundWait(...args)
  }

  private get now() {
    return this.core.now
  }

  private get owner() {
    return this.core.owner
  }

  private get host() {
    return this.core.host
  }

  private get store() {
    return this.core.store
  }

  async cancelWorkers(plan: PlanRow, fence: number, allowPlanSettlement = true) {
    const active = this.store.attempts(plan.id).filter(
      (attempt) =>
        ["preparing", "running", "verifying"].includes(attempt.state) ||
        (attempt.state === "unknown" &&
          this.store
            .attempts(plan.id)
            .filter((candidate) => candidate.task_id === attempt.task_id)
            .at(-1)?.id === attempt.id),
    )
    let waiting = false
    for (const attempt of active)
      if (await this.cancelAttemptWorker(plan, attempt, fence)) waiting = true
    if (!allowPlanSettlement || waiting) return
    this.settleCancelledPlan(plan, fence)
  }

  /** Stops one attempt's worker for a cancel. True while the attempt still has to be waited on. */
  private async cancelAttemptWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
  ): Promise<boolean> {
    let session = await this.host.session(attempt.session_id)
    if (!session) return !this.cancelMissingWorker(plan, attempt, fence)
    if (session.archived && !session.busy) {
      // An archived session can never run again: it counts as stopped.
      this.store.fenced(this.owner, fence, () =>
        this.store.recordOnce(plan.id, attempt.task_id, "CANCEL_WORKER_ARCHIVED", {
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace: attempt.workspace,
          retainedWorkPreserved: true,
        }),
      )
      return !this.settleCancelledAttempt(plan, attempt, fence, false)
    }
    const promptCompleted = this.store
      .effects(plan.id)
      .some(
        (effect) =>
          effect.attempt_id === attempt.id &&
          effect.kind === "prompt" &&
          JSON.parse(effect.payload).messageID === attempt.message_id &&
          effect.state === "completed",
      )
    this.observeUsage(attempt, session, fence)
    const backgroundReason = this.backgroundBlockReason(session)
    if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0)
      this.approvalWait(plan, attempt, session, fence)
    if (session.busy) {
      const busySession = session
      return this.cancelBusyWorker(plan, attempt, fence, () => {
        if (backgroundReason)
          this.backgroundWait(plan, attempt, busySession, backgroundReason, fence)
      })
    }
    const blocked = this.cancelBlock(session)
    if (blocked) return !this.cancelWait(plan, attempt, fence, blocked)
    if (backgroundReason) {
      this.backgroundWait(plan, attempt, session, backgroundReason, fence)
      return !this.cancelWait(plan, attempt, fence, { cause: "background-activity", bounded: true })
    }
    session = await this.host.session(attempt.session_id, { messages: true })
    if (!session) return !this.cancelMissingWorker(plan, attempt, fence)
    this.observeUsage(attempt, session, fence)
    if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0)
      this.approvalWait(plan, attempt, session, fence)
    if (session.busy) return this.cancelBusyWorker(plan, attempt, fence)
    const detailedBlocked = this.cancelBlock(session)
    if (detailedBlocked) return !this.cancelWait(plan, attempt, fence, detailedBlocked)
    const detailedBackgroundReason = this.backgroundBlockReason(session)
    if (detailedBackgroundReason) {
      this.backgroundWait(plan, attempt, session, detailedBackgroundReason, fence)
      return !this.cancelWait(plan, attempt, fence, { cause: "background-activity", bounded: true })
    }
    return this.settleStoppedWorker(plan, attempt, fence, session, promptCompleted)
  }

  /** A busy worker is interrupted; true (still waiting) unless the bounded wait already elapsed. */
  private async cancelBusyWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    whileWaiting?: () => void,
  ) {
    if (await this.interruptForCancel(plan, attempt, fence))
      return !this.settleCancelledAttempt(plan, attempt, fence, true)
    whileWaiting?.()
    return true
  }

  /** An idle worker: record its stop when its prompt ran, then settle the attempt as cancelled. */
  private settleStoppedWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    session: HostSession,
    promptCompleted: boolean,
  ) {
    if (
      promptCompleted &&
      (!session.turn ||
        !this.matchesWorkerInput(attempt, session.turn.inputID) ||
        (session.turn.state !== "completed" && session.turn.state !== "interrupted"))
    )
      return !this.cancelWait(plan, attempt, fence, {
        cause: "turn-input-mismatch",
        bounded: true,
        detail: {
          turnInputID: session.turn?.inputID ?? null,
          turnState: session.turn?.state ?? null,
        },
      })
    if (promptCompleted) {
      this.workerEvent(plan, attempt, "WORKER_STARTED", fence)
      this.workerEvent(
        plan,
        attempt,
        "WORKER_STOPPED",
        fence,
        session.outcome ?? "cancelled",
        session.turn?.inputID,
      )
    }
    return !this.settleCancelledAttempt(plan, attempt, fence, false)
  }

  /** Every attempt has settled: supersede stuck effects (after a bounded wait) and cancel the plan. */
  private settleCancelledPlan(plan: PlanRow, fence: number) {
    const stuck = this.store
      .effects(plan.id)
      .filter((effect) => ["intended", "uncertain"].includes(effect.state))
    if (stuck.length > 0) {
      if (
        !this.cancelWaitElapsed(plan, null, "plan", "unresolved-effect", fence, {
          effects: stuck.map((effect) => ({
            id: effect.id,
            kind: effect.kind,
            state: effect.state,
          })),
        })
      )
        return
      for (const effect of stuck)
        this.supersedeEffect(effect, "Plan cancelled: effect never resolved", fence)
    }
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'cancelled'),version=version+1 WHERE id=?",
        )
        .run(plan.id),
    )
    this.outcome(plan.id, { status: "cancelled" }, true)
  }

  /**
   * Interrupt a busy worker during cancellation. True once the bounded wait since
   * the first interrupt has elapsed: the host may keep listing the session active
   * with nothing to interrupt, and the worktree is being discarded anyway.
   */
  private async interruptForCancel(plan: PlanRow, attempt: AttemptRow, fence: number) {
    const prior = this.store.latestTransition<{ attemptID: string; sessionID: string; at: number }>(
      plan.id,
      attempt.task_id,
      "CANCEL_WORKER_INTERRUPTED",
    )
    const first = prior?.attemptID === attempt.id ? prior : undefined
    await this.host.interrupt(attempt.session_id)
    if (!first) {
      this.store.fenced(this.owner, fence, () =>
        this.store.record(plan.id, attempt.task_id, "CANCEL_WORKER_INTERRUPTED", {
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          at: this.now(),
        }),
      )
      return false
    }
    return this.now() - first.at >= this.cancelIdleWaitMs
  }

  /**
   * Whether the attempt's unresolved effects no longer block cancel. Effects left in
   * `intended` or `uncertain` get a bounded wait, then are superseded.
   */
  private resolveCancelEffects(plan: PlanRow, attempt: AttemptRow, fence: number): boolean {
    const stuck = this.store
      .effects(plan.id)
      .filter(
        (effect) =>
          effect.attempt_id === attempt.id && ["intended", "uncertain"].includes(effect.state),
      )
    if (stuck.length === 0) return true
    if (
      !this.cancelWaitElapsed(plan, attempt.task_id, attempt.id, "unresolved-effect", fence, {
        attemptID: attempt.id,
        effects: stuck.map((effect) => ({ id: effect.id, kind: effect.kind, state: effect.state })),
      })
    )
      return false
    for (const effect of stuck)
      this.supersedeEffect(effect, "Plan cancelled: effect never resolved", fence)
    return true
  }

  /** A cancel wait that only the user can end, or one bounded by `cancelIdleWaitMs`. */
  private cancelBlock(
    session: HostSession,
  ): { cause: string; bounded: boolean; detail?: Record<string, unknown> } | undefined {
    if (session.pendingInput) return { cause: "pending-input", bounded: false }
    if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0)
      return {
        cause: "pending-approval",
        bounded: false,
        detail: {
          pendingPermissions: session.pendingPermissions ?? 0,
          pendingForms: session.pendingForms ?? 0,
        },
      }
    if (session.observationUnstable) return { cause: "observation-unstable", bounded: true }
    return undefined
  }

  /**
   * Record why a cancel is waiting (once per cause). A bounded cause settles the
   * attempt after `cancelIdleWaitMs`; true means the attempt settled.
   */
  private cancelWait(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    wait: { cause: string; bounded: boolean; detail?: Record<string, unknown> },
  ): boolean {
    const payload = { attemptID: attempt.id, sessionID: attempt.session_id, ...wait.detail }
    if (!wait.bounded) {
      this.store.fenced(this.owner, fence, () =>
        this.store.recordOnce(plan.id, attempt.task_id, "CANCEL_WAIT", {
          scope: attempt.id,
          cause: wait.cause,
          ...payload,
        }),
      )
      return false
    }
    if (!this.cancelWaitElapsed(plan, attempt.task_id, attempt.id, wait.cause, fence, payload))
      return false
    return this.settleCancelledAttempt(plan, attempt, fence, true)
  }

  /** Records the cancel-wait cause once and reports whether the bounded wait since its start elapsed. */
  private cancelWaitElapsed(
    plan: PlanRow,
    taskID: string | null,
    scope: string,
    cause: string,
    fence: number,
    detail: Record<string, unknown>,
  ): boolean {
    this.store.fenced(this.owner, fence, () => {
      this.store.recordOnce(plan.id, taskID, "CANCEL_WAIT", { scope, cause, ...detail })
      const started = this.store.latestTransition<{ scope: string; at: number }>(
        plan.id,
        taskID,
        "CANCEL_WAIT_STARTED",
      )
      if (started?.scope !== scope)
        this.store.record(plan.id, taskID, "CANCEL_WAIT_STARTED", { scope, at: this.now() })
    })
    const started = this.store.latestTransition<{ scope: string; at: number }>(
      plan.id,
      taskID,
      "CANCEL_WAIT_STARTED",
    )
    return started !== undefined && this.now() - started.at >= this.cancelIdleWaitMs
  }

  /** Cancel the attempt and its node once its effects resolve or are superseded. The worktree is preserved. */
  private settleCancelledAttempt(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    workerNeverIdle: boolean,
  ): boolean {
    if (!this.resolveCancelEffects(plan, attempt, fence)) return false
    if (workerNeverIdle)
      this.store.fenced(this.owner, fence, () =>
        this.store.record(plan.id, attempt.task_id, "WORKER_CANCEL_WITHOUT_IDLE", {
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace: attempt.workspace,
          waitedMs: this.cancelIdleWaitMs,
          retainedWorkPreserved: true,
        }),
      )
    this.cancelReservedAttempt(plan, attempt, fence)
    return true
  }

  private cancelMissingWorker(plan: PlanRow, attempt: AttemptRow, fence: number): boolean {
    if (!this.resolveCancelEffects(plan, attempt, fence)) return false
    return this.store.fenced(this.owner, fence, () => {
      const currentPlan = this.store.plan(plan.id)
      const current = this.store
        .attempts(plan.id)
        .filter((candidate) => candidate.task_id === attempt.task_id)
        .at(-1)
      if (
        !currentPlan ||
        currentPlan.state !== plan.state ||
        current?.id !== attempt.id ||
        current.session_id !== attempt.session_id ||
        !["preparing", "running", "verifying", "unknown"].includes(current.state) ||
        this.store
          .effects(plan.id)
          .some(
            (effect) =>
              effect.attempt_id === attempt.id && ["intended", "uncertain"].includes(effect.state),
          )
      )
        return false
      this.cancelReservedAttempt(plan, current, fence)
      this.store.record(plan.id, attempt.task_id, "WORKER_SESSION_ABSENT", {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        observedAt: this.now(),
        action: "cancel",
        retainedWorkPreserved: true,
      })
      return true
    })
  }

  cancelReservedAttempt(plan: PlanRow, attempt: AttemptRow, fence: number) {
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query(
          "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'cancelled') WHERE id=?",
        )
        .run(attempt.id),
    )
    const node = this.store
      .nodes(plan.id)
      .find((candidate) => candidate.task_id === attempt.task_id)!
    if (!terminal.has(node.state)) this.store.move(plan.id, node.task_id, "CANCEL")
  }
}

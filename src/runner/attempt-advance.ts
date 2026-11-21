import type { WorkerObservationFence } from "./runtime-helpers.ts"
import { isTakeoverAttempt } from "../recovery/detector.ts"
import type { HostSession } from "./host.ts"
import { attemptIs } from "./identity-read.ts"
import type { PlanRow, AttemptRow } from "./store.ts"
import type { TerminalWorkerHold } from "./interrupted-continuation.ts"

import type { RuntimeCore } from "./runtime-core.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"
import type { VerificationReview } from "./verification-review.ts"
import type { WorkerObservation } from "./worker-observation.ts"
import type { Dispatch } from "./dispatch.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { TaskRuntime } from "./runtime.ts"

/** What the attempt advance reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type AttemptAdvanceDeps = {
  autoResumeInterrupted: boolean
  workerNoProgressWindowMs: number
  command: TaskRuntime["command"]
  prepareWorker: (plan: PlanRow, attempt: AttemptRow, fence: number) => Promise<void>
  verify: VerificationReview["verify"]
  failAttempt: VerificationReview["failAttempt"]
  validArchitect: ArchitectOwnership["validArchitect"]
  observeUsage: Dispatch["observeUsage"]
  journal: {
    hold: RuntimeJournal["hold"]
    terminalWorkerObservation: RuntimeJournal["terminalWorkerObservation"]
  }
  workerObservation: {
    workerEvent: WorkerObservation["workerEvent"]
    matchesWorkerInput: WorkerObservation["matchesWorkerInput"]
    isPriorContinuationInput: WorkerObservation["isPriorContinuationInput"]
    backgroundBlockReason: WorkerObservation["backgroundBlockReason"]
    holdApprovalObservation: WorkerObservation["holdApprovalObservation"]
    workerObservationFence: WorkerObservation["workerObservationFence"]
    workerObservationCurrent: WorkerObservation["workerObservationCurrent"]
    approvalWaitReason: WorkerObservation["approvalWaitReason"]
    resumeTransientObservationWait: WorkerObservation["resumeTransientObservationWait"]
    backgroundWait: WorkerObservation["backgroundWait"]
  }
}

/** What the pass over one running attempt carries from step to step. */
type AdvanceContext = {
  plan: PlanRow
  attempt: AttemptRow
  fence: number
  observation: WorkerObservationFence
  session: HostSession
}

/**
 * Advancing a running attempt: stale-attempt probes, missing and stalled workers, the wait and
 * idle holds, the finished turn, and automatic resume. Owns the per-worker progress and probe
 * state. Moved out of `TaskRuntime` without rewriting; the private aliases below keep the
 * member bodies identical to what they were.
 */
export class AttemptAdvance {
  private readonly workerNoProgressWindowMs: number
  private readonly autoResumeInterrupted: boolean
  private readonly command: AttemptAdvanceDeps["command"]
  private readonly prepareWorker: AttemptAdvanceDeps["prepareWorker"]
  private readonly verify: AttemptAdvanceDeps["verify"]
  private readonly failAttempt: AttemptAdvanceDeps["failAttempt"]
  private readonly validArchitect: ArchitectOwnership["validArchitect"]
  private readonly observeUsage: Dispatch["observeUsage"]
  private readonly hold: RuntimeJournal["hold"]
  private readonly terminalWorkerObservation: RuntimeJournal["terminalWorkerObservation"]
  private readonly workerEvent: WorkerObservation["workerEvent"]
  private readonly matchesWorkerInput: WorkerObservation["matchesWorkerInput"]
  private readonly isPriorContinuationInput: WorkerObservation["isPriorContinuationInput"]
  private readonly backgroundBlockReason: WorkerObservation["backgroundBlockReason"]
  private readonly holdApprovalObservation: WorkerObservation["holdApprovalObservation"]
  private readonly workerObservationFence: WorkerObservation["workerObservationFence"]
  private readonly workerObservationCurrent: WorkerObservation["workerObservationCurrent"]
  private readonly approvalWaitReason: WorkerObservation["approvalWaitReason"]
  private readonly resumeTransientObservationWait: WorkerObservation["resumeTransientObservationWait"]
  private readonly backgroundWait: WorkerObservation["backgroundWait"]

  constructor(
    private readonly core: RuntimeCore,
    deps: AttemptAdvanceDeps,
  ) {
    this.workerNoProgressWindowMs = deps.workerNoProgressWindowMs
    this.autoResumeInterrupted = deps.autoResumeInterrupted
    this.command = (...args) => deps.command(...args)
    this.prepareWorker = (...args) => deps.prepareWorker(...args)
    this.verify = (...args) => deps.verify(...args)
    this.failAttempt = (...args) => deps.failAttempt(...args)
    this.validArchitect = (session): session is HostSession => deps.validArchitect(session)
    this.observeUsage = (...args) => deps.observeUsage(...args)
    this.hold = (...args) => deps.journal.hold(...args)
    this.terminalWorkerObservation = (...args) => deps.journal.terminalWorkerObservation(...args)
    this.workerEvent = (...args) => deps.workerObservation.workerEvent(...args)
    this.matchesWorkerInput = (...args) => deps.workerObservation.matchesWorkerInput(...args)
    this.isPriorContinuationInput = (...args) =>
      deps.workerObservation.isPriorContinuationInput(...args)
    this.backgroundBlockReason = (...args) => deps.workerObservation.backgroundBlockReason(...args)
    this.holdApprovalObservation = (...args) =>
      deps.workerObservation.holdApprovalObservation(...args)
    this.workerObservationFence = (...args) =>
      deps.workerObservation.workerObservationFence(...args)
    this.workerObservationCurrent = (...args) =>
      deps.workerObservation.workerObservationCurrent(...args)
    this.approvalWaitReason = (...args) => deps.workerObservation.approvalWaitReason(...args)
    this.resumeTransientObservationWait = (...args) =>
      deps.workerObservation.resumeTransientObservationWait(...args)
    this.backgroundWait = (...args) => deps.workerObservation.backgroundWait(...args)
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

  private get now() {
    return this.core.now
  }

  private static readonly staleAttemptWindowMs = 60_000
  private readonly staleAttemptProbes = new Map<string, { since: number; probed: number }>()
  async settleStaleAttempts(fence: number) {
    const active = this.store.activeProjectAttempts()
    // A probe entry lives while its attempt is active; a settled attempt frees it.
    const liveIDs = new Set(active.map((attempt) => attempt.id))
    for (const id of this.staleAttemptProbes.keys())
      if (!liveIDs.has(id)) this.staleAttemptProbes.delete(id)
    for (const attempt of active) {
      const plan = this.store.planStatus(attempt.plan_id)
      if (!plan) continue
      if (this.store.latestAttemptID(plan.id, attempt.task_id) !== attempt.id) continue
      // The Architect is finishing this task itself. Its attempt has no native session, so absence
      // says nothing about it: only accept, a plan cancellation, or the abandonment hold ends it.
      if (isTakeoverAttempt(attempt.policy)) continue
      if (this.store.hasOpenEffect(plan.id, attempt.id)) continue
      const node = this.store.node(plan.id, attempt.task_id)
      let target: "accepted" | "failed" | "cancelled" | undefined
      let cause: string
      if (node && ["accepted", "incorporated"].includes(node.state)) {
        if (!["running", "verifying"].includes(attempt.state)) continue
        target = "accepted"
        cause = "node-already-accepted"
      } else if (
        ["running", "verifying"].includes(attempt.state) &&
        ["blocked", "cancelled", "failed", "exhausted"].includes(plan.state)
      ) {
        // Give the ordinary worker observation time to settle the attempt first, then probe the
        // host at most once per window so a held plan costs no extra read on every tick.
        const now = this.now()
        const seen = this.staleAttemptProbes.get(attempt.id)
        if (seen === undefined) this.staleAttemptProbes.set(attempt.id, { since: now, probed: now })
        if (seen === undefined || now - seen.probed < AttemptAdvance.staleAttemptWindowMs) continue
        seen.probed = now
        const session = attempt.session_id ? await this.host.session(attempt.session_id) : null
        if (
          session &&
          (!session.archived ||
            session.busy ||
            session.pendingInput ||
            (session.pendingPermissions ?? 0) > 0 ||
            (session.pendingForms ?? 0) > 0 ||
            session.observationUnstable ||
            (session.runningShells ?? 0) > 0 ||
            (session.activeChildren ?? 0) > 0)
        )
          continue
        target = plan.state === "blocked" ? "failed" : "cancelled"
        cause = session ? "session-archived-and-quiet" : "session-absent"
      } else continue
      this.store.fenced(this.owner, fence, (db) => {
        if (this.store.planStatus(plan.id)?.version !== plan.version) return
        const changed = db
          .query(
            `UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,?),artifact=COALESCE(artifact,?)
             WHERE id=? AND state=?`,
          )
          .run(target!, node?.artifact ?? null, attempt.id, attempt.state).changes
        if (changed !== 1) return
        this.staleAttemptProbes.delete(attempt.id)
        this.store.record(plan.id, attempt.task_id, "ATTEMPT_STALE_SETTLED", {
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace: attempt.workspace,
          from: attempt.state,
          to: target,
          planState: plan.state,
          nodeState: node?.state ?? null,
          cause,
        })
      })
    }
  }

  private failMissingWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    observation?: WorkerObservationFence,
  ) {
    this.store.fenced(this.owner, fence, () => {
      if (observation && !this.workerObservationCurrent(observation)) return
      const currentPlan = this.store.plan(plan.id)
      const latest = this.store
        .attempts(plan.id)
        .filter((item) => item.task_id === attempt.task_id)
        .at(-1)
      const node = this.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)
      if (
        !currentPlan ||
        !["running", "blocked"].includes(currentPlan.state) ||
        latest?.id !== attempt.id ||
        latest.message_id !== attempt.message_id ||
        latest.state !== attempt.state ||
        node?.state !== attempt.state ||
        this.store
          .effects(plan.id)
          .some(
            (effect) =>
              effect.attempt_id === attempt.id && ["intended", "uncertain"].includes(effect.state),
          )
      )
        return
      this.failAttempt(currentPlan, latest, "Owned worker session definitively missing")
      this.store.record(plan.id, attempt.task_id, "WORKER_SESSION_ABSENT", {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        observedAt: this.now(),
        action: "fail",
        retainedWorkPreserved: true,
      })
    })
  }

  /**
   * When the worker last showed progress, from durable facts only: the attempt start, the
   * session's last request start or completion, and the attempt's newest progress row (step,
   * tool and message events, including in-place updates). A running shell or child session is
   * not progress by itself: a hung command keeps a shell running forever.
   */
  private lastWorkerProgressAt(attempt: AttemptRow, session: HostSession) {
    const row = this.store.atomic((db) =>
      db
        .query<{ at: number | null }, [string, string]>(
          `SELECT max(at,coalesce(latest_observed_at,at)) AS at FROM runner_progress
            WHERE project_directory=? AND ${attemptIs(db)} ORDER BY seq DESC LIMIT 1`,
        )
        .get(this.core.directory, attempt.id),
    )
    return Math.max(attempt.started_at, session.activityAt ?? 0, row?.at ?? 0)
  }

  /**
   * A busy turn with no progress for the whole window is stuck: interrupt it once so the
   * ordinary interrupted-worker path (auto-resume, hold) takes over. A turn still busy and
   * still without progress one window after that interrupt did not stop: hold the plan.
   */
  private async interruptStalledWorker(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    fence: number,
  ) {
    if (this.workerNoProgressWindowMs <= 0) return
    const now = this.now()
    const progressAt = this.lastWorkerProgressAt(attempt, session)
    if (now - progressAt < this.workerNoProgressWindowMs) return
    const prior = this.store.latestTransition<{
      attemptID?: string
      progressAt?: number
      interruptedAt?: number
    }>(plan.id, attempt.task_id, "WORKER_NO_PROGRESS_INTERRUPT")
    if (prior?.attemptID === attempt.id && prior.progressAt === progressAt) {
      if (
        plan.state === "running" &&
        typeof prior.interruptedAt === "number" &&
        now - prior.interruptedAt >= this.workerNoProgressWindowMs
      )
        this.hold(
          plan,
          `Worker made no progress for ${Math.round((now - progressAt) / 60_000)} minute(s) and did not stop when interrupted`,
        )
      return
    }
    const payload = {
      attemptID: attempt.id,
      sessionID: session.id,
      progressAt,
      interruptedAt: now,
      runningShells: session.runningShells ?? 0,
      activeChildren: session.activeChildren ?? 0,
      windowMs: this.workerNoProgressWindowMs,
    }
    await this.host.interrupt(session.id)
    this.store.fenced(this.owner, fence, () =>
      this.store.record(plan.id, attempt.task_id, "WORKER_NO_PROGRESS_INTERRUPT", payload),
    )
  }

  async advanceAttempt(plan: PlanRow, attempt: AttemptRow, fence: number) {
    if (attempt.state === "preparing") {
      await this.prepareWorker(plan, attempt, fence)
      return
    }
    if (!new Set(["running", "blocked"]).has(plan.state)) return
    const observation = this.workerObservationFence(plan, attempt)
    if (!observation) return
    const session = await this.observeAdvancedSession(plan, attempt, fence, observation)
    if (!session) return
    const ctx: AdvanceContext = { plan, attempt, fence, observation, session }
    if (await this.holdWorkerWaits(ctx)) return
    if (await this.settleIdleWorker(ctx)) return
    await this.finishWorkerTurn(ctx)
  }

  /** The worker's session as the runtime now sees it, or undefined when the pass should stop. */
  private async observeAdvancedSession(
    plan: PlanRow,
    attempt: AttemptRow,
    fence: number,
    observation: WorkerObservationFence,
  ): Promise<HostSession | undefined> {
    let session = await this.host.session(attempt.session_id)
    if (session) this.observeUsage(attempt, session, fence)
    if (!this.workerObservationCurrent(observation)) return undefined
    if (!session) {
      this.failMissingWorker(plan, attempt, fence, observation)
      return undefined
    }
    if (
      plan.state === "blocked" &&
      this.approvalWaitReason(plan.reason) &&
      session.pendingPermissions === 0 &&
      session.pendingForms === 0 &&
      session.pendingInput === false &&
      !session.observationUnstable &&
      session.outcome === undefined
    ) {
      const detailed = await this.host.session(attempt.session_id, { messages: true })
      if (detailed) this.observeUsage(attempt, detailed, fence)
      if (!this.workerObservationCurrent(observation)) return undefined
      if (!detailed) return undefined
      session = detailed
    }
    return session
  }

  /** The turn belongs to an earlier continuation input, not the one this attempt is waiting on. */
  private staleContinuationTurn(attempt: AttemptRow, session: HostSession) {
    return Boolean(
      session.turn &&
      !this.matchesWorkerInput(attempt, session.turn.inputID) &&
      this.isPriorContinuationInput(attempt, session.turn.inputID),
    )
  }

  /** The plan is already held on this exact terminal worker observation. */
  private terminalHoldUnchanged(plan: PlanRow, attempt: AttemptRow, session: HostSession) {
    const previousHold = this.store.latestTransition<{ workerObservation?: TerminalWorkerHold }>(
      plan.id,
      null,
      "BLOCKED",
    )?.workerObservation
    const unchanged =
      (session.outcome === "failed" || session.outcome === "succeeded") &&
      (session.outcome === "succeeded" ||
        (typeof session.idleAt === "number" && Number.isFinite(session.idleAt))) &&
      previousHold?.kind === "terminal-worker-observation" &&
      previousHold.attemptID === attempt.id &&
      previousHold.sessionID === session.id &&
      previousHold.workspace === attempt.workspace &&
      previousHold.outcome === session.outcome &&
      previousHold.idleAt === session.idleAt &&
      (!session.turn ||
        (previousHold.inputID === session.turn.inputID &&
          previousHold.turnState === session.turn.state))
    return { previousHold, unchanged }
  }

  /** Holds the plan while the worker waits on approvals, input or background work. True when held. */
  private async holdWorkerWaits(ctx: AdvanceContext): Promise<boolean> {
    const { plan, attempt, fence, observation, session } = ctx
    if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0) {
      this.holdApprovalObservation(plan, attempt, session, observation, fence)
      return true
    }
    if (
      plan.state === "blocked" &&
      this.approvalWaitReason(plan.reason) &&
      session.outcome === undefined
    ) {
      this.resumeTransientObservationWait(plan, attempt, session, observation, fence, true)
      return true
    }
    if (this.staleContinuationTurn(attempt, session)) return true
    if (session.busy) await this.interruptStalledWorker(plan, attempt, session, fence)
    const backgroundReason = this.backgroundBlockReason(session)
    const { previousHold, unchanged } = this.terminalHoldUnchanged(plan, attempt, session)
    if (
      !session.busy &&
      !session.pendingInput &&
      !session.observationUnstable &&
      backgroundReason &&
      session.outcome !== "interrupted" &&
      ((session.outcome !== "failed" && session.outcome !== "succeeded") ||
        unchanged ||
        session.archived ||
        session.outcome === "succeeded")
    ) {
      this.hold(
        plan,
        backgroundReason,
        ["audit", "reconcile", "cancel"],
        unchanged ? previousHold : undefined,
        observation,
      )
      this.backgroundWait(plan, attempt, session, backgroundReason, fence)
      return true
    }
    return false
  }

  /**
   * An idle worker with an outcome is read again with its messages before the outcome is trusted.
   * True when the pass is settled (held, failed or still unstable); false to go on to the outcome.
   */
  private async settleIdleWorker(ctx: AdvanceContext): Promise<boolean> {
    const { plan, attempt, fence, observation } = ctx
    if (
      !ctx.session.busy &&
      !ctx.session.pendingInput &&
      !ctx.session.observationUnstable &&
      ctx.session.outcome
    ) {
      const detailed = await this.host.session(attempt.session_id, { messages: true })
      if (detailed) this.observeUsage(attempt, detailed, fence)
      if (!this.workerObservationCurrent(observation)) return true
      if (!detailed) {
        this.failMissingWorker(plan, attempt, fence, observation)
        return true
      }
      ctx.session = detailed
      const session = detailed
      if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0) {
        this.holdApprovalObservation(plan, attempt, session, observation, fence)
        return true
      }
      if (session.busy || session.pendingInput || session.observationUnstable) return true
      if (this.staleContinuationTurn(attempt, session)) return true
      const detailedBackgroundReason = this.backgroundBlockReason(session)
      if (session.outcome === "interrupted") {
        await this.holdInterruptedWorker(ctx, detailedBackgroundReason)
        return true
      }
      if (detailedBackgroundReason) {
        this.holdDetailedBackground(ctx, detailedBackgroundReason)
        return true
      }
    }
    const { session } = ctx
    return Boolean(
      session.busy || session.pendingInput || session.observationUnstable || !session.outcome,
    )
  }

  private async holdInterruptedWorker(ctx: AdvanceContext, backgroundReason: string | undefined) {
    const { plan, attempt, fence, observation, session } = ctx
    this.workerEvent(plan, attempt, "WORKER_STOPPED", fence, "interrupted", session.turn?.inputID)
    const reason = backgroundReason
      ? `Worker execution was interrupted; ${backgroundReason}`
      : "Worker execution was interrupted; the runtime could not resume it"
    if (backgroundReason) this.backgroundWait(plan, attempt, session, backgroundReason, fence)
    this.hold(
      plan,
      reason,
      ["audit", "reconcile", "cancel"],
      this.terminalWorkerObservation(attempt, session),
      observation,
    )
    if (!backgroundReason) await this.autoResumeInterruptedWorker(plan.id, attempt.id)
  }

  /** A worker that ended (or is idle) while background work it started is still running. */
  private holdDetailedBackground(ctx: AdvanceContext, backgroundReason: string) {
    const { plan, attempt, fence, observation, session } = ctx
    if (session.outcome === "failed" || session.outcome === "succeeded") {
      this.workerEvent(
        plan,
        attempt,
        "WORKER_STOPPED",
        fence,
        session.outcome,
        session.turn?.inputID,
      )
      this.backgroundWait(plan, attempt, session, backgroundReason, fence)
      this.hold(
        plan,
        `Worker execution ${session.outcome === "failed" ? "failed" : "completed"}; ${backgroundReason}`,
        ["audit", "reconcile", "cancel"],
        this.terminalWorkerObservation(attempt, session),
        observation,
      )
      return
    }
    this.hold(plan, backgroundReason, ["audit", "reconcile", "cancel"], undefined, observation)
    this.backgroundWait(plan, attempt, session, backgroundReason, fence)
  }

  /** The worker is idle with an outcome: fail, hold, or move the attempt on to verification. */
  private async finishWorkerTurn(ctx: AdvanceContext) {
    const { attempt, fence, session } = ctx
    if (this.resumeTransientObservationWait(ctx.plan, attempt, session, ctx.observation, fence)) {
      ctx.plan = this.store.plan(ctx.plan.id)!
      ctx.observation = this.workerObservationFence(ctx.plan, attempt) ?? ctx.observation
    }
    const { plan, observation } = ctx
    if (
      session.outcome === "succeeded" &&
      (!session.turn ||
        !this.matchesWorkerInput(attempt, session.turn.inputID) ||
        session.turn.state !== "completed")
    ) {
      this.settleUnconfirmedSuccess(plan, attempt, session, observation)
      return
    }
    this.workerEvent(plan, attempt, "WORKER_STOPPED", fence, session.outcome, session.turn?.inputID)
    if (session.outcome !== "succeeded") {
      if (session.outcome === "interrupted") {
        this.hold(
          plan,
          "Worker execution was interrupted; the runtime could not resume it",
          ["audit", "reconcile", "resume", "cancel"],
          this.terminalWorkerObservation(attempt, session),
          observation,
        )
        await this.autoResumeInterruptedWorker(plan.id, attempt.id)
        return
      }
      this.failAttempt(
        plan,
        attempt,
        `Worker ${session.outcome}`,
        session.outcome === "failed" ? this.terminalWorkerObservation(attempt, session) : undefined,
      )
      return
    }
    const task = this.store.repository.get(attempt.task_id)!
    if (attempt.state === "running") {
      this.store.move(plan.id, task.id, "VERIFY")
      this.store.atomic((db) =>
        db
          .query(
            "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'verifying') WHERE id=?",
          )
          .run(attempt.id),
      )
    }
    await this.verify(plan, attempt, task.proposal, fence)
  }

  /** The worker reported success without a completed response to the assigned input. */
  private settleUnconfirmedSuccess(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    observation: WorkerObservationFence,
  ) {
    if (
      session.turn &&
      this.matchesWorkerInput(attempt, session.turn.inputID) &&
      session.turn.state === "pending"
    )
      return
    // A completed turn for a different input is a follow-up the Architect can bind
    // (reconcile); say so and advertise it.
    if (session.turn && !this.matchesWorkerInput(attempt, session.turn.inputID)) {
      this.hold(
        plan,
        "Native worker success does not match a completed response to the current assigned input",
        ["audit", "reconcile", "retry", "cancel"],
        undefined,
        observation,
      )
      return
    }
    // The worker went idle without a completed response to its assigned input:
    // an observable failure of the attempt, retried through the normal path.
    this.failAttempt(
      plan,
      attempt,
      "Worker went idle without a completed response to the assigned input",
    )
  }

  /**
   * An interrupted worker resumes from its live state; nobody has to command it.
   * Bounded per attempt so a worker that keeps being interrupted surfaces in the hold.
   */
  private async autoResumeInterruptedWorker(planID: string, attemptID: string) {
    if (!this.autoResumeInterrupted) return
    const plan = this.store.plan(planID)
    const attempt = this.store.attempts(planID).find((candidate) => candidate.id === attemptID)
    if (!plan || plan.state !== "blocked" || !attempt) return
    const prior = this.store.activityCount(planID, attempt.task_id, {
      events: ["WORKER_AUTO_RESUMED"],
      payload: { attemptID: attempt.id },
    })
    if (prior >= 3 || !this.validArchitect(await this.host.session(plan.owner))) return
    this.store.record(planID, attempt.task_id, "WORKER_AUTO_RESUMED", {
      attemptID: attempt.id,
      messageID: attempt.message_id,
    })
    try {
      await this.command(
        {
          requestID: `auto-resume:${attempt.id}:${attempt.message_id}`,
          planID,
          action: "resume",
          taskID: attempt.task_id,
          attemptID: attempt.id,
          reason: "The worker was interrupted; the runtime resumes it from its live state",
        },
        plan.owner,
      )
    } catch {
      // The hold stays and advertises resume; the next observation tries again within the bound.
    }
  }
}

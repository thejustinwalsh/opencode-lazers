import { fingerprint } from "../identity.ts"
import { holdActions } from "./hold-actions.ts"
import type { AdoptionExecution } from "./adoption-execution.ts"
import type { OutcomeOwnership } from "./inbox.ts"
import type { TerminalWorkerHold } from "./interrupted-continuation.ts"
import type { HostSession } from "./host.ts"
import { terminalPlanStates as terminal } from "./plan-control.ts"
import type { RuntimeCore } from "./runtime-core.ts"
import {
  errorText,
  isRecord,
  isRerunnableEffect,
  messageID,
  type StartupRecoveryAuthorization,
  type WorkerObservationFence,
} from "./runtime-helpers.ts"
import {
  nativeWorktreeFailureEvidence,
  UNCERTAIN_EFFECT_RECEIPT_SCHEMA,
} from "./startup-recovery.ts"
import type { AttemptRow, EffectRow, PlanRow } from "./store.ts"

/** What the journal reads from the coordinator's other regions; each call is a lazy arrow. */
export type JournalDeps = {
  workerObservationCurrent: (observation: WorkerObservationFence) => boolean
  startupRecoveryAuthorization: (
    plan: PlanRow,
    attempt: AttemptRow,
  ) => StartupRecoveryAuthorization | undefined
  startupRecoveryAuthorityCurrent: (
    plan: PlanRow,
    attempt: AttemptRow,
    authorization: StartupRecoveryAuthorization,
  ) => boolean
  holdAdoption: AdoptionExecution["holdAdoption"]
}

/**
 * The runner's outbox and effect writers: plan holds, outcomes, and the intended, completed,
 * superseded and uncertain effect records. Moved out of `TaskRuntime` without rewriting; the
 * private aliases below keep the member bodies identical to what they were.
 */
export class RuntimeJournal {
  private readonly adoptionExecution: { holdAdoption: JournalDeps["holdAdoption"] }
  private readonly workerObservationCurrent: JournalDeps["workerObservationCurrent"]
  private readonly startupRecoveryAuthorization: JournalDeps["startupRecoveryAuthorization"]
  private readonly startupRecoveryAuthorityCurrent: JournalDeps["startupRecoveryAuthorityCurrent"]

  constructor(
    private readonly core: RuntimeCore,
    deps: JournalDeps,
  ) {
    this.adoptionExecution = { holdAdoption: (...args) => deps.holdAdoption(...args) }
    this.workerObservationCurrent = (...args) => deps.workerObservationCurrent(...args)
    this.startupRecoveryAuthorization = (...args) => deps.startupRecoveryAuthorization(...args)
    this.startupRecoveryAuthorityCurrent = (...args) =>
      deps.startupRecoveryAuthorityCurrent(...args)
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

  hold(
    plan: PlanRow,
    reason: string,
    requestedActions: readonly string[] = ["audit", "reconcile", "cancel"],
    workerObservation?: TerminalWorkerHold,
    observationFence?: WorkerObservationFence,
  ) {
    // A hold advertises every action that unblocks its reason.
    const allowedActions = holdActions(reason, requestedActions)
    const currentObservation = this.store.atomic((db) => {
      if (observationFence && !this.workerObservationCurrent(observationFence)) return false
      const current = db
        .query<{ state: string; reason: string | null }, [string]>(
          "SELECT state,reason FROM runner_plans WHERE id=?",
        )
        .get(plan.id)
      if (!current) throw new Error("Plan not found")
      const previousBlocked = db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM runner_transitions WHERE plan_id=? AND task_id IS NULL AND event='BLOCKED' ORDER BY id DESC LIMIT 1",
        )
        .get(plan.id)
      let previousObservation: unknown
      try {
        previousObservation = previousBlocked
          ? (JSON.parse(previousBlocked.payload) as { workerObservation?: unknown })
              .workerObservation
          : undefined
      } catch {
        previousObservation = undefined
      }
      const observationChanged =
        workerObservation !== undefined
          ? JSON.stringify(previousObservation) !== JSON.stringify(workerObservation)
          : previousObservation !== undefined
      const changedReason = current.state !== "blocked" || current.reason !== reason
      if (!observationChanged && !changedReason) return true
      db.query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'blocked'),reason=?,version=version+1 WHERE id=?",
      ).run(reason, plan.id)
      this.store.record(plan.id, null, "BLOCKED", {
        reason,
        ...(workerObservation ? { workerObservation } : {}),
      })
      this.outcome(plan.id, { status: "blocked", reason, allowedActions }, true)
      return true
    })
    if (!currentObservation) return undefined
    return {
      status: "blocked",
      reason,
      planID: plan.id,
      version: this.store.plan(plan.id)!.version,
    }
  }

  terminalWorkerObservation(
    attempt: AttemptRow,
    worker: HostSession,
  ): TerminalWorkerHold | undefined {
    if (
      worker.outcome !== "interrupted" &&
      worker.outcome !== "failed" &&
      worker.outcome !== "succeeded"
    )
      return undefined
    return {
      kind: "terminal-worker-observation",
      attemptID: attempt.id,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      inputID: worker.turn?.inputID,
      outcome: worker.outcome,
      turnState: worker.turn?.state,
      idleAt: worker.idleAt,
      busy: worker.busy,
      pendingInput: worker.pendingInput ?? false,
      pendingPermissions: worker.pendingPermissions ?? 0,
      pendingForms: worker.pendingForms ?? 0,
      observationUnstable: worker.observationUnstable ?? false,
    }
  }
  outcome(planID: string, payload: unknown, resume: boolean) {
    const plan = this.store.plan(planID)!
    const full = {
      planID,
      planRevision: plan.revision,
      version: plan.version,
      ...(payload as object),
      currentPlan: { state: plan.state, reason: plan.reason },
      reviewableTasks: this.store
        .nodes(planID)
        .filter((node) => node.state === "accepted" && node.artifact)
        .map((node) => {
          const attempt = this.store
            .attempts(planID)
            .findLast(
              (candidate) =>
                candidate.task_id === node.task_id &&
                candidate.state === "accepted" &&
                candidate.artifact === node.artifact,
            )
          const adoption = this.store
            .adoptions(planID)
            .find(
              (candidate) =>
                candidate.state === "accepted" &&
                candidate.task_id === node.task_id &&
                candidate.descendant_commit === node.artifact,
            )
          return {
            taskID: node.task_id,
            artifact: node.artifact,
            attemptID: attempt?.id ?? null,
            ...(adoption ? { adoptionID: adoption.id } : {}),
            evidence: this.store.repository
              .get(node.task_id)!
              .proposal.verification.map((check) => check.id),
          }
        }),
    }
    const id = fingerprint(full)
    const nativeMessageID = messageID()
    const metadata: OutcomeOwnership = {
      lazersKind: "runner-outcome",
      lazersProjectID: this.projectID,
      lazersProjectDirectory: this.directory,
      lazersPlanID: planID,
      lazersOutboxID: id,
      lazersMessageID: nativeMessageID,
      lazersSessionID: plan.owner,
      lazersStatus:
        typeof payload === "object" &&
        payload !== null &&
        "status" in payload &&
        typeof payload.status === "string"
          ? payload.status
          : "update",
      lazersVersion: plan.version,
    }
    this.store.atomic((db) => {
      db.query(
        "INSERT OR IGNORE INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',?,?,NULL)",
      ).run(
        id,
        planID,
        plan.owner,
        nativeMessageID,
        JSON.stringify(full),
        Number(resume),
        JSON.stringify(metadata),
      )
      this.store.repository.changed()
    })
  }
  effect(
    planID: string,
    taskID: string | null,
    attemptID: string | null,
    kind: string,
    payload: unknown,
    fence: number,
  ): EffectRow {
    const baseID = fingerprint({ planID, taskID, attemptID, kind, payload })
    return this.store.fenced(this.owner, fence, (db) => {
      let id = baseID
      const existing = db
        .query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE id=?")
        .get(baseID)
      if (existing) {
        // A verification effect is re-runnable: once its earlier run was
        // superseded (no receipt), the same check runs again on the candidate.
        if (!isRerunnableEffect(kind))
          throw new Error(`Existing ${kind} effect must be reconciled, never replayed`)
        const runs = db
          .query<{ id: string; state: string }, [string, string, string]>(
            "SELECT id,state FROM runner_effects WHERE plan_id=? AND kind=? AND payload=?",
          )
          .all(planID, kind, JSON.stringify(payload))
          .filter((row) => row.id === baseID || row.id.startsWith(`${baseID}:`))
        if (runs.some((row) => row.state !== "failed"))
          throw new Error(`Existing ${kind} effect must be reconciled, never replayed`)
        id = `${baseID}:${runs.length}`
      }
      db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'intended',?,NULL,?)").run(
        id,
        planID,
        taskID,
        attemptID,
        kind,
        JSON.stringify(payload),
        fence,
      )
      this.store.record(planID, taskID, "EFFECT_INTENDED", { effectID: id, kind, attemptID })
      return db.query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE id=?").get(id)!
    })
  }
  receipt(effect: EffectRow, receipt: unknown, fence: number) {
    this.store.fenced(this.owner, fence, (db) => {
      const changed = db
        .query(
          "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'completed'),receipt=? WHERE id=? AND state IN ('intended','uncertain','held')",
        )
        .run(JSON.stringify(receipt), effect.id).changes
      if (changed !== 1) return
      this.store.record(effect.plan_id, effect.task_id, "EFFECT_COMPLETED", {
        effectID: effect.id,
        kind: effect.kind,
      })
    })
  }
  /** A re-runnable effect with no receipt is replaced, not left uncertain. */
  supersedeEffect(effect: EffectRow, reason: string, fence: number) {
    this.store.fenced(this.owner, fence, (db) => {
      const changed = db
        .query(
          "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed'),receipt=? WHERE id=? AND state IN ('intended','uncertain')",
        )
        .run(JSON.stringify({ superseded: true, reason }), effect.id).changes
      if (changed !== 1) return
      this.store.record(effect.plan_id, effect.task_id, "EFFECT_SUPERSEDED", {
        effectID: effect.id,
        kind: effect.kind,
        reason,
      })
    })
  }
  uncertain(effect: EffectRow, error: unknown, fence: number, result?: unknown) {
    const nativeFailure =
      effect.kind === "worktree" || effect.kind === "worktree-recovery"
        ? nativeWorktreeFailureEvidence(error)
        : undefined
    const changed = this.store.fenced(
      this.owner,
      fence,
      (db) =>
        db
          .query(
            "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'uncertain'),receipt=? WHERE id=? AND state IN ('intended','uncertain')",
          )
          .run(
            JSON.stringify({
              ...(!nativeFailure ? { schema: UNCERTAIN_EFFECT_RECEIPT_SCHEMA } : {}),
              error: errorText(error),
              ...(result === undefined ? {} : { result }),
              ...(nativeFailure ? { nativeFailure } : {}),
            }),
            effect.id,
          ).changes,
    )
    if (changed !== 1) return
    const plan = this.store.plan(effect.plan_id)
    if (!plan || plan.state === "cancelling" || terminal.has(plan.state)) return
    if (effect.kind === "worktree-recovery" && effect.attempt_id) {
      const attempt = this.store
        .attempts(effect.plan_id)
        .find((item) => item.id === effect.attempt_id)
      const authorization = attempt ? this.startupRecoveryAuthorization(plan, attempt) : undefined
      if (
        !attempt ||
        !authorization ||
        !this.startupRecoveryAuthorityCurrent(plan, attempt, authorization)
      )
        return
    }
    {
      const reason = `Recovery uncertain for ${effect.kind} ${effect.id}: ${errorText(error)}`
      const payload = JSON.parse(effect.payload) as { adoptionID?: unknown }
      if (effect.kind.startsWith("adoption-") && typeof payload.adoptionID === "string")
        this.adoptionExecution.holdAdoption(plan, payload.adoptionID, reason, "pending", fence)
      else
        this.hold(
          plan,
          reason,
          effect.kind.startsWith("verify:") &&
            isRecord(result) &&
            isRecord(result.check) &&
            result.check.aborted === true
            ? ["resume", "reconcile", "audit", "cancel"]
            : undefined,
        )
    }
  }
}

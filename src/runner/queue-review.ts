import type { OutboxRow } from "./store.ts"
import { PROJECT_RECONCILIATION_INTERVAL_MS } from "./scheduler-coordinator.ts"
import { verificationActivitiesForDatabase } from "./verification-activities.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { OutcomeDelivery } from "./outcome-delivery.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"
import type { TaskRuntime } from "./runtime.ts"
import type { WorkerObservation } from "./worker-observation.ts"
import type { RuntimeCore } from "./runtime-core.ts"
import { planIs } from "./identity-read.ts"

type QueueWait = {
  planID: string
  prerequisitePlanIDs?: string[]
  reservationTaskIDs?: string[]
  state?: string
}

/** What `QueueReview` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type QueueReviewDeps = {
  backgroundBlockReason: WorkerObservation["backgroundBlockReason"]
  outcome: RuntimeJournal["outcome"]
  fallowGate: TaskRuntime["fallowGate"]
  outcomeDelivery: OutcomeDelivery
  validArchitect: ArchitectOwnership["validArchitect"]
}

/**
 * Queue review: asking the Architect to review the queue of finished work, and releasing the holds a
 * fixed Fallow configuration lifts. Moved out of `TaskRuntime` without rewriting; the private aliases
 * below keep the member bodies identical to what they were.
 */
export class QueueReview {
  private readonly backgroundBlockReason: QueueReviewDeps["backgroundBlockReason"]
  private readonly outcome: QueueReviewDeps["outcome"]
  private readonly fallowGate: QueueReviewDeps["fallowGate"]
  private readonly outcomeDelivery: QueueReviewDeps["outcomeDelivery"]
  private readonly validArchitect: QueueReviewDeps["validArchitect"]

  constructor(
    private readonly core: RuntimeCore,
    deps: QueueReviewDeps,
  ) {
    this.backgroundBlockReason = (...args) => deps.backgroundBlockReason(...args)
    this.outcome = (...args) => deps.outcome(...args)
    this.fallowGate = (...args) => deps.fallowGate(...args)
    this.outcomeDelivery = deps.outcomeDelivery
    this.validArchitect = deps.validArchitect
  }

  private get host() {
    return this.core.host
  }

  private get now() {
    return this.core.now
  }

  private get owner() {
    return this.core.owner
  }

  private get store() {
    return this.core.store
  }

  private get directory() {
    return this.core.directory
  }

  async requestQueueReview(waits: QueueWait[], fence: number) {
    const current = () => {
      const waiting = new Map<string, QueueWait>(
        waits
          .filter(
            ({ planID }) =>
              this.store.plan(planID)?.state === "running" &&
              !this.store.effectiveDispatchPause(planID),
          )
          .map((wait) => [wait.planID, wait]),
      )
      // A delivered notice is not resolution. Revisit unfinished review on the normal cadence.
      for (const plan of this.store.runnablePlans(new Set(), [
        "blocked",
        "accepted",
        "cleanup-blocked",
      ])) {
        if (!this.store.effectiveDispatchPause(plan.id))
          waiting.set(plan.id, { planID: plan.id, state: plan.state })
      }
      return [...waiting.values()]
    }
    const waiting = current()
    const anchor = waiting[0]
    if (!anchor) return
    const review = { waiting }
    const event = "QUEUE_REVIEW_REQUESTED"
    const prior = this.store.read((db) =>
      db
        .query<OutboxRow & { requestedAt: number }, [string, string]>(
          `SELECT o.*, o.rowid AS sequence, CAST(json_extract(o.payload,'$.version') AS INTEGER) AS version,
                COALESCE(json_extract(o.payload,'$.requestedAt'),
                  (SELECT max(t.created_at) FROM runner_transitions t
                   WHERE ${planIs(db, "runner_transitions", "t", "o.plan_id")} AND t.event='QUEUE_REVIEW_REQUESTED'), 0) AS requestedAt
           FROM runner_outbox o
          WHERE o.plan_id=? AND json_extract(o.payload,'$.status')='queue-review'
            AND json_extract(o.payload,'$.waiting')=?
          ORDER BY o.rowid DESC LIMIT 1`,
        )
        .get(anchor.planID, JSON.stringify(waiting)),
    )
    if (prior && this.now() - prior.requestedAt < PROJECT_RECONCILIATION_INTERVAL_MS) return
    if (prior?.state === "pending") return
    const needsReview = waiting.some((wait) => wait.state !== undefined)
    const reviewPlans = new Set(waiting.map((wait) => wait.planID))
    const checking = () =>
      verificationActivitiesForDatabase(this.store.repository.path).some(
        (activity) =>
          activity.metadata.projectDirectory === this.directory &&
          activity.state === "running" &&
          (!needsReview ||
            (typeof activity.metadata.planID === "string" &&
              reviewPlans.has(activity.metadata.planID))),
      )
    if (checking()) return
    const active = this.store.activeProjectAttempts()
    for (const attempt of needsReview ? [] : active) {
      const session = await this.host.session(attempt.session_id)
      if (
        session?.busy ||
        session?.pendingInput ||
        session?.observationUnstable ||
        (session && this.backgroundBlockReason(session))
      )
        return
    }
    const owner = this.store.plan(anchor.planID)?.owner
    if (!owner) return
    const architect = await this.host.session(owner)
    if (
      architect?.busy ||
      architect?.pendingInput ||
      architect?.observationUnstable ||
      (architect?.pendingPermissions ?? 0) > 0 ||
      (architect?.pendingForms ?? 0) > 0
    )
      return

    if (prior?.state === "delivered") {
      // A delivered review still waiting in the Architect's inbox is not asked again.
      if (prior.session_id !== owner || !this.validArchitect(architect)) return
      const observation = await this.outcomeDelivery.outcomeObservation(
        prior,
        owner,
        this.outcomeDelivery.ownership(prior),
      )
      if (observation === "queued") return
    }
    this.store.fenced(this.owner, fence, () => {
      if (
        checking() ||
        this.store.plan(anchor.planID)?.owner !== owner ||
        JSON.stringify(current()) !== JSON.stringify(waiting) ||
        this.store
          .activeProjectAttempts()
          .some(
            (attempt) =>
              !active.some(
                (observed) =>
                  observed.id === attempt.id &&
                  observed.message_id === attempt.message_id &&
                  observed.state === attempt.state,
              ),
          )
      )
        return
      const requestedAt = this.now()
      this.store.record(anchor.planID, null, event, { ...review, requestedAt })
      this.outcome(anchor.planID, { status: "queue-review", ...review, requestedAt }, true)
    })
  }
  /**
   * Plans held at dispatch because the project had no Fallow config resume on their own once one
   * exists (the same running transition the Architect's `run` makes), so a queued task never
   * dead-ends on a rule that arrived after it.
   */
  async releaseFallowConfigHolds(fence: number) {
    const held = this.store.read((db) =>
      db
        .query<{ id: string }, [string]>(
          "SELECT id FROM runner_plans WHERE project_directory=? AND state='blocked' AND reason LIKE 'FALLOW_CONFIG_REQUIRED%'",
        )
        .all(this.directory),
    )
    if (held.length === 0 || (await this.fallowGate())) return
    for (const { id } of held)
      this.store.fenced(this.owner, fence, (db) => {
        const changed = db
          .query(
            "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason LIKE 'FALLOW_CONFIG_REQUIRED%'",
          )
          .run(id).changes
        if (changed === 1)
          this.store.record(id, null, "RECONCILE_REQUESTED", {
            caller: "fallow-config",
            verificationEpoch: this.store.plan(id)!.version,
          })
      })
  }
}

import type { HostSession } from "./host.ts"
import type { PlanRow, OutboxRow } from "./store.ts"
import { appendOutboxReceipt } from "./store.ts"
import { coalescedOutcomeText } from "./outcome.ts"
import { isOwnedOutcomeTranscript, isOwnedQueuedOutcome, parseOutcomeOwnership } from "./inbox.ts"
import type { OutcomeOwnership } from "./inbox.ts"
import { sameProject } from "../project-key.ts"

import type { TaskRuntime } from "./runtime.ts"
import { errorText, messageID } from "./runtime-helpers.ts"

/** Handoffs, queue reviews and holds are decisions a later outcome does not answer. */
function replaceable(row: OutboxRow) {
  try {
    const status = (JSON.parse(row.payload) as { status?: unknown }).status
    return (
      status !== "architect-handoff" &&
      status !== "queue-review" &&
      status !== "retained-verification-failed"
    )
  } catch {
    return false
  }
}

/**
 * Outcome delivery keeps at most one pending LAZERS notice in an Architect's
 * OpenCode inbox. OpenCode delivers one queued input per idle transition, so every
 * extra notice is another model turn. All notices pending for a session are
 * merged into one that states the latest outcome of each plan; the notices it
 * replaces are cancelled.
 *
 * A notice is `pending` until it is in the session inbox, then `delivered`.
 * It is `superseded` when a newer outcome for the same plan replaces it before it
 * is sent. Consumption is not tracked.
 */
export class OutcomeDelivery {
  constructor(
    private readonly runtime: {
      directory: TaskRuntime["directory"]
      ensureArchitectOwner: TaskRuntime["ensureArchitectOwner"]
      host: TaskRuntime["host"]
      owner: TaskRuntime["owner"]
      projectID: TaskRuntime["projectID"]
      reconcilePlan: TaskRuntime["reconcilePlan"]
      store: TaskRuntime["store"]
      validArchitect: TaskRuntime["validArchitect"]
    },
  ) {}

  ownership(message: OutboxRow): OutcomeOwnership | undefined {
    const ownership = parseOutcomeOwnership(message.metadata ? JSON.parse(message.metadata) : null)
    if (
      !ownership ||
      ownership.lazersOutboxID !== message.id ||
      ownership.lazersPlanID !== message.plan_id ||
      ownership.lazersMessageID !== message.message_id ||
      ownership.lazersSessionID !== message.session_id
    )
      return undefined
    return ownership
  }

  private createOwnership(message: OutboxRow, sessionID: string): OutcomeOwnership {
    const payload = JSON.parse(message.payload) as { status?: unknown; version?: unknown }
    return {
      lazersKind: "runner-outcome",
      lazersProjectID: this.runtime.projectID,
      lazersProjectDirectory: this.runtime.directory,
      lazersPlanID: message.plan_id,
      lazersOutboxID: message.id,
      lazersMessageID: message.message_id,
      lazersSessionID: sessionID,
      lazersStatus: typeof payload.status === "string" ? payload.status : "update",
      lazersVersion: typeof payload.version === "number" ? payload.version : 0,
    }
  }

  /** Move a pending notice to its next state; false when another writer already did. */
  outcomeState(
    message: OutboxRow,
    state: "delivered" | "superseded",
    receipt: unknown,
    event: string,
    fence: number,
  ) {
    return this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = db
        .query<{ state: string; receipt: string | null }, [string]>(
          "SELECT state,receipt FROM runner_outbox WHERE id=?",
        )
        .get(message.id)
      if (current?.state !== "pending") return false
      const changed = db
        .query(
          "UPDATE runner_outbox SET state=lz_runner_transition('outbox',state,?),receipt=? WHERE id=? AND state='pending'",
        )
        .run(state, appendOutboxReceipt(current.receipt, receipt), message.id).changes
      if (changed) {
        this.runtime.store.record(message.plan_id, null, event, {
          outboxID: message.id,
          messageID: message.message_id,
          to: state,
          receipt,
        })
        this.runtime.store.repository.changed()
      }
      return changed === 1
    })
  }

  /** Where a notice stands in the native inbox or transcript. Read-only. */
  async outcomeObservation(
    message: OutboxRow,
    sessionID: string,
    ownership?: OutcomeOwnership,
  ): Promise<"queued" | "consumed" | "missing" | "unowned"> {
    // Older injected hosts used by recovery fixtures do not have the pinned
    // inbox API. They can still prove an exact transcript ID, but cannot prove
    // that an absent message was cancelled or consumed.
    if (!this.runtime.host.outcomeInbox) {
      const target = await this.runtime.host.session(sessionID, { messages: true })
      const transcript = target?.messages.find((item) => item.id === message.message_id)
      if (!transcript) return "missing"
      if (ownership) return isOwnedOutcomeTranscript(transcript, ownership) ? "consumed" : "unowned"
      return transcript.type === "synthetic" ? "consumed" : "unowned"
    }
    const inbox = await this.runtime.host.outcomeInbox(sessionID)
    const entry = inbox.find((item) => item.id === message.message_id)
    if (entry) {
      if (ownership && isOwnedQueuedOutcome(entry, ownership)) return "queued"
      return "unowned"
    }
    const target = await this.runtime.host.session(sessionID, { messages: true })
    const transcript = target?.messages.find((item) => item.id === message.message_id)
    if (!transcript) return "missing"
    if (ownership) return isOwnedOutcomeTranscript(transcript, ownership) ? "consumed" : "unowned"
    return transcript.type === "synthetic" ? "consumed" : "unowned"
  }

  /**
   * The pending notices of one plan that still say something. A later outcome
   * replaces an earlier one; handoffs, queue reviews and holds are decisions
   * that a later outcome does not answer, so they stay.
   */
  private async currentRows(ordered: OutboxRow[], plan: PlanRow, fence: number) {
    const current: OutboxRow[] = []
    for (const [index, message] of ordered.entries()) {
      let older: Record<string, unknown>
      try {
        older = JSON.parse(message.payload) as Record<string, unknown>
      } catch {
        continue
      }
      // Once all task artifacts are accepted the next actionable outcome is
      // the combined result. Async checks must not publish a redundant task
      // handoff merely because that result requires another tick.
      if (
        older.status === "task-accepted" &&
        plan.state === "running" &&
        this.runtime.store.nodes(plan.id).every((node) => node.state === "accepted")
      )
        continue
      const replacement =
        older.status === "architect-handoff" ||
        older.status === "queue-review" ||
        older.status === "retained-verification-failed"
          ? undefined
          : ordered.slice(index + 1).findLast((candidate) => {
              const next = JSON.parse(candidate.payload)
              if (
                next.status === "architect-handoff" ||
                next.status === "queue-review" ||
                next.status === "retained-verification-failed"
              )
                return false
              // Current outcomes include the whole accepted-artifact review set.
              // Legacy partial notices cannot suppress a different actionable result.
              if (older.status === "task-accepted")
                return (
                  (Array.isArray(next.reviewableTasks) &&
                    next.reviewableTasks.some(
                      (task: { taskID?: string; artifact?: string }) =>
                        task.taskID === older.taskID && task.artifact === older.artifact,
                    )) ||
                  (next.status === "task-accepted" &&
                    next.taskID === older.taskID &&
                    next.artifact === older.artifact) ||
                  (["accepted", "integrated"].includes(next.status) &&
                    typeof next.artifact === "string")
                )
              return next.status !== "task-accepted" || Boolean(next.currentPlan)
            })
      if (replacement)
        this.outcomeState(
          message,
          "superseded",
          { kind: "superseded-before-native-admission", byOutboxID: replacement.id },
          "OUTCOME_SUPERSEDED",
          fence,
        )
      else current.push(message)
    }
    return current
  }

  /** The live Architect for a plan, replacing a lost one; undefined leaves the notices queued. */
  private async architect(plan: PlanRow) {
    const current = await this.runtime.host.session(plan.owner)
    if (this.runtime.validArchitect(current)) return current
    try {
      return await this.runtime.ensureArchitectOwner(plan, current)
    } catch {
      return undefined
    }
  }

  /** Point queued notices at the plan's current Architect; native message IDs are global. */
  private retarget(rows: OutboxRow[], sessionID: string) {
    return rows.flatMap((row) => {
      if (row.session_id === sessionID) return [row]
      const replacementID = messageID()
      const prior = this.ownership(row) ?? this.createOwnership(row, row.session_id)
      const next = { ...prior, lazersSessionID: sessionID, lazersMessageID: replacementID }
      const metadata = JSON.stringify(next)
      const moved = this.runtime.store.retargetOutbox({
        id: row.id,
        expectedState: "pending",
        sessionID,
        messageID: replacementID,
        metadata,
        receipt: {
          kind: "owner-retargeted-queued-notice",
          fromSessionID: row.session_id,
          toSessionID: sessionID,
          previousMessageID: row.message_id,
        },
      })
      return moved ? [{ ...row, session_id: sessionID, message_id: replacementID, metadata }] : []
    })
  }

  /** Rows a queued native notice already summarizes, itself included. */
  private summarized(row: OutboxRow) {
    const ids = new Set([row.id])
    try {
      const history = (
        JSON.parse(row.receipt ?? "{}") as { history?: Array<Record<string, unknown>> }
      ).history
      for (const entry of history ?? [])
        if (Array.isArray(entry.coalescedOutboxIDs))
          for (const id of entry.coalescedOutboxIDs) if (typeof id === "string") ids.add(id)
    } catch {
      // A receipt that cannot be read summarizes only its own row.
    }
    return [...ids].flatMap((id) => this.runtime.store.outboxRowByID(id) ?? [])
  }

  /** A held notice is visible on its plan, once per distinct cause, never silent. */
  private hold(rows: OutboxRow[], event: string, detail: Record<string, unknown>, fence: number) {
    for (const planID of new Set(rows.map((row) => row.plan_id)))
      this.runtime.store.fenced(this.runtime.owner, fence, () =>
        this.runtime.store.recordOnce(planID, null, event, detail),
      )
  }

  /**
   * After an owner change, this ledger's notices still queued in the plan's former
   * sessions would cost a stray turn there. Cancel them; never block the new owner.
   */
  private async retireOldSessions(sessionID: string, rows: OutboxRow[], fence: number) {
    const host = this.runtime.host
    const old = this.runtime.store.deliveredOutsideSession(
      [...new Set(rows.map((row) => row.plan_id))],
      sessionID,
    )
    const bySession = new Map<string, OutboxRow[]>()
    for (const row of old)
      bySession.set(row.session_id, [...(bySession.get(row.session_id) ?? []), row])
    for (const [oldSession, oldRows] of bySession) {
      let queued: Awaited<ReturnType<NonNullable<typeof host.outcomeInbox>>>
      try {
        queued = host.outcomeInbox ? await host.outcomeInbox(oldSession) : []
      } catch (error) {
        this.hold(
          oldRows,
          "OUTCOME_OLD_INBOX_UNREADABLE",
          { sessionID: oldSession, error: errorText(error).slice(0, 300) },
          fence,
        )
        continue
      }
      for (const row of oldRows) {
        const ownership = this.ownership(row)
        const entry = queued.find((item) => item.id === row.message_id)
        let cancelled = false
        if (
          entry &&
          ownership &&
          sameProject(ownership.lazersProjectID, this.runtime.projectID) &&
          ownership.lazersProjectDirectory === this.runtime.directory &&
          isOwnedQueuedOutcome(entry, ownership)
        ) {
          if (!host.cancelOutcome) continue
          try {
            await host.cancelOutcome({
              sessionID: oldSession,
              inboxID: row.message_id,
              ownership,
            })
            cancelled = true
          } catch {
            // Consumed or cancelled meanwhile; it is listed again if it is still queued.
            continue
          }
        } else if (entry) continue // A lookalike is not ours to cancel.
        this.runtime.store.noteOutboxReceipt(row.id, {
          kind: "retired-session-cleaned",
          sessionID: oldSession,
          cancelled,
        })
      }
    }
  }

  /**
   * Merge a session's pending notices into one inbox item and cancel the ones it replaces.
   * Returns true when notices stay pending and delivery should be retried soon.
   */
  private async deliverSession(
    sessionID: string,
    pendingRows: OutboxRow[],
    fence: number,
  ): Promise<boolean> {
    const host = this.runtime.host
    let rows = pendingRows
    let carrier = rows.toSorted((a, b) => a.sequence - b.sequence).at(-1)!
    let queued: Awaited<ReturnType<NonNullable<typeof host.outcomeInbox>>>
    try {
      queued = host.outcomeInbox ? await host.outcomeInbox(sessionID) : []
    } catch (error) {
      // An unreadable inbox only costs the cancellations: the notice is still sent.
      queued = []
      this.hold(
        pendingRows,
        "OUTCOME_INBOX_UNREADABLE",
        { sessionID, error: errorText(error).slice(0, 300) },
        fence,
      )
    }
    // Only queued notices that this ledger sent are ours to replace; a lookalike
    // without a durable row, or with different ownership, is left alone.
    const stale = queued.flatMap((entry) => {
      const row = this.runtime.store.outboxRowByMessage(sessionID, entry.id)
      const ownership = row && this.ownership(row)
      return row &&
        ownership &&
        sameProject(ownership.lazersProjectID, this.runtime.projectID) &&
        ownership.lazersProjectDirectory === this.runtime.directory &&
        isOwnedQueuedOutcome(entry, ownership)
        ? [{ id: entry.id, ownership, row }]
        : []
    })

    if (stale.some((entry) => entry.id === carrier.message_id)) {
      // An earlier send landed before its result was recorded.
      for (const row of rows)
        this.outcomeState(
          row,
          "delivered",
          { kind: "native-inbox-observed", sessionID },
          "OUTCOME_HOST_DELIVERED",
          fence,
        )
      return false
    }

    // What a notice about to be replaced last told each plan.
    const earlier = new Map<string, OutboxRow>()
    for (const row of stale.flatMap((entry) => this.summarized(entry.row))) {
      const best = earlier.get(row.plan_id)
      if (
        !best ||
        row.version > best.version ||
        (row.version === best.version && row.sequence > best.sequence)
      )
        earlier.set(row.plan_id, row)
    }
    // A pending notice older than what the Architect was already told about its
    // plan is a late arrival; it must not replace the newer outcome.
    const pending: OutboxRow[] = []
    for (const row of rows) {
      const told = earlier.get(row.plan_id)
      if (told && told.version > row.version && replaceable(row) && replaceable(told))
        this.outcomeState(
          row,
          "superseded",
          { kind: "older-than-queued-outcome", byOutboxID: told.id },
          "OUTCOME_SUPERSEDED",
          fence,
        )
      else pending.push(row)
    }
    if (!pending.length) return false
    rows = pending
    carrier = rows.toSorted((a, b) => a.sequence - b.sequence).at(-1)!
    const pendingPlans = new Set(rows.map((row) => row.plan_id))
    // A plan with a pending notice supersedes what the replaced notices said about it.
    const summary = [
      ...[...earlier.values()].filter((row) => !pendingPlans.has(row.plan_id)),
      ...rows,
    ].toSorted((a, b) => a.sequence - b.sequence)
    const carried = new Set([...summary.map((row) => row.id), ...rows.map((row) => row.id)])

    // The pause may be set while this tick is already delivering: check again at the send.
    if (this.runtime.store.architectContactPaused()) return false
    const ownership = this.ownership(carrier) ?? this.createOwnership(carrier, sessionID)
    try {
      await host.notify({
        sessionID,
        id: carrier.message_id,
        text: coalescedOutcomeText(
          summary.map((row) => ({ planID: row.plan_id, payload: row.payload })),
        ),
        resume: rows.some((row) => Boolean(row.resume)),
        metadata: ownership,
      })
    } catch (error) {
      // A lost response may still have admitted the notice. If it is queued or already
      // consumed it was delivered; otherwise it stays pending and the next tick retries.
      try {
        const seen = await this.outcomeObservation(carrier, sessionID, ownership)
        if (seen !== "queued" && seen !== "consumed") {
          this.hold(
            rows,
            "OUTCOME_DELIVERY_FAILED",
            { sessionID, error: errorText(error).slice(0, 300) },
            fence,
          )
          return true
        }
      } catch {
        this.hold(
          rows,
          "OUTCOME_DELIVERY_FAILED",
          { sessionID, error: errorText(error).slice(0, 300) },
          fence,
        )
        return true
      }
    }
    for (const row of rows)
      this.outcomeState(
        row,
        "delivered",
        row.id === carrier.id
          ? {
              kind: "host-admitted",
              sessionID,
              coalescedOutboxIDs: [...carried],
              replacedMessageIDs: stale.map((entry) => entry.id),
            }
          : { kind: "merged-into-notice", byOutboxID: carrier.id },
        "OUTCOME_HOST_DELIVERED",
        fence,
      )
    for (const entry of stale) {
      if (!host.cancelOutcome) break
      try {
        await host.cancelOutcome({
          sessionID,
          inboxID: entry.id,
          ownership: entry.ownership,
        })
      } catch {
        // It was consumed or cancelled meanwhile; the next delivery lists the inbox again.
      }
    }
    await this.retireOldSessions(sessionID, rows, fence)
    return false
  }

  /** Returns true when notices remain pending for a retryable reason; the caller schedules a retry. */
  async deliver(fence: number, closeoutOnly = false): Promise<boolean> {
    // A user-set pause keeps every notice queued; nothing prompts an Architect.
    if (this.runtime.store.architectContactPaused()) return false
    let retry = false
    const groups = new Map<string, OutboxRow[]>()
    for (const message of this.runtime.store.outboxForDelivery(this.runtime.directory)) {
      const group = groups.get(message.plan_id) ?? []
      group.push(message)
      groups.set(message.plan_id, group)
    }
    // Notices for different plans meet here when they share an Architect.
    const sessions = new Map<string, OutboxRow[]>()
    for (const group of groups.values()) {
      const ordered = group.toSorted((a, b) => a.version - b.version || a.sequence - b.sequence)
      if (
        closeoutOnly &&
        !["accepted", "task-accepted", "cleanup-blocked"].includes(
          JSON.parse(ordered.at(-1)!.payload).status,
        )
      )
        continue
      if (this.runtime.store.architectRenewalBlocksDelivery(ordered[0]!.plan_id)) continue
      const planID = ordered[0]!.plan_id
      if (!this.runtime.store.plan(planID)) continue
      await this.runtime.reconcilePlan(planID, fence, "delivery", async () => {
        const plan = this.runtime.store.plan(planID)
        if (!plan) return
        const current = await this.currentRows(ordered, plan, fence)
        if (!current.length) return
        const target: HostSession | undefined = await this.architect(plan)
        if (!target) {
          retry = true
          this.hold(
            current,
            "OUTCOME_NO_ARCHITECT",
            { owner: plan.owner, reason: "No live Architect could be found or created" },
            fence,
          )
          return
        }
        const rows = this.retarget(current, target.id)
        if (rows.length) sessions.set(target.id, [...(sessions.get(target.id) ?? []), ...rows])
      })
    }
    for (const [sessionID, rows] of sessions)
      if (await this.deliverSession(sessionID, rows, fence)) retry = true
    return retry
  }
}

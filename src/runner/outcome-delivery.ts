import type { HostSession } from "./host.ts"
import type { PlanRow, OutboxRow } from "./store.ts"
import { appendOutboxReceipt } from "./store.ts"
import { outcomeText } from "./outcome.ts"
import { isOwnedOutcomeTranscript, isOwnedQueuedOutcome, parseOutcomeOwnership } from "./inbox.ts"
import type { OutcomeOwnership } from "./inbox.ts"
import { retainedVerification } from "./retained-verification/store.ts"

import type { TaskRuntime } from "./runtime.ts"
import { errorText } from "./runtime-helpers.ts"
import { messageID } from "./runtime-helpers.ts"

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
      wakeRecoveredArchitect: TaskRuntime["wakeRecoveredArchitect"]
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

  outcomeState(
    message: OutboxRow,
    expected: string[],
    state: string,
    receipt: unknown,
    event: string,
    fence: number,
  ) {
    return this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const placeholders = expected.map(() => "?").join(",")
      const current = db
        .query<{ state: string; receipt: string | null }, [string]>(
          "SELECT state,receipt FROM runner_outbox WHERE id=?",
        )
        .get(message.id)
      if (!current || !expected.includes(current.state)) return false
      const nextReceipt = appendOutboxReceipt(current.receipt, receipt)
      const changed = db
        .query(
          `UPDATE runner_outbox SET state=lz_runner_transition('outbox',state,?),receipt=? WHERE id=? AND state=? AND state IN (${placeholders})`,
        )
        .run(state, nextReceipt, message.id, current.state, ...expected).changes
      if (changed) {
        this.runtime.store.record(message.plan_id, null, event, {
          outboxID: message.id,
          messageID: message.message_id,
          from: current.state,
          to: state,
          receipt,
        })
        this.runtime.store.repository.changed()
      }
      return changed === 1
    })
  }

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

  private async supersedeOutcome(
    message: OutboxRow,
    latest: OutboxRow,
    plan: PlanRow,
    fence: number,
  ) {
    if (message.state === "unknown") return true
    if (message.state === "pending") {
      this.outcomeState(
        message,
        ["pending"],
        "superseded",
        { kind: "superseded-before-native-admission", byOutboxID: latest.id },
        "OUTCOME_SUPERSEDED",
        fence,
      )
      return true
    }
    if (!["sending", "uncertain", "admitted", "unknown", "delivered"].includes(message.state))
      return true

    const ownership = this.ownership(message)
    if (
      !ownership ||
      message.session_id !== latest.session_id ||
      message.session_id !== plan.owner
    ) {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "supersession-ownership-unavailable", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }

    const target = await this.runtime.host.session(message.session_id)
    if (!this.runtime.validArchitect(target) || target.id !== plan.owner) return true
    let observation: "queued" | "consumed" | "missing" | "unowned"
    try {
      observation = await this.outcomeObservation(message, target.id, ownership)
    } catch (error) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        {
          kind: "supersession-observation-unavailable",
          byOutboxID: latest.id,
          error: errorText(error),
        },
        "OUTCOME_SUPERSESSION_UNCERTAIN",
        fence,
      )
      return false
    }
    if (observation === "consumed") {
      this.outcomeState(
        message,
        [message.state],
        "consumed",
        { kind: "transcript-observed", byOutboxID: latest.id },
        "OUTCOME_CONSUMED",
        fence,
      )
      return true
    }
    if (observation === "unowned") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "supersession-input-identity-conflict", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }
    if (observation === "missing") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "unknown-consumption", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }

    if (!this.runtime.host.cancelOutcome) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        { kind: "native-cancellation-unavailable", byOutboxID: latest.id },
        "OUTCOME_CANCEL_UNCERTAIN",
        fence,
      )
      return false
    }

    try {
      await this.runtime.host.cancelOutcome({
        sessionID: target.id,
        inboxID: message.message_id,
        ownership,
      })
    } catch (error) {
      let afterFailure: "queued" | "consumed" | "missing" | "unowned"
      try {
        afterFailure = await this.outcomeObservation(message, target.id, ownership)
      } catch (observationError) {
        this.outcomeState(
          message,
          [message.state],
          message.state,
          {
            kind: "cancellation-outcome-unobservable",
            byOutboxID: latest.id,
            error: errorText(error),
            observationError: errorText(observationError),
          },
          "OUTCOME_CANCEL_UNCERTAIN",
          fence,
        )
        return false
      }
      if (afterFailure === "consumed") {
        this.outcomeState(
          message,
          [message.state],
          "consumed",
          { kind: "cancel-raced-with-consumption", byOutboxID: latest.id, error: errorText(error) },
          "OUTCOME_CANCEL_RACED_WITH_CONSUMPTION",
          fence,
        )
        return true
      }
      if (afterFailure === "queued") {
        this.outcomeState(
          message,
          [message.state],
          message.state,
          {
            kind: "cancellation-failed-still-queued",
            byOutboxID: latest.id,
            error: errorText(error),
          },
          "OUTCOME_CANCEL_UNCERTAIN",
          fence,
        )
        return false
      }
      if (afterFailure === "missing")
        this.outcomeState(
          message,
          [message.state],
          "unknown",
          {
            kind: "cancel-race-consumption-unknown",
            byOutboxID: latest.id,
            error: errorText(error),
          },
          "OUTCOME_CONSUMPTION_UNKNOWN",
          fence,
        )
      if (afterFailure === "unowned") {
        this.outcomeState(
          message,
          [message.state],
          message.state,
          { kind: "cancellation-not-confirmed-unowned-input", byOutboxID: latest.id },
          "OUTCOME_CANCEL_UNCERTAIN",
          fence,
        )
        return false
      }
      return true
    }

    let afterCancellation: "queued" | "consumed" | "missing" | "unowned"
    try {
      afterCancellation = await this.outcomeObservation(message, target.id, ownership)
    } catch (error) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        {
          kind: "cancellation-confirmation-unavailable",
          byOutboxID: latest.id,
          error: errorText(error),
        },
        "OUTCOME_CANCEL_UNCERTAIN",
        fence,
      )
      return false
    }
    if (afterCancellation === "consumed") {
      this.outcomeState(
        message,
        [message.state],
        "consumed",
        { kind: "consumption-observed-after-cancel", byOutboxID: latest.id },
        "OUTCOME_CANCEL_RACED_WITH_CONSUMPTION",
        fence,
      )
      return true
    }
    if (afterCancellation === "queued") {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        { kind: "cancel-returned-but-outcome-still-queued", byOutboxID: latest.id },
        "OUTCOME_CANCEL_UNCERTAIN",
        fence,
      )
      return false
    }
    if (afterCancellation === "unowned") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "cancel-returned-with-identity-conflict", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }

    this.outcomeState(
      message,
      [message.state],
      "superseded",
      { kind: "native-cancellation-confirmed", inboxID: message.message_id, byOutboxID: latest.id },
      "OUTCOME_SUPERSEDED",
      fence,
    )
    return true
  }

  private async deliverCurrent(
    message: OutboxRow,
    fence: number,
    admittedTargets: Map<string, HostSession>,
  ) {
    if (["consumed", "superseded", "unknown"].includes(message.state)) return
    let plan = this.runtime.store.plan(message.plan_id)
    if (!plan) return
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(message.payload) as Record<string, unknown>
    } catch {
      return
    }
    if (payload.status === "retained-verification-held") {
      const operationID = payload.operationID
      const operation =
        typeof operationID === "string"
          ? this.runtime.store.atomic((db) => retainedVerification(db, operationID))
          : undefined
      if (
        operation?.state !== "held" ||
        operation.planID !== plan.id ||
        ["cancelling", "cancelled", "integrated"].includes(plan.state)
      ) {
        if (message.state === "pending")
          this.outcomeState(
            message,
            ["pending"],
            "superseded",
            { kind: "retained-verification-hold-cleared" },
            "OUTCOME_SUPERSEDED",
            fence,
          )
        return
      }
    }
    if (payload.status === "architect-source-change") {
      const sourceSessionID = payload.sourceSessionID
      if (typeof sourceSessionID !== "string") return
      const context = this.runtime.store.architectSourceNoticeContext({
        planID: plan.id,
        sourceSessionID,
        expectedOwner: plan.owner,
        expectedPlanVersion: plan.version,
      })
      const currentTarget = context?.targets.find(
        (target) => target.owner === message.session_id && target.planIDs.includes(message.plan_id),
      )
      if (!currentTarget) {
        const replacementTarget = context?.targets[0]
        const replacementPlan = replacementTarget
          ? this.runtime.store.plan(replacementTarget.planID)
          : undefined
        if (replacementTarget && replacementPlan)
          this.runtime.store.ensureArchitectSourceChangeNotices({
            planID: replacementTarget.planID,
            sourceSessionID,
            expectedOwner: replacementTarget.owner,
            expectedPlanVersion: replacementPlan.version,
            projectID: this.runtime.projectID,
          })
        if (message.state === "pending") {
          this.outcomeState(
            message,
            ["pending"],
            "superseded",
            { kind: "source-change-target-no-longer-current", sourceSessionID },
            "ARCHITECT_SOURCE_CHANGE_SUPERSEDED",
            fence,
          )
          return
        }
      }
    }
    // Share only the no-op observation for already-admitted, same-owner rows in
    // this delivery group. Never reuse it for admission, cancellation or retarget.
    let target =
      message.state === "admitted" && message.session_id === plan.owner
        ? (admittedTargets.get(message.session_id) ??
          (await this.runtime.host.session(message.session_id)))
        : await this.runtime.host.session(message.session_id)
    plan = this.runtime.store.plan(message.plan_id)
    if (!plan) return
    if (
      message.state === "admitted" &&
      this.runtime.validArchitect(target) &&
      target.id === plan.owner
    ) {
      admittedTargets.set(target.id, target)
      return
    }
    // Any path that can mutate native/durable delivery invalidates this group's
    // observations; the next admitted row obtains a fresh host observation.
    admittedTargets.clear()
    if (!this.runtime.validArchitect(target) || target.id !== plan.owner) {
      // Admitted is not consumed. Prove consumption in the original session
      // before transferring an otherwise-current notice to its replacement.
      const priorOwnership = this.ownership(message)
      let priorObservation: string
      try {
        priorObservation = await this.outcomeObservation(
          message,
          message.session_id,
          priorOwnership,
        )
      } catch (error) {
        priorObservation = `unavailable: ${errorText(error)}`
      }
      if (priorObservation === "consumed") {
        this.outcomeState(
          message,
          [message.state],
          "consumed",
          { kind: "transcript-observed-before-owner-transfer" },
          "OUTCOME_CONSUMED",
          fence,
        )
        this.runtime.wakeRecoveredArchitect(plan.id)
        return
      }
      let safeToRetarget = message.state === "pending"
      if (!safeToRetarget && priorObservation === "queued" && this.runtime.host.cancelOutcome) {
        try {
          const originalOwnership =
            priorOwnership ?? this.createOwnership(message, message.session_id)
          await this.runtime.host.cancelOutcome({
            sessionID: message.session_id,
            inboxID: message.message_id,
            ownership: originalOwnership,
          })
          const afterCancellation = await this.outcomeObservation(
            message,
            message.session_id,
            originalOwnership,
          )
          if (afterCancellation === "consumed") {
            this.outcomeState(
              message,
              [message.state],
              "consumed",
              { kind: "cancellation-raced-with-consumption" },
              "OUTCOME_CANCEL_RACED_WITH_CONSUMPTION",
              fence,
            )
            this.runtime.wakeRecoveredArchitect(plan.id)
            return
          }
          safeToRetarget = afterCancellation === "missing"
          if (safeToRetarget) priorObservation = "cancelled-confirmed-by-inbox-and-history-readback"
        } catch (error) {
          priorObservation = `cancellation-unconfirmed: ${errorText(error)}`
        }
      }
      if (!safeToRetarget) {
        this.outcomeState(
          message,
          [message.state],
          priorObservation === "missing" || priorObservation === "unowned"
            ? "unknown"
            : message.state,
          {
            kind: "owner-changed-with-original-delivery-unresolved",
            priorSessionID: message.session_id,
            priorMessageID: message.message_id,
            priorObservation,
          },
          "OUTCOME_OWNER_TRANSFER_UNCERTAIN",
          fence,
        )
        this.runtime.wakeRecoveredArchitect(plan.id)
        return
      }
      const owner = await this.runtime.ensureArchitectOwner(plan, target)
      // Native message IDs are global. Never reuse an admitted/uncertain ID in
      // another session; persist the replacement identity before host admission.
      const replacementID = messageID()
      const nextOwnership = {
        ...(priorOwnership ?? this.createOwnership(message, message.session_id)),
        lazersSessionID: owner.id,
        lazersMessageID: replacementID,
      }
      if (
        !this.runtime.store.retargetOutbox({
          id: message.id,
          expectedState: message.state,
          sessionID: owner.id,
          messageID: replacementID,
          metadata: JSON.stringify(nextOwnership),
          receipt: {
            kind: "owner-retargeted-current-outcome",
            fromSessionID: message.session_id,
            toSessionID: owner.id,
            previousMessageID: message.message_id,
            replacementMessageID: replacementID,
            priorOwnership: priorOwnership ?? null,
            priorObservation,
            priorDeliveryState: message.state,
          },
        })
      )
        return
      message = {
        ...message,
        state: "pending",
        session_id: owner.id,
        message_id: replacementID,
        metadata: JSON.stringify(nextOwnership),
      }
      target = owner
    }
    if (!this.runtime.validArchitect(target)) return
    if (message.state === "admitted") return

    if (payload.status === "architect-source-change") {
      const sourceSessionID = payload.sourceSessionID
      const current =
        typeof sourceSessionID === "string"
          ? this.runtime.store.architectSourceNoticeContext({
              planID: message.plan_id,
              sourceSessionID,
              expectedOwner: plan.owner,
              expectedPlanVersion: plan.version,
            })
          : null
      if (
        !current?.targets.some(
          (entry) => entry.owner === message.session_id && entry.planIDs.includes(message.plan_id),
        )
      )
        return
    }

    const ownership = this.ownership(message)
    let observation: "queued" | "consumed" | "missing" | "unowned"
    try {
      observation = await this.outcomeObservation(message, target.id, ownership)
    } catch (error) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        { kind: "native-observation-unavailable", error: errorText(error) },
        "OUTCOME_OBSERVATION_UNAVAILABLE",
        fence,
      )
      return
    }
    if (observation === "queued") {
      this.outcomeState(
        message,
        [message.state],
        "admitted",
        { kind: "native-inbox-observed", consumption: "unknown" },
        "OUTCOME_HOST_ADMITTED",
        fence,
      )
      return
    }
    if (observation === "consumed") {
      this.outcomeState(
        message,
        [message.state],
        "consumed",
        { kind: "transcript-observed" },
        "OUTCOME_CONSUMED",
        fence,
      )
      return
    }
    if (observation === "unowned") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "native-input-identity-conflict" },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return
    }
    if (
      !this.outcomeState(
        message,
        ["pending", "sending", "uncertain", "delivered"],
        "sending",
        { kind: "native-admission-in-progress" },
        "OUTCOME_SEND_STARTED",
        fence,
      )
    )
      return
    try {
      await this.runtime.host.notify({
        sessionID: target.id,
        id: message.message_id,
        text: outcomeText(message.payload),
        resume: Boolean(message.resume),
        ...(ownership ? { metadata: ownership } : {}),
      })
      this.outcomeState(
        message,
        ["sending"],
        "admitted",
        { kind: "host-admitted", consumption: "unknown", sessionID: target.id },
        "OUTCOME_HOST_ADMITTED",
        fence,
      )
    } catch (error) {
      this.outcomeState(
        message,
        ["pending", "sending", "uncertain", "delivered"],
        "uncertain",
        { kind: "native-delivery-uncertain", error: errorText(error) },
        "OUTCOME_DELIVERY_UNCERTAIN",
        fence,
      )
    }
  }

  async deliver(fence: number, closeoutOnly = false) {
    const messages = this.runtime.store.outboxForDelivery(this.runtime.directory)
    const groups = new Map<string, OutboxRow[]>()
    for (const message of messages) {
      const group = groups.get(message.plan_id) ?? []
      group.push(message)
      groups.set(message.plan_id, group)
    }
    for (const group of groups.values()) {
      const ordered = group.toSorted((a, b) => a.version - b.version || a.sequence - b.sequence)
      if (closeoutOnly) {
        const latest = ordered.at(-1)!
        if (
          !["pending", "sending", "uncertain", "delivered"].includes(latest.state) ||
          !["accepted", "task-accepted", "cleanup-blocked"].includes(
            JSON.parse(latest.payload).status,
          )
        )
          continue
      }
      if (this.runtime.store.architectRenewalBlocksDelivery(ordered[0]!.plan_id)) continue
      const plan = this.runtime.store.plan(ordered[0]!.plan_id)
      if (!plan) continue
      await this.runtime.reconcilePlan(plan.id, fence, "delivery", async () => {
        const ready = new Map<string, boolean>()
        const current = new Map<string, OutboxRow>()
        for (const [index, message] of ordered.entries()) {
          const older = JSON.parse(message.payload)
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
            older.status === "architect-source-reference" ||
            older.status === "architect-source-change" ||
            older.status === "queue-review" ||
            older.status === "retained-verification-held"
              ? undefined
              : ordered.slice(index + 1).findLast((candidate) => {
                  const next = JSON.parse(candidate.payload)
                  if (
                    next.status === "architect-handoff" ||
                    next.status === "architect-source-reference" ||
                    next.status === "architect-source-change" ||
                    next.status === "queue-review" ||
                    next.status === "retained-verification-held"
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
          if (replacement) {
            const ok = await this.supersedeOutcome(message, replacement, plan, fence)
            ready.set(replacement.id, (ready.get(replacement.id) ?? true) && ok)
          } else current.set(message.id, message)
        }
        const admittedTargets = new Map<string, HostSession>()
        for (const message of current.values())
          if (ready.get(message.id) !== false)
            await this.deliverCurrent(message, fence, admittedTargets)
      })
    }
  }
}

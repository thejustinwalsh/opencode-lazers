import { messageID, errorText } from "./runtime-helpers.ts"
import { sameNativeModel } from "./model-route.ts"
import { fingerprint } from "../identity.ts"
import type { HostSession } from "./host.ts"
import { ArchitectContinuityInput, PlanInput } from "./schema.ts"
import type { PlanRow, ArchitectRenewalRow } from "./store.ts"
import { RENEWAL_SUCCESSOR_FOREIGN } from "./store.ts"
import { outcomeText } from "./outcome.ts"
import type { OutcomeOwnership } from "./inbox.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { ArchitectSources } from "./architect-sources.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What the renewal module reads from the coordinator and its sibling modules. */
export type ArchitectRenewalDeps = {
  architectPromptHook: boolean
  ownership: {
    validArchitect: ArchitectOwnership["validArchitect"]
    architectRoute: ArchitectOwnership["architectRoute"]
    architectSessionModel: ArchitectOwnership["architectSessionModel"]
    architectWaitingForHuman: ArchitectOwnership["architectWaitingForHuman"]
    sessionTitle: ArchitectOwnership["sessionTitle"]
  }
  sources: {
    inspectArchitectSourcePage: ArchitectSources["inspectArchitectSourcePage"]
    inspectArchitectSourceSweep: ArchitectSources["inspectArchitectSourceSweep"]
  }
}

/**
 * Architect session renewal: the successor handshake, continuity carried across the switch, and
 * the per-key renewal lock. Moved out of `TaskRuntime` without rewriting; the private aliases
 * below keep the member bodies identical to what they were. Every call into a sibling module
 * is a lazy arrow, so the coordinator can build the modules in any order.
 */
export class ArchitectRenewal {
  private readonly architectPromptHook: boolean
  private readonly validArchitect: ArchitectOwnership["validArchitect"]
  private readonly architectRoute: ArchitectOwnership["architectRoute"]
  private readonly architectSessionModel: ArchitectOwnership["architectSessionModel"]
  private readonly architectWaitingForHuman: ArchitectOwnership["architectWaitingForHuman"]
  private readonly sessionTitle: ArchitectOwnership["sessionTitle"]
  private readonly inspectArchitectSourcePage: ArchitectSources["inspectArchitectSourcePage"]
  private readonly inspectArchitectSourceSweep: ArchitectSources["inspectArchitectSourceSweep"]

  constructor(
    private readonly core: RuntimeCore,
    deps: ArchitectRenewalDeps,
  ) {
    this.architectPromptHook = deps.architectPromptHook
    this.validArchitect = (session): session is HostSession =>
      deps.ownership.validArchitect(session)
    this.architectRoute = (...args) => deps.ownership.architectRoute(...args)
    this.architectSessionModel = (...args) => deps.ownership.architectSessionModel(...args)
    this.architectWaitingForHuman = (...args) => deps.ownership.architectWaitingForHuman(...args)
    this.sessionTitle = (...args) => deps.ownership.sessionTitle(...args)
    this.inspectArchitectSourcePage = (...args) => deps.sources.inspectArchitectSourcePage(...args)
    this.inspectArchitectSourceSweep = (...args) =>
      deps.sources.inspectArchitectSourceSweep(...args)
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

  private get projectID() {
    return this.core.projectID
  }

  private get directory() {
    return this.core.directory
  }

  private get now() {
    return this.core.now
  }

  private readonly renewalLocks = new Map<string, Promise<void>>()
  async withRenewalLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.renewalLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => (release = resolve))
    this.renewalLocks.set(key, current)
    await previous
    try {
      return await run()
    } finally {
      release()
      if (this.renewalLocks.get(key) === current) this.renewalLocks.delete(key)
    }
  }
  async restorePredecessorForInput(renewal: ArchitectRenewalRow, fence?: number) {
    if (!this.host.updateSession)
      throw new Error(
        "Cannot preserve input during Architect renewal: native session update is unavailable",
      )
    const predecessor = await this.host.session(renewal.previous_session_id)
    if (!predecessor)
      throw new Error(
        "Cannot preserve input during Architect renewal: predecessor session is unavailable",
      )
    if (predecessor.archived) {
      await this.host.updateSession({ sessionID: predecessor.id, archived: false })
      const restored = await this.host.session(predecessor.id)
      if (!restored || restored.archived)
        throw new Error(
          "Cannot preserve input during Architect renewal: predecessor did not unarchive",
        )
    }
    if (fence !== undefined) {
      const changed = this.store.rollbackArchitectRenewal(
        this.owner,
        fence,
        renewal.id,
        "deferred",
        null,
      )
      if (!changed) {
        const current = this.store.architectRenewal(renewal.id)
        if (current && ["archiving", "recovering-input", "rolling-back"].includes(current.state))
          throw new Error(
            "Cannot preserve input during Architect renewal: ownership rollback was not recorded",
          )
      }
    }
  }
  renewalSuccessorMatches(
    session: HostSession | null,
    renewal: ArchitectRenewalRow,
    allowArchived = false,
  ) {
    const model = JSON.parse(renewal.model) as NonNullable<HostSession["model"]>
    const planIDs = this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id)
    const metadataPlanIDs = session?.metadata?.lazersPlanIDs
    // Metadata is the identity snapshot taken when native creation began. Later
    // plans may be admitted to the predecessor while creation is in flight; the
    // durable transfer attaches those plans without changing successor identity.
    const anchorIdentity =
      session?.metadata?.lazersPlanID === renewal.anchor_plan_id &&
      (!Array.isArray(metadataPlanIDs) ||
        (metadataPlanIDs.includes(renewal.anchor_plan_id) &&
          metadataPlanIDs.every((id) => planIDs.includes(String(id)))))
    return Boolean(
      session &&
      (allowArchived || !session.archived) &&
      session.agent === "architect" &&
      session.id === renewal.successor_session_id &&
      session.projectID === this.projectID &&
      session.directory === renewal.directory &&
      (session.parentID === undefined || session.parentID === renewal.previous_session_id) &&
      sameNativeModel(session.model, model) &&
      session.metadata?.lazersContinuation === true &&
      session.metadata.lazersSourceSessionID === renewal.previous_session_id &&
      anchorIdentity,
    )
  }
  renewalLabel(renewal: ArchitectRenewalRow) {
    const plan = this.store.plan(renewal.anchor_plan_id)
    if (!plan) return `Continue LAZERS plan ${renewal.anchor_plan_id.slice(0, 8)}`
    const input = PlanInput.parse(JSON.parse(plan.body))
    return input.title ?? input.objective.slice(0, 120)
  }
  renewalContinuity(renewal: ArchitectRenewalRow) {
    if (!renewal.continuity_json)
      throw new Error("Architect renewal has no explicit continuity checkpoint")
    const parsed = JSON.parse(renewal.continuity_json) as { revision?: unknown }
    const content = ArchitectContinuityInput.parse({
      decisions: (parsed as Record<string, unknown>).decisions,
      unresolvedQuestions: (parsed as Record<string, unknown>).unresolvedQuestions,
    })
    if (typeof parsed.revision !== "number" || !Number.isSafeInteger(parsed.revision))
      throw new Error("Architect continuity checkpoint revision is invalid")
    return { revision: parsed.revision, ...content }
  }
  renewalContinuityCoverage(renewal: ArchitectRenewalRow) {
    const coverage = this.store.architectRenewalCoverageEvidence(renewal.id)
    if (!coverage) throw new Error("Architect renewal continuity coverage is unavailable")
    return {
      revision: coverage.revision,
      inputCount: coverage.inputCount,
      inputFingerprint: coverage.inputFingerprint,
    }
  }
  renewalWakeContext(renewal: ArchitectRenewalRow, payload: unknown) {
    const text = outcomeText(JSON.stringify(payload), this.store.repository.projectCode())
    return {
      bytes: new TextEncoder().encode(text).byteLength,
      tokens: null,
      tokenProvenance:
        "unknown: OpenCode exposes session-cumulative token counts, not a message-level count for this wake",
      cache: {
        uncachedInput: null,
        read: null,
        write: null,
        provenance:
          "unknown until the native successor reports a public session usage snapshot; no cache hit or savings are inferred",
      },
      sessionID: renewal.successor_session_id,
      sessionUsageProvenance: "OpenCode 2.2.5 session.get cumulative snapshot, not wake-attributed",
    }
  }
  renewalEvent(renewal: ArchitectRenewalRow, event: string, payload: unknown, fence: number) {
    this.store.fenced(this.owner, fence, () =>
      this.store.record(renewal.anchor_plan_id, null, event, payload),
    )
  }
  renewalIssue(
    renewal: ArchitectRenewalRow,
    event: string,
    error: string,
    payload: Record<string, unknown>,
    fence: number,
  ) {
    this.store.setArchitectRenewalState(
      this.owner,
      fence,
      renewal.id,
      [renewal.state],
      renewal.state,
      error,
    )
    this.renewalEvent(renewal, event, { renewalID: renewal.id, error, ...payload }, fence)
  }
  async considerArchitectRenewal(plan: PlanRow, owner: HostSession, fence: number) {
    if (
      this.store.architectContactPaused() ||
      !this.architectPromptHook ||
      !this.host.updateSession ||
      !this.host.architectInputPage ||
      owner.idleAt === undefined ||
      owner.busy ||
      this.architectWaitingForHuman(owner) ||
      !owner.model ||
      this.architectRoute(owner).action !== "fresh"
    )
      return false
    if (!this.store.hasArchitectContinuity(owner.id)) return false
    const labelPlan = PlanInput.parse(JSON.parse(plan.body))
    const label = labelPlan.title ?? labelPlan.objective.slice(0, 120)
    const renewal = this.store.beginArchitectRenewal({
      schedulerOwner: this.owner,
      fence,
      anchorPlanID: plan.id,
      previousSessionID: owner.id,
      directory: owner.directory,
      model: JSON.stringify(this.architectSessionModel(owner.model)),
      idleAt: owner.idleAt,
      now: this.now(),
      handoffMessageID: messageID(),
    })
    if (!renewal) return false
    await this.continueArchitectRenewal(renewal, fence, label)
    return true
  }
  async continueArchitectRenewal(initial: ArchitectRenewalRow, fence: number, knownLabel?: string) {
    // While Architect contact is paused no renewal may create, archive or resume a session.
    if (this.store.architectContactPaused()) return
    try {
      return await this.withRenewalLock(initial.id, async () => {
        let renewal = this.store.architectRenewal(initial.id)
        if (!renewal) return
        if (
          !this.architectPromptHook ||
          !this.host.updateSession ||
          !this.host.architectInputPage
        ) {
          const reason = "Native Architect source reconciliation or archival is unavailable"
          if (renewal.state === "creating") {
            this.store.setArchitectRenewalState(
              this.owner,
              fence,
              renewal.id,
              ["creating"],
              "deferred",
              reason,
            )
            this.renewalEvent(
              renewal,
              "ARCHITECT_RENEWAL_DEFERRED",
              { renewalID: renewal.id, reason },
              fence,
            )
            return
          }
          if (renewal.state === "archiving") {
            this.renewalIssue(renewal, "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN", reason, {}, fence)
            return
          }
        }
        if (["recovering-input", "rolling-back"].includes(renewal.state)) {
          await this.restorePredecessorForInput(renewal, fence)
          return
        }
        if (renewal.state === "committed" || renewal.state === "deferred") return
        if (!renewal.continuity_json) {
          if (renewal.state === "creating") {
            this.store.setArchitectRenewalState(
              this.owner,
              fence,
              renewal.id,
              ["creating"],
              "deferred",
              "No explicit Architect decisions/questions checkpoint was recorded",
            )
            this.renewalEvent(
              renewal,
              "ARCHITECT_RENEWAL_DEFERRED",
              {
                renewalID: renewal.id,
                reason: "No explicit Architect decisions/questions checkpoint was recorded",
              },
              fence,
            )
            return
          }
          if (renewal.state === "archiving") {
            this.renewalIssue(
              renewal,
              "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
              "No explicit Architect decisions/questions checkpoint was recorded",
              {},
              fence,
            )
            return
          }
        }
        if (renewal.state === "creating") {
          // Fail unavailable/foreign successor reads before scanning all source
          // history. Re-read after the sweep below; this is not a cached proof.
          const available = await this.host.session(renewal.successor_session_id)
          if (available && !this.renewalSuccessorMatches(available, renewal))
            return this.deferForeignSuccessor(renewal, fence)
          // A checkpoint is only safe to transfer after its complete current history
          // sweep has been journaled and checked for uncovered user input.
          await this.inspectArchitectSourceSweep(renewal, fence)
          renewal = this.store.architectRenewal(renewal.id)!
          if (renewal.state !== "creating") return
          let successor = await this.host.session(renewal.successor_session_id)
          if (successor && !this.renewalSuccessorMatches(successor, renewal))
            return this.deferForeignSuccessor(renewal, fence)
          if (!successor) {
            const predecessor = await this.host.session(renewal.previous_session_id)
            if (predecessor && this.architectWaitingForHuman(predecessor)) {
              this.store.setArchitectRenewalState(
                this.owner,
                fence,
                renewal.id,
                ["creating"],
                "deferred",
                "Predecessor is waiting for human input",
              )
              return
            }
            const planIDs = this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id)
            await this.host
              .createArchitect({
                id: renewal.successor_session_id,
                directory: renewal.directory,
                model: JSON.parse(renewal.model),
                title: this.sessionTitle(knownLabel ?? this.renewalLabel(renewal)),
                planID: renewal.anchor_plan_id,
                planIDs,
                sourceSessionID: renewal.previous_session_id,
              })
              .catch(async (error) => {
                const recovered = await this.host.session(renewal!.successor_session_id)
                if (!this.renewalSuccessorMatches(recovered, renewal!)) throw error
                successor = recovered
              })
            successor ??= await this.host.session(renewal.successor_session_id)
          }
          if (successor && !this.renewalSuccessorMatches(successor, renewal))
            return this.deferForeignSuccessor(renewal, fence)
          if (!this.renewalSuccessorMatches(successor, renewal))
            throw new Error("Native Architect renewal is unavailable or foreign")
          renewal = this.store.architectRenewal(renewal.id)!
          if (renewal.state !== "creating") return
          // Repeat the complete sweep after successor creation to include inputs
          // observed while the native create call was in flight, before transfer.
          await this.inspectArchitectSourceSweep(renewal, fence)
          renewal = this.store.architectRenewal(renewal.id)!
          if (renewal.state !== "creating") return

          const predecessor = await this.host.session(renewal.previous_session_id)
          const tooRecent =
            predecessor?.idleAt === undefined || this.architectRoute(predecessor).action !== "fresh"
          if (
            !this.validArchitect(predecessor) ||
            predecessor.busy ||
            this.architectWaitingForHuman(predecessor) ||
            tooRecent
          ) {
            this.store.setArchitectRenewalState(
              this.owner,
              fence,
              renewal.id,
              ["creating"],
              "deferred",
            )
            this.renewalEvent(
              renewal,
              "ARCHITECT_RENEWAL_DEFERRED",
              {
                renewalID: renewal.id,
                busy: predecessor?.busy ?? null,
              },
              fence,
            )
            return
          }

          const planIDs = this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id)
          const label = knownLabel ?? this.renewalLabel(renewal)
          const continuity = this.renewalContinuity(renewal)
          const anchor = this.store.plan(renewal.anchor_plan_id)
          if (!anchor) throw new Error("Architect renewal plan disappeared")
          const source = this.store.architectSourceHead(renewal.previous_session_id)
          if (!source) throw new Error("Architect predecessor source disappeared before handoff")
          const payload = {
            status: "architect-handoff",
            planID: renewal.anchor_plan_id,
            version: anchor.version + 1,
            planIDs,
            label,
            continuity,
            continuityCoverage: this.renewalContinuityCoverage(renewal),
            predecessorSessionID: renewal.previous_session_id,
            successorSessionID: renewal.successor_session_id,
            sourceRevision: source?.revision ?? 0,
            sourceCoverage: {
              sourceSessionID: renewal.previous_session_id,
              cursor: source?.scan_cursor ?? null,
              complete: (source?.scan_sweep ?? 0) > 0 && source?.scan_cursor === null,
            },
          }
          const outboxID = fingerprint({
            kind: "architect-handoff",
            renewalID: renewal.id,
            messageID: renewal.handoff_message_id,
          })
          const metadata: OutcomeOwnership = {
            lazersKind: "runner-outcome",
            lazersProjectID: this.projectID,
            lazersProjectDirectory: this.directory,
            lazersPlanID: renewal.anchor_plan_id,
            lazersOutboxID: outboxID,
            lazersMessageID: renewal.handoff_message_id,
            lazersSessionID: renewal.successor_session_id,
            lazersStatus: "architect-handoff",
            lazersVersion: anchor.version + 1,
          }
          if (
            !this.store.transferArchitectRenewal({
              schedulerOwner: this.owner,
              fence,
              renewalID: renewal.id,
              outboxID,
              payload: JSON.stringify(payload),
              metadata: JSON.stringify(metadata),
            })
          ) {
            renewal = this.store.architectRenewal(renewal.id)
            if (renewal?.state === "deferred") return
            throw new Error("Architect ownership transfer lost its durable compare-and-swap")
          }
          renewal = this.store.architectRenewal(renewal.id)!
        }

        if (renewal.state !== "archiving") return
        await this.inspectArchitectSourcePage(renewal, fence)
        renewal = this.store.architectRenewal(renewal.id)!
        if (renewal.state !== "archiving") return
        let successor: HostSession | null
        try {
          successor = await this.host.session(renewal.successor_session_id)
        } catch (error) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_SUCCESSOR_UNAVAILABLE",
            errorText(error),
            { successorSessionID: renewal.successor_session_id },
            fence,
          )
          return
        }
        if (!successor || !this.renewalSuccessorMatches(successor, renewal, true)) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_SUCCESSOR_UNAVAILABLE",
            "Durable Architect successor is missing or has a conflicting identity",
            { successorSessionID: renewal.successor_session_id },
            fence,
          )
          return
        }
        if (successor.archived) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_SUCCESSOR_UNAVAILABLE",
            "Durable Architect successor was archived before renewal recovery",
            { successorSessionID: renewal.successor_session_id },
            fence,
          )
          return
        }
        const predecessorBeforeArchive = await this.host.session(renewal.previous_session_id)
        if (!predecessorBeforeArchive) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            "Predecessor session is unavailable before archival",
            {},
            fence,
          )
          return
        }
        if (
          predecessorBeforeArchive.agent !== "architect" ||
          predecessorBeforeArchive.projectID !== this.projectID ||
          predecessorBeforeArchive.directory !== renewal.directory
        ) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            "Predecessor identity changed before archival",
            {},
            fence,
          )
          return
        }
        if (
          predecessorBeforeArchive.busy ||
          this.architectWaitingForHuman(predecessorBeforeArchive) ||
          predecessorBeforeArchive.idleAt === undefined ||
          this.architectRoute(predecessorBeforeArchive).action !== "fresh"
        ) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_DEFERRED",
            "Predecessor became busy, recent, or started waiting for human input before archival",
            { busy: predecessorBeforeArchive.busy, idleAt: predecessorBeforeArchive.idleAt },
            fence,
          )
          return
        }
        let archiveError: string | null = null
        if (!predecessorBeforeArchive.archived) {
          try {
            await this.host.updateSession!({
              sessionID: renewal.previous_session_id,
              archived: true,
            })
          } catch (error) {
            archiveError = errorText(error)
          }
        }

        let predecessor: HostSession | null
        try {
          predecessor = await this.host.session(renewal.previous_session_id)
        } catch (error) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            errorText(error),
            { archiveError },
            fence,
          )
          return
        }
        if (!predecessor) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            "Predecessor session is unavailable",
            { archiveError },
            fence,
          )
          return
        }
        if (!predecessor.archived) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            archiveError ?? "Native archive was not observed",
            { predecessorSessionID: renewal.previous_session_id },
            fence,
          )
          return
        }
        if (archiveError) {
          this.renewalEvent(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_RECONCILED",
            { renewalID: renewal.id, error: archiveError, archived: true },
            fence,
          )
        }
        try {
          await this.inspectArchitectSourcePage(renewal, fence)
        } catch (error) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_SOURCE_SCAN_FAILED",
            `Native inbox could not be verified after archival: ${errorText(error)}`,
            { sourceSessionID: renewal.previous_session_id },
            fence,
          )
          return
        }
        const source = this.store.architectSourceHead(renewal.previous_session_id)
        if (!source) throw new Error("Architect predecessor source disappeared before commit")
        const payload = {
          status: "architect-handoff",
          planID: renewal.anchor_plan_id,
          planIDs: this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id),
          label: knownLabel ?? this.renewalLabel(renewal),
          continuity: this.renewalContinuity(renewal),
          continuityCoverage: this.renewalContinuityCoverage(renewal),
          predecessorSessionID: renewal.previous_session_id,
          successorSessionID: renewal.successor_session_id,
          sourceRevision: source?.revision ?? 0,
          sourceCoverage: {
            sourceSessionID: renewal.previous_session_id,
            cursor: source?.scan_cursor ?? null,
            complete: source.scan_sweep > 0 && source.scan_cursor === null,
          },
        }
        const committed = this.store.finishArchitectRenewal(
          this.owner,
          fence,
          renewal.id,
          this.renewalWakeContext(renewal, payload),
        )
        if (!committed) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_COMMIT_UNCERTAIN",
            "Durable renewal commit was not confirmed after native archival",
            { predecessorSessionID: renewal.previous_session_id },
            fence,
          )
        }
      })
    } catch (error) {
      const current = this.store.architectRenewal(initial.id)
      if (
        current &&
        ["creating", "archiving", "recovering-input", "rolling-back"].includes(current.state)
      ) {
        const reason = errorText(error)
        const previous = this.store.latestTransition<{
          renewalID: string
          state: string
          error: string
        }>(current.anchor_plan_id, null, "ARCHITECT_RENEWAL_RECOVERY_FAILED")
        // Retry recovery normally, but an unchanged durable failure is not a new
        // observation. Publishing it on every tick rebuilds all watching panels.
        if (
          current.error !== reason ||
          previous?.renewalID !== current.id ||
          previous.state !== current.state ||
          previous.error !== reason
        ) {
          this.store.setArchitectRenewalState(
            this.owner,
            fence,
            current.id,
            [current.state],
            current.state,
            reason,
          )
          this.renewalEvent(
            current,
            "ARCHITECT_RENEWAL_RECOVERY_FAILED",
            { renewalID: current.id, state: current.state, error: reason },
            fence,
          )
        }
      }
      throw error
    }
  }
  /**
   * A successor that exists under the renewal's ID but is not the session it asked for never
   * becomes it: its identity does not change between ticks. The renewal defers once, the
   * predecessor keeps its plans, and the deferred row is not retried onto that session.
   */
  deferForeignSuccessor(renewal: ArchitectRenewalRow, fence: number) {
    if (
      !this.store.setArchitectRenewalState(
        this.owner,
        fence,
        renewal.id,
        ["creating"],
        "deferred",
        RENEWAL_SUCCESSOR_FOREIGN,
      )
    )
      return
    this.renewalEvent(
      renewal,
      "ARCHITECT_RENEWAL_DEFERRED",
      { renewalID: renewal.id, reason: RENEWAL_SUCCESSOR_FOREIGN },
      fence,
    )
  }
}

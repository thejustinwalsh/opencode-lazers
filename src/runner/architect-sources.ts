import { errorText } from "./runtime-helpers.ts"
import { NoCapabilityProviderError } from "../core/capabilities.ts"
import { ArchitectContinuityInput } from "./schema.ts"
import { SourceMessagesInspectPlanSchema } from "./inspection.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"

import type { RuntimeCore } from "./runtime-core.ts"
import type { ArchitectRenewalRow } from "./store.ts"

/** What the sources module reads from the coordinator and its sibling modules. */
export type ArchitectSourcesDeps = {
  isStopped: () => boolean
  ownership: { validArchitect: ArchitectOwnership["validArchitect"] }
  renewalEvent: (
    renewal: ArchitectRenewalRow,
    event: string,
    payload: unknown,
    fence: number,
  ) => void
}

/**
 * The Architect source sessions the runner watches: prompt and event observation, invalidation,
 * continuity records, and the source scan. Owns the epoch, resync and failure state. Moved out
 * of `TaskRuntime` without rewriting; the private aliases below keep the member bodies identical.
 */
export class ArchitectSources {
  private readonly validArchitect: ArchitectOwnership["validArchitect"]
  private readonly renewalEvent: ArchitectSourcesDeps["renewalEvent"]
  private readonly isStopped: () => boolean

  constructor(
    private readonly core: RuntimeCore,
    deps: ArchitectSourcesDeps,
  ) {
    this.validArchitect = deps.ownership.validArchitect.bind(deps.ownership)
    this.renewalEvent = (...args) => deps.renewalEvent(...args)
    this.isStopped = () => deps.isStopped()
    // Seeded last, as the coordinator's constructor did, once the rest is wired.
    for (const id of core.store.architectSourceSessionIDs()) this.sourceEpochs.set(id, 0)
  }

  private get stopped() {
    return this.isStopped()
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

  private get now() {
    return this.core.now
  }

  private readonly sourceEpochs = new Map<string, number>()
  sourceResyncPending = false
  /** Called by the native prompt hook before OpenCode admits the input to its inbox. */
  async observeArchitectPrompt(sessionID: string, nativeMessageID: string) {
    const observed = this.store.observeArchitectInput(sessionID, nativeMessageID, this.now(), {
      type: "user",
      disposition: "prompt",
      userPrompt: true,
    })
    if (observed.role === "predecessor") {
      this.sourceEpochs.set(sessionID, (this.sourceEpochs.get(sessionID) ?? 0) + 1)
      this.store.invalidateArchitectSource(sessionID, this.now())
    }
  }
  private readonly sourceInvalidations = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; dirty: boolean }
  >()
  /**
   * Called for every native event. O(1) for sessions that are not Architect
   * sources; for sources the epoch bumps in memory at once and the durable
   * invalidation is coalesced (250ms) off the event path.
   */
  observeArchitectSourceEvent(sessionID?: string) {
    if (sessionID) {
      if (!this.sourceEpochs.has(sessionID)) return
      this.scheduleSourceInvalidation(sessionID)
      return
    }
    this.sourceResyncPending = true
    for (const id of this.store.architectSourceSessionIDs())
      if (!this.sourceEpochs.has(id)) this.sourceEpochs.set(id, 0)
    for (const id of [...this.sourceEpochs.keys()]) this.scheduleSourceInvalidation(id)
    this.sourceResyncPending = false
  }
  /** Leading edge writes at once; further events in the 250ms window coalesce into one trailing write. */
  scheduleSourceInvalidation(sessionID: string) {
    this.sourceEpochs.set(sessionID, (this.sourceEpochs.get(sessionID) ?? 0) + 1)
    const pending = this.sourceInvalidations.get(sessionID)
    if (pending) {
      pending.dirty = true
      return
    }
    this.store.invalidateArchitectSource(sessionID, this.now())
    const entry = {
      dirty: false,
      timer: setTimeout(() => {
        this.sourceInvalidations.delete(sessionID)
        if (!entry.dirty) return
        try {
          this.store.invalidateArchitectSource(sessionID, this.now())
        } catch {
          // The next event or tick re-requests the invalidation.
        }
      }, 250),
    }
    entry.timer.unref?.()
    this.sourceInvalidations.set(sessionID, entry)
  }
  /** Apply pending coalesced invalidations before a decision reads source state. */
  assertSchedulerActive() {
    if (this.stopped) throw new Error("Scheduler registration was disposed")
  }
  flushSourceInvalidations() {
    for (const [id, entry] of [...this.sourceInvalidations]) {
      if (!entry.dirty) continue
      entry.dirty = false
      this.store.invalidateArchitectSource(id, this.now())
    }
  }
  async recordArchitectContinuity(sessionID: string, input: unknown) {
    const continuity = ArchitectContinuityInput.parse(input)
    const session = await this.host.session(sessionID)
    if (!this.validArchitect(session))
      throw new Error("Architect continuity can only be recorded by the current active Architect")
    if (!this.host.architectInputPage)
      throw new Error("Architect continuity requires public input/history coverage")
    const coverageInputs: Array<{ id: string; type: string; metadata?: Record<string, unknown> }> =
      []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const page = await this.host.architectInputPage(sessionID, cursor)
      coverageInputs.push(...page.inbox, ...page.messages)
      if (!page.nextCursor) break
      if (seenCursors.has(page.nextCursor))
        throw new Error("Architect continuity history pagination did not advance")
      seenCursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
    const saved = this.store.saveArchitectContinuity({
      sessionID,
      decisions: continuity.decisions,
      unresolvedQuestions: continuity.unresolvedQuestions,
      coverageInputs,
      now: this.now(),
    })
    return {
      status: "recorded",
      sessionID,
      revision: saved.revision,
      decisionCount: continuity.decisions.length,
      unresolvedQuestionCount: continuity.unresolvedQuestions.length,
    }
  }
  async inspectArchitectSourceMessages(rawInput: unknown, caller: string) {
    const input = SourceMessagesInspectPlanSchema.parse(rawInput)
    const plan = this.store.plan(input.planID)
    if (!plan || plan.owner !== caller)
      throw new Error("Selected source-message retrieval requires the current plan owner")
    const owner = await this.host.session(caller)
    if (!this.validArchitect(owner))
      throw new Error("Selected source-message retrieval requires the active Architect owner")
    if (!this.host.architectSourceMessage)
      throw new Error("Authenticated native source-message retrieval is unavailable")
    const references = this.store.architectSourceMessageReferences(
      input.planID,
      input.sourceSessionID,
      input.messageIDs,
    )
    if (references.length !== input.messageIDs.length)
      throw new Error("Every selected message ID must identify a journaled source input or result")
    const messages = []
    for (const reference of references) {
      const message = await this.host.architectSourceMessage(
        input.sourceSessionID,
        reference.messageID,
      )
      if (message.id !== reference.messageID || message.type !== reference.type)
        throw new Error("Native source-message identity or journal type changed during retrieval")
      messages.push({ ...message, kind: reference.kind })
    }
    const current = this.store.plan(input.planID)
    if (!current || current.owner !== caller || current.version !== plan.version)
      throw new Error("Plan owner or version changed during selected source-message retrieval")
    return {
      mode: "source-messages" as const,
      planID: input.planID,
      sourceSessionID: input.sourceSessionID,
      selected: messages.length,
      coverage: {
        authenticatedNativeRead: true,
        privacyFiltered: true,
        metadataAndAttachmentsOmitted: true,
        transcriptCompleteness: "unknown" as const,
        nativeConsumption: "unknown" as const,
      },
      messages,
    }
  }
  async inspectArchitectSourcePage(renewal: ArchitectRenewalRow, fence: number) {
    if (!this.host.architectInputPage)
      throw new Error("Native Architect input/history observation is unavailable")
    this.flushSourceInvalidations()
    const source = this.store.architectSource(renewal.previous_session_id)
    if (!source) throw new Error("Durable Architect predecessor source is unavailable")
    if (!this.sourceEpochs.has(source.session_id)) this.sourceEpochs.set(source.session_id, 0)
    const epoch = this.sourceEpochs.get(source.session_id)
    let known: import("./host.ts").ArchitectSourceObservation | undefined
    try {
      if (source.scan_complete_at !== null && source.observation_json !== null)
        known = JSON.parse(source.observation_json)
    } catch {
      // A damaged cache hint requests a fresh scan; retained history remains usable.
    }
    const page = await this.host.architectInputPage(
      renewal.previous_session_id,
      source.scan_cursor ?? undefined,
      known,
    )
    const result = this.store.recordArchitectSourcePage({
      schedulerOwner: this.owner,
      fence,
      sessionID: renewal.previous_session_id,
      cursor: source.scan_cursor,
      nextCursor: page.nextCursor,
      inbox: page.inbox,
      messages: page.messages,
      now: this.now(),
      projectID: this.projectID,
      ...(page.observation ? { observation: page.observation } : {}),
      unchanged: page.unchanged,
      cacheCurrent: epoch === this.sourceEpochs.get(source.session_id),
    })
    if (!result) throw new Error("Architect predecessor source changed during reconciliation")
    if (result.changedInputs.length)
      this.renewalEvent(
        renewal,
        "ARCHITECT_RENEWAL_NATIVE_INPUT_OBSERVED",
        {
          renewalID: renewal.id,
          sourceRevision: result.revision,
          inputs: result.changedInputs,
          nextCursor: result.nextCursor,
        },
        fence,
      )
    if (result.changedResults.length)
      this.renewalEvent(
        renewal,
        "ARCHITECT_RENEWAL_SOURCE_RESULT_OBSERVED",
        {
          renewalID: renewal.id,
          sourceRevision: result.revision,
          results: result.changedResults,
          nextCursor: result.nextCursor,
        },
        fence,
      )
    if (
      result.nextCursor === null &&
      epoch === this.sourceEpochs.get(source.session_id) &&
      this.store.architectRenewal(renewal.id)?.state === "committed"
    ) {
      const archived = page.archived ?? (await this.host.session(source.session_id))?.archived
      if (archived === true && epoch === this.sourceEpochs.get(source.session_id))
        this.store.retireArchitectSource(source.session_id, this.owner, fence, this.now())
    }
    return result
  }
  async inspectArchitectSourceSweep(renewal: ArchitectRenewalRow, fence: number) {
    const requestedCursors = new Set<string>()
    for (;;) {
      const source = this.store.architectSource(renewal.previous_session_id)
      if (!source) throw new Error("Durable Architect predecessor source is unavailable")
      const cursor = source.scan_cursor
      if (cursor !== null) {
        if (requestedCursors.has(cursor))
          throw new Error("Native Architect input/history pagination did not advance")
        requestedCursors.add(cursor)
      }
      try {
        const result = await this.inspectArchitectSourcePage(renewal, fence)
        if (result.nextCursor === null) return
        if (result.nextCursor === cursor || requestedCursors.has(result.nextCursor))
          throw new Error("Native Architect input/history pagination did not advance")
      } catch (error) {
        // A prompt hook can defer preparation between the page read and its journal
        // write. That expected state change ends the sweep without masking read errors.
        if (this.store.architectRenewal(renewal.id)?.state !== "creating") return
        throw error
      }
    }
  }
  private readonly sourceScanFailures = new Map<string, string>()
  async reconcileArchitectSources(fence: number) {
    if (!this.host.architectInputPage) return
    for (const source of this.store.architectSources()) {
      const renewal = this.store.architectRenewal(source.renewal_id)
      if (!renewal) continue
      try {
        await this.inspectArchitectSourcePage(renewal, fence)
        this.sourceScanFailures.delete(source.session_id)
      } catch (error) {
        // No live location is the plugin booting or reloading, not a property of the
        // source: retry on the next tick and record nothing.
        if (error instanceof NoCapabilityProviderError) continue
        const cause = errorText(error)
        if (this.sourceScanFailures.get(source.session_id) === cause) continue
        this.sourceScanFailures.set(source.session_id, cause)
        // A persistent failure is one durable fact, not one row per tick or per process
        // start: record only when the cause differs from this source's newest failure.
        this.store.fenced(this.owner, fence, () =>
          this.store.recordSourceScanFailure(renewal.anchor_plan_id, {
            renewalID: renewal.id,
            sourceSessionID: source.session_id,
            error: cause,
          }),
        )
      }
    }
  }
}

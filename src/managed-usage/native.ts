import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { isWorkerAgent } from "../runner/worker-agent.ts"
import type { ManagedUsageNativeFact } from "./contract.ts"
import {
  managedUsageEventSequence,
  managedUsageEventSessionID,
  managedUsageEventType,
  managedUsageFactFromEvent,
  nativeObject,
} from "./native-facts.ts"
import {
  managedUsageEventLocation,
  managedUsageLocation,
  managedUsageLocationKey,
  sameManagedUsageLocation,
} from "./native-location.ts"
import type { ManagedUsageLocation } from "./native-location.ts"
import { ManagedUsageStore } from "./store.ts"

export type ManagedUsageNativeContext = Pick<Plugin.Context, "event" | "session" | "location">

const MAX_BUFFERED_ENROLLMENT_FACTS = 1_000
const MAX_IN_FLIGHT_OBSERVATIONS = 1_000

export const managedUsageEventFact = managedUsageFactFromEvent

type PendingEnrollment = {
  tokens: Set<symbol>
  facts: ManagedUsageNativeFact[]
  unidentifiedEvent: boolean
  unsequencedEvent: boolean
  overflow: boolean
}

function appendBufferedFacts(
  store: ManagedUsageStore,
  facts: readonly ManagedUsageNativeFact[],
  boundarySequence: number | null,
) {
  for (const fact of facts) {
    if (fact.sequence === null || fact.sequence > (boundarySequence ?? -1)) store.appendFact(fact)
  }
}

function recordPendingGaps(store: ManagedUsageStore, sessionID: string, state: PendingEnrollment) {
  const gaps = [
    state.unidentifiedEvent ? "unidentified-event" : null,
    state.unsequencedEvent ? "unsequenced-event" : null,
    state.overflow ? "buffer-overflow" : null,
  ]
  for (const kind of gaps) {
    if (kind) store.recordGap({ listenerID: "enrollment-buffer", sessionID, kind })
  }
}

function noteUnidentifiedEvent(
  store: ManagedUsageStore,
  listenerID: string,
  sessionID: string | null,
  enrolled: boolean,
  pending: PendingEnrollment | undefined,
  nativeLocation?: ManagedUsageLocation | null,
) {
  if (!sessionID) {
    if (pending) pending.unidentifiedEvent = true
    if (nativeLocation)
      store.recordGapForLocation({ listenerID, nativeLocation, kind: "unidentified-event" })
    else store.recordGapForAll({ listenerID, kind: "unidentified-event" })
    return
  }
  if (enrolled)
    store.recordGap({
      listenerID,
      sessionID,
      kind: "unidentified-event",
      nativeLocation,
    })
  else if (pending) pending.unidentifiedEvent = true
}

function bufferEnrollmentFact(state: PendingEnrollment, fact: ManagedUsageNativeFact) {
  if (state.facts.length < MAX_BUFFERED_ENROLLMENT_FACTS) state.facts.push(fact)
  else state.overflow = true
}

function authorizedStartFact(fact: ManagedUsageNativeFact, agent: string) {
  return fact.eventType !== "started" || (fact.agent === agent && !isWorkerAgent(fact.agent))
}

type ManagedUsageSession = {
  id: string
  projectID: string
  agent?: string
  location?: unknown
}

function managedSessionAtLocation(
  session: ManagedUsageSession,
  nativeLocation: ManagedUsageLocation | null,
) {
  if (!nativeLocation) return true
  const sessionLocation = managedUsageLocation(session.location)
  return sessionLocation !== null && sameManagedUsageLocation(sessionLocation, nativeLocation)
}

function managedSessionAgentIsAuthorized(
  session: ManagedUsageSession,
  store: ManagedUsageStore,
  fact: ManagedUsageNativeFact,
) {
  const agent = session.agent
  return (
    typeof agent === "string" &&
    !isWorkerAgent(agent) &&
    store.enrolledAgent(fact.sessionID) === agent &&
    !store.isWorkerSession(fact.sessionID) &&
    authorizedStartFact(fact, agent)
  )
}

async function authorizedManagedFact(
  ctx: ManagedUsageNativeContext,
  store: ManagedUsageStore,
  fact: ManagedUsageNativeFact,
  projectID: string,
  nativeLocation: ManagedUsageLocation | null,
  signal: AbortSignal,
) {
  const session = await Effect.runPromise(
    ctx.session.get({ sessionID: Session.ID.make(fact.sessionID) }),
    { signal },
  )
  signal.throwIfAborted()
  return (
    session.id === fact.sessionID &&
    session.projectID === projectID &&
    managedSessionAtLocation(session, nativeLocation) &&
    managedSessionAgentIsAuthorized(session, store, fact)
  )
}

type ObservationInput = {
  event: unknown
  ctx: ManagedUsageNativeContext
  projectID: string
  listenerID: string
  nativeLocation: ManagedUsageLocation | null
}

export type ManagedUsageObserverLease = {
  id: string
  nativeLocation: ManagedUsageLocation
}

type ActiveObserver = ManagedUsageObserverLease & {
  closed: boolean
  controllers: Set<AbortController>
  pending: Set<Promise<void>>
  stopping?: Promise<void>
}

export class ManagedUsageCapture {
  private readonly pending = new Map<string, PendingEnrollment>()
  private readonly latestSequences = new Map<string, number>()
  private readonly observers = new Map<string, ActiveObserver>()
  private readonly observersByLocation = new Map<string, Set<string>>()
  private inFlightObservations = 0

  constructor(readonly store: ManagedUsageStore) {}

  boundarySequence(sessionID: string) {
    return Math.max(this.latestSequences.get(sessionID) ?? -1, this.store.latestSequence(sessionID))
  }

  private rememberSequence(event: unknown, sessionID: string) {
    const rawSequence = managedUsageEventSequence(event, sessionID)
    if (rawSequence === null) return
    this.latestSequences.set(
      sessionID,
      Math.max(this.latestSequences.get(sessionID) ?? -1, rawSequence),
    )
  }

  startObserver(
    observerID: string,
    nativeLocation: ManagedUsageLocation,
  ): ManagedUsageObserverLease {
    const locationKey = managedUsageLocationKey(nativeLocation)
    const observerIDs = this.observersByLocation.get(locationKey) ?? new Set<string>()
    const wasUncovered = observerIDs.size === 0
    const observer: ActiveObserver = {
      id: observerID,
      nativeLocation,
      closed: false,
      controllers: new Set(),
      pending: new Set(),
    }
    observerIDs.add(observerID)
    this.observersByLocation.set(locationKey, observerIDs)
    this.observers.set(observerID, observer)
    if (wasUncovered)
      this.store.recordGapForLocation({
        listenerID: observerID,
        nativeLocation,
        kind: "listener-started",
      })
    return { id: observerID, nativeLocation }
  }

  stopObserver(
    observerID: string,
    reason: "stream-failed" | "stream-ended" | "listener-stopped",
  ): Promise<void> {
    const observer = this.observers.get(observerID)
    if (!observer) return Promise.resolve()
    if (observer.stopping) return observer.stopping
    observer.closed = true
    const stopping = (async () => {
      await Promise.allSettled(observer.pending)
      this.observers.delete(observerID)
      const locationKey = managedUsageLocationKey(observer.nativeLocation)
      const observerIDs = this.observersByLocation.get(locationKey)
      observerIDs?.delete(observerID)
      if (observerIDs?.size) return
      this.observersByLocation.delete(locationKey)
      this.store.recordGapForLocation({
        listenerID: observerID,
        nativeLocation: observer.nativeLocation,
        kind: reason,
      })
    })()
    observer.stopping = stopping
    if (reason === "listener-stopped")
      for (const controller of observer.controllers) controller.abort()
    return observer.stopping
  }

  async stopAllObservers() {
    await Promise.all(
      [...this.observers.keys()].map((observerID) =>
        this.stopObserver(observerID, "listener-stopped"),
      ),
    )
  }

  private noteUnidentifiedEvent(listenerID: string, nativeLocation: ManagedUsageLocation | null) {
    for (const enrollment of this.pending.values()) enrollment.unidentifiedEvent = true
    if (nativeLocation)
      this.store.recordGapForLocation({
        listenerID,
        nativeLocation,
        kind: "unidentified-event",
      })
    else this.store.recordGapForAll({ listenerID, kind: "unidentified-event" })
  }

  private enrollmentFact(
    input: ObservationInput,
    sessionID: string,
  ): ManagedUsageNativeFact | null {
    const enrolled = this.store.hasEnrollment(sessionID)
    const pending = this.pending.get(sessionID)
    if (!enrolled && !pending) return null
    const fact = managedUsageFactFromEvent(input.event)
    if (!fact) {
      noteUnidentifiedEvent(
        this.store,
        input.listenerID,
        sessionID,
        enrolled,
        pending,
        input.nativeLocation,
      )
      return null
    }
    this.recordUnsequencedFact(
      input.listenerID,
      sessionID,
      enrolled,
      pending,
      fact,
      input.nativeLocation,
    )
    if (!enrolled && pending) {
      bufferEnrollmentFact(pending, fact)
      return null
    }
    return fact
  }

  private recordUnsequencedFact(
    listenerID: string,
    sessionID: string,
    enrolled: boolean,
    pending: PendingEnrollment | undefined,
    fact: ManagedUsageNativeFact,
    nativeLocation: ManagedUsageLocation | null,
  ) {
    if (fact.sequence !== null) return
    if (enrolled)
      this.store.recordGap({
        listenerID,
        sessionID,
        kind: "unsequenced-event",
        nativeLocation,
      })
    else if (pending) pending.unsequencedEvent = true
  }

  private authorizationTask(
    input: ObservationInput,
    sessionID: string,
    fact: ManagedUsageNativeFact,
  ) {
    return async (signal: AbortSignal) => {
      const authorized = await authorizedManagedFact(
        input.ctx,
        this.store,
        fact,
        input.projectID,
        input.nativeLocation,
        signal,
      )
      signal.throwIfAborted()
      if (!authorized) {
        this.store.recordGap({
          listenerID: input.listenerID,
          sessionID,
          kind: "authority-changed",
          nativeLocation: input.nativeLocation,
        })
        return
      }
      signal.throwIfAborted()
      this.store.appendFact(fact)
    }
  }

  beginEnrollment(sessionID: string) {
    const token = Symbol(sessionID)
    const existing = this.pending.get(sessionID)
    const state = existing ?? {
      tokens: new Set<symbol>(),
      facts: [],
      unidentifiedEvent: false,
      unsequencedEvent: false,
      overflow: false,
    }
    state.tokens.add(token)
    this.pending.set(sessionID, state)
    let finished = false
    return {
      finish: (boundarySequence: number | null, committed: boolean) => {
        if (finished) return
        finished = true
        state.tokens.delete(token)
        if (committed) {
          appendBufferedFacts(this.store, state.facts, boundarySequence)
          recordPendingGaps(this.store, sessionID, state)
        }
        if (!state.tokens.size && this.pending.get(sessionID) === state)
          this.pending.delete(sessionID)
      },
    }
  }

  private prepareObservation(
    input: ObservationInput,
  ): ((signal: AbortSignal) => Promise<void>) | null {
    if (!managedUsageEventType(nativeObject(input.event)?.type)) return null
    const sessionID = managedUsageEventSessionID(input.event)
    if (!this.eventMatchesNativeLocation(input, sessionID)) return null
    if (!sessionID) {
      this.noteUnidentifiedEvent(input.listenerID, input.nativeLocation)
      return null
    }
    this.rememberSequence(input.event, sessionID)
    const fact = this.enrollmentFact(input, sessionID)
    return fact ? this.authorizationTask(input, sessionID, fact) : null
  }

  private eventMatchesNativeLocation(input: ObservationInput, sessionID: string | null) {
    if (!input.nativeLocation) return true
    const eventLocation = managedUsageEventLocation(input.event)
    if (eventLocation === undefined) return true
    if (eventLocation === null) {
      if (sessionID) {
        const enrolled = this.store.hasEnrollment(sessionID)
        const pending = this.pending.get(sessionID)
        noteUnidentifiedEvent(
          this.store,
          input.listenerID,
          sessionID,
          enrolled,
          pending,
          input.nativeLocation,
        )
      }
      return false
    }
    return sameManagedUsageLocation(input.nativeLocation, eventLocation)
  }

  async observe(
    event: unknown,
    ctx: ManagedUsageNativeContext,
    projectID: string,
    listenerID: string,
  ) {
    const process = this.prepareObservation({
      event,
      ctx,
      projectID,
      listenerID,
      nativeLocation: managedUsageLocation(ctx.location),
    })
    if (process) await process(new AbortController().signal)
  }

  observeForObserver(
    observerLease: ManagedUsageObserverLease,
    event: unknown,
    ctx: ManagedUsageNativeContext,
    projectID: string,
  ): void {
    const observer = this.observers.get(observerLease.id)
    if (!observer || observer.closed) return
    const process = this.prepareObservation({
      event,
      ctx,
      projectID,
      listenerID: observer.id,
      nativeLocation: observer.nativeLocation,
    })
    if (!process) return
    const sessionID = managedUsageEventSessionID(event)
    if (this.inFlightObservations >= MAX_IN_FLIGHT_OBSERVATIONS) {
      if (sessionID)
        this.store.recordGap({
          listenerID: observer.id,
          sessionID,
          kind: "buffer-overflow",
          nativeLocation: observer.nativeLocation,
        })
      return
    }
    this.inFlightObservations++
    const controller = new AbortController()
    observer.controllers.add(controller)
    const pending = process(controller.signal)
      .catch(() => {
        if (sessionID && !controller.signal.aborted)
          this.store.recordGap({
            listenerID: observer.id,
            sessionID,
            kind: "observation-failed",
            nativeLocation: observer.nativeLocation,
          })
      })
      .finally(() => {
        this.inFlightObservations--
        observer.controllers.delete(controller)
        observer.pending.delete(pending)
      })
    observer.pending.add(pending)
  }
}
export { registerManagedUsageNative } from "./native-registration.ts"

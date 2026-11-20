import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import { isWorkerAgent } from "../runner/worker-agent.ts"
import type { ManagedUsageNativeFact } from "./contract.ts"
import {
  managedUsageEventSequence,
  managedUsageEventSessionID,
  managedUsageEventType,
  managedUsageFactFromEvent,
  nativeObject,
} from "./native-facts.ts"
import { ManagedUsageStore } from "./store.ts"

type ManagedUsageNativeContext = Pick<Plugin.Context, "event" | "session" | "location">

const MANAGED_USAGE_EVENT_TYPES = [
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
] as const
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
) {
  if (!sessionID) {
    if (pending) pending.unidentifiedEvent = true
    store.recordGapForAll({ listenerID, kind: "unidentified-event" })
    return
  }
  if (enrolled) store.recordGap({ listenerID, sessionID, kind: "unidentified-event" })
  else if (pending) pending.unidentifiedEvent = true
}

function bufferEnrollmentFact(state: PendingEnrollment, fact: ManagedUsageNativeFact) {
  if (state.facts.length < MAX_BUFFERED_ENROLLMENT_FACTS) state.facts.push(fact)
  else state.overflow = true
}

function authorizedStartFact(fact: ManagedUsageNativeFact, agent: string) {
  return fact.eventType !== "started" || (fact.agent === agent && !isWorkerAgent(fact.agent))
}

async function authorizedManagedFact(
  ctx: ManagedUsageNativeContext,
  store: ManagedUsageStore,
  fact: ManagedUsageNativeFact,
  projectID: string,
) {
  const session = await Effect.runPromise(
    ctx.session.get({ sessionID: Session.ID.make(fact.sessionID) }),
  )
  return (
    session.id === fact.sessionID &&
    session.projectID === projectID &&
    typeof session.agent === "string" &&
    !isWorkerAgent(session.agent) &&
    store.enrolledAgent(fact.sessionID) === session.agent &&
    !store.isWorkerSession(fact.sessionID) &&
    authorizedStartFact(fact, session.agent)
  )
}

type ObservationInput = {
  event: unknown
  ctx: ManagedUsageNativeContext
  projectID: string
  listenerID: string
}

export class ManagedUsageCapture {
  private readonly pending = new Map<string, PendingEnrollment>()
  private readonly latestSequences = new Map<string, number>()
  private readonly activeObservers = new Set<string>()
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

  startObserver(observerID: string) {
    if (this.activeObservers.has(observerID)) return
    const wasUncovered = this.activeObservers.size === 0
    this.activeObservers.add(observerID)
    if (wasUncovered)
      this.store.recordGapForAll({ listenerID: observerID, kind: "listener-started" })
  }

  stopObserver(observerID: string, reason: "stream-failed" | "stream-ended" | "listener-stopped") {
    if (!this.activeObservers.delete(observerID) || this.activeObservers.size > 0) return
    this.store.recordGapForAll({ listenerID: observerID, kind: reason })
  }

  private noteUnidentifiedEvent(listenerID: string) {
    for (const enrollment of this.pending.values()) enrollment.unidentifiedEvent = true
    this.store.recordGapForAll({ listenerID, kind: "unidentified-event" })
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
      noteUnidentifiedEvent(this.store, input.listenerID, sessionID, enrolled, pending)
      return null
    }
    this.recordUnsequencedFact(input.listenerID, sessionID, enrolled, pending, fact)
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
  ) {
    if (fact.sequence !== null) return
    if (enrolled) this.store.recordGap({ listenerID, sessionID, kind: "unsequenced-event" })
    else if (pending) pending.unsequencedEvent = true
  }

  private authorizationTask(
    input: ObservationInput,
    sessionID: string,
    fact: ManagedUsageNativeFact,
  ) {
    return async () => {
      if (!(await authorizedManagedFact(input.ctx, this.store, fact, input.projectID))) {
        this.store.recordGap({
          listenerID: input.listenerID,
          sessionID,
          kind: "authority-changed",
        })
        return
      }
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

  private prepareObservation(input: ObservationInput): (() => Promise<void>) | null {
    if (!managedUsageEventType(nativeObject(input.event)?.type)) return null
    const sessionID = managedUsageEventSessionID(input.event)
    if (!sessionID) {
      this.noteUnidentifiedEvent(input.listenerID)
      return null
    }
    this.rememberSequence(input.event, sessionID)
    const fact = this.enrollmentFact(input, sessionID)
    return fact ? this.authorizationTask(input, sessionID, fact) : null
  }

  async observe(
    event: unknown,
    ctx: ManagedUsageNativeContext,
    projectID: string,
    listenerID: string,
  ) {
    const process = this.prepareObservation({ event, ctx, projectID, listenerID })
    if (process) await process()
  }

  observeDetached(
    event: unknown,
    ctx: ManagedUsageNativeContext,
    projectID: string,
    listenerID: string,
  ) {
    const process = this.prepareObservation({ event, ctx, projectID, listenerID })
    if (!process) return
    const sessionID = managedUsageEventSessionID(event)
    if (this.inFlightObservations >= MAX_IN_FLIGHT_OBSERVATIONS) {
      if (sessionID) this.store.recordGap({ listenerID, sessionID, kind: "buffer-overflow" })
      return
    }
    this.inFlightObservations++
    void process()
      .catch(() => {
        if (sessionID) this.store.recordGap({ listenerID, sessionID, kind: "observation-failed" })
      })
      .finally(() => {
        this.inFlightObservations--
      })
  }
}

export function registerManagedUsageNative(
  ctx: ManagedUsageNativeContext,
  capture: ManagedUsageCapture,
  projectID: string,
) {
  return Effect.gen(function* () {
    const listenerID = crypto.randomUUID()
    let activeObserverID: string | undefined
    const startObserver = () => {
      const observerID = crypto.randomUUID()
      activeObserverID = observerID
      capture.startObserver(observerID)
    }
    const stopObserver = (reason: "stream-failed" | "stream-ended" | "listener-stopped") => {
      if (!activeObserverID) return
      const observerID = activeObserverID
      activeObserverID = undefined
      capture.stopObserver(observerID, reason)
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => stopObserver("listener-stopped")))

    const listen = Effect.forever(
      Effect.suspend(() => {
        startObserver()
        return Stream.runForEach(
          ctx.event.subscribe({ types: MANAGED_USAGE_EVENT_TYPES }),
          (event) => Effect.sync(() => capture.observeDetached(event, ctx, projectID, listenerID)),
        ).pipe(
          Effect.match({
            onFailure: () => stopObserver("stream-failed"),
            onSuccess: () => stopObserver("stream-ended"),
          }),
          Effect.andThen(Effect.sleep(1_000)),
        )
      }),
    )
    yield* Effect.forkScoped(listen)
  })
}

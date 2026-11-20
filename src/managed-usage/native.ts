import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import { isWorkerAgent } from "../runner/worker-agent.ts"
import type { ManagedUsageNativeFact } from "./contract.ts"
import { ManagedUsageNativeFactSchema } from "./contract.ts"
import { ManagedUsageStore } from "./store.ts"

type ManagedUsageNativeContext = Pick<Plugin.Context, "event" | "session" | "location">

const MANAGED_USAGE_EVENT_TYPES = [
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
] as const
const MAX_BUFFERED_ENROLLMENT_FACTS = 1_000

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function sequence(value: unknown, sessionID: string): number | null {
  const durable = object(object(value)?.durable)
  return durable?.aggregateID === sessionID &&
    typeof durable.seq === "number" &&
    Number.isSafeInteger(durable.seq) &&
    durable.seq >= 0
    ? durable.seq
    : null
}

function nativeEventType(value: unknown): ManagedUsageNativeFact["eventType"] | null {
  if (value === "session.step.started") return "started"
  if (value === "session.step.ended") return "ended"
  if (value === "session.step.failed") return "failed"
  return null
}

function category(value: unknown) {
  if (value === undefined || value === null) return { tokens: null, status: "missing" as const }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return { tokens: null, status: "unavailable" as const }
  return { tokens: value, status: "observed" as const }
}

function nativeFactIdentity(event: unknown) {
  const envelope = object(event)
  const data = object(envelope?.data)
  const sessionID = text(data?.sessionID)
  const messageID = text(data?.assistantMessageID)
  const eventType = nativeEventType(envelope?.type)
  if (!envelope || !data || !sessionID || !messageID || !eventType) return null
  const rawSequence = sequence(event, sessionID)
  const nativeEventID = text(envelope?.id)
  const eventKey = nativeEventID
    ? `id:${nativeEventID}`
    : rawSequence !== null
      ? `seq:${rawSequence}:${envelope.type}`
      : null
  if (!eventKey) return null
  return {
    envelope,
    data,
    sessionID,
    messageID,
    eventType,
    sequence: rawSequence,
    nativeEventID,
    eventKey,
  }
}

function startEvidence(data: Record<string, unknown>) {
  const model = object(data?.model)
  const providerID = text(model?.providerID)
  const modelID = text(model?.id)
  const variant = model?.variant
  const routeIsValid =
    providerID !== null &&
    modelID !== null &&
    (variant === undefined || variant === null || typeof variant === "string")
  return {
    agent: text(data.agent),
    route: routeIsValid
      ? { providerID, modelID, variant: typeof variant === "string" ? variant : null }
      : null,
    routeStatus: routeIsValid
      ? ("observed" as const)
      : model === undefined
        ? ("missing" as const)
        : ("invalid" as const),
    categories: null,
  }
}

function terminalEvidence(data: Record<string, unknown>) {
  const tokens = object(data.tokens)
  const cache = object(tokens?.cache)
  return {
    agent: null,
    route: null,
    routeStatus: "not-applicable" as const,
    categories: {
      uncachedInput: category(tokens?.input),
      output: category(tokens?.output),
      reasoning: category(tokens?.reasoning),
      cacheRead: category(cache?.read),
      cacheWrite: category(cache?.write),
    },
  }
}

function factFromEvent(event: unknown): ManagedUsageNativeFact | null {
  const identity = nativeFactIdentity(event)
  if (!identity) return null
  const evidence =
    identity.eventType === "started"
      ? startEvidence(identity.data)
      : terminalEvidence(identity.data)
  const created = identity.envelope.created
  return ManagedUsageNativeFactSchema.parse({
    schemaVersion: 1,
    sessionID: identity.sessionID,
    eventKey: identity.eventKey,
    nativeEventID: identity.nativeEventID,
    eventType: identity.eventType,
    assistantMessageID: identity.messageID,
    sequence: identity.sequence,
    eventCreatedAt: typeof created === "number" && Number.isFinite(created) ? created : null,
    recordedAt: Date.now(),
    ...evidence,
  })
}

export function managedUsageEventFact(event: unknown) {
  return factFromEvent(event)
}

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
    (fact.eventType !== "started" || (fact.agent === session.agent && !isWorkerAgent(fact.agent)))
  )
}

export class ManagedUsageCapture {
  private readonly pending = new Map<string, PendingEnrollment>()
  private readonly latestSequences = new Map<string, number>()

  constructor(readonly store: ManagedUsageStore) {}

  boundarySequence(sessionID: string) {
    return Math.max(this.latestSequences.get(sessionID) ?? -1, this.store.latestSequence(sessionID))
  }

  private rememberSequence(event: unknown, sessionID: string) {
    const rawSequence = sequence(event, sessionID)
    if (rawSequence === null) return
    this.latestSequences.set(
      sessionID,
      Math.max(this.latestSequences.get(sessionID) ?? -1, rawSequence),
    )
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

  async observe(
    event: unknown,
    ctx: ManagedUsageNativeContext,
    projectID: string,
    listenerID: string,
  ) {
    const envelope = object(event)
    if (!nativeEventType(envelope?.type)) return
    const sessionID = text(object(envelope?.data)?.sessionID)
    if (!sessionID) {
      for (const enrollment of this.pending.values()) enrollment.unidentifiedEvent = true
      this.store.recordGapForAll({ listenerID, kind: "unidentified-event" })
      return
    }
    this.rememberSequence(event, sessionID)
    const enrolled = this.store.hasEnrollment(sessionID)
    const pending = this.pending.get(sessionID)
    if (!enrolled && !pending) return
    const fact = factFromEvent(event)
    if (!fact) {
      noteUnidentifiedEvent(this.store, listenerID, sessionID, enrolled, pending)
      return
    }
    if (fact.sequence === null) {
      if (enrolled) this.store.recordGap({ listenerID, sessionID, kind: "unsequenced-event" })
      else if (pending) pending.unsequencedEvent = true
    }

    if (!enrolled && pending) {
      bufferEnrollmentFact(pending, fact)
      return
    }

    if (!(await authorizedManagedFact(ctx, this.store, fact, projectID))) {
      this.store.recordGap({ listenerID, sessionID, kind: "authority-changed" })
      return
    }
    this.store.appendFact(fact)
  }
}

export function registerManagedUsageNative(
  ctx: ManagedUsageNativeContext,
  capture: ManagedUsageCapture,
  projectID: string,
) {
  return Effect.gen(function* () {
    const listenerID = crypto.randomUUID()
    capture.store.recordGapForAll({ listenerID, kind: "listener-started" })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        capture.store.recordGapForAll({ listenerID, kind: "listener-stopped" })
      }),
    )

    const listen = Effect.forever(
      Effect.suspend(() =>
        Stream.runForEach(ctx.event.subscribe({ types: MANAGED_USAGE_EVENT_TYPES }), (event) =>
          Effect.tryPromise({
            try: () => capture.observe(event, ctx, projectID, listenerID),
            catch: () => new Error("Managed usage native observation failed"),
          }).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                const sessionID = text(object(object(event)?.data)?.sessionID)
                if (sessionID)
                  capture.store.recordGap({ listenerID, sessionID, kind: "observation-failed" })
              }),
            ),
          ),
        ).pipe(
          Effect.match({
            onFailure: () => {
              capture.store.recordGapForAll({ listenerID, kind: "stream-failed" })
            },
            onSuccess: () => {
              capture.store.recordGapForAll({ listenerID, kind: "stream-ended" })
            },
          }),
          Effect.andThen(Effect.sleep(1_000)),
        ),
      ),
    )
    yield* Effect.forkScoped(listen)
  })
}

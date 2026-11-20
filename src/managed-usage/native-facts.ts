import type { ManagedUsageNativeFact } from "./contract.ts"
import { ManagedUsageNativeFactSchema } from "./contract.ts"

export type ManagedUsageNativeEventType = ManagedUsageNativeFact["eventType"]

export function nativeObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nativeText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

export function managedUsageEventType(value: unknown): ManagedUsageNativeEventType | null {
  if (value === "session.step.started") return "started"
  if (value === "session.step.ended") return "ended"
  if (value === "session.step.failed") return "failed"
  return null
}

export function managedUsageEventSessionID(event: unknown): string | null {
  return nativeText(nativeObject(nativeObject(event)?.data)?.sessionID)
}

export function managedUsageEventSequence(event: unknown, sessionID: string): number | null {
  const durable = nativeObject(nativeObject(event)?.durable)
  if (durable?.aggregateID !== sessionID) return null
  if (typeof durable.seq !== "number" || !Number.isSafeInteger(durable.seq)) return null
  return durable.seq >= 0 ? durable.seq : null
}

function eventMetadata(envelope: Record<string, unknown>, data: Record<string, unknown>) {
  const sessionID = nativeText(data.sessionID)
  const messageID = nativeText(data.assistantMessageID)
  const eventType = managedUsageEventType(envelope.type)
  if (!sessionID || !messageID || !eventType) return null
  return { sessionID, messageID, eventType }
}

function eventIdentity(event: unknown, envelope: Record<string, unknown>, sessionID: string) {
  const sequence = managedUsageEventSequence(event, sessionID)
  const nativeEventID = nativeText(envelope.id)
  const eventKey = nativeEventID
    ? `id:${nativeEventID}`
    : sequence === null
      ? null
      : `seq:${sequence}:${envelope.type}`
  return eventKey ? { sequence, nativeEventID, eventKey } : null
}

function nativeFactIdentity(event: unknown) {
  const envelope = nativeObject(event)
  if (!envelope) return null
  const data = nativeObject(envelope.data)
  if (!data) return null
  const metadata = eventMetadata(envelope, data)
  if (!metadata) return null
  const identity = eventIdentity(event, envelope, metadata.sessionID)
  return identity ? { envelope, data, ...metadata, ...identity } : null
}

function category(value: unknown) {
  if (value === undefined || value === null) return { tokens: null, status: "missing" as const }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return { tokens: null, status: "unavailable" as const }
  return { tokens: value, status: "observed" as const }
}

function startRoute(data: Record<string, unknown>) {
  const model = nativeObject(data.model)
  if (!model) return { route: null, routeStatus: "missing" as const }
  const providerID = nativeText(model.providerID)
  const modelID = nativeText(model.id)
  const variant = model.variant
  const validVariant = variant === undefined || variant === null || typeof variant === "string"
  if (!providerID || !modelID || !validVariant)
    return { route: null, routeStatus: "invalid" as const }
  return {
    route: { providerID, modelID, variant: typeof variant === "string" ? variant : null },
    routeStatus: "observed" as const,
  }
}

function startEvidence(data: Record<string, unknown>) {
  return { agent: nativeText(data.agent), ...startRoute(data), categories: null }
}

function terminalEvidence(data: Record<string, unknown>) {
  const tokens = nativeObject(data.tokens)
  const cache = nativeObject(tokens?.cache)
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

export function managedUsageFactFromEvent(event: unknown): ManagedUsageNativeFact | null {
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

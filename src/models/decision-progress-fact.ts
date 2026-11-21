import { privacyStats, safeText } from "../trajectory/privacy.ts"
import type { ProgressRow } from "../runner/store.ts"

/**
 * The decision projection of one retained progress row: the slim fact the Models decision read
 * values, built from the stored payload. The reader (live tail) and the projection owner (stored
 * rows) both call this one function, so a stored fact and a live one are the same bytes.
 */
export type JsonObject = Record<string, unknown>
export type Route = { providerID: string; modelID: string; variant: string | null }

export function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

export function parseObject(value: string | null | undefined): JsonObject | null {
  if (!value) return null
  try {
    return object(JSON.parse(value))
  } catch {
    return null
  }
}

export function parseArray(value: string | null | undefined): unknown[] | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function stringList(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === "string")
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function nonnegativeOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

export function safeRoute(value: unknown, stats: ReturnType<typeof privacyStats>): Route | null {
  const route = object(value)
  const provider = typeof route?.providerID === "string" ? route.providerID : null
  const model =
    typeof route?.modelID === "string"
      ? route.modelID
      : typeof route?.id === "string"
        ? route.id
        : null
  if (!provider || !model) return null
  const rawVariant = typeof route?.variant === "string" ? route.variant : null
  if (
    [provider, model, ...(rawVariant === null ? [] : [rawVariant])].some(
      (part) => part.includes("[REDACTED]") || part.endsWith("…[truncated]"),
    )
  )
    return null
  const providerID = safeText(provider, stats, 512)
  const modelID = safeText(model, stats, 512)
  const variant = rawVariant === null ? null : safeText(rawVariant, stats, 512)
  if (
    providerID !== provider ||
    modelID !== model ||
    (rawVariant !== null && variant !== rawVariant)
  )
    return null
  return { providerID, modelID, variant }
}

function decisionProgressFact(
  row: DecisionProgressSource,
  payload: JsonObject,
  stats: ReturnType<typeof privacyStats>,
) {
  const usageValue = object(payload.usage)
  const usage = usageValue
    ? {
        input: nonnegativeOrNull(usageValue.input),
        output: nonnegativeOrNull(usageValue.output),
        reasoning: nonnegativeOrNull(usageValue.reasoning),
        cacheRead: nonnegativeOrNull(usageValue.cacheRead),
        cacheWrite: nonnegativeOrNull(usageValue.cacheWrite),
        costUSD: nonnegativeOrNull(usageValue.costUSD),
      }
    : null
  const routeEvidence = object(payload.routeEvidence)
  const projectedRouteEvidence = routeEvidence
    ? {
        status:
          typeof routeEvidence.status === "string"
            ? safeText(routeEvidence.status, stats, 80)
            : "identity-unavailable",
        ...(routeEvidence.status === "observed"
          ? { route: safeRoute(routeEvidence.route, stats) }
          : {}),
      }
    : null
  const rawRoute = routeEvidence
    ? routeEvidence.status === "observed"
      ? routeEvidence.route
      : null
    : payload.route
  const route = safeRoute(rawRoute, stats)
  const rawObservations = list(payload.observations)
  const observations = rawObservations.flatMap((raw) => {
    const observation = object(raw)
    if (
      !observation ||
      (observation.source !== "native-event" && observation.source !== "recovery") ||
      typeof observation.eventType !== "string"
    )
      return []
    const evidence = object(observation.routeEvidence)
    const rawObservationRoute = evidence
      ? evidence.status === "observed"
        ? evidence.route
        : null
      : observation.route
    const projectedEvidence = evidence
      ? {
          status:
            typeof evidence.status === "string"
              ? safeText(evidence.status, stats, 80)
              : "identity-unavailable",
          ...(evidence.status === "observed" ? { route: safeRoute(evidence.route, stats) } : {}),
        }
      : null
    return [
      {
        source: observation.source,
        eventType: safeText(observation.eventType, stats, 160),
        at: numberOrNull(observation.at),
        messageID: typeof observation.messageID === "string" ? observation.messageID : null,
        eventID: typeof observation.eventID === "string" ? observation.eventID : null,
        route: safeRoute(rawObservationRoute, stats),
        ...(projectedEvidence ? { routeEvidence: projectedEvidence } : {}),
      },
    ]
  })
  const timing = object(payload.timing)
  const endpoints = object(timing?.endpoints)
  const completedAt = object(endpoints?.completedAt)
  const sourceTypes = parseArray(row.sources_json)
  const eventIDs = parseArray(row.event_ids_json)
  return {
    id: `progress:${row.seq}`,
    sequence: row.seq,
    attemptID: row.attempt_id,
    sessionID: row.session_id,
    messageID: row.message_id,
    source: safeText(row.source, stats, 80),
    sources: sourceTypes
      ? stringList(sourceTypes).map((source) => safeText(source, stats, 80))
      : [safeText(row.source, stats, 80)],
    eventIDs: eventIDs ? stringList(eventIDs) : [],
    kind: row.kind === "step" ? "worker-step" : "worker-usage-snapshot",
    at: row.at,
    recordedAt: numberOrNull(row.recorded_at),
    measurementBasis:
      typeof payload.measurementBasis === "string"
        ? safeText(payload.measurementBasis, stats, 160)
        : null,
    usage,
    route,
    ...(projectedRouteEvidence ? { routeEvidence: projectedRouteEvidence } : {}),
    observations,
    timing: {
      endpoints: {
        completedAt: {
          at: numberOrNull(completedAt?.at),
          sourceType:
            typeof completedAt?.sourceType === "string"
              ? safeText(completedAt.sourceType, stats, 160)
              : null,
        },
      },
    },
  }
}

/** Flag bits stored beside a projected fact; they carry the notes the live read would add. */
export const FACT_MALFORMED_PAYLOAD = 1
export const FACT_UNREADABLE_SOURCES = 2
export const FACT_UNREADABLE_EVENTS = 4

/** The columns of `runner_progress` a decision fact reads. */
export type DecisionProgressSource = Pick<
  ProgressRow,
  | "seq"
  | "attempt_id"
  | "session_id"
  | "at"
  | "recorded_at"
  | "source"
  | "sources_json"
  | "kind"
  | "event_ids_json"
  | "message_id"
  | "payload"
>

/** A malformed payload has no fact; valid JSON that is not an object projects as an empty one. */
export function projectDecisionProgressRow(
  row: DecisionProgressSource,
  stats: ReturnType<typeof privacyStats>,
): { flags: number; fact: Record<string, unknown> | null } {
  let payload: JsonObject
  try {
    payload = object(JSON.parse(row.payload)) ?? {}
  } catch {
    return { flags: FACT_MALFORMED_PAYLOAD, fact: null }
  }
  const flags =
    (parseArray(row.sources_json) ? 0 : FACT_UNREADABLE_SOURCES) |
    (parseArray(row.event_ids_json) ? 0 : FACT_UNREADABLE_EVENTS)
  return { flags, fact: decisionProgressFact(row, payload, stats) }
}

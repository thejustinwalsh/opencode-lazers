import type { ProgressRow } from "../runner/store.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { publicProgressError, visibleProgressText } from "./privacy.ts"

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function list(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
}

function payload(row: ProgressRow): JsonObject {
  try {
    return object(JSON.parse(row.payload)) ?? {}
  } catch {
    return {}
  }
}

function projectedRoute(value: unknown, stats: ReturnType<typeof privacyStats>) {
  const route = object(value)
  if (typeof route?.providerID !== "string" || typeof route.modelID !== "string") return null
  return {
    providerID: safeText(route.providerID, stats, 200),
    modelID: safeText(route.modelID, stats, 300),
    variant: typeof route.variant === "string" ? safeText(route.variant, stats, 200) : null,
  }
}

function projectedObservations(value: unknown, stats: ReturnType<typeof privacyStats>) {
  if (!Array.isArray(value)) return []
  return value.slice(-25).flatMap((raw) => {
    const observation = object(raw)
    if (
      !observation ||
      (observation.source !== "native-event" && observation.source !== "recovery") ||
      typeof observation.eventType !== "string"
    )
      return []
    return [
      {
        source: observation.source,
        eventID:
          typeof observation.eventID === "string"
            ? safeText(observation.eventID, stats, 200)
            : null,
        eventType: safeText(observation.eventType, stats, 120),
        at: number(observation.at),
        status: string(observation.status),
        messageID:
          typeof observation.messageID === "string"
            ? safeText(observation.messageID, stats, 200)
            : null,
        callID:
          typeof observation.callID === "string" ? safeText(observation.callID, stats, 200) : null,
        agent:
          typeof observation.agent === "string" ? safeText(observation.agent, stats, 200) : null,
        tool: typeof observation.tool === "string" ? safeText(observation.tool, stats, 160) : null,
        route: projectedRoute(observation.route, stats),
        startedAt: number(observation.startedAt),
      },
    ]
  })
}

/** Fail-closed trajectory view; stored native or model payloads are never copied wholesale. */
export function projectProgressFact(row: ProgressRow): Record<string, unknown> {
  const stats = privacyStats()
  const value = payload(row)
  const view: Record<string, unknown> = {
    id: `progress:${row.seq}`,
    sequence: row.seq,
    at: row.at,
    projectID: safeText(row.project_id, stats, 128),
    planID: safeText(row.plan_id, stats, 128),
    taskID: safeText(row.task_id, stats, 128),
    attemptID: safeText(row.attempt_id, stats, 128),
    sessionID: safeText(row.session_id, stats, 128),
    messageID: row.message_id === null ? null : safeText(row.message_id, stats, 200),
    callID: row.call_id === null ? null : safeText(row.call_id, stats, 200),
    source: safeText(row.source, stats, 80),
    sources: [...new Set([row.source, ...list(row.sources_json)])].map((source) =>
      safeText(source, stats, 80),
    ),
    eventIDs: list(row.event_ids_json).map((id) => safeText(id, stats, 200)),
    kind: row.kind === "commentary" ? "commentary" : `worker-${safeText(row.kind, stats, 80)}`,
  }

  switch (row.kind) {
    case "commentary":
      view.text = typeof value.text === "string" ? safeText(value.text, stats, 1200) : ""
      break
    case "tool":
      view.tool = typeof value.tool === "string" ? safeText(value.tool, stats, 160) : null
      view.status = string(value.status)
      if (typeof value.content === "string") view.result = visibleProgressText(value.content, stats)
      // Legacy arbitrary structured output is not exported either.
      if (value.error !== undefined) view.error = publicProgressError(value.error, stats)
      view.observations = projectedObservations(value.observations, stats)
      break
    case "visible-text":
      view.text = typeof value.text === "string" ? safeText(value.text, stats) : ""
      break
    case "step": {
      const usage = object(value.usage)
      view.status = string(value.status)
      view.finish = string(value.finish)
      view.measurementBasis = string(value.measurementBasis)
      view.agent = typeof value.agent === "string" ? safeText(value.agent, stats, 200) : null
      view.route = projectedRoute(value.route, stats)
      view.observations = projectedObservations(value.observations, stats)
      view.usage = usage
        ? {
            input: number(usage.input),
            output: number(usage.output),
            reasoning: number(usage.reasoning),
            cacheRead: number(usage.cacheRead),
            cacheWrite: number(usage.cacheWrite),
            costUSD: number(usage.costUSD),
          }
        : null
      if (value.error !== undefined) view.error = publicProgressError(value.error, stats)
      break
    }
    case "usage-snapshot": {
      const usage = object(value.usage)
      view.measurementBasis = string(value.measurementBasis)
      view.usage = usage
        ? {
            input: number(usage.input),
            output: number(usage.output),
            reasoning: number(usage.reasoning),
            cacheRead: number(usage.cacheRead),
            cacheWrite: number(usage.cacheWrite),
            costUSD: number(usage.costUSD),
          }
        : null
      view.additive = false
      break
    }
    case "provider-retry":
      view.attempt = number(value.attempt)
      if (value.error !== undefined) view.error = publicProgressError(value.error, stats)
      break
    case "execution-outcome":
      view.outcome = string(value.outcome)
      view.basis = string(value.basis)
      if (value.error !== undefined) view.error = publicProgressError(value.error, stats)
      if (typeof value.reason === "string") view.reason = safeText(value.reason, stats, 500)
      break
    case "outcome-snapshot":
      view.outcome = string(value.outcome)
      view.basis = "cumulative-session-outcome-snapshot"
      view.additive = false
      view.turnIdentity = "unavailable"
      break
    case "shell":
      view.shellID = typeof value.shellID === "string" ? safeText(value.shellID, stats, 128) : null
      view.command = typeof value.command === "string" ? safeText(value.command, stats) : null
      view.status = string(value.status)
      view.exit = number(value.exit)
      if (typeof value.output === "string") view.output = safeText(value.output, stats)
      view.truncated = value.truncated === true
      break
    case "verification":
      view.checkID =
        typeof value.checkID === "string" ? safeText(value.checkID, stats, 120) : "unknown"
      view.result = string(value.result)
      view.exitCode = number(value.exitCode)
      view.timedOut = typeof value.timedOut === "boolean" ? value.timedOut : null
      view.unchanged = typeof value.unchanged === "boolean" ? value.unchanged : null
      if (typeof value.artifact === "string") view.artifact = safeText(value.artifact, stats, 128)
      if (typeof value.command === "string") view.command = safeText(value.command, stats)
      if (value.error !== undefined) view.error = publicProgressError(value.error, stats)
      break
    case "artifact":
      view.commit = typeof value.commit === "string" ? safeText(value.commit, stats, 128) : null
      break
    case "gap":
      view.reason =
        typeof value.reason === "string"
          ? safeText(value.reason, stats, 500)
          : "Unknown recovery gap"
      break
    case "reminder":
      view.text = typeof value.text === "string" ? safeText(value.text, stats, 500) : ""
      view.delivery = string(value.delivery)
      view.observedAt = number(value.reconciledAt)
      view.nativeEventID =
        typeof value.nativeEventID === "string" ? safeText(value.nativeEventID, stats, 200) : null
      break
    default:
      view.kind = "worker-unknown"
      break
  }
  return view
}

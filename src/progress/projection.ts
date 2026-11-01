import type { ProgressRow } from "../runner/store.ts"
import { privacyStats, safeText, safeValue } from "../trajectory/privacy.ts"

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
      if (typeof value.content === "string") view.result = safeText(value.content, stats)
      if (value.output !== undefined) view.output = safeValue(value.output, stats)
      if (value.error !== undefined) view.error = safeValue(value.error, stats)
      break
    case "visible-text":
      view.text = typeof value.text === "string" ? safeText(value.text, stats) : ""
      break
    case "step": {
      const usage = object(value.usage)
      view.status = string(value.status)
      view.finish = string(value.finish)
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
      if (value.error !== undefined) view.error = safeValue(value.error, stats)
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
      if (value.error !== undefined) view.error = safeValue(value.error, stats)
      break
    case "execution-outcome":
      view.outcome = string(value.outcome)
      view.basis = string(value.basis)
      if (value.error !== undefined) view.error = safeValue(value.error, stats)
      if (typeof value.reason === "string") view.reason = safeText(value.reason, stats, 500)
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
      if (value.error !== undefined) view.error = safeValue(value.error, stats)
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
      break
    default:
      view.kind = "worker-unknown"
      break
  }
  return view
}

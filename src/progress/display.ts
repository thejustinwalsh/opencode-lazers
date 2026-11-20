import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { projectProgressFact } from "./projection.ts"
import type { ProgressRow } from "../runner/store.ts"

/**
 * What the live history list shows of one progress row, as a pure function of the stored row.
 * The writer stores its result beside the row (`runner_progress_display`), so a reader of that
 * table sees exactly what the read-time projection produced; both call {@link progressDisplay}.
 * The helpers here also serve the Radar live read, which owns the same privacy rules.
 */
export type JsonObject = Record<string, unknown>
export const TRUNCATION_SUFFIX = "…[truncated]"

/**
 * The version of {@link progressDisplay}. Stored rows carry the version that wrote them, and the
 * backfill rewrites rows written under an older one.
 *   1: the read-time guards of the first history read applied (payload 4096 B, event ids 2048 B,
 *      ids 200 B): a row past one of them showed only its columns.
 *   2: the display is computed once at write time, from the whole row; only the per-field display
 *      truncation (80 to 600 characters) remains.
 */
export const DISPLAY_VERSION = 2

export function contractText(
  value: string,
  stats: ReturnType<typeof privacyStats>,
  maximum: number,
) {
  const sanitized = safeText(value, stats, Number.MAX_SAFE_INTEGER)
  if (sanitized.length <= maximum) return sanitized
  stats.truncated++
  const bodyLength = Math.max(0, maximum - TRUNCATION_SUFFIX.length)
  let body = sanitized.slice(0, bodyLength)
  const last = body.charCodeAt(body.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) body = body.slice(0, -1)
  return `${body}${TRUNCATION_SUFFIX}`
}

export function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

export function safeRoute(value: unknown, stats: ReturnType<typeof privacyStats>) {
  const model = object(value)
  const modelID = typeof model?.modelID === "string" ? model.modelID : model?.id
  if (typeof model?.providerID !== "string" || typeof modelID !== "string") return null
  if (model.variant !== undefined && model.variant !== null && typeof model.variant !== "string")
    return null
  if (Object.hasOwn(model, "identity")) {
    const identity = object(model.identity)
    if (
      !identity ||
      identity.providerID !== model.providerID ||
      identity.modelID !== modelID ||
      identity.variant !== (typeof model.variant === "string" ? model.variant : null)
    )
      return null
  }
  if (model.providerID.length > 200 || modelID.length > 300) return null
  if (typeof model.variant === "string" && model.variant.length > 200) return null
  const providerID = contractText(model.providerID, stats, 200)
  const safeModelID = contractText(modelID, stats, 300)
  if (!providerID || !safeModelID) return null
  if (
    [providerID, safeModelID].some(
      (part) => part.includes("[REDACTED]") || part.endsWith(TRUNCATION_SUFFIX),
    )
  )
    return null
  const variant = typeof model.variant === "string" ? contractText(model.variant, stats, 200) : null
  if (variant?.includes("[REDACTED]") || variant?.endsWith(TRUNCATION_SUFFIX)) return null
  return {
    providerID,
    modelID: safeModelID,
    variant,
  }
}

export function numeric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function text(value: unknown, maximum: number, stats: ReturnType<typeof privacyStats>) {
  return typeof value === "string" ? contractText(value, stats, maximum) : null
}

export function observationList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const observation = object(item)
    if (!observation || typeof observation.eventType !== "string") return []
    return [observation]
  })
}

export function fileTargets(value: unknown):
  | {
      coverage: "observed" | "partial" | "omitted"
      operation: "read" | "edit" | "patch" | null
      paths: string[]
    }
  | undefined {
  const targets = object(value)
  if (
    !targets ||
    (targets.coverage !== "observed" &&
      targets.coverage !== "partial" &&
      targets.coverage !== "omitted")
  )
    return undefined
  const operation =
    targets.operation === "read" || targets.operation === "edit" || targets.operation === "patch"
      ? targets.operation
      : null
  const hasControlCharacters = (value: string) =>
    [...value].some((character) => {
      const code = character.codePointAt(0)!
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    })
  const paths = Array.isArray(targets.paths)
    ? targets.paths
        .slice(0, 8)
        .filter(
          (path): path is string =>
            typeof path === "string" &&
            path.length <= 512 &&
            path.length > 0 &&
            !path.startsWith("/") &&
            !path.includes("\\") &&
            !/^[a-z][a-z\d+.-]*:/iu.test(path) &&
            !hasControlCharacters(path) &&
            !path.split("/").some((part) => !part || part === "." || part === ".."),
        )
    : []
  const invalidPaths = !Array.isArray(targets.paths) || targets.paths.length > paths.length
  const coverage =
    paths.length === 0
      ? "omitted"
      : invalidPaths || targets.coverage === "partial"
        ? "partial"
        : targets.coverage
  return { coverage, operation, paths }
}

/** The columns of a stored progress row the display reads. A bounded SQL read satisfies it too. */
export type DisplayRow = {
  seq: number
  at: number
  recorded_at: number | null
  source: string
  kind: string
  event_ids_json: string | null
  call_id: string | null
  message_id: string | null
  payload: string | null
}

/** The parsed fact of a row, through the same projection the trajectory and reports use. */
export function factFor(row: DisplayRow) {
  const progress: ProgressRow = {
    seq: row.seq,
    project_directory: "",
    project_id: "",
    plan_id: "",
    task_id: "",
    attempt_id: "",
    session_id: "",
    at: row.at,
    recorded_at: row.recorded_at,
    source: row.source,
    sources_json: "[]",
    kind: row.kind,
    event_ids_json: row.event_ids_json ?? "[]",
    call_id: row.call_id,
    message_id: row.message_id,
    dedupe_key: "",
    payload: row.payload ?? "{}",
  }
  return projectProgressFact(progress)
}

/** One history row's displayed fields: sanitized, truncated, ready to show. */
export type ProgressDisplay = {
  kind: string
  source: string
  messageID: string | null
  callID: string | null
  tool: string | null
  status: string | null
  agent: string | null
  result: string | null
  error: string | null
  route: { providerID: string; modelID: string; variant: string | null } | null
  observations: {
    eventID: string | null
    eventType: string
    at: number | null
    status: string | null
  }[]
  payloadAvailable: boolean
  fileTargets?: NonNullable<ReturnType<typeof fileTargets>>
}

/** The display of a stored row: sanitized and truncated per field, from the whole row. */
export function progressDisplay(stored: DisplayRow): ProgressDisplay {
  const row: DisplayRow = {
    ...stored,
    source: stored.source.slice(0, 80),
    kind: stored.kind.slice(0, 80),
  }
  const stats = privacyStats()
  const fact = row.payload === null ? {} : factFor(row)
  const observations = observationList(fact.observations)
    .toSorted((left, right) => (numeric(left.at) ?? 0) - (numeric(right.at) ?? 0))
    .slice(-8)
    .map((item) => ({
      eventID: text(item.eventID, 200, stats),
      eventType: contractText(String(item.eventType), stats, 120),
      at: numeric(item.at),
      status: text(item.status, 80, stats),
    }))
  const routeEvidence = object(fact.routeEvidence)
  const route = routeEvidence?.status === "observed" ? safeRoute(routeEvidence.route, stats) : null
  const error = object(fact.error)
  const requestedFiles = fileTargets(fact.fileTargets)
  return {
    kind: contractText(String(fact.kind ?? row.kind), stats, 80),
    source: contractText(String(fact.source ?? row.source), stats, 80),
    messageID: text(fact.messageID ?? row.message_id, 200, stats),
    callID: text(fact.callID ?? row.call_id, 200, stats),
    tool: text(fact.tool, 160, stats),
    status: text(fact.status, 80, stats),
    agent: text(fact.agent, 200, stats),
    result: text(fact.result, 600, stats),
    error: text(error?.message, 600, stats),
    route,
    observations,
    payloadAvailable: row.payload !== null,
    ...(requestedFiles ? { fileTargets: requestedFiles } : {}),
  }
}

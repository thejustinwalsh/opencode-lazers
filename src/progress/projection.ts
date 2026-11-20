import type { ProgressReportRow as ProgressRow } from "../runner/store.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { publicProgressError, visibleProgressText } from "./privacy.ts"

type JsonObject = Record<string, unknown>
const EPOCH_MILLIS = "unix-epoch-ms" as const

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function epochMillis(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
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

const TIMING_ENDPOINT_MEANINGS: Record<string, readonly [string, string][]> = {
  tool: [
    ["inputAt", "Tool input-started boundary"],
    ["calledAt", "Tool call boundary; not proof that the tool executed"],
    ["completedAt", "Tool result terminal boundary"],
  ],
  step: [
    ["startedAt", "Assistant request dispatch/start boundary"],
    ["streamedAt", "Provider response-body end before tool settlement"],
    ["completedAt", "Assistant step terminal boundary after tool settlement"],
  ],
  "provider-retry": [["scheduledAt", "Provider retry scheduled boundary"]],
  shell: [
    ["createdAt", "Retained shell message creation; not process start"],
    ["startedAt", "Shell process start boundary"],
    ["completedAt", "Shell process completion boundary"],
  ],
  verification: [
    ["startedAt", "LAZERS verification command start time"],
    ["completedAt", "LAZERS verification command completion time"],
  ],
}

function projectedTiming(kind: string, value: unknown, stats: ReturnType<typeof privacyStats>) {
  const allowlist = TIMING_ENDPOINT_MEANINGS[kind]
  if (!allowlist) return undefined
  const timing = object(value)
  const endpoints = object(timing?.endpoints) ?? {}
  const sources = new Set(["native-event", "recovery", "runtime"])
  return {
    unit: EPOCH_MILLIS,
    endpoints: Object.fromEntries(
      allowlist.map(([key, meaning]) => {
        const endpoint = object(endpoints[key])
        const at = epochMillis(endpoint?.at)
        const source = typeof endpoint?.source === "string" ? endpoint.source : null
        const valid = at !== null && source !== null && sources.has(source)
        return [
          key,
          {
            at: valid ? at : null,
            source: valid ? source : null,
            sourceType:
              valid && typeof endpoint?.sourceType === "string"
                ? safeText(endpoint.sourceType, stats, 120)
                : null,
            meaning,
          },
        ]
      }),
    ),
  }
}

function projectedProvenance(value: unknown, stats: ReturnType<typeof privacyStats>) {
  const provenance = object(value)
  if (!provenance) return null
  const source = string(provenance.source)
  return {
    source:
      source === "native-event" ||
      source === "recovery" ||
      source === "runtime" ||
      source === "tool-hook"
        ? source
        : null,
    sourceType:
      typeof provenance.sourceType === "string"
        ? safeText(provenance.sourceType, stats, 120)
        : null,
  }
}

function projectedExecution(value: unknown, stats: ReturnType<typeof privacyStats>) {
  const execution = object(value)
  if (!execution) return null
  const status = string(execution.status)
  if (status !== "executed" && status !== "not-executed" && status !== "unknown") return null
  const source = string(execution.source)
  return {
    status,
    source:
      source === "native-event" || source === "recovery" || source === "runtime" ? source : null,
    sourceType:
      typeof execution.sourceType === "string" ? safeText(execution.sourceType, stats, 120) : null,
    meaning: typeof execution.meaning === "string" ? safeText(execution.meaning, stats, 240) : null,
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
  const projected = {
    providerID: safeText(route.providerID, stats, 200),
    modelID: safeText(route.modelID, stats, 300),
    variant: typeof route.variant === "string" ? safeText(route.variant, stats, 200) : null,
  }
  const identity = object(route.identity)
  const explicitIdentityLost =
    Object.hasOwn(route, "identity") &&
    (!identity ||
      identity.providerID !== route.providerID ||
      identity.modelID !== route.modelID ||
      identity.variant !== (typeof route.variant === "string" ? route.variant : null))
  const invalidVariant =
    route.variant !== undefined && route.variant !== null && typeof route.variant !== "string"
  const sanitizedIdentityLost = [projected.providerID, projected.modelID, projected.variant].some(
    (part) => part?.endsWith("…[truncated]") || part?.includes("[REDACTED]"),
  )
  return {
    ...projected,
    ...(explicitIdentityLost || invalidVariant || sanitizedIdentityLost ? { identity: null } : {}),
  }
}

function projectedRouteEvidence(value: unknown, stats: ReturnType<typeof privacyStats>) {
  const evidence = object(value)
  if (!evidence) return null
  if (evidence.status !== "observed") {
    const route = projectedRoute(evidence.route, stats)
    return { status: "identity-unavailable", ...(route ? { route } : {}) }
  }
  const route = projectedRoute(evidence.route, stats)
  return route && !Object.hasOwn(route, "identity")
    ? { status: "observed", route }
    : { status: "identity-unavailable" }
}

function projectedObservations(value: unknown, stats: ReturnType<typeof privacyStats>) {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    const observation = object(raw)
    if (
      !observation ||
      (observation.source !== "native-event" && observation.source !== "recovery") ||
      typeof observation.eventType !== "string"
    )
      return []
    return [
      (() => {
        const route = projectedRoute(observation.route, stats)
        const routeEvidence = projectedRouteEvidence(observation.routeEvidence, stats)
        const explicitEvidenceLost =
          Object.hasOwn(observation, "routeEvidence") && !object(observation.routeEvidence)
        const legacyRouteInvalid =
          (Object.hasOwn(observation, "route") && observation.route === null) ||
          (observation.route !== undefined && observation.route !== null && route === null)
        return {
          source: observation.source,
          eventID:
            typeof observation.eventID === "string"
              ? safeText(observation.eventID, stats, 200)
              : null,
          eventType: safeText(observation.eventType, stats, 120),
          at: epochMillis(observation.at),
          status: string(observation.status),
          messageID:
            typeof observation.messageID === "string"
              ? safeText(observation.messageID, stats, 200)
              : null,
          callID:
            typeof observation.callID === "string"
              ? safeText(observation.callID, stats, 200)
              : null,
          agent:
            typeof observation.agent === "string" ? safeText(observation.agent, stats, 200) : null,
          tool:
            typeof observation.tool === "string" ? safeText(observation.tool, stats, 160) : null,
          route,
          routeEvidence:
            routeEvidence ??
            (explicitEvidenceLost || legacyRouteInvalid
              ? { status: "identity-unavailable" }
              : null),
          startedAt: epochMillis(observation.startedAt),
          unit: observation.unit === "unix-epoch-ms" ? "unix-epoch-ms" : null,
          meaning:
            typeof observation.meaning === "string"
              ? safeText(observation.meaning, stats, 240)
              : null,
        }
      })(),
    ]
  })
}

function projectedFileTargets(value: unknown) {
  const targets = object(value)
  if (!targets) return undefined
  const operation =
    targets.operation === "read" || targets.operation === "edit" || targets.operation === "patch"
      ? targets.operation
      : null
  const coverage =
    targets.coverage === "observed" ||
    targets.coverage === "partial" ||
    targets.coverage === "omitted"
      ? targets.coverage
      : "omitted"
  const rawPaths = Array.isArray(targets.paths) ? targets.paths : []
  const paths: string[] = []
  let invalid = !operation || !Array.isArray(targets.paths) || rawPaths.length > 8
  const hasControlCharacters = (value: string) =>
    [...value].some((character) => {
      const code = character.codePointAt(0)!
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    })
  for (const raw of rawPaths.slice(0, 8)) {
    if (
      typeof raw !== "string" ||
      !raw ||
      raw.length > 512 ||
      raw.startsWith("/") ||
      raw.includes("\\") ||
      /^[a-z][a-z\d+.-]*:/iu.test(raw) ||
      hasControlCharacters(raw) ||
      raw.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      invalid = true
      continue
    }
    if (!paths.includes(raw)) paths.push(raw)
  }
  const projectedCoverage =
    paths.length === 0 ? "omitted" : invalid || coverage === "partial" ? "partial" : coverage
  return { coverage: projectedCoverage, operation, paths }
}

function baseProgressView(
  row: ProgressRow,
  recordedAt: number | null,
  stats: ReturnType<typeof privacyStats>,
): Record<string, unknown> {
  return {
    id: `progress:${row.seq}`,
    sequence: row.seq,
    at: row.at,
    recordedAt,
    recording: {
      recordedAt,
      unit: EPOCH_MILLIS,
      source: "runner-progress-store",
      meaning: "Local persistence/change time; not a native execution endpoint",
    },
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
}

function projectedUsage(value: JsonObject) {
  const usage = object(value.usage)
  if (!usage) return null
  return {
    input: number(usage.input),
    output: number(usage.output),
    reasoning: number(usage.reasoning),
    cacheRead: number(usage.cacheRead),
    cacheWrite: number(usage.cacheWrite),
    costUSD: number(usage.costUSD),
  }
}

function applyProjectedError(
  view: Record<string, unknown>,
  value: JsonObject,
  stats: ReturnType<typeof privacyStats>,
) {
  if (value.error !== undefined) view.error = publicProgressError(value.error, stats)
}

function isLegacyRouteInvalid(value: JsonObject, legacyRoute: unknown): boolean {
  if (Object.hasOwn(value, "route") && value.route === null) return true
  if (value.route !== undefined && value.route !== null && legacyRoute === null) return true
  return false
}

function resolveStepRoutes(
  value: JsonObject,
  stats: ReturnType<typeof privacyStats>,
): { route: unknown; routeEvidence: unknown } {
  const routeEvidence = projectedRouteEvidence(value.routeEvidence, stats)
  const explicitEvidenceLost = Object.hasOwn(value, "routeEvidence") && !object(value.routeEvidence)
  const legacyRoute = projectedRoute(value.route, stats)
  const legacyRouteInvalid = isLegacyRouteInvalid(value, legacyRoute)
  return {
    routeEvidence:
      routeEvidence ??
      (explicitEvidenceLost || legacyRouteInvalid ? { status: "identity-unavailable" } : null),
    route:
      object(routeEvidence)?.route ?? (routeEvidence || legacyRouteInvalid ? null : legacyRoute),
  }
}

function applyCommentary(
  view: Record<string, unknown>,
  value: JsonObject,
  stats: ReturnType<typeof privacyStats>,
) {
  // The whole stored note; a panel that wants a short form derives it when it displays this.
  view.text =
    typeof value.text === "string" ? safeText(value.text, stats, Number.POSITIVE_INFINITY) : ""
}

function applyTool(
  view: Record<string, unknown>,
  value: JsonObject,
  kind: string,
  stats: ReturnType<typeof privacyStats>,
) {
  view.tool = typeof value.tool === "string" ? safeText(value.tool, stats, 160) : null
  view.status = string(value.status)
  if (typeof value.detail === "string") view.detail = safeText(value.detail, stats, 200)
  view.callStatus = value.callStatus === "called" ? "called" : null
  view.statusProvenance = projectedProvenance(value.statusProvenance, stats)
  view.execution = projectedExecution(value.execution, stats)
  view.timing = projectedTiming(kind, value.timing, stats)
  if (typeof value.content === "string") view.result = visibleProgressText(value.content, stats)
  // Legacy arbitrary structured output is not exported either.
  applyProjectedError(view, value, stats)
  view.observations = projectedObservations(value.observations, stats)
  if (Object.hasOwn(value, "fileTargets"))
    view.fileTargets = projectedFileTargets(value.fileTargets) ?? {
      coverage: "omitted",
      operation: null,
      paths: [],
    }
}

function applyVisibleText(
  view: Record<string, unknown>,
  value: JsonObject,
  stats: ReturnType<typeof privacyStats>,
) {
  view.text = typeof value.text === "string" ? safeText(value.text, stats) : ""
  if (value.messageType === "user" || value.messageType === "synthetic") {
    view.kind = value.messageType
    view.messageType = value.messageType
    view.createdAt = epochMillis(value.createdAt)
    view.at = view.createdAt
  }
}

function applyStep(
  view: Record<string, unknown>,
  value: JsonObject,
  kind: string,
  stats: ReturnType<typeof privacyStats>,
) {
  view.status = string(value.status)
  view.statusProvenance = projectedProvenance(value.statusProvenance, stats)
  view.timing = projectedTiming(kind, value.timing, stats)
  view.finish = string(value.finish)
  view.measurementBasis = string(value.measurementBasis)
  view.agent = typeof value.agent === "string" ? safeText(value.agent, stats, 200) : null
  const resolved = resolveStepRoutes(value, stats)
  view.routeEvidence = resolved.routeEvidence
  view.route = resolved.route
  view.observations = projectedObservations(value.observations, stats)
  view.usage = projectedUsage(value)
  applyProjectedError(view, value, stats)
}

function applyUsageSnapshot(view: Record<string, unknown>, value: JsonObject) {
  view.measurementBasis = string(value.measurementBasis)
  view.usage = projectedUsage(value)
  view.additive = false
}

function applyProviderRetry(
  view: Record<string, unknown>,
  value: JsonObject,
  kind: string,
  stats: ReturnType<typeof privacyStats>,
) {
  view.attempt = number(value.attempt)
  view.timing = projectedTiming(kind, value.timing, stats)
  applyProjectedError(view, value, stats)
}

function applyExecutionOutcome(
  view: Record<string, unknown>,
  value: JsonObject,
  stats: ReturnType<typeof privacyStats>,
) {
  view.outcome = string(value.outcome)
  view.basis = string(value.basis)
  applyProjectedError(view, value, stats)
  if (typeof value.reason === "string") view.reason = safeText(value.reason, stats, 500)
}

function applyOutcomeSnapshot(view: Record<string, unknown>, value: JsonObject) {
  view.outcome = string(value.outcome)
  view.basis = "cumulative-session-outcome-snapshot"
  view.additive = false
  view.turnIdentity = "unavailable"
}

function applyShell(
  view: Record<string, unknown>,
  value: JsonObject,
  kind: string,
  stats: ReturnType<typeof privacyStats>,
) {
  view.shellID = typeof value.shellID === "string" ? safeText(value.shellID, stats, 128) : null
  view.command = typeof value.command === "string" ? safeText(value.command, stats) : null
  view.status = string(value.status)
  view.exit = number(value.exit)
  if (typeof value.output === "string") view.output = safeText(value.output, stats)
  view.truncated = value.truncated === true
  view.timing = projectedTiming(kind, value.timing, stats)
}

function applyVerification(
  view: Record<string, unknown>,
  value: JsonObject,
  kind: string,
  stats: ReturnType<typeof privacyStats>,
) {
  view.checkID = typeof value.checkID === "string" ? safeText(value.checkID, stats, 120) : "unknown"
  view.result = string(value.result)
  view.exitCode = number(value.exitCode)
  view.startedAt = epochMillis(value.startedAt)
  view.endedAt = epochMillis(value.endedAt)
  view.timing = projectedTiming(kind, value.timing, stats)
  view.timedOut = typeof value.timedOut === "boolean" ? value.timedOut : null
  view.unchanged = typeof value.unchanged === "boolean" ? value.unchanged : null
  if (typeof value.artifact === "string") view.artifact = safeText(value.artifact, stats, 128)
  if (typeof value.command === "string") view.command = safeText(value.command, stats)
  applyProjectedError(view, value, stats)
}

function applyArtifact(
  view: Record<string, unknown>,
  value: JsonObject,
  stats: ReturnType<typeof privacyStats>,
) {
  view.commit = typeof value.commit === "string" ? safeText(value.commit, stats, 128) : null
}

function applyGap(
  view: Record<string, unknown>,
  value: JsonObject,
  stats: ReturnType<typeof privacyStats>,
) {
  view.reason =
    typeof value.reason === "string" ? safeText(value.reason, stats, 500) : "Unknown recovery gap"
}

function applyReminder(
  view: Record<string, unknown>,
  value: JsonObject,
  stats: ReturnType<typeof privacyStats>,
) {
  view.text = typeof value.text === "string" ? safeText(value.text, stats, 500) : ""
  view.delivery = string(value.delivery)
  view.observedAt = epochMillis(value.reconciledAt)
  view.nativeEventID =
    typeof value.nativeEventID === "string" ? safeText(value.nativeEventID, stats, 200) : null
}

/** Fail-closed trajectory view; stored native or model payloads are never copied wholesale. */
export function projectProgressFact(row: ProgressRow): Record<string, unknown> {
  const stats = privacyStats()
  const value = payload(row)
  const recordedAt = epochMillis(row.recorded_at)
  const view = baseProgressView(row, recordedAt, stats)

  switch (row.kind) {
    case "commentary":
      applyCommentary(view, value, stats)
      break
    case "tool":
      applyTool(view, value, row.kind, stats)
      break
    case "visible-text":
      applyVisibleText(view, value, stats)
      break
    case "step":
      applyStep(view, value, row.kind, stats)
      break
    case "usage-snapshot":
      applyUsageSnapshot(view, value)
      break
    case "provider-retry":
      applyProviderRetry(view, value, row.kind, stats)
      break
    case "execution-outcome":
      applyExecutionOutcome(view, value, stats)
      break
    case "outcome-snapshot":
      applyOutcomeSnapshot(view, value)
      break
    case "shell":
      applyShell(view, value, row.kind, stats)
      break
    case "verification":
      applyVerification(view, value, row.kind, stats)
      break
    case "artifact":
      applyArtifact(view, value, stats)
      break
    case "gap":
      applyGap(view, value, stats)
      break
    case "reminder":
      applyReminder(view, value, stats)
      break
    default:
      view.kind = "worker-unknown"
      break
  }
  return view
}

import { createHash } from "node:crypto"
import { projectProgressFact } from "../progress/projection.ts"
import type { ProgressRow } from "../runner/store.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import {
  LiveHistoryInput,
  LiveHistoryOutput,
  LiveRadarInput,
  LiveRadarOutput,
  type LiveHistoryRequestInput,
  type LiveHistoryResponse,
  type LiveRadarRequestInput,
  type LiveRadarResponse,
} from "./contract.ts"
import type { NativeSignal, ObservationChangeTracker } from "./changes.ts"
import type { RadarNativeSession, RadarSessionHost } from "./native.ts"
import {
  LIVE_LIMITS,
  LiveReadStore,
  type LiveProgressRow,
  type LiveSourceSnapshot,
} from "./live-store.ts"
import type { RunnerStore } from "../runner/store.ts"
import { schedulerProjectKey, sharedScheduler } from "../runner/scheduler-coordinator.ts"

type JsonObject = Record<string, unknown>
type SessionCandidate = { id: string; directory: string | null; native?: RadarNativeSession }
const TRUNCATION_SUFFIX = "…[truncated]"

function contractText(value: string, stats: ReturnType<typeof privacyStats>, maximum: number) {
  const sanitized = safeText(value, stats, Number.MAX_SAFE_INTEGER)
  if (sanitized.length <= maximum) return sanitized
  stats.truncated++
  const bodyLength = Math.max(0, maximum - TRUNCATION_SUFFIX.length)
  let body = sanitized.slice(0, bodyLength)
  const last = body.charCodeAt(body.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) body = body.slice(0, -1)
  return `${body}${TRUNCATION_SUFFIX}`
}

function jsonBytesAtMost(value: unknown, maximum: number): { bytes: number; overflow: boolean } {
  let bytes = 0
  const add = (amount: number) => {
    bytes += amount
    return bytes <= maximum
  }
  const visit = (item: unknown): boolean => {
    if (item === null) return add(4)
    if (typeof item === "string") {
      if (!add(2)) return false
      for (const character of item) {
        const code = character.codePointAt(0)!
        const size =
          code === 0x22 || code === 0x5c
            ? 2
            : code < 0x20
              ? [8, 9, 10, 12, 13].includes(code)
                ? 2
                : 6
              : character.length === 1 && code >= 0xd800 && code <= 0xdfff
                ? 6
                : code <= 0x7f
                  ? 1
                  : code <= 0x7ff
                    ? 2
                    : code <= 0xffff
                      ? 3
                      : 4
        if (!add(size)) return false
      }
      return true
    }
    if (typeof item === "boolean") return add(item ? 4 : 5)
    if (typeof item === "number")
      return add(Number.isFinite(item) ? JSON.stringify(item).length : 4)
    if (Array.isArray(item)) {
      if (!add(2)) return false
      for (let index = 0; index < item.length; index++) {
        if (index && !add(1)) return false
        if (!visit(item[index])) return false
      }
      return true
    }
    if (typeof item === "object") {
      const entries = Object.entries(item)
      if (!add(2)) return false
      for (let index = 0; index < entries.length; index++) {
        if (index && !add(1)) return false
        if (!visit(entries[index]![0]) || !add(1) || !visit(entries[index]![1])) return false
      }
      return true
    }
    return add(4)
  }
  const complete = visit(value)
  return { bytes: Math.min(bytes, maximum), overflow: !complete }
}

function measuredResponseBytes<T extends { coverage: { responseBytes: number } }>(response: T) {
  const encoder = new TextEncoder()
  let bytes = 0
  for (let iteration = 0; iteration < 8; iteration++) {
    response.coverage.responseBytes = bytes
    const measured = encoder.encode(JSON.stringify(response)).byteLength
    if (measured === bytes) return measured
    bytes = measured
  }
  response.coverage.responseBytes = bytes
  return encoder.encode(JSON.stringify(response)).byteLength
}

function dropUnreturnedRoutes(response: LiveRadarResponse) {
  const routeIDs = new Set(response.routes.map((route) => route.id))
  for (const session of response.sessions) {
    if (session.selectedRouteID && !routeIDs.has(session.selectedRouteID)) {
      session.selectedRouteID = null
      session.routeCoverage.selected = "truncated"
    }
    if (session.configuredRouteID && !routeIDs.has(session.configuredRouteID)) {
      session.configuredRouteID = null
      session.routeCoverage.configured = "truncated"
    }
    if (session.observedRouteID && !routeIDs.has(session.observedRouteID)) {
      session.observedRouteID = null
      session.routeCoverage.observed = "truncated"
    }
  }
  const returnedRoute = (id: string | null) =>
    id?.startsWith("route:live:") && !routeIDs.has(id) ? null : id
  for (const edge of response.flow) {
    edge.from = returnedRoute(edge.from)
    edge.to = returnedRoute(edge.to)
    edge.routeID = returnedRoute(edge.routeID)
  }
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function jsonObject(value: string | null) {
  if (value === null) return null
  try {
    return object(JSON.parse(value))
  } catch {
    return null
  }
}

function stableToken(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function sessionNodeID(sessionID: string) {
  return `session:${stableToken(sessionID)}`
}

function safeRoute(value: unknown, stats: ReturnType<typeof privacyStats>) {
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

function nativeMetadataBytes(session: RadarNativeSession, maximum: number) {
  return jsonBytesAtMost(
    {
      id: session.id,
      projectID: session.projectID,
      parentID: session.parentID,
      directory: session.directory,
      agent: session.agent,
      model: session.model,
      archived: session.archived,
      busy: session.busy,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    maximum,
  )
}

function configuredRoute(policy: string | null, stats: ReturnType<typeof privacyStats>) {
  const value = jsonObject(policy)
  return safeRoute(value?.model, stats)
}

function routeID(
  source: "attempt-policy" | "session-selection" | "step-event",
  sessionID: string,
  attemptID: string | null,
  messageID: string | null,
  eventID: string | null,
  route: { providerID: string; modelID: string; variant: string | null },
) {
  const identity = JSON.stringify([source, sessionID, attemptID, messageID, eventID, route])
  return `route:live:${source}:${stableToken(identity)}`
}

function numeric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function text(value: unknown, maximum: number, stats: ReturnType<typeof privacyStats>) {
  return typeof value === "string" ? contractText(value, stats, maximum) : null
}

function factFor(row: LiveProgressRow) {
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

function observationList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const observation = object(item)
    if (!observation || typeof observation.eventType !== "string") return []
    return [observation]
  })
}

function getEndpoint(fact: JsonObject, name: string) {
  const timing = object(fact.timing)
  const endpoints = object(timing?.endpoints)
  const endpoint = object(endpoints?.[name])
  return numeric(endpoint?.at)
}

function executionStatus(fact: JsonObject): "executed" | "not-executed" | "unknown" | null {
  const execution = object(fact.execution)
  if (
    execution?.status === "executed" ||
    execution?.status === "not-executed" ||
    execution?.status === "unknown"
  )
    return execution.status
  return null
}

function toolStatus(
  fact: JsonObject,
): "input-started" | "running" | "not-executed" | "succeeded" | "failed" | "unknown" {
  if (
    fact.status === "input-started" ||
    fact.status === "running" ||
    fact.status === "not-executed" ||
    fact.status === "succeeded" ||
    fact.status === "failed"
  )
    return fact.status
  return "unknown"
}

function fileTargets(value: unknown):
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

function latestNativeObservation(observations: JsonObject[]) {
  return observations
    .filter((observation) => observation.source === "native-event")
    .toSorted((left, right) => (numeric(left.at) ?? 0) - (numeric(right.at) ?? 0))
    .at(-1)
}

function routeFromObservation(observation: JsonObject, stats: ReturnType<typeof privacyStats>) {
  if (Object.hasOwn(observation, "routeEvidence")) {
    const evidence = object(observation.routeEvidence)
    return evidence?.status === "observed" ? safeRoute(evidence.route, stats) : null
  }
  return safeRoute(observation.route, stats)
}

function addLiveRoute(
  sourceName: "attempt-policy" | "session-selection" | "step-event",
  sessionID: string,
  attemptID: string | null,
  messageID: string | null,
  eventID: string | null,
  at: number | null,
  route: { providerID: string; modelID: string; variant: string | null },
  routes: LiveRadarResponse["routes"],
  byID: Map<string, LiveRadarResponse["routes"][number]>,
  stats: ReturnType<typeof privacyStats>,
  onTruncated: () => void,
) {
  const id = routeID(sourceName, sessionID, attemptID, messageID, eventID, route)
  if (byID.has(id)) return id
  if (routes.length >= 256) {
    onTruncated()
    return null
  }
  const item = {
    id,
    ...route,
    source: sourceName,
    sessionID,
    attemptID,
    messageID,
    eventID,
    observedAt: at,
  }
  byID.set(id, item)
  routes.push(item)
  return id
}

function toNativeObservations(
  session: RadarNativeSession,
  source: LiveSourceSnapshot,
  routes: LiveRadarResponse["routes"],
  routeByID: Map<string, LiveRadarResponse["routes"][number]>,
  calls: LiveRadarResponse["calls"],
  flow: LiveRadarResponse["flow"],
  stats: ReturnType<typeof privacyStats>,
  flags: { routeTruncated: boolean; flowTruncated: boolean; callsTruncated: boolean },
) {
  const assignment = source.assignments.get(session.id)
  if (!assignment)
    return {
      configuredRouteID: null,
      observedRouteID: null,
      routeCoverage: {
        configured: "not-assigned" as const,
        observed: "not-observed" as const,
      },
    }

  const sessionProgress = source.progress.get(session.id) ?? []
  const routesByMessage = new Map<string, string | null>()
  let latestObservedRoute: { id: string | null; at: number } | undefined
  let observedEvidenceMissing = false
  for (const row of sessionProgress.toReversed()) {
    if (row.kind !== "step" || row.payload === null) continue
    const fact = factFor(row)
    const observations = observationList(fact.observations)
    for (const observation of observations) {
      const eventType = observation.eventType
      if (
        ![
          "session.step.started",
          "session.step.streamed",
          "session.step.ended",
          "session.step.failed",
        ].includes(String(eventType))
      )
        continue
      const eventID = text(observation.eventID, 200, stats)
      const messageID = text(observation.messageID ?? fact.messageID, 200, stats)
      const observedAt = numeric(observation.at)
      if (eventType === "session.step.started") {
        const route = routeFromObservation(observation, stats)
        const id = route
          ? addLiveRoute(
              "step-event",
              session.id,
              assignment.attemptID,
              messageID,
              eventID,
              observedAt,
              route,
              routes,
              routeByID,
              stats,
              () => (flags.routeTruncated = true),
            )
          : null
        if (messageID) routesByMessage.set(messageID, id)
        if (!route) observedEvidenceMissing = true
        const routeAt = observedAt ?? row.recorded_at ?? row.at
        if (!latestObservedRoute || routeAt >= latestObservedRoute.at)
          latestObservedRoute = { id, at: routeAt }
      }
      if (observedAt === null) continue
      const routeIDForMessage = messageID ? (routesByMessage.get(messageID) ?? null) : null
      const kind =
        eventType === "session.step.started"
          ? "model-request"
          : eventType === "session.step.streamed"
            ? "model-stream"
            : "model-response"
      const sessionIDNode = sessionNodeID(session.id)
      const from = kind === "model-request" ? sessionIDNode : routeIDForMessage
      const to = kind === "model-request" ? routeIDForMessage : sessionIDNode
      if (flow.length >= 256) {
        flags.flowTruncated = true
        continue
      }
      flow.push({
        id: `flow:${stableToken(`${row.seq}:${eventID ?? ""}:${kind}`)}`,
        kind,
        source: "progress",
        from,
        to,
        sessionID: session.id,
        messageID,
        callID: null,
        tool: null,
        agent: null,
        routeID: routeIDForMessage,
        toolID: null,
        status: contractText(String(observation.status ?? "unknown"), stats, 32),
        startedAt:
          numeric(observation.startedAt) ??
          (kind === "model-request" ? getEndpoint(fact, "startedAt") : null),
        observedAt,
        sourceProgressSequence: row.seq,
        sourceNativeRevision: null,
        sourceEventID: eventID,
        sourceEventType: contractText(String(eventType), stats, 120),
      })
    }
  }

  const policyRoute = configuredRoute(assignment.policy, stats)
  const configuredRouteID = policyRoute
    ? addLiveRoute(
        "attempt-policy",
        session.id,
        assignment.attemptID,
        null,
        null,
        null,
        policyRoute,
        routes,
        routeByID,
        stats,
        () => (flags.routeTruncated = true),
      )
    : null

  for (const row of sessionProgress) {
    if (row.kind !== "tool" || row.call_id === null || row.payload === null) continue
    const fact = factFor(row)
    const observations = observationList(fact.observations)
    const latest = latestNativeObservation(observations)
    const callID = text(fact.callID ?? row.call_id, 200, stats)
    if (!callID) continue
    const messageID = text(fact.messageID ?? row.message_id, 200, stats)
    const toolName = text(fact.tool, 160, stats)
    const id = `call:${stableToken(`${session.id}:${assignment.attemptID}:${callID}`)}`
    if (calls.some((call) => call.id === id)) continue
    if (calls.length >= 256) {
      flags.callsTruncated = true
      continue
    }
    const status = toolStatus(fact)
    const phaseEventID = text(latest?.eventID, 200, stats)
    const phaseEventType = text(latest?.eventType, 120, stats)
    const phaseObservedAt = numeric(latest?.at) ?? row.recorded_at ?? row.at
    const toolID = toolName ? `tool:${stableToken(toolName)}` : null
    const terminalEvent =
      phaseEventType === "session.tool.success" || phaseEventType === "session.tool.failed"
    const sessionIDNode = sessionNodeID(session.id)
    if (latest && flow.length >= 256) flags.flowTruncated = true
    else if (latest)
      flow.push({
        id: `flow:${stableToken(`${row.seq}:tool-phase`)}`,
        kind: "tool-phase",
        source: "progress",
        from: phaseEventType ? (terminalEvent ? toolID : sessionIDNode) : null,
        to: phaseEventType ? (terminalEvent ? sessionIDNode : toolID) : null,
        sessionID: session.id,
        messageID,
        callID,
        tool: toolName,
        agent: null,
        routeID: null,
        toolID,
        status: contractText(String(latest.status ?? status), stats, 32),
        startedAt: getEndpoint(fact, "inputAt") ?? getEndpoint(fact, "calledAt"),
        observedAt: phaseObservedAt,
        sourceProgressSequence: row.seq,
        sourceNativeRevision: null,
        sourceEventID: phaseEventID,
        sourceEventType: phaseEventType,
      })

    const error = object(fact.error)
    const requestedFiles = fileTargets(fact.fileTargets)
    calls.push({
      id,
      sessionID: session.id,
      attemptID: assignment.attemptID,
      messageID,
      callID,
      tool: toolName,
      status,
      execution: executionStatus(fact),
      inputAt: getEndpoint(fact, "inputAt"),
      calledAt: getEndpoint(fact, "calledAt"),
      completedAt: getEndpoint(fact, "completedAt"),
      observedAt: numeric(latest?.at) ?? row.recorded_at ?? row.at,
      sourceProgressSequence: row.seq,
      sourceEventID: phaseEventID,
      sourceEventType: phaseEventType,
      result: text(fact.result, 240, stats),
      error: text(error?.message, 240, stats),
      payloadAvailable: true,
      ...(requestedFiles ? { fileTargets: requestedFiles } : {}),
    })
  }

  return {
    configuredRouteID,
    observedRouteID: latestObservedRoute?.id ?? null,
    routeCoverage: {
      configured: !policyRoute
        ? ("unavailable" as const)
        : configuredRouteID
          ? ("available" as const)
          : ("truncated" as const),
      observed: latestObservedRoute?.id
        ? ("available" as const)
        : observedEvidenceMissing
          ? ("identity-unavailable" as const)
          : latestObservedRoute
            ? ("truncated" as const)
            : ("not-observed" as const),
    },
  }
}

function toUnassignedNativeSignals(
  sessionID: string,
  signals: readonly NativeSignal[],
  routes: LiveRadarResponse["routes"],
  routeByID: Map<string, LiveRadarResponse["routes"][number]>,
  flow: LiveRadarResponse["flow"],
  stats: ReturnType<typeof privacyStats>,
  flags: { routeTruncated: boolean; flowTruncated: boolean; callsTruncated: boolean },
) {
  let latestObservedRoute: { id: string | null; at: number } | undefined

  for (const signal of signals) {
    if (signal.sessionID !== sessionID) continue
    let routeIDForSignal: string | null = null
    if (signal.eventType === "session.step.started") {
      const route = safeRoute(
        {
          providerID: signal.providerID,
          modelID: signal.modelID,
          variant: signal.variant,
        },
        stats,
      )
      if (route && signal.messageID) {
        routeIDForSignal = addLiveRoute(
          "step-event",
          sessionID,
          null,
          signal.messageID,
          signal.eventID,
          signal.observedAt,
          route,
          routes,
          routeByID,
          stats,
          () => (flags.routeTruncated = true),
        )
        latestObservedRoute = { id: routeIDForSignal, at: signal.observedAt }
      } else {
        latestObservedRoute = { id: null, at: signal.observedAt }
      }
    }

    const kind = signal.eventType.startsWith("session.tool.")
      ? "tool-phase"
      : signal.eventType.startsWith("session.execution.")
        ? "execution"
        : signal.eventType === "session.step.started"
          ? "model-request"
          : signal.eventType === "session.step.streamed"
            ? "model-stream"
            : "model-response"
    if (flow.length >= 256) {
      flags.flowTruncated = true
      continue
    }
    const toolID = signal.tool ? `tool:${stableToken(signal.tool)}` : null
    flow.push({
      id: `flow:native:${stableToken(`${sessionID}:${signal.eventID}`)}`,
      kind,
      source: "native-event",
      from: null,
      to: null,
      sessionID,
      messageID: signal.messageID,
      callID: signal.callID,
      tool: signal.tool,
      agent: signal.agent,
      routeID: routeIDForSignal,
      toolID,
      status: contractText(signal.status, stats, 32),
      startedAt:
        signal.eventType === "session.step.started" ||
        signal.eventType === "session.execution.started" ||
        signal.eventType === "session.tool.called" ||
        signal.eventType === "session.tool.input.started"
          ? signal.observedAt
          : null,
      observedAt: signal.observedAt,
      sourceProgressSequence: null,
      sourceNativeRevision: signal.sourceNativeRevision,
      sourceEventID: signal.eventID,
      sourceEventType: contractText(signal.eventType, stats, 120),
    })
  }

  return {
    observedRouteID: latestObservedRoute?.id ?? null,
    observedRouteCoverage: latestObservedRoute?.id
      ? ("available" as const)
      : latestObservedRoute
        ? flags.routeTruncated
          ? ("truncated" as const)
          : ("identity-unavailable" as const)
        : ("not-observed" as const),
  }
}

function historyItem(row: LiveProgressRow, stats: ReturnType<typeof privacyStats>) {
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
  const routeValue =
    routeEvidence?.status === "observed" ? safeRoute(routeEvidence.route, stats) : null
  const error = object(fact.error)
  const requestedFiles = fileTargets(fact.fileTargets)
  return {
    sequence: row.seq,
    at: row.at,
    recordedAt: row.recorded_at,
    kind: contractText(String(fact.kind ?? row.kind), stats, 80),
    source: contractText(String(fact.source ?? row.source), stats, 80),
    messageID: text(fact.messageID ?? row.message_id, 200, stats),
    callID: text(fact.callID ?? row.call_id, 200, stats),
    tool: text(fact.tool, 160, stats),
    status: text(fact.status, 80, stats),
    agent: text(fact.agent, 200, stats),
    result: text(fact.result, 600, stats),
    error: text(error?.message, 600, stats),
    route: routeValue,
    observations,
    payloadAvailable: row.payload !== null,
    ...(requestedFiles ? { fileTargets: requestedFiles } : {}),
  }
}

export class LiveRadarReader {
  private readonly source: LiveReadStore
  private readonly schedulerKey: string

  constructor(
    store: RunnerStore,
    private readonly host: RadarSessionHost | undefined,
    private readonly projectID: string,
    private readonly secret: Uint8Array,
  ) {
    this.schedulerKey = schedulerProjectKey(
      store.repository.path,
      store.repository.projectDirectory,
      projectID,
    )
    this.source = new LiveReadStore(
      store.repository.path,
      store.repository.projectDirectory,
      projectID,
      secret,
    )
  }

  async radar(
    input: LiveRadarRequestInput,
    tracker: ObservationChangeTracker,
    signal: AbortSignal,
    streamEpoch: string,
  ): Promise<LiveRadarResponse> {
    const finishScopeSelection = tracker.beginScopeSelection()
    try {
      return await this.readRadar(input, tracker, signal, streamEpoch)
    } finally {
      finishScopeSelection()
    }
  }

  private async readRadar(
    input: LiveRadarRequestInput,
    tracker: ObservationChangeTracker,
    signal: AbortSignal,
    streamEpoch: string,
  ): Promise<LiveRadarResponse> {
    const trackedSessionIDs = new Set<string>()
    let trackedSessionIDsTruncated = false
    const trackSessions = (
      tracker: ObservationChangeTracker,
      sessionIDs: Iterable<string>,
      preferredSessionID?: string,
    ) => {
      const incoming = [...new Set(sessionIDs)]
      const preferred = preferredSessionID ? incoming.indexOf(preferredSessionID) : -1
      if (preferred >= 0) incoming.splice(preferred, 1)
      for (const sessionID of incoming) {
        trackedSessionIDs.delete(sessionID)
        trackedSessionIDs.add(sessionID)
        if (trackedSessionIDs.size > LIVE_LIMITS.retainedStateEntries) {
          trackedSessionIDs.delete(trackedSessionIDs.values().next().value!)
          trackedSessionIDsTruncated = true
        }
      }
      if (preferredSessionID) {
        trackedSessionIDs.delete(preferredSessionID)
        trackedSessionIDs.add(preferredSessionID)
        if (trackedSessionIDs.size > LIVE_LIMITS.retainedStateEntries) {
          const evictable = [...trackedSessionIDs].find((id) => id !== preferredSessionID)
          if (evictable) trackedSessionIDs.delete(evictable)
          trackedSessionIDsTruncated = true
        }
      }
      // Event interest spans visible panel scopes; coverage belongs only to this read.
      tracker.trackScopedSessions(trackedSessionIDs, preferredSessionID, { retainInterests: true })
      return trackedSessionIDs.size
    }

    const request = LiveRadarInput.parse(input)
    signal.throwIfAborted()
    const nativeRevision = tracker.nativeRevision
    const eventSequence = tracker.sequence
    const stats = privacyStats()
    let nativeInventory: LiveRadarResponse["freshness"]["nativeInventory"] = "unavailable"
    let inventoryTruncated = false
    let nativeMetadataTruncated = false
    let foreignSessionsExcluded = 0
    let viewSessionArchived = false
    let nativeInventoryReads = 0
    let nativeSessionReads = 0
    let nativeMetadataBytesInspected = 0
    const source = this.source.readCurrent(
      request.scope.kind === "session" ? request.scope.sessionID : null,
      signal,
    )
    signal.throwIfAborted()

    const managedIDs = [...source.assignments.keys()]
    trackSessions(tracker, [...managedIDs, request.scope.sessionID], request.scope.sessionID)
    const nativeByID = new Map<string, RadarNativeSession>()
    const seenNativeIDs = new Set<string>()
    const inspectNative = (session: RadarNativeSession) => {
      const remaining = LIVE_LIMITS.nativeMetadataBytes - nativeMetadataBytesInspected
      const measurement = nativeMetadataBytes(session, remaining)
      nativeMetadataBytesInspected += measurement.bytes
      if (measurement.overflow) {
        nativeMetadataTruncated = true
        inventoryTruncated = true
        nativeInventory = "bounded"
        return null
      }
      if (
        !session.id ||
        session.id.length > 200 ||
        !session.projectID ||
        session.projectID.length > 200 ||
        session.directory.length > 4096 ||
        (session.agent !== null && session.agent.length > 200)
      ) {
        nativeMetadataTruncated = true
        inventoryTruncated = true
      }
      const route = session.model
      if (
        route &&
        (route.providerID.length > 200 ||
          route.id.length > 300 ||
          (route.variant !== null && route.variant.length > 200))
      ) {
        nativeMetadataTruncated = true
        inventoryTruncated = true
      }
      if (session.projectID !== this.projectID) {
        foreignSessionsExcluded++
        return null
      }
      if (session.archived) return null
      if (!session.id || session.id.length > 200 || seenNativeIDs.has(session.id)) {
        inventoryTruncated = true
        return null
      }
      seenNativeIDs.add(session.id)
      const boundedSession = {
        ...session,
        directory: session.directory.length <= 4096 ? session.directory : "",
        agent: session.agent !== null && session.agent.length > 200 ? null : session.agent,
      }
      return boundedSession
    }
    const inventoryRows: RadarNativeSession[] = []

    if (request.scope.kind === "session") {
      nativeInventory = this.host ? "complete" : "unavailable"
      if (this.host) {
        nativeSessionReads++
        try {
          const session = await this.host.get(request.scope.sessionID, signal)
          signal.throwIfAborted()
          if (session) {
            if (session.id === request.scope.sessionID && session.archived) {
              viewSessionArchived = true
            } else {
              const boundedSession = inspectNative(session)
              if (boundedSession?.id === request.scope.sessionID)
                nativeByID.set(request.scope.sessionID, boundedSession)
              else if (boundedSession) {
                inventoryTruncated = true
                nativeInventory = "bounded"
              }
            }
          }
        } catch (error) {
          if (signal.aborted) throw error
          nativeInventory = "unavailable"
        }
      }
      if (nativeMetadataTruncated && nativeInventory === "complete") nativeInventory = "bounded"
    } else if (this.host) {
      nativeInventoryReads++
      try {
        const inventory = await this.host.project(
          this.projectID,
          false,
          LIVE_LIMITS.inventoryCandidates + 1,
          signal,
        )
        signal.throwIfAborted()
        inventoryTruncated =
          inventory.truncated || inventory.sessions.length > LIVE_LIMITS.inventoryCandidates
        nativeInventory = inventoryTruncated ? "bounded" : "complete"
        inventoryRows.push(...inventory.sessions.slice(0, LIVE_LIMITS.inventoryCandidates + 1))
      } catch (error) {
        if (signal.aborted) throw error
        nativeInventory = "unavailable"
      }

      const inventoryByID = new Map<string, RadarNativeSession>()
      for (const session of inventoryRows) {
        if (session.projectID !== this.projectID) {
          foreignSessionsExcluded++
          continue
        }
        if (!session.id || session.id.length > 200 || inventoryByID.has(session.id)) {
          inventoryTruncated = true
          continue
        }
        inventoryByID.set(session.id, session)
      }

      // The view's exact authorized session may be a human Architect outside the
      // bounded worker inventory. Fetch only this ID; never widen inventory here.
      if (nativeSessionReads < LIVE_LIMITS.nativeSessionReads) {
        nativeSessionReads++
        try {
          const current = await this.host.get(request.scope.sessionID, signal)
          signal.throwIfAborted()
          if (current) {
            if (current.id !== request.scope.sessionID) {
              inventoryTruncated = true
              nativeInventory = "bounded"
            } else if (current.archived) {
              // Archived scope is never promoted into current activity.
              viewSessionArchived = true
            } else {
              const boundedSession = inspectNative(current)
              if (boundedSession?.id === request.scope.sessionID)
                nativeByID.set(request.scope.sessionID, boundedSession)
              else if (boundedSession) {
                inventoryTruncated = true
                nativeInventory = "bounded"
              }
            }
          }
        } catch (error) {
          if (signal.aborted) throw error
          nativeInventory = "unavailable"
        }
      } else {
        inventoryTruncated = true
        nativeInventory = "bounded"
      }

      for (const sessionID of managedIDs) {
        let native = nativeByID.get(sessionID) ?? inventoryByID.get(sessionID)
        if (!native) {
          if (nativeSessionReads >= LIVE_LIMITS.nativeSessionReads) {
            inventoryTruncated = true
            nativeInventory = "bounded"
            continue
          }
          nativeSessionReads++
          try {
            native = (await this.host.get(sessionID, signal)) ?? undefined
          } catch (error) {
            if (signal.aborted) throw error
            nativeInventory = "unavailable"
            inventoryTruncated = true
            continue
          }
        }
        if (!native) continue
        const boundedSession = inspectNative(native)
        if (boundedSession?.id === sessionID) nativeByID.set(sessionID, boundedSession)
        else if (boundedSession) {
          nativeInventory = "bounded"
          inventoryTruncated = true
        }
      }

      if (request.includeUnmanagedSessions) {
        let unmanagedAdded = 0
        for (const session of inventoryRows) {
          if (managedIDs.includes(session.id)) continue
          if (session.projectID !== this.projectID) continue
          if (managedIDs.length + unmanagedAdded >= LIVE_LIMITS.sessions) {
            inventoryTruncated = true
            break
          }
          if (nativeByID.has(session.id)) continue
          const boundedSession = inspectNative(session)
          if (boundedSession) {
            nativeByID.set(boundedSession.id, boundedSession)
            unmanagedAdded++
          }
          if (nativeMetadataTruncated) break
        }
      }
      if (nativeMetadataTruncated && nativeInventory === "complete") nativeInventory = "bounded"
    }

    for (const assignment of source.assignments.values()) {
      const native = nativeByID.get(assignment.sessionID)
      if (native && !assignment.workspaceOmitted && native.directory.length > 0)
        assignment.workspaceMatches = assignment.workspace === native.directory
      else if (native && assignment.workspaceOmitted) {
        nativeMetadataTruncated = true
        inventoryTruncated = true
      }
    }

    const candidates: SessionCandidate[] = []
    if (request.scope.kind === "project") {
      const current = nativeByID.get(request.scope.sessionID)
      if (current)
        candidates.push({
          id: request.scope.sessionID,
          directory: current.directory,
          native: current,
        })
      else if (
        !viewSessionArchived &&
        !source.assignments.has(request.scope.sessionID) &&
        foreignSessionsExcluded === 0
      )
        candidates.push({ id: request.scope.sessionID, directory: null })
    }
    for (const sessionID of managedIDs) {
      if (candidates.some((candidate) => candidate.id === sessionID)) continue
      const native = nativeByID.get(sessionID)
      candidates.push({
        id: sessionID,
        directory: native?.directory ?? null,
        ...(native ? { native } : {}),
      })
    }
    if (request.scope.kind === "session") {
      if (!candidates.length && foreignSessionsExcluded === 0 && !viewSessionArchived)
        candidates.push({
          id: request.scope.sessionID,
          directory: nativeByID.get(request.scope.sessionID)?.directory ?? null,
          ...(nativeByID.has(request.scope.sessionID)
            ? { native: nativeByID.get(request.scope.sessionID)! }
            : {}),
        })
    } else if (request.includeUnmanagedSessions) {
      for (const [sessionID, native] of nativeByID) {
        if (source.assignments.has(sessionID)) continue
        if (candidates.some((candidate) => candidate.id === sessionID)) continue
        if (candidates.length >= LIVE_LIMITS.sessions) break
        candidates.push({ id: sessionID, directory: native.directory, native })
      }
    }
    inventoryTruncated ||= source.assignmentTruncated
    if (nativeSessionReads > LIVE_LIMITS.nativeSessionReads)
      throw new Error("Bounded native session reads exceeded their declared call budget")
    const boundedCandidates = candidates.slice(0, LIVE_LIMITS.sessions)
    if (candidates.length > boundedCandidates.length) inventoryTruncated = true
    let retainedStateEntries = trackSessions(
      tracker,
      boundedCandidates.map((candidate) => candidate.id),
      request.scope.sessionID,
    )
    signal.throwIfAborted()
    const liveSignalSnapshot = tracker.peekLiveSignals(
      new Set(boundedCandidates.map((candidate) => candidate.id)),
    )

    const sessionRows: LiveRadarResponse["sessions"] = []
    const routes: LiveRadarResponse["routes"] = []
    const calls: LiveRadarResponse["calls"] = []
    const flow: LiveRadarResponse["flow"] = []
    const routeByID = new Map<string, LiveRadarResponse["routes"][number]>()
    const flags = {
      routeTruncated: false,
      flowTruncated: liveSignalSnapshot.truncated,
      callsTruncated: false,
    }
    const observedAt = Date.now()

    for (const candidate of boundedCandidates) {
      signal.throwIfAborted()
      const native = candidate.native
      const assignment = source.assignments.get(candidate.id)
      if (
        request.scope.kind === "project" &&
        !request.includeUnmanagedSessions &&
        !assignment &&
        candidate.id !== request.scope.sessionID
      )
        continue
      if (native && native.projectID !== this.projectID) {
        foreignSessionsExcluded++
        continue
      }
      const moved = Boolean(assignment && native && assignment.workspaceMatches === false)
      const locationUnknown = Boolean(
        assignment && native && (assignment.workspaceOmitted || native.directory.length === 0),
      )
      const availability: LiveRadarResponse["sessions"][number]["availability"] = !native
        ? nativeInventory !== "complete"
          ? "unavailable"
          : "missing"
        : native.archived
          ? "archived"
          : locationUnknown
            ? "unavailable"
            : moved
              ? "moved"
              : "available"
      const fresh = availability === "available"
      const selectedRoute = fresh ? safeRoute(native?.model, stats) : null
      const selectedRouteID = selectedRoute
        ? addLiveRoute(
            "session-selection",
            candidate.id,
            null,
            null,
            null,
            observedAt,
            selectedRoute,
            routes,
            routeByID,
            stats,
            () => (flags.routeTruncated = true),
          )
        : null
      const sessionSignals = assignment
        ? []
        : liveSignalSnapshot.signals.filter((item) => item.sessionID === candidate.id)
      const nativeSignalState = toUnassignedNativeSignals(
        candidate.id,
        sessionSignals,
        routes,
        routeByID,
        flow,
        stats,
        flags,
      )
      const nativeRouteState = toNativeObservations(
        native ?? {
          id: candidate.id,
          projectID: this.projectID,
          parentID: null,
          directory: "",
          agent: null,
          model: null,
          archived: false,
          busy: null,
          createdAt: null,
          updatedAt: null,
        },
        source,
        routes,
        routeByID,
        calls,
        flow,
        stats,
        flags,
      )
      const routeState = {
        ...nativeRouteState,
        observedRouteID: nativeSignalState.observedRouteID ?? nativeRouteState.observedRouteID,
        routeCoverage: {
          ...nativeRouteState.routeCoverage,
          observed:
            nativeSignalState.observedRouteCoverage === "not-observed"
              ? nativeRouteState.routeCoverage.observed
              : nativeSignalState.observedRouteCoverage,
        },
      }
      sessionRows.push({
        id: sessionNodeID(candidate.id),
        sessionID: candidate.id,
        projectID: this.projectID,
        classification: assignment ? "managed" : "unmanaged",
        ...(native?.parentID && native.parentID.length <= 200
          ? { parentSessionID: native.parentID }
          : {}),
        isViewSession: candidate.id === request.scope.sessionID,
        isCurrentArchitect:
          candidate.id !== request.scope.sessionID || !native
            ? null
            : native.agent === null
              ? null
              : native.agent.trim().toLocaleLowerCase() === "architect",
        availability,
        freshness: fresh
          ? "current"
          : availability === "missing" || availability === "unavailable"
            ? "unknown"
            : "stale",
        agent: fresh && native?.agent ? contractText(native.agent, stats, 200) : null,
        state: fresh
          ? native?.busy === null
            ? "unknown"
            : native?.busy
              ? "busy"
              : "idle"
          : "unknown",
        assignment: assignment
          ? {
              planID: assignment.planID,
              taskID: assignment.taskID,
              attemptID: assignment.attemptID,
              state: assignment.state,
              startedAt: assignment.startedAt,
              ...(assignment.attemptNumber > 0 ? { attemptNumber: assignment.attemptNumber } : {}),
              ...(assignment.taskTitle
                ? { taskTitle: contractText(assignment.taskTitle, stats, 240) }
                : {}),
              ...(assignment.taskReference
                ? { taskReference: contractText(assignment.taskReference, stats, 60) }
                : {}),
            }
          : null,
        selectedRouteID,
        configuredRouteID: routeState.configuredRouteID,
        observedRouteID: routeState.observedRouteID,
        routeCoverage: {
          selected: !selectedRoute ? "unavailable" : selectedRouteID ? "available" : "truncated",
          configured: routeState.routeCoverage.configured,
          observed: routeState.routeCoverage.observed,
        },
        updatedAt: fresh ? (native?.updatedAt ?? null) : null,
        observedAt: native ? observedAt : null,
      })
    }

    sessionRows.sort((left, right) => {
      const currentArchitect =
        Number(right.isCurrentArchitect === true) - Number(left.isCurrentArchitect === true)
      if (currentArchitect) return currentArchitect
      const currentView = Number(right.isViewSession) - Number(left.isViewSession)
      if (currentView) return currentView
      const managed =
        Number(right.classification === "managed") - Number(left.classification === "managed")
      if (managed) return managed
      const busy = Number(right.state === "busy") - Number(left.state === "busy")
      if (busy) return busy
      return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    })

    const response = {
      schemaVersion: 1 as const,
      projectID: this.projectID,
      scope:
        request.scope.kind === "session"
          ? { kind: "session" as const, sessionID: request.scope.sessionID }
          : { kind: "project" as const },
      streamEpoch,
      observedAt,
      boundary: {
        runnerRevision: source.runnerRevision,
        nativeRevision,
        eventSequence,
      },
      freshness: {
        runner: source.runnerRevision === null ? ("unavailable" as const) : ("current" as const),
        nativeInventory,
        nativeEvents: tracker.hasConnectedEventStream
          ? ("connected" as const)
          : ("gap-or-unavailable" as const),
      },
      scheduler: (() => {
        try {
          const status = sharedScheduler.projectStatus(this.schedulerKey)
          return {
            status: status.status,
            participants:
              Number.isSafeInteger(status.participants) && status.participants >= 0
                ? status.participants
                : null,
          }
        } catch {
          return { status: "unknown" as const, participants: null }
        }
      })(),
      ...(source.workload ? { workload: source.workload } : {}),
      coverage: {
        sessionCount: sessionRows.length,
        managedSessionCount: sessionRows.filter((session) => session.classification === "managed")
          .length,
        includeUnmanagedSessions: request.includeUnmanagedSessions,
        inventoryTruncated,
        progressTruncated: source.progressTruncated,
        payloadTruncated: source.payloadTruncated,
        routeTruncated: flags.routeTruncated,
        flowTruncated: flags.flowTruncated,
        callsTruncated: flags.callsTruncated,
        assignmentTruncated: source.assignmentTruncated,
        journalTruncated: source.journalTruncated,
        journal: source.journal,
        foreignSessionsExcluded,
        sourceQueries: source.sourceQueries,
        sourceRowsRead: source.sourceRowsRead,
        sourceBytesRead: source.sourceBytesRead,
        sourcePayloadBytesRead: source.sourcePayloadBytesRead,
        nativeInventoryReads,
        nativeSessionReads,
        nativeMetadataBytesInspected,
        nativeMetadataTruncated,
        nativeMetadataBoundary: "raw-selected-fields-after-adapter" as const,
        nativeContextLoads: 0 as const,
        retainedStateEntries,
        retainedStateTruncated: trackedSessionIDsTruncated,
        responseBytes: 0,
      },
      limits: LIVE_LIMITS,
      sessions: sessionRows,
      routes,
      calls,
      flow,
    }

    const updateSessionCoverage = () => {
      response.coverage.sessionCount = response.sessions.length
      response.coverage.managedSessionCount = response.sessions.filter(
        (session) => session.classification === "managed",
      ).length
    }
    updateSessionCoverage()
    retainedStateEntries = trackSessions(
      tracker,
      response.sessions.map((session) => session.sessionID),
      request.scope.sessionID,
    )
    response.coverage.retainedStateEntries = retainedStateEntries
    let responseBytes = measuredResponseBytes(response)
    while (responseBytes > LIVE_LIMITS.responseBytes) {
      if (response.flow.length) {
        response.flow.pop()
        response.coverage.flowTruncated = true
      } else if (response.calls.length) {
        response.calls.pop()
        response.coverage.callsTruncated = true
      } else if (response.routes.length) {
        response.routes.pop()
        response.coverage.routeTruncated = true
      } else if (response.sessions.length) {
        response.sessions.pop()
        response.coverage.inventoryTruncated = true
      } else {
        throw new Error("Bounded live response exceeded its declared byte limit")
      }
      updateSessionCoverage()
      dropUnreturnedRoutes(response)
      retainedStateEntries = trackSessions(
        tracker,
        response.sessions.map((session) => session.sessionID),
        request.scope.sessionID,
      )
      response.coverage.retainedStateEntries = retainedStateEntries
      responseBytes = measuredResponseBytes(response)
    }
    dropUnreturnedRoutes(response)
    retainedStateEntries = trackSessions(
      tracker,
      response.sessions.map((session) => session.sessionID),
      request.scope.sessionID,
    )
    response.coverage.retainedStateEntries = retainedStateEntries
    responseBytes = measuredResponseBytes(response)
    response.coverage.responseBytes = responseBytes
    const parsed = LiveRadarOutput.parse(response)
    if (parsed.coverage.responseBytes > LIVE_LIMITS.responseBytes)
      throw new Error("Bounded live response exceeded its declared byte limit")
    return parsed
  }

  history(input: LiveHistoryRequestInput, signal: AbortSignal): LiveHistoryResponse {
    const request = LiveHistoryInput.parse(input)
    signal.throwIfAborted()
    const source = this.source.readHistory(request, signal)
    signal.throwIfAborted()
    const stats = privacyStats()
    const items = source.rows.map((row) => historyItem(row, stats)).toReversed()
    const response = {
      schemaVersion: 1 as const,
      projectID: this.projectID,
      scope:
        request.scope.kind === "session"
          ? { kind: "session" as const, sessionID: request.scope.sessionID }
          : { kind: "project" as const },
      sessionID: request.sessionID,
      attemptID: source.attemptID,
      source: "runner-progress" as const,
      runnerRevision: source.runnerRevision,
      capturedAt: Date.now(),
      items,
      nextCursor: source.nextCursor,
      limits: {
        items: 25 as const,
        payloadBytes: LIVE_LIMITS.progressPayloadBytes,
        sourceQueries: 10 as const,
        sourceRows: 40 as const,
        sourceBytes: 250_000 as const,
        responseBytes: LIVE_LIMITS.responseBytes,
      },
      coverage: {
        hasMore: source.hasMore,
        payloadTruncated: source.payloadTruncated,
        journal: source.journal,
        sourceQueries: source.sourceQueries,
        sourceRowsRead: source.sourceRowsRead,
        sourceBytesRead: source.sourceBytesRead,
        sourcePayloadBytesRead: source.sourcePayloadBytesRead,
        nativeInventoryReads: 0 as const,
        nativeContextLoads: 0 as const,
        retainedStateEntries: 0 as const,
        responseBytes: 0,
      },
    }
    response.coverage.responseBytes = measuredResponseBytes(response)
    if (response.coverage.responseBytes > LIVE_LIMITS.responseBytes)
      throw new Error("Bounded selected history exceeded its declared byte limit")
    return LiveHistoryOutput.parse(response)
  }
}

import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { relativize } from "../progress/tool-detail.ts"
import type { PathScope } from "../progress/tool-detail.ts"
import {
  contractText,
  factFor,
  fileTargets,
  numeric,
  object,
  observationList,
  progressDisplay,
  safeRoute,
  text,
  type JsonObject,
} from "../progress/display.ts"
import { privacyStats } from "../trajectory/privacy.ts"
import {
  LiveAttemptInput,
  LiveGroupInput,
  LiveGroupOutput,
  LiveAttemptOutput,
  LiveHistoryInput,
  LiveHistoryOutput,
  LiveRadarInput,
  LiveRadarOutput,
  type LiveAttemptRequestInput,
  type LiveGroupRequestInput,
  type LiveGroupResponse,
  type LiveAttemptResponse,
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
  type LiveAttemptAssignment,
  type LiveSourceSnapshot,
} from "./live-store.ts"
import type { RunnerStore } from "../runner/store.ts"
import { schedulerProjectKey, sharedScheduler } from "../runner/scheduler-coordinator.ts"

type SessionCandidate = { id: string; directory: string | null; native?: RadarNativeSession }

type JsonBudgetAdd = (amount: number) => boolean
type JsonVisit = (item: unknown) => boolean

function isJsonShortEscape(code: number): boolean {
  return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
}

function jsonControlCharByteSize(code: number): number {
  return isJsonShortEscape(code) ? 2 : 6
}

function isLoneSurrogate(character: string, code: number): boolean {
  return character.length === 1 && code >= 0xd800 && code <= 0xdfff
}

function jsonUtf8ByteSize(code: number): number {
  if (code <= 0x7f) return 1
  if (code <= 0x7ff) return 2
  if (code <= 0xffff) return 3
  return 4
}

function jsonStringCharByteSize(character: string, code: number): number {
  if (code === 0x22 || code === 0x5c) return 2
  if (code < 0x20) return jsonControlCharByteSize(code)
  if (isLoneSurrogate(character, code)) return 6
  return jsonUtf8ByteSize(code)
}

function jsonStringBytes(value: string, add: JsonBudgetAdd): boolean {
  if (!add(2)) return false
  for (const character of value) {
    const size = jsonStringCharByteSize(character, character.codePointAt(0)!)
    if (!add(size)) return false
  }
  return true
}

function jsonNumberBytes(value: number, add: JsonBudgetAdd): boolean {
  return add(Number.isFinite(value) ? JSON.stringify(value).length : 4)
}

function jsonArrayBytes(value: unknown[], add: JsonBudgetAdd, visit: JsonVisit): boolean {
  if (!add(2)) return false
  for (let index = 0; index < value.length; index++) {
    if (index > 0 && !add(1)) return false
    if (!visit(value[index])) return false
  }
  return true
}

function jsonObjectBytes(value: object, add: JsonBudgetAdd, visit: JsonVisit): boolean {
  const entries = Object.entries(value)
  if (!add(2)) return false
  for (let index = 0; index < entries.length; index++) {
    if (index > 0 && !add(1)) return false
    const entry = entries[index]!
    if (!visit(entry[0])) return false
    if (!add(1)) return false
    if (!visit(entry[1])) return false
  }
  return true
}

function jsonBytesAtMost(value: unknown, maximum: number): { bytes: number; overflow: boolean } {
  let bytes = 0
  const add = (amount: number) => {
    bytes += amount
    return bytes <= maximum
  }
  const visit = (item: unknown): boolean => {
    if (item === null) return add(4)
    if (typeof item === "string") return jsonStringBytes(item, add)
    if (typeof item === "boolean") return add(item ? 4 : 5)
    if (typeof item === "number") return jsonNumberBytes(item, add)
    if (Array.isArray(item)) return jsonArrayBytes(item, add, visit)
    if (typeof item === "object") return jsonObjectBytes(item as object, add, visit)
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

type StepRouteState = {
  latestObservedRoute: { id: string | null; at: number } | undefined
  observedEvidenceMissing: boolean
}

type StepScan = {
  session: RadarNativeSession
  assignment: LiveAttemptAssignment
  collections: LiveCollections
  stats: LiveStats
  routesByMessage: Map<string, string | null>
  routeState: StepRouteState
}

type StepEvent = {
  row: LiveProgressRow
  fact: JsonObject
  observation: JsonObject
  eventType: unknown
  eventID: string | null
  messageID: string | null
}

function nonNegativeCount(value: unknown) {
  const count = numeric(value)
  return count !== null && count >= 0 ? Math.floor(count) : null
}

function stepUsageOf(fact: JsonObject) {
  const measured = object(fact.usage)
  return measured &&
    (nonNegativeCount(measured.input) !== null || nonNegativeCount(measured.output) !== null)
    ? { input: nonNegativeCount(measured.input), output: nonNegativeCount(measured.output) }
    : undefined
}

function recordStepStartRoute(scan: StepScan, event: StepEvent, observedAt: number | null) {
  const { stats, collections, routeState } = scan
  const route = routeFromObservation(event.observation, stats)
  const id = route
    ? addLiveRoute(
        "step-event",
        scan.session.id,
        scan.assignment.attemptID,
        event.messageID,
        event.eventID,
        observedAt,
        route,
        collections.routes,
        collections.routeByID,
        stats,
        () => (collections.flags.routeTruncated = true),
      )
    : null
  if (event.messageID) scan.routesByMessage.set(event.messageID, id)
  if (!route) routeState.observedEvidenceMissing = true
  const routeAt = observedAt ?? event.row.recorded_at ?? event.row.at
  if (!routeState.latestObservedRoute || routeAt >= routeState.latestObservedRoute.at)
    routeState.latestObservedRoute = { id, at: routeAt }
}

function pushModelFlow(
  scan: StepScan,
  event: StepEvent,
  observedAt: number,
  stepUsage: ReturnType<typeof stepUsageOf>,
) {
  const { session, stats, collections } = scan
  const { row, fact, observation, eventType, eventID, messageID } = event
  const routeIDForMessage = messageID ? (scan.routesByMessage.get(messageID) ?? null) : null
  const kind =
    eventType === "session.step.started"
      ? "model-request"
      : eventType === "session.step.streamed"
        ? "model-stream"
        : "model-response"
  const sessionIDNode = sessionNodeID(session.id)
  const from = kind === "model-request" ? sessionIDNode : routeIDForMessage
  const to = kind === "model-request" ? routeIDForMessage : sessionIDNode
  if (collections.flow.length >= 256) {
    collections.flags.flowTruncated = true
    return
  }
  collections.flow.push({
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
    ...(stepUsage && eventType === "session.step.ended" ? { usage: stepUsage } : {}),
  })
}

const STEP_EVENT_TYPES = [
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
]

function scanStepRow(scan: StepScan, row: LiveProgressRow) {
  const { stats } = scan
  const fact = factFor(row)
  const observations = observationList(fact.observations)
  const stepUsage = stepUsageOf(fact)
  for (const observation of observations) {
    const eventType = observation.eventType
    if (!STEP_EVENT_TYPES.includes(String(eventType))) continue
    const event: StepEvent = {
      row,
      fact,
      observation,
      eventType,
      eventID: text(observation.eventID, 200, stats),
      messageID: text(observation.messageID ?? fact.messageID, 200, stats),
    }
    const observedAt = numeric(observation.at)
    if (eventType === "session.step.started") recordStepStartRoute(scan, event, observedAt)
    if (observedAt === null) continue
    pushModelFlow(scan, event, observedAt, stepUsage)
  }
}

function pushToolPhaseFlow(
  scan: StepScan,
  row: LiveProgressRow,
  fact: JsonObject,
  latest: JsonObject,
  tool: { callID: string; messageID: string | null; toolName: string | null },
  phase: { eventID: string | null; eventType: string | null },
  status: ReturnType<typeof toolStatus>,
) {
  const { session, stats, collections } = scan
  const phaseEventID = phase.eventID
  const phaseEventType = phase.eventType
  const phaseObservedAt = numeric(latest.at) ?? row.recorded_at ?? row.at
  const toolID = tool.toolName ? `tool:${stableToken(tool.toolName)}` : null
  const terminalEvent =
    phaseEventType === "session.tool.success" || phaseEventType === "session.tool.failed"
  const sessionIDNode = sessionNodeID(session.id)
  collections.flow.push({
    id: `flow:${stableToken(`${row.seq}:tool-phase`)}`,
    kind: "tool-phase",
    source: "progress",
    from: phaseEventType ? (terminalEvent ? toolID : sessionIDNode) : null,
    to: phaseEventType ? (terminalEvent ? sessionIDNode : toolID) : null,
    sessionID: session.id,
    messageID: tool.messageID,
    callID: tool.callID,
    tool: tool.toolName,
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
}

function scanToolRow(scan: StepScan, row: LiveProgressRow) {
  const { session, assignment, stats, collections } = scan
  const { calls, flow, flags } = collections
  const fact = factFor(row)
  const observations = observationList(fact.observations)
  const latest = latestNativeObservation(observations)
  const callID = text(fact.callID ?? row.call_id, 200, stats)
  if (!callID) return
  const messageID = text(fact.messageID ?? row.message_id, 200, stats)
  const toolName = text(fact.tool, 160, stats)
  const id = `call:${stableToken(`${session.id}:${assignment.attemptID}:${callID}`)}`
  if (calls.some((call) => call.id === id)) return
  if (calls.length >= 256) {
    flags.callsTruncated = true
    return
  }
  const status = toolStatus(fact)
  const phaseEventID = text(latest?.eventID, 200, stats)
  const phaseEventType = text(latest?.eventType, 120, stats)
  if (latest && flow.length >= 256) flags.flowTruncated = true
  else if (latest)
    pushToolPhaseFlow(
      scan,
      row,
      fact,
      latest,
      { callID, messageID, toolName },
      { eventID: phaseEventID, eventType: phaseEventType },
      status,
    )

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
    ...(typeof fact.detail === "string" && fact.detail
      ? { detail: contractText(fact.detail, stats, 200) }
      : {}),
  })
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

  const collections: LiveCollections = { routes, routeByID, calls, flow, flags }
  const sessionProgress = source.progress.get(session.id) ?? []
  const scan: StepScan = {
    session,
    assignment,
    collections,
    stats,
    routesByMessage: new Map<string, string | null>(),
    routeState: { latestObservedRoute: undefined, observedEvidenceMissing: false },
  }
  for (const row of sessionProgress.toReversed()) {
    if (row.kind !== "step" || row.payload === null) continue
    scanStepRow(scan, row)
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
    scanToolRow(scan, row)
  }

  const { latestObservedRoute, observedEvidenceMissing } = scan.routeState
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

function historyItem(row: LiveProgressRow) {
  return {
    sequence: row.seq,
    at: row.at,
    recordedAt: row.recorded_at,
    ...progressDisplay(row),
  }
}

type LiveRadarParsedRequest = ReturnType<typeof LiveRadarInput.parse>
type LiveStats = ReturnType<typeof privacyStats>
type LiveSessionRow = LiveRadarResponse["sessions"][number]
type LiveTracking = { ids: Set<string>; truncated: boolean }
type LiveFlags = { routeTruncated: boolean; flowTruncated: boolean; callsTruncated: boolean }

type LiveNativeState = {
  nativeInventory: LiveRadarResponse["freshness"]["nativeInventory"]
  inventoryTruncated: boolean
  nativeMetadataTruncated: boolean
  foreignSessionsExcluded: number
  viewSessionArchived: boolean
  nativeInventoryReads: number
  nativeSessionReads: number
  nativeMetadataBytesInspected: number
  nativeByID: Map<string, RadarNativeSession>
  seenNativeIDs: Set<string>
}

type LiveNativeReader = {
  host: RadarSessionHost
  projectID: string
  signal: AbortSignal
  state: LiveNativeState
}

type LiveCollections = {
  routes: LiveRadarResponse["routes"]
  routeByID: Map<string, LiveRadarResponse["routes"][number]>
  calls: LiveRadarResponse["calls"]
  flow: LiveRadarResponse["flow"]
  flags: LiveFlags
}

type LiveRowInputs = {
  projectID: string
  request: LiveRadarParsedRequest
  source: LiveSourceSnapshot
  state: LiveNativeState
  observedAt: number
  stats: LiveStats
  collections: LiveCollections
  liveSignals: ReturnType<ObservationChangeTracker["peekLiveSignals"]>
}

function trackLiveSessions(
  tracking: LiveTracking,
  tracker: ObservationChangeTracker,
  sessionIDs: Iterable<string>,
  preferredSessionID?: string,
) {
  const trackedSessionIDs = tracking.ids
  const incoming = [...new Set(sessionIDs)]
  const preferred = preferredSessionID ? incoming.indexOf(preferredSessionID) : -1
  if (preferred >= 0) incoming.splice(preferred, 1)
  for (const sessionID of incoming) {
    trackedSessionIDs.delete(sessionID)
    trackedSessionIDs.add(sessionID)
    if (trackedSessionIDs.size > LIVE_LIMITS.retainedStateEntries) {
      trackedSessionIDs.delete(trackedSessionIDs.values().next().value!)
      tracking.truncated = true
    }
  }
  if (preferredSessionID) {
    trackedSessionIDs.delete(preferredSessionID)
    trackedSessionIDs.add(preferredSessionID)
    if (trackedSessionIDs.size > LIVE_LIMITS.retainedStateEntries) {
      const evictable = [...trackedSessionIDs].find((id) => id !== preferredSessionID)
      if (evictable) trackedSessionIDs.delete(evictable)
      tracking.truncated = true
    }
  }
  // Event interest spans visible panel scopes; coverage belongs only to this read.
  tracker.trackScopedSessions(trackedSessionIDs, preferredSessionID, { retainInterests: true })
  return trackedSessionIDs.size
}

function newLiveNativeState(): LiveNativeState {
  return {
    nativeInventory: "unavailable",
    inventoryTruncated: false,
    nativeMetadataTruncated: false,
    foreignSessionsExcluded: 0,
    viewSessionArchived: false,
    nativeInventoryReads: 0,
    nativeSessionReads: 0,
    nativeMetadataBytesInspected: 0,
    nativeByID: new Map(),
    seenNativeIDs: new Set(),
  }
}

function inspectNativeSession(
  state: LiveNativeState,
  projectID: string,
  session: RadarNativeSession,
) {
  const remaining = LIVE_LIMITS.nativeMetadataBytes - state.nativeMetadataBytesInspected
  const measurement = nativeMetadataBytes(session, remaining)
  state.nativeMetadataBytesInspected += measurement.bytes
  if (measurement.overflow) {
    state.nativeMetadataTruncated = true
    state.inventoryTruncated = true
    state.nativeInventory = "bounded"
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
    state.nativeMetadataTruncated = true
    state.inventoryTruncated = true
  }
  const route = session.model
  if (
    route &&
    (route.providerID.length > 200 ||
      route.id.length > 300 ||
      (route.variant !== null && route.variant.length > 200))
  ) {
    state.nativeMetadataTruncated = true
    state.inventoryTruncated = true
  }
  if (session.projectID !== projectID) {
    state.foreignSessionsExcluded++
    return null
  }
  if (session.archived) return null
  if (!session.id || session.id.length > 200 || state.seenNativeIDs.has(session.id)) {
    state.inventoryTruncated = true
    return null
  }
  state.seenNativeIDs.add(session.id)
  const boundedSession = {
    ...session,
    directory: session.directory.length <= 4096 ? session.directory : "",
    agent: session.agent !== null && session.agent.length > 200 ? null : session.agent,
  }
  return boundedSession
}

function acceptBoundedSession(
  state: LiveNativeState,
  projectID: string,
  sessionID: string,
  session: RadarNativeSession,
) {
  const boundedSession = inspectNativeSession(state, projectID, session)
  if (boundedSession?.id === sessionID) state.nativeByID.set(sessionID, boundedSession)
  else if (boundedSession) {
    state.inventoryTruncated = true
    state.nativeInventory = "bounded"
  }
}

async function readSessionScopeNative(
  host: RadarSessionHost | undefined,
  projectID: string,
  signal: AbortSignal,
  state: LiveNativeState,
  viewSessionID: string,
) {
  state.nativeInventory = host ? "complete" : "unavailable"
  if (host) {
    state.nativeSessionReads++
    try {
      const session = await host.get(viewSessionID, signal)
      signal.throwIfAborted()
      if (session) {
        if (session.id === viewSessionID && session.archived) {
          state.viewSessionArchived = true
        } else {
          acceptBoundedSession(state, projectID, viewSessionID, session)
        }
      }
    } catch (error) {
      if (signal.aborted) throw error
      state.nativeInventory = "unavailable"
    }
  }
  if (state.nativeMetadataTruncated && state.nativeInventory === "complete")
    state.nativeInventory = "bounded"
}

async function readProjectInventoryRows(reader: LiveNativeReader) {
  const { state } = reader
  const inventoryRows: RadarNativeSession[] = []
  state.nativeInventoryReads++
  try {
    const inventory = await reader.host.project(
      reader.projectID,
      false,
      LIVE_LIMITS.inventoryCandidates + 1,
      reader.signal,
    )
    reader.signal.throwIfAborted()
    state.inventoryTruncated =
      inventory.truncated || inventory.sessions.length > LIVE_LIMITS.inventoryCandidates
    state.nativeInventory = state.inventoryTruncated ? "bounded" : "complete"
    inventoryRows.push(...inventory.sessions.slice(0, LIVE_LIMITS.inventoryCandidates + 1))
  } catch (error) {
    if (reader.signal.aborted) throw error
    state.nativeInventory = "unavailable"
  }
  return inventoryRows
}

function indexInventoryRows(reader: LiveNativeReader, inventoryRows: RadarNativeSession[]) {
  const inventoryByID = new Map<string, RadarNativeSession>()
  for (const session of inventoryRows) {
    if (session.projectID !== reader.projectID) {
      reader.state.foreignSessionsExcluded++
      continue
    }
    if (!session.id || session.id.length > 200 || inventoryByID.has(session.id)) {
      reader.state.inventoryTruncated = true
      continue
    }
    inventoryByID.set(session.id, session)
  }
  return inventoryByID
}

// The view's exact authorized session may be a human Architect outside the
// bounded worker inventory. Fetch only this ID; never widen inventory here.
async function readProjectViewSession(reader: LiveNativeReader, viewSessionID: string) {
  const { state } = reader
  if (state.nativeSessionReads >= LIVE_LIMITS.nativeSessionReads) {
    state.inventoryTruncated = true
    state.nativeInventory = "bounded"
    return
  }
  state.nativeSessionReads++
  try {
    const current = await reader.host.get(viewSessionID, reader.signal)
    reader.signal.throwIfAborted()
    if (current) {
      if (current.id !== viewSessionID) {
        state.inventoryTruncated = true
        state.nativeInventory = "bounded"
      } else if (current.archived) {
        // Archived scope is never promoted into current activity.
        state.viewSessionArchived = true
      } else {
        acceptBoundedSession(state, reader.projectID, viewSessionID, current)
      }
    }
  } catch (error) {
    if (reader.signal.aborted) throw error
    state.nativeInventory = "unavailable"
  }
}

async function readManagedNativeSessions(
  reader: LiveNativeReader,
  managedIDs: string[],
  inventoryByID: Map<string, RadarNativeSession>,
) {
  const { state } = reader
  for (const sessionID of managedIDs) {
    let native = state.nativeByID.get(sessionID) ?? inventoryByID.get(sessionID)
    if (!native) {
      if (state.nativeSessionReads >= LIVE_LIMITS.nativeSessionReads) {
        state.inventoryTruncated = true
        state.nativeInventory = "bounded"
        continue
      }
      state.nativeSessionReads++
      try {
        native = (await reader.host.get(sessionID, reader.signal)) ?? undefined
      } catch (error) {
        if (reader.signal.aborted) throw error
        state.nativeInventory = "unavailable"
        state.inventoryTruncated = true
        continue
      }
    }
    if (!native) continue
    acceptBoundedSession(state, reader.projectID, sessionID, native)
  }
}

function addUnmanagedNativeSessions(
  reader: LiveNativeReader,
  managedIDs: string[],
  inventoryRows: RadarNativeSession[],
) {
  const { state } = reader
  let unmanagedAdded = 0
  for (const session of inventoryRows) {
    if (managedIDs.includes(session.id)) continue
    if (session.projectID !== reader.projectID) continue
    if (managedIDs.length + unmanagedAdded >= LIVE_LIMITS.sessions) {
      state.inventoryTruncated = true
      break
    }
    if (state.nativeByID.has(session.id)) continue
    const boundedSession = inspectNativeSession(state, reader.projectID, session)
    if (boundedSession) {
      state.nativeByID.set(boundedSession.id, boundedSession)
      unmanagedAdded++
    }
    if (state.nativeMetadataTruncated) break
  }
}

async function readProjectScopeNative(
  reader: LiveNativeReader,
  request: LiveRadarParsedRequest,
  managedIDs: string[],
) {
  const { state } = reader
  const inventoryRows = await readProjectInventoryRows(reader)
  const inventoryByID = indexInventoryRows(reader, inventoryRows)
  await readProjectViewSession(reader, request.scope.sessionID)
  await readManagedNativeSessions(reader, managedIDs, inventoryByID)
  if (request.includeUnmanagedSessions)
    addUnmanagedNativeSessions(reader, managedIDs, inventoryRows)
  if (state.nativeMetadataTruncated && state.nativeInventory === "complete")
    state.nativeInventory = "bounded"
}

function matchAssignmentWorkspaces(source: LiveSourceSnapshot, state: LiveNativeState) {
  for (const assignment of source.assignments.values()) {
    const native = state.nativeByID.get(assignment.sessionID)
    if (native && !assignment.workspaceOmitted && native.directory.length > 0)
      assignment.workspaceMatches = assignment.workspace === native.directory
    else if (native && assignment.workspaceOmitted) {
      state.nativeMetadataTruncated = true
      state.inventoryTruncated = true
    }
  }
}

function selectSessionCandidates(
  request: LiveRadarParsedRequest,
  source: LiveSourceSnapshot,
  state: LiveNativeState,
  managedIDs: string[],
) {
  const { nativeByID } = state
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
      !state.viewSessionArchived &&
      !source.assignments.has(request.scope.sessionID) &&
      state.foreignSessionsExcluded === 0
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
    if (!candidates.length && state.foreignSessionsExcluded === 0 && !state.viewSessionArchived)
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
  return candidates
}

function liveSessionAvailability(
  native: RadarNativeSession | undefined,
  assignment: LiveAttemptAssignment | undefined,
  nativeInventory: LiveNativeState["nativeInventory"],
): LiveSessionRow["availability"] {
  const moved = Boolean(assignment && native && assignment.workspaceMatches === false)
  const locationUnknown = Boolean(
    assignment && native && (assignment.workspaceOmitted || native.directory.length === 0),
  )
  return !native
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
}

function liveSessionAssignment(
  assignment: LiveAttemptAssignment | undefined,
  stats: LiveStats,
): LiveSessionRow["assignment"] {
  if (!assignment) return null
  return {
    planID: assignment.planID,
    taskID: assignment.taskID,
    attemptID: assignment.attemptID,
    state: assignment.state,
    startedAt: assignment.startedAt,
    ...(assignment.attemptNumber > 0 ? { attemptNumber: assignment.attemptNumber } : {}),
    ...(assignment.taskTitle ? { taskTitle: contractText(assignment.taskTitle, stats, 240) } : {}),
    ...(assignment.taskReference
      ? { taskReference: contractText(assignment.taskReference, stats, 60) }
      : {}),
    ...(assignment.task
      ? {
          task: {
            state: assignment.task.state,
            reason: assignment.task.reason
              ? contractText(assignment.task.reason, stats, 600)
              : null,
            planState: assignment.task.planState,
            planReason: assignment.task.planReason
              ? contractText(assignment.task.planReason, stats, 600)
              : null,
          },
        }
      : {}),
  }
}

function liveRouteState(
  candidate: SessionCandidate,
  inputs: LiveRowInputs,
  assignmentPresent: boolean,
) {
  const { native } = candidate
  const { collections, stats, source, projectID } = inputs
  const sessionSignals = assignmentPresent
    ? []
    : inputs.liveSignals.signals.filter((item) => item.sessionID === candidate.id)
  const nativeSignalState = toUnassignedNativeSignals(
    candidate.id,
    sessionSignals,
    collections.routes,
    collections.routeByID,
    collections.flow,
    stats,
    collections.flags,
  )
  const nativeRouteState = toNativeObservations(
    native ?? {
      id: candidate.id,
      projectID,
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
    collections.routes,
    collections.routeByID,
    collections.calls,
    collections.flow,
    stats,
    collections.flags,
  )
  return {
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
}

function liveSessionRow(candidate: SessionCandidate, inputs: LiveRowInputs): LiveSessionRow | null {
  const { request, source, state, stats, collections, observedAt } = inputs
  const native = candidate.native
  const assignment = source.assignments.get(candidate.id)
  if (
    request.scope.kind === "project" &&
    !request.includeUnmanagedSessions &&
    !assignment &&
    candidate.id !== request.scope.sessionID
  )
    return null
  if (native && native.projectID !== inputs.projectID) {
    state.foreignSessionsExcluded++
    return null
  }
  const availability = liveSessionAvailability(native, assignment, state.nativeInventory)
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
        collections.routes,
        collections.routeByID,
        stats,
        () => (collections.flags.routeTruncated = true),
      )
    : null
  const routeState = liveRouteState(candidate, inputs, Boolean(assignment))
  return {
    id: sessionNodeID(candidate.id),
    sessionID: candidate.id,
    projectID: inputs.projectID,
    classification: assignment ? "managed" : "unmanaged",
    ...(native?.parentID && native.parentID.length <= 200
      ? { parentSessionID: native.parentID }
      : {}),
    ...(fresh && native?.title?.trim()
      ? { title: contractText(native.title.trim(), stats, 200) }
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
    state: fresh ? (native?.busy === null ? "unknown" : native?.busy ? "busy" : "idle") : "unknown",
    assignment: liveSessionAssignment(assignment, stats),
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
  }
}

function buildLiveSessionRows(
  candidates: SessionCandidate[],
  inputs: LiveRowInputs,
  signal: AbortSignal,
) {
  const sessionRows: LiveRadarResponse["sessions"] = []
  for (const candidate of candidates) {
    signal.throwIfAborted()
    const row = liveSessionRow(candidate, inputs)
    if (row) sessionRows.push(row)
  }
  return sessionRows
}

function compareLiveSessionRows(left: LiveSessionRow, right: LiveSessionRow) {
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
}

// Paths read relative to where the session works: its workspace, else the project root.
function liveDetailShortener(
  source: LiveSourceSnapshot,
  projectDirectory: string,
  stats: LiveStats,
) {
  const pathScope = (sessionID: string): PathScope => {
    const workspace = source.assignments.get(sessionID)?.workspace
    return {
      roots: workspace ? [workspace, projectDirectory] : [projectDirectory],
      worktreesBase: `${projectDirectory}.worktrees`,
      home: homedir(),
    }
  }
  return (sessionID: string, detail: string) =>
    contractText(relativize(detail, pathScope(sessionID)), stats, 200)
}

// Sessions with no runner assignment (the Architect) have no progress rows: their calls come
// from the canonical per-call record.
function appendNativeCalls(
  store: LiveReadStore,
  sessionRows: LiveRadarResponse["sessions"],
  collections: LiveCollections,
  observedAt: number,
  stats: LiveStats,
  shorten: (sessionID: string, detail: string) => string,
  signal: AbortSignal,
) {
  const { calls, flags } = collections
  const known = new Set(calls.map((call) => `${call.sessionID}\u0000${call.callID}`))
  for (const row of store.nativeCalls(
    sessionRows.filter((item) => item.assignment === null).map((item) => item.sessionID),
    signal,
  )) {
    if (known.has(`${row.session_id}\u0000${row.call_id}`)) continue
    if (calls.length >= 256) {
      flags.callsTruncated = true
      break
    }
    const finished = row.status === "succeeded" || row.status === "failed"
    const status: LiveRadarResponse["calls"][number]["status"] = finished
      ? (row.status as "succeeded" | "failed")
      : observedAt - row.last_observed_at <= 600_000
        ? "running"
        : "unknown"
    calls.push({
      id: `call:${stableToken(`${row.session_id}:${row.call_id}`)}`,
      sessionID: row.session_id,
      attemptID: null,
      messageID: text(row.message_id, 200, stats),
      callID: text(row.call_id, 200, stats) ?? "call",
      tool: text(row.tool, 160, stats),
      status,
      execution: null,
      inputAt: row.first_observed_at,
      calledAt: null,
      completedAt: finished ? row.last_observed_at : null,
      observedAt: row.last_observed_at,
      sourceProgressSequence: null,
      sourceEventID: null,
      sourceEventType: null,
      result: null,
      error: text(row.error, 240, stats),
      payloadAvailable: false,
      ...(row.detail ? { detail: shorten(row.session_id, row.detail) } : {}),
    })
  }
}

// Stored summaries may carry absolute paths: shorten them here, and let calls and tool phases
// without their own summary take the one recorded for the same call.
function shortenStoredDetails(
  store: LiveReadStore,
  sessionRows: LiveRadarResponse["sessions"],
  collections: LiveCollections,
  shorten: (sessionID: string, detail: string) => string,
  signal: AbortSignal,
) {
  const details = store.toolDetails(
    sessionRows.map((row) => row.sessionID),
    signal,
  )
  for (const call of collections.calls) {
    const detail = call.detail ?? details.get(`${call.sessionID}\u0000${call.callID}`)
    if (detail) call.detail = shorten(call.sessionID, detail)
  }
  for (const item of collections.flow)
    if (item.kind === "tool-phase") {
      const detail =
        item.detail ??
        (item.callID ? details.get(`${item.sessionID}\u0000${item.callID}`) : undefined)
      if (detail) item.detail = shorten(item.sessionID, detail)
    }
}

function liveSchedulerStatus(schedulerKey: string) {
  try {
    const status = sharedScheduler.projectStatus(schedulerKey)
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
}

function updateLiveSessionCoverage(response: LiveRadarResponse) {
  response.coverage.sessionCount = response.sessions.length
  response.coverage.managedSessionCount = response.sessions.filter(
    (session) => session.classification === "managed",
  ).length
}

function retrackResponseSessions(
  tracking: LiveTracking,
  tracker: ObservationChangeTracker,
  response: LiveRadarResponse,
  viewSessionID: string,
) {
  response.coverage.retainedStateEntries = trackLiveSessions(
    tracking,
    tracker,
    response.sessions.map((session) => session.sessionID),
    viewSessionID,
  )
}

function dropOneReturnedItem(response: LiveRadarResponse) {
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
}

function fitLiveResponseToBytes(
  response: LiveRadarResponse,
  tracker: ObservationChangeTracker,
  tracking: LiveTracking,
  viewSessionID: string,
) {
  updateLiveSessionCoverage(response)
  retrackResponseSessions(tracking, tracker, response, viewSessionID)
  let responseBytes = measuredResponseBytes(response)
  while (responseBytes > LIVE_LIMITS.responseBytes) {
    dropOneReturnedItem(response)
    updateLiveSessionCoverage(response)
    dropUnreturnedRoutes(response)
    retrackResponseSessions(tracking, tracker, response, viewSessionID)
    responseBytes = measuredResponseBytes(response)
  }
  dropUnreturnedRoutes(response)
  retrackResponseSessions(tracking, tracker, response, viewSessionID)
  responseBytes = measuredResponseBytes(response)
  response.coverage.responseBytes = responseBytes
}

export class LiveRadarReader {
  private readonly source: LiveReadStore
  private readonly schedulerKey: string
  private readonly projectDirectory: string

  constructor(
    store: RunnerStore,
    private readonly host: RadarSessionHost | undefined,
    private readonly projectID: string,
    private readonly secret: Uint8Array,
  ) {
    this.projectDirectory = store.repository.projectDirectory
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
    const tracking: LiveTracking = { ids: new Set<string>(), truncated: false }
    const request = LiveRadarInput.parse(input)
    signal.throwIfAborted()
    const nativeRevision = tracker.nativeRevision
    const eventSequence = tracker.sequence
    const stats = privacyStats()
    const state = newLiveNativeState()
    const source = this.source.readCurrent(
      request.scope.kind === "session" ? request.scope.sessionID : null,
      signal,
    )
    signal.throwIfAborted()

    const managedIDs = [...source.assignments.keys()]
    trackLiveSessions(
      tracking,
      tracker,
      [...managedIDs, request.scope.sessionID],
      request.scope.sessionID,
    )

    if (request.scope.kind === "session")
      await readSessionScopeNative(
        this.host,
        this.projectID,
        signal,
        state,
        request.scope.sessionID,
      )
    else if (this.host)
      await readProjectScopeNative(
        { host: this.host, projectID: this.projectID, signal, state },
        request,
        managedIDs,
      )
    matchAssignmentWorkspaces(source, state)

    const candidates = selectSessionCandidates(request, source, state, managedIDs)
    state.inventoryTruncated ||= source.assignmentTruncated
    if (state.nativeSessionReads > LIVE_LIMITS.nativeSessionReads)
      throw new Error("Bounded native session reads exceeded their declared call budget")
    const boundedCandidates = candidates.slice(0, LIVE_LIMITS.sessions)
    if (candidates.length > boundedCandidates.length) state.inventoryTruncated = true
    const retainedStateEntries = trackLiveSessions(
      tracking,
      tracker,
      boundedCandidates.map((candidate) => candidate.id),
      request.scope.sessionID,
    )
    signal.throwIfAborted()
    const liveSignals = tracker.peekLiveSignals(
      new Set(boundedCandidates.map((candidate) => candidate.id)),
    )

    const collections: LiveCollections = {
      routes: [],
      routeByID: new Map(),
      calls: [],
      flow: [],
      flags: {
        routeTruncated: false,
        flowTruncated: liveSignals.truncated,
        callsTruncated: false,
      },
    }
    const observedAt = Date.now()
    const sessionRows = buildLiveSessionRows(
      boundedCandidates,
      {
        projectID: this.projectID,
        request,
        source,
        state,
        observedAt,
        stats,
        collections,
        liveSignals,
      },
      signal,
    )
    sessionRows.sort(compareLiveSessionRows)

    const shorten = liveDetailShortener(source, this.projectDirectory, stats)
    appendNativeCalls(this.source, sessionRows, collections, observedAt, stats, shorten, signal)
    shortenStoredDetails(this.source, sessionRows, collections, shorten, signal)

    const response: LiveRadarResponse = {
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
        nativeInventory: state.nativeInventory,
        nativeEvents: tracker.hasConnectedEventStream
          ? ("connected" as const)
          : ("gap-or-unavailable" as const),
      },
      scheduler: liveSchedulerStatus(this.schedulerKey),
      ...(source.workload ? { workload: source.workload } : {}),
      coverage: {
        sessionCount: sessionRows.length,
        managedSessionCount: sessionRows.filter((session) => session.classification === "managed")
          .length,
        includeUnmanagedSessions: request.includeUnmanagedSessions,
        inventoryTruncated: state.inventoryTruncated,
        progressTruncated: source.progressTruncated,
        payloadTruncated: source.payloadTruncated,
        routeTruncated: collections.flags.routeTruncated,
        flowTruncated: collections.flags.flowTruncated,
        callsTruncated: collections.flags.callsTruncated,
        assignmentTruncated: source.assignmentTruncated,
        journalTruncated: source.journalTruncated,
        journal: source.journal,
        foreignSessionsExcluded: state.foreignSessionsExcluded,
        sourceQueries: source.sourceQueries,
        sourceRowsRead: source.sourceRowsRead,
        sourceBytesRead: source.sourceBytesRead,
        sourcePayloadBytesRead: source.sourcePayloadBytesRead,
        nativeInventoryReads: state.nativeInventoryReads,
        nativeSessionReads: state.nativeSessionReads,
        nativeMetadataBytesInspected: state.nativeMetadataBytesInspected,
        nativeMetadataTruncated: state.nativeMetadataTruncated,
        nativeMetadataBoundary: "raw-selected-fields-after-adapter" as const,
        nativeContextLoads: 0 as const,
        retainedStateEntries,
        retainedStateTruncated: tracking.truncated,
        responseBytes: 0,
      },
      limits: LIVE_LIMITS,
      sessions: sessionRows,
      routes: collections.routes,
      calls: collections.calls,
      flow: collections.flow,
    }

    fitLiveResponseToBytes(response, tracker, tracking, request.scope.sessionID)
    const parsed = LiveRadarOutput.parse(response)
    if (parsed.coverage.responseBytes > LIVE_LIMITS.responseBytes)
      throw new Error("Bounded live response exceeded its declared byte limit")
    return parsed
  }

  group(input: LiveGroupRequestInput, signal: AbortSignal): LiveGroupResponse {
    const request = LiveGroupInput.parse(input)
    signal.throwIfAborted()
    return LiveGroupOutput.parse({
      schemaVersion: 1,
      projectID: this.projectID,
      group: request.group,
      ...this.source.readGroupTasks(request.group, signal),
    })
  }

  attempt(input: LiveAttemptRequestInput, signal: AbortSignal): LiveAttemptResponse {
    const request = LiveAttemptInput.parse(input)
    signal.throwIfAborted()
    return LiveAttemptOutput.parse({
      schemaVersion: 1,
      projectID: this.projectID,
      sessionID: request.sessionID,
      attempt: this.source.readAttempt(request, signal),
    })
  }

  history(input: LiveHistoryRequestInput, signal: AbortSignal): LiveHistoryResponse {
    const request = LiveHistoryInput.parse(input)
    signal.throwIfAborted()
    const source = this.source.readHistory(request, signal)
    signal.throwIfAborted()
    const items = source.rows.map((row) => historyItem(row)).toReversed()
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

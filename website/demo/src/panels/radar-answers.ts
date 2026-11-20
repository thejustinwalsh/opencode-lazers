import { Changed, Observability } from "../../../../src/observability/contract.ts"
import type {
  LiveAttemptResponse,
  LiveGroupResponse,
  LiveHistoryResponse,
  LiveRadarResponse,
  ObservationScope,
} from "../../../../src/observability/contract.ts"
import type { Read } from "../adapter.ts"
import { T0 } from "../story.ts"

/**
 * Pure answers for the Radar panel: a compact description of the world at one moment, expanded
 * into the exact `lazers.observability` live reads (`liveRadar`, `liveHistory`, `liveAttempt`,
 * `liveGroup`) the real panel reads. No browser or Solid code, so the build script can validate it.
 * Times are story milliseconds: 0 is the story's start and the demo's `Date.now()` is `T0 + clock`.
 */
export interface DemoCall {
  /** Native tool name: read, edit, bash, grep... */
  tool: string
  /** One redacted line of what the call ran: its command, file or pattern. */
  detail?: string
  /** File the call read or edited. */
  path?: string
  op?: "read" | "edit" | "patch"
  /** Story ms the call started. */
  at: number
  /** How long it ran; absent while it is still running. */
  ms?: number
  /** Error text of a failed call. */
  failed?: string
}
export interface DemoModel {
  providerID: string
  id: string
  variant?: string
}
export interface DemoWorker {
  /** Reference number: 204 is LZ-204. */
  n: number
  title: string
  state: "preparing" | "running" | "verifying"
  /** Story ms the attempt started; negative when it began before the story. */
  startedAt: number
  model: DemoModel
  /** The calls the live read lists, oldest first. */
  calls: DemoCall[]
  /** Tool calls the attempt has made in all; at least `calls.length`. */
  toolCount: number
  files?: number
  /** Why the task is held: the worker is waiting rather than running. */
  held?: string
  /** An open worker concern with the rule's recommended action. */
  concern?: {
    line: string
    action?: "acknowledge" | "steer" | "takeover" | "cancel"
    because?: string
  }
}
export interface DemoTaskRef {
  n: number
  title: string
}
export interface RadarData {
  /** Observation revision: every step that changes what a service would answer raises it. */
  rev: number
  architect: { busy: boolean; model: DemoModel; calls: DemoCall[]; updatedAt: number }
  workers: DemoWorker[]
  /** Recorded task counts behind the project summary and the Map's Queue group. */
  needsYou: DemoTaskRef[]
  failed: DemoTaskRef[]
  queued: DemoTaskRef[]
}

export const PROJECT = { canonical: "/workspace/lazers-demo", id: "demo-project" }
/** The session the panel is open beside: the Architect's. */
const ARCHITECT = "ses-demo"
const EPOCH = "5eed0000-0000-4000-8000-000000000001"
const PLAN = "30000000-0000-4000-8000-000000000001"

/** RFC 4122 v4-shaped ids, stable per kind and number. */
const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const taskID = (n: number) => uid(1, n)
const attemptID = (n: number) => uid(2, n)
const ref = (n: number) => `LZ-${n}`
const workerSession = (n: number) => `ses-worker-${n}`
const abs = (at: number) => T0 + at

const routeID = (sessionID: string) => `route:${sessionID}`
function route(sessionID: string, model: DemoModel, attempt: string | null, at: number) {
  return {
    id: routeID(sessionID),
    providerID: model.providerID,
    modelID: model.id,
    variant: model.variant ?? null,
    source: "step-event" as const,
    sessionID,
    attemptID: attempt,
    messageID: null,
    eventID: null,
    observedAt: abs(at),
  }
}

type LiveSessionOut = LiveRadarResponse["sessions"][number]
type LiveCallOut = LiveRadarResponse["calls"][number]

function liveCall(sessionID: string, attempt: string | null, call: DemoCall): LiveCallOut {
  const running = call.ms === undefined && call.failed === undefined
  const end = call.ms === undefined ? null : abs(call.at + call.ms)
  return {
    id: `call:${sessionID}:${call.at}`,
    sessionID,
    attemptID: attempt,
    messageID: null,
    callID: `call-${call.at}`,
    tool: call.tool,
    status: running ? "running" : call.failed !== undefined ? "failed" : "succeeded",
    execution: "executed",
    inputAt: abs(call.at),
    calledAt: abs(call.at),
    completedAt: running ? null : (end ?? abs(call.at + 800)),
    observedAt: running ? abs(call.at) : (end ?? abs(call.at + 800)),
    sourceProgressSequence: null,
    sourceEventID: null,
    sourceEventType: null,
    result: running || call.failed !== undefined ? null : "ok",
    error: call.failed ?? null,
    payloadAvailable: false,
    ...(call.path
      ? {
          fileTargets: {
            coverage: "observed" as const,
            operation: call.op ?? "read",
            paths: [call.path],
          },
        }
      : {}),
    ...(call.detail ? { detail: call.detail } : {}),
  }
}

const lastTouch = (calls: DemoCall[], fallback: number) =>
  calls.reduce((latest, call) => Math.max(latest, call.at + (call.ms ?? 0)), fallback)

function architectSession(data: RadarData): LiveSessionOut {
  return {
    id: `session:${ARCHITECT}`,
    sessionID: ARCHITECT,
    projectID: PROJECT.id,
    classification: "managed",
    title: "Architect",
    isViewSession: true,
    isCurrentArchitect: true,
    availability: "available",
    freshness: "current",
    agent: "lazers-architect",
    state: data.architect.busy ? "busy" : "idle",
    assignment: null,
    selectedRouteID: routeID(ARCHITECT),
    configuredRouteID: null,
    observedRouteID: routeID(ARCHITECT),
    routeCoverage: { selected: "available", configured: "not-assigned", observed: "available" },
    updatedAt: abs(data.architect.updatedAt),
    observedAt: abs(data.architect.updatedAt),
  }
}

function workerLiveSession(worker: DemoWorker): LiveSessionOut {
  const sessionID = workerSession(worker.n)
  const touched = lastTouch(worker.calls, worker.startedAt)
  return {
    id: `session:${sessionID}`,
    sessionID,
    projectID: PROJECT.id,
    classification: "managed",
    parentSessionID: ARCHITECT,
    title: worker.title,
    isViewSession: false,
    isCurrentArchitect: false,
    availability: "available",
    freshness: "current",
    agent: "lazers-implementer",
    state: "busy",
    assignment: {
      planID: PLAN,
      taskID: taskID(worker.n),
      attemptID: attemptID(worker.n),
      state: worker.state,
      startedAt: abs(worker.startedAt),
      attemptNumber: 1,
      taskTitle: worker.title,
      taskReference: ref(worker.n),
      task: {
        state: worker.held ? "blocked" : worker.state === "verifying" ? "verifying" : "running",
        reason: worker.held ?? null,
        planState: "running",
        planReason: null,
      },
    },
    selectedRouteID: routeID(sessionID),
    configuredRouteID: routeID(sessionID),
    observedRouteID: routeID(sessionID),
    routeCoverage: { selected: "available", configured: "available", observed: "available" },
    updatedAt: abs(touched),
    observedAt: abs(touched),
  }
}

function live(data: RadarData, scope: ObservationScope): LiveRadarResponse {
  const sessions = [architectSession(data), ...data.workers.map(workerLiveSession)]
  const calls = [
    ...data.architect.calls.map((call) => liveCall(ARCHITECT, null, call)),
    ...data.workers.flatMap((worker) =>
      worker.calls.map((call) => liveCall(workerSession(worker.n), attemptID(worker.n), call)),
    ),
  ]
  const active = data.workers.filter((worker) => !worker.held).length
  return {
    schemaVersion: 1,
    projectID: PROJECT.id,
    scope:
      scope.kind === "session"
        ? { kind: "session", sessionID: scope.sessionID }
        : { kind: "project" },
    streamEpoch: EPOCH,
    observedAt: Date.now(),
    boundary: { runnerRevision: data.rev, nativeRevision: data.rev, eventSequence: data.rev },
    freshness: { runner: "current", nativeInventory: "complete", nativeEvents: "connected" },
    scheduler: { status: "scheduled", participants: active },
    workload: {
      queued: data.queued.length,
      needsYou: data.needsYou.length,
      failed: data.failed.length,
    },
    coverage: {
      sessionCount: sessions.length,
      managedSessionCount: sessions.length,
      includeUnmanagedSessions: false,
      inventoryTruncated: false,
      assignmentTruncated: false,
      progressTruncated: false,
      payloadTruncated: false,
      routeTruncated: false,
      callsTruncated: false,
      flowTruncated: false,
      journalTruncated: false,
      journal: "available",
      foreignSessionsExcluded: 0,
      sourceQueries: 4,
      sourceRowsRead: calls.length,
      sourceBytesRead: 4096,
      sourcePayloadBytesRead: 0,
      nativeInventoryReads: 1,
      nativeSessionReads: sessions.length,
      nativeMetadataBytesInspected: 2048,
      nativeMetadataTruncated: false,
      nativeMetadataBoundary: "raw-selected-fields-after-adapter",
      nativeContextLoads: 0,
      retainedStateEntries: sessions.length,
      retainedStateTruncated: false,
      responseBytes: 8192,
    },
    limits: {
      sessions: 32,
      inventoryCandidates: 256,
      progressRowsPerSession: 17,
      toolRowsPerSession: 17,
      progressRowsPerAttempt: 50,
      journalFacts: 257,
      journalHydrationFacts: 16,
      progressPayloadBytes: 4096,
      sourceRows: 1500,
      sourceBytes: 10_000_000,
      sourceQueries: 100,
      nativeMetadataBytes: 256_000,
      nativeSessionReads: 32,
      retainedStateEntries: 32,
      responseBytes: 512_000,
      nativeInventoryReads: 1,
    },
    sessions,
    routes: [
      route(ARCHITECT, data.architect.model, null, data.architect.updatedAt),
      ...data.workers.map((worker) =>
        route(workerSession(worker.n), worker.model, attemptID(worker.n), worker.startedAt),
      ),
    ],
    calls,
    flow: [],
  }
}

function history(data: RadarData, sessionID: string, scope: ObservationScope): LiveHistoryResponse {
  const worker = data.workers.find((candidate) => workerSession(candidate.n) === sessionID)
  return {
    schemaVersion: 1,
    projectID: PROJECT.id,
    scope:
      scope.kind === "session"
        ? { kind: "session", sessionID: scope.sessionID }
        : { kind: "project" },
    sessionID,
    attemptID: worker ? attemptID(worker.n) : null,
    source: "runner-progress",
    runnerRevision: data.rev,
    capturedAt: Date.now(),
    items: [],
    nextCursor: null,
    limits: {
      items: 25,
      payloadBytes: 4096,
      sourceQueries: 10,
      sourceRows: 40,
      sourceBytes: 250_000,
      responseBytes: 512_000,
    },
    coverage: {
      hasMore: false,
      payloadTruncated: false,
      journal: "available",
      sourceQueries: 1,
      sourceRowsRead: 0,
      sourceBytesRead: 0,
      sourcePayloadBytesRead: 0,
      nativeInventoryReads: 0,
      nativeContextLoads: 0,
      retainedStateEntries: 0,
      responseBytes: 512,
    },
  }
}

/** One tick per tool call: the ones the read lists, and earlier ones spread from the start. */
function ticks(worker: DemoWorker) {
  const listed = worker.calls.map((call) => ({
    at: abs(call.at),
    ...(call.failed !== undefined ? { failed: true as const } : {}),
  }))
  const earlier = Math.max(0, worker.toolCount - worker.calls.length)
  const first = worker.calls[0]?.at ?? worker.startedAt + 60_000
  const span = Math.max(1, first - worker.startedAt)
  const before = Array.from({ length: earlier }, (_, index) => ({
    at: abs(worker.startedAt + Math.round(((index + 1) * span) / (earlier + 1))),
  }))
  return [...before, ...listed]
}

function attempt(data: RadarData, sessionID: string, scope: ObservationScope): LiveAttemptResponse {
  void scope
  const worker = data.workers.find((candidate) => workerSession(candidate.n) === sessionID)
  return {
    schemaVersion: 1,
    projectID: PROJECT.id,
    sessionID,
    attempt: worker
      ? {
          id: attemptID(worker.n),
          number: 1,
          state: worker.state,
          startedAt: abs(worker.startedAt),
          toolCount: worker.toolCount,
          model: {
            providerID: worker.model.providerID,
            id: worker.model.id,
            ...(worker.model.variant ? { variant: worker.model.variant } : {}),
          },
          summary: {
            lastActivityAt: abs(lastTouch(worker.calls, worker.startedAt)),
            ticks: ticks(worker),
            ...(worker.files ? { files: worker.files } : {}),
          },
          task: {
            state: worker.held ? "blocked" : worker.state === "verifying" ? "verifying" : "running",
            reason: worker.held ?? null,
            planState: "running",
            planReason: null,
          },
          ...(worker.concern ? { concern: worker.concern } : {}),
        }
      : null,
  }
}

function group(data: RadarData, name: "needs-you" | "failed" | "queued"): LiveGroupResponse {
  const tasks = name === "needs-you" ? data.needsYou : name === "failed" ? data.failed : data.queued
  return {
    schemaVersion: 1,
    projectID: PROJECT.id,
    group: name,
    total: tasks.length,
    tasks: tasks.map((task) => ({
      taskID: taskID(task.n),
      reference: ref(task.n),
      title: task.title,
    })),
  }
}

export function rpc(data: () => RadarData) {
  return {
    [Observability.id]: {
      liveRadar: (input: { scope: ObservationScope }) => live(data(), input.scope),
      liveHistory: (input: { scope: ObservationScope; sessionID: string }) =>
        history(data(), input.sessionID, input.scope),
      liveAttempt: (input: { scope: ObservationScope; sessionID: string }) =>
        attempt(data(), input.sessionID, input.scope),
      liveGroup: (input: { group: "needs-you" | "failed" | "queued" }) =>
        group(data(), input.group),
    },
  } as Record<string, Record<string, (input: never) => unknown>>
}

/** Every distinct read this data answers, with the contract schema that must accept it. */
export function reads(data: RadarData): Read[] {
  const out: Read[] = []
  const session: ObservationScope = { kind: "session", sessionID: ARCHITECT }
  const project: ObservationScope = { kind: "project", sessionID: ARCHITECT }
  for (const scope of [session, project])
    out.push({
      label: `lazers.observability.liveRadar ${scope.kind}`,
      schema: Observability.methods.liveRadar.output,
      value: live(data, scope),
    })
  const ids = [ARCHITECT, ...data.workers.map((worker) => workerSession(worker.n))]
  for (const id of ids) {
    out.push({
      label: `lazers.observability.liveHistory ${id}`,
      schema: Observability.methods.liveHistory.output,
      value: history(data, id, session),
    })
    out.push({
      label: `lazers.observability.liveAttempt ${id}`,
      schema: Observability.methods.liveAttempt.output,
      value: attempt(data, id, session),
    })
  }
  for (const name of ["needs-you", "failed", "queued"] as const)
    out.push({
      label: `lazers.observability.liveGroup ${name}`,
      schema: Observability.methods.liveGroup.output,
      value: group(data, name),
    })
  out.push({
    label: "lazers.observability.changed",
    schema: Changed,
    value: change(data),
  })
  return out
}

const change = (data: RadarData) => ({
  projectID: PROJECT.id,
  sequence: Math.max(1, data.rev),
  repositoryVersion: data.rev,
  sourceRevision: data.rev,
  nativeRevision: data.rev,
  cause: "runner" as const,
  resnapshotRequired: false,
})

/**
 * What the service publishes after a change: the panel re-reads on it. `sequence` follows the
 * data's revision, so the next live read (which reports the same revision) is never behind it.
 */
export const radarChanged = (emit: (type: string, data: unknown) => void, data: RadarData) =>
  emit(`rpc.${Observability.id}.changed`, change(data))

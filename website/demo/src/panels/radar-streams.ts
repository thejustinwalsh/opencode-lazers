import {
  liveHistoryColumns,
  LIVE_HISTORY_SOURCE,
} from "../../../../src/streams/sources/live-history-ref.ts"
import {
  RADAR_SOURCES,
  radarAssignmentColumns,
  radarAttemptDetail,
  radarGroupColumns,
  radarNativeCallColumns,
  radarSchedulerColumns,
  radarWorkloadColumns,
  radarNodeColumns,
  radarPlanEventColumns,
  radarPlanEventDetail,
} from "../../../../src/streams/sources/radar-ref.ts"
import { TASK_SOURCES, taskPlanColumns } from "../../../../src/streams/sources/tasks-ref.ts"
import { taskMachineDefinition } from "../../../../src/runner/task-machine-config.ts"
import {
  RADAR_SESSIONS_SOURCE,
  radarSessionColumns,
} from "../../../../src/streams/sources/host-sessions-ref.ts"
import {
  RADAR_FLOW_SOURCES,
  radarStepColumns,
  radarTranscriptColumns,
} from "../../../../src/streams/sources/radar-flow-ref.ts"
import { streamAnswers, type Open, type DemoRow } from "./stream-answers.ts"
import type { DemoCall, DemoWorker, RadarData } from "./radar-answers.ts"

/**
 * The demo's answer to `lazers.streams` for the Radar, as real frames over the demo's mock world:
 * the Monitor's sessions (`radar.sessions`), active attempts (`radar.assignments`), scheduler,
 * each session's canonical calls (`radar.nativeCalls`) and each session's model steps
 * (`radar.steps`, `radar.transcripts`: every session read in full); the worker pane's attempt
 * (`radar.attempt`) and calls (`observability.liveHistory`: the lane, the newest row and the
 * older-calls list); a Map group's tasks with the workload (`radar.group`, `radar.workload`).
 */
export type RadarIds = {
  project: string
  architect: string
  taskID(n: number): string
  attemptID(n: number): string
  ref(n: number): string
  workerSession(n: number): string
  abs(at: number): number
}

const SOURCES = {
  [RADAR_SOURCES.attempt]: {
    columns: { ...radarAssignmentColumns, ...radarAttemptDetail },
    key: ["id"],
  },
  [LIVE_HISTORY_SOURCE]: { columns: liveHistoryColumns, key: ["seq"] },
  [RADAR_SOURCES.group]: { columns: radarGroupColumns, key: ["task_id"] },
  [RADAR_SOURCES.workload]: { columns: radarWorkloadColumns, key: ["project_directory"] },
  [RADAR_SESSIONS_SOURCE]: { columns: radarSessionColumns, key: ["id"] },
  [RADAR_SOURCES.assignments]: { columns: radarAssignmentColumns, key: ["id"] },
  [RADAR_SOURCES.scheduler]: { columns: radarSchedulerColumns, key: ["project_directory"] },
  [RADAR_SOURCES.nativeCalls]: { columns: radarNativeCallColumns, key: ["id"] },
  [RADAR_FLOW_SOURCES.steps]: { columns: radarStepColumns, key: ["id"] },
  [RADAR_FLOW_SOURCES.transcripts]: { columns: radarTranscriptColumns, key: ["id"] },
  [TASK_SOURCES.plans]: { columns: taskPlanColumns, key: ["plan_id"] },
  [RADAR_SOURCES.nodes]: { columns: radarNodeColumns, key: ["task_id"] },
  [RADAR_SOURCES.planEvents]: {
    columns: radarPlanEventColumns,
    key: ["id"],
    detail: radarPlanEventDetail,
  },
}

/** The demo's one plan: every worker's task is a node of it. */
const PLAN_ID = "00000003-0000-4000-8000-000000000001"
const MACHINE_VERSION = taskMachineDefinition().version

/** A worker's task as the runner records it: its state, and the machine edges it took to get there. */
const nodeState = (worker: DemoWorker) =>
  worker.held ? "blocked" : worker.state === "verifying" ? "verifying" : "running"
const edgesOf = (worker: DemoWorker): [string, string, string][] => {
  const path: [string, string, string][] = [
    ["queued", "READY", "ready"],
    ["ready", "DISPATCH", "running"],
  ]
  if (worker.state === "verifying") path.push(["running", "VERIFY", "verifying"])
  if (worker.held) path.push([path.at(-1)![2], "BLOCK", "blocked"])
  return path
}

function lifecycleRows(data: RadarData, open: Open, ids: RadarIds): DemoRow[] | undefined {
  const filter = open.filter
  if (open.source === TASK_SOURCES.plans)
    return [
      {
        plan_id: PLAN_ID,
        seq: 1,
        title: "Offline sync",
        state: "running",
        reason: null,
        priority: 1,
        priority_key: 1,
        owner_session_id: ids.architect,
        workspace_mode: "isolated",
        after_plans: [],
        after_plans_count: 0,
        pause: null,
        plan_revision: 1,
        node_count: data.workers.length,
        open_count: data.workers.length,
      },
    ]
  if (open.source === RADAR_SOURCES.nodes)
    return filter.planID !== PLAN_ID
      ? []
      : data.workers.map((worker, ordinal) => ({
          plan_id: PLAN_ID,
          task_id: ids.taskID(worker.n),
          ordinal,
          state: nodeState(worker),
          version: edgesOf(worker).length,
          reason: worker.held ?? null,
          machine_version: MACHINE_VERSION,
          snapshot: { status: "active", value: nodeState(worker) },
        }))
  if (open.source === RADAR_SOURCES.planEvents) {
    const worker = data.workers.find((found) => ids.taskID(found.n) === filter.taskID)
    if (!worker || filter.planID !== PLAN_ID) return []
    return edgesOf(worker).map(([from, event, to], index) => ({
      id: worker.n * 100 + index + 1,
      plan_id: PLAN_ID,
      task_id: ids.taskID(worker.n),
      event,
      from_state: from,
      to_state: to,
      attempt_id: index > 0 ? ids.attemptID(worker.n) : null,
      at: ids.abs(worker.startedAt) - (edgesOf(worker).length - index) * 20_000,
      detail: {
        event: {
          reason:
            event === "BLOCK"
              ? (worker.held ?? "held")
              : event === "DISPATCH"
                ? `Dispatched to ${worker.model.id}`
                : `${event.toLowerCase()} recorded`,
          version: index + 1,
        },
      },
    }))
  }
  return undefined
}

const lastTouch = (calls: DemoCall[], fallback: number) =>
  calls.reduce((latest, call) => Math.max(latest, call.at + (call.ms ?? 0)), fallback)

/** The host's session facts: the Architect, then each worker under it, newest change first. */
function sessionRows(data: RadarData, ids: RadarIds): DemoRow[] {
  const route = (model: DemoWorker["model"]) => ({
    route_provider: model.providerID,
    route_model: model.id,
    route_variant: model.variant ?? null,
  })
  const base = { directory: ids.project, pending_input: false, pending_permissions: 0 }
  return [
    {
      ...base,
      id: 1,
      session_id: ids.architect,
      role: "architect",
      agent: "lazers-architect",
      title: "Architect",
      attempt_id: null,
      task_id: null,
      parent_session_id: null,
      busy: data.architect.busy,
      pending_forms: 0,
      outcome: null,
      archived: false,
      ...route(data.architect.model),
      tokens_in: null,
      tokens_out: null,
      created_at: ids.abs(-3_600_000),
      updated_at: ids.abs(data.architect.updatedAt),
      host_updated_at: ids.abs(data.architect.updatedAt),
    },
    ...data.workers.map((worker, index) => {
      const touched = ids.abs(lastTouch(worker.calls, worker.startedAt))
      return {
        ...base,
        id: 10 + index,
        session_id: ids.workerSession(worker.n),
        role: "worker",
        agent: "lazers-implementer",
        title: worker.title,
        attempt_id: ids.attemptID(worker.n),
        task_id: ids.taskID(worker.n),
        parent_session_id: ids.architect,
        busy: true,
        pending_forms: 0,
        outcome: null,
        archived: false,
        ...route(worker.model),
        tokens_in: null,
        tokens_out: null,
        created_at: ids.abs(worker.startedAt),
        updated_at: touched,
        host_updated_at: touched,
      }
    }),
  ].sort((a, b) => Number(b.updated_at) - Number(a.updated_at) || b.id - a.id)
}

/** A session's canonical calls, newest first (`first_observed_at desc`). */
function nativeCallRows(sessionID: string, calls: DemoCall[], ids: RadarIds): DemoRow[] {
  return calls
    .map((call, index) => {
      const running = call.ms === undefined && call.failed === undefined
      return {
        id: index + 1,
        session_id: sessionID,
        identity_kind: "native-call",
        call_id: `call-${call.at}`,
        detail_call_id: `call-${call.at}`,
        message_id: null,
        agent: null,
        tool: call.tool,
        attempt_id: null,
        status: running ? "running" : call.failed !== undefined ? "failed" : "succeeded",
        detail: call.detail ?? call.path ?? null,
        error: call.failed ?? null,
        first_observed_at: ids.abs(call.at),
        last_observed_at: ids.abs(call.at + (call.ms ?? 0)),
      }
    })
    .reverse()
}

/**
 * A session's model steps, newest first: one request before each call, answered just before the
 * call starts, with measured tokens. A running call's step has finished; the model is not asked
 * again until the call returns. `n` keys the rows: a worker's number, 0 for the Architect.
 */
function stepRows(
  sessionID: string,
  n: number,
  model: DemoWorker["model"],
  calls: DemoCall[],
  ids: RadarIds,
): DemoRow[] {
  return calls
    .map((call, index) => ({
      id: n * 1_000 + index + 1,
      session_id: sessionID,
      message_id: `msg-${n}-${index}`,
      ordinal: index * 2 + 1,
      provider_id: model.providerID,
      model_id: model.id,
      variant: model.variant ?? null,
      created_at: ids.abs(call.at - 1_400),
      streamed_at: ids.abs(call.at - 900),
      completed_at: ids.abs(call.at - 100),
      input_tokens: 24_000 + index * 1_500,
      output_tokens: 320 + index * 40,
      error_type: null,
    }))
    .reverse()
}

/** Every tool call of a worker's attempt, newest first: the listed calls and earlier ones spread from its start. */
function callRows(worker: DemoWorker, ids: RadarIds): DemoRow[] {
  const earlier = Math.max(0, worker.toolCount - worker.calls.length)
  const first = worker.calls[0]?.at ?? worker.startedAt + 60_000
  const span = Math.max(1, first - worker.startedAt)
  const before: DemoCall[] = Array.from({ length: earlier }, (_, index) => ({
    tool: "read",
    at: worker.startedAt + Math.round(((index + 1) * span) / (earlier + 1)),
    ms: 400,
  }))
  return [...before, ...worker.calls]
    .map((call, index) => ({
      seq: worker.n * 10_000 + index + 1,
      at: ids.abs(call.at),
      recorded_at: ids.abs(call.at),
      kind: "tool",
      source: "native-event",
      message_id: null,
      call_id: `call-${call.at}`,
      tool: call.tool,
      status: call.failed ? "failed" : call.ms === undefined ? "running" : "succeeded",
      agent: "lazers-implementor",
      result: null,
      error: call.failed ?? null,
      route_provider: null,
      route_model: null,
      route_variant: null,
      file_targets_json: call.path
        ? { coverage: "observed", operation: call.op ?? "read", paths: [call.path] }
        : null,
      observations_json: [],
      payload_available: true,
    }))
    .reverse()
}

function attemptRow(worker: DemoWorker, ids: RadarIds): DemoRow {
  return {
    id: ids.attemptID(worker.n),
    session_id: ids.workerSession(worker.n),
    plan_id: null,
    task_id: ids.taskID(worker.n),
    number: 1,
    state: worker.state,
    started_at: ids.abs(worker.startedAt),
    tool_count: worker.toolCount,
    model: worker.model,
    takeover: false,
    reference: ids.ref(worker.n),
    title: worker.title,
    node_state: worker.held ? "blocked" : worker.state === "verifying" ? "verifying" : "running",
    node_reason: worker.held ?? null,
    plan_state: "running",
    plan_reason: null,
    concern: worker.concern ? { line: worker.concern.line } : null,
    concern_action: worker.concern?.action ?? null,
    concern_because: worker.concern?.because ?? null,
    workspace: null,
    base_commit: null,
    artifact: null,
  }
}

function rowsOf(data: RadarData, open: Open, ids: RadarIds): DemoRow[] {
  const lifecycle = lifecycleRows(data, open, ids)
  if (lifecycle) return lifecycle
  const filter = open.filter
  const worker = (sessionID: unknown) =>
    data.workers.find((candidate) => ids.workerSession(candidate.n) === sessionID)
  if (open.source === RADAR_SOURCES.attempt) {
    const found = worker(filter.sessionID)
    return found ? [attemptRow(found, ids)] : []
  }
  if (open.source === LIVE_HISTORY_SOURCE) {
    const found = worker(filter.sessionID)
    if (!found) return []
    const before = typeof filter.beforeAt === "number" ? filter.beforeAt : Infinity
    return callRows(found, ids).filter((row) => Number(row.at) < before)
  }
  if (open.source === RADAR_SESSIONS_SOURCE) {
    const all = sessionRows(data, ids)
    const one = filter.sessionID
    return one === undefined
      ? all
      : all.filter((row) => row.session_id === one || row.parent_session_id === one)
  }
  if (open.source === RADAR_SOURCES.assignments)
    return data.workers
      .map((found) => attemptRow(found, ids))
      .filter((row) => filter.sessionID === undefined || row.session_id === filter.sessionID)
      .sort((a, b) => Number(b.started_at) - Number(a.started_at))
  if (open.source === RADAR_SOURCES.scheduler)
    return [
      {
        project_directory: ids.project,
        status: "scheduled",
        participants: data.workers.filter((found) => !found.held).length,
        updated_at: ids.abs(0),
      },
    ]
  if (open.source === RADAR_SOURCES.nativeCalls) {
    if (filter.sessionID === ids.architect)
      return nativeCallRows(ids.architect, data.architect.calls, ids)
    const found = worker(filter.sessionID)
    return found ? nativeCallRows(ids.workerSession(found.n), found.calls, ids) : []
  }
  /** Every shown session's model steps are stored: the Architect's and each worker's. */
  const sessionSteps = (sessionID: unknown) => {
    if (sessionID === ids.architect)
      return stepRows(ids.architect, 0, data.architect.model, data.architect.calls, ids)
    const found = worker(sessionID)
    return found
      ? stepRows(ids.workerSession(found.n), found.n, found.model, found.calls, ids)
      : undefined
  }
  if (open.source === RADAR_FLOW_SOURCES.steps) return sessionSteps(filter.sessionID) ?? []
  if (open.source === RADAR_FLOW_SOURCES.transcripts)
    return (Array.isArray(filter.sessionIDs) ? filter.sessionIDs : [])
      .filter((id) => sessionSteps(id) !== undefined)
      .map((id, index) => ({
        id: index + 1,
        session_id: id,
        read_state: "available",
        message_count: (sessionSteps(id)!.length + 1) * 2,
      }))
  const tasks = (group: unknown) =>
    group === "needs-you" ? data.needsYou : group === "failed" ? data.failed : data.queued
  if (open.source === RADAR_SOURCES.group)
    // Newest first, as the source orders the group (`seq desc`).
    return tasks(filter.group)
      .map((task) => ({
        task_id: ids.taskID(task.n),
        seq: task.n,
        reference: ids.ref(task.n),
        title: task.title,
      }))
      .sort((a, b) => b.seq - a.seq)
  if (open.source === RADAR_SOURCES.workload)
    return [
      {
        project_directory: ids.project,
        ready: true,
        queued: data.queued.length,
        needs_you: data.needsYou.length,
        failed: data.failed.length,
      },
    ]
  return []
}

export const radarStreams = (data: () => RadarData, ids: RadarIds) =>
  streamAnswers(SOURCES, (open) => rowsOf(data(), open, ids))

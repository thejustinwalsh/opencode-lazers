import {
  liveHistoryColumns,
  LIVE_HISTORY_SOURCE,
} from "../../../../src/streams/sources/live-history-ref.ts"
import {
  RADAR_SOURCES,
  radarAssignmentColumns,
  radarAttemptDetail,
  radarGroupColumns,
  radarWorkloadColumns,
} from "../../../../src/streams/sources/radar-ref.ts"
import { streamAnswers, type Open, type DemoRow } from "./stream-answers.ts"
import type { DemoCall, DemoWorker, RadarData } from "./radar-answers.ts"

/**
 * The demo's answer to `lazers.streams` for the Radar: the selected worker's attempt
 * (`radar.attempt`), its calls (`observability.liveHistory`: the lane, the newest row and the
 * older-calls list) and a Map group's tasks with the workload (`radar.group`, `radar.workload`),
 * as real frames over the demo's mock world.
 */
export type RadarIds = {
  project: string
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
    workspace: null,
    base_commit: null,
    artifact: null,
  }
}

function rowsOf(data: RadarData, open: Open, ids: RadarIds): DemoRow[] {
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

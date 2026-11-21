import type { Columns } from "../../../../src/streams/frame.ts"
import {
  TRAJECTORY_SOURCES,
  trajectoryAttemptColumns,
  trajectoryEffortColumns,
  trajectoryEffortDetail,
  trajectoryEventColumns,
  trajectoryEventDetail,
  trajectoryTranscriptColumns,
} from "../../../../src/streams/sources/trajectory-ref.ts"
import { TASK_SOURCES, taskScheduleColumns } from "../../../../src/streams/sources/tasks-ref.ts"
import { streamAnswers, type DemoRow, type Open } from "./stream-answers.ts"
import { scheduleRows } from "./tasks-streams.ts"
import {
  attemptID,
  callID,
  markID,
  planID,
  sessionOf,
  taskID,
  transitions,
  when,
} from "./trajectory-answers.ts"
import type { TrajectoryData } from "./trajectory-answers.ts"

/**
 * The demo's answer to `lazers.streams` for the Trajectory sources: the same frames the real
 * reader writes (the real codec), over rows built from the demo's description of one task. The
 * timeline, attempts, effort and transcript rows carry exactly the columns of
 * `src/streams/sources/trajectory-ref.ts`; the task header reads `tasks.schedule`.
 */
const SOURCES: Record<string, { columns: Columns; key: string[]; detail?: Columns }> = {
  [TASK_SOURCES.schedule]: { columns: taskScheduleColumns, key: ["task_id"] },
  [TRAJECTORY_SOURCES.events]: {
    columns: trajectoryEventColumns,
    detail: trajectoryEventDetail,
    key: ["ref"],
  },
  [TRAJECTORY_SOURCES.attempts]: { columns: trajectoryAttemptColumns, key: ["id"] },
  [TRAJECTORY_SOURCES.effort]: {
    columns: trajectoryEffortColumns,
    detail: trajectoryEffortDetail,
    key: ["id"],
  },
  [TRAJECTORY_SOURCES.transcript]: { columns: trajectoryTranscriptColumns, key: ["id"] },
}

const eventRow = (row: DemoRow): DemoRow => ({ sort_key: String(row.ref), ...row, sort_at: row.at })

function eventRows(data: TrajectoryData): DemoRow[] {
  const plan = planID(data, data.task.plan)
  const rows: DemoRow[] = []
  let sequence = 0
  for (const step of transitions(data))
    rows.push(
      eventRow({
        ref: `tr:${++sequence}`,
        kind: "transition",
        at: when(step.at),
        plan_id: plan,
        attempt_id: step.attempt ? attemptID(step.attempt) : null,
        event: step.event,
        from_state: step.from,
        to_state: step.to,
        detail: { event: { id: `tr:${sequence}`, kind: "runner-transition", reason: step.reason } },
      }),
    )
  for (const check of data.checks) {
    const at = when(check.end ?? check.start)
    rows.push(
      eventRow({
        ref: `tr:check-${check.id}-${check.attempt}`,
        kind: "check",
        at,
        plan_id: plan,
        attempt_id: attemptID(check.attempt),
        event: check.id,
        status: check.result,
        detail: {
          event: { id: `tr:check-${check.id}-${check.attempt}`, kind: "verification", at },
          check: {
            id: check.id,
            scope: "attempt",
            attemptID: attemptID(check.attempt),
            state: check.end === null ? "running" : "completed",
            result: check.result,
            command: check.command,
            startedAt: when(check.start),
            endedAt: check.end === null ? null : when(check.end),
            timingBasis: "verification receipt",
            exitCode: check.exit ?? null,
            timedOut: check.end === null ? null : false,
            unchanged: check.end === null ? null : false,
            stdout: check.stdout ?? null,
            stderr: check.stderr ?? null,
            error: null,
          },
        },
      }),
    )
  }
  for (const call of data.calls)
    rows.push(
      eventRow({
        ref: `call:${call.key}`,
        kind: "tool",
        at: when(call.at),
        plan_id: plan,
        attempt_id: attemptID(call.attempt),
        session_id: sessionOf(call.attempt),
        message_id: sessionOf(call.attempt),
        call_id: callID(call),
        status: call.status,
        tool: call.tool,
        completed_at: when(call.at + call.s),
      }),
    )
  return rows
}

function attemptRows(data: TrajectoryData): DemoRow[] {
  const events = eventRows(data)
  return data.attempts.map((attempt) => ({
    id: attemptID(attempt.number),
    plan_id: planID(data, data.task.plan),
    task_id: taskID(data.task.n),
    number: attempt.number,
    state: attempt.state,
    session_id: sessionOf(attempt.number),
    started_at: when(attempt.start),
    tool_count: data.calls.filter((call) => call.attempt === attempt.number).length,
    token_count: 0,
    retry_count: 0,
    model: attempt.model,
    takeover: false,
    last_event_at: Math.max(
      ...events
        .filter((row) => row.attempt_id === attemptID(attempt.number))
        .map((row) => Number(row.at)),
    ),
  }))
}

function effortRows(data: TrajectoryData): DemoRow[] {
  const calls = data.calls.length
  const tokens = calls * 5_200
  const usage = {
    uncachedInput: tokens,
    cacheRead: tokens * 6,
    cacheWrite: Math.round(tokens / 4),
    output: Math.round(tokens / 8),
    reasoning: Math.round(tokens / 16),
  }
  return [
    {
      id: 1,
      task_id: taskID(data.task.n),
      busy: data.attempts.some((attempt) => attempt.end === null),
      uncached_input: usage.uncachedInput,
      output: usage.output,
      reasoning: usage.reasoning,
      cache_read: usage.cacheRead,
      cache_write: usage.cacheWrite,
      sessions: data.attempts.length,
      known_sessions: data.attempts.length,
      market_value: null,
      market_status: "unavailable",
      refreshed_at: when(0),
      effort: {
        effort: {
          acceptedAt: data.task.state === "accepted" ? when(352) : null,
          firstAttemptAt: when(data.attempts[0]?.start ?? 0),
          tokenUsage: {
            measuredSubtotal: usage,
            total: null,
            knownSessions: data.attempts.length,
            totalSessions: data.attempts.length,
            unknownAttempts: [],
          },
          toolCalls: { count: calls },
          recordedCost: { apiEquivalentTotalUsd: null },
        },
      },
    },
  ]
}

function transcriptRows(data: TrajectoryData, session: string): DemoRow[] {
  const attempt = data.attempts.find((item) => sessionOf(item.number) === session)
  if (!attempt) return []
  return [
    {
      id: `${session}:text`,
      ordinal: 0,
      message_id: `${session}:text`,
      kind: "user",
      at: when(attempt.start),
      text: data.task.objective,
      body: {},
    },
    ...data.calls
      .filter((call) => call.attempt === attempt.number)
      .map((call, index) => ({
        id: markID(call.attempt, call.key),
        ordinal: index + 1,
        message_id: session,
        kind: "tool",
        at: when(call.at),
        text: call.tool,
        status: call.status,
        tool: call.tool,
        body: {
          callID: callID(call),
          ...(call.command ? { command: call.command } : {}),
          ...(call.result ? { result: call.result } : {}),
          ...(call.status === "error" ? { error: "Command exited with code 1" } : {}),
          ...(call.path && call.tool !== "Bash"
            ? {
                fileTargets: {
                  coverage: "observed",
                  operation: call.tool === "Edit" ? "edit" : "read",
                  paths: [call.path],
                },
              }
            : {}),
        },
      })),
  ]
}

function rowsOf(data: TrajectoryData, open: Open, project: string): DemoRow[] {
  const filter = open.filter
  if (open.source === TASK_SOURCES.schedule) {
    const tasks = [
      {
        n: data.task.n,
        title: data.task.title,
        state: data.task.state,
        plan: data.task.plan,
        objective: data.task.objective,
      },
      ...data.others
        .filter(
          (task) =>
            (filter.scope as { kind?: string } | undefined)?.kind !== "session" || task.session,
        )
        .map((task) => ({ n: task.n, title: task.title, state: task.state, plan: task.plan })),
    ]
    return (
      scheduleRows({ tasks } as never, project)
        .filter((row) => filter.taskID === undefined || row.task_id === filter.taskID)
        // The story picks by position, so the choices keep one order while the task changes state.
        .sort(
          (a, b) =>
            String(a.plan_id).localeCompare(String(b.plan_id)) ||
            Number(a.ordinal) - Number(b.ordinal),
        )
    )
  }
  if (filter.taskID !== taskID(data.task.n)) return []
  if (open.source === TRAJECTORY_SOURCES.attempts) return attemptRows(data)
  if (open.source === TRAJECTORY_SOURCES.effort) return effortRows(data)
  if (open.source === TRAJECTORY_SOURCES.transcript)
    return transcriptRows(data, String(filter.sessionID))
  if (open.source !== TRAJECTORY_SOURCES.events) return []
  const kinds = filter.kinds as string[] | undefined
  const sign = open.order === "follow" ? -1 : 1
  return eventRows(data)
    .filter((row) => !kinds || kinds.includes(String(row.kind)))
    .filter(
      (row) => !filter.attemptID || row.attempt_id === filter.attemptID || row.attempt_id === null,
    )
    .sort(
      (a, b) =>
        sign *
        (Number(a.sort_at) - Number(b.sort_at) || String(a.ref).localeCompare(String(b.ref))),
    )
}

const held = new Set<string>()

export function trajectoryStreams(data: () => TrajectoryData, project: string) {
  const inner = streamAnswers(SOURCES, (stream) => rowsOf(data(), stream, project))
  return {
    ...inner,
    open: (input: Parameters<typeof inner.open>[0]) => {
      held.add(input.stream)
      return inner.open(input)
    },
    close: (input: { stream: string }) => {
      held.delete(input.stream)
      return inner.close(input)
    },
  }
}

/** Streams the panel holds open now; a change pushes each of them a newer frame. */
export const streamIDs = () => [...held]

import { expect, test } from "bun:test"
import { readFrame, type Columns } from "../../../src/streams/frame.ts"
import { liveHistoryColumns } from "../../../src/streams/sources/live-history-ref.ts"
import {
  radarAssignmentColumns,
  radarAttemptDetail,
  radarGroupColumns,
  radarNativeCallColumns,
  radarWorkloadColumns,
} from "../../../src/streams/sources/radar-ref.ts"
import { radarSessionColumns } from "../../../src/streams/sources/host-sessions-ref.ts"
import {
  radarStepColumns,
  radarTranscriptColumns,
} from "../../../src/streams/sources/radar-flow-ref.ts"
import { assembleLive } from "../../../src/radar/live-view.ts"
import { createFlowModel } from "../../../src/radar/flow-model.ts"
import { radarStreams } from "../src/panels/radar-streams.ts"
import type { RadarData } from "../src/panels/radar-answers.ts"

const model = { providerID: "openai", id: "gpt-6-luna", variant: "max" }
const data: RadarData = {
  rev: 1,
  architect: { busy: true, model, calls: [], updatedAt: 0 },
  workers: [
    {
      n: 204,
      title: "Stream the Radar",
      state: "running",
      startedAt: -60_000,
      model,
      calls: [
        { tool: "read", path: "src/a.ts", at: 1_000, ms: 50 },
        { tool: "edit", path: "src/a.ts", op: "edit", at: 2_000, ms: 80 },
        { tool: "bash", at: 3_000, failed: "exit 1" },
      ],
      toolCount: 7,
      concern: { line: "Repeated test failures", action: "steer" },
    },
  ],
  needsYou: [{ n: 9, title: "Needs a decision" }],
  failed: [],
  queued: [
    { n: 11, title: "Queued one" },
    { n: 12, title: "Queued two" },
  ],
}
const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const server = radarStreams(() => data, {
  project: "/demo",
  architect: "ses-demo",
  taskID: (n) => uid(1, n),
  attemptID: (n) => uid(2, n),
  ref: (n) => `LZ-${n}`,
  workerSession: (n) => `ses-worker-${n}`,
  abs: (at) => 1_000_000 + at,
})
const decode = (reply: { data: string }, columns: Columns) => {
  const bytes = Uint8Array.from(atob(reply.data), (c) => c.charCodeAt(0))
  const frame = readFrame(bytes.buffer, 0, columns)
  return {
    header: frame.header,
    rows: Array.from(
      { length: frame.header.count },
      (_, i) => frame.row(i) as unknown as Record<string, unknown>,
    ),
  }
}
const open = (source: string, filter: Record<string, unknown>, window: number, order = "recent") =>
  server.open({ stream: crypto.randomUUID(), source, filter, order, window })

test("the demo answers the worker pane's attempt and call streams with real frames", () => {
  const attempt = decode(open("radar.attempt", { sessionID: "ses-worker-204" }, 1), {
    ...radarAssignmentColumns,
    ...radarAttemptDetail,
  })
  expect(attempt.rows[0]).toMatchObject({
    id: uid(2, 204),
    state: "running",
    tool_count: 7,
    reference: "LZ-204",
    concern: { line: "Repeated test failures" },
    concern_action: "steer",
  })
  // Every call of the attempt: the four earlier ones and the three listed, newest first.
  const calls = decode(
    open("observability.liveHistory", { sessionID: "ses-worker-204", toolsOnly: true }, 50),
    liveHistoryColumns,
  )
  expect(calls.rows).toHaveLength(7)
  expect(calls.rows[0]).toMatchObject({ tool: "bash", status: "failed" })
  expect(calls.rows[1]?.file_targets_json).toEqual({
    coverage: "observed",
    operation: "edit",
    paths: ["src/a.ts"],
  })
  // The older-calls list reads before a time.
  const older = decode(
    open("observability.liveHistory", { sessionID: "ses-worker-204", beforeAt: 1_001_000 }, 50),
    liveHistoryColumns,
  )
  expect(older.rows).toHaveLength(4)
  expect(
    decode(open("radar.attempt", { sessionID: "ses-nobody" }, 1), radarAssignmentColumns).rows,
  ).toEqual([])
})

test("the demo answers a Map group and the workload; the workload is indexed, never a zero default", () => {
  const queued = decode(open("radar.group", { group: "queued" }, 50), radarGroupColumns)
  expect(queued.rows.map((row) => row.reference)).toEqual(["LZ-12", "LZ-11"])
  const workload = decode(open("radar.workload", {}, 1, "key"), radarWorkloadColumns)
  expect(workload.rows[0]).toMatchObject({ ready: true, queued: 2, needs_you: 1, failed: 0 })
})

test("the demo answers the Monitor's sessions, calls and model steps; Flow draws them", () => {
  const sessions = decode(open("radar.sessions", {}, 40), radarSessionColumns)
  expect(sessions.rows.map((row) => [row.session_id, row.role, row.parent_session_id])).toEqual([
    ["ses-worker-204", "worker", "ses-demo"],
    ["ses-demo", "architect", null],
  ])
  const steps = decode(open("radar.steps", { sessionID: "ses-worker-204" }, 18), radarStepColumns)
  expect(steps.rows).toHaveLength(3)
  expect(steps.rows[0]).toMatchObject({ model_id: "gpt-6-luna", input_tokens: 27_000 })
  const transcripts = decode(
    open("radar.transcripts", { sessionIDs: ["ses-worker-204"] }, 1, "key"),
    radarTranscriptColumns,
  )
  expect(transcripts.rows[0]).toMatchObject({ read_state: "available" })
  const native = decode(
    open("radar.nativeCalls", { sessionID: "ses-worker-204" }, 18),
    radarNativeCallColumns,
  )
  expect(native.rows[0]).toMatchObject({ tool: "bash", status: "failed", error: "exit 1" })
  const assignments = decode(open("radar.assignments", {}, 40), radarAssignmentColumns)
  const calls = decode(
    open("observability.liveHistory", { sessionID: "ses-worker-204", toolsOnly: true }, 18),
    liveHistoryColumns,
  )
  const scope = { kind: "project" as const, sessionID: "ses-demo" }
  const live = assembleLive({
    scope,
    projectDirectory: "/demo",
    now: 1_000_000 + 3_500,
    includeUnmanagedSessions: false,
    sessions: sessions.rows,
    assignments: assignments.rows,
    calls: new Map([["ses-worker-204", calls.rows]]),
    nativeCalls: new Map([["ses-worker-204", native.rows]]),
    steps: new Map([["ses-worker-204", steps.rows]]),
    phasesLoading: new Set(),
  })
  const flow = createFlowModel(live, 1_000_000 + 3_500)
  expect(flow.quiet).toBe(false)
  expect(flow.models[0]).toMatchObject({ name: "gpt-6-luna", calls: 3 })
  expect(flow.feed.some((row) => row.kind === "model")).toBe(true)
})

test("the demo answers the Architect's model steps too: every shown session's are stored", () => {
  const withCalls: RadarData = {
    ...data,
    architect: { ...data.architect, calls: [{ tool: "read", at: 500, ms: 40 }] },
  }
  const server = radarStreams(() => withCalls, {
    project: "/demo",
    architect: "ses-demo",
    taskID: (n) => uid(1, n),
    attemptID: (n) => uid(2, n),
    ref: (n) => `LZ-${n}`,
    workerSession: (n) => `ses-worker-${n}`,
    abs: (at) => 1_000_000 + at,
  })
  const reply = server.open({
    stream: crypto.randomUUID(),
    source: "radar.steps",
    filter: { sessionID: "ses-demo" },
    order: "recent",
    window: 18,
  })
  expect(decode(reply, radarStepColumns).rows).toMatchObject([{ model_id: "gpt-6-luna" }])
})

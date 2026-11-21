import { expect, test } from "bun:test"
import { readFrame, type Columns } from "../../../src/streams/frame.ts"
import { liveHistoryColumns } from "../../../src/streams/sources/live-history-ref.ts"
import {
  radarAssignmentColumns,
  radarAttemptDetail,
  radarGroupColumns,
  radarWorkloadColumns,
} from "../../../src/streams/sources/radar-ref.ts"
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

import { expect, mock, test } from "bun:test"
import { frameSize, writeFrame, type Columns } from "../streams/frame.ts"
import type { StreamsTransport } from "../streams/gui.ts"
import { liveHistoryRef } from "../streams/sources/live-history-ref.ts"
import { radarFlowRefs } from "../streams/sources/radar-flow-ref.ts"
import { radarRefs } from "../streams/sources/radar-ref.ts"

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(condition()).toBe(true)
}

/** One frame of `rows` (objects by column name) as the Streams RPC sends it. */
function frame(columns: Columns, rows: Record<string, unknown>[]) {
  const cells = rows.map((row) => Object.keys(columns).map((name) => row[name] ?? null))
  const buffer = new ArrayBuffer(frameSize(columns, cells))
  writeFrame(buffer, 0, columns, { revision: 1, count: rows.length, before: 0, after: 0 }, cells)
  return { seq: 1, data: Buffer.from(buffer).toString("base64") }
}

const COLUMNS: Record<string, Columns> = {
  [radarRefs.sessions.name]: radarRefs.sessions.columns,
  [radarRefs.assignments.name]: radarRefs.assignments.columns,
  [radarRefs.scheduler.name]: radarRefs.scheduler.columns,
  [radarRefs.workload.name]: radarRefs.workload.columns,
  [radarRefs.nativeCalls.name]: radarRefs.nativeCalls.columns,
  [radarFlowRefs.steps.name]: radarFlowRefs.steps.columns,
  [radarFlowRefs.transcripts.name]: radarFlowRefs.transcripts.columns,
  [liveHistoryRef.name]: liveHistoryRef.columns,
}

test("a running worker whose session row arrives after its assignment is one row", async () => {
  const now = Date.now()
  const worker = {
    id: 3,
    session_id: "ses-worker",
    role: "worker",
    title: "LZ · worker",
    attempt_id: "attempt-1",
    task_id: "task-1",
    busy: true,
    pending_input: false,
    pending_permissions: 0,
    pending_forms: 0,
    archived: false,
    created_at: now - 1000,
    updated_at: now,
    host_updated_at: now,
  }
  const assignment = {
    id: "attempt-1",
    session_id: "ses-worker",
    plan_id: "plan-1",
    task_id: "task-1",
    number: 1,
    state: "running",
    started_at: now - 1000,
    tool_count: 0,
    takeover: false,
    reference: "LZ-1",
    title: "worker",
  }
  // The project's session window answers after the assignments: the worker is outside it at first.
  let release!: () => void
  const windowGate = new Promise<void>((resolve) => (release = resolve))
  const transport: StreamsTransport = {
    async open(input) {
      const columns = COLUMNS[input.source]!
      const filter = input.filter as { sessionID?: string }
      if (input.source === radarRefs.sessions.name) {
        if (filter.sessionID === undefined) await windowGate
        return frame(columns, [worker])
      }
      if (input.source === radarRefs.assignments.name) return frame(columns, [assignment])
      return frame(columns, [])
    },
    slide: async () => frame({ id: "int" }, []),
    seek: async () => frame({ id: "int" }, []),
    read: async () => frame({ id: "int" }, []),
    touch: async () => ({ alive: true }),
    close: async () => {},
    onChanged: () => () => {},
  }
  // The GUI client is reactive: load the browser build of Solid (the server build never runs effects).
  const browserSolid = "../../node_modules/solid-js/dist/solid.js"
  const serverSolid = await import("solid-js")
  const browser = (await import(browserSolid)) as typeof import("solid-js")
  mock.module("solid-js", () => browser)
  try {
    const module = "./monitor-streams.ts?browser-solid"
    const { openMonitorStreams } = (await import(module)) as typeof import("./monitor-streams.ts")
    const monitor = openMonitorStreams({
      key: "k",
      transport,
      projectDirectory: "/project",
      scope: { kind: "project", sessionID: "ses-architect" },
      includeUnmanagedSessions: false,
      online: () => true,
    })
    // The worker's own session stream answers first; then the window brings the same row.
    await new Promise((r) => setTimeout(r, 30))
    release()
    await until(() => (monitor.data().live?.sessions.length ?? 0) > 0)
    await new Promise((r) => setTimeout(r, 30))
    const sessions = monitor.data().live!.sessions
    expect(sessions.map((session) => session.sessionID)).toEqual(["ses-worker"])
    monitor.dispose()
  } finally {
    mock.module("solid-js", () => serverSolid)
  }
})

import { afterAll, beforeAll, expect, test } from "bun:test"
import { makeFixture } from "../../../test/trajectory/fixture.ts"
import { ensureHostSessionStateSchema, writeHostSession } from "../../host-sessions/state.ts"
import { ensureTranscriptMetaSchema, writeTranscriptPage } from "../../transcript-meta/schema.ts"
import { readFrame } from "../frame.ts"
import { base64ToBytes } from "../gui.ts"
import { readerPool, type ReaderPool } from "../pool.ts"
import { createStreamsService } from "../rpc.ts"
import { radarStepColumns, radarTranscriptColumns } from "./radar-flow-ref.ts"
import { radarNativeCallColumns } from "./radar-ref.ts"
import { radarSessionColumns } from "./host-sessions-ref.ts"
import { ensureNativeCallDisplaySchema } from "../../progress/native-call-display.ts"
import { assembleLive } from "../../radar/live-view.ts"
import { sessionCallLines } from "../../radar/monitor-model.ts"
import "./radar.ts"
import "./host-sessions.ts"
import "./radar-flow.ts"

let fixture: ReturnType<typeof makeFixture>
let pool: ReaderPool
let project: string

const step = (id: string, created: number) => ({
  type: "assistant",
  id,
  model: { providerID: "openai", id: "gpt-6-luna" },
  time: { created, completed: created + 10 },
  tokens: { input: 5, output: 1 },
})

beforeAll(() => {
  fixture = makeFixture()
  project = fixture.directory
  ensureHostSessionStateSchema(fixture.repository)
  ensureTranscriptMetaSchema(fixture.repository)
  ensureNativeCallDisplaySchema(fixture.repository)
  const fresh = { cursor: null, base: 0, messageCount: 0, state: "not-read" as const }
  fixture.repository.atomic((db) => {
    writeTranscriptPage(db, project, "ses-worker", fresh, [step("m1", 1), step("m2", 2)], undefined)
    writeTranscriptPage(db, project, "ses-child", fresh, [step("c1", 3)], "next-page")
    writeTranscriptPage(db, project, "ses-other", fresh, [step("o1", 4)], undefined)
    for (const [id, parentID] of [
      ["ses-worker", null],
      ["ses-child", "ses-worker"],
      ["ses-other", null],
    ] as const)
      writeHostSession(db, project, "project", id, {
        id,
        projectID: "project",
        parentID,
        agent: "build",
        title: null,
        directory: project,
        archived: false,
        busy: false,
        outcome: null,
        model: null,
        tokensIn: 0,
        tokensOut: 0,
        tokensReasoning: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        createdAt: 1,
        updatedAt: 1,
      })
  })
  // A subagent of ses-worker makes a call; another session makes one too.
  fixture.repository.atomic((db) => {
    const call = db.query(
      `INSERT INTO native_tool_calls(project_directory,project_id,session_id,identity_kind,
         invocation_id,native_call_id,context_call_id,message_id,agent,tool,first_observed_at,
         last_observed_at,sources_json,event_ids_json,payload)
       VALUES(?,'project',?,'native-call',?,?,?,'m','explore','read',?,?,'[]','[]',?)`,
    )
    call.run(
      project,
      "ses-child",
      "c-child",
      "c-child",
      "c-child",
      100,
      200,
      '{"status":"succeeded","detail":"read src/a.ts"}',
    )
    call.run(
      project,
      "ses-other",
      "c-other",
      "c-other",
      "c-other",
      100,
      200,
      '{"status":"succeeded"}',
    )
  })
  pool = readerPool(fixture.repository.path, { workers: 1 })
})
afterAll(async () => {
  await pool.close()
  fixture.close()
})

function service() {
  return createStreamsService({
    pool,
    changed: () => {},
    context: {
      projectID: "project",
      projectDirectory: project,
      projectIds: (id) => [id],
      assertRead: async () => {},
      read: (run) => fixture.repository.read(run),
    },
  })
}

async function open(
  streams: ReturnType<typeof service>,
  source: string,
  filter: Record<string, unknown>,
  order: string,
) {
  const frame = await streams.open({
    stream: crypto.randomUUID(),
    source,
    filter: { projectDirectory: "/elsewhere", ...filter },
    order,
    window: 40,
  })
  const bytes = base64ToBytes(frame.data)
  const columns = {
    "radar.steps": radarStepColumns,
    "radar.transcripts": radarTranscriptColumns,
    "radar.nativeCalls": radarNativeCallColumns,
    "radar.sessions": radarSessionColumns,
  }[source]!
  const read = readFrame(bytes.buffer, bytes.byteOffset, columns)
  return Array.from({ length: read.header.count }, (_, i) => read.row(i) as Record<string, unknown>)
}

test("radar.steps: one session's steps newest first, in the service's project", async () => {
  const streams = service()
  try {
    const rows = await open(
      streams,
      "radar.steps",
      { scope: { kind: "project", sessionID: "ses-worker" }, sessionID: "ses-worker" },
      "recent",
    )
    expect(rows.map((row) => row.message_id)).toEqual(["m2", "m1"])
    expect(rows[0]).toMatchObject({ model_id: "gpt-6-luna", input_tokens: 5, output_tokens: 1 })
  } finally {
    streams.dispose()
  }
})

test("radar.transcripts: read state per listed session; a page not at the end is not-read", async () => {
  const streams = service()
  try {
    const rows = await open(
      streams,
      "radar.transcripts",
      {
        scope: { kind: "project", sessionID: "ses-worker" },
        sessionIDs: ["ses-worker", "ses-child", "ses-missing"],
      },
      "key",
    )
    expect(Object.fromEntries(rows.map((row) => [row.session_id, row.read_state]))).toEqual({
      "ses-worker": "available",
      "ses-child": "not-read",
    })
  } finally {
    streams.dispose()
  }
})

test("authorize: a session view reads its own session and its children, not another", async () => {
  const streams = service()
  const scope = { kind: "session", sessionID: "ses-worker" }
  try {
    expect(
      (await open(streams, "radar.steps", { scope, sessionID: "ses-child" }, "recent")).length,
    ).toBe(1)
    await expect(
      open(streams, "radar.steps", { scope, sessionID: "ses-other" }, "recent"),
    ).rejects.toThrow("unavailable")
    await expect(
      open(streams, "radar.transcripts", { scope, sessionIDs: ["ses-worker", "ses-other"] }, "key"),
    ).rejects.toThrow("unavailable")
  } finally {
    streams.dispose()
  }
})

test("radar.nativeCalls: a session view reads its subagent child's calls, not another session's", async () => {
  const streams = service()
  const scope = { kind: "session", sessionID: "ses-worker" }
  try {
    const child = await open(
      streams,
      "radar.nativeCalls",
      { scope, sessionID: "ses-child" },
      "recent",
    )
    expect(child.map((row) => row.call_id)).toEqual(["c-child"])
    await expect(
      open(streams, "radar.nativeCalls", { scope, sessionID: "ses-other" }, "recent"),
    ).rejects.toThrow("unavailable")
  } finally {
    streams.dispose()
  }
})

test("parity: a session view lists its subagent child with the child's calls, as the old read did", async () => {
  const streams = service()
  const scope = { kind: "session" as const, sessionID: "ses-worker" }
  try {
    const sessions = await open(streams, "radar.sessions", { scope }, "recent")
    expect(sessions.map((row) => row.session_id).sort()).toEqual(["ses-child", "ses-worker"])
    const nativeCalls = new Map<string, Record<string, unknown>[]>()
    for (const row of sessions) {
      const id = String(row.session_id)
      nativeCalls.set(
        id,
        await open(streams, "radar.nativeCalls", { scope, sessionID: id }, "recent"),
      )
    }
    const live = assembleLive({
      scope,
      projectDirectory: project,
      now: 1_000,
      includeUnmanagedSessions: false,
      sessions,
      assignments: [],
      calls: new Map(),
      nativeCalls,
      steps: new Map(),
      phasesLoading: new Set(),
    })
    expect(live.sessions.find((item) => item.sessionID === "ses-child")?.parentSessionID).toBe(
      "ses-worker",
    )
    // The old read's native call line: status from the payload, ended at its last observation.
    expect(sessionCallLines(live, "ses-child")).toMatchObject([
      {
        callID: "c-child",
        tool: "read",
        status: "completed",
        current: false,
        detail: "read src/a.ts",
        startedAt: 100,
        endedAt: 200,
      },
    ])
  } finally {
    streams.dispose()
  }
})

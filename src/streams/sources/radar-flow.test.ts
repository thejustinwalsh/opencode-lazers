import { afterAll, beforeAll, expect, test } from "bun:test"
import { makeFixture } from "../../../test/trajectory/fixture.ts"
import { ensureHostSessionStateSchema, writeHostSession } from "../../host-sessions/state.ts"
import { ensureTranscriptMetaSchema, writeTranscriptPage } from "../../transcript-meta/schema.ts"
import { readFrame } from "../frame.ts"
import { base64ToBytes } from "../gui.ts"
import { readerPool, type ReaderPool } from "../pool.ts"
import { createStreamsService } from "../rpc.ts"
import { radarStepColumns, radarTranscriptColumns } from "./radar-flow-ref.ts"
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
    window: 18,
  })
  const bytes = base64ToBytes(frame.data)
  const columns = source === "radar.steps" ? radarStepColumns : radarTranscriptColumns
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

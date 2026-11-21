import { afterAll, beforeAll, expect, test } from "bun:test"
import { makeFixture } from "../../../test/trajectory/fixture.ts"
import {
  ensureHostSessionStateSchema,
  writeHostSession,
  type HostSessionRecord,
} from "../../host-sessions/state.ts"
import { openStream } from "../client.ts"
import { readFrame } from "../frame.ts"
import { base64ToBytes } from "../gui.ts"
import { readerPool, type ReaderPool } from "../pool.ts"
import { createStreamsService } from "../rpc.ts"
import { streamColumns } from "../source.ts"
import { radarSessionsSource } from "./host-sessions.ts"
import { radarSessionColumns, type RadarSessionsFilter } from "./host-sessions-ref.ts"
import type { RadarScope } from "./radar-ref.ts"

let fixture: ReturnType<typeof makeFixture>
let pool: ReaderPool
let project: string
const owner: RadarScope = { kind: "project", sessionID: "ses-architect" }

const record = (id: string, patch: Partial<HostSessionRecord> = {}): HostSessionRecord => ({
  id,
  projectID: "project",
  parentID: null,
  agent: "build",
  title: null,
  directory: "/work",
  archived: false,
  busy: false,
  outcome: null,
  model: null,
  tokensIn: 1,
  tokensOut: 1,
  tokensReasoning: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

beforeAll(() => {
  fixture = makeFixture()
  project = fixture.directory
  ensureHostSessionStateSchema(fixture.repository)
  let at = 1_000
  fixture.repository.atomic((db) => {
    for (const item of [
      record("ses-architect", { agent: "architect" }),
      record("ses-child", { parentID: "ses-architect" }),
      record("ses-failed", { busy: true }),
      record("ses-old", { archived: true }),
      record("ses-human"),
    ])
      writeHostSession(db, project, "project", item.id, item, undefined, at++)
  })
  pool = readerPool(fixture.repository.path, { workers: 1 })
})
afterAll(async () => {
  await pool.close()
  fixture.close()
})

async function sessions(filter: RadarSessionsFilter) {
  const stream = openStream(pool, radarSessionsSource, {
    filter,
    order: "recent",
    window: 40,
    transport: "copy",
  })
  await stream.ready()
  const columns = Object.keys(streamColumns(radarSessionsSource as never, 40))
  const items = stream.items.map((row) =>
    Object.fromEntries(columns.map((column) => [column, (row as Record<string, unknown>)[column]])),
  )
  stream.close()
  return items
}

test("radar.sessions: newest change first, archived left out unless asked, a session with its children", async () => {
  const all = await sessions({ projectDirectory: project, scope: owner })
  expect(all.map((row) => row.session_id)).toEqual([
    "ses-human",
    "ses-failed",
    "ses-child",
    "ses-architect",
  ])
  expect(all.find((row) => row.session_id === "ses-failed")).toMatchObject({
    role: "worker",
    busy: true,
  })
  expect(
    (await sessions({ projectDirectory: project, scope: owner, includeArchived: true })).length,
  ).toBe(5)
  const family = await sessions({
    projectDirectory: project,
    scope: owner,
    sessionID: "ses-architect",
  })
  expect(family.map((row) => [row.session_id, row.role])).toEqual([
    ["ses-child", "unmanaged"],
    ["ses-architect", "architect"],
  ])
})

test("radar.sessions: a fold write reaches an open stream", async () => {
  const stream = openStream(pool, radarSessionsSource, {
    filter: { projectDirectory: project, scope: owner },
    order: "recent",
    window: 40,
    transport: "copy",
  })
  await stream.ready()
  let changes = 0
  stream.on("change", () => changes++)
  try {
    fixture.repository.atomic((db) =>
      writeHostSession(
        db,
        project,
        "project",
        "ses-architect",
        record("ses-architect", { agent: "architect", busy: true, updatedAt: 5 }),
        { busy: true, pendingInput: false, pendingPermissions: 1, pendingForms: 0, outcome: null },
        9_000,
      ),
    )
    for (let waited = 0; waited < 50 && changes === 0; waited++) await Bun.sleep(20)
    expect(changes).toBeGreaterThan(0)
    expect(stream.items[0]).toMatchObject({ session_id: "ses-architect", pending_permissions: 1 })
  } finally {
    stream.close()
  }
})

test("authorize: a session view reads its own session and children; the caller's directory is overwritten", async () => {
  const asked: string[] = []
  const service = createStreamsService({
    pool,
    changed: () => {},
    context: {
      projectID: "project",
      projectDirectory: project,
      projectIds: (id) => [id],
      assertRead: async (sessionID) => {
        asked.push(sessionID)
        if (sessionID === "ses-denied") throw new Error("Not permitted")
      },
    },
  })
  const open = async (filter: Record<string, unknown>) => {
    const frame = await service.open({
      stream: crypto.randomUUID(),
      source: "radar.sessions",
      filter: { projectDirectory: "/elsewhere", scope: owner, ...filter },
      order: "recent",
      window: 40,
    })
    const bytes = base64ToBytes(frame.data)
    const read = readFrame(bytes.buffer, bytes.byteOffset, radarSessionColumns)
    return Array.from({ length: read.header.count }, (_, i) => read.row(i).session_id).sort()
  }
  try {
    expect((await open({})).length).toBe(4)
    expect(
      await open({
        scope: { kind: "session", sessionID: "ses-architect" },
        sessionID: "ses-human",
      }),
    ).toEqual(["ses-architect", "ses-child"])
    await expect(open({ scope: { kind: "project", sessionID: "ses-denied" } })).rejects.toThrow(
      "Not permitted",
    )
    expect(asked).toEqual(["ses-architect", "ses-architect", "ses-denied"])
  } finally {
    service.dispose()
  }
})

import { Database } from "bun:sqlite"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { Cause, Effect, Queue, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HostMessage } from "../../core/host-messages.ts"
import { databaseChanges } from "../../database-events.ts"
import { messageSliceEvents, object } from "../../trajectory/message-events.ts"
import { privacyStats, safeText } from "../../trajectory/privacy.ts"
import { dateMillis } from "../../transcript-meta/step.ts"
import { readFrame } from "../frame.ts"
import type { StreamsTransport } from "../gui.ts"
import { bindHostRuntime, defineHostSource, openHostStream } from "../host-source.ts"
import { createStreamsService } from "../rpc.ts"
import type { StreamContext } from "../source.ts"
import {
  messageRows,
  trajectoryEffortSource,
  trajectoryTranscriptSource,
  type TrajectoryHostRuntime,
} from "./trajectory-host.ts"
import {
  TRAJECTORY_SOURCES,
  trajectoryEffortColumns,
  trajectoryEffortDetail,
  trajectoryTranscriptColumns,
  type TrajectoryScope,
} from "./trajectory-ref.ts"

const project = "/work/p"
const session = "ses-worker"
const taskID = "task-1"
const owner: TrajectoryScope = { kind: "project", sessionID: "ses-owner" }

/** 120 messages: user, assistant (text + reasoning + tool), a shell, a system and a skill. */
function messages(): HostMessage[] {
  const out: Record<string, unknown>[] = []
  for (let n = 0; n < 120; n++) {
    const id = `msg-${String(n).padStart(3, "0")}`
    const time = { created: 1000 + n }
    if (n % 6 === 0)
      out.push({ id, type: "user", text: `ask ${n}`, time, files: [{ name: "private.png" }] })
    else if (n % 6 === 1)
      out.push({
        id,
        type: "assistant",
        model: { providerID: "openai", id: "gpt" },
        time: { created: 1000 + n, completed: 1001 + n },
        content: [
          { type: "reasoning", text: "SECRET-REASONING" },
          { type: "text", text: `answer ${n}` },
          {
            type: "tool",
            id: `call-${n}`,
            name: "bash",
            time: { ran: 1000 + n, completed: 1001 + n },
            executed: true,
            state: {
              status: "completed",
              input: { command: "ls" },
              content: [{ type: "text", text: "listing" }],
            },
          },
        ],
      })
    else if (n % 6 === 2)
      out.push({
        id,
        type: "shell",
        command: "echo hi",
        status: "completed",
        time,
        output: { output: "hi" },
      })
    else if (n % 6 === 3) out.push({ id, type: "system", text: "SECRET-SYSTEM", time })
    else if (n % 6 === 4) out.push({ id, type: "skill", name: "SECRET-SKILL", time })
    else
      out.push({
        id,
        type: "assistant",
        model: { providerID: "openai", id: "gpt" },
        time,
        content: [],
      })
  }
  return out as unknown as HostMessage[]
}

/**
 * A host message list with the page cursors the real one has: `f:<n>` reads forward from
 * boundary n, `b:<n>` reads the messages before boundary n, each page ascending. As the real host
 * does (probed read-only through the driver client, 2026-11-21: `.cache/driver/
 * claude-backward-paging.ts`, `claude-tail-paging.ts`), every page with messages carries both
 * `next` (after its last message) and `previous` (before its first), at the ends of the list too;
 * the page read through an end's cursor is empty and carries neither.
 */
function fakeHost(store: Map<string, HostMessage[]>) {
  const state = { lists: 0 }
  const client = {
    message: {
      async list(input: { sessionID: string; limit: number; cursor?: string; order?: string }) {
        state.lists++
        const all = store.get(input.sessionID) ?? []
        const n = all.length
        const [kind, at] = input.cursor
          ? [input.cursor[0], Number(input.cursor.slice(2))]
          : ["f", 0]
        const [lo, hi] =
          kind === "f" ? [at, Math.min(n, at + input.limit)] : [Math.max(0, at - input.limit), at]
        return {
          data: all.slice(lo, hi),
          cursor: hi > lo ? { next: `f:${hi}`, previous: `b:${lo}` } : {},
        }
      },
    },
  }
  return { client: client as unknown as TrajectoryHostRuntime["messages"], state }
}

let dir: string
let db: Database
let path: string
let store: Map<string, HostMessage[]>
let host: ReturnType<typeof fakeHost>
let touched: string[]
let detailCalls: number
let runtime: TrajectoryHostRuntime
let unbind: () => void

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lz-host-"))
  path = join(dir, "db.sqlite")
  db = new Database(path)
  db.run(`CREATE TABLE tasks(project_directory TEXT, id TEXT);
    CREATE TABLE task_schedule_sessions(session_id TEXT, task_id TEXT);
    CREATE TABLE runner_attempts(project_directory TEXT, task_id TEXT, session_id TEXT);
    CREATE TABLE transcript_sessions(project_directory TEXT, session_id TEXT, cursor TEXT);
    CREATE TABLE transcript_steps(id INTEGER PRIMARY KEY, note TEXT);
    CREATE TABLE trajectory_task_effort(id INTEGER PRIMARY KEY, project_directory TEXT, task_id TEXT,
      busy INTEGER, uncached_input INTEGER, output INTEGER, reasoning INTEGER, cache_read INTEGER,
      cache_write INTEGER, sessions INTEGER, known_sessions INTEGER, market_value TEXT,
      market_status TEXT, refreshed_at INTEGER)`)
  db.run("INSERT INTO tasks VALUES(?,?)", [project, taskID])
  db.run("INSERT INTO runner_attempts VALUES(?,?,?)", [project, taskID, session])
  databaseChanges.track(db, path)
  store = new Map([[session, messages()]])
  host = fakeHost(store)
  touched = []
  detailCalls = 0
  runtime = {
    messages: host.client,
    databasePath: path,
    read: (run) => run(db),
    effortDetail: async () => {
      detailCalls++
      return { taskEffortBasis: { assessments: [{ id: "a1" }] }, tokens: 7 } as never
    },
    touchEffort: (id) => void touched.push(id),
  }
  unbind = bindHostRuntime(project, runtime)
})
afterAll(() => {
  unbind()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const open = (
  window: number,
  anchor?: "head" | "tail" | { key: unknown[]; place?: "start" | "center" },
) =>
  openHostStream(trajectoryTranscriptSource, {
    filter: { projectDirectory: project, scope: owner, taskID, sessionID: session },
    window,
    runtime,
    ...(anchor ? { anchor: anchor as never } : {}),
  })
const reference = messageRowsOf(messages())
function messageRowsOf(all: HostMessage[]) {
  return all.flatMap((message, at) => messageRows(message, at))
}
const idsOf = (stream: { items: readonly { id: unknown }[] }) => stream.items.map((row) => row.id)
const refIds = (from: number, to: number) => reference.slice(from, to).map((row) => row[0])
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 300; i++) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error("condition not reached")
}

test("a window reads the session's events in host order, across host pages", async () => {
  const stream = open(120)
  await stream.ready()
  expect(idsOf(stream)).toEqual(refIds(0, 120))
  expect(stream.before).toBe(0)
  stream.close()
  const wide = open(100_000)
  await wide.ready()
  expect(idsOf(wide)).toEqual(refIds(0, reference.length))
  expect(wide.after).toBe(0)
  wide.close()
})

test("privacy: reasoning, system, skill and attachments never appear; tool text is filtered", async () => {
  const stream = open(100_000)
  await stream.ready()
  const text = JSON.stringify(
    stream.items.map((row) => [row.id, row.kind, row.text, row.status, row.tool, row.body]),
  )
  for (const secret of ["SECRET-REASONING", "SECRET-SYSTEM", "SECRET-SKILL", "private.png"])
    expect(text).not.toContain(secret)
  const kinds = new Set(stream.items.map((row) => row.kind))
  expect(kinds).toEqual(new Set(["user", "assistant-step", "assistant-text", "tool", "shell"]))
  const tool = stream.items.find((row) => row.kind === "tool")!
  expect(tool.tool).toBe("bash")
  expect(tool.status).toBe("completed")
  expect(JSON.stringify(tool.body)).toContain("listing")
  stream.close()
})

test("the rows match the old read's message events (the moved functions) event for event", () => {
  const message = messages()[1]!
  const raw = message as unknown as Record<string, unknown>
  const stats = privacyStats()
  const old: Record<string, unknown>[] = []
  messageSliceEvents(
    {
      stats,
      base: (id, at, kind) => ({ id: safeText(id, stats, 256), at, kind }),
      add: (event) => old.push(event),
    },
    { message: raw, messageID: String(raw.id), createdAt: dateMillis(object(raw.time)?.created) },
  )
  const rows = messageRows(message)
  expect(rows.map((row) => row[0])).toEqual(old.map((event) => event.id))
  expect(rows.map((row) => row[3])).toEqual(old.map((event) => event.kind))
  const toolRow = rows.find((row) => row[3] === "tool")!
  const toolEvent = old.find((event) => event.kind === "tool")!
  expect((toolRow[8] as Record<string, unknown>).input).toEqual(toolEvent.input as never)
  expect((toolRow[8] as Record<string, unknown>).result).toBe(toolEvent.result as never)
})

test("slides walk the whole transcript forward and back, over host pages and mid-message edges", async () => {
  const stream = open(7, "head")
  await stream.ready()
  expect(idsOf(stream)).toEqual(refIds(0, 7))
  let at = 0
  for (const step of [3, 5, 11, 40, -2, -9, 1, 60, -75, 13]) {
    at = Math.max(0, Math.min(reference.length - 7, at + step))
    await stream.slide(step)
    expect(idsOf(stream)).toEqual(refIds(at, at + 7))
  }
  await stream.slide(-100_000)
  expect(idsOf(stream)).toEqual(refIds(0, 7))
  expect(stream.before).toBe(0)
  await stream.slide(100_000)
  expect(idsOf(stream)).toEqual(refIds(reference.length - 7, reference.length))
  expect(stream.after).toBe(0)
  expect(stream.before).toBe("more")
  stream.close()
})

test("tail anchors the last window; seek to a key centers it; head resets", async () => {
  const stream = open(10, "tail")
  await stream.ready()
  expect(idsOf(stream)).toEqual(refIds(reference.length - 10, reference.length))
  expect([stream.before, stream.after]).toEqual(["more", 0])
  const mid = Math.floor(reference.length / 2)
  const key = reference[Math.floor(reference.length / 2)]![0]
  await stream.seek({ key: [key] } as never)
  expect(idsOf(stream)).toEqual(refIds(mid - 5, mid + 5))
  await stream.seek({ key: [key], place: "start" } as never)
  expect(idsOf(stream)[0]).toBe(key)
  await stream.slide(-4)
  expect(idsOf(stream)).toEqual(refIds(mid - 4, mid + 6))
  await expect(stream.seek({ key: ["no-such-row"] } as never)).rejects.toThrow("no row")
  await stream.seek("head")
  expect(idsOf(stream)).toEqual(refIds(0, 10))
  stream.close()
})

test("the real host's list ends: a stored end cursor and the first page's previous read as ends", async () => {
  // The transcript fold stores the cursor it last read through: at the end of the list, the
  // `next` of the last page, whose page is empty and carries no cursor.
  const n = store.get(session)!.length
  db.run("INSERT INTO transcript_sessions VALUES(?,?,?)", [project, session, `f:${n}`])
  try {
    const stream = open(10, "tail")
    await stream.ready()
    expect(idsOf(stream)).toEqual(refIds(reference.length - 10, reference.length))
    // Back to the head across pages: each preceding page is read ascending, and the first page's
    // `previous` (an empty page) ends the walk instead of naming a position.
    await stream.slide(-100_000)
    expect(idsOf(stream)).toEqual(refIds(0, 10))
    expect(stream.before).toBe(0)
    // A refresh re-reads from the window's start: still the head window, not the empty page.
    await stream.slide(3)
    await stream.slide(-3)
    expect(idsOf(stream)).toEqual(refIds(0, 10))
    stream.close()
  } finally {
    db.run("DELETE FROM transcript_sessions WHERE session_id=?", [session])
  }
})

test("a tail open of a transcript shorter than one host page is one host read", async () => {
  const short = new Map([["ses-short", messages().slice(0, 10)]])
  const shortHost = fakeHost(short)
  db.run("INSERT INTO runner_attempts VALUES(?,?,?)", [project, taskID, "ses-short"])
  const stream = openHostStream(trajectoryTranscriptSource, {
    filter: { projectDirectory: project, scope: owner, taskID, sessionID: "ses-short" },
    window: 6,
    anchor: "tail",
    runtime: { ...runtime, messages: shortHost.client },
  })
  await stream.ready()
  expect(idsOf(stream)).toEqual(
    messageRowsOf(short.get("ses-short")!)
      .slice(-6)
      .map((row) => row[0]),
  )
  // The page holds fewer messages than the limit: the empty page past the end is never read,
  // and the window is cut from the same page.
  expect(shortHost.state.lists).toBe(1)
  stream.close()
})

test("a hint after a new message updates a tail window; close stops the host reads", async () => {
  const live = new Map([["ses-live", messages().slice(0, 10)]])
  const liveHost = fakeHost(live)
  const liveRuntime = { ...runtime, messages: liveHost.client }
  db.run("INSERT INTO runner_attempts VALUES(?,?,?)", [project, taskID, "ses-live"])
  const stream = openHostStream(trajectoryTranscriptSource, {
    filter: { projectDirectory: project, scope: owner, taskID, sessionID: "ses-live" },
    window: 6,
    anchor: "tail",
    runtime: liveRuntime,
  })
  await stream.ready()
  const before = idsOf(stream)
  let changes = 0
  stream.on("change", () => changes++)
  live.get("ses-live")!.push(...messages().slice(10, 12))
  db.run("INSERT INTO transcript_steps(note) VALUES('x')")
  await until(() => changes > 0)
  expect(idsOf(stream)).not.toEqual(before)
  const moreExpected = messageRowsOf(live.get("ses-live")!)
  expect(idsOf(stream)).toEqual(moreExpected.slice(-6).map((row) => row[0]))
  stream.close()
  const reads = liveHost.state.lists
  db.run("INSERT INTO transcript_steps(note) VALUES('y')")
  await Bun.sleep(40)
  expect(liveHost.state.lists).toBe(reads)
})

function context(denied = new Set<string>()): StreamContext {
  return {
    projectID: "project",
    projectDirectory: project,
    projectIds: (id) => [id],
    assertRead: async () => {},
    assertAction: async (sessionID) => {
      if (denied.has(sessionID)) throw new Error("Not permitted")
    },
    read: (run) => run(db),
  }
}

test("authorize: scope checks plus the session must be an attempt of the task", async () => {
  const authorize = trajectoryTranscriptSource.authorize!
  const base = { projectDirectory: "/elsewhere", scope: owner, taskID, sessionID: session }
  expect((await authorize(base, context())).projectDirectory).toBe(project)
  await expect(authorize({ ...base, sessionID: "ses-other" }, context())).rejects.toThrow(
    "unavailable",
  )
  await expect(authorize({ ...base, taskID: "no-task" }, context())).rejects.toThrow("unavailable")
  await expect(authorize(base, context(new Set(["ses-owner"])))).rejects.toThrow("Not permitted")
})

test("through the Streams service and the GUI client: open, slide, seek, change", async () => {
  const pushed: [string, number][] = []
  const service = createStreamsService({
    pool: undefined as never,
    changed: (stream, seq) => pushed.push([stream, seq]),
    context: context(),
  })
  const input = {
    source: TRAJECTORY_SOURCES.transcript,
    filter: { projectDirectory: "x", scope: owner, taskID, sessionID: session },
    order: "transcript",
    window: 8,
  }
  const frame = await service.open({ stream: "t1", ...input })
  const decode = (data: string) => {
    const bytes = Uint8Array.from(Buffer.from(data, "base64"))
    const read = readFrame(bytes.buffer, bytes.byteOffset, trajectoryTranscriptColumns)
    return Array.from({ length: read.header.count }, (_, i) => read.row(i).id)
  }
  expect(decode(frame.data)).toEqual(refIds(0, 8))
  expect(decode((await service.slide({ stream: "t1", delta: 5 })).data)).toEqual(refIds(5, 13))
  const denied = createStreamsService({
    pool: undefined as never,
    changed() {},
    context: context(new Set(["ses-owner"])),
  })
  await expect(denied.open({ stream: "t2", ...input })).rejects.toThrow("Not permitted")
  expect(service.close({ stream: "t1" })).toEqual({ closed: true })

  const transport: StreamsTransport = {
    open: (i) => service.open(i),
    slide: (stream, delta) => service.slide({ stream, delta }),
    seek: (stream, anchor) => service.seek({ stream, anchor }),
    read: async (stream) => service.read({ stream }),
    touch: async (stream) => service.touch({ stream }),
    close: async (stream) => void service.close({ stream }),
    onChanged: () => () => {},
  }
  // The GUI client is reactive: load the browser build of Solid (the server build never runs effects).
  const browserSolid = "../../../node_modules/solid-js/dist/solid.js"
  const serverSolid = await import("solid-js")
  const browser = (await import(browserSolid)) as typeof import("solid-js")
  mock.module("solid-js", () => browser)
  const { createRoot } = browser
  const guiModule = "../gui.ts?browser-solid"
  const { createStream } = (await import(guiModule)) as typeof import("../gui.ts")
  await createRoot(async (disposeRoot) => {
    const gui = createStream(
      transport,
      { name: TRAJECTORY_SOURCES.transcript, columns: trajectoryTranscriptColumns },
      () => ({
        filter: input.filter,
        order: "transcript",
        window: 8,
      }),
    )
    await until(() => gui.items().length === 8)
    expect(gui.items().map((row) => row.id)).toEqual(refIds(0, 8))
    gui.slide(4)
    await until(() => gui.items()[0]?.id === reference[4]![0])
    disposeRoot()
  })
  mock.module("solid-js", () => serverSolid)
  service.dispose()
})

test("close and lease expiry call release(filter) once", async () => {
  const released: unknown[] = []
  defineHostSource({
    name: "test.host-released",
    key: ["id"],
    columns: { id: "int" },
    authorize: (filter: { n: number }) => ({ ...filter, n: filter.n + 1 }),
    release: (filter) => void released.push(filter),
    open: () => ({
      async page() {
        return { rows: [[1]], start: "0", end: "1", before: false, after: false }
      },
      watch: () => () => {},
    }),
  })
  const input = { source: "test.host-released", filter: { n: 1 }, order: "x", window: 3 }
  const service = createStreamsService({
    pool: undefined as never,
    changed() {},
    context: context(),
    leaseMs: 30,
  })
  await service.open({ stream: "r1", ...input })
  service.close({ stream: "r1" })
  service.close({ stream: "r1" })
  expect(released).toEqual([{ n: 2 }])
  await service.open({ stream: "r2", ...input })
  await until(() => released.length === 2)
  await Bun.sleep(60)
  expect(released).toEqual([{ n: 2 }, { n: 2 }])
  service.dispose()
})

// ---- trajectory.effort -----------------------------------------------------------------------

const effortInput = (window: number) => ({
  source: TRAJECTORY_SOURCES.effort,
  filter: { projectDirectory: "x", scope: owner, taskID },
  order: "effort",
  window,
})

test("effort: an empty window until the fold writes the row; list rows carry the summary; window 1 the worker's detail", async () => {
  const service = createStreamsService({
    pool: undefined as never,
    changed() {},
    context: context(),
  })
  const empty = await service.open({ stream: "e0", ...effortInput(1) })
  const decode = (data: string, window: number) => {
    const bytes = Uint8Array.from(Buffer.from(data, "base64"))
    const columns =
      window === 1
        ? { ...trajectoryEffortColumns, ...trajectoryEffortDetail }
        : trajectoryEffortColumns
    const read = readFrame(bytes.buffer, bytes.byteOffset, columns)
    return Array.from({ length: read.header.count }, (_, i) => read.row(i))
  }
  expect(decode(empty.data, 1)).toEqual([])
  // Opening the task asked the fold to compute it.
  expect(touched).toEqual([taskID])
  service.close({ stream: "e0" })

  db.run(
    "INSERT INTO trajectory_task_effort VALUES(1,?,?,1,10,20,30,40,50,2,2,'1.25','priced',99)",
    [project, taskID],
  )
  const list = await service.open({ stream: "e1", ...effortInput(25) })
  const [row] = decode(list.data, 25)
  expect(row).toMatchObject({
    id: 1,
    task_id: taskID,
    busy: true,
    output: 20,
    market_value: "1.25",
    refreshed_at: 99,
  })
  expect(detailCalls).toBe(0)
  const detail = await service.open({ stream: "e2", ...effortInput(1) })
  const [full] = decode(detail.data, 1)
  expect(detailCalls).toBe(1)
  expect((full as Record<string, unknown>).effort).toMatchObject({
    taskEffortBasis: { assessments: [{ id: "a1" }] },
  })
  expect(touched).toEqual([taskID, taskID, taskID])
  // The fold rewrites the row: the stream hears it and re-reads.
  db.run("UPDATE trajectory_task_effort SET output=21 WHERE task_id=?", [taskID])
  const changed = openHostStream(trajectoryEffortSource, {
    filter: { projectDirectory: project, scope: owner, taskID },
    window: 25,
    runtime,
  })
  await changed.ready()
  db.run("UPDATE trajectory_task_effort SET output=22 WHERE task_id=?", [taskID])
  await until(() => changed.items[0]?.output === 22)
  changed.close()
  service.dispose()
})

test("a native session event for this session is a refresh hint; another session's is not", async () => {
  const live = new Map([["ses-native", messages().slice(0, 10)]])
  const liveHost = fakeHost(live)
  const queue = Effect.runSync(Queue.unbounded<unknown, Cause.Done>())
  const events = { event: { subscribe: () => Stream.fromQueue(queue) } }
  db.run("INSERT INTO runner_attempts VALUES(?,?,?)", [project, taskID, "ses-native"])
  const stream = openHostStream(trajectoryTranscriptSource, {
    filter: { projectDirectory: project, scope: owner, taskID, sessionID: "ses-native" },
    window: 6,
    anchor: "tail",
    runtime: { ...runtime, messages: liveHost.client, events: events as never },
  })
  await stream.ready()
  await Bun.sleep(30)
  live.get("ses-native")!.push(...messages().slice(10, 12))
  const reads = liveHost.state.lists
  await Effect.runPromise(
    Queue.offer(queue, { id: "e1", type: "session.step.ended", data: { sessionID: "ses-other" } }),
  )
  await Bun.sleep(40)
  expect(liveHost.state.lists).toBe(reads)
  await Effect.runPromise(
    Queue.offer(queue, { id: "e2", type: "session.step.ended", data: { sessionID: "ses-native" } }),
  )
  await until(() => liveHost.state.lists > reads)
  await until(() => idsOf(stream).at(-1) === messageRowsOf(live.get("ses-native")!).at(-1)![0])
  stream.close()
})

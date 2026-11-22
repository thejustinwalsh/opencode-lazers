import { Database } from "bun:sqlite"
import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  cursorSecret,
  firstAttemptID,
  makeFixture,
  secondAttemptID,
  taskID,
} from "../../../test/trajectory/fixture.ts"
import { eventFromRow } from "../../trajectory-panel/rows.ts"
import { seedDisplayCorpus } from "../../progress/display.fixture.ts"
import { startProjection } from "../../projections/owner.ts"
import { meterRepository } from "../../runner/read-meter.fixture.ts"
import { TaskScheduleOwner } from "../../tasks/schedule/owner.ts"
import type { HostMessageClient } from "../../core/host-messages.ts"
import { taskEventsProjection } from "../../events/task-events-refresh.ts"
import { inspectTrajectory } from "../../trajectory/read.ts"
import { InspectTrajectoryInput } from "../../trajectory/schema.ts"
import { ensureTranscriptMetaSchema, TRANSCRIPT_META_QUEUE } from "../../transcript-meta/schema.ts"
import { TranscriptMetaFold } from "../../transcript-meta/fold.ts"
import { openStream } from "../client.ts"
import { type Columns } from "../frame.ts"
import { readerPool, type ReaderPool } from "../pool.ts"
import { streamColumns, type Source, type StreamContext } from "../source.ts"
import { trajectoryAttemptsSource, trajectoryEventsSource } from "./trajectory.ts"
import type { TrajectoryScope } from "./trajectory-ref.ts"

const takeoverAttemptID = "0e2c1f6d-6f0b-4a53-9d8b-0a6a0c1d2e3f"
const owner: TrajectoryScope = { kind: "project", sessionID: "ses-owner" }
const slow = {
  startMs: 60_000,
  quiet: { sliceMs: 1, waitMs: 1 },
  busy: { sliceMs: 1, waitMs: 1 },
  retryMs: 60_000,
}

let made: ReturnType<typeof makeFixture>
let pool: ReaderPool
let release: () => void
let folding: TranscriptMetaFold
let project: string

/** A host message list over `transcripts`, one page. */
function hostClient(transcripts: Map<string, unknown[]>) {
  return {
    message: {
      async list(input: { sessionID: string }) {
        return { data: transcripts.get(input.sessionID) ?? [], cursor: {} }
      },
    },
  } as unknown as HostMessageClient
}

beforeAll(async () => {
  made = makeFixture()
  project = made.directory
  const plan = made.receipt.planID
  made.store.atomic((db) => {
    // A takeover attempt of the same task (Architect finishing it), and plan-level rows.
    db.query(
      "INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count,tool_count,retry_count,cost) VALUES(?,?,?,3,'ses-takeover','msg-third',?,?,NULL,?,'running',5000,0,0,0,NULL)",
    ).run(
      takeoverAttemptID,
      plan,
      taskID,
      made.directory,
      "a".repeat(40),
      JSON.stringify({ model: { providerID: "openai", id: "gpt-6-sol" }, takeover: { from: 2 } }),
    )
    const transition = db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
    )
    // Two transitions with the same time: the old event id breaks the tie.
    transition.run(plan, taskID, 3, "NOTE", JSON.stringify({ reason: "tied a" }), 1500)
    transition.run(plan, taskID, 4, "RETRY", JSON.stringify({ attemptID: "gone" }), 1500)
    transition.run(plan, null, 5, "PLAN_ONLY", "{}", 1700)
    const effect = db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,?,'{}',?,1)")
    // An untimed plan-level effect: it sorts last, as the old read sorted it.
    effect.run("plan-cleanup", plan, null, null, "worktree-remove", "completed", null)
    effect.run(
      "task-session",
      plan,
      taskID,
      firstAttemptID,
      "session",
      "failed",
      JSON.stringify({ error: "host refused" }),
    )
  })
  // A failed assistant message (error name stored, message never) in the accepted session.
  const accepted = made.sessions.get("ses-accepted")!
  accepted.messages = [
    ...accepted.messages!,
    {
      id: "msg-new-failed",
      type: "assistant",
      time: { created: 2030 },
      model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
      content: [],
      error: { type: "ProviderError", message: "PRIVATE-ERROR-TEXT" },
    } as never,
  ]
  seedDisplayCorpus(made)
  // The recorder's rows for the host's tool parts: the call's own timing endpoints (the part's
  // `time.ran` and `time.completed`) beside its first and last observation. The failed call was
  // first observed at its input (1030), the successful one only after its call (2024); a
  // tool-wrapper invocation inside the successful call is not a host part.
  made.store.atomic((db) => {
    const call = db.query(
      `INSERT INTO native_tool_calls(project_directory,project_id,session_id,identity_kind,invocation_id,
         native_call_id,context_call_id,message_id,agent,tool,first_observed_at,last_observed_at,
         sources_json,event_ids_json,payload)
       VALUES(?, 'project', ?, ?, ?, ?, ?, ?, 'lazers-implementor', ?, ?, ?, '[]','[]',?)`,
    )
    const timing = (called: number, completed: number) => ({
      unit: "unix-epoch-ms",
      endpoints: { calledAt: { at: called }, completedAt: { at: completed } },
    })
    call.run(
      project,
      "ses-failed",
      "native-call",
      "call-failed",
      "call-failed",
      "call-failed",
      "msg-old-tool",
      "Read",
      1030,
      1041,
      JSON.stringify({
        status: "failed",
        detail: "PRIVATE-DETAIL",
        error: { message: "PRIVATE" },
        timing: timing(1035, 1040),
      }),
    )
    call.run(
      project,
      "ses-accepted",
      "native-call",
      "call-success",
      "call-success",
      "call-success",
      "msg-new-tool",
      "Bash",
      2024,
      2031,
      JSON.stringify({ status: "succeeded", timing: timing(2022, 2030) }),
    )
    call.run(
      project,
      "ses-accepted",
      "local-invocation",
      "wrapped-invocation",
      null,
      "call-success",
      "msg-new-tool",
      "lz-inspect-plan",
      2025,
      2026,
      JSON.stringify({ status: "succeeded" }),
    )
  })
  const lease = startProjection(made.repository.path, made.directory, taskEventsProjection, {
    pacing: slow,
  })
  release = () => lease.release()
  await lease.owner.settle()
  ensureTranscriptMetaSchema(made.repository)
  const transcripts = new Map(
    [...made.sessions.values()].map((session) => [session.id, [...session.messages!]]),
  )
  folding = new TranscriptMetaFold(made.repository, hostClient(transcripts), { spacingMs: 0 })
  folding.start()
  made.repository.atomic((db) => {
    for (const id of transcripts.keys())
      db.query(`INSERT OR IGNORE INTO ${TRANSCRIPT_META_QUEUE}(ref,next_at) VALUES(?,0)`).run(
        `${made.directory}\u0000${id}`,
      )
  })
  await folding.settle()
  await made.index()
  pool = readerPool(made.repository.path, { workers: 1 })
})
afterAll(async () => {
  await pool.close()
  folding.close()
  release()
  made.close()
})

type Item = Record<string, unknown>
async function rows<F, C extends Columns>(
  source: Source<F, C>,
  filter: F,
  order: string,
  window = 100,
) {
  const stream = openStream(pool, source, { filter, order, window, transport: "copy" })
  await stream.ready()
  const columns = Object.keys(streamColumns(source as never, window))
  const items = stream.items.map(
    (row) => Object.fromEntries(columns.map((c) => [c, (row as Item)[c]])) as Item,
  )
  stream.close()
  return items
}

const filter = { projectDirectory: "", scope: owner, taskID }
const events = (extra: Record<string, unknown> = {}, order = "timeline", window = 100) =>
  rows(
    trajectoryEventsSource,
    { ...filter, projectDirectory: project, ...extra } as never,
    order,
    window,
  )

const UNSTORED = new Set([
  "user",
  "synthetic",
  "assistant-text",
  "shell",
  "compaction",
  "session-idle",
  "model-switched",
  "agent-switched",
  "location-switched",
])
const KIND: Record<string, string> = {
  "runner-transition": "transition",
  "runner-effect": "effect",
  verification: "check",
}

async function oldEvents() {
  const report = await inspectTrajectory(
    made.store,
    made.host,
    "project",
    InspectTrajectoryInput.parse({ taskID }),
    cursorSecret,
    { allEvents: true },
  )
  return report.trajectory.events as Item[]
}

/** Every row of the timeline, walked a window of 7 at a time from the head to the end. */
async function walk(extra: Record<string, unknown> = {}, order = "timeline") {
  const stream = openStream(pool, trajectoryEventsSource, {
    filter: { ...filter, projectDirectory: project, ...extra } as never,
    order,
    window: 7,
    anchor: "head",
    transport: "copy",
  })
  await stream.ready()
  const seen: Item[] = []
  const take = () => {
    for (const row of stream.items) {
      const item = { ref: row.ref, sort_key: row.sort_key, kind: row.kind, status: row.status }
      if (!seen.some((known) => known.ref === item.ref)) seen.push(item)
    }
  }
  take()
  const first = { before: stream.before, after: stream.after }
  for (let guard = 0; stream.after !== 0 && guard < 200; guard++) {
    await stream.slide(5)
    take()
  }
  stream.close()
  return { seen, first }
}

test("timeline parity: the stream walked by windows equals the old read's order, ids, kinds and statuses", async () => {
  const old = await oldEvents()
  const { seen, first } = await walk()
  const full = await events()
  // Sliding by windows reads the same rows, in the same order, as one big window.
  expect(seen.map((row) => row.ref)).toEqual(full.map((row) => row.ref))
  // Exact counts on open: nothing before the first window, the rest after it.
  expect(first).toEqual({ before: 0, after: full.length - 7 })

  const ids = new Set(old.map((event) => String(event.id)))
  const keys = new Set(seen.map((row) => String(row.sort_key)))
  // Every stored row is an event of the old read ...
  expect([...keys].filter((key) => !ids.has(key))).toEqual([])
  // ... and what the old read had beyond them is message text, never stored (`trajectory.transcript`).
  const missing = old.filter((event) => !keys.has(String(event.id)))
  expect(missing.length).toBeGreaterThan(4)
  expect(missing.every((event) => UNSTORED.has(String(event.kind)))).toBe(true)

  // Same order, apart from the one documented time difference below.
  const order = (ids: string[]) => ids.filter((id) => id !== "progress:5")
  expect(order(seen.map((row) => String(row.sort_key)))).toEqual(
    order(old.map((event) => String(event.id)).filter((id) => keys.has(id))),
  )

  // Kind and status of every stored row that has one in both.
  const byID = new Map(old.map((event) => [String(event.id), event]))
  for (const row of full) {
    const event = byID.get(String(row.sort_key))!
    if (String(row.kind) === "progress") continue
    expect(row.kind).toBe(KIND[String(event.kind)] ?? event.kind)
    if (row.kind === "tool") {
      // The host part's status word, its `time.ran`, `time.completed` and its message's route.
      expect(row.status).toBe(event.status)
      expect(row.completed_at).toBe(event.completedAt)
      const model = event.model as { providerID: string; id: string; variant?: string }
      expect([row.route_provider, row.route_model, row.route_variant ?? undefined]).toEqual([
        model.providerID,
        model.id,
        model.variant,
      ])
    }
    if (row.kind === "assistant-step") {
      expect(row.status).toBe(event.status)
      const model = event.model as { providerID: string; id: string; variant: string }
      expect([row.route_provider, row.route_model, row.route_variant]).toEqual([
        model.providerID,
        model.id,
        model.variant,
      ])
    }
    if (row.kind === "check") expect(row.status).toBe(event.status)
    if (row.kind === "transition") expect(row.event).toBe(event.event)
    expect(row.attempt_id).toBe(event.attemptID)
    expect(row.at).toBe(event.at)
  }
  // The failed step reads failed, and its error row carries the name only; the retry carries its attempt.
  const failed = full.find((row) => row.sort_key === "msg-new-failed:assistant-step")
  expect([failed?.status, failed?.error_type]).toEqual(["failed", null])
  expect(full.find((row) => row.sort_key === "msg-new-failed:error")?.error_type).toBe(
    "ProviderError",
  )
  expect(full.find((row) => row.sort_key === "msg-old-retry:provider-retry")).toMatchObject({
    retry_attempt: 2,
    at: 1052,
  })
  // No row of a step carries the string "unknown".
  expect(JSON.stringify(full)).not.toContain('"unknown"')
  // Ties at 1500 are broken by the old id; the untimed plan-level effect sorts last.
  const at1500 = full.filter((row) => row.at === 1500).map((row) => row.sort_key)
  expect(at1500).toEqual([...at1500].sort())
  expect(full.at(-1)).toMatchObject({
    event: "worktree-remove",
    at: null,
    sort_at: 9007199254740991,
  })
  // A check pass and a check fail, a failed task effect.
  expect(full.filter((row) => row.kind === "check").map((row) => row.status)).toEqual([
    "failed",
    "passed",
    "passed",
  ])
  // Two attempts' calls, never their detail or error text.
  expect(full.filter((row) => row.kind === "tool").map((row) => [row.tool, row.call_id])).toEqual([
    ["Read", "call-failed"],
    ["Bash", "call-success"],
  ])
  expect(JSON.stringify(full)).not.toContain("PRIVATE")
})

test("progress rows: the panel's mapping gives the old read's kind, call and file targets", async () => {
  const old = new Map((await oldEvents()).map((event) => [String(event.id), event]))
  const progress = (await events()).filter((row) => row.kind === "progress")
  expect(progress.length).toBeGreaterThan(3)
  let files = 0
  for (const row of progress) {
    const before = old.get(String(row.sort_key))!
    const mapped = eventFromRow(row, taskID)
    expect([row.ref, mapped.kind]).toEqual([row.ref, before.kind])
    // An oversized call id is shortened by each projection its own way; host call ids are short.
    const oldCall = (before.callID as string | undefined) ?? null
    if (oldCall === null || oldCall.length < 200) expect(mapped.callID ?? null).toBe(oldCall)
    expect(mapped.fileTargets ?? null).toEqual(
      (before.fileTargets as typeof mapped.fileTargets) ?? null,
    )
    if (mapped.fileTargets) files++
  }
  // The corpus records file targets on two tool calls: the Files lane has them.
  expect(files).toBe(2)
})

test("check intervals: every check row carries the old read's receipt interval, unselected", async () => {
  const report = await inspectTrajectory(
    made.store,
    made.host,
    "project",
    InspectTrajectoryInput.parse({ taskID }),
    cursorSecret,
    { allEvents: true },
  )
  const old = [
    ...report.plans.flatMap((plan) => plan.checks),
    ...report.attempts.flatMap((attempt) => attempt.checks),
  ]
  const key = (check: {
    id: unknown
    attemptID: unknown
    startedAt: unknown
    endedAt: unknown
    state: unknown
    result: unknown
  }) =>
    JSON.stringify([
      check.id,
      check.attemptID,
      check.startedAt,
      check.endedAt,
      check.state,
      check.result,
    ])
  // The list columns alone, as the panel's every-check stream reads them (no window-1 detail).
  const listed = (await events({ kinds: ["check"] })).map((row) =>
    key({
      id: row.event,
      attemptID: row.attempt_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      state: row.to_state,
      result: row.status,
    }),
  )
  expect(listed.length).toBe(3)
  expect(listed.toSorted()).toEqual([...new Set(old.map(key))].toSorted())
  expect(listed.every((row) => JSON.parse(row)[2] !== null && JSON.parse(row)[3] !== null)).toBe(
    true,
  )
})

test("documented differences from the old read", async () => {
  const old = new Map((await oldEvents()).map((event) => [String(event.id), event]))
  const full = new Map((await events()).map((row) => [String(row.sort_key), row]))
  // Tool rows are the old read's: time, status word, completion and route (asserted in the
  // parity test above). What remains differs where no user sees it, or as justified here:
  // 1. A progress row's time is the display row's `at`; the old read sorted a visible-text row by
  //    its message time. Justified: the display row is the stored fact; the old time came from a
  //    host message read per report.
  expect([old.get("progress:5")!.at, full.get("progress:5")!.at]).toEqual([10, 1028.5])
  // 2. Progress rows keep the display kind (commentary, tool, ...) in `event`; the old read said
  //    worker-*. Not seen: the panel maps it back (`eventFromRow`).
  expect(full.get("progress:1")).toMatchObject({ kind: "progress", event: "commentary" })
  expect(old.get("progress:1")!.kind).toBe("commentary")
  // 3. The old read ordered tied ids with localeCompare; the stream orders them bytewise. Not seen
  //    for the ids LAZERS and OpenCode write (ASCII), where the two orders agree.
  // 4. A call recorded as not executed keeps no host status; it reads `error` with an error,
  //    `completed` with a completion time, otherwise `running` (the old read showed the host part's
  //    word). A call still streaming its input sits at its input start; the old read had no time
  //    for it and sorted it last.
  // 5. A tool-wrapper invocation (a LAZERS tool inside a host call) is not a row, as before.
  expect([...full.values()].some((row) => row.tool === "lz-inspect-plan")).toBe(false)
})

test("filters: an attempt keeps its own rows and the plan-level ones; kinds narrow", async () => {
  const first = await events({ attemptID: firstAttemptID })
  expect(first.every((row) => row.attempt_id === firstAttemptID || row.attempt_id === null)).toBe(
    true,
  )
  expect(first.some((row) => row.attempt_id === null)).toBe(true)
  expect(first.some((row) => row.attempt_id === secondAttemptID)).toBe(false)
  const tools = await events({ kinds: ["tool"] })
  expect(tools.map((row) => row.kind)).toEqual(["tool", "tool"])
  // The follow order is the timeline reversed.
  const forward = (await events()).map((row) => row.ref)
  expect((await events({}, "follow")).map((row) => row.ref)).toEqual(forward.toReversed())
  // Window 1 carries the stored event's cold JSON.
  const [one] = await events({ kinds: ["check"] }, "timeline", 1)
  expect(one!.detail).toHaveProperty("event")
})

test("trajectory.attempts: a task's attempts in number order, with the takeover and last event time", async () => {
  const list = await rows(
    trajectoryAttemptsSource,
    { ...filter, projectDirectory: project } as never,
    "number",
  )
  expect(list.map((row) => [row.number, row.id, row.state, row.takeover])).toEqual([
    [1, firstAttemptID, "running", false],
    [2, secondAttemptID, "accepted", false],
    [3, takeoverAttemptID, "running", true],
  ])
  expect(list[1]).toMatchObject({
    session_id: "ses-accepted",
    started_at: 2000,
    tool_count: 3,
    token_count: 88,
    retry_count: 0,
  })
  expect(list[0]!.model).toEqual({ providerID: "openai", id: "gpt-6-luna", variant: "max" })
  const latest = made.repository.read((db) =>
    db
      .query<{ attempt_id: string; at: number }, []>(
        "SELECT attempt_id, MAX(at) AS at FROM task_events WHERE attempt_id IS NOT NULL GROUP BY attempt_id",
      )
      .all(),
  )
  for (const row of latest)
    expect(list.find((attempt) => attempt.id === row.attempt_id)!.last_event_at).toBe(row.at)
  expect(list[2]!.last_event_at).toBeNull()
})

// ---- authorize ---------------------------------------------------------------------------------

function context(denied = new Set<string>()) {
  const asked: [string, string][] = []
  const value: StreamContext = {
    projectID: "project",
    projectDirectory: project,
    projectIds: (id) => [id],
    assertRead: async () => {},
    assertAction: async (sessionID, action) => {
      asked.push([sessionID, action])
      if (denied.has(sessionID)) throw new Error("Not permitted")
    },
    read: (run) => made.repository.read(run),
  }
  return { value, asked }
}

test("authorize: the tool's permission, the service's project, and a session reads only its own tasks", async () => {
  const c = context(new Set(["ses-denied"]))
  const input = { projectDirectory: "/elsewhere", scope: owner, taskID }
  for (const source of [trajectoryEventsSource, trajectoryAttemptsSource]) {
    const authorize = source.authorize as (
      input: unknown,
      context: StreamContext,
    ) => Promise<{ projectDirectory: string }>
    expect((await authorize(input, c.value)).projectDirectory).toBe(project)
    // A session that holds an attempt of the task reads it; an unrelated one does not.
    const own = { ...input, scope: { kind: "session", sessionID: "ses-failed" } }
    expect((await authorize(own, c.value)).projectDirectory).toBe(project)
    await expect(
      authorize({ ...input, scope: { kind: "session", sessionID: "ses-elsewhere" } }, c.value),
    ).rejects.toThrow("Trajectory scope is unavailable")
    await expect(authorize({ ...input, taskID: "no-such-task" }, c.value)).rejects.toThrow(
      "Trajectory scope is unavailable",
    )
    await expect(
      authorize({ ...input, scope: { kind: "project", sessionID: "ses-denied" } }, c.value),
    ).rejects.toThrow("Not permitted")
    // A context without `assertAction` rejects.
    await expect(authorize(input, { ...c.value, assertAction: undefined })).rejects.toThrow(
      "Trajectory scope is unavailable",
    )
  }
  expect(c.asked.every(([, action]) => action === "lz-inspect-trajectory")).toBe(true)
})

test("idle: open Trajectory streams issue no statement and stay quiet on an unrelated write", async () => {
  const meter = meterRepository(made.repository)
  const streams: { close(): void }[] = []
  let changes = 0
  try {
    for (const [source, order] of [
      [trajectoryEventsSource, "timeline"],
      [trajectoryAttemptsSource, "number"],
    ] as const) {
      const stream = openStream(pool, source as Source<unknown, Columns>, {
        filter: { ...filter, projectDirectory: project },
        order,
        window: 40,
        transport: "copy",
      })
      await stream.ready()
      stream.on("change", () => changes++)
      streams.push(stream)
    }
    expect(meter.statements).toEqual([])
    made.repository.atomic((db) =>
      db
        .query("INSERT INTO task_changes(project_directory,kind) VALUES(?,'mutation')")
        .run(project),
    )
    await Bun.sleep(300)
    expect(changes).toBe(0)
    // Not vacuous: a new transition of the task reaches the events stream.
    made.store.atomic((db) =>
      db
        .query(
          "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,9,'NOTE','{}',4500)",
        )
        .run(made.receipt.planID, taskID),
    )
    for (let waited = 0; waited < 100 && changes === 0; waited++) await Bun.sleep(20)
    expect(changes).toBeGreaterThan(0)
  } finally {
    for (const stream of streams) stream.close()
    meter.stop()
  }
})

// ---- scale and plan ----------------------------------------------------------------------------

test("a task of 20,000 timeline rows counts and pages through indexes, no table scanned", async () => {
  const big = makeFixture()
  const lease = startProjection(big.repository.path, big.directory, taskEventsProjection, {
    pacing: slow,
  })
  const bigPool = readerPool(big.repository.path, { workers: 1 })
  try {
    await lease.owner.settle()
    ensureTranscriptMetaSchema(big.repository)
    const plan = big.receipt.planID
    big.repository.atomic((db) => {
      const event = db.query(
        `INSERT INTO task_events(project_directory,task_id,plan_id,attempt_id,session_id,at,sort_at,sort_key,kind,origin,event,detail)
         VALUES(?,?,?,?,?,?,?,?,'progress',?,'tool',?)`,
      )
      for (let i = 0; i < 20_000; i++)
        event.run(
          big.directory,
          taskID,
          plan,
          firstAttemptID,
          "ses-failed",
          100_000 + i,
          100_000 + i,
          `progress:${i}`,
          `pg:${100 + i}`,
          JSON.stringify({ event: { id: i, pad: "x".repeat(300) } }),
        )
      const step = db.query(
        "INSERT INTO transcript_steps(project_directory,session_id,message_id,ordinal,created_at,completed_at) VALUES(?,?,?,?,?,?)",
      )
      const call = db.query(
        `INSERT INTO native_tool_calls(project_directory,project_id,session_id,identity_kind,invocation_id,
           native_call_id,context_call_id,message_id,agent,tool,first_observed_at,last_observed_at,
           sources_json,event_ids_json,payload) VALUES(?, 'project', 'ses-failed','native-call',?,?,?,?,'a','Read',?,?,'[]','[]','{}')`,
      )
      for (let i = 0; i < 5_000; i++) {
        step.run(big.directory, "ses-failed", `big-${i}`, 1000 + i, 100_000 + i, 100_001 + i)
        call.run(
          big.directory,
          `inv-${i}`,
          `inv-${i}`,
          `inv-${i}`,
          `big-${i}`,
          100_000 + i,
          100_001 + i,
        )
      }
    })
    const started = performance.now()
    const stream = openStream(bigPool, trajectoryEventsSource, {
      filter: { ...filter, projectDirectory: big.directory } as never,
      order: "timeline",
      window: 40,
      anchor: "head",
      transport: "copy",
    })
    await stream.ready()
    const opened = performance.now() - started
    const total = stream.items.length + (stream.after as number)
    // 20,000 stored events, 5,000 steps (+ the 2 fixture steps), 5,000 calls, and the fixture's own.
    expect(total).toBeGreaterThanOrEqual(30_000)
    await stream.slide(40)
    stream.close()
    console.log(`trajectory.events open on ${total} rows: ${opened.toFixed(0)} ms`)
    expect(opened).toBeLessThan(5_000)

    // The plan: every arm is driven by an index; none scans a table.
    const { windowQuery } = await import("../source.ts")
    const db = new Database(big.repository.path, { readonly: true })
    try {
      for (const extra of [{}, { attemptID: firstAttemptID, kinds: ["tool", "transition"] }]) {
        const q = windowQuery(trajectoryEventsSource as never, {
          filter: { ...filter, projectDirectory: big.directory, ...extra },
          order: "timeline",
          anchor: { values: [100_500, "progress:500", "pg:600"], place: "start" },
          window: 40,
        })
        for (const sql of [
          q.rows,
          q.lead?.(10) ?? q.rows,
          q.before([100_500, "x", "y"]),
          q.after([100_500, "x", "y"]),
        ]) {
          const plan = (
            db.query("EXPLAIN QUERY PLAN " + sql.sql).all(...(sql.params as never[])) as {
              detail: string
            }[]
          ).map((row) => row.detail)
          expect(plan.filter((line) => /^SCAN (task_events|s|c|a)\b/.test(line))).toEqual([])
          expect(plan.some((line) => line.includes("task_events_task"))).toBe(true)
          // Steps and calls are reached by one attempt's session, never by the project alone.
          for (const line of plan.filter((line) => /^SEARCH (s|c) USING/.test(line)))
            expect(line).toContain("session_id=?")
        }
      }
    } finally {
      db.close()
    }
  } finally {
    await bigPool.close()
    lease.release()
    big.close()
  }
})

import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  firstAttemptID,
  makeFixture,
  secondAttemptID,
  taskID,
} from "../../../test/trajectory/fixture.ts"
import { LiveReadStore } from "../../observability/live-store.ts"
import { meterRepository } from "../../runner/read-meter.fixture.ts"
import { insertTask } from "../../tasks/schedule/fixture.ts"
import { storedGroupHead, storedWorkload } from "../../tasks/schedule/stored.ts"
import { TaskState } from "../../runner/schema.ts"
import { openStream, type Stream } from "../client.ts"
import { readFrame, type Columns } from "../frame.ts"
import { base64ToBytes } from "../gui.ts"
import { readerPool, type ReaderPool } from "../pool.ts"
import { createStreamsService } from "../rpc.ts"
import { streamColumns, type Source } from "../source.ts"
import {
  radarAssignmentsSource,
  radarAttemptSource,
  radarGroupSource,
  radarJournalSource,
  radarNativeCallsSource,
  radarNodesSource,
  radarPlanEventsSource,
  radarSchedulerSource,
  radarWorkloadSource,
} from "./radar.ts"
import { radarAssignmentColumns, type RadarGroup, type RadarScope } from "./radar-ref.ts"
import { writeSchedulerStatus } from "../../runner/scheduler-status.ts"

let fixture: ReturnType<typeof makeFixture>
let pool: ReaderPool
let project: string
const owner: RadarScope = { kind: "project", sessionID: "ses-owner" }
const signal = new AbortController().signal

beforeAll(async () => {
  fixture = makeFixture()
  project = fixture.directory
  // Two active attempts, more tasks for the groups, a tool call and a scheduler row.
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID)
    db.query("UPDATE runner_attempts SET state='verifying' WHERE id=?").run(secondAttemptID)
    db.query(
      `INSERT INTO native_tool_calls(project_directory,project_id,session_id,identity_kind,invocation_id,
         native_call_id,context_call_id,message_id,agent,tool,first_observed_at,last_observed_at,
         sources_json,event_ids_json,payload)
       VALUES(?, 'project','ses-architect','native-call','c1','c1','c1','m1','lazers-architect','read',10,20,'[]','[]',?)`,
    ).run(project, JSON.stringify({ status: "succeeded", detail: "read src/a.ts" }))
    writeSchedulerStatus(db, project, { status: "scheduled", participants: 1 })
  })
  const queued = ["alpha", "beta", "gamma"].map((name) => insertTask(fixture.repository, name))
  // A plan holding two of them, so the Queued group has rows.
  fixture.store.submit(
    {
      requestID: "radar-queued",
      objective: "Queued work",
      baseCommit: "a".repeat(40),
      workspaceMode: "shared",
      nodes: queued.slice(0, 2).map((id) => ({ taskID: id, revision: 1 })),
      dependencies: [],
      integrationOrder: queued.slice(0, 2),
      verification: [{ id: "check", command: "bun test", timeoutMs: 60000 }],
      acceptance: [
        {
          id: "ok",
          assertion: "Checks pass",
          evidence: [{ kind: "verification", verificationID: "check" }],
        },
      ],
    },
    "ses-owner",
  )
  await fixture.index()
  pool = readerPool(fixture.repository.path, { workers: 1 })
})
afterAll(async () => {
  await pool.close()
  fixture.close()
})

async function rows<F, C extends Columns>(
  source: Source<F, C>,
  filter: F,
  order: string,
  window = 50,
) {
  const stream = openStream(pool, source, { filter, order, window, transport: "copy" })
  await stream.ready()
  // Rows read their fields from the frame on access: copy each column out before closing.
  const columns = Object.keys(streamColumns(source as never, window))
  const items = stream.items.map(
    (row) =>
      Object.fromEntries(
        columns.map((column) => [column, (row as Record<string, unknown>)[column]]),
      ) as Record<string, unknown>,
  )
  stream.close()
  return items
}

test("radar.assignments parity: equals readCurrent's active assignments for project and session scope", async () => {
  const live = new LiveReadStore(fixture.repository.path, project, "project")
  for (const session of [null, "ses-failed"] as const) {
    const old = [...live.readCurrent(session, signal).assignments.values()]
    const scope: RadarScope = session ? { kind: "session", sessionID: session } : owner
    const filter = {
      projectDirectory: project,
      scope,
      ...(session ? { sessionID: session } : {}),
    }
    const shown = await rows(radarAssignmentsSource, filter, "recent")
    expect(old.length).toBe(session ? 1 : 2)
    expect(
      shown.map((row) => ({
        sessionID: row.session_id,
        attemptID: row.id,
        planID: row.plan_id,
        taskID: row.task_id,
        state: row.state,
        startedAt: row.started_at,
        attemptNumber: row.number,
        taskReference: row.reference,
        task: {
          state: row.node_state,
          reason: row.node_reason,
          planState: row.plan_state,
          planReason: row.plan_reason,
        },
      })),
    ).toEqual(
      old.map((item) => ({
        sessionID: item.sessionID,
        attemptID: item.attemptID,
        planID: item.planID,
        taskID: item.taskID,
        state: item.state,
        startedAt: item.startedAt,
        attemptNumber: item.attemptNumber,
        taskReference: item.taskReference,
        task: item.task!,
      })),
    )
    // Titles: the stored title is the task's objective, as the old label read it.
    for (const [i, item] of old.entries()) expect(shown[i]!.title).toBe(item.taskTitle!)
  }
})

test("radar.attempt: the worker session's attempt with its task's stored states (the fields liveAttempt returned)", async () => {
  const [row] = await rows(
    radarAttemptSource,
    { projectDirectory: project, scope: owner, sessionID: "ses-accepted" },
    "recent",
    1,
  )
  expect({
    id: row!.id,
    number: row!.number,
    state: row!.state,
    startedAt: row!.started_at,
    toolCount: row!.tool_count,
    model: row!.model,
    task: {
      state: row!.node_state,
      reason: row!.node_reason,
      planState: row!.plan_state,
      planReason: row!.plan_reason,
    },
  }).toEqual({
    id: secondAttemptID,
    number: 2,
    state: "verifying",
    startedAt: 2000,
    toolCount: 3,
    model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
    task: { state: "accepted", reason: null, planState: "accepted", planReason: null },
  })

  // The detail window carries the cold fields.
  expect(row!.workspace).toBe(fixture.directory)
})

test("radar.group parity: needs-you, failed and queued heads equal storedGroupHead; workload equals storedWorkload", async () => {
  const workload = fixture.repository.read((db) => storedWorkload(db, project))!
  const [stored] = await rows(
    radarWorkloadSource,
    { projectDirectory: project, scope: owner },
    "key",
    1,
  )
  expect({
    ready: stored!.ready,
    queued: stored!.queued,
    needsYou: stored!.needs_you,
    failed: stored!.failed,
  }).toEqual({ ready: true, ...workload })
  expect(workload.queued).toBeGreaterThan(0)
  for (const group of ["needs-you", "failed", "queued"] as RadarGroup[]) {
    const head = fixture.repository.read((db) => storedGroupHead(db, project, group, 25))!
    const shown = await rows(
      radarGroupSource,
      { projectDirectory: project, scope: owner, group },
      "recent",
    )
    expect(shown.map((row) => row.task_id)).toEqual(head.rows.map((row) => row.task_id))
    expect(shown.map((row) => row.title)).toEqual(head.rows.map((row) => row.title))
  }
})

test("radar.planEvents parity: the latest machine transition of each edge of the node, as the statechart picks it", async () => {
  const planID = fixture.receipt.planID
  // The old snapshot's transitions of the node, filtered as `observedTransition` filters them.
  const recorded = fixture.repository.read((db) =>
    db
      .query<{ id: number; event: string; payload: string }, [string]>(
        "SELECT id,event,payload FROM runner_transitions WHERE task_id=? ORDER BY id LIMIT 10000",
      )
      .all(taskID),
  )
  const latest = new Map<string, number>()
  for (const row of recorded) {
    const payload = JSON.parse(row.payload) as { from?: unknown; to?: unknown }
    const from = TaskState.safeParse(payload.from)
    const to = TaskState.safeParse(payload.to)
    if (!from.success || !to.success) continue
    latest.set(`${from.data}\u0000${row.event}\u0000${to.data}`, row.id)
  }
  expect(latest.size).toBeGreaterThan(0)
  const shown = await rows(
    radarPlanEventsSource,
    { projectDirectory: project, scope: owner, planID, taskID },
    "id",
  )
  const origins = fixture.repository.read(
    (db) =>
      new Map(
        db
          .query<{ id: number; origin: string }, []>(
            "SELECT id,origin FROM task_events LIMIT 10000",
          )
          .all()
          .map((row) => [row.id, row.origin]),
      ),
  )
  expect(
    new Map(
      shown.map((row) => [
        `${row.from_state}\u0000${row.event}\u0000${row.to_state}`,
        Number(origins.get(row.id as number)!.slice(3)),
      ]),
    ),
  ).toEqual(latest)
  // The selected edge's detail window carries its reason and version.
  const [one] = await rows(
    radarPlanEventsSource,
    { projectDirectory: project, scope: owner, planID, taskID },
    "id",
    1,
  )
  expect((one!.detail as { event: { kind: string } }).event.kind).toBe("runner-transition")
})

test("radar.nodes: a plan's nodes in plan order with the persisted machine snapshot", async () => {
  const planID = fixture.receipt.planID
  const shown = await rows(
    radarNodesSource,
    { projectDirectory: project, scope: owner, planID },
    "plan",
  )
  const stored = fixture.repository.read((db) =>
    db
      .query<
        { task_id: string; state: string; snapshot: string; machine_version: string },
        [string]
      >(
        "SELECT task_id,state,snapshot,machine_version FROM runner_nodes WHERE plan_id=? ORDER BY ordinal LIMIT 100",
      )
      .all(planID),
  )
  expect(shown.map((row) => [row.task_id, row.state, row.snapshot, row.machine_version])).toEqual(
    stored.map((row) => [row.task_id, row.state, JSON.parse(row.snapshot), row.machine_version]),
  )
  // Another project's directory reads nothing.
  expect(
    await rows(radarNodesSource, { projectDirectory: "/elsewhere", scope: owner, planID }, "plan"),
  ).toEqual([])
})

test("radar.nativeCalls, radar.journal and radar.scheduler read their stored rows", async () => {
  const calls = await rows(
    radarNativeCallsSource,
    { projectDirectory: project, scope: owner, sessionID: "ses-architect", nativeOnly: true },
    "recent",
  )
  expect(calls.map((row) => [row.call_id, row.status, row.detail])).toEqual([
    ["c1", "succeeded", "read src/a.ts"],
  ])
  fixture.repository.atomic((db) =>
    db
      .query(
        `INSERT INTO recovery_progress_facts(project_directory,project_id,plan_id,task_id,attempt_id,session_id,
           source_seq,source_at,change_kind,source_kind,source,status,changed_fields)
         VALUES(?,'project',?,?,?,'ses-failed',7,100,'inserted','tool','runtime','running','[]')`,
      )
      .run(project, fixture.receipt.planID, taskID, firstAttemptID),
  )
  const journal = await rows(
    radarJournalSource,
    { projectDirectory: project, scope: owner, attemptID: firstAttemptID },
    "recent",
  )
  expect(journal.map((row) => [row.source_seq, row.source_kind, row.status])).toEqual([
    [7, "tool", "running"],
  ])
  const status = await rows(
    radarSchedulerSource,
    { projectDirectory: project, scope: owner },
    "key",
    1,
  )
  expect(status.map((row) => [row.status, row.participants])).toEqual([["scheduled", 1]])
})

test("idle: open Radar streams issue no statement on the main connection and stay quiet on an unrelated write", async () => {
  const meter = meterRepository(fixture.repository)
  const streams: Stream<Columns>[] = []
  let changes = 0
  try {
    for (const [source, filter, order] of [
      [radarAssignmentsSource, { projectDirectory: project, scope: owner }, "recent"],
      [radarWorkloadSource, { projectDirectory: project, scope: owner }, "key"],
      [radarSchedulerSource, { projectDirectory: project, scope: owner }, "key"],
      [radarGroupSource, { projectDirectory: project, scope: owner, group: "queued" }, "recent"],
    ] as const) {
      const stream = openStream(pool, source as Source<unknown, Columns>, {
        filter,
        order,
        window: 40,
        transport: "copy",
      })
      await stream.ready()
      stream.on("change", () => changes++)
      streams.push(stream)
    }
    expect(meter.statements).toEqual([])
    // A write to a table no Radar source reads.
    fixture.repository.atomic((db) =>
      db
        .query("INSERT INTO task_changes(project_directory,kind) VALUES(?,'mutation')")
        .run(project),
    )
    await Bun.sleep(300)
    expect(changes).toBe(0)
    // Not vacuous: a write to an attempt the assignments list shows reaches it.
    fixture.repository.atomic((db) =>
      db.query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE id=?").run(firstAttemptID),
    )
    for (let waited = 0; waited < 50 && changes === 0; waited++) await Bun.sleep(20)
    expect(changes).toBeGreaterThan(0)
  } finally {
    for (const stream of streams) stream.close()
    meter.stop()
  }
})

test("authorize: a session view of another session throws; the caller's directory is overwritten", async () => {
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
  const open = async (source: string, filter: Record<string, unknown>) => {
    const frame = await service.open({
      stream: crypto.randomUUID(),
      source,
      filter: { projectDirectory: "/elsewhere", scope: owner, ...filter },
      order: "recent",
      window: 40,
    })
    const bytes = base64ToBytes(frame.data)
    const read = readFrame(bytes.buffer, bytes.byteOffset, radarAssignmentColumns)
    return Array.from({ length: read.header.count }, (_, i) => read.row(i).id)
  }
  try {
    expect((await open("radar.assignments", {})).length).toBe(2)
    // A session view lists only its own session's attempt, whatever it asked for.
    expect(
      await open("radar.assignments", {
        scope: { kind: "session", sessionID: "ses-failed" },
        sessionID: "ses-accepted",
      }),
    ).toEqual([firstAttemptID])
    await expect(
      open("radar.attempt", {
        scope: { kind: "session", sessionID: "ses-failed" },
        sessionID: "ses-accepted",
      }),
    ).rejects.toThrow("unavailable in this project scope")
    await expect(
      open("radar.assignments", { scope: { kind: "project", sessionID: "ses-denied" } }),
    ).rejects.toThrow("Not permitted")
    expect(asked).toEqual(["ses-owner", "ses-failed", "ses-denied"])
  } finally {
    service.dispose()
  }
})

import { afterAll, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import { ensureHostSessionStateSchema, writeHostSession } from "../../src/host-sessions/state.ts"
import {
  installProgressDisplaySchema,
  refreshProgressDisplay,
} from "../../src/progress/display-store.ts"
import { ensureNativeCallDisplaySchema } from "../../src/progress/native-call-display.ts"
import {
  ensureTranscriptMetaSchema,
  writeTranscriptPage,
} from "../../src/transcript-meta/schema.ts"
import { openStream } from "../../src/streams/client.ts"
import { readerPool } from "../../src/streams/pool.ts"
import { streamColumns, type Source } from "../../src/streams/source.ts"
import type { Columns } from "../../src/streams/frame.ts"
import { liveHistorySource } from "../../src/streams/sources/live-history.ts"
import { radarAssignmentsSource, radarNativeCallsSource } from "../../src/streams/sources/radar.ts"
import { radarSessionsSource } from "../../src/streams/sources/host-sessions.ts"
import { radarStepsSource, radarTranscriptsSource } from "../../src/streams/sources/radar-flow.ts"
import { makeFixture, firstAttemptID, taskID } from "../trajectory/fixture.ts"
import { operationalReads } from "./operational.ts"

/**
 * Records the parity fixture `test/fixtures/panel-streams/radar-flow.json`: one worker attempt's
 * model steps and tool calls written both as the progress rows the old `liveRadar` read scanned and
 * as the stored rows the streams read (`transcript_steps`, `runner_progress_display`,
 * `host_session_state`). The old read's sessions, routes, calls and flow are kept beside the
 * stream rows; `src/radar/live-view.test.ts` checks Flow builds the same phases and cards from
 * both. Set `RECORD_RADAR_FLOW=1` to rewrite the file.
 */
const fixture = makeFixture()
const project = fixture.directory
const SESSION = "ses-failed"
const ROUTE = { providerID: "openai", id: "gpt-6-luna", variant: "high" }
/** The recorder's route evidence names the model `modelID`. */
const EVIDENCE = { providerID: "openai", modelID: "gpt-6-luna", variant: "high" }
const T = 1_800_000_000_000

afterAll(() => fixture.close())

function progress(input: {
  kind: "step" | "tool"
  at: number
  messageID: string
  callID?: string
  key: string
  payload: unknown
}) {
  return fixture.store.atomic((db) => {
    db.query(
      `INSERT INTO runner_progress(
         project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
         source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      project,
      "project",
      fixture.receipt.planID,
      taskID,
      firstAttemptID,
      SESSION,
      input.at,
      input.at + 1,
      "native-event",
      JSON.stringify(["native-event"]),
      input.kind,
      "[]",
      input.callID ?? null,
      input.messageID,
      input.key,
      JSON.stringify(input.payload),
    )
    const seq = Number(
      db.query<{ seq: number }, []>("SELECT max(seq) AS seq FROM runner_progress").get()!.seq,
    )
    refreshProgressDisplay(db, seq)
  })
}

const observation = (eventType: string, at: number, status: string, messageID: string) => ({
  source: "native-event",
  eventID: `evt-${messageID}-${status}`,
  eventType,
  at,
  status,
  messageID,
  ...(eventType === "session.step.started"
    ? { routeEvidence: { status: "observed", route: EVIDENCE }, startedAt: at }
    : {}),
})

/** A model step: started, streamed, then ended with usage or failed. */
function step(messageID: string, at: number, end: "ended" | "failed", usage?: [number, number]) {
  progress({
    kind: "step",
    at,
    messageID,
    key: `step-${messageID}`,
    payload: {
      status: end,
      routeEvidence: { status: "observed", route: EVIDENCE },
      ...(usage ? { usage: { input: usage[0], output: usage[1] } } : {}),
      observations: [
        observation("session.step.started", at, "started", messageID),
        observation("session.step.streamed", at + 400, "streamed", messageID),
        observation(`session.step.${end}`, at + 900, end, messageID),
      ],
    },
  })
}

function tool(
  callID: string,
  name: string,
  at: number,
  status: "running" | "succeeded" | "failed",
) {
  const done = status !== "running"
  progress({
    kind: "tool",
    at,
    messageID: "msg-a",
    callID,
    key: `tool-${callID}`,
    payload: {
      tool: name,
      status,
      callID,
      messageID: "msg-a",
      execution: { status: "executed", source: "native-event" },
      ...(status === "failed" ? { error: { message: "exit 1" } } : {}),
      timing: {
        endpoints: {
          inputAt: { at, source: "native-event", sourceType: "session.tool.input.started" },
          ...(done
            ? {
                completedAt: {
                  at: at + 300,
                  source: "native-event",
                  sourceType: "session.tool.success",
                },
              }
            : {}),
        },
      },
      observations: [
        {
          source: "native-event",
          eventID: `evt-${callID}-in`,
          eventType: "session.tool.input.started",
          at,
          status: "input-started",
          callID,
          tool: name,
        },
        ...(done
          ? [
              {
                source: "native-event",
                eventID: `evt-${callID}-end`,
                eventType: status === "failed" ? "session.tool.failed" : "session.tool.success",
                at: at + 300,
                status,
                callID,
                tool: name,
              },
            ]
          : []),
      ],
    },
  })
}

const message = (
  id: string,
  at: number,
  end: "ended" | "failed",
  usage?: [number, number],
  retry = false,
) => ({
  type: "assistant",
  id,
  model: ROUTE,
  // The host completes a failed message too; its error carries only a name here.
  time: { created: at, streamed: at + 400, completed: at + 900 },
  ...(usage ? { tokens: { input: usage[0], output: usage[1] } } : {}),
  ...(end === "failed" ? { error: { type: "ProviderError" } } : {}),
  ...(retry ? { retry: { at: at - 100, attempt: 2, error: { type: "RateLimited" } } } : {}),
})

async function rows<F>(source: Source<F, Columns>, filter: F, order: string, window: number) {
  const pool = readerPool(fixture.repository.path, { workers: 1 })
  try {
    const stream = openStream(pool, source as never, { filter, order, window, transport: "copy" })
    await stream.ready()
    const columns = Object.keys(streamColumns(source as never, window))
    const items = stream.items.map((row) =>
      Object.fromEntries(
        columns.map((column) => [column, (row as Record<string, unknown>)[column]]),
      ),
    )
    stream.close()
    return JSON.parse(
      JSON.stringify(items, (_, value) => (typeof value === "bigint" ? Number(value) : value)),
    )
  } finally {
    await pool.close()
  }
}

test("record: the old live read and the stream rows of one worker's model and tool phases", async () => {
  ensureHostSessionStateSchema(fixture.repository)
  ensureTranscriptMetaSchema(fixture.repository)
  ensureNativeCallDisplaySchema(fixture.repository)
  fixture.store.atomic((db) => {
    installProgressDisplaySchema(db)
    db.query("UPDATE runner_attempts SET state='running', policy=? WHERE id=?").run(
      JSON.stringify({ model: ROUTE }),
      firstAttemptID,
    )
  })
  step("msg-a", T + 1_000, "ended", [1_200, 80])
  step("msg-b", T + 3_000, "failed")
  step("msg-c", T + 5_000, "ended", [900, 40])
  tool("call-1", "Bash", T + 2_000, "succeeded")
  tool("call-2", "Read", T + 2_500, "failed")
  tool("call-3", "Edit", T + 6_200, "running")
  fixture.repository.atomic((db) => {
    writeTranscriptPage(
      db,
      project,
      SESSION,
      { cursor: null, base: 0, messageCount: 0, state: "not-read" },
      [
        { type: "user", id: "u-1" },
        message("msg-a", T + 1_000, "ended", [1_200, 80]),
        message("msg-b", T + 3_000, "failed"),
        message("msg-c", T + 5_000, "ended", [900, 40], true),
      ],
      undefined,
    )
    writeHostSession(
      db,
      project,
      "project",
      SESSION,
      {
        id: SESSION,
        projectID: "project",
        parentID: "ses-owner",
        agent: "worker",
        title: null,
        directory: project,
        archived: false,
        busy: false,
        outcome: null,
        // The fixture's own session selection (`test/trajectory/fixture.ts`).
        model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
        tokensIn: 2_100,
        tokensOut: 120,
        tokensReasoning: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        createdAt: T,
        // As the fixture's native session says (`operational.ts`), so the session fields agree too.
        updatedAt: 1_200,
      } as never,
      undefined,
      T + 6_300,
    )
  })

  const reads = operationalReads(fixture, "project")
  const tracker = new ObservationChangeTracker(
    fixture.repository,
    new Uint8Array(32).fill(5),
    "project",
  )
  tracker.initialize(() => {})
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  const live = await reads.liveRadar(
    { scope, includeUnmanagedSessions: false },
    tracker,
    new AbortController().signal,
    tracker.streamEpoch,
  )
  const session = live.sessions.find((item) => item.sessionID === SESSION)
  expect(session?.assignment?.attemptID).toBe(firstAttemptID)
  const old = {
    sessions: live.sessions.filter((item) => item.sessionID === SESSION),
    routes: live.routes.filter((route) => route.sessionID === SESSION),
    calls: live.calls.filter((call) => call.sessionID === SESSION),
    flow: live.flow.filter((item) => item.sessionID === SESSION),
    scheduler: live.scheduler,
    workload: live.workload,
  }
  expect(old.flow.filter((item) => item.kind === "model-response").length).toBe(3)
  expect(old.calls.length).toBe(3)

  const base = { projectDirectory: project, scope }
  const streams = {
    sessions: (await rows(radarSessionsSource as never, base, "recent", 40)).filter(
      (row: { session_id: string }) => row.session_id === SESSION,
    ),
    assignments: await rows(radarAssignmentsSource as never, base, "recent", 40),
    calls: await rows(
      liveHistorySource as never,
      {
        ...base,
        attemptID: firstAttemptID,
        sessionID: SESSION,
        toolsOnly: true,
        projectIDs: ["project"],
      },
      "recent",
      18,
    ),
    nativeCalls: await rows(
      radarNativeCallsSource as never,
      { ...base, sessionID: SESSION },
      "recent",
      18,
    ),
    steps: await rows(radarStepsSource as never, { ...base, sessionID: SESSION }, "recent", 18),
    transcripts: await rows(
      radarTranscriptsSource as never,
      { ...base, sessionIDs: [SESSION] },
      "key",
      40,
    ),
  }
  expect(streams.steps.map((row: { message_id: string }) => row.message_id)).toEqual([
    "msg-c",
    "msg-b",
    "msg-a",
  ])
  expect(streams.transcripts[0]?.read_state).toBe("available")
  if (process.env.RECORD_RADAR_FLOW === "1")
    writeFileSync(
      join(import.meta.dir, "../fixtures/panel-streams/radar-flow.json"),
      `${JSON.stringify({ project, scope, observedAt: live.observedAt, old, streams }, null, 2)}\n`,
    )
})

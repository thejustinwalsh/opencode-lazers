import { expect, test } from "bun:test"
import { firstAttemptID, makeFixture } from "../../test/trajectory/fixture.ts"
import { operationalReads } from "../../test/radar/operational.ts"
import type { LiveHistoryResponse } from "../observability/contract.ts"
import { ProgressRecorder } from "./recorder.ts"
import { refreshProgressDisplay } from "./display-store.ts"

type StoredDisplay = {
  seq: number
  at: number
  recorded_at: number | null
  kind: string
  source: string
  message_id: string | null
  call_id: string | null
  tool: string | null
  status: string | null
  agent: string | null
  result: string | null
  error: string | null
  route_provider: string | null
  route_model: string | null
  route_variant: string | null
  file_targets_json: string | null
  observations_json: string
  payload_available: number
}

/** A stored display row in the shape of a history item. */
function itemOf(row: StoredDisplay) {
  return {
    sequence: row.seq,
    at: row.at,
    recordedAt: row.recorded_at,
    kind: row.kind,
    source: row.source,
    messageID: row.message_id,
    callID: row.call_id,
    tool: row.tool,
    status: row.status,
    agent: row.agent,
    result: row.result,
    error: row.error,
    route:
      row.route_provider === null
        ? null
        : { providerID: row.route_provider, modelID: row.route_model, variant: row.route_variant },
    observations: JSON.parse(row.observations_json),
    payloadAvailable: row.payload_available === 1,
    ...(row.file_targets_json ? { fileTargets: JSON.parse(row.file_targets_json) } : {}),
  }
}

const secret = "sk-proj-12345678901234567890"
const route = (n: number) => ({
  status: "observed",
  route: { providerID: "openai", modelID: `gpt-${n}`, variant: n % 2 ? "max" : null },
})

/** Every progress kind and every edge the display handles, as stored payloads. */
const corpus: { kind: string; payload: unknown; eventIDs?: string[]; callID?: string }[] = [
  {
    kind: "commentary",
    payload: { text: `thinking about ${secret}`, agent: "lazers-implementor" },
  },
  {
    kind: "tool",
    callID: "call-ok",
    payload: {
      tool: "read",
      status: "succeeded",
      agent: "lazers-implementor",
      result: "ok ".repeat(400),
      fileTargets: { coverage: "observed", operation: "read", paths: ["src/a.ts", "src/b.ts"] },
    },
  },
  {
    kind: "tool",
    callID: "call-bad",
    payload: {
      tool: "edit",
      status: "failed",
      error: { type: "ToolError", message: `failed: token=${secret} ${"x".repeat(900)}` },
      fileTargets: {
        coverage: "observed",
        operation: "edit",
        paths: ["/etc/passwd", "ok.ts", "../up"],
      },
    },
  },
  {
    kind: "tool",
    callID: "call-obs",
    payload: {
      tool: "bash",
      status: "running",
      observations: Array.from({ length: 12 }, (_, i) => ({
        source: i % 2 ? "native-event" : "recovery",
        eventID: `evt-${i}`,
        eventType: "session.tool.called",
        at: 5000 - i * 10,
        status: "running",
        routeEvidence: route(i),
      })),
    },
  },
  { kind: "visible-text", payload: { messageType: "synthetic", createdAt: 10, text: "hello" } },
  {
    kind: "step",
    payload: {
      status: "completed",
      agent: "lazers-implementor",
      routeEvidence: route(1),
      usage: { input: 10, output: 20 },
    },
  },
  { kind: "step", payload: { status: "completed", routeEvidence: { status: "unknown" } } },
  { kind: "usage-snapshot", payload: { usage: { input: 1, output: 2, costUSD: 0.5 } } },
  { kind: "provider-retry", payload: { status: "scheduled", error: { message: "rate limited" } } },
  { kind: "execution-outcome", payload: { status: "executed", result: "done", error: null } },
  { kind: "outcome-snapshot", payload: { status: "failed", result: "partial" } },
  { kind: "shell", payload: { status: "completed", result: "exit 0" } },
  {
    kind: "verification",
    payload: { status: "failed", result: "bun test", error: { message: "1 fail" } },
  },
  { kind: "artifact", payload: { status: "recorded", result: "b".repeat(40) } },
  { kind: "gap", payload: { status: "unavailable", result: "messages missing" } },
  { kind: "reminder", payload: { status: "delivered", result: "reminder sent" } },
  { kind: "native-observation", payload: { eventType: "session.idle" } },
  { kind: "mystery-kind", payload: { tool: "ignored" } },
  { kind: "tool", payload: "not an object" },
  {
    kind: "tool",
    payload: { tool: "é".repeat(200), status: "😀".repeat(100), result: "😀".repeat(400) },
  },
  // Past the contract's bounds: the history read leaves these out, so the row shows its columns.
  {
    kind: "tool",
    callID: "call-big",
    payload: { tool: "write", status: "succeeded", result: "y".repeat(5000) },
  },
  { kind: "tool", callID: "c".repeat(300), payload: { tool: "grep", status: "succeeded" } },
  {
    kind: "tool",
    callID: "call-ids",
    eventIDs: Array.from({ length: 200 }, (_, i) => `event-${i}-${"z".repeat(10)}`),
    payload: { tool: "glob", status: "succeeded" },
  },
]

function seed(fixture: ReturnType<typeof makeFixture>) {
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID)
    const plan = db
      .query<{ plan_id: string; task_id: string }, [string]>(
        "SELECT plan_id,task_id FROM runner_attempts WHERE id=?",
      )
      .get(firstAttemptID)!
    const insert = db.query(
      `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,
        at,recorded_at,source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    corpus.forEach((entry, i) => {
      const result = insert.run(
        fixture.store.repository.projectDirectory,
        "project",
        plan.plan_id,
        plan.task_id,
        firstAttemptID,
        "ses-failed",
        1_000 + i * 7 + (i % 3 ? 0.5 : 0),
        i % 4 ? 2_000 + i : null,
        i % 2 ? "native-event" : "runtime",
        "[]",
        entry.kind,
        JSON.stringify(entry.eventIDs ?? [`evt-${i}`]),
        entry.callID ?? null,
        `msg-${i}`,
        `corpus-${i}`,
        typeof entry.payload === "string" ? entry.payload : JSON.stringify(entry.payload),
      )
      // Rows that reach the table other than through the recorder are covered by backfill; the
      // writer's own function is what stores them here.
      refreshProgressDisplay(db, Number(result.lastInsertRowid))
    })
  })
}

test("the display stored with each progress row equals the read-time history, for every kind", async () => {
  const fixture = makeFixture()
  try {
    seed(fixture)
    const recorder = new ProgressRecorder(fixture.store, "project")
    for (const [index, call] of [
      { tool: "read", callID: "rec-read", input: { path: "src/read.ts", content: "DECOY" } },
      { tool: "edit", callID: "rec-edit", input: { path: "src/edit.ts", oldText: "DECOY" } },
    ].entries()) {
      recorder.recordToolTargets({
        ...call,
        messageID: `rec-msg-${index}`,
        sessionID: "ses-failed",
        agent: "lazers-implementor",
      })
      recorder.recordNativeEvent({
        id: `rec-evt-${index}`,
        type: "session.tool.input.started",
        created: 60_000 + index,
        data: {
          sessionID: "ses-failed",
          assistantMessageID: `rec-msg-${index}`,
          id: call.callID,
          name: call.tool,
        },
      })
    }
    // A later event merges into the stored row: the display follows the merged payload.
    recorder.recordNativeEvent({
      id: "rec-evt-failed",
      type: "session.tool.failed",
      created: 60_100,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "rec-msg-1",
        id: "rec-edit",
        error: { type: "ToolError", message: "native edit failed" },
      },
    })

    const reads = operationalReads(fixture)
    const old: LiveHistoryResponse["items"] = []
    let cursor: string | undefined
    do {
      const page = reads.liveHistory(
        {
          scope: { kind: "project", sessionID: "ses-owner" },
          sessionID: "ses-failed",
          limit: 25,
          ...(cursor ? { cursor } : {}),
        },
        new AbortController().signal,
      )
      old.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor)

    const stored = fixture.store.read((db) =>
      db
        .query<StoredDisplay, [string]>(
          "SELECT * FROM runner_progress_display WHERE attempt_id=? ORDER BY seq",
        )
        .all(firstAttemptID),
    )
    expect(old.length).toBeGreaterThanOrEqual(corpus.length + 2)
    expect(stored.map((row) => row.seq)).toEqual(
      old.map((item) => item.sequence).toSorted((a, b) => a - b),
    )
    const byStored = new Map(stored.map((row) => [row.seq, itemOf(row)]))
    for (const item of old) expect(byStored.get(item.sequence)).toEqual(item)

    // The corpus exercises what it claims to.
    const kinds = new Set(old.map((item) => item.kind))
    for (const kind of ["commentary", "worker-tool", "worker-step", "worker-shell", "worker-gap"])
      expect(kinds.has(kind)).toBe(true)
    expect(old.some((item) => item.fileTargets?.coverage === "partial")).toBe(true)
    expect(old.some((item) => item.route !== null)).toBe(true)
    expect(old.some((item) => item.observations.length === 8)).toBe(true)
    expect(old.some((item) => !item.payloadAvailable)).toBe(true)
    expect(old.some((item) => item.error?.endsWith("…[truncated]"))).toBe(true)
    expect(JSON.stringify(old)).not.toContain(secret)
    expect(old.find((item) => item.callID === "rec-edit")?.error).toBe("native edit failed")
  } finally {
    fixture.close()
  }
})

test("a deleted progress row takes its display with it", () => {
  const fixture = makeFixture()
  try {
    seed(fixture)
    const count = () =>
      fixture.store.read(
        (db) =>
          db.query<{ n: number }, []>("SELECT count(*) AS n FROM runner_progress_display").get()!.n,
      )
    expect(count()).toBe(corpus.length)
    fixture.store.atomic((db) => db.query("DELETE FROM runner_progress WHERE seq<=5").run())
    expect(count()).toBe(corpus.length - 5)
  } finally {
    fixture.close()
  }
})

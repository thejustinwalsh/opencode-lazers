import { firstAttemptID, type makeFixture } from "../../test/trajectory/fixture.ts"
import { refreshProgressDisplay } from "./display-store.ts"
import type { LiveHistoryItem } from "../streams/sources/live-history-ref.ts"

export const secret = "sk-proj-12345678901234567890"
const route = (n: number) => ({
  status: "observed",
  route: { providerID: "openai", modelID: `gpt-${n}`, variant: n % 2 ? "max" : null },
})

/** Every progress kind and every edge the display handles, as stored payloads. */
export const corpus: { kind: string; payload: unknown; eventIDs?: string[]; callID?: string }[] = [
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

export function seedDisplayCorpus(fixture: ReturnType<typeof makeFixture>) {
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

/** A `runner_progress_display` row as the history item it displays. */
export type StoredDisplay = {
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

export function storedDisplayItem(row: StoredDisplay): LiveHistoryItem {
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
        : {
            providerID: row.route_provider,
            modelID: row.route_model as string,
            variant: row.route_variant,
          },
    observations: JSON.parse(row.observations_json),
    payloadAvailable: row.payload_available === 1,
    ...(row.file_targets_json ? { fileTargets: JSON.parse(row.file_targets_json) } : {}),
  }
}

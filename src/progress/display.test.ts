import { expect, test } from "bun:test"
import { firstAttemptID, makeFixture } from "../../test/trajectory/fixture.ts"
import { operationalReads } from "../../test/radar/operational.ts"
import type { LiveHistoryResponse } from "../observability/contract.ts"
import { ProgressRecorder } from "./recorder.ts"
import { corpus, secret, seedDisplayCorpus } from "./display.fixture.ts"

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

test("the display stored with each progress row equals the read-time history, for every kind", async () => {
  const fixture = makeFixture()
  try {
    seedDisplayCorpus(fixture)
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
    seedDisplayCorpus(fixture)
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

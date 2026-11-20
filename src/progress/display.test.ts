import { expect, test } from "bun:test"
import { firstAttemptID, makeFixture } from "../../test/trajectory/fixture.ts"
import {
  corpus,
  secret,
  seedDisplayCorpus,
  storedDisplayItem,
  v1Display,
} from "./display.fixture.ts"
import type { StoredDisplay } from "./display.fixture.ts"
import { progressDisplay } from "./display.ts"
import { ProgressRecorder } from "./recorder.ts"

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

    // What the display is for each stored row now: the pure function over the row as it is.
    const progress = fixture.store.read((db) =>
      db
        .query<
          {
            seq: number
            at: number
            recorded_at: number | null
            source: string
            kind: string
            event_ids_json: string
            call_id: string | null
            message_id: string | null
            payload: string
          },
          [string]
        >(
          `SELECT seq,at,recorded_at,source,kind,event_ids_json,call_id,message_id,payload
             FROM runner_progress WHERE attempt_id=? ORDER BY seq`,
        )
        .all(firstAttemptID),
    )
    const expected = progress.map((row) => ({
      sequence: row.seq,
      at: row.at,
      recordedAt: row.recorded_at,
      ...progressDisplay(row),
    }))
    const stored = fixture.store.read((db) =>
      db
        .query<StoredDisplay, [string]>(
          "SELECT * FROM runner_progress_display WHERE attempt_id=? ORDER BY seq",
        )
        .all(firstAttemptID),
    )
    expect(expected.length).toBeGreaterThanOrEqual(corpus.length + 2)
    expect(stored.map(storedDisplayItem)).toEqual(expected)
    const old = expected

    // The corpus exercises what it claims to.
    const kinds = new Set(old.map((item) => item.kind))
    for (const kind of ["commentary", "worker-tool", "worker-step", "worker-shell", "worker-gap"])
      expect(kinds.has(kind)).toBe(true)
    expect(old.some((item) => item.fileTargets?.coverage === "partial")).toBe(true)
    expect(old.some((item) => item.route !== null)).toBe(true)
    expect(old.some((item) => item.observations.length === 8)).toBe(true)
    expect(old.every((item) => item.payloadAvailable)).toBe(true)
    expect(old.some((item) => item.error?.endsWith("…[truncated]"))).toBe(true)
    expect(JSON.stringify(old)).not.toContain(secret)
    expect(old.find((item) => item.callID === "rec-edit")?.error).toBe("native edit failed")
    // Rows the first read cut (see `v1Display`) now carry their fields.
    const big = old.find(
      (item) => item.messageID === `msg-${corpus.findIndex((e) => e.callID === "call-big")}`,
    )
    expect(big).toMatchObject({ payloadAvailable: true, tool: "write", status: "succeeded" })
    expect(old.find((item) => item.callID?.startsWith("ccc"))?.callID).toEndWith("…[truncated]")
    const changed = progress.filter(
      (row) => JSON.stringify(v1Display(row)) !== JSON.stringify(progressDisplay(row)),
    )
    expect(changed.map((row) => row.call_id)).toEqual(["call-big", "c".repeat(300)])
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

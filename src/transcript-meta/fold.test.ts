import { expect, test } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { makeFixture, secondAttemptID } from "../../test/trajectory/fixture.ts"
import type { HostMessageClient } from "../core/host-messages.ts"
import { startProjection } from "../projections/owner.ts"
import { TranscriptMetaFold } from "./fold.ts"
import {
  ensureTranscriptMetaSchema,
  storedTranscriptSession,
  TRANSCRIPT_META_QUEUE,
  transcriptMetaSeedProjection,
} from "./schema.ts"

type Fixture = ReturnType<typeof makeFixture>

/**
 * A host message list over `transcripts`, paged like OpenCode's: the first page names the order,
 * later pages only the cursor (both together is rejected), and the last page has no next cursor.
 */
function fakeClient(transcripts: Map<string, unknown[]>) {
  const calls: Array<{ sessionID: string; cursor?: string }> = []
  let fail: ((sessionID: string) => unknown) | undefined
  const client = {
    message: {
      async list(input: { sessionID: string; limit?: number; cursor?: string; order?: string }) {
        if (input.cursor && input.order) throw new Error("Cursor cannot be combined with order")
        calls.push({
          sessionID: input.sessionID,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        })
        const failure = fail?.(input.sessionID)
        if (failure) throw failure
        const all = transcripts.get(input.sessionID) ?? []
        const offset = input.cursor ? Number(input.cursor.slice(2)) : 0
        const limit = input.limit ?? 50
        const data = all.slice(offset, offset + limit)
        const next = offset + limit < all.length ? `c:${offset + limit}` : undefined
        return { data, cursor: { next } }
      },
    },
  } as unknown as HostMessageClient
  return {
    client,
    calls,
    failWith(next: typeof fail) {
      fail = next
    },
  }
}

const assistant = (id: string, created: number, model = "gpt-6-luna") => ({
  id,
  type: "assistant",
  time: { created, completed: created + 5 },
  model: { providerID: "openai", id: model, variant: "max" },
  tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
  content: [{ type: "text", text: "visible" }],
})
const user = (id: string) => ({ id, type: "user", text: "do the thing" })

/** `count` messages, alternating user and assistant. */
function transcript(count: number, prefix = "m") {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? user(`${prefix}-${index}`) : assistant(`${prefix}-${index}`, 1_000 + index),
  )
}

function steps(fixture: Fixture, sessionID: string) {
  return fixture.repository.read((db) =>
    db
      .query<{ message_id: string; ordinal: number }, [string, string]>(
        `SELECT message_id,ordinal FROM transcript_steps
         WHERE project_directory=? AND session_id=? ORDER BY ordinal`,
      )
      .all(fixture.directory, sessionID),
  )
}

function queue(fixture: Fixture, sessionID: string) {
  fixture.repository.atomic((db) =>
    db
      .query(`INSERT OR IGNORE INTO ${TRANSCRIPT_META_QUEUE}(ref,next_at) VALUES(?,0)`)
      .run(`${fixture.directory}\u0000${sessionID}`),
  )
}

function fold(fixture: Fixture, client: HostMessageClient, now?: () => number) {
  ensureTranscriptMetaSchema(fixture.repository)
  const created = new TranscriptMetaFold(fixture.repository, client, {
    spacingMs: 0,
    ...(now ? { now } : {}),
  })
  created.start()
  return created
}

test("pages by cursor; a restart resumes at the stored cursor; redelivery adds no row", async () => {
  const fixture = makeFixture()
  try {
    const transcripts = new Map([["ses-accepted", transcript(120)]])
    const host = fakeClient(transcripts)
    let folding = fold(fixture, host.client)
    queue(fixture, "ses-accepted")
    await folding.settle()
    expect(host.calls.map((call) => call.cursor ?? null)).toEqual([null, "c:50", "c:100"])
    expect(steps(fixture, "ses-accepted")).toHaveLength(60)
    expect(steps(fixture, "ses-accepted")[0]).toEqual({ message_id: "m-1", ordinal: 1 })
    expect(
      fixture.repository.read((db) =>
        storedTranscriptSession(db, fixture.directory, "ses-accepted"),
      ),
    ).toEqual({ cursor: "c:100", base: 100, messageCount: 120, state: "available" })
    folding.close()

    // A restart reads from the tail page only; the same messages again write nothing.
    transcripts.get("ses-accepted")!.push(...transcript(10, "n"))
    host.calls.length = 0
    folding = fold(fixture, host.client)
    queue(fixture, "ses-accepted")
    await folding.settle()
    expect(host.calls.map((call) => call.cursor)).toEqual(["c:100"])
    const rows = steps(fixture, "ses-accepted")
    expect(rows).toHaveLength(65)
    expect(rows.at(-1)).toEqual({ message_id: "n-9", ordinal: 129 })
    expect(new Set(rows.map((row) => row.message_id)).size).toBe(rows.length)
    folding.close()
  } finally {
    fixture.close()
  }
})

test("a reverted tail drops its steps; the count follows the host", async () => {
  const fixture = makeFixture()
  try {
    const transcripts = new Map([["ses-accepted", transcript(30)]])
    const host = fakeClient(transcripts)
    const folding = fold(fixture, host.client)
    queue(fixture, "ses-accepted")
    await folding.settle()
    expect(steps(fixture, "ses-accepted")).toHaveLength(15)
    transcripts.set("ses-accepted", transcript(20))
    queue(fixture, "ses-accepted")
    await folding.settle()
    expect(steps(fixture, "ses-accepted")).toHaveLength(10)
    expect(
      fixture.repository.read((db) =>
        storedTranscriptSession(db, fixture.directory, "ses-accepted"),
      )?.messageCount,
    ).toBe(20)
    folding.close()
  } finally {
    fixture.close()
  }
})

test("privacy: no text column exists and no message text reaches the database file", async () => {
  const fixture = makeFixture()
  try {
    // The fixture's transcripts carry secrets in text, tool input and output, reasoning, error
    // messages and attachments.
    const transcripts = new Map(
      [...fixture.sessions.values()].map((session) => [session.id, [...session.messages!]]),
    )
    const secrets = [
      "sk-proj-12345678901234567890",
      "never-export-this",
      "PRIVATE REASONING DO NOT EXPORT",
      "Bearer retry-secret-value",
      "ghp_123456789012345678901234567890",
      "REPLAY DATA",
    ]
    const serialized = JSON.stringify([...transcripts.values()])
    for (const secret of secrets) expect(serialized).toContain(secret)
    const host = fakeClient(transcripts)
    const folding = fold(fixture, host.client)
    for (const id of transcripts.keys()) queue(fixture, id)
    await folding.settle()
    folding.close()
    expect(steps(fixture, "ses-failed").length).toBeGreaterThan(0)

    const columns = (table: string) =>
      fixture.repository.read((db) =>
        db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name),
      )
    // Ids, the route, times, two counts and names: nothing that holds text.
    expect(columns("transcript_steps")).toEqual([
      "id",
      "project_directory",
      "session_id",
      "message_id",
      "ordinal",
      "provider_id",
      "model_id",
      "variant",
      "created_at",
      "streamed_at",
      "completed_at",
      "input_tokens",
      "output_tokens",
      "error_type",
      "retry_at",
      "retry_attempt",
      "retry_error_type",
    ])
    expect(columns("transcript_sessions")).toEqual([
      "id",
      "project_directory",
      "session_id",
      "cursor",
      "base_ordinal",
      "message_count",
      "read_state",
    ])
    const errorTypes = fixture.repository.read((db) =>
      db
        .query<{ error_type: string }, []>(
          "SELECT retry_error_type AS error_type FROM transcript_steps WHERE retry_error_type IS NOT NULL",
        )
        .all(),
    )
    // The retry's error name is kept; its message (a bearer token here) is not.
    expect(errorTypes).toEqual([{ error_type: "ProviderError" }])

    // The main file and the write-ahead log: every byte written so far is in one of them.
    const path = fixture.repository.path
    const bytes = [path, `${path}-wal`]
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file).toString("latin1"))
      .join("")
    expect(bytes).toContain("ses-failed")
    for (const secret of secrets) expect(bytes).not.toContain(secret)
  } finally {
    fixture.close()
  }
})

test("a failed read parks with a backoff; a gone session keeps its rows and leaves the queue", async () => {
  const fixture = makeFixture()
  try {
    let now = 1_000_000
    const transcripts = new Map([["ses-accepted", transcript(4)]])
    const host = fakeClient(transcripts)
    const folding = fold(fixture, host.client, () => now)
    host.failWith(() => new Error("host down"))
    queue(fixture, "ses-accepted")
    await folding.drain()
    const parked = () =>
      fixture.repository.read((db) =>
        db
          .query<{ attempts: number; next_at: number; error: string }, []>(
            `SELECT attempts,next_at,error FROM ${TRANSCRIPT_META_QUEUE}`,
          )
          .get(),
      )
    expect(parked()).toEqual({ attempts: 1, next_at: now + 1_000, error: "host down" })
    expect(
      fixture.repository.read((db) =>
        storedTranscriptSession(db, fixture.directory, "ses-accepted"),
      )?.state,
    ).toBe("unavailable")
    // Not due: nothing is read; when due, it recovers.
    host.calls.length = 0
    await folding.drain()
    expect(host.calls).toHaveLength(0)
    host.failWith(undefined)
    now += 1_000
    await folding.settle()
    expect(steps(fixture, "ses-accepted")).toHaveLength(2)
    expect(parked()).toBeNull()

    // OpenCode no longer has it: the rows stay, the state stays available, nothing is queued.
    host.failWith(() => ({ _tag: "SessionNotFoundError" }))
    queue(fixture, "ses-accepted")
    await folding.settle()
    expect(steps(fixture, "ses-accepted")).toHaveLength(2)
    expect(parked()).toBeNull()
    expect(
      fixture.repository.read((db) =>
        storedTranscriptSession(db, fixture.directory, "ses-accepted"),
      )?.state,
    ).toBe("available")
    expect(folding.idle()).toBe(true)
    folding.close()
  } finally {
    fixture.close()
  }
})

test("hints: only attempt sessions are read, a covered hint reads nothing, spacing waits", async () => {
  const fixture = makeFixture()
  try {
    let now = 5_000
    const transcripts = new Map([
      ["ses-accepted", transcript(4)],
      ["ses-owner", transcript(4)],
    ])
    const host = fakeClient(transcripts)
    ensureTranscriptMetaSchema(fixture.repository)
    const folding = new TranscriptMetaFold(fixture.repository, host.client, {
      now: () => now,
      spacingMs: 2_000,
    })
    folding.start()
    const event = (sessionID: string, created: number) => ({
      type: "session.step.ended",
      created,
      data: { sessionID },
    })
    folding.hint(event("ses-owner", now))
    await folding.settle()
    expect(host.calls).toHaveLength(0)

    folding.hint(event("ses-accepted", now))
    await folding.settle()
    expect(host.calls).toHaveLength(1)
    // Created before the read began: covered.
    folding.hint(event("ses-accepted", now - 1))
    await folding.settle()
    expect(host.calls).toHaveLength(1)
    // A newer hint inside the spacing waits for it.
    now += 500
    folding.hint(event("ses-accepted", now))
    await folding.settle()
    expect(host.calls).toHaveLength(1)
    expect(folding.idle()).toBe(false)
    now += 1_500
    await folding.settle()
    expect(host.calls).toHaveLength(2)
    expect(folding.idle()).toBe(true)
    folding.close()
  } finally {
    fixture.close()
  }
})

test("an attempt's state change queues its session; the seed queues every worker attempt once", async () => {
  const fixture = makeFixture()
  try {
    ensureTranscriptMetaSchema(fixture.repository)
    const queued = () =>
      fixture.repository.read((db) =>
        db
          .query<{ ref: string }, []>(`SELECT ref FROM ${TRANSCRIPT_META_QUEUE} ORDER BY ref`)
          .all()
          .map((row) => row.ref.split("\u0000")[1]),
      )
    expect(queued()).toEqual([])
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(secondAttemptID),
    )
    expect(queued()).toEqual(["ses-accepted"])
    fixture.repository.atomic((db) => db.exec(`DELETE FROM ${TRANSCRIPT_META_QUEUE}`))

    const started = performance.now()
    const seed = startProjection(
      fixture.repository.path,
      fixture.directory,
      transcriptMetaSeedProjection,
      { scope: fixture.directory },
    )
    await seed.owner.settle()
    console.info(`transcript seed: ${(performance.now() - started).toFixed(1)} ms`)
    expect(queued()).toEqual(["ses-accepted", "ses-failed"])
    seed.release()
  } finally {
    fixture.close()
  }
})

/** A host session row as the host session fold writes it (the columns the fold reads). */
function hostSession(
  fixture: Fixture,
  sessionID: string,
  options: { archived?: boolean; updated: number; busy?: boolean },
) {
  fixture.repository.atomic((db) =>
    db
      .query(
        `INSERT INTO host_session_state(project_directory,session_id,role,busy,pending_input,
           pending_permissions,pending_forms,archived,updated_at,host_updated_at)
         VALUES(?,?,'architect',?,0,0,0,?,?,?)`,
      )
      .run(
        fixture.directory,
        sessionID,
        Number(options.busy ?? false),
        Number(options.archived ?? false),
        options.updated,
        options.updated,
      ),
  )
}

test("sessions no plan holds: a shown host session is queued, hinted and read newest first", async () => {
  const fixture = makeFixture()
  try {
    const transcripts = new Map([
      ["ses-architect-old", transcript(4, "o")],
      ["ses-architect-new", transcript(4, "n")],
      ["ses-architect-archived", transcript(4, "a")],
    ])
    const host = fakeClient(transcripts)
    ensureTranscriptMetaSchema(fixture.repository)
    // The host session fold writes rows; each unarchived insert queues its session.
    hostSession(fixture, "ses-architect-old", { updated: 1_000 })
    hostSession(fixture, "ses-architect-new", { updated: 9_000 })
    hostSession(fixture, "ses-architect-archived", { updated: 5_000, archived: true })
    const folding = new TranscriptMetaFold(fixture.repository, host.client, { spacingMs: 0 })
    folding.start()
    await folding.settle()
    expect(host.calls.map((call) => call.sessionID)).toEqual([
      "ses-architect-new",
      "ses-architect-old",
    ])
    expect(steps(fixture, "ses-architect-new")).toHaveLength(2)

    // A step event of a shown session reads it; of an archived one outside the window, nothing.
    host.calls.length = 0
    const event = (sessionID: string) => ({
      type: "session.step.ended",
      created: Date.now() + 1_000,
      data: { sessionID },
    })
    folding.hint(event("ses-architect-old"))
    folding.hint(event("ses-architect-archived"))
    await folding.settle()
    expect(host.calls.map((call) => call.sessionID)).toEqual(["ses-architect-old"])

    // With a retention age, an archived session updated within it is shown: the seed queues it.
    fixture.repository.atomic((db) => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS retention_settings(id INTEGER PRIMARY KEY, auto_days INTEGER, updated_at INTEGER)",
      )
      db.query("INSERT INTO retention_settings(id,auto_days,updated_at) VALUES(1,7,0)").run()
      db.query("UPDATE host_session_state SET host_updated_at=? WHERE session_id=?").run(
        Date.now(),
        "ses-architect-archived",
      )
    })
    const seed = startProjection(
      fixture.repository.path,
      fixture.directory,
      transcriptMetaSeedProjection,
      { scope: fixture.directory },
    )
    await seed.owner.settle()
    seed.release()
    host.calls.length = 0
    await folding.settle()
    expect(host.calls.map((call) => call.sessionID)).toContain("ses-architect-archived")
    folding.close()
  } finally {
    fixture.close()
  }
})

test("a cursor the host refuses is read again from the start; the rows stay", async () => {
  const fixture = makeFixture()
  try {
    const transcripts = new Map([["ses-accepted", transcript(60)]])
    const host = fakeClient(transcripts)
    const folding = fold(fixture, host.client)
    queue(fixture, "ses-accepted")
    await folding.settle()
    expect(steps(fixture, "ses-accepted")).toHaveLength(30)
    let refused = false
    host.failWith(() => {
      if (refused) return undefined
      refused = true
      return { _tag: "InvalidCursorError", message: "Unknown cursor" }
    })
    host.calls.length = 0
    queue(fixture, "ses-accepted")
    await folding.settle()
    expect(host.calls.map((call) => call.cursor ?? null)).toEqual(["c:50", null, "c:50"])
    expect(steps(fixture, "ses-accepted")).toHaveLength(30)
    expect(folding.idle()).toBe(true)
    folding.close()
  } finally {
    fixture.close()
  }
})

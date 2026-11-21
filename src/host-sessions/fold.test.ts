import { afterEach, expect, test } from "bun:test"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { startProjection } from "../projections/owner.ts"
import { meterRepository } from "../runner/read-meter.fixture.ts"
import { TaskRepository } from "../storage.ts"
import { HostSessionFold, hostSessionHint } from "./fold.ts"
import {
  ensureHostSessionStateSchema,
  HOST_SESSION_QUEUE,
  hostSessionSeedProjection,
  type HostSessionPending,
  type HostSessionRecord,
  type HostSessionSource,
} from "./state.ts"

type Fixture = ReturnType<typeof makeFixture>
const open: { close(): void }[] = []
afterEach(() => {
  for (const item of open.splice(0).reverse()) item.close()
})

function fixture() {
  const made = makeFixture()
  open.push(made)
  // The fixture's attempts predate the project column; the runner backfills it in production.
  made.repository.atomic((db) =>
    db
      .query("UPDATE runner_attempts SET project_directory=? WHERE project_directory IS NULL")
      .run(made.directory),
  )
  return made
}

const session = (id: string, patch: Partial<HostSessionRecord> = {}): HostSessionRecord => ({
  id,
  projectID: "project",
  parentID: null,
  agent: "build",
  title: null,
  directory: "/work",
  archived: false,
  busy: false,
  outcome: null,
  model: { providerID: "openai", id: "gpt-6-luna", variant: null },
  tokensIn: 10,
  tokensOut: 5,
  createdAt: 1,
  updatedAt: 100,
  ...patch,
})

/** A host of sessions, read through the fold's three calls, counting them. */
function fakeHost(records: HostSessionRecord[], pageSize = 2) {
  const sessions = new Map(records.map((item) => [item.id, item]))
  const pending = new Map<string, HostSessionPending>()
  const calls = { get: 0, pending: 0, list: 0 }
  let fail: string | undefined
  const source: HostSessionSource = {
    async get(id) {
      calls.get++
      if (fail === id) throw new Error("host unavailable")
      return sessions.get(id) ?? null
    },
    async pending(id) {
      calls.pending++
      const known = sessions.get(id)
      if (!known) return null
      return (
        pending.get(id) ?? {
          busy: known.busy,
          pendingInput: false,
          pendingPermissions: 0,
          pendingForms: 0,
          outcome: known.outcome,
        }
      )
    },
    async list(projectID, cursor) {
      calls.list++
      const live = [...sessions.values()].filter(
        (item) => item.projectID === projectID && !item.archived,
      )
      const start = cursor ? Number(cursor) : 0
      const next = start + pageSize
      return {
        records: live.slice(start, next),
        ...(next < live.length ? { next: String(next) } : {}),
      }
    },
  }
  return {
    source,
    sessions,
    pending,
    calls,
    failOn(id: string | undefined) {
      fail = id
    },
  }
}

function startFold(made: Fixture, source: HostSessionSource, now?: () => number) {
  const repository = new TaskRepository(made.repository.path, made.directory)
  const fold = new HostSessionFold(repository, "project", source, now ? { now } : {})
  fold.start()
  open.push({
    close() {
      fold.close()
      repository.close()
    },
  })
  return { fold, repository }
}

const event = (type: string, sessionID: string, created?: number) => ({
  id: crypto.randomUUID(),
  type,
  ...(created === undefined ? {} : { created }),
  data: type === "form.created" ? { form: { sessionID } } : { sessionID },
})

type StoredRow = Record<string, unknown>
const rows = (made: Fixture) =>
  made.repository.read((db) =>
    db
      .query<StoredRow, [string]>(
        `SELECT session_id,role,agent,attempt_id,task_id,parent_session_id,directory,busy,
           pending_input,pending_permissions,pending_forms,outcome,archived,route_provider,
           route_model,route_variant,tokens_in,tokens_out,created_at,host_updated_at
         FROM host_session_state WHERE project_directory=? ORDER BY session_id`,
      )
      .all(made.directory),
  )
const queued = (made: Fixture) =>
  made.repository.read(
    (db) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${HOST_SESSION_QUEUE}`).get()!.n,
  )

test("hint: the event names the session; form events name it inside the form", () => {
  expect(hostSessionHint(event("session.usage.updated", "ses-a", 5))).toEqual({
    sessionID: "ses-a",
    created: 5,
    observe: false,
    moved: false,
  })
  expect(hostSessionHint(event("form.created", "ses-b"))?.sessionID).toBe("ses-b")
  expect(hostSessionHint(event("permission.asked", "ses-c"))?.observe).toBe(true)
  expect(hostSessionHint({ type: "session.idle", data: {} })).toBeUndefined()
})

test("fold: a hinted session is read once and stored with its role; another project's is not", async () => {
  const made = fixture()
  const host = fakeHost([
    session("ses-failed"),
    session("ses-architect", { agent: "architect" }),
    session("ses-foreign", { projectID: "other" }),
  ])
  const { fold } = startFold(made, host.source)
  for (const id of ["ses-failed", "ses-architect", "ses-foreign"])
    fold.hint(event("session.agent.selected", id, 1))
  await fold.settle()
  const stored = rows(made)
  expect(stored.map((row) => [row.session_id, row.role])).toEqual([
    ["ses-architect", "architect"],
    ["ses-failed", "worker"],
  ])
  expect(stored[1]!.attempt_id).toBeString()
  expect(stored[1]!.task_id).toBeString()
  expect(queued(made)).toBe(0)
  // A foreign session's later events read nothing.
  const before = host.calls.get
  fold.hint(event("session.usage.updated", "ses-foreign", 2))
  await fold.settle()
  expect(host.calls.get).toBe(before)
})

test("redelivered and out-of-order events leave the newest stamp", async () => {
  const made = fixture()
  const host = fakeHost([session("ses-a", { updatedAt: 200, tokensIn: 50 })])
  let clock = 1_000
  const { fold } = startFold(made, host.source, () => clock)
  const usage = event("session.usage.updated", "ses-a", 900)
  fold.hint(usage)
  await fold.settle()
  expect(host.calls.get).toBe(1)
  // Redelivered: created before the read began, so the read already covered it.
  clock = 2_000
  fold.hint(usage)
  fold.hint(event("session.usage.updated", "ses-a", 950))
  await fold.settle()
  expect(host.calls.get).toBe(1)
  // An older host state read late (a reordered read) never moves the row back.
  host.sessions.set("ses-a", session("ses-a", { updatedAt: 150, tokensIn: 7 }))
  fold.hint(event("session.usage.updated", "ses-a", 1_500))
  await fold.settle()
  expect(host.calls.get).toBe(2)
  expect(rows(made)[0]).toMatchObject({ host_updated_at: 200, tokens_in: 50 })
  // A newer state is written.
  host.sessions.set("ses-a", session("ses-a", { updatedAt: 300, tokensIn: 70 }))
  fold.hint(event("session.usage.updated", "ses-a", 2_500))
  await fold.settle()
  expect(rows(made)[0]).toMatchObject({ host_updated_at: 300, tokens_in: 70 })
})

test("pending counts: a permission or form event reads them; a usage event on a busy session keeps them; idle clears them", async () => {
  const made = fixture()
  const host = fakeHost([session("ses-a", { busy: true })])
  host.pending.set("ses-a", {
    busy: true,
    pendingInput: true,
    pendingPermissions: 2,
    pendingForms: 1,
    outcome: null,
  })
  let clock = 10
  const { fold } = startFold(made, host.source, () => clock)
  fold.hint(event("permission.asked", "ses-a", 5))
  await fold.settle()
  expect(host.calls.pending).toBe(1)
  expect(rows(made)[0]).toMatchObject({
    busy: 1,
    pending_input: 1,
    pending_permissions: 2,
    pending_forms: 1,
  })
  // A usage event reads the record only; the stored counts stay.
  clock = 20
  host.sessions.set("ses-a", session("ses-a", { busy: true, updatedAt: 110, tokensIn: 99 }))
  fold.hint(event("session.usage.updated", "ses-a", 15))
  await fold.settle()
  expect(host.calls.pending).toBe(1)
  expect(rows(made)[0]).toMatchObject({ tokens_in: 99, pending_permissions: 2, pending_forms: 1 })
  // An observe event during the usage read is not covered by it.
  clock = 30
  host.pending.set("ses-a", {
    busy: false,
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    outcome: "succeeded",
  })
  host.sessions.set("ses-a", session("ses-a", { updatedAt: 120, outcome: "succeeded" }))
  fold.hint(event("session.execution.succeeded", "ses-a", 25))
  await fold.settle()
  expect(rows(made)[0]).toMatchObject({
    busy: 0,
    pending_input: 0,
    pending_permissions: 0,
    pending_forms: 0,
    outcome: "succeeded",
  })
})

test("a lost event converges on attach: the resync re-reads the host by cursor", async () => {
  const made = fixture()
  const host = fakeHost(
    [session("ses-1"), session("ses-2"), session("ses-3", { busy: true }), session("ses-4")],
    2,
  )
  const { fold } = startFold(made, host.source)
  await fold.resync()
  await fold.settle()
  expect(rows(made).map((row) => row.session_id)).toEqual(["ses-1", "ses-2", "ses-3", "ses-4"])
  // Two pages, by cursor; only the busy session needed a pending read.
  expect(host.calls.list).toBe(2)
  expect(host.calls.pending).toBe(1)
  // Changes with no event at all: one archived, one deleted, one updated, one created.
  host.sessions.set("ses-1", session("ses-1", { archived: true, updatedAt: 200 }))
  host.sessions.delete("ses-2")
  host.sessions.set("ses-4", session("ses-4", { updatedAt: 300, tokensOut: 77 }))
  host.sessions.set("ses-5", session("ses-5", { parentID: "ses-4" }))
  await fold.resync()
  await fold.settle()
  const stored = rows(made)
  expect(stored.map((row) => [row.session_id, row.archived])).toEqual([
    ["ses-1", 1],
    ["ses-3", 1 - 1],
    ["ses-4", 0],
    ["ses-5", 0],
  ])
  expect(stored.find((row) => row.session_id === "ses-4")).toMatchObject({ tokens_out: 77 })
  expect(stored.find((row) => row.session_id === "ses-5")).toMatchObject({
    parent_session_id: "ses-4",
  })
})

test("idle: with no event and no queued session the fold reads nothing and holds no timer", async () => {
  const made = fixture()
  const host = fakeHost([session("ses-a")])
  const { fold, repository } = startFold(made, host.source)
  fold.hint(event("session.created", "ses-a", 1))
  await fold.settle()
  // The drain's own queue delete wakes it once more: one empty probe, then nothing.
  await Bun.sleep(20)
  const calls = { ...host.calls }
  const meter = meterRepository(repository)
  try {
    // An unrelated write elsewhere in the database wakes nothing.
    made.repository.atomic((db) =>
      db.query("UPDATE runner_attempts SET tool_count=tool_count+1").run(),
    )
    await Bun.sleep(150)
    expect(fold.idle()).toBe(true)
    expect(meter.statements).toEqual([])
    expect(host.calls).toEqual(calls)
    // Not vacuous: the same meter counts the fold's statements for a hint.
    fold.hint(event("session.usage.updated", "ses-a"))
    await fold.settle()
    expect(meter.statements.length).toBeGreaterThan(0)
    expect(host.calls.get).toBe(calls.get + 1)
  } finally {
    meter.stop()
  }
})

test("a failed read stays queued with its error and a backoff; a later hint retries it", async () => {
  const made = fixture()
  const host = fakeHost([session("ses-a")])
  const { fold } = startFold(made, host.source)
  host.failOn("ses-a")
  fold.hint(event("session.created", "ses-a", 1))
  await fold.settle()
  const parked = made.repository.read((db) =>
    db
      .query<{ attempts: number; error: string; next_at: number }, []>(
        `SELECT attempts,error,next_at FROM ${HOST_SESSION_QUEUE}`,
      )
      .get(),
  )
  expect(parked).toMatchObject({ attempts: 1, error: "host unavailable" })
  expect(parked!.next_at).toBeGreaterThan(Date.now())
  expect(fold.idle()).toBe(false) // the retry timer is the exit
  host.failOn(undefined)
  fold.hint(event("session.usage.updated", "ses-a"))
  await fold.settle()
  expect(queued(made)).toBe(0)
  expect(rows(made).length).toBe(1)
  expect(fold.idle()).toBe(true)
})

test("restart between cursor and rows resumes and ends equal to a fresh backfill", async () => {
  const records = [
    session("ses-owner", { agent: "architect" }),
    session("ses-failed", { busy: true }),
    session("ses-accepted", { archived: true }),
  ]
  const seed = async (made: Fixture) => {
    await made.index()
    ensureHostSessionStateSchema(made.repository)
    const lease = startProjection(made.repository.path, made.directory, hostSessionSeedProjection, {
      scope: made.directory,
    })
    open.push({ close: () => lease.release() })
    await lease.owner.settle()
    expect(lease.owner.status()?.state).toBe("ready")
  }
  // Fresh: seed, then read every queued session.
  const fresh = fixture()
  await seed(fresh)
  const freshFold = startFold(fresh, fakeHost(records).source).fold
  await freshFold.settle()
  // Interrupted: the first process reads one session and stops.
  const resumed = fixture()
  await seed(resumed)
  expect(queued(resumed)).toBe(3)
  const first = fakeHost(records)
  let reads = 0
  const stopping: HostSessionSource = {
    ...first.source,
    get: async (id) => {
      if (++reads > 1) await new Promise(() => {})
      return first.source.get(id)
    },
  }
  const firstFold = startFold(resumed, stopping).fold
  for (let waited = 0; waited < 50 && queued(resumed) > 2; waited++) await Bun.sleep(10)
  firstFold.close()
  expect(queued(resumed)).toBe(2)
  // The next process starts from the queue the first left.
  const second = fakeHost(records)
  await startFold(resumed, second.source).fold.settle()
  expect(second.calls.get).toBe(2)
  expect(rows(resumed)).toEqual(rows(fresh))
  expect(rows(fresh).map((row) => [row.session_id, row.role, row.archived])).toEqual([
    ["ses-accepted", "worker", 1],
    ["ses-failed", "worker", 0],
    ["ses-owner", "architect", 0],
  ])
})

test("title: the session record's own title is stored redacted and cut; no title stays null", async () => {
  const made = fixture()
  const host = fakeHost([
    session("ses-a", { title: "  Fix login api_key=sk-live-123  " }),
    session("ses-b", { title: "x".repeat(300) }),
    session("ses-c"),
  ])
  const { fold } = startFold(made, host.source)
  for (const id of ["ses-a", "ses-b", "ses-c"]) fold.hint(event("session.created", id, 1))
  await fold.settle()
  const titles = made.repository.read((db) =>
    db
      .query<{ session_id: string; title: string | null }, []>(
        "SELECT session_id,title FROM host_session_state ORDER BY session_id",
      )
      .all(),
  )
  expect(titles[0]!.title).toStartWith("Fix login api_key=")
  expect(titles[0]!.title).not.toContain("sk-live-123")
  expect(titles[1]!.title!.length).toBeLessThanOrEqual(200)
  expect(titles[2]!.title).toBeNull()
})

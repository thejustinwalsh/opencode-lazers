import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveReadStore } from "../observability/live-store.ts"
import { startProjection } from "../projections/owner.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository } from "../storage.ts"
import {
  NATIVE_CALL_DISPLAY,
  NATIVE_CALL_PAGE_ROWS,
  nativeCallDisplayProjection,
} from "./native-call-display.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const slow = {
  startMs: 60_000,
  quiet: { sliceMs: 1, waitMs: 1 },
  busy: { sliceMs: 1, waitMs: 1 },
  retryMs: 60_000,
}

function store() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-native-display-"))
  const path = join(directory, "tasks.sqlite")
  const repository = new TaskRepository(path, directory)
  new RunnerStore(repository)
  cleanups.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, path, repository }
}

type Call = {
  session: string
  kind?: "native-call" | "local-invocation"
  invocation: string
  native?: string | null
  context?: string
  tool?: string
  at: number
  payload: Record<string, unknown>
}

function insert(repository: TaskRepository, calls: readonly Call[]) {
  repository.atomic((db) => {
    const statement = db.query(
      `INSERT INTO native_tool_calls(project_directory,project_id,session_id,identity_kind,invocation_id,
         native_call_id,context_call_id,message_id,agent,tool,first_observed_at,last_observed_at,
         sources_json,event_ids_json,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'[]','[]',?)`,
    )
    for (const call of calls)
      statement.run(
        repository.projectDirectory,
        "project",
        call.session,
        call.kind ?? "native-call",
        call.invocation,
        call.native === undefined ? call.invocation : call.native,
        call.context ?? call.invocation,
        `msg-${call.invocation}`,
        "lazers-architect",
        call.tool ?? "read",
        call.at,
        call.at,
        JSON.stringify(call.payload),
      )
  })
}

const signal = new AbortController().signal
const corpus: Call[] = [
  ...Array.from({ length: 25 }, (_, i) => ({
    session: "ses-architect",
    invocation: `call-${i}`,
    at: 1_000 + i,
    payload: { status: i % 3 ? "succeeded" : "failed", detail: `read ${"x".repeat(300)} ${i}` },
  })),
  {
    session: "ses-architect",
    invocation: "call-error",
    at: 2_000,
    payload: { status: "failed", error: { message: `boom ${"y".repeat(400)}` } },
  },
  // A local invocation that the native read leaves out, but whose detail the tool details keep.
  {
    session: "ses-architect",
    kind: "local-invocation",
    invocation: "local-1",
    native: null,
    context: "ctx-1",
    at: 2_100,
    payload: { detail: "local detail" },
  },
  { session: "ses-other", invocation: "other-1", at: 1_500, payload: { status: "running" } },
]

type DisplayRow = {
  session_id: string
  call_id: string
  detail_call_id: string
  identity_kind: string
  message_id: string | null
  tool: string | null
  first_observed_at: number
  last_observed_at: number
  status: string | null
  detail: string | null
  error: string | null
}
const display = (repository: TaskRepository) =>
  repository.read((db) =>
    db
      .query<DisplayRow, [string]>(
        `SELECT session_id,call_id,detail_call_id,identity_kind,message_id,tool,first_observed_at,
           last_observed_at,status,detail,error
         FROM native_tool_call_display WHERE project_directory=? ORDER BY id LIMIT 5000`,
      )
      .all(repository.projectDirectory),
  )

function parity(directory: string, path: string, repository: TaskRepository) {
  const rows = display(repository)
  const live = new LiveReadStore(path, directory, "project")
  const sessions = ["ses-architect", "ses-other"]
  // The old native read: the latest native calls per session, every listed field.
  const old = live.nativeCalls(sessions, signal)
  for (const call of old) {
    const row = rows.find(
      (candidate) =>
        candidate.identity_kind === "native-call" &&
        candidate.session_id === call.session_id &&
        candidate.call_id === call.call_id,
    )
    expect(row).toMatchObject({
      message_id: call.message_id,
      tool: call.tool,
      first_observed_at: call.first_observed_at,
      last_observed_at: call.last_observed_at,
      status: call.status,
      detail: call.detail,
      error: call.error,
    })
  }
  // The old tool details: one 200-character detail per session and call key.
  const details = live.toolDetails(sessions, signal)
  expect(details.size).toBeGreaterThan(0)
  for (const [key, detail] of details) {
    const [session, call] = key.split("\u0000")
    expect(
      rows.find((row) => row.session_id === session && row.detail_call_id === call)?.detail,
    ).toBe(detail)
  }
  return old.length
}

test("parity: display rows carry what the live native-call and tool-detail reads returned, kept by triggers", () => {
  const { directory, path, repository } = store()
  insert(repository, corpus)
  expect(display(repository).length).toBe(corpus.length)
  expect(parity(directory, path, repository)).toBeGreaterThan(10)
  // The recorder's merge, an identity promotion and retention keep the rows current.
  repository.atomic((db) => {
    db.query(
      `UPDATE native_tool_calls SET last_observed_at=3000,payload=? WHERE invocation_id='call-1'`,
    ).run(JSON.stringify({ status: "succeeded", detail: "merged" }))
    db.query(
      `UPDATE native_tool_calls SET identity_kind='native-call',invocation_id='native-9',native_call_id='native-9'
       WHERE invocation_id='local-1'`,
    ).run()
    db.query("DELETE FROM native_tool_calls WHERE invocation_id='call-2'").run()
  })
  const rows = display(repository)
  expect(rows.find((row) => row.call_id === "call-1")).toMatchObject({
    detail: "merged",
    last_observed_at: 3000,
  })
  expect(rows.find((row) => row.call_id === "native-9")?.identity_kind).toBe("native-call")
  expect(rows.some((row) => row.call_id === "call-2")).toBe(false)
  expect(rows.length).toBe(corpus.length - 1)
  parity(directory, path, repository)
})

test("backfill: calls from before the table are displayed newest first, resuming after a kill", async () => {
  const { directory, path, repository } = store()
  const many: Call[] = Array.from({ length: NATIVE_CALL_PAGE_ROWS * 2 + 7 }, (_, i) => ({
    session: `ses-${i % 3}`,
    invocation: `c-${i}`,
    at: i,
    payload: { status: "succeeded", detail: `d-${i}` },
  }))
  insert(repository, many)
  const expected = display(repository)
  repository.atomic((db) => db.exec("DELETE FROM native_tool_call_display"))
  const first = startProjection(path, directory, nativeCallDisplayProjection, { pacing: slow })
  expect(first.owner.backfillPage()).toBe(true)
  first.release()
  const shown = display(repository)
  expect(shown.length).toBe(NATIVE_CALL_PAGE_ROWS)
  // The newest calls came first.
  expect(Math.min(...shown.map((row) => row.first_observed_at))).toBe(
    many.length - NATIVE_CALL_PAGE_ROWS,
  )
  const lease = startProjection(path, directory, nativeCallDisplayProjection, { pacing: slow })
  cleanups.push(() => lease.release())
  await lease.owner.settle()
  expect(lease.owner.status()).toMatchObject({ name: NATIVE_CALL_DISPLAY, state: "ready" })
  expect(display(repository)).toEqual(expected)
  expect(lease.owner.idle()).toBe(true)
})

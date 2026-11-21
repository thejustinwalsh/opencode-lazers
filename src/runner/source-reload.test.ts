import { expect, test } from "bun:test"
import { fixture, prepareIdleArchitect, useRuntimeFixtureCleanup } from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

/**
 * A plugin reload (and a lost event stream) resyncs every Architect source. The resync keeps the
 * stored observation: an unchanged session costs one cheap host read and no page scan, a changed
 * one is scanned again, and no input is lost or recorded twice.
 */
async function liveSource() {
  const now = 2_000_000_700_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "reload.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  for (let i = 0; i < 3; i++) await f.runtime.tick()
  f.sessions.get("owner")!.archived = false
  f.runtime.observeArchitectSourceEvent("owner")
  f.runtime.flushSourceInvalidations()
  for (let i = 0; i < 3; i++) await f.runtime.tick()
  const pages: { cursor?: string; known: boolean; unchanged?: boolean }[] = []
  const read = f.host.architectInputPage!.bind(f.host)
  f.host.architectInputPage = async (id, cursor, known) => {
    const page = await read(id, cursor, known)
    pages.push({ ...(cursor ? { cursor } : {}), known: Boolean(known), unchanged: page.unchanged })
    return page
  }
  const journal = () =>
    f.repository.read((db) =>
      db
        .query(
          "SELECT message_id,observed_at,disposition,updated_at FROM runner_architect_inputs WHERE session_id='owner' ORDER BY message_id",
        )
        .all(),
    )
  return { f, pages, journal }
}

test("a reload with an unchanged source is one cheap host read and no page scan", async () => {
  const { f, pages, journal } = await liveSource()
  const before = f.store.architectSource("owner")!
  const entries = journal()
  f.runtime.observeArchitectSourceEvent()
  for (let i = 0; i < 4; i++) await f.runtime.tick()
  expect(pages).toEqual([{ known: true, unchanged: true }])
  const after = f.store.architectSource("owner")!
  expect(after.observation_json).toBe(before.observation_json)
  expect(after.revision).toBe(before.revision)
  expect(after.scan_sweep).toBe(before.scan_sweep)
  expect(journal()).toEqual(entries)
}, 120_000)

test("a source that changed while the plugin was down is scanned and loses no input", async () => {
  const { f, pages, journal } = await liveSource()
  const before = journal()
  // Activity the plugin did not see: a new user message on the Architect session.
  f.sessions.get("owner")!.messages.push({ id: "msg_while_down", text: "steer", type: "user" })
  f.runtime.observeArchitectSourceEvent()
  for (let i = 0; i < 3; i++) await f.runtime.tick()
  expect(pages[0]).toEqual({ known: true, unchanged: undefined })
  const after = journal() as { message_id: string }[]
  expect(after.map((row) => row.message_id)).toContain("msg_while_down")
  // Every earlier input is still there, once.
  for (const row of before as { message_id: string }[])
    expect(after.filter((entry) => entry.message_id === row.message_id)).toHaveLength(1)
  expect(new Set(after.map((row) => row.message_id)).size).toBe(after.length)
  // And the next reload is cheap again.
  const scans = pages.length
  f.runtime.observeArchitectSourceEvent()
  for (let i = 0; i < 3; i++) await f.runtime.tick()
  expect(pages.slice(scans)).toEqual([{ known: true, unchanged: true }])
}, 120_000)

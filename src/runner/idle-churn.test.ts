import { expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import type { TaskRepository } from "../storage.ts"
import { fixture, prepareIdleArchitect, useRuntimeFixtureCleanup } from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

/** Count the read and write transactions of a repository, and which ones changed rows. */
function meterTransactions(repository: TaskRepository) {
  const read = repository.read.bind(repository)
  const atomic = repository.atomic.bind(repository)
  const counts = { reads: 0, atomics: 0, writes: 0 }
  repository.read = ((run: (db: Database) => unknown) => {
    counts.reads++
    return read(run)
  }) as typeof repository.read
  repository.atomic = ((run: (db: Database) => unknown) =>
    atomic((db) => {
      counts.atomics++
      const before = db.query<{ n: number }, []>("SELECT total_changes() n").get()!.n
      const result = run(db)
      if (db.query<{ n: number }, []>("SELECT total_changes() n").get()!.n !== before) {
        counts.writes++
      }
      return result
    })) as typeof repository.atomic
  return {
    counts,
    stop() {
      repository.read = read
      repository.atomic = atomic
    },
  }
}

/** Count only what the host is asked, whatever the call. */
function countHost(host: Record<string, unknown>) {
  const calls: string[] = []
  for (const [name, value] of Object.entries(host)) {
    if (typeof value !== "function") continue
    host[name] = (...args: unknown[]) => {
      calls.push(name)
      return (value as (...a: unknown[]) => unknown).apply(host, args)
    }
  }
  return calls
}

async function idleArchitect() {
  const now = 2_000_000_600_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "idle-churn.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  for (let i = 0; i < 3; i++) await f.runtime.tick()
  // The Architect stays a live, unarchived source with a blocked plan awaiting it.
  f.sessions.get("owner")!.archived = false
  f.runtime.observeArchitectSourceEvent("owner")
  f.runtime.flushSourceInvalidations()
  for (let i = 0; i < 3; i++) await f.runtime.tick()
  expect(f.store.architectSources()).toHaveLength(1)
  return f
}

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test("idle ticks write nothing and read a constant amount, however many run", async () => {
  const f = await idleArchitect()
  const hostCalls = countHost(f.host as unknown as Record<string, unknown>)
  let scanned = 0
  const measure = async (ticks: number) => {
    const meter = meterTransactions(f.repository)
    const before = hostCalls.length
    for (let i = 0; i < ticks; i++) await f.runtime.tick()
    meter.stop()
    scanned += hostCalls.slice(before).filter((name) => name === "architectInputPage").length
    return { ...meter.counts, host: hostCalls.length - before }
  }
  const few = await measure(5)
  const many = await measure(25)
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(`[idle-churn] 5 ticks ${JSON.stringify(few)}; 25 ticks ${JSON.stringify(many)}`)
  expect(few.writes).toBe(0)
  expect(many.writes).toBe(0)
  expect(many.reads).toBe(few.reads * 5)
  expect(many.host).toBe(few.host * 5)
  // Nothing changed, so the source's history is not read again.
  expect(scanned).toBe(0)
}, 120_000)

test("one external event settles: invalidation and its rescan write a bounded amount, then nothing", async () => {
  const f = await idleArchitect()
  f.runtime.observeArchitectSourceEvent("owner")
  const meter = meterTransactions(f.repository)
  const perRound: number[] = []
  for (let round = 0; round < 8; round++) {
    const before = meter.counts.writes
    await f.runtime.tick()
    await turn()
    await turn()
    perRound.push(meter.counts.writes - before)
  }
  meter.stop()
  if (process.env.READ_SWEEP_NUMBERS) console.log(`[idle-churn] writes per round ${perRound}`)
  expect(perRound.slice(3)).toEqual([0, 0, 0, 0, 0])
}, 120_000)

test("an event that cannot change the source journal does not invalidate it", async () => {
  const f = await idleArchitect()
  const meter = meterTransactions(f.repository)
  const revision = f.store.architectSource("owner")!
  f.runtime.observeArchitectSourceEvent("owner", "session.usage.updated")
  f.runtime.observeArchitectSourceEvent("owner", "session.status")
  await turn()
  f.runtime.flushSourceInvalidations()
  meter.stop()
  expect(meter.counts.writes).toBe(0)
  expect(f.store.architectSource("owner")!.scan_complete_at).toBe(revision.scan_complete_at)
}, 120_000)

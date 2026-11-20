import { beforeEach, expect, test } from "bun:test"
import type { LiveRadarResponse, ObservationChange } from "../observability/contract.ts"
import type { RadarMonitorData } from "./monitor-state.ts"
import type { RadarMonitorTransport } from "./monitor-transport.ts"
import { RadarMonitorState } from "./monitor-state.ts"
import { clearKept } from "./kept.ts"

beforeEach(clearKept)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 1_200; index++) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error("Condition was not reached")
}

function live(sequence: number, scope: LiveRadarResponse["scope"] = { kind: "project" }) {
  return {
    schemaVersion: 1,
    projectID: "project",
    scope,
    streamEpoch: "11111111-1111-4111-8111-111111111111",
    observedAt: 1000 + sequence,
    boundary: { runnerRevision: 1, nativeRevision: sequence, eventSequence: sequence },
    freshness: {
      runner: "current",
      nativeInventory: "complete",
      nativeEvents: "connected",
    },
    coverage: {},
    limits: {},
    sessions: [],
    routes: [],
    calls: [],
    flow: [],
  } as unknown as LiveRadarResponse
}

function fakeTransport(
  options: {
    radar?: (count: number, signal: AbortSignal) => Promise<LiveRadarResponse>
  } = {},
) {
  const queued: ObservationChange[] = []
  const waiters: ((change: ObservationChange | undefined) => void)[] = []
  let liveReads = 0
  const transport: RadarMonitorTransport = {
    liveRadar: (_scope, _include, signal) => {
      const count = ++liveReads
      return options.radar ? options.radar(count, signal) : Promise.resolve(live(count))
    },
    changes: (signal) =>
      (async function* () {
        while (!signal.aborted) {
          const change =
            queued.shift() ??
            (await new Promise<ObservationChange | undefined>((resolve) => {
              waiters.push(resolve)
              signal.addEventListener("abort", () => resolve(undefined), { once: true })
            }))
          if (!change || signal.aborted) return
          yield change
        }
      })(),
    online: () => true,
  }
  return {
    transport,
    emit: (sequence: number, resnapshotRequired = false) => {
      const change: ObservationChange = {
        projectID: "project",
        sequence,
        repositoryVersion: 0,
        sourceRevision: 0,
        nativeRevision: sequence,
        cause: "native",
        resnapshotRequired,
      }
      const waiter = waiters.shift()
      if (waiter) waiter(change)
      else queued.push(change)
    },
    liveReads: () => liveReads,
  }
}

const projectScope = { kind: "project" as const, sessionID: "anchor" }

test("live event updates keep the selected session", async () => {
  const changes: unknown[] = []
  const fake = fakeTransport()
  const state = new RadarMonitorState((data) => changes.push(data))
  state.connect("project-key", "project", projectScope, fake.transport, false)
  await until(() => Boolean(state.data.live))
  state.selectSession("ses-worker")
  const retained = state.data.live
  expect(state.data.selectedSessionID).toBe("ses-worker")
  fake.emit(2)
  await until(() => fake.liveReads() >= 2 && state.data.live?.boundary.eventSequence === 2)
  expect(state.data.selectedSessionID).toBe("ses-worker")
  expect(state.data.live).not.toBe(retained)
  expect(changes.length).toBeGreaterThan(3)
  state.close()
})

test("structured failures retain live rows and never coerce error objects", async () => {
  const failure = {
    name: "RPCError",
    data: { reason: "Observation scope is too large", recovery: "narrow" },
  }
  const fake = fakeTransport({
    radar: async (count) => {
      if (count === 1) return live(1)
      throw failure
    },
  })
  const state = new RadarMonitorState(() => {})
  state.connect("project-key", "project", projectScope, fake.transport, false)
  await until(() => Boolean(state.data.live))
  const retained = state.data.live
  fake.emit(2)
  await until(() => state.data.error.includes("Observation scope is too large"))
  expect(state.data.live).toBe(retained)
  expect(state.data.stale).toBe(true)
  expect(state.data.error).toContain("Recovery: narrow.")
  expect(state.data.error).not.toContain("[object Object]")
  state.close()
})

test("scope changes and disposal fence late live results", async () => {
  const oldLive = deferred<LiveRadarResponse>()
  const newLive = deferred<LiveRadarResponse>()
  const fake = fakeTransport({
    radar: (count) => (count === 1 ? oldLive.promise : newLive.promise),
  })
  const published: RadarMonitorData[] = []
  const state = new RadarMonitorState((data) => published.push(data))
  state.connect(
    "session-key",
    "project",
    { kind: "session", sessionID: "ses-old" },
    fake.transport,
    false,
  )
  state.connect("project-key", "project", projectScope, fake.transport, false)
  newLive.resolve(live(2))
  await until(() => state.data.live?.boundary.eventSequence === 2)
  oldLive.resolve(live(1, { kind: "session", sessionID: "ses-old" }))
  await Bun.sleep(5)
  expect(state.data.live?.scope).toEqual({ kind: "project" })

  state.selectSession("ses-old")
  state.close()
  const countAfterClose = published.length
  oldLive.resolve(live(3, { kind: "session", sessionID: "ses-old" }))
  await Bun.sleep(5)
  expect(published).toHaveLength(countAfterClose)
})

test("event gaps are visible and trigger live resynchronization", async () => {
  const fake = fakeTransport()
  const state = new RadarMonitorState(() => {})
  state.connect("project-key", "project", projectScope, fake.transport, false)
  await until(() => Boolean(state.data.live))
  fake.emit(3, true)
  await until(() => fake.liveReads() > 1)
  expect(state.data.error).not.toContain("[object Object]")
  expect(state.data.live?.boundary.eventSequence).toBeGreaterThanOrEqual(1)
  state.close()
})

test.each([false, true])(
  "routine updates stay connected while a real gap stays visible: gap=%s",
  async (gap) => {
    const pending = deferred<LiveRadarResponse>()
    const catchup = deferred<LiveRadarResponse>()
    const fake = fakeTransport({
      radar: (count) =>
        count === 1 ? Promise.resolve(live(1)) : count === 2 ? pending.promise : catchup.promise,
    })
    const state = new RadarMonitorState(() => {})
    state.connect("project-key", "project", projectScope, fake.transport, false)
    try {
      await until(() => Boolean(state.data.live))
      expect(state.data.stale).toBe(false)
      fake.emit(gap ? 3 : 2, gap)
      await until(() => fake.liveReads() === 2)
      expect(state.data.stale).toBe(gap)
      fake.emit(gap ? 4 : 3)
      await Bun.sleep(1)
      expect(state.data.stale).toBe(gap)
      pending.resolve(live(gap ? 3 : 2))
      await until(() => fake.liveReads() === 3)
      expect(state.data.stale).toBe(gap)
      expect(state.data.resynchronizing).toBe(gap)
      catchup.resolve(live(gap ? 4 : 3))
      await until(() => state.data.live?.boundary.eventSequence === (gap ? 4 : 3))
      expect(state.data.stale).toBe(false)
      expect(state.data.resynchronizing).toBe(false)
    } finally {
      state.close()
    }
  },
)

test("a re-mounted panel renders the kept snapshot at once and refreshes in place", async () => {
  const first = fakeTransport()
  const one = new RadarMonitorState(() => {})
  one.connect("kept-key", "project", projectScope, first.transport, false)
  await until(() => Boolean(one.data.live))
  const shown = one.data.live
  one.close()

  const gate = deferred<LiveRadarResponse>()
  const second = fakeTransport({ radar: () => gate.promise })
  const updates: RadarMonitorData[] = []
  const two = new RadarMonitorState((data) => updates.push(data))
  two.connect("kept-key", "project", projectScope, second.transport, false)
  // Before the new read answers: content is there, nothing is loading, no reconnect banner state.
  expect(two.data.live).toBe(shown)
  expect(two.data.loading).toBe(false)
  expect(two.data.connection).toBe("connected")
  expect(updates.at(-1)?.live).toBe(shown)
  gate.resolve(live(9))
  await until(() => two.data.live?.boundary.eventSequence === 9)
  two.close()
})

test("the skeleton belongs to a first load: another scope key starts empty", async () => {
  const fake = fakeTransport()
  const one = new RadarMonitorState(() => {})
  one.connect("scope-a", "project", projectScope, fake.transport, false)
  await until(() => Boolean(one.data.live))
  one.close()
  const two = new RadarMonitorState(() => {})
  two.connect("scope-b", "project", projectScope, fakeTransport().transport, false)
  expect(two.data.live).toBeUndefined()
  expect(two.data.loading).toBe(true)
  two.close()
})

test("a burst of events becomes a few spaced reads, and an idle view reads nothing", async () => {
  let latest = 1
  const fake = fakeTransport({
    radar: () => Promise.resolve(live(latest)),
  })
  const state = new RadarMonitorState(() => {})
  state.connect("project-key", "project", projectScope, fake.transport, false)
  try {
    await until(() => Boolean(state.data.live))
    const idleBase = fake.liveReads()
    await Bun.sleep(1_200)
    // No polling: with no events there are no reads.
    expect(fake.liveReads()).toBe(idleBase)
    // 100 events over one second would have been up to 100 back-to-back reads.
    const started = fake.liveReads()
    for (let i = 0; i < 50; i++) {
      latest++
      fake.emit(latest)
      await Bun.sleep(20)
    }
    await Bun.sleep(600)
    const reads = fake.liveReads() - started
    console.info("MONITOR-READS-PER-50-EVENTS-IN-1S", reads)
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(6)
  } finally {
    state.close()
  }
})

import { beforeEach, expect, test } from "bun:test"
import type {
  LiveHistoryResponse,
  LiveRadarResponse,
  ObservationChange,
} from "../observability/contract.ts"
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
  for (let index = 0; index < 100; index++) {
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

function history(sessionID: string, sequences: number[], nextCursor: string | null = null) {
  return {
    schemaVersion: 1,
    projectID: "project",
    scope: { kind: "project" },
    sessionID,
    attemptID: "22222222-2222-4222-8222-222222222222",
    source: "runner-progress",
    runnerRevision: 1,
    capturedAt: Date.now(),
    items: sequences.map((sequence) => ({
      sequence,
      at: sequence,
      recordedAt: sequence,
      kind: "worker-tool",
      source: "native-event",
      messageID: "message",
      callID: `call-${sequence}`,
      tool: "read",
      status: "succeeded",
      agent: null,
      result: null,
      error: null,
      route: null,
      observations: [],
      payloadAvailable: true,
    })),
    nextCursor,
    limits: {},
    coverage: { hasMore: nextCursor !== null, payloadTruncated: false, journal: "available" },
  } as unknown as LiveHistoryResponse
}

function fakeTransport(
  options: {
    radar?: (count: number, signal: AbortSignal) => Promise<LiveRadarResponse>
    history?: (
      sessionID: string,
      cursor?: string,
      signal?: AbortSignal,
    ) => Promise<LiveHistoryResponse>
  } = {},
) {
  const queued: ObservationChange[] = []
  const waiters: ((change: ObservationChange | undefined) => void)[] = []
  let liveReads = 0
  let historyReads = 0
  const transport: RadarMonitorTransport = {
    liveRadar: (_scope, _include, signal) => {
      const count = ++liveReads
      return options.radar ? options.radar(count, signal) : Promise.resolve(live(count))
    },
    liveHistory: (scope, sessionID, cursor, signal) => {
      historyReads++
      return (
        options.history?.(sessionID, cursor, signal) ?? Promise.resolve(history(sessionID, [2, 1]))
      )
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
    historyReads: () => historyReads,
  }
}

const projectScope = { kind: "project" as const, sessionID: "anchor" }

test("live event updates preserve session identity and separately paged history", async () => {
  const changes: unknown[] = []
  const fake = fakeTransport({
    history: async (sessionID, cursor) =>
      cursor ? history(sessionID, [1]) : history(sessionID, [3, 2], "next-page"),
  })
  const state = new RadarMonitorState((data) => changes.push(data))
  state.connect("project-key", "project", projectScope, fake.transport, false)
  await until(() => Boolean(state.data.live))
  state.selectSession("ses-worker")
  await until(() => Boolean(state.data.history))
  const retained = state.data.live
  expect(state.data.history?.items.map((item) => item.sequence)).toEqual([3, 2])
  fake.emit(2)
  await until(() => fake.liveReads() >= 2 && state.data.live?.boundary.eventSequence === 2)
  expect(state.data.selectedSessionID).toBe("ses-worker")
  expect(state.data.history?.items.map((item) => item.sequence)).toEqual([3, 2])
  state.loadMoreHistory()
  await until(() => fake.historyReads() >= 3 && state.data.history?.items.length === 3)
  expect(state.data.history?.items.map((item) => item.sequence)).toEqual([3, 2, 1])
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

test("scope changes and disposal fence late live and selected-history results", async () => {
  const oldLive = deferred<LiveRadarResponse>()
  const newLive = deferred<LiveRadarResponse>()
  const oldHistory = deferred<LiveHistoryResponse>()
  const fake = fakeTransport({
    radar: (count) => (count === 1 ? oldLive.promise : newLive.promise),
    history: () => oldHistory.promise,
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
  oldHistory.resolve(history("ses-old", [1]))
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

const sequences = (data: RadarMonitorData) => data.history?.items.map((item) => item.sequence)

test("live head refresh merges by sequence without cancelling or rewinding the older-page drain", async () => {
  const older = deferred<LiveHistoryResponse>()
  const cursors: (string | undefined)[] = []
  let tailSignal: AbortSignal | undefined
  let heads = 0
  const fake = fakeTransport({
    history: (sessionID, cursor, signal) => {
      cursors.push(cursor)
      if (cursor === "before-20") {
        tailSignal = signal
        return older.promise
      }
      heads++
      if (heads > 1) return Promise.resolve(history(sessionID, [40, 30], "fresh-before-30"))
      const first = history(sessionID, [30, 20], "before-20")
      first.items[0] = { ...first.items[0]!, status: "running" }
      return Promise.resolve(first)
    },
  })
  const state = new RadarMonitorState(() => {})
  state.connect("project-key", "project", projectScope, fake.transport, false)
  try {
    await until(() => Boolean(state.data.live))
    state.selectSession("ses-worker")
    await until(() => state.data.history?.items.length === 2)

    state.loadMoreHistory()
    await until(() => tailSignal !== undefined)
    expect(state.data.historyLoading).toBe(true)

    // A live event re-reads the newest page while the older page is still in flight.
    fake.emit(2)
    await until(() => state.data.history?.items[0]?.sequence === 40)
    expect(tailSignal!.aborted).toBe(false)
    expect(sequences(state.data)).toEqual([40, 30, 20])
    expect(state.data.history?.items.find((item) => item.sequence === 30)?.status).toBe("succeeded")
    expect(state.data.history?.nextCursor).toBe("before-20")
    expect(state.data.history?.coverage.hasMore).toBe(true)
    expect(state.data.historyLoading).toBe(true)

    const tail = history("ses-worker", [10], null)
    tail.coverage.payloadTruncated = true
    older.resolve(tail)
    await until(() => state.data.history?.items.length === 4)
    expect(sequences(state.data)).toEqual([40, 30, 20, 10])
    expect(state.data.history?.nextCursor).toBeNull()
    expect(state.data.history?.coverage).toMatchObject({ hasMore: false, payloadTruncated: true })
    expect(state.data.historyLoading).toBe(false)

    // A later head page must not resurrect a cursor or hide the truncated older page.
    const exhausted = state.data.history
    fake.emit(3)
    await until(() => state.data.history !== exhausted)
    expect(state.data.history?.nextCursor).toBeNull()
    expect(state.data.history?.coverage).toMatchObject({ hasMore: false, payloadTruncated: true })
    state.loadMoreHistory()
    await Bun.sleep(2)
    expect(cursors.filter((cursor) => cursor !== undefined)).toEqual(["before-20"])
  } finally {
    state.close()
  }
})

test("a moved journal restarts the older-page read from a fresh head past loaded rows", async () => {
  const cursors: (string | undefined)[] = []
  let heads = 0
  const fake = fakeTransport({
    history: async (sessionID, cursor) => {
      cursors.push(cursor)
      if (cursor === "before-20")
        throw {
          name: "RPCError",
          data: { reason: "changed-during-read", recovery: "restart" },
        }
      if (cursor === "fresh-before-40") return history(sessionID, [30, 20], "fresh-before-20")
      if (cursor === "fresh-before-20") return history(sessionID, [10], null)
      heads++
      return heads === 1
        ? history(sessionID, [30, 20], "before-20")
        : history(sessionID, [50, 40], "fresh-before-40")
    },
  })
  const state = new RadarMonitorState(() => {})
  state.connect("project-key", "project", projectScope, fake.transport, false)
  try {
    await until(() => Boolean(state.data.live))
    state.selectSession("ses-worker")
    await until(() => state.data.history?.items.length === 2)
    state.loadMoreHistory()
    await until(() => state.data.history?.nextCursor === null)
    expect(sequences(state.data)).toEqual([50, 40, 30, 20, 10])
    expect(state.data.historyError).toBe("")
    expect(cursors).toEqual([
      undefined,
      "before-20",
      undefined,
      "fresh-before-40",
      "fresh-before-20",
    ])
  } finally {
    state.close()
  }
})

test("a non-contiguous head and a selection change fence stale older pages", async () => {
  const olderA = deferred<LiveHistoryResponse>()
  const olderB = deferred<LiveHistoryResponse>()
  const tailSignals: AbortSignal[] = []
  let heads = 0
  const fake = fakeTransport({
    history: (sessionID, cursor, signal) => {
      if (cursor) {
        tailSignals.push(signal!)
        return tailSignals.length === 1 ? olderA.promise : olderB.promise
      }
      if (sessionID === "ses-other") return Promise.resolve(history(sessionID, [7]))
      heads++
      return Promise.resolve(
        heads === 1
          ? history(sessionID, [30, 20], "before-20")
          : history(sessionID, [90, 80], "before-80"),
      )
    },
  })
  const state = new RadarMonitorState(() => {})
  state.connect("project-key", "project", projectScope, fake.transport, false)
  try {
    await until(() => Boolean(state.data.live))
    state.selectSession("ses-worker")
    await until(() => state.data.history?.items.length === 2)

    // More new rows than one page: the gap is not hidden behind the old cursor.
    state.loadMoreHistory()
    await until(() => tailSignals.length === 1)
    fake.emit(2)
    await until(() => state.data.history?.items[0]?.sequence === 90)
    expect(tailSignals[0]!.aborted).toBe(true)
    expect(sequences(state.data)).toEqual([90, 80])
    expect(state.data.history?.nextCursor).toBe("before-80")
    expect(state.data.historyLoading).toBe(false)
    olderA.resolve(history("ses-worker", [10], null))
    await Bun.sleep(2)
    expect(sequences(state.data)).toEqual([90, 80])

    // A late older page for the previous selection never lands in the new selection.
    state.loadMoreHistory()
    await until(() => tailSignals.length === 2)
    state.selectSession("ses-other")
    await until(() => state.data.history?.sessionID === "ses-other")
    expect(tailSignals[1]!.aborted).toBe(true)
    olderB.resolve(history("ses-worker", [10], null))
    await Bun.sleep(2)
    expect(state.data.selectedSessionID).toBe("ses-other")
    expect(sequences(state.data)).toEqual([7])
    expect(state.data.historyLoading).toBe(false)
  } finally {
    state.close()
  }
})

test("a stale restart head cannot overwrite a newer live head", async () => {
  const delayedRestart = deferred<LiveHistoryResponse>()
  let heads = 0
  const fake = fakeTransport({
    history: async (sessionID, cursor) => {
      if (cursor === "old-before-20")
        throw { data: { reason: "changed-during-read", recovery: "restart" } }
      if (cursor === "restart-before-20") return history(sessionID, [10])
      if (++heads === 2) return delayedRestart.promise
      return history(sessionID, heads === 1 ? [30, 20] : [40, 30], "old-before-20")
    },
  })
  const state = new RadarMonitorState(() => {})
  state.connect("project-key", "project", projectScope, fake.transport, false)
  try {
    await until(() => Boolean(state.data.live))
    state.selectSession("ses-worker")
    await until(() => state.data.history?.items.length === 2)
    state.loadMoreHistory()
    await until(() => heads === 2)
    fake.emit(2)
    await until(() => state.data.history?.items[0]?.sequence === 40)
    const stale = history("ses-worker", [30, 20], "restart-before-20")
    stale.items[0] = { ...stale.items[0]!, status: "running" }
    delayedRestart.resolve(stale)
    await until(() => state.data.history?.nextCursor === null)
    expect(state.data.history?.items.find((item) => item.sequence === 30)?.status).toBe("succeeded")
  } finally {
    state.close()
  }
})

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

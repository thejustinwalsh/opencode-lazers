import { expect, test } from "bun:test"
import type {
  LiveHistoryResponse,
  LiveRadarResponse,
  ObservationChange,
} from "../observability/contract.ts"
import type { RadarMonitorData } from "./monitor-state.ts"
import type { RadarMonitorTransport } from "./monitor-transport.ts"
import { RadarMonitorState } from "./monitor-state.ts"

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
    coverage: { hasMore: nextCursor !== null },
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

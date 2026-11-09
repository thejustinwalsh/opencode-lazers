import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "../observability/changes.ts"
import type {
  ObservationChange,
  ObservationScope,
  RadarResponse,
  SnapshotResponse,
} from "../observability/contract.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { operationalReads } from "../../test/radar/operational.ts"
import { RadarPanelState } from "./state.ts"
import { RadarPulseTracker } from "./pulse.ts"
import type { RadarMapEdge } from "./map-model.ts"
import type { RadarTransport } from "./transport.ts"

type QueueItem<T> = { value: T; done: false } | { value: undefined; done: true }

class EventQueue<T> {
  private values: T[] = []
  private waiters: Array<(result: QueueItem<T>) => void> = []
  private closed = false

  push(value: T) {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  close() {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  next(signal: AbortSignal): Promise<QueueItem<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.closed || signal.aborted) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", done)
        const index = this.waiters.indexOf(onValue)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve({ value: undefined, done: true })
      }
      const onValue = (item: QueueItem<T>) => {
        signal.removeEventListener("abort", done)
        resolve(item)
      }
      this.waiters.push(onValue)
      signal.addEventListener("abort", done, { once: true })
    })
  }
}

async function* changesFrom<T>(queue: EventQueue<T>, signal: AbortSignal): AsyncIterable<T> {
  while (!signal.aborted) {
    const item = await queue.next(signal)
    if (item.done) return
    yield item.value
  }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Condition was not reached")
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function snapshots() {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(5)
  const reads = operationalReads(fixture, "project", secret)
  const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
  tracker.initialize()
  return {
    fixture,
    session: reads.snapshot({ kind: "session", sessionID: "ses-failed" }, tracker),
    project: reads.snapshot({ kind: "project", sessionID: "ses-failed" }, tracker),
    sessionRadar: reads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    ),
    projectRadar: reads.radar(
      { scope: { kind: "project", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    ),
  }
}

test("F-S14-1 Radar read errors preserve the readable RPC envelope message", async () => {
  const message = "Observation scope is too large; narrow it"
  const queue = new EventQueue<ObservationChange>()
  const fail = async () => {
    throw { type: "observation_error", data: { message } }
  }
  const state = new RadarPanelState(() => {})
  try {
    state.connect(
      "rpc-error",
      "project",
      { kind: "project", sessionID: "ses-reader" },
      {
        snapshot: fail,
        radar: fail,
        changes: (signal) => changesFrom(queue, signal),
        online: () => true,
      },
    )
    await until(() => Boolean(state.data.error))
    // F-S14-1: a rejected RPC must retain its actionable message in the alert.
    expect(state.data.error).not.toContain("[object Object]")
    expect(state.data.error).toContain(message)
  } finally {
    state.close()
    queue.close()
  }
})

test("an idle event subscription performs no repeated projections and changes still refresh", async () => {
  const { fixture, session, sessionRadar } = snapshots()
  const radar = await sessionRadar
  const queue = new EventQueue<ObservationChange>()
  let snapshotCalls = 0,
    radarCalls = 0
  let sequence = session.boundary.eventSequence
  const transport: RadarTransport = {
    snapshot: async () => {
      snapshotCalls++
      return { ...session, boundary: { ...session.boundary, eventSequence: sequence } }
    },
    radar: async () => {
      radarCalls++
      return { ...radar, boundary: { ...radar.boundary, eventSequence: sequence } }
    },
    changes: (signal) => changesFrom(queue, signal),
    online: () => true,
  }
  const state = new RadarPanelState(() => {})
  try {
    state.connect(
      "session-view",
      "project",
      { kind: "session", sessionID: "ses-failed" },
      transport,
    )
    await until(() => Boolean(state.data.radar) && !state.data.stale)
    await Bun.sleep(3_100)
    expect({ snapshotCalls, radarCalls }).toEqual({ snapshotCalls: 1, radarCalls: 1 })
    sequence++
    queue.push({
      projectID: "project",
      sequence,
      repositoryVersion: session.boundary.repositoryVersion,
      sourceRevision: session.boundary.sourceRevision,
      nativeRevision: session.boundary.nativeRevision,
      cause: "native",
      resnapshotRequired: false,
    })
    await until(() => state.data.snapshot?.boundary.eventSequence === sequence && !state.data.stale)
    expect({ snapshotCalls, radarCalls }).toEqual({ snapshotCalls: 2, radarCalls: 2 })
  } finally {
    state.close()
    fixture.close()
  }
})

test("late session responses cannot replace a switched project observation", async () => {
  const { fixture, session, project, sessionRadar, projectRadar } = snapshots()
  try {
    const [sessionData, projectData] = await Promise.all([sessionRadar, projectRadar])
    const first = deferred<SnapshotResponse>()
    const firstRadar = deferred<RadarResponse>()
    const queue = new EventQueue<ObservationChange>()
    const late: RadarTransport = {
      snapshot: () => first.promise,
      radar: () => firstRadar.promise,
      changes: (signal) => changesFrom(queue, signal),
      online: () => true,
    }
    const current: RadarTransport = {
      snapshot: async () => project,
      radar: async () => projectData,
      changes: (signal) => changesFrom(queue, signal),
      online: () => true,
    }
    const state = new RadarPanelState(
      () => {},
      async () => {},
    )
    state.connect("session-view", "project", { kind: "session", sessionID: "ses-failed" }, late)
    state.connect("project-view", "project", { kind: "project", sessionID: "ses-failed" }, current)
    await until(() => state.data.radar?.scope.kind === "project")
    first.resolve(session)
    firstRadar.resolve(sessionData)
    await new Promise((resolve) => setTimeout(resolve, 2))
    expect(state.data.key).toBe("project-view")
    expect(state.data.snapshot?.scope).toEqual({ kind: "project" })
    expect(state.data.snapshot?.plans).toEqual(project.plans)
    expect(state.data.radar?.scope.kind).toBe("project")
    state.close()
  } finally {
    fixture.close()
  }
})

test("duplicates are ignored, event gaps invalidate, and a closed stream reconnects by resnapshot", async () => {
  const { fixture, session, sessionRadar } = snapshots()
  try {
    const radar = await sessionRadar
    const queues = [new EventQueue<ObservationChange>(), new EventQueue<ObservationChange>()]
    let streamCalls = 0
    let snapshotCalls = 0
    let deferRefresh = false
    let deferredReadsCompleted = 0
    let reconnectWaits = 0
    const refreshGate = deferred<void>()
    const reconnectGate = deferred<void>()
    const updates: { stale: boolean; error: string }[] = []
    const pulses: string[] = []
    const pulseTracker = new RadarPulseTracker()
    let eventSequence = session.boundary.eventSequence
    const transport: RadarTransport = {
      snapshot: async () => {
        snapshotCalls++
        const result = {
          ...session,
          boundary: { ...session.boundary, eventSequence },
        }
        if (deferRefresh) {
          await refreshGate.promise
          deferredReadsCompleted++
        }
        return result
      },
      radar: async (_scope, _includeUnmanaged, _signal) => {
        const result = { ...radar, boundary: { ...radar.boundary, eventSequence } }
        if (deferRefresh) {
          await refreshGate.promise
          deferredReadsCompleted++
        }
        return result
      },
      changes: (signal) => {
        const queue = queues[Math.min(streamCalls++, queues.length - 1)]!
        return changesFrom(queue, signal)
      },
      online: () => true,
    }
    const state = new RadarPanelState(
      (data) => {
        updates.push({ stale: data.stale, error: data.error })
        if (!data.radar) return
        const edge: RadarMapEdge = {
          id: "outcome",
          kind: "outcome",
          from: "worker",
          to: "runner",
          status: "succeeded",
          records: [],
          evidence: [],
          routeRecords: [],
          related: [],
          pulseEventIDs: [`event-${data.radar.boundary.eventSequence}`],
        }
        pulses.push(
          ...pulseTracker
            .update([edge], data.resynchronizing ?? data.stale, true)
            .map((pulse) => pulse.eventID),
        )
      },
      async () => {
        reconnectWaits++
        await reconnectGate.promise
      },
    )
    state.connect(
      "session-view",
      "project",
      { kind: "session", sessionID: "ses-failed" },
      transport,
    )
    await until(
      () => Boolean(state.data.radar) && Boolean(state.data.snapshot) && !state.data.stale,
    )
    expect(snapshotCalls).toBe(1)

    const emit = (sequence: number, resnapshotRequired = false) => {
      const queue = queues[Math.min(streamCalls - 1, queues.length - 1)]!
      eventSequence = sequence
      queue.push({
        projectID: "project",
        sequence,
        repositoryVersion: session.boundary.repositoryVersion,
        sourceRevision: session.boundary.sourceRevision,
        nativeRevision: session.boundary.nativeRevision,
        cause: "runner",
        resnapshotRequired,
      })
    }
    const next = eventSequence + 1
    const beforeUpdate = updates.length
    emit(next)
    await until(() => state.data.snapshot?.boundary.eventSequence === next && !state.data.stale)
    expect(snapshotCalls).toBe(2)
    expect(updates.slice(beforeUpdate)).toContainEqual({ stale: true, error: "" })
    expect(pulses).toEqual([`event-${next}`])

    emit(next)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(snapshotCalls).toBe(2)
    expect(pulses).toEqual([`event-${next}`])

    const gap = next + 2
    const beforeGap = updates.length
    emit(gap, true)
    await until(() => state.data.snapshot?.boundary.eventSequence === gap && !state.data.stale)
    expect(snapshotCalls).toBe(3)
    expect(updates.slice(beforeGap)).toContainEqual({
      stale: true,
      error: "Observation gap; refreshing the snapshot.",
    })

    expect(pulses).toEqual([`event-${next}`])
    emit(gap + 1)
    await until(() => state.data.snapshot?.boundary.eventSequence === gap + 1 && !state.data.stale)
    expect(pulses).toEqual([`event-${next}`, `event-${gap + 1}`])

    deferRefresh = true
    state.refreshNow()
    await until(() => snapshotCalls === 5)
    queues[0]!.close()
    await until(() => reconnectWaits === 1)
    expect(state.data.resynchronizing).toBe(true)
    deferRefresh = false
    refreshGate.resolve(undefined)
    await until(() => deferredReadsCompleted === 2)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.data.stale).toBe(true)
    expect(state.data.resynchronizing).toBe(true)
    state.refreshNow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(snapshotCalls).toBe(5)

    eventSequence = gap + 2 // missed activity while the stream was disconnected
    reconnectGate.resolve(undefined)
    await until(() => streamCalls >= 2 && snapshotCalls >= 6 && !state.data.stale)
    expect(state.data.snapshot?.boundary.eventSequence).toBe(gap + 2)
    expect(pulses).toEqual([`event-${next}`, `event-${gap + 1}`])
    emit(gap + 3)
    await until(() => state.data.snapshot?.boundary.eventSequence === gap + 3 && !state.data.stale)
    expect(pulses).toEqual([`event-${next}`, `event-${gap + 1}`, `event-${gap + 3}`])
    state.close()
  } finally {
    fixture.close()
  }
})

test("a gap catch-up remains a quiet baseline until Radar covers the recovery sequence", async () => {
  const { fixture, session, sessionRadar } = snapshots()
  let state: RadarPanelState | undefined
  try {
    const radar = await sessionRadar
    const queue = new EventQueue<ObservationChange>()
    const base = radar.boundary.eventSequence
    const gap = base + 3
    const delayedRadar = deferred<void>()
    const delayedCatchup = deferred<void>()
    let radarCalls = 0
    let snapshotCalls = 0
    const sequenceFor = (index: number) =>
      index === 0 ? base : index === 1 ? base + 1 : index === 2 ? gap : gap + 1
    const waitForRead = async (index: number) => {
      if (index === 1) await delayedRadar.promise
      if (index === 2) await delayedCatchup.promise
    }
    const transport: RadarTransport = {
      snapshot: async () => {
        const index = snapshotCalls++
        const eventSequence = sequenceFor(index)
        await waitForRead(index)
        return { ...session, boundary: { ...session.boundary, eventSequence } }
      },
      radar: async () => {
        const index = radarCalls++
        const eventSequence = sequenceFor(index)
        await waitForRead(index)
        return { ...radar, boundary: { ...radar.boundary, eventSequence } }
      },
      changes: (signal) => changesFrom(queue, signal),
      online: () => true,
    }
    const pulses: string[] = []
    const pulseTracker = new RadarPulseTracker()
    state = new RadarPanelState(
      (data) => {
        if (!data.radar) return
        const edge: RadarMapEdge = {
          id: "outcome",
          kind: "outcome",
          from: "worker",
          to: "runner",
          status: "succeeded",
          records: [],
          evidence: [],
          routeRecords: [],
          related: [],
          pulseEventIDs: [`event-${data.radar.boundary.eventSequence}`],
        }
        pulses.push(
          ...pulseTracker.update([edge], data.resynchronizing, true).map((pulse) => pulse.eventID),
        )
      },
      async () => {},
    )
    state.connect(
      "session-view",
      "project",
      { kind: "session", sessionID: "ses-failed" },
      transport,
    )
    await until(() => state!.data.radar?.boundary.eventSequence === base && !state!.data.stale)
    expect(state.data.resynchronizing).toBe(false)

    queue.push({
      projectID: "project",
      sequence: gap,
      repositoryVersion: session.boundary.repositoryVersion,
      sourceRevision: session.boundary.sourceRevision,
      nativeRevision: session.boundary.nativeRevision,
      cause: "gap",
      resnapshotRequired: true,
    })
    await until(() => radarCalls === 2 && snapshotCalls === 2)
    delayedRadar.resolve(undefined)
    await until(
      () =>
        radarCalls >= 3 &&
        snapshotCalls >= 3 &&
        state!.data.radar?.boundary.eventSequence === base + 1 &&
        state!.data.resynchronizing,
    )
    expect(pulses).toEqual([])

    delayedCatchup.resolve(undefined)
    await until(
      () =>
        state!.data.radar?.boundary.eventSequence === gap &&
        !state!.data.stale &&
        state!.data.resynchronizing,
    )
    expect(pulses).toEqual([])

    queue.push({
      projectID: "project",
      sequence: gap + 1,
      repositoryVersion: session.boundary.repositoryVersion,
      sourceRevision: session.boundary.sourceRevision,
      nativeRevision: session.boundary.nativeRevision,
      cause: "runner",
      resnapshotRequired: false,
    })
    await until(
      () =>
        state!.data.radar?.boundary.eventSequence === gap + 1 &&
        !state!.data.stale &&
        !state!.data.resynchronizing,
    )
    expect(pulses).toEqual([`event-${gap + 1}`])
  } finally {
    state?.close()
    fixture.close()
  }
})

test("lifecycle advancement revokes a previously ready quiet Radar baseline", async () => {
  const { fixture, session, sessionRadar } = snapshots()
  let state: RadarPanelState | undefined
  try {
    const radar = await sessionRadar
    const queue = new EventQueue<ObservationChange>()
    const base = radar.boundary.eventSequence
    let sequence = base
    let lifecycleAhead = false
    let snapshotCalls = 0
    const pulses: string[] = []
    const tracker = new RadarPulseTracker()
    const transport: RadarTransport = {
      snapshot: async () => {
        snapshotCalls++
        return {
          ...session,
          boundary: { ...session.boundary, eventSequence: sequence + (lifecycleAhead ? 1 : 0) },
        }
      },
      radar: async () => ({ ...radar, boundary: { ...radar.boundary, eventSequence: sequence } }),
      changes: (signal) => changesFrom(queue, signal),
      online: () => true,
    }
    state = new RadarPanelState(
      (data) => {
        if (!data.radar) return
        const edge: RadarMapEdge = {
          id: "outcome",
          kind: "outcome",
          from: "worker",
          to: "runner",
          status: "succeeded",
          records: [],
          evidence: [],
          routeRecords: [],
          related: [],
          pulseEventIDs: [`event-${data.radar.boundary.eventSequence}`],
        }
        pulses.push(
          ...tracker.update([edge], data.resynchronizing, true).map((pulse) => pulse.eventID),
        )
      },
      async () => {},
    )
    state.connect(
      "session-view",
      "project",
      { kind: "session", sessionID: "ses-failed" },
      transport,
    )
    await until(() => Boolean(state?.data.radar) && !state!.data.stale)
    const emit = (next: number, gap: boolean) => {
      sequence = next
      queue.push({
        projectID: "project",
        sequence,
        repositoryVersion: session.boundary.repositoryVersion,
        sourceRevision: session.boundary.sourceRevision,
        nativeRevision: session.boundary.nativeRevision,
        cause: gap ? "gap" : "runner",
        resnapshotRequired: gap,
      })
    }
    emit(base + 3, true)
    await until(() => state!.data.radar?.boundary.eventSequence === base + 3 && !state!.data.stale)
    expect(state.data.resynchronizing).toBe(true)
    lifecycleAhead = true
    state.refreshNow()
    await until(() => snapshotCalls >= 3 && state!.data.stale && Boolean(state!.data.error))
    lifecycleAhead = false
    emit(base + 5, false)
    await until(() => state!.data.radar?.boundary.eventSequence === base + 5 && !state!.data.stale)
    expect(state.data.resynchronizing).toBe(true)
    expect(pulses).toEqual([])
    emit(base + 6, false)
    await until(() => state!.data.radar?.boundary.eventSequence === base + 6 && !state!.data.stale)
    expect(state.data.resynchronizing).toBe(false)
    expect(pulses).toEqual([`event-${base + 6}`])
  } finally {
    state?.close()
    fixture.close()
  }
})

test("wrong-project and wrong-scope snapshot responses remain unavailable", async () => {
  const { fixture, session, project, sessionRadar, projectRadar } = snapshots()
  try {
    const [radarSession, radarProject] = await Promise.all([sessionRadar, projectRadar])
    const queue = new EventQueue<ObservationChange>()
    for (const [wrong, scope, message] of [
      [
        { ...radarSession, projectID: "other-project" },
        { kind: "session", sessionID: "ses-failed" },
        "another project",
      ],
      [radarProject, { kind: "session", sessionID: "ses-failed" }, "another scope"],
    ] as const) {
      const state = new RadarPanelState(
        () => {},
        async () => {},
      )
      const transport: RadarTransport = {
        snapshot: async () => (wrong === radarProject ? project : session),
        radar: async () => wrong,
        changes: (signal) => changesFrom(queue, signal),
        online: () => true,
      }
      const target = scope as ObservationScope
      state.connect("wrong", "project", target, transport)
      await until(() => Boolean(state.data.error))
      expect(state.data.radar).toBeUndefined()
      expect(state.data.error).toContain(message)
      state.close()
    }
  } finally {
    fixture.close()
  }
})

test("independently publishes changing Radar and lifecycle reads without claiming a coherent boundary", async () => {
  const { fixture, session, sessionRadar } = snapshots()
  try {
    const radar = await sessionRadar
    const queue = new EventQueue<ObservationChange>()
    let radarCalls = 0
    let snapshotCalls = 0
    let aligned = false
    const alignedSequence = radar.boundary.eventSequence + 4
    const transport: RadarTransport = {
      snapshot: async () => {
        snapshotCalls++
        const eventSequence = aligned
          ? alignedSequence
          : session.boundary.eventSequence + snapshotCalls - 1
        return { ...session, boundary: { ...session.boundary, eventSequence } }
      },
      radar: async () => {
        radarCalls++
        const eventSequence = aligned ? alignedSequence : radar.boundary.eventSequence + radarCalls
        return {
          ...radar,
          boundary: { ...radar.boundary, eventSequence },
        }
      },
      changes: (signal) => changesFrom(queue, signal),
      online: () => true,
    }
    const state = new RadarPanelState(
      () => {},
      async () => {},
    )
    state.connect(
      "session-view",
      "project",
      { kind: "session", sessionID: "ses-failed" },
      transport,
    )
    await until(
      () =>
        radarCalls === 3 &&
        state.data.radar?.boundary.eventSequence === alignedSequence - 1 &&
        state.data.snapshot?.boundary.eventSequence === alignedSequence - 2,
    )
    expect(snapshotCalls).toBe(3)
    expect(state.data.radar?.boundary.eventSequence).toBe(alignedSequence - 1)
    expect(state.data.snapshot?.boundary.eventSequence).toBe(alignedSequence - 2)
    expect(state.data.stale).toBe(true)
    expect(state.data.resynchronizing).toBe(false)
    expect(state.data.error).toContain("different read boundaries")

    aligned = true
    state.refreshNow()
    await until(
      () =>
        state.data.radar?.boundary.eventSequence === alignedSequence &&
        state.data.snapshot?.boundary.eventSequence === alignedSequence &&
        !state.data.stale,
    )
    expect(state.data.error).toBe("")
    state.close()
  } finally {
    fixture.close()
  }
})

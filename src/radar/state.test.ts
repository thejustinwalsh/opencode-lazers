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
    const updates: { stale: boolean; error: string }[] = []
    const pulses: string[] = []
    const pulseTracker = new RadarPulseTracker()
    let eventSequence = session.boundary.eventSequence
    const transport: RadarTransport = {
      snapshot: async () => {
        snapshotCalls++
        return {
          ...session,
          boundary: { ...session.boundary, eventSequence },
        }
      },
      radar: async (_scope, _includeUnmanaged, _signal) => ({
        ...radar,
        boundary: { ...radar.boundary, eventSequence },
      }),
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
      async () => {},
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

    queues[0]!.close()
    await until(() => streamCalls >= 2 && snapshotCalls >= 5 && !state.data.stale)
    expect(state.data.snapshot?.boundary.eventSequence).toBe(gap + 1)
    expect(pulses).toEqual([`event-${next}`, `event-${gap + 1}`])
    emit(gap + 2)
    await until(() => state.data.snapshot?.boundary.eventSequence === gap + 2 && !state.data.stale)
    expect(pulses).toEqual([`event-${next}`, `event-${gap + 1}`, `event-${gap + 2}`])
    state.close()
  } finally {
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

test("operational and lifecycle snapshots do not publish mixed repository revisions", async () => {
  const { fixture, session, sessionRadar } = snapshots()
  try {
    const radar = await sessionRadar
    const queue = new EventQueue<ObservationChange>()
    let calls = 0
    const transport: RadarTransport = {
      snapshot: async () => session,
      radar: async () => {
        calls++
        return {
          ...radar,
          boundary: { ...radar.boundary, sourceRevision: radar.boundary.sourceRevision + 1 },
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
    await until(() => calls === 3)
    expect(state.data.radar).toBeUndefined()
    expect(state.data.snapshot).toBeUndefined()
    expect(state.data.stale).toBe(true)
    expect(state.data.error).toContain("changed while reading")
    state.close()
  } finally {
    fixture.close()
  }
})

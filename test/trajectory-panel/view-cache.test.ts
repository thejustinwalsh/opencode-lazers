import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import { ObservationReads } from "../../src/observability/read.ts"
import {
  TrajectoryPanelState,
  TrajectoryViewCache,
} from "../../src/trajectory-panel/panel-state.ts"
import type { TrajectoryTransport } from "../../src/trajectory-panel/projection.ts"
import { cursorSecret, makeFixture, taskID } from "../trajectory/fixture.ts"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await tick()
  expect(predicate()).toBe(true)
}

test("a re-mounted panel shows the last loaded trajectory at once and refreshes it in place", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const reads = new ObservationReads(
    fixture.store,
    {
      session: (id) => fixture.host.session(id),
      status: async (id) => {
        const session = fixture.sessions.get(id)
        return session
          ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
          : null
      },
    },
    "project",
    cursorSecret,
  )
  const transport: TrajectoryTransport = {
    snapshot: async (scope) => reads.snapshot(scope, tracker),
    trajectory: async (scope, id, _signal, cursor) =>
      reads.trajectory({ scope, taskID: id, limit: 50, ...(cursor ? { cursor } : {}) }, tracker),
    history: async (scope, id, _signal, cursor, limit = 50) =>
      reads.trajectoryHistory({ scope, taskID: id, limit, ...(cursor ? { cursor } : {}) }, tracker),
    status: async (scope, id, _signal, cursor) =>
      reads.trajectoryStatus({ scope, taskID: id, live: cursor ? { cursor } : {} }, tracker),
    changes: (signal) =>
      (async function* () {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()))
        yield* []
      })(),
    online: () => true,
  }
  const cache = new TrajectoryViewCache()
  const scope = { kind: "project", sessionID: "ses-owner" } as const
  const preferences = {
    taskID: null,
    selection: null,
    target: {
      requestID: "request-remount",
      taskID,
      reference: fixture.repository.referenceFor(taskID)!,
      projectID: "project",
      projectDirectory: fixture.directory,
    },
  }
  const options = { autoContinue: false, cache }
  const first = new TrajectoryPanelState(
    () => {},
    () => {},
    undefined,
    options,
  )
  const second = new TrajectoryPanelState(
    () => {},
    () => {},
    undefined,
    options,
  )
  try {
    first.connect("first", "project", fixture.directory, scope, transport, preferences)
    await until(() => Boolean(first.data.report) && !first.data.loading)
    const loaded = first.data.report!
    first.close()

    // A transport that never answers: whatever is on screen right after connect is the cache.
    const silent: TrajectoryTransport = {
      ...transport,
      snapshot: () => new Promise(() => {}),
      history: () => new Promise(() => {}),
      status: () => new Promise(() => {}),
    }
    second.connect("second", "project", fixture.directory, scope, silent, preferences)
    expect(second.data.key).toBe("second")
    expect(second.data.report?.task.id).toBe(loaded.task.id)
    expect(second.data.loading).toBe(false)
    expect(second.data.error).toBe("")
    expect(second.data.events.length).toBe(first.data.events.length)
    expect(second.data.selection).toEqual(first.data.selection)

    // Without a cache the same connect starts from nothing.
    const bare = new TrajectoryPanelState(
      () => {},
      () => {},
      undefined,
      { autoContinue: false },
    )
    bare.connect("bare", "project", fixture.directory, scope, silent, preferences)
    expect(bare.data.report).toBeUndefined()
    expect(bare.data.loading).toBe(true)
    bare.close()
  } finally {
    first.close()
    second.close()
    fixture.close()
  }
})

test("the view cache is per project, scope, task and selected attempt, and keeps a few entries", () => {
  const key = (project: string, kind: "project" | "session", task: string, attempt: string) =>
    TrajectoryViewCache.key(
      project,
      { kind, sessionID: "ses" },
      task,
      attempt ? { kind: "attempt", id: attempt } : null,
    )
  const keys = new Set([
    key("p1", "project", "t1", ""),
    key("p2", "project", "t1", ""),
    key("p1", "session", "t1", ""),
    key("p1", "project", "t2", ""),
    key("p1", "project", "t1", "a1"),
  ])
  expect(keys.size).toBe(5)
  // A selected check or event belongs to the task's default entry, not to an attempt entry.
  expect(
    TrajectoryViewCache.key("p1", { kind: "project", sessionID: "ses" }, "t1", {
      kind: "check",
      id: "c",
    }),
  ).toBe(key("p1", "project", "t1", ""))

  const cache = new TrajectoryViewCache(2)
  const data = (id: string) => ({ key: id }) as never
  cache.set("a", data("a"))
  cache.set("b", data("b"))
  cache.get("a")
  cache.set("c", data("c"))
  expect(cache.get("b")).toBeUndefined()
  expect(cache.get("a")).toBeDefined()
  cache.clear()
  expect(cache.get("a")).toBeUndefined()
})

test("only a panel opened with no task context asks the person to pick", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const reads = new ObservationReads(
    fixture.store,
    {
      session: (id) => fixture.host.session(id),
      status: async (id) => {
        const session = fixture.sessions.get(id)
        return session
          ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
          : null
      },
    },
    "project",
    cursorSecret,
  )
  const transport: TrajectoryTransport = {
    snapshot: async (scope) => reads.snapshot(scope, tracker),
    trajectory: async (scope, id) => reads.trajectory({ scope, taskID: id, limit: 50 }, tracker),
    history: async (scope, id, _signal, cursor, limit = 50) =>
      reads.trajectoryHistory({ scope, taskID: id, limit, ...(cursor ? { cursor } : {}) }, tracker),
    status: async (scope, id) => reads.trajectoryStatus({ scope, taskID: id }, tracker),
    changes: (signal) =>
      (async function* () {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()))
        yield* []
      })(),
    online: () => true,
  }
  const scope = { kind: "project", sessionID: "ses-owner" } as const
  const cache = new TrajectoryViewCache()
  const open = (preferences: Parameters<TrajectoryPanelState["connect"]>[5], withCache = true) => {
    const state = new TrajectoryPanelState(
      () => {},
      () => {},
      undefined,
      {
        autoContinue: false,
        ...(withCache ? { cache } : {}),
      },
    )
    state.connect("view", "project", fixture.directory, scope, transport, preferences)
    return state
  }
  const opened: TrajectoryPanelState[] = []
  try {
    // No context at all: nothing is picked for the person.
    const bare = open({ taskID: null, selection: null })
    opened.push(bare)
    await until(() => bare.data.tasks.length > 0 && !bare.data.loading)
    expect(bare.data.taskID).toBeNull()

    // A remembered task of this view shows at once.
    const remembered = open({ taskID, selection: null })
    opened.push(remembered)
    expect(remembered.data.taskID).toBe(taskID)
    await until(() => Boolean(remembered.data.report) && !remembered.data.loading)

    // The cache holds a last-viewed task for this project: a panel with no task shows it.
    const again = open({ taskID: null, selection: null })
    opened.push(again)
    expect(again.data.taskID).toBe(taskID)
    expect(again.data.report?.task.id).toBe(taskID)
    expect(again.data.loading).toBe(false)

    // Opened from a task (Tasks, Radar): that task, whatever was shown before.
    const targeted = open({
      taskID: null,
      selection: null,
      target: {
        requestID: "from-task",
        taskID,
        reference: fixture.repository.referenceFor(taskID)!,
        projectID: "project",
        projectDirectory: fixture.directory,
      },
    })
    opened.push(targeted)
    expect(targeted.data.taskID).toBe(taskID)
  } finally {
    for (const state of opened) state.close()
    fixture.close()
  }
})

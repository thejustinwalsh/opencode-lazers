import { expect, test } from "bun:test"
import { TaskPanelState } from "./panel-state.ts"
import type { TaskTransport } from "./panel-state.ts"
import type { StartTaskInput, StartTaskResult, TaskDetail, TaskPage } from "./contract.ts"
import type { TopologyResponse } from "../observability/contract.ts"
import { preferredTaskStateFilter } from "./state-filter.ts"
import type { TaskPanelChange } from "./panel-state.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const page = (project: string, id = crypto.randomUUID(), snapshot = 1): TaskPage => ({
  projectDirectory: project,
  snapshot,
  count: 1,
  nextCursor: null,
  serverTime: new Date().toISOString(),
  tasks: [
    {
      taskID: id,
      reference: "LZ-1",
      revision: 1,
      status: "submitted",
      reason: null,
      classification: {
        revision: 1,
        classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
        provenance: { kind: "embedded", sessionID: "session", createdAt: new Date().toISOString() },
      },
      title: id,
      objective: id,
      sessionID: "session",
      createdAt: new Date().toISOString(),
      matches: [],
    },
  ],
})
function transport(
  query: TaskTransport["query"],
  get: TaskTransport["get"] = async () => ({ status: "not_found" }),
  start: TaskTransport["start"] = async () => ({
    status: "started",
    planID: crypto.randomUUID(),
    state: "running",
  }),
): TaskTransport {
  return {
    query,
    get,
    start,
    online: () => true,
    changes: (signal) =>
      (async function* () {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        )
        if (!signal.aborted) yield { projectDirectory: "/unused", version: 0 }
      })(),
  }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function changeChannel() {
  const queued: TaskPanelChange[] = []
  let waiter:
    | {
        resolve: (change: TaskPanelChange | undefined) => void
        abort: () => void
        signal: AbortSignal
      }
    | undefined
  return {
    emit(change: TaskPanelChange) {
      if (!waiter) {
        queued.push(change)
        return
      }
      const current = waiter
      waiter = undefined
      current.signal.removeEventListener("abort", current.abort)
      current.resolve(change)
    },
    changes(signal: AbortSignal): AsyncIterable<TaskPanelChange> {
      return (async function* () {
        while (!signal.aborted) {
          const change =
            queued.shift() ??
            (await new Promise<TaskPanelChange | undefined>((resolve) => {
              const abort = () => {
                if (waiter?.resolve === resolve) waiter = undefined
                resolve(undefined)
              }
              waiter = { resolve, abort, signal }
              signal.addEventListener("abort", abort, { once: true })
            }))
          if (!change) return
          yield change
        }
      })()
    },
  }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await tick()
  expect(predicate()).toBe(true)
}

test("state preferences remain independent while old history preferences retain their meaning", () => {
  expect(preferredTaskStateFilter(undefined, undefined)).toBe("open")
  expect(preferredTaskStateFilter(undefined, false)).toBe("open")
  expect(preferredTaskStateFilter(undefined, true)).toBe("all")
  expect(preferredTaskStateFilter("failed", true)).toBe("failed")
  expect(preferredTaskStateFilter("completed", false)).toBe("completed")
})

test("healthy connected Tasks does not repeat list and inspector reads without changes", async () => {
  let queries = 0
  let details = 0
  let activityReads = 0
  const state = new TaskPanelState(() => {})
  const current = page("/project")
  const api = transport(
    async () => {
      queries++
      return current
    },
    async () => {
      details++
      return { status: "not_found" }
    },
  )
  api.currentActivity = async (taskIDs) => {
    activityReads++
    return {
      activities: taskIDs.map((taskID) => ({
        taskID,
        attemptID: null,
        foreground: "unknown" as const,
        unknownReason: "no-current-attempt" as const,
        recordedState: null,
        waiting: false,
        holdReason: null,
        pendingInput: null,
        pendingPermissions: null,
        pendingForms: null,
        outcome: null,
        observedAt: null,
      })),
    }
  }
  try {
    state.connect("view", "/project", api, {})
    await until(() => queries === 1 && details === 1 && activityReads >= 2)
    const initialActivityReads = activityReads
    await Bun.sleep(5_150)
    expect(state.data.page).toEqual(current)
    expect(queries).toBe(1)
    expect(details).toBe(1)
    expect(activityReads).toBe(initialActivityReads)
  } finally {
    state.close()
  }
}, 10_000)

test("native activity events refresh only matching tasks and coalesce repeated notifications", async () => {
  const taskA = crypto.randomUUID()
  const taskB = crypto.randomUUID()
  const first = page("/project", taskA)
  const otherTask = { ...first.tasks[0]!, taskID: taskB, reference: "LZ-2", title: taskB }
  const current = { ...first, count: 2, tasks: [first.tasks[0]!, otherTask] }
  const channel = changeChannel()
  const activityReads: string[][] = []
  const state = new TaskPanelState(() => {})
  const api = transport(async () => current)
  api.changes = channel.changes
  let activityEventObserved = false
  api.currentActivity = async (taskIDs) => {
    activityReads.push([...taskIDs])
    return {
      activities: taskIDs.map((taskID) => ({
        taskID,
        workerSessionID: taskID === taskA ? "worker-a" : "worker-b",
        attemptID: crypto.randomUUID(),
        foreground:
          taskID === taskA && activityEventObserved ? ("active" as const) : ("inactive" as const),
        unknownReason: null,
        recordedState: "running" as const,
        waiting: false,
        holdReason: null,
        pendingInput: false,
        pendingPermissions: 0,
        pendingForms: 0,
        outcome: null,
        observedAt: Date.now(),
      })),
    }
  }
  try {
    state.connect("view", "/project", api, {}, taskA)
    await until(
      () =>
        !state.data.loading &&
        state.data.currentActivity[taskA]?.workerSessionID === "worker-a" &&
        state.data.currentActivity[taskB]?.workerSessionID === "worker-b",
    )
    await tick()
    await tick()
    const initialReads = activityReads.length
    activityEventObserved = true
    channel.emit({ projectDirectory: "/project", version: 0, activitySessionID: "worker-a" })
    channel.emit({ projectDirectory: "/project", version: 0, activitySessionID: "worker-a" })
    channel.emit({ projectDirectory: "/project", version: 0, activitySessionID: "unrelated" })
    await until(() => activityReads.length === initialReads + 1)
    await until(() => state.data.currentActivity[taskA]?.foreground === "active")
    await Bun.sleep(80)
    expect(activityReads.slice(initialReads)).toEqual([[taskA]])
    expect(state.data.currentActivity[taskB]?.foreground).toBe("inactive")
  } finally {
    state.close()
  }
})

test("native reconnect refreshes current activity once on the connected stream", async () => {
  const taskID = crypto.randomUUID()
  const channel = changeChannel()
  const state = new TaskPanelState(() => {})
  let queries = 0
  let activityReads = 0
  const api = transport(async () => {
    queries++
    return page("/project", taskID, queries)
  })
  api.changes = channel.changes
  api.currentActivity = async (taskIDs) => {
    activityReads++
    return {
      activities: taskIDs.map((id) => ({
        taskID: id,
        workerSessionID: "worker-a",
        attemptID: crypto.randomUUID(),
        foreground: "inactive" as const,
        unknownReason: null,
        recordedState: "running" as const,
        waiting: false,
        holdReason: null,
        pendingInput: false,
        pendingPermissions: 0,
        pendingForms: 0,
        outcome: null,
        observedAt: Date.now(),
      })),
    }
  }
  try {
    state.connect("view", "/project", api, {}, taskID)
    await until(
      () =>
        queries === 1 &&
        !state.data.loading &&
        state.data.currentActivity[taskID]?.workerSessionID === "worker-a",
    )
    await tick()
    await tick()
    const initialActivityReads = activityReads
    channel.emit({ projectDirectory: "/project", version: 0, resnapshotRequired: true })
    await until(() => queries === 2 && activityReads === initialActivityReads + 1)
    await tick()
    await tick()
    expect(activityReads).toBe(initialActivityReads + 1)
    expect(state.data.page?.snapshot).toBe(2)
  } finally {
    state.close()
  }
})

test("disposed task connections ignore late native activity notifications", async () => {
  const oldTaskID = crypto.randomUUID()
  const newTaskID = crypto.randomUUID()
  const oldChannel = changeChannel()
  const oldReads: string[][] = []
  const currentReads: string[][] = []
  const state = new TaskPanelState(() => {})
  const oldTransport = transport(async () => page("/project", oldTaskID))
  oldTransport.changes = oldChannel.changes
  oldTransport.currentActivity = async (taskIDs) => {
    oldReads.push([...taskIDs])
    return {
      activities: taskIDs.map((taskID) => ({
        taskID,
        workerSessionID: "old-worker",
        attemptID: crypto.randomUUID(),
        foreground: "inactive" as const,
        unknownReason: null,
        recordedState: "running" as const,
        waiting: false,
        holdReason: null,
        pendingInput: false,
        pendingPermissions: 0,
        pendingForms: 0,
        outcome: null,
        observedAt: Date.now(),
      })),
    }
  }
  const newChannel = changeChannel()
  const newTransport = transport(async () => page("/project", newTaskID))
  newTransport.changes = newChannel.changes
  newTransport.currentActivity = async (taskIDs) => {
    currentReads.push([...taskIDs])
    return {
      activities: taskIDs.map((taskID) => ({
        taskID,
        workerSessionID: "new-worker",
        attemptID: crypto.randomUUID(),
        foreground: "inactive" as const,
        unknownReason: null,
        recordedState: "running" as const,
        waiting: false,
        holdReason: null,
        pendingInput: false,
        pendingPermissions: 0,
        pendingForms: 0,
        outcome: null,
        observedAt: Date.now(),
      })),
    }
  }
  try {
    state.connect("old", "/project", oldTransport, {}, oldTaskID)
    await until(
      () =>
        !state.data.loading &&
        state.data.currentActivity[oldTaskID]?.workerSessionID === "old-worker",
    )
    await tick()
    state.connect("new", "/project", newTransport, {}, newTaskID)
    await until(
      () =>
        !state.data.loading &&
        state.data.currentActivity[newTaskID]?.workerSessionID === "new-worker",
    )
    await tick()
    const oldReadCount = oldReads.length
    const currentReadCount = currentReads.length
    oldChannel.emit({ projectDirectory: "/project", version: 0, activitySessionID: "old-worker" })
    await Bun.sleep(80)
    expect(oldReads).toHaveLength(oldReadCount)
    expect(currentReads).toHaveLength(currentReadCount)
    expect(state.data.key).toBe("new")
    expect(state.data.currentActivity[oldTaskID]).toBeUndefined()
  } finally {
    state.close()
  }
})

test("late current-activity responses cannot cross a changed Tasks scope", async () => {
  const taskID = crypto.randomUUID()
  const original = {
    ...page("/project", taskID),
    tasks: [
      {
        ...page("/project", taskID).tasks[0]!,
        status: "running" as const,
        recordedState: "running" as const,
      },
    ],
  }
  const stale = deferred<Awaited<ReturnType<NonNullable<TaskTransport["currentActivity"]>>>>()
  let delay = false
  let calls = 0
  const oldTransport = transport(async () => original)
  oldTransport.currentActivity = async () => {
    calls++
    if (delay) return stale.promise
    return {
      activities: [
        {
          taskID,
          attemptID: crypto.randomUUID(),
          foreground: "inactive",
          unknownReason: null,
          recordedState: "running",
          waiting: true,
          holdReason: "old scope hold",
          pendingInput: false,
          pendingPermissions: 0,
          pendingForms: 0,
          outcome: "succeeded",
          observedAt: Date.now(),
        },
      ],
    }
  }
  const state = new TaskPanelState(() => {})
  try {
    state.connect("session-a", "/project", oldTransport, {}, taskID)
    await until(() => state.data.currentActivity[taskID]?.holdReason === "old scope hold")
    await tick()
    delay = true
    const previousCalls = calls
    state.refreshCurrentActivity()
    await until(() => calls > previousCalls)

    const newTransport = transport(async () => original)
    newTransport.currentActivity = async () => ({
      activities: [
        {
          taskID,
          attemptID: crypto.randomUUID(),
          foreground: "active",
          unknownReason: null,
          recordedState: "running",
          waiting: true,
          holdReason: "new scope hold",
          pendingInput: true,
          pendingPermissions: 1,
          pendingForms: 0,
          outcome: null,
          observedAt: Date.now(),
        },
      ],
    })
    state.connect("project-b", "/project", newTransport, {}, taskID)
    await until(() => state.data.currentActivity[taskID]?.holdReason === "new scope hold")
    const current = state.data.currentActivity[taskID]
    stale.resolve({
      activities: [
        {
          taskID,
          attemptID: crypto.randomUUID(),
          foreground: "inactive",
          unknownReason: null,
          recordedState: "running",
          waiting: true,
          holdReason: "late old response",
          pendingInput: false,
          pendingPermissions: 0,
          pendingForms: 0,
          outcome: "succeeded",
          observedAt: Date.now(),
        },
      ],
    })
    await tick()
    expect(state.data.currentActivity[taskID]).toEqual(current)
  } finally {
    state.close()
  }
})

test("native reconnect catches missed state even when repository version did not advance", async () => {
  const reconnect = deferred<void>()
  const first = deferred<TaskPage>()
  let calls = 0
  const state = new TaskPanelState(() => {})
  const original = page("/project")
  const recovered = { ...original, serverTime: "2026-11-04T19:00:00.000Z" }
  const api = transport(async () => (++calls === 1 ? first.promise : recovered))
  api.changes = (signal) =>
    (async function* () {
      await reconnect.promise
      yield { projectDirectory: "/project", version: 0, resnapshotRequired: true }
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      )
    })()
  try {
    state.connect("view", "/project", api, {})
    reconnect.resolve()
    await tick()
    first.resolve(original)
    await tick()
    await tick()
    expect(calls).toBe(2)
    expect(state.data.page).toEqual(recovered)
    expect(state.data.stale).toBe(false)
  } finally {
    state.close()
  }
})

test("failed reads retry without events and stop retrying after recovery", async () => {
  let calls = 0
  const state = new TaskPanelState(() => {})
  const recovered = page("/project")
  try {
    state.connect(
      "view",
      "/project",
      transport(async () => {
        if (++calls === 1) throw new Error("temporary read failure")
        return recovered
      }),
      {},
    )
    await tick()
    expect(state.data.stale).toBe(true)
    await Bun.sleep(1_100)
    expect(state.data.page).toEqual(recovered)
    expect(state.data.stale).toBe(false)
    await Bun.sleep(3_150)
    expect(calls).toBe(2)
  } finally {
    state.close()
  }
})

test("closing a failed view cancels its recovery reads", async () => {
  let calls = 0
  const state = new TaskPanelState(() => {})
  state.connect(
    "view",
    "/project",
    transport(async () => {
      calls++
      throw new Error("temporary read failure")
    }),
    {},
  )
  await tick()
  state.close()
  await Bun.sleep(1_100)
  expect(calls).toBe(1)
})

test("old session/project/server/filter responses and old detail selections cannot replace the current view", async () => {
  const old = deferred<TaskPage>()
  const detailA = deferred<TaskDetail>()
  const state = new TaskPanelState(() => {})
  try {
    state.connect(
      "server-a/project-a/session-a/filter-a",
      "/a",
      transport(() => old.promise),
      {},
    )
    const current = page("/b")
    state.connect(
      "server-b/project-b/session-b/filter-b",
      "/b",
      transport(
        async () => current,
        () => detailA.promise,
      ),
      { search: "b" },
    )
    await tick()
    expect(state.data.tasks[0]!.taskID).toBe(current.tasks[0]!.taskID)
    old.resolve(page("/a"))
    await tick()
    expect(state.data.key).toBe("server-b/project-b/session-b/filter-b")
    expect(state.data.tasks).toEqual(current.tasks)
    const freshDetail = deferred<TaskDetail>()
    state.connect(
      "new-selection",
      "/b",
      transport(
        async () => current,
        () => freshDetail.promise,
      ),
      {},
      current.tasks[0]!.taskID,
    )
    detailA.resolve({ status: "revision_unavailable", revision: 1 })
    freshDetail.resolve({ status: "not_found" })
    await tick()
    expect(state.data.detail).toEqual({ status: "not_found" })
  } finally {
    state.close()
  }
})

test("duplicate Start clicks share a request, while reconnect retries through the new transport", async () => {
  const pending = deferred<StartTaskResult>()
  const id = crypto.randomUUID()
  const reconnectedResult: StartTaskResult = {
    status: "existing",
    planID: crypto.randomUUID(),
    state: "running",
  }
  let starts = 0
  const state = new TaskPanelState(() => {})
  const input: StartTaskInput = { taskID: id, revision: 1, sessionID: "architect-session" }
  try {
    state.connect(
      "first",
      "/project",
      transport(
        async () => page("/project", id),
        undefined,
        async () => {
          starts++
          return pending.promise
        },
      ),
      {},
    )
    const first = state.start(input)
    const second = state.start(input)
    expect(starts).toBe(1)
    state.connect(
      "reconnected",
      "/project",
      transport(
        async () => page("/project", id),
        undefined,
        async () => {
          starts++
          return reconnectedResult
        },
      ),
      {},
    )
    const third = state.start(input)
    expect(starts).toBe(2)
    expect(await third).toEqual(reconnectedResult)
    const result = {
      status: "started" as const,
      planID: crypto.randomUUID(),
      state: "running" as const,
    }
    pending.resolve(result)
    expect(await Promise.all([first, second])).toEqual([result, result])
    expect(starts).toBe(2)
  } finally {
    state.close()
  }
})

test("invalidations during snapshot acquisition are caught up, foreign and duplicate events are ignored", async () => {
  let deliver!: (event: { projectDirectory: string; version: number }) => void
  const first = deferred<TaskPage>()
  let calls = 0
  let streamClosed = false
  const state = new TaskPanelState(() => {})
  const second = page("/project", crypto.randomUUID(), 2)
  const api = transport(async () => (++calls === 1 ? first.promise : second))
  api.changes = (signal) =>
    (async function* () {
      try {
        while (!signal.aborted) {
          const event = await new Promise<{ projectDirectory: string; version: number }>(
            (resolve) => {
              deliver = resolve
              signal.addEventListener(
                "abort",
                () => resolve({ projectDirectory: "", version: 0 }),
                { once: true },
              )
            },
          )
          if (!signal.aborted) yield event
        }
      } finally {
        streamClosed = true
      }
    })()
  try {
    state.connect("view", "/project", api, {})
    deliver({ projectDirectory: "/project", version: 2 })
    await tick()
    first.resolve(page("/project", crypto.randomUUID(), 1))
    await tick()
    await tick()
    expect(state.data.page!.snapshot).toBe(2)
    expect(calls).toBe(2)
    deliver({ projectDirectory: "/foreign", version: 50 })
    await tick()
    deliver({ projectDirectory: "/project", version: 1 })
    await tick()
    expect(calls).toBe(2)
  } finally {
    state.close()
    await tick()
  }
  expect(streamClosed).toBe(true)
})

test("a change already covered by the in-flight snapshot does not repeat the read", async () => {
  const first = deferred<TaskPage>()
  const change = deferred<void>()
  let calls = 0
  const state = new TaskPanelState(() => {})
  const current = page("/project", crypto.randomUUID(), 2)
  const api = transport(async () => {
    calls++
    return first.promise
  })
  api.changes = (signal) =>
    (async function* () {
      await change.promise
      yield { projectDirectory: "/project", version: 2 }
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      )
    })()
  try {
    state.connect("view", "/project", api, {})
    change.resolve()
    await tick()
    first.resolve(current)
    await tick()
    await tick()
    expect(state.data.page).toEqual(current)
    expect(calls).toBe(1)
  } finally {
    state.close()
  }
})

test("read failures retain stale scoped data and recovery preserves the selected task", async () => {
  const original = page("/project")
  let fail = false
  const state = new TaskPanelState(() => {})
  try {
    state.connect(
      "view",
      "/project",
      transport(async () => {
        if (fail) throw new Error("disconnected")
        return original
      }),
      {},
    )
    await tick()
    const selected = state.data.selectedID
    fail = true
    await state.refresh()
    expect(state.data.stale).toBe(true)
    expect(state.data.tasks).toEqual(original.tasks)
    fail = false
    await state.refresh()
    expect(state.data.stale).toBe(false)
    expect(state.data.selectedID).toBe(selected)
  } finally {
    state.close()
  }
})

test("topology is published only when it shares the task-page repository boundary", async () => {
  const state = new TaskPanelState(() => {})
  let queries = 0
  let snapshots = 0
  const api = transport(async () => page("/project", crypto.randomUUID(), ++queries))
  api.topology = async () => {
    snapshots++
    return {
      boundary: { repositoryVersion: snapshots === 1 ? 0 : 2 },
      plans: [],
    } as unknown as TopologyResponse
  }
  try {
    state.connect("view", "/project", api, {})
    await tick()
    await tick()
    expect(queries).toBe(2)
    expect(snapshots).toBe(2)
    expect(state.data.page?.snapshot).toBe(2)
    expect(state.data.topology?.boundary.repositoryVersion).toBe(2)
    expect(state.data.topologyError).toBe("")
  } finally {
    state.close()
  }
})

test("linked dependency details use the transport's same-scope authorization path", async () => {
  const state = new TaskPanelState(() => {})
  const target = crypto.randomUUID()
  let requested: string | undefined
  const api = transport(
    async () => page("/project"),
    async (taskID) => {
      requested = taskID
      return { status: "not_found" }
    },
  )
  try {
    state.connect("view", "/project", api, { sessionID: "session" })
    await tick()
    await state.resolveLinked(target)
    expect(requested).toBe(target)
  } finally {
    state.close()
  }
})

test("late optional topology cannot publish old tasks into a newly connected scope", async () => {
  const state = new TaskPanelState(() => {})
  const pending = deferred<TopologyResponse>()
  const old = page("/old")
  const current = page("/new")
  const oldTransport = transport(async () => old)
  oldTransport.topology = () => pending.promise // Deliberately ignores abort, like a late RPC.
  try {
    state.connect("old-view", "/old", oldTransport, {})
    await tick()
    state.connect(
      "new-view",
      "/new",
      transport(async () => current),
      {},
    )
    await tick()
    pending.resolve({
      boundary: { repositoryVersion: old.snapshot },
      plans: [],
    } as unknown as TopologyResponse)
    await tick()
    expect(state.data.key).toBe("new-view")
    expect(state.data.tasks).toEqual(current.tasks)
    expect(state.data.page?.projectDirectory).toBe("/new")
    expect(state.data.topology).toBeUndefined()
    expect(state.data.selectedID).toBe(current.tasks[0]?.taskID)
  } finally {
    state.close()
  }
})

test("restored inspectors load while topology is pending or the list fails", async () => {
  for (const failList of [false, true]) {
    const state = new TaskPanelState(() => {})
    const pending = deferred<TopologyResponse>()
    const selectedID = crypto.randomUUID()
    const requested: string[] = []
    const api = transport(
      async () => {
        if (failList) throw new Error("list unavailable")
        return page("/project", selectedID)
      },
      async (id) => {
        requested.push(id)
        return { status: "not_found" }
      },
    )
    api.topology = () => pending.promise
    try {
      state.connect("saved-view", "/project", api, {}, selectedID)
      await tick()
      expect(requested).toEqual([selectedID])
      expect(state.data.selectedID).toBe(selectedID)
      expect(state.data.detail).toEqual({ status: "not_found" })
      if (failList) expect(state.data.error).toContain("list unavailable")
      else expect(state.data.loading).toBe(true)
    } finally {
      state.close()
      pending.resolve({
        boundary: { repositoryVersion: 1 },
        plans: [],
      } as unknown as TopologyResponse)
    }
  }
})

test.each([
  [
    { type: "rpc.internal", message: "RPC call failed" },
    "Execution links unavailable: RPC call failed. Showing ungrouped tasks.",
  ],
  [{ arbitrary: "private details" }, "Execution links unavailable. Showing ungrouped tasks."],
  [
    new Error("Scope is too large"),
    "Execution links unavailable: Scope is too large. Showing ungrouped tasks.",
  ],
])("optional topology errors show only a readable public message: %j", async (error, expected) => {
  const state = new TaskPanelState(() => {})
  const api = transport(async () => page("/project"))
  api.topology = async () => {
    throw error
  }
  try {
    state.connect("view", "/project", api, {})
    await tick()
    expect(state.data.tasks).toHaveLength(1)
    expect(state.data.topologyError).toBe(expected)
    expect(state.data.topologyError).not.toContain("[object Object]")
  } finally {
    state.close()
  }
})

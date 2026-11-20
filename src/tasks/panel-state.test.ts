import { expect, test } from "bun:test"
import { refusalMessage } from "../audit/fallow-refusal.ts"
import { configRequired } from "../audit/fallow-gate.ts"
import { TaskPanelState } from "./panel-state.ts"
import type { TaskTransport, TaskPanelChange } from "./panel-state.ts"
import type { StartTaskInput, StartTaskResult, TaskDetail } from "./contract.ts"
import { preferredTaskStateFilter } from "./state-filter.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function transport(
  get: TaskTransport["get"] = async () => ({ status: "not_found" }),
  start: TaskTransport["start"] = async () => ({
    status: "started",
    planID: crypto.randomUUID(),
    state: "running",
  }),
): TaskTransport {
  return {
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
const activityOf = (
  taskIDs: string[],
  worker = "worker",
  foreground: "active" | "inactive" = "inactive",
) => ({
  activities: taskIDs.map((taskID) => ({
    taskID,
    workerSessionID: worker,
    attemptID: crypto.randomUUID(),
    foreground,
    unknownReason: null,
    recordedState: "running" as const,
    waiting: false,
    holdReason: null as string | null,
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    outcome: null,
    observedAt: Date.now(),
  })),
})
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
  // A stored Completed meant accepted plus integrated; All lists both.
  expect(preferredTaskStateFilter("completed", false)).toBe("all")
  expect(preferredTaskStateFilter("integrated", true)).toBe("integrated")
})

const found = (id: string): TaskDetail =>
  ({ status: "found", task: { id }, reference: id }) as unknown as TaskDetail

test("a change event reads the selected task again once; foreign and repeated versions are ignored", async () => {
  const channel = changeChannel()
  let details = 0
  const state = new TaskPanelState(() => {})
  const api = transport(async (taskID) => (details++, found(taskID)))
  api.changes = channel.changes
  try {
    state.connect("view", "/project", api, "task-1")
    await until(() => details === 1)
    await Bun.sleep(150)
    expect(details).toBe(1)
    channel.emit({ projectDirectory: "/elsewhere", version: 5 })
    channel.emit({ projectDirectory: "/project", version: 5 })
    channel.emit({ projectDirectory: "/project", version: 5 })
    channel.emit({ projectDirectory: "/project", version: 4 })
    await until(() => details === 2)
    await Bun.sleep(80)
    expect(details).toBe(2)
    channel.emit({ projectDirectory: "/project", version: 6 })
    await until(() => details === 3)
  } finally {
    state.close()
  }
})

test("the rows in view are read for activity once, and a row that stays is not read again", async () => {
  const reads: string[][] = []
  const state = new TaskPanelState(() => {})
  const api = transport()
  api.currentActivity = async (taskIDs) => (reads.push([...taskIDs]), activityOf(taskIDs))
  try {
    state.connect("view", "/project", api)
    state.observe(["a", "b"])
    await until(() => state.data.currentActivity.b !== undefined)
    state.observe(["b", "c"])
    await until(() => state.data.currentActivity.c !== undefined)
    expect(reads).toEqual([["a", "b"], ["c"]])
  } finally {
    state.close()
  }
})

test("native activity events refresh only matching tasks and coalesce repeated notifications", async () => {
  const taskA = "11111111-1111-4111-8111-111111111111"
  const taskB = "22222222-2222-4222-8222-222222222222"
  const channel = changeChannel()
  const activityReads: string[][] = []
  const state = new TaskPanelState(() => {})
  const api = transport()
  api.changes = channel.changes
  let eventObserved = false
  api.currentActivity = async (taskIDs) => {
    activityReads.push([...taskIDs])
    return {
      activities: activityOf(taskIDs).activities.map((activity) => ({
        ...activity,
        workerSessionID: activity.taskID === taskA ? "worker-a" : "worker-b",
        foreground:
          activity.taskID === taskA && eventObserved ? ("active" as const) : ("inactive" as const),
      })),
    }
  }
  try {
    state.connect("view", "/project", api, taskA)
    state.observe([taskA, taskB])
    await until(
      () =>
        state.data.currentActivity[taskA]?.workerSessionID === "worker-a" &&
        state.data.currentActivity[taskB]?.workerSessionID === "worker-b",
    )
    await tick()
    await tick()
    const initialReads = activityReads.length
    eventObserved = true
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

test("disposed task connections ignore late native activity notifications", async () => {
  const oldTaskID = crypto.randomUUID()
  const newTaskID = crypto.randomUUID()
  const oldChannel = changeChannel()
  const oldReads: string[][] = []
  const currentReads: string[][] = []
  const state = new TaskPanelState(() => {})
  const oldTransport = transport()
  oldTransport.changes = oldChannel.changes
  oldTransport.currentActivity = async (taskIDs) => (
    oldReads.push([...taskIDs]),
    activityOf(taskIDs, "old-worker")
  )
  const newTransport = transport()
  newTransport.currentActivity = async (taskIDs) => (
    currentReads.push([...taskIDs]),
    activityOf(taskIDs, "new-worker")
  )
  try {
    state.connect("old", "/project", oldTransport, oldTaskID)
    await until(() => state.data.currentActivity[oldTaskID]?.workerSessionID === "old-worker")
    await tick()
    state.connect("new", "/project", newTransport, newTaskID)
    await until(() => state.data.currentActivity[newTaskID]?.workerSessionID === "new-worker")
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
  const stale = deferred<ReturnType<typeof activityOf>>()
  let delay = false
  let calls = 0
  const oldTransport = transport()
  oldTransport.currentActivity = async (taskIDs) => {
    calls++
    if (delay) return stale.promise
    return {
      activities: activityOf(taskIDs).activities.map((a) => ({
        ...a,
        holdReason: "old scope hold",
      })),
    }
  }
  const state = new TaskPanelState(() => {})
  try {
    state.connect("session-a", "/project", oldTransport, taskID)
    await until(() => state.data.currentActivity[taskID]?.holdReason === "old scope hold")
    await tick()
    delay = true
    const previousCalls = calls
    state.refreshCurrentActivity()
    await until(() => calls > previousCalls)
    const newTransport = transport()
    newTransport.currentActivity = async (taskIDs) => ({
      activities: activityOf(taskIDs).activities.map((a) => ({
        ...a,
        holdReason: "new scope hold",
      })),
    })
    state.connect("project-b", "/project", newTransport, taskID)
    await until(() => state.data.currentActivity[taskID]?.holdReason === "new scope hold")
    const current = state.data.currentActivity[taskID]
    stale.resolve({
      activities: activityOf([taskID]).activities.map((a) => ({ ...a, holdReason: "late old" })),
    })
    await tick()
    expect(state.data.currentActivity[taskID]).toEqual(current)
  } finally {
    state.close()
  }
})

test("a failed detail read retries without events and stops retrying after recovery", async () => {
  let reads = 0
  const state = new TaskPanelState(() => {})
  try {
    state.connect(
      "view",
      "/project",
      transport(async (taskID) => {
        reads++
        if (reads === 1) throw new Error("detail unavailable")
        return found(taskID)
      }),
      "task-1",
    )
    await until(() => Boolean(state.data.error))
    expect(state.data.stale).toBe(true)
    // The retry waits one second.
    for (let attempt = 0; attempt < 300 && state.data.detail?.status !== "found"; attempt++)
      await Bun.sleep(10)
    expect(state.data.detail?.status).toBe("found")
    expect(state.data.error).toBe("")
    expect(state.data.stale).toBe(false)
    const settled = reads
    await Bun.sleep(1_300)
    expect(reads).toBe(settled)
  } finally {
    state.close()
  }
})

test("closing a failed view cancels its recovery reads", async () => {
  let reads = 0
  const state = new TaskPanelState(() => {})
  state.connect(
    "view",
    "/project",
    transport(async () => {
      reads++
      throw new Error("down")
    }),
    "task-1",
  )
  await until(() => reads === 1)
  state.close()
  await Bun.sleep(1_300)
  expect(reads).toBe(1)
})

test("an old view's detail response cannot replace the current view's", async () => {
  const slow = deferred<TaskDetail>()
  const state = new TaskPanelState(() => {})
  try {
    state.connect(
      "old",
      "/project",
      transport(async () => slow.promise),
      "task-old",
    )
    state.connect(
      "new",
      "/project",
      transport(async (taskID) => found(taskID)),
      "task-new",
    )
    await until(() => state.data.detail?.status === "found")
    slow.resolve(found("task-old"))
    await tick()
    expect(state.data.selectedID).toBe("task-new")
    expect((state.data.detail as unknown as { task: { id: string } }).task.id).toBe("task-new")
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
      transport(undefined, async () => {
        starts++
        return pending.promise
      }),
    )
    const first = state.start(input)
    const second = state.start(input)
    expect(starts).toBe(1)
    state.connect(
      "reconnected",
      "/project",
      transport(undefined, async () => {
        starts++
        return reconnectedResult
      }),
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

test("selecting a task keeps the previous detail until the new one arrives", async () => {
  const wait = deferred<TaskDetail>()
  const state = new TaskPanelState(() => {})
  try {
    state.connect(
      "view",
      "/project",
      transport(async (taskID) => (taskID === "next" ? wait.promise : found(taskID))),
      "first",
    )
    await until(() => state.data.detail?.status === "found")
    const before = state.data.detail
    const pending = state.select("next")
    expect(state.data.selectedID).toBe("next")
    expect(state.data.detail).toBe(before)
    wait.resolve(found("next"))
    await pending
    expect(state.data.detail).not.toBe(before)
  } finally {
    state.close()
  }
})

test("F-S14-1 task read errors preserve the readable RPC envelope message", async () => {
  const message = "Observation scope is too large; narrow it"
  const state = new TaskPanelState(() => {})
  try {
    state.connect(
      "rpc-error",
      "/project",
      transport(async () => {
        throw { type: "observation_error", data: { message } }
      }),
      "task-1",
    )
    await until(() => Boolean(state.data.error))
    // F-S14-1: plain RPC envelopes must never become object-coercion text.
    expect(state.data.error).not.toContain("[object Object]")
    expect(state.data.error).toContain(message)
  } finally {
    state.close()
  }
})

test("a refused start reaches the panel as the typed result, not an exception", async () => {
  const refusal = configRequired("/project")
  const id = crypto.randomUUID()
  const state = new TaskPanelState(() => {})
  try {
    state.connect(
      "first",
      "/project",
      transport(undefined, async () => refusal),
    )
    const result = await state.start({ taskID: id, revision: 1, sessionID: "architect-session" })
    expect(result).toEqual(refusal)
    expect(result.status === "refused" && refusalMessage(result)).toContain(
      "lz-fallow-config (mode suggest)",
    )
  } finally {
    state.close()
  }
})

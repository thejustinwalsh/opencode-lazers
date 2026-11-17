import { expect, test } from "bun:test"
import { STALLED_PAGE, TaskPanelState } from "./panel-state.ts"
import type { TaskTransport } from "./panel-state.ts"
import type { StartTaskInput, StartTaskResult, TaskDetail, TaskPage } from "./contract.ts"
import type { TopologyResponse } from "../observability/contract.ts"
import { preferredTaskStateFilter } from "./state-filter.ts"
import type { TaskPanelChange } from "./panel-state.ts"
import type { SchedulingPage, SchedulingScope } from "./scheduling-contract.ts"
import { buildExecutionList } from "./execution-list.ts"

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

test("Tasks panel assembles one paginated scheduling snapshot without changing its numeric observation time", async () => {
  const state = new TaskPanelState(() => {})
  const scope: SchedulingScope = { kind: "project", sessionID: "session" }
  const blockedTaskID = crypto.randomUUID()
  const blockerTaskIDs = Array.from({ length: 100 }, () => crypto.randomUUID())
  const base = {
    schemaVersion: 1 as const,
    snapshotID: crypto.randomUUID(),
    repositoryVersion: 7,
    scope,
    observedAt: 0,
    coverage: {
      status: "complete" as const,
      planCount: 2,
      coveredPlanCount: 2,
      nodeCount: 1,
      coveredNodeCount: 1,
      activeReservationCount: 101,
      reservationsComplete: true,
      reason: null,
    },
    next: { status: "none" as const },
    selectedTaskIDs: [],
    selectionComplete: true,
  }
  const schedulingPages: SchedulingPage[] = [
    {
      ...base,
      plans: [
        {
          planID: crypto.randomUUID(),
          planVersion: 1,
          planOrder: 0,
          priority: 4,
          title: "First page plan",
          lifecycle: "running",
          decision: "waiting",
          reason: null,
          afterPlans: [],
          nodes: [
            {
              taskID: blockedTaskID,
              title: "Blocked task",
              objective: "Blocked task",
              ordinal: 0,
              order: 0,
              lifecycle: "queued",
              decision: "waiting",
              reason: "A conflicting write scope is reserved.",
              prerequisites: [],
              waitingOn: [],
              reservationTaskIDs: blockerTaskIDs,
              reservationTaskCount: 101,
              reservationTaskIDsComplete: false,
            },
          ],
          nodesComplete: true,
        },
      ],
      nextCursor: "page-two",
    },
    {
      ...base,
      plans: [
        {
          planID: crypto.randomUUID(),
          planVersion: 1,
          planOrder: 1,
          priority: 0,
          title: "Second page plan",
          lifecycle: "running",
          decision: "waiting",
          reason: null,
          afterPlans: [],
          nodes: [],
          nodesComplete: true,
        },
      ],
      nextCursor: null,
    },
  ]
  let schedulingCalls = 0
  const api = transport(async () => page("/project"))
  api.scheduling = async (input) => {
    const current = schedulingPages[schedulingCalls++]!
    if (input.cursor === undefined) expect(current.nextCursor).toBe("page-two")
    else expect(input.cursor).toBe("page-two")
    return current
  }
  state.connect("scheduling-pages", "/project", api, {}, undefined, scope)
  await until(() => state.data.scheduling?.plans.length === 2)
  expect(schedulingCalls).toBe(2)
  expect(state.data.scheduling?.observedAt).toBe(0)
  expect(state.data.scheduling?.plans.map((plan) => plan.title)).toEqual([
    "First page plan",
    "Second page plan",
  ])
  const blockedRow = buildExecutionList({
    tasks: state.data.tasks,
    revealTaskIDs: new Set([blockedTaskID]),
    scheduling: state.data.scheduling,
  }).plans[0]?.rows.find((row) => row.taskID === blockedTaskID)
  expect(blockedRow?.scheduling).toMatchObject({
    reservationTaskCount: 101,
    reservationTaskIDs: blockerTaskIDs,
    reservationTaskIDsComplete: false,
  })
  expect(blockedRow?.scheduling?.reason).toContain("Showing 100 of 101 blocker task references.")
  expect(state.data.schedulingError).toBe("")
  state.close()
})

test("unrelated progress watermark churn preserves compatible topology grouping and three active workers", async () => {
  const taskIDs: string[] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  const planID = crypto.randomUUID()
  const scope: SchedulingScope = { kind: "project", sessionID: "session" }
  const initial = page("/project").tasks[0]!
  const tasks = taskIDs.map((taskID, ordinal) => ({
    ...initial,
    taskID,
    reference: `LZ-${ordinal + 1}`,
    status: "running" as const,
    recordedState: "running" as const,
    title: `Worker ${ordinal + 1}`,
    objective: `Worker ${ordinal + 1}`,
  }))
  let watermark = 10
  const state = new TaskPanelState(() => {})
  const api = transport(async () => ({
    ...page("/project"),
    snapshot: watermark,
    count: tasks.length,
    tasks,
  }))
  api.topology = async () => {
    // Model an ordinary progress write after the task page, without changing relationships.
    watermark++
    return {
      schemaVersion: 1,
      projectID: "project",
      scope: { kind: "project" },
      observedAt: new Date().toISOString(),
      boundary: { repositoryVersion: watermark },
      plans: [
        {
          id: planID,
          revision: 1,
          version: 1,
          state: "running",
          reason: null,
          title: "Concurrent dependency graph",
          afterPlans: [],
          nodes: taskIDs.map((taskID, ordinal) => ({
            taskID,
            revision: 1,
            objective: `Worker ${ordinal + 1}`,
            ordinal,
            state: "running",
            version: 1,
            reason: null,
            machineVersion: "test",
            machineSupported: true,
            snapshot: null,
            snapshotMatchesState: true,
            waitingOn: ordinal ? [taskIDs[ordinal - 1]!] : [],
          })),
          dependencies: taskIDs.slice(1).map((taskID, index) => ({
            prerequisite: taskIDs[index]!,
            successor: taskID,
          })),
        },
      ],
      unplannedTasks: [],
    } as unknown as TopologyResponse
  }
  api.scheduling = async () => {
    // Another unrelated progress write lands between topology and scheduling reads.
    watermark++
    const nodes = taskIDs.map((taskID, ordinal) => ({
      taskID,
      title: `Worker ${ordinal + 1}`,
      objective: `Worker ${ordinal + 1}`,
      ordinal,
      order: ordinal,
      lifecycle: "running" as const,
      decision: "not-applicable" as const,
      reason: null,
      prerequisites: ordinal ? [taskIDs[ordinal - 1]!] : [],
      waitingOn: [],
      reservationTaskIDs: [],
    }))
    return {
      schemaVersion: 1,
      snapshotID: crypto.randomUUID(),
      repositoryVersion: watermark,
      scope,
      observedAt: Date.now(),
      coverage: {
        status: "complete",
        planCount: 1,
        coveredPlanCount: 1,
        nodeCount: nodes.length,
        coveredNodeCount: nodes.length,
        activeReservationCount: 0,
        reservationsComplete: true,
        reason: null,
      },
      next: { status: "none" },
      selectedTaskIDs: [],
      selectionComplete: true,
      plans: [
        {
          planID,
          planVersion: 1,
          planOrder: 0,
          priority: 3,
          title: "Concurrent dependency graph",
          lifecycle: "running",
          decision: "waiting",
          reason: null,
          afterPlans: [],
          nodesComplete: true,
          nodes,
        },
      ],
      nextCursor: null,
    }
  }
  api.currentActivity = async (requested) => ({
    activities: requested.map((taskID) => ({
      taskID,
      workerSessionID: `worker-${taskIDs.indexOf(taskID) + 1}`,
      attemptID: crypto.randomUUID(),
      foreground: "active" as const,
      unknownReason: null,
      recordedState: "running" as const,
      waiting: false,
      holdReason: null,
      pendingInput: false,
      pendingPermissions: 0,
      pendingForms: 0,
      outcome: null,
      observedAt: watermark,
    })),
  })

  try {
    state.connect("concurrent", "/project", api, {}, undefined, scope)
    await until(
      () =>
        !state.data.loading &&
        taskIDs.every((taskID) => state.data.currentActivity[taskID]?.foreground === "active"),
    )
    expect(state.data.topology).toBeDefined()
    expect(state.data.topologyError).toBe("")
    expect(state.data.schedulingError).toBe("")
    const list = buildExecutionList({
      topology: state.data.topology,
      tasks: state.data.tasks,
      scheduling: state.data.scheduling,
    })
    expect(list.plans).toHaveLength(1)
    expect(list.plans[0]?.rows.map((row) => row.taskID)).toEqual(taskIDs)
    expect(list.plans[0]?.rows[2]?.prerequisites).toEqual([taskIDs[1]!])
    expect(Object.keys(state.data.currentActivity)).toHaveLength(3)
    expect(
      Object.values(state.data.currentActivity).map((activity) => activity.foreground),
    ).toEqual(["active", "active", "active"])
  } finally {
    state.close()
  }
})

test("material relationship disagreement and scheduling scope mismatch do not combine groupings", async () => {
  const taskIDs: string[] = [crypto.randomUUID(), crypto.randomUUID()]
  const planID = crypto.randomUUID()
  const scope: SchedulingScope = { kind: "project", sessionID: "session" }
  const initial = page("/project").tasks[0]!
  const tasks = taskIDs.map((taskID) => ({ ...initial, taskID }))
  const state = new TaskPanelState(() => {})
  const api = transport(async () => ({
    ...page("/project"),
    tasks,
    count: tasks.length,
    snapshot: 1,
  }))
  api.topology = async () =>
    ({
      boundary: { repositoryVersion: 2 },
      scope: { kind: "project" },
      plans: [
        {
          id: planID,
          revision: 1,
          version: 1,
          afterPlans: [],
          nodes: taskIDs.map((taskID, ordinal) => ({ taskID, ordinal })),
          dependencies: [{ prerequisite: taskIDs[0], successor: taskIDs[1] }],
        },
      ],
    }) as unknown as TopologyResponse
  api.scheduling = async () => ({
    schemaVersion: 1,
    snapshotID: crypto.randomUUID(),
    repositoryVersion: 3,
    scope: { kind: "project", sessionID: "session" },
    observedAt: 1,
    coverage: {
      status: "complete",
      planCount: 1,
      coveredPlanCount: 1,
      nodeCount: 2,
      coveredNodeCount: 2,
      activeReservationCount: 0,
      reservationsComplete: true,
      reason: null,
    },
    next: { status: "none" },
    selectedTaskIDs: [],
    selectionComplete: true,
    plans: [
      {
        planID,
        planVersion: 1,
        planOrder: 0,
        priority: 0,
        title: "Current relationship",
        lifecycle: "running",
        decision: "waiting",
        reason: null,
        afterPlans: [],
        nodesComplete: true,
        nodes: taskIDs.map((taskID, ordinal) => ({
          taskID,
          title: taskID,
          objective: taskID,
          ordinal,
          order: ordinal,
          lifecycle: "queued" as const,
          decision: "waiting" as const,
          reason: null,
          prerequisites: [],
          waitingOn: [],
          reservationTaskIDs: [],
        })),
      },
    ],
    nextCursor: null,
  })
  try {
    state.connect("changed-relationships", "/project", api, {}, undefined, scope)
    await until(() => !state.data.loading && Boolean(state.data.scheduling))
    expect(state.data.topology).toBeUndefined()
    expect(state.data.topologyError).toContain("relationships changed")
    const list = buildExecutionList({
      topology: state.data.topology,
      tasks: state.data.tasks,
      scheduling: state.data.scheduling,
    })
    expect(list.plans).toHaveLength(1)
    expect(list.plans[0]?.rows[1]?.prerequisites).toEqual([])
  } finally {
    state.close()
  }

  const incompatible = new TaskPanelState(() => {})
  const wrongScope = transport(async () => ({ ...page("/project"), tasks, count: tasks.length }))
  wrongScope.topology = async () =>
    ({
      boundary: { repositoryVersion: 1 },
      scope: { kind: "project" },
      plans: [],
    }) as unknown as TopologyResponse
  wrongScope.scheduling = async () => ({
    ...(await api.scheduling!({ scope, limit: 10 }, new AbortController().signal)),
    scope: { kind: "session", sessionID: "other-session" },
  })
  try {
    incompatible.connect("wrong-scope", "/project", wrongScope, {}, undefined, scope)
    await until(() => !incompatible.data.loading && Boolean(incompatible.data.schedulingError))
    expect(incompatible.data.scheduling).toBeUndefined()
    expect(incompatible.data.topology).toBeDefined()
  } finally {
    incompatible.close()
  }
})

test("bounded scheduling plan prerequisites keep compatible topology prefixes", async () => {
  const taskID = crypto.randomUUID()
  const planID = crypto.randomUUID()
  const prerequisiteIDs = [crypto.randomUUID(), crypto.randomUUID()]
  const scope: SchedulingScope = { kind: "project", sessionID: "session" }
  const state = new TaskPanelState(() => {})
  const api = transport(async () => page("/project", taskID))
  api.topology = async () =>
    ({
      boundary: { repositoryVersion: 1 },
      scope: { kind: "project" },
      plans: [
        {
          id: planID,
          revision: 1,
          version: 1,
          afterPlans: prerequisiteIDs,
          nodes: [{ taskID, ordinal: 0 }],
          dependencies: [],
        },
      ],
    }) as unknown as TopologyResponse
  api.scheduling = async () => ({
    schemaVersion: 1,
    snapshotID: crypto.randomUUID(),
    repositoryVersion: 1,
    scope,
    observedAt: 1,
    coverage: {
      status: "partial",
      planCount: 1,
      coveredPlanCount: 1,
      nodeCount: 1,
      coveredNodeCount: 1,
      activeReservationCount: 0,
      reservationsComplete: true,
      reason: "Prerequisite plan references are bounded.",
    },
    next: { status: "none" },
    selectedTaskIDs: [],
    selectionComplete: true,
    plans: [
      {
        planID,
        planVersion: 1,
        planOrder: 0,
        priority: 0,
        title: "Bounded prerequisites",
        lifecycle: "running",
        decision: "waiting",
        reason: null,
        afterPlans: [prerequisiteIDs[0]!],
        afterPlansCount: 2,
        afterPlansComplete: false,
        nodesComplete: true,
        nodes: [
          {
            taskID,
            title: "Task",
            objective: "Task",
            ordinal: 0,
            order: 0,
            lifecycle: "queued",
            decision: "waiting",
            reason: null,
            prerequisites: [],
            waitingOn: [],
            reservationTaskIDs: [],
          },
        ],
      },
    ],
    nextCursor: null,
  })

  try {
    state.connect("bounded-afterplans", "/project", api, {}, undefined, scope)
    await until(() => !state.data.loading && Boolean(state.data.scheduling))
    expect(state.data.topology).toBeDefined()
    expect(state.data.topologyError).toBe("")
    expect(
      buildExecutionList({
        tasks: state.data.tasks,
        scheduling: state.data.scheduling,
      }).plans[0],
    ).toMatchObject({
      afterPlans: [prerequisiteIDs[0]!],
      afterPlansCount: 2,
      afterPlansComplete: false,
    })
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

test("ordinary list refresh retains observed activity until replacement or a failed read", async () => {
  const taskID = crypto.randomUUID()
  const attemptID = crypto.randomUUID()
  const state = new TaskPanelState(() => {})
  const pending = deferred<void>()
  let hold = false
  let started = false
  let fail = false
  let active = true
  let snapshot = 0
  const api = transport(async () => page("/project", taskID, ++snapshot))
  api.currentActivity = async () => {
    if (hold) {
      started = true
      await pending.promise
    }
    if (fail) throw new Error("native observation unavailable")
    return {
      activities: [
        {
          taskID,
          workerSessionID: "worker-a",
          attemptID,
          foreground: active ? "active" : "inactive",
          unknownReason: null,
          recordedState: "running",
          waiting: false,
          holdReason: null,
          pendingInput: false,
          pendingPermissions: 0,
          pendingForms: 0,
          outcome: null,
          observedAt: Date.now(),
        },
      ],
    }
  }
  try {
    state.connect("view", "/project", api, {}, taskID)
    await until(
      () => !state.data.loading && state.data.currentActivity[taskID]?.foreground === "active",
    )
    await tick()
    hold = true
    active = false
    const refresh = state.refresh()
    await until(() => started)
    expect(state.data.currentActivity[taskID]?.foreground).toBe("active")
    expect(state.data.currentActivity[taskID]?.attemptID).toBe(attemptID)
    pending.resolve()
    await refresh
    expect(state.data.currentActivity[taskID]?.foreground).toBe("inactive")
    hold = false
    fail = true
    await state.refresh()
    expect(state.data.currentActivity[taskID]).toBeUndefined()
    expect(state.data.activityError).toBe("Current activity is unavailable.")
    expect(state.data.activityError).not.toContain("[object Object]")
  } finally {
    pending.resolve()
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
      {},
    )
    await until(() => Boolean(state.data.error))
    // F-S14-1: plain RPC envelopes must never become object-coercion text.
    expect(state.data.error).not.toContain("[object Object]")
    expect(state.data.error).toContain(message)
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

test("more(key) ignores another view's key and requests each page object once", async () => {
  const first = { ...page("/project"), nextCursor: "page-two" }
  const second = { ...page("/project"), nextCursor: null }
  const calls: Array<string | undefined> = []
  const pending = deferred<TaskPage>()
  const state = new TaskPanelState(() => {})
  try {
    state.connect(
      "view-a",
      "/project",
      transport(async (input) => {
        calls.push(input.cursor)
        return input.cursor ? pending.promise : first
      }),
      {},
    )
    await until(() => state.data.page === first && !state.data.loading)
    await tick()
    // A request carrying a stale filter key never reaches the transport.
    await state.more("view-b")
    expect(calls).toEqual([undefined])
    // The same page object is requested once, however often the view asks.
    const requests = [state.more("view-a"), state.more("view-a"), state.more("view-a")]
    await until(() => calls.length === 2)
    pending.resolve(second)
    await Promise.all(requests)
    expect(calls).toEqual([undefined, "page-two"])
    expect(state.data.page).toBe(second)
    expect(state.data.tasks).toHaveLength(2)
    // No next page: nothing more to ask for.
    await state.more("view-a")
    expect(calls).toHaveLength(2)
  } finally {
    state.close()
  }
})

test("a failed next page has its own error and loads again only on an explicit retry", async () => {
  const first = { ...page("/project"), nextCursor: "page-two" }
  const calls: Array<string | undefined> = []
  let failMore = true
  const state = new TaskPanelState(() => {})
  const pageTwo = () => calls.filter((cursor) => cursor === "page-two").length
  try {
    state.connect(
      "view-a",
      "/project",
      transport(async (input) => {
        calls.push(input.cursor)
        if (input.cursor && failMore) throw new Error("page two unavailable")
        return input.cursor ? { ...page("/project"), nextCursor: null } : { ...first }
      }),
      {},
    )
    await until(() => state.data.page?.nextCursor === "page-two" && !state.data.loading)
    await tick()
    await state.more("view-a")
    // The list itself is fine: no list error, no stale mark, no list retry timer.
    expect(state.data.moreError).toContain("page two unavailable")
    expect(state.data.error).toBe("")
    expect(state.data.stale).toBe(false)
    expect(pageTwo()).toBe(1)
    const reads = calls.length
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(calls).toHaveLength(reads)
    // Neither repeated asks nor a refresh that replaces the page object re-request it.
    await state.more("view-a")
    await state.refresh()
    await until(() => !state.data.loading && state.data.page?.nextCursor === "page-two")
    await tick()
    await state.more("view-a")
    expect(pageTwo()).toBe(1)
    expect(state.data.moreError).toContain("page two unavailable")
    // Retry for another view is ignored; retry for this view requests the page once more.
    failMore = false
    state.retryMore("view-b")
    expect(pageTwo()).toBe(1)
    state.retryMore("view-a")
    await until(() => state.data.page?.nextCursor === null)
    expect(pageTwo()).toBe(2)
    expect(state.data.moreError).toBe("")
  } finally {
    state.close()
  }
})

test("a next page that repeats its cursor or lists nothing new stops until an explicit retry", async () => {
  const first = { ...page("/project"), nextCursor: "page-two" }
  const calls: Array<string | undefined> = []
  // page-two lists a new task but points back at itself; later, nothing new with fresh cursors.
  let mode: "cycle" | "empty" | "end" = "cycle"
  let fresh = 0
  const state = new TaskPanelState(() => {})
  const asked = (cursor: string) => calls.filter((call) => call === cursor).length
  try {
    state.connect(
      "view-a",
      "/project",
      transport(async (input) => {
        calls.push(input.cursor)
        if (calls.length > 50) throw new Error("pagination did not stop")
        if (!input.cursor) return { ...first }
        if (mode === "cycle") return { ...page("/project"), nextCursor: input.cursor }
        if (mode === "empty") return { ...page("/project"), tasks: [], nextCursor: `f-${++fresh}` }
        return { ...page("/project"), nextCursor: null }
      }),
      {},
    )
    await until(() => state.data.page?.nextCursor === "page-two" && !state.data.loading)
    await tick()
    await state.more("view-a")
    // The new task is kept; the repeated cursor is not followed again by any view request.
    expect(state.data.tasks).toHaveLength(2)
    expect(state.data.moreError).toBe(STALLED_PAGE)
    for (let ask = 0; ask < 5; ask++) await state.more("view-a")
    expect(asked("page-two")).toBe(1)
    // Retry belongs to its view; for this view it asks the same cursor exactly once more.
    state.retryMore("view-b")
    expect(asked("page-two")).toBe(1)
    state.retryMore("view-a")
    await until(() => asked("page-two") === 2 && state.data.moreError === STALLED_PAGE)
    // No progress under a fresh cursor stops too, at the last page that made progress.
    mode = "empty"
    state.retryMore("view-a")
    await until(() => asked("page-two") === 3 && state.data.moreError === STALLED_PAGE)
    for (let ask = 0; ask < 5; ask++) await state.more("view-a")
    expect(calls.filter((call) => call?.startsWith("f-"))).toEqual([])
    expect(state.data.page?.nextCursor).toBe("page-two")
    // Once the source advances, Retry reads on and the error clears.
    mode = "end"
    state.retryMore("view-a")
    await until(() => state.data.page?.nextCursor === null)
    expect(state.data.moreError).toBe("")
  } finally {
    state.close()
  }
})

test("a refresh reading grown pages stops at a cursor cycle and leaves the rest to Retry", async () => {
  let count = 1
  const calls: Array<string | undefined> = []
  const state = new TaskPanelState(() => {})
  try {
    state.connect(
      "view-a",
      "/project",
      transport(async (input) => {
        calls.push(input.cursor)
        if (calls.length > 50) throw new Error("refresh did not stop")
        // Pages after the first list nothing and point back at the same cursor.
        if (input.cursor) return { ...page("/project"), count, tasks: [], nextCursor: "c" }
        return { ...page("/project"), count, nextCursor: "c" }
      }),
      {},
    )
    await until(() => !state.data.loading && state.data.page?.nextCursor === "c")
    await tick()
    expect(calls).toEqual([undefined])
    // The list grew: the refresh reads on toward the old length plus the growth.
    count = 5
    await state.refresh()
    await until(() => !state.data.loading && state.data.moreError === STALLED_PAGE)
    expect(calls.filter((call) => call === "c")).toHaveLength(1)
    expect(state.data.error).toBe("")
    await state.more("view-a")
    expect(calls.filter((call) => call === "c")).toHaveLength(1)
  } finally {
    state.close()
  }
})

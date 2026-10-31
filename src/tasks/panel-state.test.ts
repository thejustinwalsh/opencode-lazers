import { expect, test } from "bun:test"
import { TaskPanelState } from "./panel-state.ts"
import type { TaskTransport } from "./panel-state.ts"
import type { StartTaskInput, StartTaskResult, TaskDetail, TaskPage } from "./contract.ts"

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
      revision: 1,
      status: "submitted",
      reason: null,
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

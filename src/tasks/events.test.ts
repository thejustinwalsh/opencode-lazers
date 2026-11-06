import { expect, test } from "bun:test"
import { taskChanges } from "./events.ts"
import type { TaskEventSource } from "./events.ts"

test("native connection announcements resnapshot; only valid scoped task changes pass", async () => {
  const controller = new AbortController()
  let subscribed: Parameters<TaskEventSource["subscribe"]>[0] | undefined
  const source: TaskEventSource = {
    subscribe(options) {
      subscribed = options
      return (async function* () {
        yield { type: "server.connected", data: {} }
        yield { type: "rpc.lazers.tasks.changed", data: { projectDirectory: "/other", version: 4 } }
        yield {
          type: "rpc.lazers.tasks.changed",
          data: { projectDirectory: "/project", version: "bad" },
        }
        yield { type: "rpc.other.changed", data: { projectDirectory: "/project", version: 8 } }
        yield {
          type: "rpc.lazers.tasks.changed",
          data: { projectDirectory: "/project", version: 9 },
        }
        yield { type: "session.status", data: { sessionID: "worker-a", status: { type: "busy" } } }
        yield { type: "session.execution.succeeded", data: { sessionID: "worker-a" } }
        yield { type: "permission.asked", data: { sessionID: "worker-a", message: "private" } }
        yield { type: "form.created", data: { form: { sessionID: "worker-a", title: "private" } } }
        yield { type: "session.execution.started", data: { sessionID: "" } }
        yield { type: "session.tool.called", data: { sessionID: "worker-a" } }
        yield { type: "server.connected", data: {} }
      })()
    },
  }
  const changes = await Array.fromAsync(taskChanges(source, "/project", controller.signal))
  expect(subscribed).toEqual({
    types: [
      "rpc.lazers.tasks.changed",
      "session.created",
      "session.deleted",
      "session.moved",
      "session.archived",
      "session.unarchived",
      "session.status",
      "session.execution.started",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.inbox.enqueued",
      "session.inbox.delivered",
      "session.inbox.cancelled",
      "session.inbox.delivery.changed",
      "permission.asked",
      "permission.replied",
      "form.created",
      "form.replied",
      "form.cancelled",
    ],
    signal: controller.signal,
  })
  expect(changes).toEqual([
    { projectDirectory: "/project", version: 0, resnapshotRequired: true },
    { projectDirectory: "/project", version: 9 },
    { projectDirectory: "/project", version: 0, activitySessionID: "worker-a" },
    { projectDirectory: "/project", version: 0, activitySessionID: "worker-a" },
    { projectDirectory: "/project", version: 0, activitySessionID: "worker-a" },
    { projectDirectory: "/project", version: 0, activitySessionID: "worker-a" },
    { projectDirectory: "/project", version: 0, resnapshotRequired: true },
  ])
})

test("aborted native subscriptions cannot invalidate a closed task view", async () => {
  const controller = new AbortController()
  const source: TaskEventSource = {
    subscribe: () =>
      (async function* () {
        controller.abort()
        yield { type: "server.connected", data: {} }
      })(),
  }
  expect(await Array.fromAsync(taskChanges(source, "/project", controller.signal))).toEqual([])
})

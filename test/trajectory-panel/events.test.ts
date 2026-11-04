import { expect, test } from "bun:test"
import { trajectoryChanges } from "../../src/trajectory-panel/events.ts"
import type { TrajectoryEventSource } from "../../src/trajectory-panel/events.ts"

test("native connection announcements resnapshot; only valid scoped trajectory changes pass", async () => {
  const controller = new AbortController()
  let subscribed: Parameters<TrajectoryEventSource["subscribe"]>[0] | undefined
  const source: TrajectoryEventSource = {
    subscribe(options) {
      subscribed = options
      return (async function* () {
        yield { type: "server.connected", data: {} }
        yield {
          type: "rpc.lazers.observability.changed",
          data: { projectID: "other", sequence: 4 },
        }
        yield {
          type: "rpc.lazers.observability.changed",
          data: { projectID: "project", sequence: "bad" },
        }
        yield { type: "rpc.other.changed", data: { projectID: "project", sequence: 8 } }
        yield {
          type: "rpc.lazers.observability.changed",
          data: {
            projectID: "project",
            sequence: 9,
            repositoryVersion: 1,
            sourceRevision: 1,
            nativeRevision: 1,
            cause: "native",
            resnapshotRequired: false,
          },
        }
        yield { type: "server.connected", data: {} }
      })()
    },
  }
  const changes = await Array.fromAsync(trajectoryChanges(source, "project", controller.signal))
  expect(subscribed).toEqual({
    types: ["rpc.lazers.observability.changed"],
    signal: controller.signal,
  })
  expect(changes).toEqual([
    { projectID: "project", sequence: 0, resnapshotRequired: true },
    {
      projectID: "project",
      sequence: 9,
      repositoryVersion: 1,
      sourceRevision: 1,
      nativeRevision: 1,
      cause: "native",
      resnapshotRequired: false,
    },
    { projectID: "project", sequence: 0, resnapshotRequired: true },
  ])
})

test("aborted native subscriptions cannot invalidate a closed trajectory view", async () => {
  const controller = new AbortController()
  const source: TrajectoryEventSource = {
    subscribe: () =>
      (async function* () {
        controller.abort()
        yield { type: "server.connected", data: {} }
      })(),
  }
  expect(await Array.fromAsync(trajectoryChanges(source, "project", controller.signal))).toEqual([])
})

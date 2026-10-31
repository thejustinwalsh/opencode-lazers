import { expect, test } from "bun:test"
import type { ObservationScope } from "../observability/contract.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { ObservationChangeTracker } from "../observability/changes.ts"
import { ObservationReads } from "../observability/read.ts"
import { createRadarTransport } from "./transport.ts"

test("RPC adapter sends the explicit scope, directory, and abort signal", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(4)
    const reads = new ObservationReads(fixture.store, fixture.host, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const snapshot = reads.snapshot({ kind: "session", sessionID: "ses-failed" }, tracker)
    const scope: ObservationScope = { kind: "session", sessionID: "ses-failed" }
    const controller = new AbortController()
    const calls: unknown[] = []
    const transport = createRadarTransport(
      () => ({
        snapshot: async (input, options) => {
          calls.push({ input, options })
          return snapshot
        },
        events: {
          subscribe: async function* (_name, options) {
            calls.push({ eventSignal: options.signal })
            yield {
              data: {
                projectID: "project",
                sequence: 4,
                repositoryVersion: 0,
                sourceRevision: 0,
                nativeRevision: 0,
                cause: "runner",
                resnapshotRequired: false,
              },
            }
          },
        },
      }),
      "/workspace/project",
      () => true,
    )

    expect(await transport.snapshot(scope, controller.signal)).toBe(snapshot)
    expect(calls[0]).toEqual({
      input: { scope },
      options: { location: { directory: "/workspace/project" }, signal: controller.signal },
    })
    const changes = transport.changes(controller.signal)
    expect((await changes[Symbol.asyncIterator]().next()).value).toMatchObject({
      projectID: "project",
      sequence: 4,
    })
    expect(calls[1]).toEqual({ eventSignal: controller.signal })
    expect(transport.online()).toBe(true)
  } finally {
    fixture.close()
  }
})

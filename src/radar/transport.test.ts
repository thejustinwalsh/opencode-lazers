import { expect, test } from "bun:test"
import type { ObservationScope } from "../observability/contract.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { ObservationChangeTracker } from "../observability/changes.ts"
import { ObservationSyncState } from "../observability/state.ts"
import { createRadarTransport } from "./transport.ts"
import { operationalReads } from "../../test/radar/operational.ts"

test("RPC adapter sends the explicit scope, directory, and abort signal", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(4)
    const reads = operationalReads(fixture, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const snapshot = reads.snapshot({ kind: "session", sessionID: "ses-failed" }, tracker)
    const radar = await reads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    const scope: ObservationScope = { kind: "session", sessionID: "ses-failed" }
    const controller = new AbortController()
    const calls: unknown[] = []
    const transport = createRadarTransport(
      () => ({
        snapshot: async (input, options) => {
          calls.push({ input, options })
          return snapshot
        },
        radar: async (input, options) => {
          calls.push({ input, options })
          return radar
        },
        events: {
          subscribe: async function* (_name, options) {
            calls.push({ eventSignal: options.signal })
            yield {
              location: { directory: "/workspace/project" },
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
    expect(await transport.radar(scope, false, controller.signal)).toBe(radar)
    expect(calls[1]).toEqual({
      input: { scope, includeUnmanagedSessions: false },
      options: { location: { directory: "/workspace/project" }, signal: controller.signal },
    })
    const changes = transport.changes(controller.signal)
    expect((await changes[Symbol.asyncIterator]().next()).value).toMatchObject({
      projectID: "project",
      sequence: 4,
    })
    expect(calls[2]).toEqual({ eventSignal: controller.signal })
    expect(transport.online()).toBe(true)
  } finally {
    fixture.close()
  }
})

test("other worktree counters cannot trigger Radar gaps or suppress this location", async () => {
  const sync = new ObservationSyncState()
  const generation = sync.connect("project", { kind: "project", sessionID: "ses-owner" })
  const change = (sequence: number) => ({
    projectID: "project",
    sequence,
    repositoryVersion: 0,
    sourceRevision: 0,
    nativeRevision: sequence,
    cause: "native" as const,
    resnapshotRequired: false,
  })
  const transport = createRadarTransport(
    () => ({
      snapshot: async () => {
        throw new Error("not requested")
      },
      radar: async () => {
        throw new Error("not requested")
      },
      events: {
        subscribe: async function* () {
          yield { location: { directory: "/workspace/project" }, data: change(1) }
          yield { location: { directory: "/workspace/worker" }, data: change(100) }
          yield { data: change(200) }
          yield {
            location: { directory: "/workspace/project" },
            data: { ...change(900), projectID: "other" },
          }
          yield { location: { directory: "/workspace/project" }, data: change(2) }
        },
      },
    }),
    "/workspace/project",
    () => true,
  )
  const sequences: number[] = []
  const contiguous: boolean[] = []
  for await (const event of transport.changes(new AbortController().signal)) {
    sequences.push(event.sequence)
    contiguous.push(sync.acceptChange(generation, "project", event))
  }
  expect(sequences).toEqual([1, 900, 2])
  expect(contiguous).toEqual([false, false, true])
  expect(sync.eventSequence).toBe(2)
})

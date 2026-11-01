import { expect, test } from "bun:test"
import { flowStateInspector, ScrollRestoration } from "./presentation.ts"
import { ObservationChangeTracker } from "../observability/changes.ts"
import { ObservationReads } from "../observability/read.ts"
import type { SnapshotResponse } from "../observability/contract.ts"
import type { ObservationNode } from "./projection.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"

test("independent pane scroll restores once for each selection key", () => {
  const scheduled: (() => void)[] = []
  const restore = new ScrollRestoration((apply) => scheduled.push(apply))
  const visual = { scrollTop: 0 }
  const detail = { scrollTop: 0 }

  restore.restore("session:flow", true, visual, 120)
  expect(restore.restored("session:flow")).toBe(false)
  scheduled.shift()?.()
  expect(visual.scrollTop).toBe(120)
  expect(restore.restored("session:flow")).toBe(true)
  restore.restore("session:flow", true, visual, 250)
  scheduled.shift()?.()
  expect(visual.scrollTop).toBe(120)

  restore.restore("session:selection", true, detail, 42)
  scheduled.shift()?.()
  expect(detail.scrollTop).toBe(42)
  expect(restore.restored("session:selection")).toBe(true)
})

test("a pending restoration cannot write into a later scope", () => {
  const scheduled: (() => void)[] = []
  const restore = new ScrollRestoration((apply) => scheduled.push(apply))
  const pane = { scrollTop: 0 }
  restore.restore("old", true, pane, 90)
  restore.restore("new", true, pane, 24)
  scheduled.shift()?.()
  expect(pane.scrollTop).toBe(0)
  scheduled.shift()?.()
  expect(pane.scrollTop).toBe(24)
})

test("one mounted Flow inspector follows task, snapshot and selected-state changes", () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(4)
    const reads = new ObservationReads(fixture.store, fixture.host, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    let snapshot: SnapshotResponse | undefined = reads.snapshot(
      { kind: "session", sessionID: "ses-failed" },
      tracker,
    )
    let node: ObservationNode | undefined = {
      ...snapshot.plans[0]!.nodes[0]!,
      taskID: "efd8459f-1dbe-4472-968b-f26f59504291",
      state: "accepted",
      snapshot: { status: "active", value: "accepted" },
      snapshotMatchesState: true,
    }
    let selected = "running"
    // Create once, just as the non-keyed Show does when its state stays truthy.
    const inspector = flowStateInspector(
      () => node,
      () => snapshot,
      () => selected,
    )
    expect(inspector()).toMatchObject({ taskID: node.taskID, current: "No" })

    node = {
      ...node,
      taskID: "01d89f85-5eeb-4797-a0a8-18b2521e1cfa",
      state: "running",
      reason: "Live progress worker",
      snapshot: { status: "active", value: "running" },
    }
    expect(inspector()).toMatchObject({
      taskID: node.taskID,
      current: "Yes",
      matchesRecordedState: true,
      reason: "Live progress worker",
    })
    selected = "accepted"
    expect(inspector()).toMatchObject({ current: "No", matchesRecordedState: false })

    snapshot = { ...snapshot, machine: { ...snapshot.machine, version: "other-machine" } }
    expect(inspector()).toMatchObject({ current: "Unsupported machine", machine: "other-machine" })
    snapshot = undefined
    node = undefined
    expect(inspector()).toMatchObject({
      current: "Unavailable",
      taskID: "Unavailable",
      machine: "Unavailable",
    })
  } finally {
    fixture.close()
  }
})

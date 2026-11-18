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
  const visual = { scrollTop: 0, scrollLeft: 0 }
  const detail = { scrollTop: 0, scrollLeft: 0 }

  restore.restore("session:flow", true, visual, { top: 120, left: 24 })
  expect(restore.restored("session:flow")).toBe(false)
  scheduled.shift()?.()
  expect(visual.scrollTop).toBe(120)
  expect(visual.scrollLeft).toBe(24)
  expect(restore.restored("session:flow")).toBe(true)
  restore.restore("session:flow", true, visual, { top: 250, left: 60 })
  scheduled.shift()?.()
  expect(visual.scrollTop).toBe(120)
  expect(visual.scrollLeft).toBe(24)

  restore.restore("session:selection", true, detail, { top: 42, left: 12 })
  scheduled.shift()?.()
  expect(detail.scrollTop).toBe(42)
  expect(detail.scrollLeft).toBe(12)
  expect(restore.restored("session:selection")).toBe(true)
})

test("a pending restoration cannot write into a later scope", () => {
  const scheduled: (() => void)[] = []
  const restore = new ScrollRestoration((apply) => scheduled.push(apply))
  const pane = { scrollTop: 0, scrollLeft: 0 }
  restore.restore("old", true, pane, { top: 90, left: 40 })
  restore.restore("new", true, pane, { top: 24, left: 8 })
  scheduled.shift()?.()
  expect(pane.scrollTop).toBe(0)
  expect(pane.scrollLeft).toBe(0)
  scheduled.shift()?.()
  expect(pane.scrollTop).toBe(24)
  expect(pane.scrollLeft).toBe(8)
})

test("scope scroll restoration waits for async map readiness and preserves both axes", () => {
  const scheduled: (() => void)[] = []
  const restore = new ScrollRestoration((apply) => scheduled.push(apply))
  const pane = { scrollTop: 0, scrollLeft: 0 }
  restore.restore("old-project:map", false, pane, { top: 180, left: 60 })
  restore.restore("new-project:map", false, pane, { top: 72, left: 24 })
  expect(scheduled).toHaveLength(0)
  expect(pane).toEqual({ scrollTop: 0, scrollLeft: 0 })

  restore.restore("old-project:map", true, pane, { top: 180, left: 60 })
  restore.restore("new-project:map", true, pane, { top: 72, left: 24 })
  scheduled.shift()?.()
  expect(pane).toEqual({ scrollTop: 0, scrollLeft: 0 })
  scheduled.shift()?.()
  expect(pane).toEqual({ scrollTop: 72, scrollLeft: 24 })
  expect(restore.restored("new-project:map")).toBe(true)
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
    expect(inspector().current).toBeUndefined()
    expect(inspector().taskID).toBeUndefined()
    expect(inspector().machine).toBeUndefined()
    expect(inspector().reason).toBeUndefined()
  } finally {
    fixture.close()
  }
})

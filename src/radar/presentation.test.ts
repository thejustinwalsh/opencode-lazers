import { expect, test } from "bun:test"
import { flowStateInspector, ScrollRestoration } from "./presentation.ts"
import { taskMachineDefinition, type TaskMachineDefinition } from "../runner/task-machine-config.ts"
import type { ObservationNode } from "./projection.ts"

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

test("one mounted Flow inspector follows task, machine and selected-state changes", () => {
  let machine: TaskMachineDefinition | undefined = taskMachineDefinition()
  let node: ObservationNode | undefined = {
    planID: "1f58602c-e8ca-4a1b-99c6-32b183e418d2",
    taskID: "efd8459f-1dbe-4472-968b-f26f59504291",
    reference: null,
    state: "accepted",
    version: 2,
    reason: null,
    machineVersion: machine.version,
    machineSupported: true,
    snapshot: { status: "active", value: "accepted" },
    snapshotMatchesState: true,
  }
  let selected = "running"
  // Create once, just as the non-keyed Show does when its state stays truthy.
  const inspector = flowStateInspector(
    () => node,
    () => machine,
    () => selected,
  )
  expect(inspector()).toMatchObject({ taskID: node!.taskID, current: "No" })

  node = {
    ...node!,
    taskID: "01d89f85-5eeb-4797-a0a8-18b2521e1cfa",
    state: "running",
    reason: "Live progress worker",
    snapshot: { status: "active", value: "running" },
  }
  expect(inspector()).toMatchObject({
    taskID: node!.taskID,
    current: "Yes",
    matchesRecordedState: true,
    reason: "Live progress worker",
  })
  selected = "accepted"
  expect(inspector()).toMatchObject({ current: "No", matchesRecordedState: false })

  machine = { ...machine, version: "other-machine" }
  expect(inspector()).toMatchObject({ current: "Unsupported machine", machine: "other-machine" })
  machine = undefined
  node = undefined
  expect(inspector().current).toBeUndefined()
  expect(inspector().taskID).toBeUndefined()
  expect(inspector().machine).toBeUndefined()
  expect(inspector().reason).toBeUndefined()
})

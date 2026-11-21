import { expect, test } from "bun:test"
import { taskMachineDefinition } from "../runner/task-machine-config.ts"
import {
  activeState,
  machineSupported,
  nodeOf,
  observedTransition,
  transitionOf,
  type ObservationNode,
} from "./projection.ts"
import { statechartLayout } from "./statechart.ts"

const machine = taskMachineDefinition()
const taskID = "bb53fd1c-85cc-4d67-932d-b8b69a197d8b"
const planID = "1f58602c-e8ca-4a1b-99c6-32b183e418d2"

/** A `radar.nodes` row as the stream frame reads it. */
const nodeRow = (state: string, persisted: unknown, version = machine.version) =>
  ({
    plan_id: planID,
    task_id: taskID,
    ordinal: 0,
    state,
    version: 2,
    reason: null,
    machine_version: version,
    snapshot: persisted,
  }) as never

/** A `radar.planEvents` row: the latest transition of one edge. */
const edgeRow = (id: number, from: string, event: string, to: string, task = taskID) =>
  ({
    id,
    plan_id: planID,
    task_id: task,
    event,
    from_state: from,
    to_state: to,
    attempt_id: null,
    at: 4000 + id,
  }) as never

test("the machine definition is the runner's: every state and edge, in declaration order", () => {
  expect(machine).toMatchObject({
    id: "lazers-task",
    version: "lazers-task/1",
    initialState: "queued",
  })
  expect(machine.states.map((state) => state.id)).toContain("verifying")
  expect(machine.states.find((state) => state.id === "incorporated")?.type).toBe("final")
  expect(machine.states.find((state) => state.id === "verifying")?.transitions).toContainEqual({
    event: "ACCEPT",
    target: "accepted",
  })
})

test("Flow only highlights a persisted snapshot that matches the recorded state", () => {
  const mismatched = nodeOf(nodeRow("accepted", { status: "active", value: "queued" }), machine)
  expect(machineSupported(mismatched, machine)).toBe(true)
  expect(mismatched.snapshotMatchesState).toBe(false)
  expect(activeState(mismatched, machine)).toBeUndefined()

  const node = nodeOf(nodeRow("accepted", { status: "active", value: "accepted" }), machine)
  expect(activeState(node, machine)).toBe("accepted")
  const accept = transitionOf(edgeRow(3, "verifying", "ACCEPT", "accepted"))
  const graph = statechartLayout(machine, node, [accept])
  expect(graph.nodes.map((item) => item.id)).toEqual(machine.states.map((item) => item.id))
  expect(graph.nodes.find((item) => item.id === "accepted")?.active).toBe(true)
  expect(graph.edges).toHaveLength(
    machine.states.reduce((count, state) => count + state.transitions.length, 0),
  )
  expect(graph.edges.filter((edge) => edge.recorded).map((edge) => edge.event)).toEqual(["ACCEPT"])
  const bypass = graph.edges.find((edge) => edge.from === "queued" && edge.event === "INCORPORATE")!
  const route = bypass.path.match(/C (\d+) 34, (\d+) 736,/)
  expect(route?.[1]).toBe(route?.[2])
  expect(Number(route?.[1]) < 106 || Number(route?.[1]) > 254).toBe(true)
  expect(bypass.arrow).toMatch(/L (106|254) 736 L/)
  // Another task's edge is not this node's.
  const other = transitionOf(edgeRow(4, "verifying", "ACCEPT", "accepted", "another-task"))
  expect(statechartLayout(machine, node, [other]).edges.filter((edge) => edge.recorded)).toEqual([])
  const definition = machine.states
    .find((item) => item.id === "verifying")!
    .transitions.find((item) => item.event === "ACCEPT")!
  expect(observedTransition([accept, other], node, definition, "verifying")).toEqual(accept)
})

test("statechart positions remain stable when only the current snapshot changes", () => {
  const before = statechartLayout(
    machine,
    nodeOf(nodeRow("accepted", { status: "active", value: "queued" }), machine),
    [],
  )
  const after = statechartLayout(
    machine,
    nodeOf(nodeRow("verifying", { status: "active", value: "verifying" }), machine),
    [],
  )
  expect(after.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
    before.nodes.map(({ id, x, y }) => ({ id, x, y })),
  )
  expect(after.edges.map(({ id, path }) => ({ id, path }))).toEqual(
    before.edges.map(({ id, path }) => ({ id, path })),
  )
  expect(after.nodes.find((item) => item.id === "verifying")?.active).toBe(true)
})

test("unsupported machine versions and unknown persisted states expose no active state", () => {
  const old: ObservationNode = nodeOf(
    nodeRow("accepted", { status: "active", value: "accepted" }, "lazers-task/old"),
    machine,
  )
  expect(machineSupported(old, machine)).toBe(false)
  expect(old.snapshot).toBeNull()
  expect(activeState(old, machine)).toBeUndefined()
  const unknown = nodeOf(nodeRow("accepted", { status: "active", value: "dreaming" }), machine)
  expect(unknown.snapshot).toBeNull()
  expect(activeState(unknown, machine)).toBeUndefined()
})

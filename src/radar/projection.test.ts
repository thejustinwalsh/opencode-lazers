import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "../observability/changes.ts"
import { ObservationReads } from "../observability/read.ts"
import type { SnapshotResponse } from "../observability/contract.ts"
import { makeFixture, taskID } from "../../test/trajectory/fixture.ts"
import { activeState, machineSupported, observedTransition } from "./projection.ts"
import { statechartLayout } from "./statechart.ts"

function snapshotFixture() {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(4)
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret)
  const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
  tracker.initialize()
  const snapshot = reads.snapshot({ kind: "session", sessionID: "ses-failed" }, tracker)
  return { fixture, snapshot }
}

test("Flow uses projected topology and only highlights a matching persisted snapshot", () => {
  const { fixture, snapshot } = snapshotFixture()
  try {
    const node = snapshot.plans[0]!.nodes[0]!
    expect(machineSupported(node, snapshot)).toBe(true)
    expect(node.snapshotMatchesState).toBe(false)
    expect(activeState(node, snapshot)).toBeUndefined()

    const matching = {
      ...snapshot,
      plans: snapshot.plans.map((plan) => ({
        ...plan,
        nodes: plan.nodes.map((item) => ({
          ...item,
          snapshot: { status: "active", value: "accepted" as const },
          snapshotMatchesState: true,
        })),
      })),
    } as SnapshotResponse
    const currentNode = matching.plans[0]!.nodes[0]!
    expect(activeState(currentNode, matching)).toBe("accepted")

    const graph = statechartLayout(matching, matching.plans[0]!, currentNode)
    expect(graph.nodes.map((item) => item.id)).toEqual(
      matching.machine.states.map((item) => item.id),
    )
    expect(graph.nodes.find((item) => item.id === "accepted")?.active).toBe(true)
    expect(graph.edges).toHaveLength(
      matching.machine.states.reduce((count, state) => count + state.transitions.length, 0),
    )
    expect(graph.edges.filter((edge) => edge.recorded).map((edge) => edge.event)).toEqual([
      "ACCEPT",
    ])
    expect(graph.edges.every((edge) => edge.event && edge.from && edge.to)).toBe(true)
    const bypass = graph.edges.find(
      (edge) => edge.from === "queued" && edge.event === "INCORPORATE",
    )!
    const route = bypass.path.match(/C (\d+) 34, (\d+) 736,/)
    expect(route).not.toBeNull()
    expect(route?.[1]).toBe(route?.[2])
    expect(Number(route?.[1]) < 106 || Number(route?.[1]) > 254).toBe(true)
    expect(bypass.arrow).toMatch(/L (106|254) 736 L/)

    const accepted = snapshot.transitions.find((item) => item.event === "ACCEPT")!
    const otherPlanID = "00000000-0000-4000-8000-000000000001"
    const duplicatePlan = { ...matching.plans[0]!, id: otherPlanID }
    const duplicateTransition = {
      ...accepted,
      sequence: accepted.sequence + 1,
      planID: otherPlanID,
    }
    const multiPlan = {
      ...matching,
      plans: [...matching.plans, duplicatePlan],
      transitions: [...matching.transitions, duplicateTransition],
    } as SnapshotResponse
    expect(
      statechartLayout(multiPlan, matching.plans[0]!, currentNode).edges.filter(
        (edge) => edge.recorded,
      ),
    ).toHaveLength(1)
    const definition = matching.machine.states
      .find((item) => item.id === "verifying")!
      .transitions.find((item) => item.event === "ACCEPT")!
    expect(observedTransition(snapshot.transitions, node, definition, "verifying")).toEqual(
      accepted,
    )
    expect(matching.plans[0]!.dependencies).not.toHaveLength(graph.edges.length)
  } finally {
    fixture.close()
  }
})

test("statechart positions remain stable when only the current snapshot changes", () => {
  const { fixture, snapshot } = snapshotFixture()
  try {
    const node = snapshot.plans[0]!.nodes[0]!
    const updated = {
      ...snapshot,
      plans: snapshot.plans.map((plan) => ({
        ...plan,
        nodes: plan.nodes.map((item) => ({
          ...item,
          state: "verifying" as const,
          snapshot: { status: "active", value: "verifying" as const },
          snapshotMatchesState: true,
        })),
      })),
    } as SnapshotResponse
    const before = statechartLayout(snapshot, snapshot.plans[0]!, node)
    const after = statechartLayout(updated, updated.plans[0]!, updated.plans[0]!.nodes[0]!)
    expect(after.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      before.nodes.map(({ id, x, y }) => ({ id, x, y })),
    )
    expect(after.edges.map(({ id, path }) => ({ id, path }))).toEqual(
      before.edges.map(({ id, path }) => ({ id, path })),
    )
    expect(after.nodes.find((item) => item.id === "verifying")?.active).toBe(true)
  } finally {
    fixture.close()
  }
})

test("unsupported machine versions do not expose an active state", () => {
  const { fixture, snapshot } = snapshotFixture()
  try {
    const node = {
      ...snapshot.plans[0]!.nodes[0]!,
      taskID,
      machineVersion: "lazers-task/old",
      machineSupported: false,
      snapshot: { status: "active", value: "accepted" as const },
      snapshotMatchesState: true,
    }
    expect(machineSupported(node, snapshot)).toBe(false)
    expect(activeState(node, snapshot)).toBeUndefined()
  } finally {
    fixture.close()
  }
})

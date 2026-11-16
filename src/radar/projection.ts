import type { SnapshotResponse } from "../observability/contract.ts"

export type MachineState = SnapshotResponse["machine"]["states"][number]
export type MachineTransition = MachineState["transitions"][number]
export type ObservationNode = SnapshotResponse["plans"][number]["nodes"][number]
export type ObservationPlan = SnapshotResponse["plans"][number]
export type RecordedTransition = SnapshotResponse["transitions"][number]
export function selectedPlan(snapshot: SnapshotResponse, planID: string | null) {
  if (planID) return snapshot.plans.find((plan) => plan.id === planID)
  return snapshot.plans[0]
}

export function selectedNode(plan: ObservationPlan, taskID: string | null) {
  if (taskID) return plan.nodes.find((node) => node.taskID === taskID)
  return plan.nodes[0]
}

export function planTransitions(snapshot: SnapshotResponse, plan: ObservationPlan) {
  return snapshot.transitions.filter((transition) => transition.planID === plan.id)
}

export function machineSupported(node: ObservationNode, snapshot: SnapshotResponse) {
  return node.machineSupported && node.machineVersion === snapshot.machine.version
}

export function activeState(node: ObservationNode, snapshot: SnapshotResponse) {
  if (!machineSupported(node, snapshot) || !node.snapshotMatchesState) return undefined
  if (!node.snapshot || node.snapshot.value !== node.state) return undefined
  return snapshot.machine.states.some((state) => state.id === node.snapshot?.value)
    ? node.snapshot.value
    : undefined
}

export function observedTransition(
  transitions: readonly RecordedTransition[],
  node: ObservationNode,
  transition: MachineTransition,
  fromState: string,
) {
  return transitions
    .filter(
      (candidate) =>
        candidate.kind === "machine" &&
        candidate.taskID === node.taskID &&
        candidate.from !== null &&
        candidate.to !== null &&
        candidate.from === fromState &&
        candidate.event === transition.event &&
        candidate.to === transition.target,
    )
    .at(-1)
}

export function transitionForSequence(
  snapshot: SnapshotResponse,
  sequence: number | null,
): RecordedTransition | undefined {
  return sequence === null
    ? undefined
    : snapshot.transitions.find((transition) => transition.sequence === sequence)
}

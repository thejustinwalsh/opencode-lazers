import type { Row } from "../streams/frame.ts"
import type { radarRefs } from "../streams/sources/radar-ref.ts"
import type { taskPlanColumns } from "../streams/sources/tasks-ref.ts"
import type { TaskMachineDefinition, TaskMachineState } from "../runner/task-machine-config.ts"

/**
 * The lifecycle view's inputs, from stream rows: the task machine (plain data, the same the runner
 * builds its machine from), a plan's nodes (`radar.nodes`) and each node's recorded edges
 * (`radar.planEvents`: the latest transition per from, event and to). Nothing here reads a
 * snapshot.
 */
export type MachineState = TaskMachineDefinition["states"][number]
export type MachineTransition = MachineState["transitions"][number]

export type ObservationPlan = {
  id: string
  sequence: number | null
  title: string | null
  state: string
}

export type ObservationNode = {
  planID: string
  taskID: string
  reference: string | null
  state: string
  version: number
  reason: string | null
  machineVersion: string
  machineSupported: boolean
  snapshot: { status: string; value: TaskMachineState } | null
  snapshotMatchesState: boolean
}

export type RecordedTransition = {
  sequence: number
  planID: string
  taskID: string
  attemptID: string | null
  kind: "machine"
  event: string
  from: string
  to: string
  /** Read with the selected edge's detail; absent on a list row. */
  reason?: string | null
  recordedAt: number | null
}

const fields = (row: unknown) => row as Record<string, unknown>

export function planOf(row: Row<typeof taskPlanColumns>): ObservationPlan {
  const value = fields(row)
  return {
    id: String(value.plan_id),
    sequence: typeof value.seq === "number" && Number.isFinite(value.seq) ? value.seq : null,
    title: (value.title as string | null) ?? null,
    state: String(value.state),
  }
}

/** A node row, with the persisted snapshot checked as the old read checked it (`safeSnapshot`). */
export function nodeOf(
  row: Row<typeof radarRefs.nodes.columns>,
  machine: TaskMachineDefinition,
): ObservationNode {
  const value = fields(row)
  const machineVersion = String(value.machine_version)
  const supported = machineVersion === machine.version
  const persisted = value.snapshot as { status?: unknown; value?: unknown } | null
  const known = machine.states.find((state) => state.id === persisted?.value)?.id
  const snapshot =
    supported && known
      ? {
          status: typeof persisted?.status === "string" ? persisted.status : "unknown",
          value: known,
        }
      : null
  return {
    planID: String(value.plan_id),
    taskID: String(value.task_id),
    reference: (value.reference as string | null) ?? null,
    state: String(value.state),
    version: Number(value.version),
    reason: (value.reason as string | null) ?? null,
    machineVersion,
    machineSupported: supported,
    snapshot,
    snapshotMatchesState: snapshot !== null && snapshot.value === value.state,
  }
}

export function transitionOf(row: Row<typeof radarRefs.planEvents.columns>): RecordedTransition {
  const value = fields(row)
  const detail = (value.detail as { event?: { reason?: unknown } } | undefined)?.event
  return {
    sequence: Number(value.id),
    planID: String(value.plan_id),
    taskID: String(value.task_id),
    attemptID: (value.attempt_id as string | null) ?? null,
    kind: "machine",
    event: String(value.event),
    from: String(value.from_state),
    to: String(value.to_state),
    ...(detail ? { reason: typeof detail.reason === "string" ? detail.reason : null } : {}),
    recordedAt: typeof value.at === "number" ? value.at : null,
  }
}

export function selectedPlan(plans: readonly ObservationPlan[], planID: string | null) {
  if (planID) return plans.find((plan) => plan.id === planID)
  return plans[0]
}

export function selectedNode(nodes: readonly ObservationNode[], taskID: string | null) {
  if (taskID) return nodes.find((node) => node.taskID === taskID)
  return nodes[0]
}

export function machineSupported(node: ObservationNode, machine: TaskMachineDefinition) {
  return node.machineSupported && node.machineVersion === machine.version
}

export function activeState(node: ObservationNode, machine: TaskMachineDefinition) {
  if (!machineSupported(node, machine) || !node.snapshotMatchesState) return undefined
  if (!node.snapshot || node.snapshot.value !== node.state) return undefined
  return machine.states.some((state) => state.id === node.snapshot?.value)
    ? node.snapshot.value
    : undefined
}

/** The recorded transition of an edge: the node's latest with the same from, event and to. */
export function observedTransition(
  transitions: readonly RecordedTransition[],
  node: ObservationNode,
  transition: MachineTransition,
  fromState: string,
) {
  return transitions
    .filter(
      (candidate) =>
        candidate.taskID === node.taskID &&
        candidate.from === fromState &&
        candidate.event === transition.event &&
        candidate.to === transition.target,
    )
    .at(-1)
}

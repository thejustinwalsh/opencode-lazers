import type { SnapshotResponse } from "../observability/contract.ts"

export type MachineState = SnapshotResponse["machine"]["states"][number]
export type MachineTransition = MachineState["transitions"][number]
export type ObservationNode = SnapshotResponse["plans"][number]["nodes"][number]
export type ObservationPlan = SnapshotResponse["plans"][number]
export type RecordedTransition = SnapshotResponse["transitions"][number]
export type RecordedExecution = {
  startedAt: number | null
  endedAt: number | null
  startSequence: number | null
  endSequence: number | null
  timingBasis: string
}
export type TimelineAttempt = {
  id: string
  planID: string
  taskID: string
  number: number
  state: string
  startedAt: number
  endedAt: null
  timingBasis: string
  executions: RecordedExecution[]
}
export type TimelineCheck = {
  id: string
  planID: string
  taskID: string | null
  attemptID: string | null
  checkID: string
  scope: "attempt" | "plan"
  state: string
  startedAt: number | null
  endedAt: number | null
  exitCode: number | null
  timingBasis: string
}

type SnapshotTimeline = SnapshotResponse & {
  attempts?: unknown[]
  checks?: unknown[]
}

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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function nullableText(value: unknown) {
  return typeof value === "string" ? value : null
}

function sequence(value: unknown) {
  return Number.isInteger(value) ? (value as number) : null
}

function execution(value: unknown): RecordedExecution | undefined {
  const item = record(value)
  if (!item || typeof item.timingBasis !== "string") return undefined
  return {
    startedAt: finite(item.startedAt),
    endedAt: finite(item.endedAt),
    startSequence: sequence(item.startSequence),
    endSequence: sequence(item.endSequence),
    timingBasis: item.timingBasis,
  }
}

/** Timeline metadata is additive to the snapshot contract; absent records remain absent. */
export function timelineAttempts(snapshot: SnapshotResponse, selectedPlanID: string) {
  const source = snapshot as SnapshotTimeline
  if (!Array.isArray(source.attempts)) return []
  return source.attempts.flatMap((value): TimelineAttempt[] => {
    const item = record(value)
    if (
      !item ||
      item.planID !== selectedPlanID ||
      typeof item.id !== "string" ||
      typeof item.taskID !== "string" ||
      !Number.isInteger(item.number) ||
      typeof item.state !== "string" ||
      typeof item.startedAt !== "number" ||
      !Number.isFinite(item.startedAt) ||
      item.endedAt !== null ||
      typeof item.timingBasis !== "string" ||
      !Array.isArray(item.executions)
    )
      return []
    return [
      {
        id: item.id,
        planID: item.planID,
        taskID: item.taskID,
        number: item.number as number,
        state: item.state,
        startedAt: item.startedAt,
        endedAt: null,
        timingBasis: item.timingBasis,
        executions: item.executions.flatMap((value): RecordedExecution[] => {
          const parsed = execution(value)
          return parsed ? [parsed] : []
        }),
      },
    ]
  })
}

export function timelineChecks(snapshot: SnapshotResponse, selectedPlanID: string) {
  const source = snapshot as SnapshotTimeline
  if (!Array.isArray(source.checks)) return []
  return source.checks.flatMap((value): TimelineCheck[] => {
    const item = record(value)
    if (
      !item ||
      typeof item.id !== "string" ||
      item.planID !== selectedPlanID ||
      typeof item.checkID !== "string" ||
      (item.scope !== "attempt" && item.scope !== "plan") ||
      typeof item.state !== "string" ||
      typeof item.timingBasis !== "string"
    )
      return []
    return [
      {
        id: item.id,
        planID: item.planID,
        taskID: nullableText(item.taskID),
        attemptID: nullableText(item.attemptID),
        checkID: item.checkID,
        scope: item.scope,
        state: item.state,
        startedAt: finite(item.startedAt),
        endedAt: finite(item.endedAt),
        exitCode: finite(item.exitCode),
        timingBasis: item.timingBasis,
      },
    ]
  })
}

export function attemptKey(item: TimelineAttempt) {
  return item.id
}

export function checkKey(item: TimelineCheck) {
  return item.id
}
